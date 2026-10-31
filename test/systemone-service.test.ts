/**
 * SystemOneService 行为契约：全部走 FakeProvider（进程内），不碰真实网关。
 * 钉住零写入路径、并发上限、单飞合并、关闭语义与 Jev 陷阱隔离。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import { DEFAULT_SETTINGS } from "../src/store/index.js";
import { Store } from "../src/store/index.js";
import type { Settings } from "../src/types.js";
import { SystemOneProviderError } from "../src/systemone/errors.js";
import type { JudgeInput, SystemOneProvider } from "../src/systemone/provider.js";
import {
  SYSTEMONE_MAX_CONCURRENCY,
  SystemOneService,
  type SystemOneOutcome,
} from "../src/systemone/service.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

let clock = Date.parse("2026-10-27T00:00:00.000Z");
const tickNow = (): number => clock;

const boot = async (settingsPatch: Partial<Settings> = {}): Promise<{
  store: Store;
  settings: Settings;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-s1svc-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const store = new Store(db, { now: tickNow });
  const settings: Settings = { ...DEFAULT_SETTINGS, ...settingsPatch };
  return { store, settings };
};

const seedThread = (store: Store, id: string): void => {
  const now = store.now();
  store.upsertThread({ id, harnessId: CODEX_HARNESS_ID, nativeStatus: "running", title: "t", lastActivityAt: now });
  store.commitSourceScan({
    source: {
      sourceId: `src_${id}`,
      path: `/tmp/${id}.jsonl`,
      threadId: id,
      inode: id.length + 7,
      size: 10,
      mtime: now,
      consumedBytes: 10,
      prefixHash: "p",
      tailHash: null,
      nextOrdinal: 2,
      parserVersion: 1,
      rewritten: false,
    },
    threads: [],
    turns: [
      { id: `t_${id}_0`, threadId: id, ordinal: 0, nativeStatus: "completed", startedAt: now - 2, endedAt: now - 1, sourceRef: `src_${id}` },
      { id: `t_${id}_1`, threadId: id, ordinal: 1, nativeStatus: "running", startedAt: now, endedAt: null, sourceRef: `src_${id}` },
    ],
    evidence: [
      { threadId: id, sourceId: `src_${id}`, byteStart: 0, recordHash: "e0", turnOrdinal: 0, kind: "message", summary: "hello", props: null },
    ],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  });
};

type FakeBehavior =
  | { kind: "ok"; status?: string; confidence?: number; refs?: string[]; usage?: { inputTokens: number; outputTokens: number } | null }
  | { kind: "error"; code: "timeout" | "connection" | "http_error" | "invalid_output" | "auth" }
  | { kind: "hang"; resolveOnAbort?: boolean };

class FakeProvider implements SystemOneProvider {
  readonly id = "fake";
  calls = 0;
  model = "fake-model";
  availableOk = true;
  behavior: FakeBehavior = { kind: "ok" };
  inJudge = 0;
  maxInJudge = 0;
  private gate: { open: () => void; done: Promise<void> } | null = null;

  resolveModel(): string {
    return this.model;
  }

  available(): { ok: true } | { ok: false; reason: string } {
    return this.availableOk ? { ok: true } : { ok: false, reason: "no token env" };
  }

  hold(): Promise<void> {
    let open!: () => void;
    const done = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.gate = { open, done };
    return done;
  }

  release(): void {
    this.gate?.open();
    this.gate = null;
  }

  async judge(input: JudgeInput, signal: AbortSignal): Promise<{
    status: "progressing";
    confidence: number;
    evidenceRefs: string[];
    provider: string;
    model: string;
    usage: { inputTokens: number; outputTokens: number } | null;
  }> {
    this.calls += 1;
    this.inJudge += 1;
    this.maxInJudge = Math.max(this.maxInJudge, this.inJudge);
    try {
      if (this.gate !== null) {
        await this.gate.done;
      }
      if (this.behavior.kind === "hang") {
        await new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new SystemOneProviderError("timeout", "aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new SystemOneProviderError("timeout", "aborted")), { once: true });
        });
      }
      if (this.behavior.kind === "error") {
        throw new SystemOneProviderError(this.behavior.code, `fake ${this.behavior.code}`);
      }
      return {
        status: (this.behavior.status ?? "progressing") as "progressing",
        confidence: this.behavior.confidence ?? 0.8,
        evidenceRefs: this.behavior.refs ?? [],
        provider: this.id,
        model: this.model,
        usage: this.behavior.usage === undefined ? { inputTokens: 10, outputTokens: 5 } : this.behavior.usage,
      };
    } finally {
      this.inJudge -= 1;
    }
  }
}

const wire = async (settingsPatch: Partial<Settings> = {}) => {
  const { store, settings } = await boot(settingsPatch);
  const provider = new FakeProvider();
  const service = new SystemOneService({ store, provider, settings: () => settings, now: tickNow });
  return { store, settings, provider, service };
};

const outcomeOf = (outcome: SystemOneOutcome): SystemOneOutcome => outcome;

test("service: happy path writes once, reasonShort is a template, provenance is stamped", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_ok");
  const outcome = outcomeOf(await service.evaluate("th_ok"));
  assert.equal(outcome.called, true);
  assert.equal(outcome.degradation, null);
  assert.equal(outcome.view?.state, "current");
  assert.equal(outcome.view?.verdict?.status, "progressing");
  assert.match(outcome.view?.verdict?.reasonShort ?? "", /^进行中 · 最新 turn #1 · 1 条证据$/);
  assert.match(outcome.view?.verdict?.provenance ?? "", /^systemone:fake\/fake-model@progress-p1\.0$/);
  assert.equal(provider.calls, 1);
  const usage = store.systemoneUsageToday(tickNow());
  assert.deepEqual([usage.calls, usage.inputTokens, usage.outputTokens], [1, 10, 5]);
});

test("service: second evaluate with same fingerprint is a zero-write cache hit", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_cache");
  await service.evaluate("th_cache");
  const revisionsBefore = store.revisions().threads;
  const second = outcomeOf(await service.evaluate("th_cache"));
  assert.equal(second.called, false);
  assert.equal(second.degradation, null);
  assert.equal(second.view?.state, "current");
  assert.equal(provider.calls, 1);
  assert.equal(store.revisions().threads, revisionsBefore);
});

test("service: force bypasses cache and backoff but not breaker or availability", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_force");
  await service.evaluate("th_force");
  const forced = outcomeOf(await service.evaluate("th_force", { force: true }));
  assert.equal(forced.called, true);
  assert.equal(provider.calls, 2);
  provider.behavior = { kind: "error", code: "timeout" };
  for (let i = 0; i < 3; i++) {
    clock += 31_000;
    await service.evaluate("th_force", { force: true });
  }
  const breaker = outcomeOf(await service.evaluate("th_force", { force: true }));
  assert.equal(breaker.degradation, "breaker_open");
  assert.equal(breaker.called, false);
  assert.equal(provider.calls, 5);
});

test("service: backoff blocks a re-judge within 30s and force bypasses it", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_backoff");
  provider.behavior = { kind: "error", code: "timeout" };
  const first = outcomeOf(await service.evaluate("th_backoff"));
  assert.equal(first.degradation, "timeout");
  const second = outcomeOf(await service.evaluate("th_backoff"));
  assert.equal(second.degradation, "backoff");
  assert.equal(provider.calls, 1);
  clock += 31_000;
  const third = outcomeOf(await service.evaluate("th_backoff"));
  assert.equal(third.called, true);
  assert.equal(provider.calls, 2);
});

test("service: budget exhaustion is zero-write and checked under the semaphore", async () => {
  const { store, provider, service } = await wire({ systemoneDailyTokenBudget: 0 });
  seedThread(store, "th_budget");
  const before = store.revisions().threads;
  const outcome = outcomeOf(await service.evaluate("th_budget"));
  assert.equal(outcome.degradation, "budget_exhausted");
  assert.equal(outcome.called, false);
  assert.equal(provider.calls, 0);
  assert.equal(store.revisions().threads, before);
});

test("service: visible pre-check skips all when the budget is exhausted", async () => {
  const { store, provider, service } = await wire({ systemoneDailyTokenBudget: 0 });
  seedThread(store, "th_vb");
  const before = store.revisions().threads;
  const summary = service.visible(["th_vb"]);
  assert.equal(summary.started, 0);
  assert.deepEqual(summary.skipped, [{ threadId: "th_vb", reason: "budget_exhausted" }]);
  assert.equal(provider.calls, 0);
  assert.equal(store.revisions().threads, before);
});

test("service: shared daily usage across threads trips the budget", async () => {
  const { store, provider, service } = await wire({ systemoneDailyTokenBudget: 14 });
  seedThread(store, "th_b1");
  seedThread(store, "th_b2");
  await service.evaluate("th_b1");
  const second = outcomeOf(await service.evaluate("th_b2"));
  assert.equal(second.degradation, "budget_exhausted");
  assert.equal(provider.calls, 1);
});

test("service: no evidence is a no-write degradation", async () => {
  const { store, provider, service } = await wire();
  store.upsertThread({ id: "th_empty", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: tickNow() });
  const before = store.revisions().threads;
  const outcome = outcomeOf(await service.evaluate("th_empty"));
  assert.equal(outcome.degradation, "no_evidence");
  assert.equal(provider.calls, 0);
  assert.equal(store.revisions().threads, before);
});

test("service: disabled and provider-unavailable are zero-write", async () => {
  const { store, provider, service } = await wire({ systemoneEnabled: false });
  seedThread(store, "th_disabled");
  const outcome = outcomeOf(await service.evaluate("th_disabled"));
  assert.equal(outcome.degradation, "disabled");
  assert.equal(provider.calls, 0);
  const { store: store2, provider: provider2, service: service2 } = await wire();
  seedThread(store2, "th_unavail");
  provider2.availableOk = false;
  const outcome2 = outcomeOf(await service2.evaluate("th_unavail"));
  assert.equal(outcome2.degradation, "provider_unavailable");
  assert.equal(provider2.calls, 0);
});

test("service: unknown thread yields view null and visible skips it", async () => {
  const { provider, service } = await wire();
  const outcome = outcomeOf(await service.evaluate("ghost"));
  assert.equal(outcome.view, null);
  assert.equal(provider.calls, 0);
  const summary = service.visible(["ghost"]);
  assert.equal(summary.visible, 1);
  assert.equal(summary.started, 0);
  assert.deepEqual(summary.skipped, [{ threadId: "ghost", reason: "no_evidence" }]);
});

test("service: version change marks stale and a re-evaluate re-judges under the new model", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_version");
  await service.evaluate("th_version");
  provider.model = "fake-model-2";
  const stale = service.view("th_version");
  assert.equal(stale?.state, "stale");
  assert.equal(stale?.degradation?.code, "version_changed");
  const again = outcomeOf(await service.evaluate("th_version"));
  assert.equal(again.called, true);
  assert.equal(provider.calls, 2);
  assert.equal(service.view("th_version")?.state, "current");
});

test("service: breaker opens at 3 and resume clears without calling the provider", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_breaker");
  provider.behavior = { kind: "error", code: "http_error" };
  for (let i = 0; i < 3; i++) {
    clock += 31_000;
    await service.evaluate("th_breaker");
  }
  clock += 31_000;
  const blocked = outcomeOf(await service.evaluate("th_breaker"));
  assert.equal(blocked.degradation, "breaker_open");
  assert.equal(provider.calls, 3);
  const view = service.resume("th_breaker");
  assert.equal(view.breakerOpen, false);
  clock += 31_000;
  const after = outcomeOf(await service.evaluate("th_breaker"));
  assert.equal(after.called, true);
  assert.equal(provider.calls, 4);
});

test("service: resume on unknown thread throws NotFound", async () => {
  const { service } = await wire();
  assert.throws(() => service.resume("ghost"));
});

test("service: auth failure sets a 30s cooldown that blocks other threads", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_auth");
  provider.behavior = { kind: "error", code: "auth" };
  const first = outcomeOf(await service.evaluate("th_auth"));
  assert.equal(first.degradation, "auth");
  seedThread(store, "th_auth2");
  const second = outcomeOf(await service.evaluate("th_auth2"));
  assert.equal(second.degradation, "provider_unavailable");
  assert.equal(provider.calls, 1);
  clock += 31_000;
  const third = outcomeOf(await service.evaluate("th_auth2"));
  assert.equal(third.called, true);
  assert.equal(provider.calls, 2);
});

test("service: auth cooldown via visible path blocks skipped entries", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_vis1");
  provider.behavior = { kind: "error", code: "auth" };
  void (await service.evaluate("th_vis1"));
  seedThread(store, "th_vis2");
  const summary = service.visible(["th_vis2"]);
  assert.equal(summary.started, 0);
  assert.deepEqual(summary.skipped, [{ threadId: "th_vis2", reason: "provider_unavailable" }]);
});

test("service: global concurrency is capped and per-thread calls coalesce", async () => {
  const { store, provider, service } = await wire();
  const ids = ["th_c1", "th_c2", "th_c3", "th_c4"];
  for (const id of ids) seedThread(store, id);
  const held = provider.hold();
  const pending = ids.map((id) => service.evaluate(id));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(provider.maxInJudge, SYSTEMONE_MAX_CONCURRENCY);
  provider.release();
  await held;
  const outcomes = await Promise.all(pending);
  for (const outcome of outcomes) assert.equal(outcome.called, true);
  assert.equal(provider.calls, 4);
  seedThread(store, "th_c5");
  provider.maxInJudge = 0;
  const gate = provider.hold();
  const pair = [service.evaluate("th_c5"), service.evaluate("th_c5")];
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(provider.calls, 5);
  provider.release();
  await gate;
  const pairOutcomes = await Promise.all(pair);
  assert.equal(pairOutcomes[0]!.threadId, "th_c5");
  assert.equal(pairOutcomes[1]!.threadId, "th_c5");
  assert.equal(pairOutcomes[1]!.called, true);
  assert.equal(provider.maxInJudge, 1);
});

test("service: disable while queued prevents the provider call after the semaphore", async () => {
  const { store, settings, provider, service } = await wire();
  const ids = ["th_q1", "th_q2", "th_q3"];
  for (const id of ids) seedThread(store, id);
  provider.hold();
  const first = service.evaluate("th_q1");
  const second = service.evaluate("th_q2");
  const queued = service.evaluate("th_q3");
  await new Promise((resolve) => setTimeout(resolve, 20));
  settings.systemoneEnabled = false;
  provider.release();
  const outcomes = await Promise.all([first, second, queued]);
  assert.equal(provider.calls, 2);
  assert.equal(outcomes[2]!.called, false);
  assert.equal(outcomes[2]!.degradation, "disabled");
});

test("service: close aborts in-flight judges and no writes happen after close", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_close");
  provider.behavior = { kind: "hang" };
  provider.hold();
  const pending = service.evaluate("th_close");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(provider.calls, 1);
  const closing = service.close();
  provider.release();
  const outcome = await pending;
  await closing;
  assert.equal(outcome.called, true);
  assert.equal(outcome.degradation, "timeout");
  const count = (store.db.prepare("SELECT count(*) AS n FROM systemone_assessments").get() as { n: number }).n;
  assert.equal(count, 0);
  const afterClose = outcomeOf(await service.evaluate("th_close"));
  assert.equal(afterClose.degradation, "provider_unavailable");
  assert.equal(provider.calls, 1);
});

test("service: runtime view discloses budget/concurrency/breaker and never tokens", async () => {
  const { provider, service } = await wire({ systemoneDailyTokenBudget: 5000 });
  const runtime = service.runtime();
  assert.equal(runtime.enabled, true);
  assert.equal(runtime.provider, "fake");
  assert.equal(runtime.model, "fake-model");
  assert.equal(runtime.available, true);
  assert.equal(runtime.unavailableReason, null);
  assert.deepEqual(runtime.budget, { day: "2026-10-27", usedTokens: 0, limitTokens: 5000, exhausted: false });
  assert.deepEqual(runtime.concurrency, { limit: 2, inFlight: 0 });
  assert.deepEqual(runtime.breaker, { threshold: 3, backoffMs: 30000 });
  assert.equal(runtime.promptVersion, "progress-p1.0");
  assert.ok(Array.isArray(runtime.externalData));
  assert.ok(runtime.externalData.some((line) => line.includes("workspace")));
  assert.ok(runtime.externalData.some((line) => line.includes("证据")));
  assert.ok(runtime.externalData.some((line) => line.includes("注记")));
  assert.ok(!runtime.externalData.join(" ").toLowerCase().includes("token"));
  provider.availableOk = false;
  assert.equal(service.runtime().available, false);
  assert.match(service.runtime().unavailableReason ?? "", /token/);
});

test("service: Jev-trap guard — verdict rows never re-arm the fingerprint", async () => {
  const { store, provider, service } = await wire();
  seedThread(store, "th_jev");
  await service.evaluate("th_jev");
  const second = outcomeOf(await service.evaluate("th_jev"));
  assert.equal(second.called, false);
  assert.equal(provider.calls, 1);
  const view = service.view("th_jev");
  assert.equal(view?.state, "current");
  assert.equal(store.revisions().threads > 0, true);
});
