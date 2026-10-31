import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { Store } from "../src/store/index.js";
import type { ProgressVerdict } from "../src/systemone/contract.js";
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const FIXED_NOW = Date.parse("2026-10-27T00:00:00.000Z");

const boot = async (): Promise<{ store: Store; revisions: () => number }> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-s1s-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const store = new Store(db, { now: () => FIXED_NOW });
  return { store, revisions: () => store.revisions().threads };
};

const seedThread = (store: Store, id = "th_s1"): void => {
  store.upsertThread({ id, harnessId: CODEX_HARNESS_ID, nativeStatus: "running", title: "t", lastActivityAt: FIXED_NOW });
};

const verdict = (overrides: Partial<ProgressVerdict> = {}): ProgressVerdict => ({
  status: "progressing",
  confidence: 0.8,
  reasonShort: "进行中 · 最新 turn #1 · 1 条证据",
  evidenceRefs: [],
  coversThrough: null,
  provenance: "systemone:magpie/m@progress-p1.0",
  assessedAt: new Date(FIXED_NOW).toISOString(),
  ...overrides,
});

const successInput = (threadId: string) => ({
  threadId,
  cacheKey: `ck-${threadId}`,
  fingerprint: `fp-${threadId}`,
  versionKey: "magpie|m|progress-p1.0|progress-q1.0",
  provider: "magpie",
  model: "m",
  verdict: verdict(),
  latencyMs: 5,
  inputTokens: 10,
  outputTokens: 5,
});

test("store: success writes once, touches threads, usage counted", async () => {
  const { store, revisions } = await boot();
  seedThread(store);
  const before = revisions();
  const view = store.systemoneRecordSuccess(successInput("th_s1"));
  assert.equal(view.state, "current");
  assert.equal(view.verdict?.status, "progressing");
  assert.equal(revisions(), before + 1);
  const usage = store.systemoneUsageToday(FIXED_NOW);
  assert.equal(usage.calls, 1);
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.outputTokens, 5);
});

test("store: cache hit returns view; later failure blocks hit", async () => {
  const { store } = await boot();
  seedThread(store);
  store.systemoneRecordSuccess(successInput("th_s1"));
  const hit = store.systemoneCacheHit({ threadId: "th_s1", cacheKey: "ck-th_s1" });
  assert.notEqual(hit, null);
  assert.equal(hit?.state, "current");
  assert.equal(store.systemoneCacheHit({ threadId: "th_s1", cacheKey: "other" }), null);
  store.systemoneRecordFailure({
    threadId: "th_s1",
    cacheKey: "ck-th_s1",
    fingerprint: "fp-th_s1",
    versionKey: "magpie|m|progress-p1.0|progress-q1.0",
    provider: "magpie",
    model: "m",
    outcome: "timeout",
    failureMessage: "slow",
  });
  assert.equal(store.systemoneCacheHit({ threadId: "th_s1", cacheKey: "ck-th_s1" }), null);
  const stale = store.systemoneView("th_s1")!;
  assert.equal(stale.state, "stale");
  assert.equal(stale.degradation?.code, "timeout");
});

test("store: breaker opens after 3 failures, resume clears", async () => {
  const { store } = await boot();
  seedThread(store);
  store.systemoneRecordSuccess(successInput("th_s1"));
  for (const outcome of ["timeout", "connection", "http_error"] as const) {
    store.systemoneRecordFailure({
      threadId: "th_s1",
      cacheKey: `ck-${outcome}`,
      fingerprint: "fp",
      versionKey: "magpie|m|progress-p1.0|progress-q1.0",
      provider: "magpie",
      model: "m",
      outcome,
      failureMessage: outcome,
    });
  }
  const opened = store.systemoneView("th_s1")!;
  assert.equal(opened.breakerOpen, true);
  const resumed = store.systemoneResumeBreaker({
    threadId: "th_s1",
    versionKey: "magpie|m|progress-p1.0|progress-q1.0",
    provider: "magpie",
    model: "m",
  });
  assert.equal(resumed.breakerOpen, false);
  assert.equal(resumed.state, "current");
});

test("store: version change marks stale without write", async () => {
  const { store, revisions } = await boot();
  seedThread(store);
  store.systemoneRecordSuccess({
    ...successInput("th_s1"),
    versionKey: "magpie|m|progress-p0.9|progress-q0.9",
  });
  const before = revisions();
  const stale = store.systemoneView("th_s1")!;
  assert.equal(stale.state, "stale");
  assert.equal(stale.degradation?.code, "version_changed");
  assert.notEqual(stale.verdict, null);
  assert.equal(store.systemoneUsageToday(FIXED_NOW).calls, 1);
  assert.equal(revisions(), before);
});

test("store: known thread without rows is unknown; missing thread is null", async () => {
  const { store } = await boot();
  seedThread(store);
  store.upsertThread({ id: "th_other", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: FIXED_NOW });
  const view = store.systemoneView("th_other")!;
  assert.equal(view.state, "unknown");
  assert.equal(view.verdict, null);
  assert.equal(store.systemoneView("missing"), null);
});

test("store: prune keeps latest 100 rows per thread", async () => {
  const { store } = await boot();
  seedThread(store);
  for (let i = 0; i < 105; i++) {
    store.systemoneRecordFailure({
      threadId: "th_s1",
      cacheKey: `ck-${i}`,
      fingerprint: `fp-${i}`,
      versionKey: "magpie|m|progress-p1.0|progress-q1.0",
      provider: "magpie",
      model: "m",
      outcome: "timeout",
      failureMessage: "slow",
    });
  }
  const count = store.db.prepare("SELECT count(*) AS n FROM systemone_assessments WHERE thread_id = ?").get("th_s1") as { n: number };
  assert.equal(count.n, 100);
});

test("store: explicit current version key marks model change stale", async () => {
  const { store } = await boot();
  seedThread(store);
  store.systemoneRecordSuccess({
    ...successInput("th_s1"),
    model: "old",
    versionKey: "magpie|old|progress-p1.0|progress-q1.0",
  });
  const stale = store.systemoneView("th_s1", "magpie|new|progress-p1.0|progress-q1.0")!;
  assert.equal(stale.state, "stale");
  assert.equal(stale.degradation?.code, "version_changed");
});

test("store: cache hit returns the verdict for its key, not a later success", async () => {
  const { store } = await boot();
  seedThread(store);
  store.systemoneRecordSuccess({
    ...successInput("th_s1"),
    cacheKey: "ck-old",
    verdict: verdict({ status: "progressing" }),
  });
  store.systemoneRecordSuccess({
    ...successInput("th_s1"),
    cacheKey: "ck-new",
    verdict: verdict({ status: "blocked" }),
  });
  const hit = store.systemoneCacheHit({
    threadId: "th_s1",
    cacheKey: "ck-old",
    currentVersionKey: "magpie|m|progress-p1.0|progress-q1.0",
  });
  assert.equal(hit?.verdict?.status, "progressing");
});

test("store: failed verdict writes do not change evidence fingerprint inputs", async () => {
  const { store } = await boot();
  seedThread(store);
  const now = store.now();
  store.commitSourceScan({
    source: {
      sourceId: "src_fp",
      path: "/tmp/fp.jsonl",
      threadId: "th_s1",
      inode: 7,
      size: 10,
      mtime: now,
      consumedBytes: 10,
      prefixHash: "p",
      tailHash: null,
      nextOrdinal: 1,
      parserVersion: 1,
      rewritten: false,
    },
    threads: [{
      id: "th_s1", harnessId: CODEX_HARNESS_ID, nativeSessionId: "th_s1", nativeStatus: "running",
      title: "t", lastActivityAt: now,
    }],
    turns: [{ id: "t0", threadId: "th_s1", ordinal: 0, nativeStatus: "completed", startedAt: now, endedAt: now, sourceRef: "src_fp" }],
    evidence: [{ threadId: "th_s1", sourceId: "src_fp", byteStart: 0, recordHash: "e0", turnOrdinal: 0, kind: "message", summary: "hi", props: null }],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  });
  const before = store.threadEvidenceFingerprint("th_s1");
  store.systemoneRecordFailure({
    threadId: "th_s1",
    cacheKey: "ck",
    fingerprint: "fp",
    versionKey: "magpie|m|progress-p1.0|progress-q1.0",
    provider: "magpie",
    model: "m",
    outcome: "timeout",
    failureMessage: "slow",
  });
  assert.equal(store.threadEvidenceFingerprint("th_s1"), before);
});
