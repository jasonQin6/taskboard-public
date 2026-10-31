/**
 * GoalService 贯通：goal.* / thread.sample 的授权门、能力探测、resume 审计、Conflict 回落与
 * 单飞共享（A9/A10/A11/A17/A22 的执行侧）。全部经 daemon 公共 API 缝（HTTP + store 注入）
 * + 假 app-server（ADR-0012），不调真实 Codex——本机 0.163.0 无 thread/sample。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { THREAD_RESUME_KIND } from "../src/runs.js";
import { rec, resetClock, sessionMeta, taskComplete, taskStarted } from "./helpers/rollout.js";

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录（本文件进程内生效，driver 子进程继承）
const CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-goals-"));
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

let bootSeq = 0;

const boot = async (
  driverEnv: Record<string, string> = {},
  overrides: Partial<Parameters<typeof startDaemon>[0]> = {},
): Promise<RunningDaemon> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-goals-"));
  tmpDirs.push(dir);
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(dir, "taskboard.sqlite"),
    driver: {
      command: process.execPath,
      args: [FAKE_APP_SERVER_PATH],
      env: { ...process.env, FAKE_TURN_DELAY_MS: "25", ...driverEnv },
    },
    cronTickMs: 10,
    scanIntervalMs: 20,
    ...overrides,
  });
  daemons.push(daemon);
  return daemon;
};

const post = async (daemon: RunningDaemon, type: string, fields: Record<string, unknown> = {}, requestId?: string) => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, requestId: requestId ?? `t-${Math.random().toString(36).slice(2)}`, ...fields }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const getJson = async <T>(daemon: RunningDaemon, path: string): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`);
  return (await response.json()) as T;
};

interface TaskView {
  id: string;
  status: string;
  summaryStatus: string;
  goalStatus: string | null;
  activeRun: { id: string; status: string; threadId: string | null } | null;
  lastRun: { id: string; status: string; threadId: string | null; failureReason: string | null } | null;
  primaryThreadId: string | null;
  primaryThreadStatus: string | null;
  inFlightWrite: boolean;
  threads: Array<{ id: string; nativeStatus: string; primaryTaskId: string | null; goalStatus: string | null }>;
  annotations: Array<{ id: string; kind: string; body: string; threadId: string | null }>;
}

const taskView = async (daemon: RunningDaemon, taskId: string): Promise<TaskView> => {
  const payload = await getJson<{ task: TaskView }>(daemon, `/api/tasks/${taskId}`);
  return payload.task;
};

const until = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

const createTask = async (daemon: RunningDaemon, title: string, extra: Record<string, unknown> = {}): Promise<string> => {
  const response = await post(daemon, "task.create", {
    title,
    prompt: "do it",
    workspace: "/tmp/ws",
    status: "todo",
    ...extra,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body.task as { id: string }).id;
};

/** 在测试 CODEX_HOME 里落一条「外部线程」rollout：session_id 即 threadId，带一个已完成 turn。 */
const seedRollout = async (threadId: string, turnId: string): Promise<void> => {
  resetClock();
  const lines = [
    sessionMeta(0, { sessionId: threadId, cwd: "/tmp/ws" }),
    taskStarted(1, turnId),
    taskComplete(2, turnId),
  ].join("\n");
  const dir = join(CODEX_HOME, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-${threadId}.jsonl`), `${lines}\n`);
};

// ---- A11：goal/sample 与 send 共享单飞 ----

test("thread.sample while a send is in flight is rejected 409 and leaves the send's in-flight slot intact", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_TURN_DELAY_MS: "1500" });
  const taskId = await createTask(daemon, "busy", { goalEnabled: true });
  const created = await post(daemon, "run.create", { taskId });
  assert.equal(created.status, 201);
  await until(async () => (await taskView(daemon, taskId)).primaryThreadId !== null);
  const threadId = (await taskView(daemon, taskId)).primaryThreadId;
  assert.ok(threadId !== null);

  const sampled = await post(daemon, "thread.sample", { threadId });
  assert.equal(sampled.status, 409, JSON.stringify(sampled.body));

  // 对称面：goal 写操作同样被单飞拒绝
  const goaled = await post(daemon, "goal.set", { taskId });
  assert.equal(goaled.status, 409, JSON.stringify(goaled.body));

  // 回归哨兵：被拒的 sample 不得释放 send 的单飞槽（A11：同 thread 在飞时一律拒绝）
  assert.equal((await taskView(daemon, taskId)).inFlightWrite, true, "sample 误清了 send 的在飞登记");
});

// ---- A9：绑定线程试探性加载成功 → sample 摘要 → 释放写锁 ----

test("thread.sample on a bound thread resumes, samples, and releases the lock with audit (A9)", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-1" });
  await seedRollout("ext-1", "turn_1");
  // reader 扫到外部线程（含已完成 turn）后才能绑定：sample 的 expected_turn_id 以 reader 视角为准
  const threadDetail = async (): Promise<{ turnCount: number; summary: unknown; nativeStatus: string | null } | null> => {
    const payload = await getJson<{ thread?: { turnCount: number; summary: unknown; nativeStatus: string | null } }>(
      daemon,
      "/api/threads/ext-1",
    );
    return payload.thread ?? null;
  };
  await until(async () => (await threadDetail())?.turnCount === 1);
  const taskId = await createTask(daemon, "sampled");
  const bound = await post(daemon, "thread.bind", { taskId, threadId: "ext-1" });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  const sampled = await post(daemon, "thread.sample", { threadId: "ext-1" });
  assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
  assert.deepEqual(sampled.body.sample, {
    threadId: "ext-1",
    provenance: "sample",
    text: "fake sample of ext-1 at turn_1",
    held: false,
    reason: null,
  });

  // 摘要落库并进任务面：summaryStatus 跟主绑定线程最新摘要 provenance 走
  assert.equal((await threadDetail())?.summary !== null, true);
  const view = await taskView(daemon, taskId);
  assert.equal(view.summaryStatus, "sample");

  // 写邻接审计落库，且不含任务内容（证据持久化边界）
  const resumeAudit = view.annotations.filter((a) => a.kind === THREAD_RESUME_KIND);
  assert.equal(resumeAudit.length, 1, JSON.stringify(view.annotations));
  assert.equal(resumeAudit[0].threadId, "ext-1");
  assert.equal(resumeAudit[0].body.includes("do it"), false, "审计正文不得携带任务内容");

  // 采样后锁已释放：进程内无残留 in-flight 写
  const state = await getJson<{ runtime: { inFlightWrites: number } }>(daemon, "/api/state");
  assert.equal(state.runtime.inFlightWrites, 0);
});

// ---- A10：回落路径——Inbox 永不 resume；能力缺失/写锁 Conflict/expected turn 未知回落基线并如实记录 ----

test("thread.sample on an inbox thread never resumes and falls back (A10)", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-inbox" });
  await seedRollout("ext-inbox", "turn_1");
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-inbox")).thread !== undefined);

  const sampled = await post(daemon, "thread.sample", { threadId: "ext-inbox" });
  assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
  const sample = sampled.body.sample as Record<string, unknown>;
  assert.equal(sample.provenance, "none");
  assert.equal(sample.held, false);
  assert.match(String(sample.reason), /not bound to a task/);
  const state = await getJson<{ annotations: Array<{ kind: string }> }>(daemon, "/api/state");
  assert.equal(
    state.annotations.filter((a) => a.kind === THREAD_RESUME_KIND).length,
    0,
    "Inbox 线程不得发生 resume",
  );
});

test("thread.sample falls back to baseline when the app-server lacks thread/sample (A10)", async () => {
  // 不开 FAKE_WITH_SAMPLE：镜像本机 0.163.0（method 不存在）
  const daemon = await boot({ FAKE_KNOWN_THREADS: "ext-old" });
  await seedRollout("ext-old", "turn_1");
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-old")).thread !== undefined);
  const taskId = await createTask(daemon, "oldserver");
  const bound = await post(daemon, "thread.bind", { taskId, threadId: "ext-old" });
  assert.equal(bound.status, 200);

  const sampled = await post(daemon, "thread.sample", { threadId: "ext-old" });
  assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
  const sample = sampled.body.sample as Record<string, unknown>;
  // 有 compacted 基线时回落基线本身（R1 提供；本票验证回落路径与 provenance 标注）
  daemon.store.addThreadSummary({ threadId: "ext-old", provenance: "compacted", text: "compacted baseline text" });
  const fallen = await post(daemon, "thread.sample", { threadId: "ext-old" }, "retry-after-seed");
  assert.equal(fallen.status, 200, JSON.stringify(fallen.body));
  assert.deepEqual(fallen.body.sample, {
    threadId: "ext-old",
    provenance: "compacted",
    text: "compacted baseline text",
    held: false,
    reason: (fallen.body.sample as { reason: string }).reason,
  });
  assert.equal(sample.provenance, "none");
  assert.equal(sample.held, false);
  assert.match(String(sample.reason), /not available/);
  const view = await taskView(daemon, taskId);
  assert.equal(view.summaryStatus, "compacted");
  assert.equal(
    view.annotations.filter((a) => a.kind === THREAD_RESUME_KIND).length,
    0,
    "能力缺失时不得接管写锁",
  );
});

test("thread.sample falls back with held=true when the writer lock is held by another process (A10)", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-held", FAKE_HELD_THREAD: "ext-held" });
  await seedRollout("ext-held", "turn_1");
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-held")).thread !== undefined);
  const taskId = await createTask(daemon, "held");
  const bound = await post(daemon, "thread.bind", { taskId, threadId: "ext-held" });
  assert.equal(bound.status, 200);

  const sampled = await post(daemon, "thread.sample", { threadId: "ext-held" });
  assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
  const sample = sampled.body.sample as Record<string, unknown>;
  assert.equal(sample.provenance, "none");
  assert.equal(sample.held, true);
  assert.match(String(sample.reason), /held by another process/);
  assert.equal((await taskView(daemon, taskId)).primaryThreadStatus, "held");
});

test("thread.sample without a reader-known completed turn falls back and never resumes (A10)", async () => {
  // rollout 只有 task_started（无已完成 turn）：线程可被发现，expected_turn_id 无从校验
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-noturn" });
  resetClock();
  const lines = [sessionMeta(0, { sessionId: "ext-noturn", cwd: "/tmp/ws" }), taskStarted(1, "turn_open")].join("\n");
  await mkdir(join(CODEX_HOME, "sessions"), { recursive: true });
  await writeFile(join(CODEX_HOME, "sessions", "rollout-ext-noturn.jsonl"), `${lines}\n`);
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-noturn")).thread !== undefined);
  const taskId = await createTask(daemon, "noturn");
  const bound = await post(daemon, "thread.bind", { taskId, threadId: "ext-noturn" });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  const sampled = await post(daemon, "thread.sample", { threadId: "ext-noturn" });
  assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
  const sample = sampled.body.sample as Record<string, unknown>;
  assert.equal(sample.provenance, "none");
  assert.equal(sample.held, false);
  assert.match(String(sample.reason), /no completed turn/);
  const state = await getJson<{ annotations: Array<{ kind: string }> }>(daemon, "/api/state");
  assert.equal(state.annotations.filter((a) => a.kind === THREAD_RESUME_KIND).length, 0);
});

// ---- A17/A22：native goal——设置、状态进详情、goal 续跑的 wait 语义、能力缺失明确失败 ----

test("goal.set drives the native goal, caches status into task detail, and the goal turn keeps the thread running (A17/A22)", async () => {
  const daemon = await boot({ FAKE_GOAL_TURN_MS: "400" });
  const taskId = await createTask(daemon, "goaled", { goalEnabled: true, prompt: "ship the thing" });
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed");

  const set = await post(daemon, "goal.set", { taskId });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const goal = set.body.goal as Record<string, unknown>;
  assert.equal(goal.taskId, taskId);
  assert.equal(goal.op, "set");
  assert.equal(goal.goalStatus, "active");

  // goal 状态进任务详情（证据缓存）；goal 续跑 turn 期间线程原生 running、无 Run（A22 的真实观测源）
  await until(async () => {
    const view = await taskView(daemon, taskId);
    return view.goalStatus === "active" && view.primaryThreadStatus === "running";
  });
  const mid = await taskView(daemon, taskId);
  assert.equal(mid.activeRun, null, "goal 续跑不产生也不延长 Run");
  assert.notEqual(mid.primaryThreadId, null);

  // goal turn 终态后线程回静止：wait 的 goal 模式据此收敛
  await until(async () => (await taskView(daemon, taskId)).primaryThreadStatus === "completed");
});

test("goal.set is rejected for a task whose goal mode the user never enabled (A17, 故事 61/64)", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, "nogoal");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed");

  const set = await post(daemon, "goal.set", { taskId });
  assert.equal(set.status, 400, JSON.stringify(set.body));
  assert.match(String(set.body.error), /not enabled goal execution mode/);
});

test("goal operations fail with 501 when the app-server lacks the goal family (A17)", async () => {
  const daemon = await boot({ FAKE_WITHOUT_GOAL: "1" });
  const taskId = await createTask(daemon, "nogoalserver", { goalEnabled: true });
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed");

  const set = await post(daemon, "goal.set", { taskId });
  assert.equal(set.status, 501, JSON.stringify(set.body));
  assert.match(String(set.body.error), /thread\/goal\/set was not found/);
  // 明确失败：不得静默回退成 taskboard 自造 goal loop
  const view = await taskView(daemon, taskId);
  assert.equal(view.goalStatus, null);
});

test("goal.set on a bound external thread takes the writer lock with audit before setting (A17)", async () => {
  const daemon = await boot({ FAKE_KNOWN_THREADS: "ext-goal" });
  await seedRollout("ext-goal", "turn_1");
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-goal")).thread !== undefined);
  const taskId = await createTask(daemon, "external-goaled", { goalEnabled: true });
  const bound = await post(daemon, "thread.bind", { taskId, threadId: "ext-goal" });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  const set = await post(daemon, "goal.set", { taskId });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal((set.body.goal as { goalStatus: string }).goalStatus, "active");

  // goal 写邻接同样落 resume 审计（不碰 Codex 存储的唯一例外，ADR-0003）
  const view = await taskView(daemon, taskId);
  const audits = view.annotations.filter((a) => a.kind === THREAD_RESUME_KIND);
  assert.equal(audits.length, 1, JSON.stringify(view.annotations));
  assert.equal(audits[0].body.includes("ship"), false, "审计正文不得携带 goal/任务内容");
  // goal 续跑窗口已开：线程被原生 turn 拉起 running
  await until(async () => (await taskView(daemon, taskId)).primaryThreadStatus === "running");
});
// ---- goal 续跑的防休眠接线（setGoalContinuation → PowerController）与证据语义（故事 63） ----

test("goal continuation opens the power protection window and pause closes it (setGoalContinuation 接线)", async () => {
  const calls: string[] = [];
  let held = false;
  const daemon = await boot(
    { FAKE_GOAL_TURN_MS: "400" },
    {
      settingsOverrides: { preventIdleSleep: true },
      powerGuard: {
        acquire: async () => {
          calls.push("acquire");
          held = true;
        },
        release: async () => {
          calls.push("release");
          held = false;
        },
        status: () => (held ? "active" : "idle"),
      },
    },
  );
  const powerOf = async (): Promise<string> =>
    (await getJson<{ runtime: { powerProtection: string } }>(daemon, "/api/state")).runtime.powerProtection;
  assert.equal(await powerOf(), "idle");

  const taskId = await createTask(daemon, "power-goaled", { goalEnabled: true });
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed");
  assert.equal(await powerOf(), "idle", "Run 结束后窗口应关闭");

  const set = await post(daemon, "goal.set", { taskId });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  await until(async () => (await powerOf()) === "active", 2_000);

  const paused = await post(daemon, "goal.pause", { taskId });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  await until(async () => (await powerOf()) === "idle", 2_000);
  // Run 窗口与 goal 窗口各一对 acquire/release；最后一对来自 goal 续跑窗口的开与关
  assert.deepEqual(calls.slice(-2), ["acquire", "release"]);
  assert.ok(calls.length >= 4, `guard calls: ${calls.join(",")}`);
});

test("goal status complete/budget_limited stays evidence-only and never completes the task (故事 63)", async () => {
  // prompt 含 [budget]：假服务器在该 goal turn 终态时把 status 转 budget_limited
  const daemon = await boot({ FAKE_GOAL_TURN_MS: "200" });
  const taskId = await createTask(daemon, "budgeted", { goalEnabled: true, prompt: "[budget] finish it" });
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed");

  const set = await post(daemon, "goal.set", { taskId });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  // 状态缓存只在 goal 操作时刷新（turn 终态事件不带 goal 状态）：goal.status 轮询读回原生词
  await until(async () => {
    await post(daemon, "goal.status", { taskId });
    return (await taskView(daemon, taskId)).goalStatus === "budget_limited";
  }, 3_000);

  const view = await taskView(daemon, taskId);
  assert.equal(view.status, "todo", "goal 状态只作证据，不得驱动 Task 状态机");
  assert.equal(view.activeRun, null);
});

// ---- 复盘修复：驱动级失败收口与写锁纪律 ----

const driverWith = (env: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  command: process.execPath,
  args: [FAKE_APP_SERVER_PATH],
  env: { ...process.env, FAKE_TURN_DELAY_MS: "25", ...env },
  ...extra,
});

test("thread.sample: resume 驱动级失败终结动作行再上抛，线程不被悬挂行卡死", async () => {
  const daemon = await boot(
    {},
    {
      driver: driverWith(
        { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-resume-fail", FAKE_IGNORE_METHODS: "thread/resume" },
        { requestTimeoutMs: 150 },
      ),
    },
  );
  await seedRollout("ext-resume-fail", "turn_1");
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-resume-fail")).thread !== undefined);
  const taskId = await createTask(daemon, "resumefail");
  assert.equal((await post(daemon, "thread.bind", { taskId, threadId: "ext-resume-fail" })).status, 200);

  const sampled = await post(daemon, "thread.sample", { threadId: "ext-resume-fail" });
  assert.equal(sampled.status, 500, JSON.stringify(sampled.body));
  const row = daemon.store
    .listActionExecutions({ threadId: "ext-resume-fail" })
    .find((a) => a.action === "thread.sample");
  assert.ok(row !== undefined);
  assert.equal(row!.status, "failed", "resume 驱动级失败必须终结动作行");
  assert.equal(row!.detail?.failureKind, "timeout");
  const again = await post(daemon, "thread.sample", { threadId: "ext-resume-fail" });
  assert.equal(again.status, 500, "失败已收口：后续动作照常发起而非 409");
});

test("thread.sample: 采样成功后的落库失败也释放写锁（finally 释放，不得泄漏到 driver 重启）", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-writelock" });
  await seedRollout("ext-writelock", "turn_1");
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-writelock")).thread !== undefined);
  const taskId = await createTask(daemon, "writelock");
  assert.equal((await post(daemon, "thread.bind", { taskId, threadId: "ext-writelock" })).status, 200);

  const original = daemon.store.addThreadSummary.bind(daemon.store);
  (daemon.store as unknown as { addThreadSummary: () => never }).addThreadSummary = () => {
    throw new Error("injected store failure");
  };
  const sampled = await post(daemon, "thread.sample", { threadId: "ext-writelock" });
  (daemon.store as unknown as { addThreadSummary: typeof original }).addThreadSummary = original;
  assert.equal(sampled.status, 500, JSON.stringify(sampled.body));
  assert.equal(daemon.driver.isLoaded("ext-writelock"), false, "写锁必须经 finally 释放");
  const row = daemon.store.listActionExecutions({ threadId: "ext-writelock" }).find((a) => a.action === "thread.sample");
  assert.equal(row!.status, "failed");
});

test("goal 读操作用完即还写锁：本次 resume 的线程在 get/status/pause/clear 后不长期占用", async () => {
  const daemon = await boot({ FAKE_KNOWN_THREADS: "ext-goal-read" });
  await seedRollout("ext-goal-read", "turn_1");
  await until(async () => (await getJson<{ thread?: unknown }>(daemon, "/api/threads/ext-goal-read")).thread !== undefined);
  const taskId = await createTask(daemon, "goalread", { goalEnabled: true });
  assert.equal((await post(daemon, "thread.bind", { taskId, threadId: "ext-goal-read" })).status, 200);

  const status = await post(daemon, "goal.status", { taskId });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(daemon.driver.isLoaded("ext-goal-read"), false, "读操作不得长期占用写锁");

  // 写操作（set）保持 loaded：续跑窗口开着，不适用本纪律
  const set = await post(daemon, "goal.set", { taskId });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(daemon.driver.isLoaded("ext-goal-read"), true);
});
