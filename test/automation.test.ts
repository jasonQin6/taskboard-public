/**
 * 自动化 scheduler、默认策略与 live 低风险自动执行（issue #11 / Wave 3-A）。
 * 分层：Store 默认策略原语 → scheduler 候选纯函数 → daemon 贯通（空闲触发、去重、自动执行、pause、shadow/live 门）。
 * 全部经 daemon 公共 API 缝（ADR-0012）+ 假 app-server；时间语义用注入时钟（now 可推进）。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { parseCreateTaskInput, parseUpdateTaskInput } from "../src/task-input.js";
import { Store } from "../src/store/index.js";
import { AutomationScheduler, EVALUATION_CONCURRENCY, idleEvaluationCandidates } from "../src/automation.js";
import { openStateDb } from "../src/db.js";

// reader 隔离：本文件进程内把 CODEX_HOME 指到临时目录（driver 子进程继承）
const CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-auto-"));
process.env.CODEX_HOME = CODEX_HOME;

const FAKE_APP_SERVER_PATH = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  assert.equal(
    process.getActiveResourcesInfo().includes("ProcessWrap"),
    false,
    "child process handle leaked after daemon close",
  );
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

interface BootOptions {
  driverEnv?: Record<string, string>;
  /** 注入时钟：测试直接推进 nowMs.value 控制空闲/阈值语义。 */
  nowMs?: { value: number };
  automationTickMs?: number;
  scanIntervalMs?: number;
}

const boot = async (options: BootOptions = {}): Promise<RunningDaemon> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-auto-"));
  tmpDirs.push(dir);
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(dir, "taskboard.sqlite"),
    driver: {
      command: process.execPath,
      args: [FAKE_APP_SERVER_PATH],
      env: { ...process.env, FAKE_TURN_DELAY_MS: "25", ...options.driverEnv },
    },
    ...(options.nowMs !== undefined ? { now: () => options.nowMs!.value } : {}),
    ...(options.automationTickMs !== undefined ? { automationTickMs: options.automationTickMs } : {}),
    scanIntervalMs: options.scanIntervalMs ?? 20,
  });
  daemons.push(daemon);
  return daemon;
};

const post = async (
  daemon: RunningDaemon,
  type: string,
  fields: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, requestId: `t-${Math.random().toString(36).slice(2)}`, ...fields }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const getJson = async <T>(daemon: RunningDaemon, path: string): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`);
  return (await response.json()) as T;
};

const until = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

interface TaskView {
  id: string;
  status: string;
  automationMode: string;
  acceptanceMode: string;
  badges: string[];
  primaryThreadId: string | null;
  lastRun: { id: string; status: string } | null;
}

const taskView = async (daemon: RunningDaemon, taskId: string): Promise<TaskView> => {
  const payload = await getJson<{ task: TaskView }>(daemon, `/api/tasks/${taskId}`);
  return payload.task;
};

const createTask = async (daemon: RunningDaemon, fields: Record<string, unknown> = {}): Promise<string> => {
  const response = await post(daemon, "task.create", {
    title: "auto task",
    prompt: "do it",
    workspace: "/tmp/ws",
    ...fields,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body.task as { id: string }).id;
};

// ---- Store 层：默认策略原语 ----

const makeStore = async (): Promise<{ store: Store; nowMs: { value: number } }> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-auto-store-"));
  tmpDirs.push(dir);
  const { db } = await openStateDbFor(dir);
  const nowMs = { value: Date.parse("2026-10-22T10:00:00.000Z") };
  return { store: new Store(db, { now: () => nowMs.value }), nowMs };
};

const openStateDbFor = async (dir: string) => {
  const { openStateDb } = await import("../src/db.js");
  return openStateDb(join(dir, "taskboard.sqlite"));
};

test("store: taskboard 创建并绑定主线程把未显式设置的 suggest 任务升级为 auto，显式设置不动 (故事 49)", async () => {
  const { store } = await makeStore();
  const implicit = store.createTask(parseCreateTaskInput({ title: "a", prompt: "p", workspace: "/tmp/ws" }));
  assert.equal(implicit.automationMode, "suggest");
  const explicitSuggest = store.createTask(
    parseCreateTaskInput({ title: "b", prompt: "p", workspace: "/tmp/ws", automationMode: "suggest" }),
  );
  const explicitOff = store.createTask(
    parseCreateTaskInput({ title: "c", prompt: "p", workspace: "/tmp/ws", automationMode: "off" }),
  );

  store.applyTaskboardThreadDefault(implicit.id);
  store.applyTaskboardThreadDefault(explicitSuggest.id);
  store.applyTaskboardThreadDefault(explicitOff.id);

  assert.equal(store.requireTask(implicit.id).automationMode, "auto");
  assert.equal(store.requireTask(explicitSuggest.id).automationMode, "suggest", "explicit suggest must win");
  assert.equal(store.requireTask(explicitOff.id).automationMode, "off", "explicit off must win");
});

test("store: 显式 update 之后的任务不再被默认策略覆盖", async () => {
  const { store } = await makeStore();
  const task = store.createTask(parseCreateTaskInput({ title: "a", prompt: "p", workspace: "/tmp/ws" }));
  store.applyTaskboardThreadDefault(task.id);
  assert.equal(store.requireTask(task.id).automationMode, "auto");
  store.updateTask(task.id, parseUpdateTaskInput({ automationMode: "suggest" }));
  store.applyTaskboardThreadDefault(task.id);
  assert.equal(store.requireTask(task.id).automationMode, "suggest", "post-update explicit choice must stick");
});

// ---- daemon 贯通：run 创建并绑定主线程 → 默认策略生效 ----

test("daemon: run 创建主线程后任务 automation 默认升级 auto；外部线程绑定保持 suggest (故事 49/50)", async () => {
  const daemon = await boot();
  const implicit = await createTask(daemon);
  const external = await createTask(daemon);

  await post(daemon, "run.create", { taskId: implicit });
  await until(async () => (await taskView(daemon, implicit)).lastRun?.status === "completed");
  assert.equal((await taskView(daemon, implicit)).automationMode, "auto");

  // 外部扫描线程：手动绑定不改 automation（默认 suggest）
  const { resetClock, sessionMeta, taskComplete, taskStarted } = await import("./helpers/rollout.js");
  resetClock();
  const lines = [sessionMeta(0, { sessionId: "ext-bind", cwd: "/tmp/ws" }), taskStarted(1, "t1"), taskComplete(2, "t1")];
  const dir = join(CODEX_HOME, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout-ext-bind.jsonl"), `${lines.join("\n")}\n`);
  await until(async () => {
    const inbox = await getJson<{ inbox: Array<{ id: string }> }>(daemon, "/api/state");
    return inbox.inbox.some((thread) => thread.id === "ext-bind");
  });
  await post(daemon, "thread.bind", { taskId: external, threadId: "ext-bind" });
  assert.equal((await taskView(daemon, external)).automationMode, "suggest");
});

test("daemon: 用户显式设置 suggest 的任务经 run 创建主线程后仍是 suggest (故事 49)", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, { automationMode: "suggest" });
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed");
  assert.equal((await taskView(daemon, taskId)).automationMode, "suggest");
});

// ---- scheduler 候选纯函数：空闲阈值 / 去重 / 新证据再武装（A12，故事 45/46/47/48） ----

const IDLE_MS = 600_000;
const T0_AUTO = Date.parse("2026-10-22T10:00:00.000Z");

const seedIdleBoundTask = (
  store: Store,
  overrides: {
    automationMode?: "off" | "suggest" | "auto";
    status?: "todo" | "done" | "failed";
    idleThresholdMs?: number;
    lastActivityAt?: number;
  } = {},
): { taskId: string; threadId: string } => {
  const task = store.createTask(
    parseCreateTaskInput({
      title: "sched",
      prompt: "p",
      workspace: "/tmp/ws",
      ...(overrides.automationMode !== undefined ? { automationMode: overrides.automationMode } : {}),
      ...(overrides.idleThresholdMs !== undefined ? { idleThresholdMs: overrides.idleThresholdMs } : {}),
    }),
  );
  if (overrides.status === "done") store.moveTask(task.id, "done");
  if (overrides.status === "failed") store.moveTask(task.id, "failed");
  store.upsertThread({
    id: `th_${task.id}`,
    harnessId: CODEX_HARNESS_ID,
    nativeStatus: "idle",
    lastActivityAt: overrides.lastActivityAt ?? T0_AUTO - IDLE_MS - 1,
  });
  store.bindThread(task.id, `th_${task.id}`);
  return { taskId: task.id, threadId: `th_${task.id}` };
};

test("scheduler candidates: 空闲阈值达到才触发，off/done/failed/活跃 Run/pause 不触发 (故事 45/46)", async () => {
  const { store, nowMs } = await makeStore();
  store.updateSettings({ idleThresholdMs: IDLE_MS });
  const idle = seedIdleBoundTask(store);
  const fresh = seedIdleBoundTask(store, { lastActivityAt: T0_AUTO - 1_000 });
  const off = seedIdleBoundTask(store, { automationMode: "off" });
  const done = seedIdleBoundTask(store, { status: "done" });
  const override = seedIdleBoundTask(store, { idleThresholdMs: IDLE_MS * 10 });
  nowMs.value = T0_AUTO;

  let candidates = idleEvaluationCandidates(store, nowMs.value);
  const ids = candidates.map((candidate) => candidate.threadId);
  assert.ok(ids.includes(idle.threadId));
  assert.ok(!ids.includes(fresh.threadId), "not idle yet");
  assert.ok(!ids.includes(off.threadId), "automation=off is never scheduled");
  assert.ok(!ids.includes(done.threadId), "finished tasks are not scheduled");
  assert.ok(!ids.includes(override.threadId), "per-task idle threshold override wins (故事 46)");

  store.createRun(idle.taskId, "manual"); // queued 活跃 Run：不评估
  candidates = idleEvaluationCandidates(store, nowMs.value);
  assert.ok(!candidates.some((candidate) => candidate.threadId === idle.threadId), "active run blocks scheduling");

  store.updateSettings({ automationPaused: true });
  assert.deepEqual(idleEvaluationCandidates(store, nowMs.value), [], "pause stops new evaluations immediately");
});

test("scheduler candidates: 同一指纹的落定结论不再触发；断路器打开不触发；新证据改变指纹后再触发 (A12)", async () => {
  const { store, nowMs } = await makeStore();
  store.updateSettings({ idleThresholdMs: IDLE_MS });
  const { threadId } = seedIdleBoundTask(store);
  nowMs.value = T0_AUTO;
  assert.equal(idleEvaluationCandidates(store, nowMs.value).length, 1);

  // 落定 no_op 结论：同指纹不再触发（调度层推广，A12 的 no_op 不重复调用 Jev）
  const fingerprint = store.threadEvidenceFingerprint(threadId);
  store.recordEvaluationSettled(threadId, fingerprint, { noOp: true });
  assert.equal(idleEvaluationCandidates(store, nowMs.value).length, 0, "settled no_op is not rescheduled");

  // 非 no_op 结论同样不重复烧钱（同一问题同一证据不问第二遍）
  store.recordEvaluationSettled(threadId, fingerprint, { noOp: false });
  assert.equal(idleEvaluationCandidates(store, nowMs.value).length, 0, "settled non-no_op is not rescheduled either");

  // 断路器打开：不触发
  store.recordEvaluationFailure(threadId, "boom");
  store.recordEvaluationFailure(threadId, "boom");
  store.recordEvaluationFailure(threadId, "boom");
  store.recordEvaluationSettled(threadId, `${fingerprint}+new`, { noOp: true });
  assert.equal(idleEvaluationCandidates(store, nowMs.value).length, 0, "open breaker blocks scheduling");

  // 人工恢复断路器后：消费当前指纹（与证据一致），不触发
  store.resetEvaluationBreaker(threadId);
  store.recordEvaluationSettled(threadId, store.threadEvidenceFingerprint(threadId), { noOp: true });
  assert.equal(idleEvaluationCandidates(store, nowMs.value).length, 0, "settled for the current fingerprint");

  // 新证据落库（终态动作行改变指纹）：再武装（故事 48）
  const settledFingerprint = store.threadEvidenceFingerprint(threadId);
  const action = store.beginActionExecution({ action: "jev.evaluate", trigger: "auto", threadId });
  store.finishActionExecution(action.id, "completed", {});
  assert.notEqual(store.threadEvidenceFingerprint(threadId), settledFingerprint);
  assert.equal(idleEvaluationCandidates(store, nowMs.value).length, 1, "new evidence re-arms evaluation (故事 48)");
});

test("scheduler start-after-stop 复活：stop 不再把实例判死刑", async () => {
  const { store, nowMs } = await makeStore();
  store.updateSettings({ idleThresholdMs: IDLE_MS });
  const { threadId } = seedIdleBoundTask(store);
  nowMs.value = T0_AUTO;
  const evaluated: string[] = [];
  // intervalMs 拉长到测试期内不会触发：评估只由 start() 的立即 tick 驱动，时间面确定
  const scheduler = new AutomationScheduler({
    store,
    onEvaluate: (candidate) => {
      evaluated.push(candidate.threadId);
    },
    now: () => nowMs.value,
    intervalMs: 60_000,
  });
  scheduler.start();
  // start() 的立即 tick 在 fire-and-forget 里完成全部工作：跨宏任务边界等它落定再继续
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(evaluated.includes(threadId), "start 触发首次评估");
  scheduler.stop();

  evaluated.length = 0;
  await scheduler.tick(); // stop 后 tick 必须是 no-op（连评估意图都不该有）
  assert.equal(evaluated.length, 0, "stop 后 tick 不触发");

  scheduler.start(); // 复活点：start 必须复位 stopped（红：不复位则这里永远沉寂）
  // start() 的立即 tick 是 fire-and-forget：跨宏任务边界等它完全落定（ticking 复位），再断言复活
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(evaluated.includes(threadId), "stop→start 复活：评估恢复触发");
  scheduler.stop();
});

test("tick 内候选评估走有界并发窗口：慢评估不再串行阻塞全部线程，且并发不越上限", async () => {
  const { store, nowMs } = await makeStore();
  store.updateSettings({ idleThresholdMs: IDLE_MS });
  const total = 6;
  for (let i = 0; i < total; i++) seedIdleBoundTask(store);
  nowMs.value = T0_AUTO;
  let concurrent = 0;
  let peak = 0;
  let calls = 0;
  const scheduler = new AutomationScheduler({
    store,
    onEvaluate: async () => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 20));
      concurrent -= 1;
      calls += 1;
    },
    now: () => nowMs.value,
  });
  await scheduler.tick();
  assert.equal(calls, total, "每个候选都被评估（无饿死）");
  assert.ok(peak > 1, `候选评估应并行展开，实测峰值 ${peak}`);
  assert.ok(peak <= EVALUATION_CONCURRENCY, `并发峰值 ${peak} 越过了有界窗口 ${EVALUATION_CONCURRENCY}`);
  scheduler.stop();
});

// ---- daemon 贯通：空闲触发评估、no_op 不重复、新 turn 再评估（A12） ----

const NOOP_ANSWER = JSON.stringify({
  needs_attention: false,
  progress: "quiet",
  summary_short: "nothing to do",
  candidates: [{ action: "no_op", reason_short: "quiet", risk: "low", evidence_refs: [] }],
  recommended: "no_op",
  confidence: 0.9,
});

const jevEvaluateRowCount = (daemon: RunningDaemon, threadId: string): number =>
  daemon.store
    .listActionExecutions({ threadId, limit: 200 })
    .filter((row) => row.action === "jev.evaluate" && row.trigger === "auto").length;

test("daemon scheduler: 空闲触发一次评估；no_op 不重复；新 turn 后再次评估 (A12)", async () => {
  const { T0 } = await import("./helpers/rollout.js");
  const nowMs = { value: T0 + 30 * 60_000 }; // rollout 活动在 T0 附近：30 分钟后即空闲（默认阈值 10 分钟）
  const daemon = await boot({ driverEnv: { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-sched", FAKE_JEV_ANSWER: NOOP_ANSWER }, nowMs, automationTickMs: 10 });
  const { resetClock, sessionMeta, taskComplete, taskStarted, tick: tickClock } = await import("./helpers/rollout.js");
  resetClock();
  const lines = [sessionMeta(0, { sessionId: "ext-sched", cwd: "/tmp/ws" }), taskStarted(1, "t1"), taskComplete(2, "t1")];
  const dir = join(CODEX_HOME, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "rollout-ext-sched.jsonl"), `${lines.join("\n")}\n`);
  const taskId = await createTask(daemon, { automationMode: "suggest" });
  await until(async () => (await getJson<{ inbox: Array<{ id: string }> }>(daemon, "/api/state")).inbox.some((t) => t.id === "ext-sched"));
  await post(daemon, "thread.bind", { taskId, threadId: "ext-sched" });

  await until(() => jevEvaluateRowCount(daemon, "ext-sched") >= 1);
  await until(async () => {
    const proposals = daemon.store.listProposals({ threadId: "ext-sched" });
    return proposals.length === 1 && (proposals[0]!.payload as { answer?: { recommended?: string } }).answer?.recommended === "no_op";
  });

  // 时间继续流逝但无新证据：不再调用 Jev（A12）
  nowMs.value += 60 * 60_000;
  const before = jevEvaluateRowCount(daemon, "ext-sched");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(jevEvaluateRowCount(daemon, "ext-sched"), before, "idle no_op must not re-invoke Jev");

  // 新 turn 落入 rollout：指纹改变 → 下一个 tick 再评估
  const appended = [taskStarted(3, "t2", tickClock(60_000)), taskComplete(4, "t2", tickClock(1_000))].join("\n");
  await writeFile(join(dir, "rollout-ext-sched.jsonl"), `${lines.join("\n")}\n${appended}\n`, { flag: "a" });
  nowMs.value += 60 * 60_000;
  await until(() => jevEvaluateRowCount(daemon, "ext-sched") >= before + 1, 5_000);
});

// ---- 自动执行策略：live 门 + 低风险白名单 + mark_done 证据门 + needs_attention（A15/A16，故事 51–56） ----

import {
  automationGateSnapshot,
  decideAutoExecution,
  liveQuotaTaskIds,
  LIVE_TASK_LIMIT,
  planAutoExecution,
} from "../src/automation.js";
import { EXECUTABLE_PROPOSAL_ACTIONS, CRITICAL_RISK_NEVER_EXECUTED_REASON } from "../src/types.js";
import type { MarkDoneGateVerdict } from "../src/jev-gate.js";

/** 证据门判定桩：conditions 面省略（决策面只消费 eligible/failed）。 */
const gateVerdict = (eligible: boolean, failed: string[] = []): MarkDoneGateVerdict => ({
  eligible,
  conditions: {
    acceptanceAgent: true,
    automationAuto: true,
    acceptanceCriteriaNonEmpty: true,
    latestTurnCompleted: true,
    noUnresolvedAnomalies: true,
    referencesAcceptanceEvidence: true,
    riskNotCritical: true,
  },
  failed,
});

test("policy: decideAutoExecution 纯函数按序拒绝——非 auto 触发/pause/门未开/超配额/critical/needs_attention/非低风险/证据门未过", () => {
  const base = {
    trigger: "auto" as const,
    automationMode: "auto" as const,
    automationPaused: false,
    gateMode: "live" as const,
    withinLiveQuota: true,
    needsAttention: false,
    action: "continue_thread" as const,
    risk: "low" as const,
    markDoneGate: null,
  };
  assert.deepEqual(decideAutoExecution(base), { execute: true, action: "continue_thread" });
  assert.equal(decideAutoExecution({ ...base, trigger: "manual" }).execute, false, "manual never auto-executes");
  assert.equal(decideAutoExecution({ ...base, automationPaused: true }).execute, false, "pause stops auto actions");
  assert.equal(decideAutoExecution({ ...base, automationMode: "suggest" }).execute, false);
  assert.equal(decideAutoExecution({ ...base, gateMode: "shadow" }).execute, false, "shadow mode never auto-executes");
  assert.equal(decideAutoExecution({ ...base, gateMode: "halted" }).execute, false, "halted never auto-executes");
  assert.equal(decideAutoExecution({ ...base, withinLiveQuota: false }).execute, false, "quota bounds live tasks");
  assert.deepEqual(decideAutoExecution({ ...base, risk: "critical" }), {
    execute: false,
    reason: CRITICAL_RISK_NEVER_EXECUTED_REASON,
  }, "决策面拒绝原因引用共享常量（执行面同源引用，晨析 2026-10-25）");
  assert.equal(decideAutoExecution({ ...base, needsAttention: true }).execute, false, "needs_attention waits for user");
  assert.equal(decideAutoExecution({ ...base, risk: "medium" }).execute, false, "live policy is low-risk only");
  assert.equal(
    decideAutoExecution({ ...base, action: "mark_done", markDoneGate: gateVerdict(false) }).execute,
    false,
    "mark_done requires the evidence gate",
  );
  assert.deepEqual(decideAutoExecution({ ...base, action: "mark_done", markDoneGate: gateVerdict(true) }), {
    execute: true,
    action: "mark_done",
  });
  assert.deepEqual(decideAutoExecution({ ...base, action: "annotate" }), { execute: true, action: "annotate" });
  assert.equal(
    decideAutoExecution({ ...base, action: "ask_user" }).execute,
    false,
    "propose-only actions need confirmation",
  );
  assert.deepEqual(decideAutoExecution({ ...base, action: "no_op" }), { execute: true, action: "no_op" });
  assert.equal(LIVE_TASK_LIMIT, 5, "the gate fixes the live quota at 5 (自治上线门 4)");
  // 决策面/执行面共用 types.ts 单源（#34）：常量面钉死，两侧都从这里派生，漂移即同时漂移
  // （变异验证：从 types.ts 删任一动作，automation 联合与执行面分派应 tsc 报错）
  assert.deepEqual([...EXECUTABLE_PROPOSAL_ACTIONS], ["continue_thread", "annotate", "mark_done", "no_op"]);
});

test("policy: mark_done deny reason 携带 verdict.failed 键名列表；空 failed 保持单句不带冒号尾（#34）", () => {
  const base = {
    trigger: "auto" as const,
    automationMode: "auto" as const,
    automationPaused: false,
    gateMode: "live" as const,
    withinLiveQuota: true,
    needsAttention: false,
    action: "mark_done" as const,
    risk: "low" as const,
    markDoneGate: null,
  };
  assert.deepEqual(
    decideAutoExecution({ ...base, markDoneGate: gateVerdict(false, ["latestTurnCompleted", "referencesAcceptanceEvidence"]) }),
    {
      execute: false,
      reason: "mark_done evidence gate not satisfied: latestTurnCompleted, referencesAcceptanceEvidence",
    },
    "deny reason 单点可读「哪几条前置没过」",
  );
  assert.deepEqual(decideAutoExecution({ ...base, markDoneGate: gateVerdict(false, []) }), {
    execute: false,
    reason: "mark_done evidence gate not satisfied",
  }, "空 failed（防御形态）不带冒号尾");
  assert.deepEqual(decideAutoExecution({ ...base, markDoneGate: null }), {
    execute: false,
    reason: "mark_done evidence gate not satisfied",
  }, "verdict 缺失（非 mark_done 评估路径）保持单句");
});

test("policy: liveQuotaTaskIds 取创建序前 5 个合格 auto 任务，完成/失败/归档让位", async () => {
  const { store } = await makeStore();
  const ids: string[] = [];
  for (let index = 0; index < LIVE_TASK_LIMIT + 2; index += 1) {
    const task = store.createTask(
      parseCreateTaskInput({ title: `t${index}`, prompt: "p", workspace: "/tmp/ws", automationMode: "auto" }),
    );
    store.upsertThread({ id: `th_${task.id}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
    store.bindThread(task.id, `th_${task.id}`);
    ids.push(task.id);
  }
  assert.deepEqual(liveQuotaTaskIds(store), ids.slice(0, LIVE_TASK_LIMIT));
  store.moveTask(ids[0]!, "done"); // 完成 → 名额让给第 6 个
  assert.deepEqual(liveQuotaTaskIds(store), [...ids.slice(1, LIVE_TASK_LIMIT), ids[LIVE_TASK_LIMIT]]);
});

// ---- 票 #20：门快照单点 + planAutoExecution 执行计划（#18 决策面，ADR-0015） ----

test("policy: automationGateSnapshot 从 store 单点读齐门状态——门模式/全局 pause/live 配额/证据门资格", async () => {
  const { store } = await makeStore();
  const taskId = store
    .createTask(parseCreateTaskInput({ title: "gate-snap", prompt: "p", workspace: "/tmp/ws", automationMode: "auto" }))
    .id;
  store.upsertThread({ id: `th_${taskId}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.bindThread(taskId, `th_${taskId}`);

  // 默认态：门 shadow、未 pause、配额内、无证据门判定
  assert.deepEqual(automationGateSnapshot(store, taskId, null), {
    automationMode: "auto",
    automationPaused: false,
    gateMode: "shadow",
    withinLiveQuota: true,
    markDoneGate: null,
  });

  // 证据门判定（完整 verdict）随评估进快照（评估结论，非 store 状态；deny reason 要用 failed 键名）
  assert.deepEqual(automationGateSnapshot(store, taskId, gateVerdict(true, [])).markDoneGate, gateVerdict(true, []));
  assert.equal(automationGateSnapshot(store, taskId, gateVerdict(false, ["latestTurnCompleted"])).markDoneGate?.eligible, false);
  assert.deepEqual(
    automationGateSnapshot(store, taskId, gateVerdict(false, ["latestTurnCompleted"])).markDoneGate?.failed,
    ["latestTurnCompleted"],
  );

  // 门模式与全局 pause 读 settings 单点
  store.updateSettings({ automationLiveGate: "live" });
  assert.equal(automationGateSnapshot(store, taskId, null).gateMode, "live");
  store.updateSettings({ automationPaused: true });
  assert.equal(automationGateSnapshot(store, taskId, null).automationPaused, true);

  // live 配额：第 6 个合格任务在配额外
  for (let index = 0; index < LIVE_TASK_LIMIT; index += 1) {
    const extra = store
      .createTask(parseCreateTaskInput({ title: `snap${index}`, prompt: "p", workspace: "/tmp/ws", automationMode: "auto" }))
      .id;
    store.upsertThread({ id: `th_${extra}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
    store.bindThread(extra, `th_${extra}`);
  }
  assert.equal(automationGateSnapshot(store, taskId, null).withinLiveQuota, true);
  const overflow = store
    .createTask(parseCreateTaskInput({ title: "overflow", prompt: "p", workspace: "/tmp/ws", automationMode: "auto" }))
    .id;
  store.upsertThread({ id: `th_${overflow}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.bindThread(overflow, `th_${overflow}`);
  assert.equal(automationGateSnapshot(store, overflow, null).withinLiveQuota, false);

  // 任务 automation 模式随快照读出（suggest 任务不做自动执行）
  const suggestId = store
    .createTask(parseCreateTaskInput({ title: "snap-suggest", prompt: "p", workspace: "/tmp/ws", automationMode: "suggest" }))
    .id;
  store.upsertThread({ id: `th_${suggestId}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.bindThread(suggestId, `th_${suggestId}`);
  assert.equal(automationGateSnapshot(store, suggestId, null).automationMode, "suggest");
});

test("policy: planAutoExecution 裁决表——放行带完整执行口径（authorizedBy/requestId 派生自提案/confidence/risk），拒绝带结构化 reason", () => {
  const baseGate = {
    automationMode: "auto" as const,
    automationPaused: false,
    gateMode: "live" as const,
    withinLiveQuota: true,
    markDoneGate: null,
  };
  const baseProposal = {
    proposalId: "prop-1",
    action: "continue_thread" as const,
    risk: "low" as const,
    needsAttention: false,
    confidence: 0.82,
  };
  // 拒绝形态的结构化 reason（类型收窄 helper）
  const denyReason = (plan: ReturnType<typeof planAutoExecution>): string =>
    plan.execute ? "unexpected allow" : plan.reason;
  // 放行：口径一次成型，requestId 派生自提案 id
  assert.deepEqual(planAutoExecution(baseGate, baseProposal), {
    execute: true,
    action: "continue_thread",
    authorizedBy: "automation:auto",
    requestId: "auto/prop-1",
    confidence: 0.82,
    risk: "low",
  });
  // requestId 跟着提案走
  assert.deepEqual(planAutoExecution(baseGate, { ...baseProposal, proposalId: "prop-2", action: "annotate" }), {
    execute: true,
    action: "annotate",
    authorizedBy: "automation:auto",
    requestId: "auto/prop-2",
    confidence: 0.82,
    risk: "low",
  });
  // no_op 放行（语义保持：确认不去重、不翻转指纹）
  assert.deepEqual(planAutoExecution(baseGate, { ...baseProposal, action: "no_op" }), {
    execute: true,
    action: "no_op",
    authorizedBy: "automation:auto",
    requestId: "auto/prop-1",
    confidence: 0.82,
    risk: "low",
  });

  // 门模式三态：shadow/halted 都拦（live 已在放行例中）
  assert.match(denyReason(planAutoExecution({ ...baseGate, gateMode: "shadow" }, baseProposal)), /gate/);
  assert.match(denyReason(planAutoExecution({ ...baseGate, gateMode: "halted" }, baseProposal)), /gate/);
  // 全局 pause
  assert.match(denyReason(planAutoExecution({ ...baseGate, automationPaused: true }, baseProposal)), /paused/);
  // 配额内外
  assert.match(denyReason(planAutoExecution({ ...baseGate, withinLiveQuota: false }, baseProposal)), /limit/);
  // needs_attention 停下等用户
  assert.match(denyReason(planAutoExecution(baseGate, { ...baseProposal, needsAttention: true })), /needs_attention/);
  // 风险等级白名单：live 只放行 low
  assert.match(denyReason(planAutoExecution(baseGate, { ...baseProposal, risk: "medium" })), /risk/);
  // critical 任何路径都拒绝
  assert.match(denyReason(planAutoExecution(baseGate, { ...baseProposal, risk: "critical" })), /critical/);
  // propose-only 动作要人工确认
  assert.match(denyReason(planAutoExecution(baseGate, { ...baseProposal, action: "ask_user" })), /confirmation/);
  // mark_done 证据门两态：资格缺失拒绝（reason 携带 failed 键名，#34）、齐备放行
  assert.equal(
    denyReason(planAutoExecution(baseGate, { ...baseProposal, action: "mark_done" })),
    "mark_done evidence gate not satisfied",
    "verdict 缺失保持单句不带冒号尾",
  );
  assert.equal(
    denyReason(
      planAutoExecution(
        { ...baseGate, markDoneGate: gateVerdict(false, ["latestTurnCompleted", "referencesAcceptanceEvidence"]) },
        { ...baseProposal, action: "mark_done" },
      ),
    ),
    "mark_done evidence gate not satisfied: latestTurnCompleted, referencesAcceptanceEvidence",
  );
  assert.deepEqual(
    planAutoExecution({ ...baseGate, markDoneGate: gateVerdict(true) }, { ...baseProposal, action: "mark_done" }),
    {
      execute: true,
      action: "mark_done",
      authorizedBy: "automation:auto",
      requestId: "auto/prop-1",
      confidence: 0.82,
      risk: "low",
    },
  );
});

// ---- shadow 回放：快照收集、三方对比、人工标注、有害即停（自治上线门 1–4/6，故事 87/88/89） ----

import type { ShadowComparisonView } from "../src/store/index.js";

const seedShadowProposal = (
  store: Store,
  threadId: string,
  taskId: string,
  fingerprint: string,
  recommended: string,
  risk: string,
  options: { accepted?: boolean; executed?: boolean } = {},
): string => {
  const proposal = store.addProposal({
    threadId,
    taskId,
    evidenceFingerprint: fingerprint,
    payload: {
      ok: true,
      answer: {
        needsAttention: false,
        progress: "p",
        summaryShort: "s",
        candidates: [{ action: recommended, reason_short: "r", risk, evidence_refs: [] }],
        recommended,
        confidence: 0.8,
      },
      ...(options.executed ? { executionResult: { executed: true, authorizedBy: "automation:auto" } } : {}),
    },
  });
  if (options.accepted === true) store.decideProposal(proposal.id, "accepted");
  return proposal.id;
};

test("shadow 回放: collect 从提案去重收集三方对比；失败答案与重复 collect 不进表 (故事 87)", async () => {
  const { store } = await makeStore();
  const task = store.createTask(parseCreateTaskInput({ title: "t", prompt: "p", workspace: "/tmp/ws" }));
  store.upsertThread({ id: "th_sh1", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", goalStatus: "completed" });
  store.bindThread(task.id, "th_sh1");
  store.db
    .prepare("INSERT INTO thread_turns (id, thread_id, ordinal, native_status, source_ref) VALUES ('tn1', 'th_sh1', 1, 'completed', 's1')")
    .run();
  const acceptedId = seedShadowProposal(store, "th_sh1", task.id, "fp:1", "continue_thread", "low", { accepted: true, executed: true });
  seedShadowProposal(store, "th_sh1", task.id, "fp:2", "annotate", "low");
  store.addProposal({ threadId: "th_sh1", taskId: task.id, evidenceFingerprint: "fp:3", payload: { ok: false } });

  const first = store.collectShadowComparisons();
  assert.equal(first.collected, 2);
  assert.equal(first.total, 2);
  assert.equal(store.collectShadowComparisons().collected, 0, "同一提案不重复收集");

  const rows = store.listShadowComparisons();
  const executedRow = rows.find((row) => row.proposalId === acceptedId)!;
  assert.equal(executedRow.executed, true, "executed 跟随提案执行事实");
  assert.equal(executedRow.nativeTurnStatus, "completed", "原生侧记录最新 turn 终态");
  assert.equal(executedRow.nativeGoalStatus, "completed", "原生侧记录最近 goal 状态");
  assert.equal(executedRow.jevRecommended, "continue_thread");
  assert.equal(executedRow.label, null);
  const pendingRow = rows.find((row) => row.evidenceFingerprint === "fp:2")!;
  assert.equal(pendingRow.executed, false);
});

test("shadow 回放: collect→execute→collect 后 executed 以 MAX 刷新，重复 collect 不重复计数 (门 6，故事 87/88)", async () => {
  const { store } = await makeStore();
  const task = store.createTask(parseCreateTaskInput({ title: "t", prompt: "p", workspace: "/tmp/ws" }));
  store.upsertThread({ id: "th_sh1b", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", goalStatus: "completed" });
  store.bindThread(task.id, "th_sh1b");
  store.db
    .prepare("INSERT INTO thread_turns (id, thread_id, ordinal, native_status, source_ref) VALUES ('tn1b', 'th_sh1b', 1, 'completed', 's1')")
    .run();
  const proposalId = seedShadowProposal(store, "th_sh1b", task.id, "fp:b", "continue_thread", "low");

  // 先收集：提案尚 pending，快照 executed 记 0
  const first = store.collectShadowComparisons();
  assert.equal(first.collected, 1);
  const rowBefore = store.listShadowComparisons().find((row) => row.proposalId === proposalId)!;
  assert.equal(rowBefore.executed, false);

  // 后执行：提案 accepted 并写入 executionResult；再次 collect 唯一键相撞，executed 必须刷新而非被去重冻结
  store.decideProposal(proposalId, "accepted", { executionResult: { executed: true, authorizedBy: "automation:auto" } });
  const second = store.collectShadowComparisons();
  assert.equal(second.collected, 0, "刷新 executed 是更新不是新收集，不得计入 collected");
  assert.equal(second.total, 1);
  const rowAfter = store.listShadowComparisons().find((row) => row.proposalId === proposalId)!;
  assert.equal(rowAfter.executed, true, "后执行的提案再次 collect 时 executed 以 MAX 刷新");

  // 刷新后的快照对门 6 可见：有害标注立即 halted
  store.labelShadowComparison(rowAfter.id, "harmful");
  assert.equal(store.getSettings().automationLiveGate, "halted", "先收集后执行的有害快照必须能触发门 6");
});

test("shadow 回放: 人工标注三值；executed+harmful 立即 halted 并留审计标注 (门 3/6，故事 88/89)", async () => {
  const { store } = await makeStore();
  const task = store.createTask(parseCreateTaskInput({ title: "t", prompt: "p", workspace: "/tmp/ws" }));
  store.upsertThread({ id: "th_sh2", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.bindThread(task.id, "th_sh2");
  const executedId = seedShadowProposal(store, "th_sh2", task.id, "fp:e", "continue_thread", "low", { accepted: true, executed: true });
  const pendingId = seedShadowProposal(store, "th_sh2", task.id, "fp:p", "annotate", "low");
  store.collectShadowComparisons();
  const executedRow = store.listShadowComparisons().find((row) => row.proposalId === executedId)!;
  const pendingRow = store.listShadowComparisons().find((row) => row.proposalId === pendingId)!;

  const labeled = store.labelShadowComparison(pendingRow.id, "helpful");
  assert.equal(labeled.label, "helpful");
  assert.equal(store.getSettings().automationLiveGate, "shadow", "未执行的有害/有效标注不动门");

  store.labelShadowComparison(executedRow.id, "harmful");
  assert.equal(store.getSettings().automationLiveGate, "halted", "有害自动动作立即关闭自动执行");
  const audit = store.listAnnotations({ taskId: task.id, limit: 50 }).find((note) => note.kind === "automation_halted");
  assert.ok(audit, "halt 落审计标注（证据保留）");
  assert.match(audit!.body, new RegExp(executedRow.id));

  const summary = store.shadowComparisonSummary();
  assert.equal(summary.snapshots, 2);
  assert.equal(summary.helpful, 1);
  assert.equal(summary.harmful, 1);
  assert.equal(summary.executedHarmful, 1);
  assert.equal(summary.unlabeled, 0);
});

// ---- 门判定：只有没有有害动作且 Jev 至少优于 no_op 才进 live（门 4，故事 89 前提） ----

import { evaluateShadowGateVerdict, SHADOW_MIN_SNAPSHOTS } from "../src/automation.js";

test("policy: evaluateShadowGateVerdict 需要 ≥20 快照、0 有害、≥1 helpful（Jev 优于 no_op）", () => {
  assert.equal(SHADOW_MIN_SNAPSHOTS, 20, "门 1：至少 20 个真实快照");
  const base = { snapshots: 20, helpful: 5, ineffective: 3, harmful: 0, executedHarmful: 0 };
  assert.deepEqual(evaluateShadowGateVerdict(base), { pass: true, failures: [] });
  const short = evaluateShadowGateVerdict({ ...base, snapshots: 19 });
  assert.equal(short.pass, false);
  assert.match(short.failures[0]!, /shadow snapshots/);
  const harmful = evaluateShadowGateVerdict({ ...base, harmful: 1 });
  assert.equal(harmful.pass, false);
  assert.match(harmful.failures[0]!, /harmful/);
  const noHelpful = evaluateShadowGateVerdict({ ...base, helpful: 0 });
  assert.equal(noHelpful.pass, false);
  assert.match(noHelpful.failures[0]!, /no_op/);
  const both = evaluateShadowGateVerdict({ snapshots: 2, helpful: 0, ineffective: 0, harmful: 2, executedHarmful: 1 });
  assert.equal(both.failures.length, 3, "多个不满足条件一并报出");
});

test("daemon 门动作: shadow.collect/label + automation.live.enter 组成可执行门流程；settings.update 绕不过门 (门 1–4)", async () => {
  const daemon = await boot();
  // 门模式只经判定动作流转：settings.update 的白名单里没有 automationLiveGate
  const bypass = await post(daemon, "settings.update", { settings: { automationLiveGate: "live" } });
  assert.equal(bypass.status, 400);
  assert.equal((await getJson<{ runtime: { automationLiveGate: string } }>(daemon, "/api/state")).runtime.automationLiveGate, "shadow", "runtime 暴露门模式");

  // 空快照直接进 live 被拒：失败原因一次讲清
  const early = await post(daemon, "automation.live.enter", {});
  assert.equal(early.status, 409);
  assert.match(String(early.body.error), /shadow snapshots/);

  // 门 1：种 20 份真实快照（已执行的 helpful 场景），collect 去重收集
  for (let index = 0; index < 20; index += 1) {
    const taskId = await createTask(daemon, { automationMode: "auto" });
    daemon.store.upsertThread({ id: `th_gate${index}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", goalStatus: "completed" });
    daemon.store.bindThread(taskId, `th_gate${index}`);
    seedShadowProposal(daemon.store, `th_gate${index}`, taskId, `fp:gate${index}`, "continue_thread", "low", {
      accepted: true,
      executed: true,
    });
  }
  const collect = await post(daemon, "shadow.collect", {});
  assert.equal(collect.status, 200);
  assert.equal((collect.body.shadow as { collected: number }).collected, 20);

  // 门 3：人工标注 helpful（Jev 优于 no_op 的证据）
  const comparison = daemon.store.listShadowComparisons()[0]!;
  const label = await post(daemon, "shadow.label", { comparisonId: comparison.id, label: "helpful" });
  assert.equal(label.status, 200);
  const badLabel = await post(daemon, "shadow.label", { comparisonId: comparison.id, label: "magic" });
  assert.equal(badLabel.status, 400);

  // 门 4：判定通过 → live，自动执行路径随门开启（decideAutoExecution 已测）
  const enter = await post(daemon, "automation.live.enter", {});
  assert.equal(enter.status, 200, JSON.stringify(enter.body));
  assert.equal((await getJson<{ runtime: { automationLiveGate: string } }>(daemon, "/api/state")).runtime.automationLiveGate, "live");
});

// ---- daemon 贯通：自动执行路径 ----

const answerWith = (action: string, risk: string, refs: string[], needsAttention = false): string =>
  JSON.stringify({
    needs_attention: needsAttention,
    progress: "evaluated",
    summary_short: "short",
    candidates: [{ action, reason_short: "because", risk, evidence_refs: refs }],
    recommended: action,
    confidence: 0.9,
  });

const seedGateEvidence = (daemon: RunningDaemon, threadId: string, id: string): void => {
  daemon.store.db
    .prepare(
      "INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal, kind, summary, props, superseded, created_at) VALUES (?, ?, 'src_gate', 0, 'hash_gate', 1, 'file_change', 'src/fix.ts modified', NULL, 0, ?)",
    )
    .run(id, threadId, daemon.store.now());
};

const seedExternalThread = async (threadId: string, withFileChange = false): Promise<void> => {
  const { resetClock, sessionMeta, taskComplete, taskStarted, fileChangeItem } = await import("./helpers/rollout.js");
  resetClock();
  const lines = withFileChange
    ? [
        sessionMeta(0, { sessionId: threadId, cwd: "/tmp/ws" }),
        taskStarted(1, "turn_1"),
        fileChangeItem(2, "turn_1", { "src/fix.ts": { type: "modified" } }, { turnId: "turn_1", threadId }),
        taskComplete(3, "turn_1"),
      ]
    : [sessionMeta(0, { sessionId: threadId, cwd: "/tmp/ws" }), taskStarted(1, "turn_1"), taskComplete(2, "turn_1")];
  const dir = join(CODEX_HOME, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-${threadId}.jsonl`), `${lines.join("\n")}\n`);
};

const waitInboxSeen = async (daemon: RunningDaemon, threadId: string): Promise<void> => {
  await until(async () =>
    (await getJson<{ inbox: Array<{ id: string }> }>(daemon, "/api/state")).inbox.some((t) => t.id === threadId),
  );
};

interface ProposalRow {
  id: string;
  status: string;
  payload: {
    answer?: { recommended: string };
    gate?: { eligible: boolean; failed: string[] };
    executionResult?: { executed: boolean; authorizedBy?: string; movedTo?: string; message?: string };
  };
}

const latestProposal = (daemon: RunningDaemon, threadId: string): ProposalRow | undefined =>
  daemon.store.listProposals({ threadId, limit: 10 })[0] as ProposalRow | undefined;

const acceptedProposal = (daemon: RunningDaemon, threadId: string): ProposalRow | undefined =>
  daemon.store.listProposals({ threadId, status: "accepted", limit: 1 })[0] as ProposalRow | undefined;

const enterLive = (daemon: RunningDaemon): void => {
  // 门判定动作在 shadow 一节测；这里直接置位以聚焦自动执行路径
  daemon.store.updateSettings({ automationLiveGate: "live" });
};

test("daemon A15: acceptance=agent + 证据门通过 → scheduler 自动执行 mark_done 并留完整审计", async () => {
  const { T0 } = await import("./helpers/rollout.js");
  const nowMs = { value: T0 + 30 * 60_000 };
  const daemon = await boot({
    driverEnv: { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-a15", FAKE_JEV_ANSWER: answerWith("mark_done", "low", ["ev_gate"]) },
    nowMs,
    automationTickMs: 10,
  });
  await seedExternalThread("ext-a15", true);
  await waitInboxSeen(daemon, "ext-a15");
  const taskId = await createTask(daemon, {
    acceptanceMode: "agent",
    automationMode: "auto",
    acceptanceCriteria: "src/fix.ts 修改完成",
  });
  await post(daemon, "thread.bind", { taskId, threadId: "ext-a15" });
  seedGateEvidence(daemon, "ext-a15", "ev_gate");
  enterLive(daemon);

  await until(async () => (await taskView(daemon, taskId)).status === "done", 5_000);
  const proposal = acceptedProposal(daemon, "ext-a15");
  assert.equal(proposal?.status, "accepted");
  assert.equal(proposal?.payload.answer?.recommended, "mark_done");
  assert.equal(proposal?.payload.gate?.eligible, true);
  assert.equal(proposal?.payload.executionResult?.authorizedBy, "automation:auto");
  assert.equal(proposal?.payload.executionResult?.movedTo, "done");
  const execution = daemon.store
    .listActionExecutions({ taskId, limit: 50 })
    .find((row) => row.action === "proposal.mark_done");
  assert.ok(execution, "mark_done execution is audited as an action row");
  assert.equal(execution.trigger, "auto");
  assert.equal(execution.detail?.authorizedBy, "automation:auto");
  assert.equal(execution.detail?.risk, "low");
  assert.equal(execution.requestId, `auto/${proposal!.id}`, "request identity is recorded");
});

test("daemon A15 反例: acceptance=human 的 mark_done 只生成提案；证据缺失同样不执行", async () => {
  const { T0 } = await import("./helpers/rollout.js");
  const nowMs = { value: T0 + 30 * 60_000 };
  const daemon = await boot({
    driverEnv: { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-a15h", FAKE_JEV_ANSWER: answerWith("mark_done", "low", []) },
    nowMs,
    automationTickMs: 10,
  });
  await seedExternalThread("ext-a15h");
  await waitInboxSeen(daemon, "ext-a15h");
  const taskId = await createTask(daemon, {
    acceptanceMode: "agent",
    automationMode: "auto",
    acceptanceCriteria: "criteria",
  });
  await post(daemon, "thread.bind", { taskId, threadId: "ext-a15h" });
  enterLive(daemon); // 证据门缺引用：即使 live 也只提案

  await until(() => latestProposal(daemon, "ext-a15h") !== undefined, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await taskView(daemon, taskId)).status, "todo");
  assert.equal(latestProposal(daemon, "ext-a15h")?.status, "pending");
  assert.equal(latestProposal(daemon, "ext-a15h")?.payload.gate?.eligible, false);
});

test("daemon: shadow 门未开时 auto 任务只提案不执行；live 后同一评估路径才自动执行 continue_thread", async () => {
  const { T0 } = await import("./helpers/rollout.js");
  const nowMs = { value: T0 + 30 * 60_000 };
  const daemon = await boot({
    driverEnv: { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-live", FAKE_JEV_ANSWER: answerWith("continue_thread", "low", []) },
    nowMs,
    automationTickMs: 10,
  });
  await seedExternalThread("ext-live");
  await waitInboxSeen(daemon, "ext-live");
  const taskId = await createTask(daemon, { automationMode: "auto" });
  await post(daemon, "thread.bind", { taskId, threadId: "ext-live" });

  // 默认 shadow：评估发生、提案 pending、无执行
  await until(() => latestProposal(daemon, "ext-live") !== undefined, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(latestProposal(daemon, "ext-live")?.status, "pending", "shadow mode lands proposals only");
  assert.equal(
    daemon.store.listActionExecutions({ taskId, limit: 50 }).some((row) => row.action.startsWith("proposal.")),
    false,
    "no execution in shadow mode",
  );

  // 进 live + 新证据再武装：自动发送 continue（固定模板）并落全审计
  enterLive(daemon);
  const { taskComplete, taskStarted, tick: tickClock } = await import("./helpers/rollout.js");
  const dir = join(CODEX_HOME, "sessions");
  const appended = [taskStarted(3, "turn_2", tickClock(1_000)), taskComplete(4, "turn_2", tickClock(1_000))].join("\n");
  const { readFile } = await import("node:fs/promises");
  const existing = await readFile(join(dir, "rollout-ext-live.jsonl"), "utf8");
  await writeFile(join(dir, "rollout-ext-live.jsonl"), `${existing}${appended}\n`, { flag: "a" });
  // 等提案收敛而非动作行出现：动作行在执行开始就落账，完成与 decideProposal 在 send 终态之后
  await until(() => acceptedProposal(daemon, "ext-live") !== undefined, 5_000);
  const proposal = acceptedProposal(daemon, "ext-live");
  assert.equal(proposal?.status, "accepted");
  assert.equal(proposal?.payload.executionResult?.authorizedBy, "automation:auto");
  assert.match(proposal?.payload.executionResult?.message ?? "", /^\[taskboard\]/, "auto message carries the taskboard marker");
  // 自驱 send 即线程活动：空闲阈值从执行时刻重新计时
  const thread = daemon.store.getThread("ext-live");
  assert.ok(thread?.lastActivityAt !== null && Date.parse(thread.lastActivityAt) >= T0 + 30 * 60_000);
});

test("daemon A16: 评估层 needs_attention 转待关注徽标；系统不存在自动批准路径", async () => {
  const { T0 } = await import("./helpers/rollout.js");
  const nowMs = { value: T0 + 30 * 60_000 };
  const daemon = await boot({
    driverEnv: { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-a16", FAKE_JEV_ANSWER: answerWith("continue_thread", "low", [], true) },
    nowMs,
    automationTickMs: 10,
  });
  await seedExternalThread("ext-a16");
  await waitInboxSeen(daemon, "ext-a16");
  const taskId = await createTask(daemon, { automationMode: "auto" });
  await post(daemon, "thread.bind", { taskId, threadId: "ext-a16" });
  enterLive(daemon);

  await until(
    () => daemon.store.listAnnotations({ taskId, limit: 50 }).some((note) => note.kind === "needs_attention"),
    5_000,
  );
  assert.ok((await taskView(daemon, taskId)).badges.includes("needs_attention"));
  // 自驱任务停在待关注：不执行任何动作，提案留给用户
  assert.equal(latestProposal(daemon, "ext-a16")?.status, "pending");

  // 不存在自动批准路径：动作面没有任何审批应答类型
  const response = await post(daemon, "approval.respond", { proposalId: "x" });
  assert.equal(response.status, 400);
  assert.match(String(response.body.error), /unknown action type/);
});

test("daemon: critical 风险提案任何路径都拒绝执行 (词汇表「风险等级」)", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, { automationMode: "auto" });
  daemon.store.upsertThread({ id: "th-crit", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: 1 });
  daemon.store.bindThread(taskId, "th-crit");
  const proposal = daemon.store.addProposal({
    threadId: "th-crit",
    taskId,
    evidenceFingerprint: "t1:c1:a-",
    // 候选形态与写侧契约一致（parseJevAnswer 产出 camelCase）：读侧守卫按形变数据受控拒绝
    payload: {
      ok: true,
      answer: {
        needsAttention: false,
        progress: "p",
        summaryShort: "s",
        candidates: [{ action: "continue_thread", reasonShort: "r", risk: "critical", evidenceRefs: [] }],
        recommended: "continue_thread",
        confidence: 0.9,
      },
    },
  });
  const response = await post(daemon, "proposal.accept", { proposalId: proposal.id });
  assert.equal(response.status, 409);
  assert.match(String(response.body.error), /critical risk is never executed/);
  assert.equal(daemon.store.getProposal(proposal.id)?.status, "pending");
});

test("daemon A12: 自动 no_op 结算不写动作行——证据指纹不翻转，不重复烧评估", async () => {
  const { T0 } = await import("./helpers/rollout.js");
  const nowMs = { value: T0 + 30 * 60_000 };
  const daemon = await boot({
    driverEnv: { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-noop-auto", FAKE_JEV_ANSWER: answerWith("no_op", "low", []) },
    nowMs,
    automationTickMs: 10,
  });
  await seedExternalThread("ext-noop-auto");
  await waitInboxSeen(daemon, "ext-noop-auto");
  const taskId = await createTask(daemon, { automationMode: "auto" });
  await post(daemon, "thread.bind", { taskId, threadId: "ext-noop-auto" });
  enterLive(daemon);

  await until(() => latestProposal(daemon, "ext-noop-auto") !== undefined, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const proposals = daemon.store.listProposals({ threadId: "ext-noop-auto", limit: 10 });
  assert.equal(proposals.length, 1, `auto no_op 不得每 tick 重复评估（got ${proposals.length}）`);
  const noOpRows = daemon.store
    .listActionExecutions({ threadId: "ext-noop-auto", limit: 50 })
    .filter((row) => row.action === "proposal.no_op");
  assert.equal(noOpRows.length, 0, "自动 no_op 不写终态动作行（写它会翻转指纹、解除 A12 去重）");
  const state = daemon.store.getEvaluationState("ext-noop-auto");
  assert.equal(state?.lastNoOp, true, "评估状态按 no_op 落定");
});

test("shadow label 终局：已标注的对比拒绝改标（有害标注不可撤销，门统计不被事后改写）", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, { automationMode: "auto" });
  daemon.store.upsertThread({ id: "th-label-final", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", goalStatus: "completed" });
  daemon.store.bindThread(taskId, "th-label-final");
  seedShadowProposal(daemon.store, "th-label-final", taskId, "fp:label-final", "continue_thread", "low", {
    accepted: true,
    executed: true,
  });
  daemon.store.collectShadowComparisons();
  const comparison = daemon.store.listShadowComparisons()[0]!;

  const first = await post(daemon, "shadow.label", { comparisonId: comparison.id, label: "helpful" });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await post(daemon, "shadow.label", { comparisonId: comparison.id, label: "harmful" });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(daemon.store.listShadowComparisons()[0]!.label, "helpful", "标注保持终态");
});

test("automation.live.enter 在 halted 下直接 409：即使门判定已可PASS也不复活（终局门语义）", async () => {
  const daemon = await boot();
  // 种满足门 1–4 的证据（20 已执行 helpful 快照）
  for (let index = 0; index < 20; index += 1) {
    const taskId = await createTask(daemon, { automationMode: "auto" });
    daemon.store.upsertThread({ id: `th-halt${index}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", goalStatus: "completed" });
    daemon.store.bindThread(taskId, `th-halt${index}`);
    seedShadowProposal(daemon.store, `th-halt${index}`, taskId, `fp:halt${index}`, "continue_thread", "low", {
      accepted: true,
      executed: true,
    });
  }
  await post(daemon, "shadow.collect", {});
  const comparison = daemon.store.listShadowComparisons()[0]!;
  assert.equal((await post(daemon, "shadow.label", { comparisonId: comparison.id, label: "helpful" })).status, 200);
  assert.equal((await post(daemon, "automation.live.enter", {})).status, 200, "前置：门判定可 PASS 才进 live");

  // 有害标注触发 halted（store 置位），此后 live.enter 显式 409
  const harmful = daemon.store.listShadowComparisons()[1]!;
  assert.equal((await post(daemon, "shadow.label", { comparisonId: harmful.id, label: "harmful" })).status, 200);
  assert.equal(
    (await getJson<{ runtime: { automationLiveGate: string } }>(daemon, "/api/state")).runtime.automationLiveGate,
    "halted",
  );
  const reenter = await post(daemon, "automation.live.enter", {});
  assert.equal(reenter.status, 409, JSON.stringify(reenter.body));
  assert.match(String(reenter.body.error), /halted/);
});
