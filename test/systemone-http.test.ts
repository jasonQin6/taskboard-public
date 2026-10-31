/**
 * SystemOne HTTP 面：三个 action、state/detail 投影、501 缺省、参数校验与执行面隔离。
 * 直接装配 createHttpServer + 进程内 FakeProvider，不碰真实 Magpie。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import { createHttpServer, type TaskboardHttp } from "../src/http.js";
import { SingleFlightRegistry } from "../src/single-flight.js";
import { DEFAULT_SETTINGS, Store } from "../src/store/index.js";
import type { Settings } from "../src/types.js";
import type { JudgeInput, SystemOneProvider } from "../src/systemone/provider.js";
import { SystemOneProviderError } from "../src/systemone/errors.js";
import { SystemOneService } from "../src/systemone/service.js";
import type { ViewContext } from "../src/views.js";

const tmpDirs: string[] = [];
const boots: Array<{ http: TaskboardHttp; service: SystemOneService }> = [];
afterEach(async () => {
  while (boots.length > 0) {
    const booted = boots.pop()!;
    await booted.http.shutdown();
    await booted.service.close();
  }
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

class FakeProvider implements SystemOneProvider {
  readonly id = "fake";
  model = "fake-model";
  calls = 0;
  behavior: "ok" | "fail" = "ok";

  resolveModel(): string {
    return this.model;
  }

  available(): { ok: true } {
    return { ok: true };
  }

  async judge(_input: JudgeInput, _signal: AbortSignal) {
    this.calls += 1;
    if (this.behavior === "fail") {
      throw new SystemOneProviderError("http_error", "fake gateway failure");
    }
    return {
      status: "progressing" as const,
      confidence: 0.8,
      evidenceRefs: [],
      provider: this.id,
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

interface Harness {
  store: Store;
  settings: Settings;
  provider: FakeProvider;
  service: SystemOneService;
  base: string;
  advance: (ms: number) => void;
}

const seedThread = (store: Store, id: string): void => {
  const now = store.now();
  store.upsertThread({ id, harnessId: CODEX_HARNESS_ID, nativeStatus: "running", title: `t ${id}`, lastActivityAt: now });
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
    threads: [{
      id,
      harnessId: CODEX_HARNESS_ID,
      nativeSessionId: id,
      nativeStatus: "running",
      title: `t ${id}`,
      workspace: "/tmp/ws",
      nativeGroup: null,
      sourcePath: `/tmp/${id}.jsonl`,
      sourceByteStart: 0,
      sourceRecordHash: "h0",
      lastActivityAt: now,
    }],
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

const boot = async (options: { withService?: boolean } = {}): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-s1http-"));
  tmpDirs.push(dir);
  let nowMs = Date.parse("2026-10-27T00:00:00.000Z");
  const now = (): number => nowMs;
  const dbPath = join(dir, "taskboard.sqlite");
  const { db } = await openStateDb(dbPath);
  const store = new Store(db, { now });
  const settings: Settings = { ...DEFAULT_SETTINGS };
  const provider = new FakeProvider();
  const service = new SystemOneService({ store, provider, settings: () => settings, now });
  const withService = options.withService !== false;
  const views: ViewContext = {
    store,
    singleFlight: new SingleFlightRegistry(),
    runtime: () => ({
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      powerProtection: "off",
      proxyGuard: false,
      driver: { available: false, note: "test" },
    }),
    ...(withService ? { systemone: service } : {}),
  };
  const http = createHttpServer({
    store,
    views,
    dbPath,
    ...(withService ? { systemone: service } : {}),
  });
  boots.push({ http, service });
  const port = await new Promise<number>((resolve) => {
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return { store, settings, provider, service, base: `http://127.0.0.1:${port}`, advance: (ms) => (nowMs += ms) };
};

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const getJson = async (base: string, path: string): Promise<JsonResponse> => {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const postAction = async (
  base: string,
  type: string,
  fields: Record<string, unknown>,
): Promise<JsonResponse> => {
  const res = await fetch(`${base}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, requestId: crypto.randomUUID(), ...fields }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const waitFor = async (predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for SystemOne state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const VIEW_KEYS = ["breakerOpen", "degradation", "lastAttemptAt", "state", "threadId", "verdict"];
const VERDICT_KEYS = ["assessedAt", "confidence", "coversThrough", "evidenceRefs", "provenance", "reasonShort", "status"];
const RUNTIME_KEYS = [
  "available", "breaker", "budget", "concurrency", "enabled", "externalData", "model",
  "promptVersion", "provider", "questionVersion", "unavailableReason",
];

test("systemone-http: 未装配服务时 state/detail 为空且三个 action 501", async () => {
  const { store, base } = await boot({ withService: false });
  seedThread(store, "th_none");
  const state = await getJson(base, "/api/state");
  assert.deepEqual(state.body.progressVerdicts, []);
  assert.equal((state.body.runtime as Record<string, unknown>).systemone, null);
  const detail = await getJson(base, "/api/threads/th_none");
  const thread = detail.body.thread as Record<string, unknown>;
  assert.equal(thread.progressVerdict, null);
  assert.equal(thread.semanticStatus, null);
  for (const [type, fields] of [
    ["systemone.visible", { threadIds: ["th_none"] }],
    ["systemone.refresh", { threadId: "th_none" }],
    ["systemone.resume", { threadId: "th_none" }],
  ] as const) {
    const res = await postAction(base, type, fields);
    assert.equal(res.status, 501, `${type} 缺省应 501`);
  }
});

test("systemone-http: visible 启动后台判定，state 与 detail 投影 verdict", async () => {
  const { store, provider, base } = await boot();
  seedThread(store, "th_a");
  seedThread(store, "th_b");
  const visible = await postAction(base, "systemone.visible", {
    threadIds: ["th_a", "th_b", "ghost"],
  });
  assert.equal(visible.status, 200);
  assert.deepEqual(Object.keys(visible.body).sort(), ["ok", "skipped", "started", "visible"]);
  assert.equal(visible.body.visible, 3);
  assert.equal(visible.body.started, 2);
  assert.deepEqual(visible.body.skipped, [{ threadId: "ghost", reason: "no_evidence" }]);
  await waitFor(async () => {
    const state = await getJson(base, "/api/state");
    const runtime = (state.body.runtime as Record<string, unknown>).systemone as Record<string, unknown>;
    const concurrency = runtime.concurrency as Record<string, unknown>;
    return ((state.body.progressVerdicts as unknown[]) ?? []).length === 2 && concurrency.inFlight === 0;
  });
  const state = await getJson(base, "/api/state");
  const verdicts = state.body.progressVerdicts as Array<Record<string, unknown>>;
  for (const id of ["th_a", "th_b"]) {
    const view = verdicts.find((candidate) => candidate.threadId === id)!;
    assert.deepEqual(Object.keys(view).sort(), VIEW_KEYS);
    assert.equal(view.state, "current");
    const verdict = view.verdict as Record<string, unknown>;
    assert.deepEqual(Object.keys(verdict).sort(), VERDICT_KEYS);
    assert.equal(verdict.status, "progressing");
    assert.equal(verdict.provenance, "systemone:fake/fake-model@progress-p1.0");
    assert.equal(verdict.coversThrough !== null, true);
  }
  const runtime = (state.body.runtime as Record<string, unknown>).systemone as Record<string, unknown>;
  assert.deepEqual(Object.keys(runtime).sort(), RUNTIME_KEYS);
  assert.equal(runtime.enabled, true);
  assert.equal(runtime.provider, "fake");
  assert.equal(runtime.model, "fake-model");
  assert.ok(Array.isArray(runtime.externalData));
  assert.ok((runtime.externalData as string[]).some((line) => line.includes("workspace")));
  assert.deepEqual(runtime.budget, { day: "2026-10-27", usedTokens: 30, limitTokens: 200_000, exhausted: false });
  assert.deepEqual(runtime.concurrency, { limit: 2, inFlight: 0 });
  assert.deepEqual(runtime.breaker, { threshold: 3, backoffMs: 30_000 });
  assert.equal(provider.calls, 2);

  const detail = await getJson(base, "/api/threads/th_a");
  const thread = detail.body.thread as Record<string, unknown>;
  assert.equal(thread.semanticStatus, "progressing");
  const progressVerdict = thread.progressVerdict as Record<string, unknown>;
  assert.deepEqual(Object.keys(progressVerdict).sort(), VIEW_KEYS);
  assert.equal((progressVerdict.verdict as Record<string, unknown>).status, "progressing");
});

test("systemone-http: refresh 强制再判定，未知线程 404", async () => {
  const { store, provider, base } = await boot();
  seedThread(store, "th_refresh");
  const first = await postAction(base, "systemone.refresh", { threadId: "th_refresh" });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.body).sort(), ["ok", "outcome"]);
  const outcome = first.body.outcome as Record<string, unknown>;
  assert.deepEqual(Object.keys(outcome).sort(), ["called", "degradation", "threadId", "view"]);
  assert.equal(outcome.called, true);
  assert.equal(outcome.degradation, null);
  const second = await postAction(base, "systemone.refresh", { threadId: "th_refresh" });
  assert.equal(second.status, 200);
  assert.equal(provider.calls, 2, "refresh 必绕缓存再调 provider");
  const missing = await postAction(base, "systemone.refresh", { threadId: "ghost" });
  assert.equal(missing.status, 404);
});

test("systemone-http: resume 清断路器，未知线程 404", async () => {
  const { store, provider, base, advance } = await boot();
  seedThread(store, "th_break");
  provider.behavior = "fail";
  for (let i = 0; i < 3; i++) {
    advance(31_000);
    const failed = await postAction(base, "systemone.refresh", { threadId: "th_break" });
    assert.equal(failed.status, 200);
    assert.equal((failed.body.outcome as Record<string, unknown>).called, true);
  }
  advance(31_000);
  const blocked = await postAction(base, "systemone.refresh", { threadId: "th_break" });
  assert.equal((blocked.body.outcome as Record<string, unknown>).degradation, "breaker_open");
  const resumed = await postAction(base, "systemone.resume", { threadId: "th_break" });
  assert.equal(resumed.status, 200);
  assert.deepEqual(Object.keys(resumed.body).sort(), ["ok", "view"]);
  assert.equal((resumed.body.view as Record<string, unknown>).breakerOpen, false);
  assert.equal(provider.calls, 3, "resume 不得调用 provider");
  const missing = await postAction(base, "systemone.resume", { threadId: "ghost" });
  assert.equal(missing.status, 404);
});

test("systemone-http: threadIds/threadId 参数校验落 400", async () => {
  const { store, base } = await boot();
  seedThread(store, "th_v");
  const badVisible = [
    {},
    { threadIds: "th_v" },
    { threadIds: [] },
    { threadIds: Array.from({ length: 65 }, (_, index) => `t${index}`) },
    { threadIds: [1] },
    { threadIds: ["   "] },
    { threadIds: ["th_v", "th_v"] },
  ];
  for (const fields of badVisible) {
    const res = await postAction(base, "systemone.visible", fields);
    assert.equal(res.status, 400, `visible ${JSON.stringify(fields)} 应 400`);
  }
  for (const type of ["systemone.refresh", "systemone.resume"]) {
    const res = await postAction(base, type, {});
    assert.equal(res.status, 400, `${type} 缺 threadId 应 400`);
  }
});

test("systemone-http: action 只 touch threads，不改任务/运行/提案/注记/nativeStatus", async () => {
  const { store, base } = await boot();
  seedThread(store, "th_iso");
  const before = {
    tasks: store.listTasks(),
    proposals: store.listProposals({ limit: 100 }),
    annotations: store.listAnnotations({}),
    executions: store.listActionExecutions({}),
    activeRuns: store.countActiveRuns(),
    thread: store.listThreads().find((thread) => thread.id === "th_iso"),
    revisions: store.revisions(),
  };
  assert.ok(before.thread !== undefined);
  const res = await postAction(base, "systemone.refresh", { threadId: "th_iso" });
  assert.equal(res.status, 200);
  assert.deepEqual(store.listTasks(), before.tasks);
  assert.deepEqual(store.listProposals({ limit: 100 }), before.proposals);
  assert.deepEqual(store.listAnnotations({}), before.annotations);
  assert.deepEqual(store.listActionExecutions({}), before.executions);
  assert.equal(store.countActiveRuns(), before.activeRuns);
  assert.deepEqual(store.listThreads().find((thread) => thread.id === "th_iso"), before.thread);
  assert.equal(store.revisions().tasks, before.revisions.tasks);
  assert.equal(store.revisions().config, before.revisions.config);
  assert.ok(store.revisions().threads > before.revisions.threads);
});
