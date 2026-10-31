import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import {
  isEvidenceRefsSubset,
  isNonNegativeInt,
  isSemanticStatus,
  isValidConfidence,
  isValidProvenance,
  SYSTEMONE_CONTRACT_VERSION,
  SYSTEMONE_PROMPT_VERSION,
  SYSTEMONE_QUESTION_VERSION,
} from "../src/systemone/contract.js";
import { readJudgeInput } from "../src/systemone/facts.js";
import {
  evidenceFingerprintOf,
  systemoneCacheKeyOf,
  systemoneVersionKeyOf,
} from "../src/systemone/fingerprint.js";
import { Store } from "../src/store/index.js";
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const boot = async (): Promise<Store> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-s1c-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  return new Store(db);
};

const seedThread = (store: Store): string => {
  const now = store.now();
  store.upsertThread({ id: "th_s1", harnessId: CODEX_HARNESS_ID, nativeStatus: "running", title: "t", lastActivityAt: now });
  store.commitSourceScan({
    source: {
      sourceId: "src_s1",
      path: "/tmp/s1.jsonl",
      threadId: "th_s1",
      inode: 1,
      size: 10,
      mtime: now,
      consumedBytes: 10,
      prefixHash: "p",
      tailHash: null,
      nextOrdinal: 2,
      parserVersion: 1,
      rewritten: false,
    },
    threads: [{
      id: "th_s1",
      harnessId: CODEX_HARNESS_ID,
      nativeSessionId: "th_s1",
      nativeStatus: "running",
      title: "t",
      workspace: "/tmp/ws",
      nativeGroup: null,
      sourcePath: "/tmp/s1.jsonl",
      sourceByteStart: 0,
      sourceRecordHash: "h0",
      lastActivityAt: now,
    }],
    turns: [
      { id: "turn_0", threadId: "th_s1", ordinal: 0, nativeStatus: "completed", startedAt: now - 2, endedAt: now - 1, sourceRef: "src_s1" },
      { id: "turn_1", threadId: "th_s1", ordinal: 1, nativeStatus: "running", startedAt: now, endedAt: null, sourceRef: "src_s1" },
    ],
    evidence: [
      { threadId: "th_s1", sourceId: "src_s1", byteStart: 0, recordHash: "e0", turnOrdinal: 0, kind: "message", summary: "hello", props: null },
    ],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [{
      threadId: "th_s1",
      text: "compacted baseline",
      sourceRef: "cmp_0",
      coveredThroughTurnOrdinal: 0,
    }],
    lineage: [],
  });
  return "th_s1";
};

test("contract: versions are pinned and validators behave", () => {
  assert.equal(SYSTEMONE_CONTRACT_VERSION, 1);
  assert.equal(SYSTEMONE_PROMPT_VERSION, "progress-p1.0");
  assert.equal(SYSTEMONE_QUESTION_VERSION, "progress-q1.0");
  assert.equal(isSemanticStatus("progressing"), true);
  assert.equal(isSemanticStatus("doing"), false);
  assert.equal(isValidConfidence(0), true);
  assert.equal(isValidConfidence(1), true);
  assert.equal(isValidConfidence(-0.1), false);
  assert.equal(isValidConfidence(1.1), false);
  assert.equal(isValidConfidence(Number.NaN), false);
  assert.equal(isEvidenceRefsSubset(["a"], ["a", "b"]), true);
  assert.equal(isEvidenceRefsSubset([], ["a"]), true);
  assert.equal(isEvidenceRefsSubset(["zz"], ["a"]), false);
  assert.equal(isValidProvenance("systemone:magpie/m@progress-p1.0"), true);
  assert.equal(isValidProvenance("jev:magpie/m@v1"), false);
  assert.equal(isNonNegativeInt(0), true);
  assert.equal(isNonNegativeInt(-1), false);
  assert.equal(isNonNegativeInt(1.5), false);
});

test("facts: bounded read of thread state", async () => {
  const store = await boot();
  const id = seedThread(store);
  const input = readJudgeInput(store, id)!;
  assert.equal(input.subject.threadId, id);
  assert.equal(input.subject.workspace, "/tmp/ws");
  assert.equal(input.turns.total, 2);
  assert.equal(input.evidence.length, 1);
  assert.equal(input.summary?.provenance, "compacted");
  assert.deepEqual(input.allowedEvidenceIds, input.evidence.map((item) => item.id));
});

test("facts: unknown thread reads null; empty thread is no_evidence", async () => {
  const store = await boot();
  assert.equal(readJudgeInput(store, "missing"), null);
  store.upsertThread({ id: "th_empty", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: store.now() });
  const empty = readJudgeInput(store, "th_empty")!;
  assert.equal(empty.turns.total, 0);
  assert.equal(empty.evidence.length, 0);
  assert.equal(empty.summary, null);
});

test("facts: latest 20 turns/evidence and thread-scoped notes", async () => {
  const store = await boot();
  const now = store.now();
  store.upsertThread({ id: "th_win", harnessId: CODEX_HARNESS_ID, nativeStatus: "running", lastActivityAt: now });
  store.upsertThread({ id: "th_other", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: now });
  store.commitSourceScan({
    source: {
      sourceId: "src_win",
      path: "/tmp/win.jsonl",
      threadId: "th_win",
      inode: 2,
      size: 10,
      mtime: now,
      consumedBytes: 10,
      prefixHash: "p",
      tailHash: null,
      nextOrdinal: 26,
      parserVersion: 1,
      rewritten: false,
    },
    threads: [{
      id: "th_win",
      harnessId: CODEX_HARNESS_ID,
      nativeSessionId: "th_win",
      nativeStatus: "running",
      title: "win",
      workspace: "/tmp/win",
      nativeGroup: null,
      sourcePath: "/tmp/win.jsonl",
      sourceByteStart: 0,
      sourceRecordHash: "h0",
      lastActivityAt: now,
    }],
    turns: Array.from({ length: 25 }, (_, i) => ({
      id: `turn_${i}`,
      threadId: "th_win",
      ordinal: i,
      nativeStatus: i % 2 === 0 ? "completed" : "running",
      startedAt: now,
      endedAt: i % 2 === 0 ? now : null,
      sourceRef: "src_win",
    })),
    evidence: Array.from({ length: 25 }, (_, i) => ({
      threadId: "th_win",
      sourceId: "src_win",
      byteStart: i,
      recordHash: `e${i}`,
      turnOrdinal: i,
      kind: "message",
      summary: `s${i}`,
      props: null,
    })),
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  });
  store.addAnnotation({ threadId: "th_win", kind: "note", body: "win note" });
  store.addAnnotation({ threadId: "th_other", kind: "note", body: "other note" });
  const input = readJudgeInput(store, "th_win")!;
  assert.equal(input.turns.total, 25);
  assert.equal(input.turns.latest?.ordinal, 24);
  assert.equal(input.evidence.length, 20);
  assert.deepEqual(
    new Set(input.evidence.map((item) => item.recordHash)),
    new Set(Array.from({ length: 20 }, (_, i) => `e${i + 5}`)),
  );
  assert.deepEqual(input.overlay.notes.map((note) => note.body), ["win note"]);
});

test("fingerprint: stability vectors and change triggers", async () => {
  const store = await boot();
  const id = seedThread(store);
  const { fingerprintInputOfJudgeInput } = await import("../src/systemone/facts.js");
  const base = fingerprintInputOfJudgeInput(readJudgeInput(store, id)!);
  const again = fingerprintInputOfJudgeInput(readJudgeInput(store, id)!);
  assert.equal(evidenceFingerprintOf(base), evidenceFingerprintOf(again));
  const changedEvidence = { ...base, evidence: [...base.evidence, ["ev_new", "message", 1, "h", "x"] as const] };
  assert.notEqual(evidenceFingerprintOf(base), evidenceFingerprintOf(changedEvidence));
  const changedTurns = { ...base, turnsTotal: base.turnsTotal + 1 };
  assert.notEqual(evidenceFingerprintOf(base), evidenceFingerprintOf(changedTurns));
  const changedSummary = {
    ...base,
    summary: ["compacted", "other", 1] as const,
  };
  assert.notEqual(evidenceFingerprintOf(base), evidenceFingerprintOf(changedSummary));
  const countsA = { ...base, turnsByStatus: { running: 1, completed: 2 } };
  const countsB = { ...base, turnsByStatus: { completed: 2, running: 1 } };
  assert.equal(evidenceFingerprintOf(countsA), evidenceFingerprintOf(countsB));
});

test("fingerprint: cache key binds provider/model/versions", async () => {
  const store = await boot();
  const id = seedThread(store);
  const { fingerprintInputOfJudgeInput } = await import("../src/systemone/facts.js");
  const fp = evidenceFingerprintOf(fingerprintInputOfJudgeInput(readJudgeInput(store, id)!));
  const base = { fingerprint: fp, provider: "magpie", model: "m", promptVersion: "progress-p1.0", questionVersion: "progress-q1.0" };
  const same = systemoneCacheKeyOf(base);
  assert.equal(systemoneCacheKeyOf({ ...base }), same);
  assert.notEqual(systemoneCacheKeyOf({ ...base, model: "other" }), same);
  assert.equal(systemoneVersionKeyOf(base), "magpie|m|progress-p1.0|progress-q1.0");
});
