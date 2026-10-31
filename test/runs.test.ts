/**
 * Run 生命周期贯通：run/cancel 动作、并发上限与队列、cron 真路径、级联驱动与翻转、
 * 审批停下语义、断连/协议失败路径（A11/A16/A19/A21/A23 的执行侧）。
 * 全部经 daemon 公共 API 缝（HTTP + store 注入）+ 假 app-server，不调真实 Codex。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { SingleFlightRegistry } from "../src/single-flight.js";

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录（本文件进程内生效，driver 子进程继承）
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-runs-"));

const FAKE_APP_SERVER_PATH = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  // 回归哨兵：daemon 全关后不得残留子进程句柄（close 与在飞 spawn 的竞态泄漏会把整个测试进程挂死）
  assert.equal(
    process.getActiveResourcesInfo().includes("ProcessWrap"),
    false,
    "child process handle leaked after daemon close",
  );
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const boot = async (
  driverEnv: Record<string, string> = {},
  overrides: Partial<Parameters<typeof startDaemon>[0]> = {},
): Promise<RunningDaemon> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-runs-"));
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
  badges: string[];
  activeRun: { id: string; status: string; threadId: string | null } | null;
  lastRun: { id: string; status: string; trigger: string; threadId: string | null; failureReason: string | null } | null;
  primaryThreadId: string | null;
  primaryThreadStatus: string | null;
  inFlightWrite: boolean;
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

const createTask = async (daemon: RunningDaemon, title: string, prompt = "do it", extra: Record<string, unknown> = {}): Promise<string> => {
  const response = await post(daemon, "task.create", {
    title,
    prompt,
    workspace: "/tmp/ws",
    status: "todo",
    ...extra,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body.task as { id: string }).id;
};

test("run.create drives a real Run through the app-server: running → completed → task todo, primary thread bound", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, "happy");
  const created = await post(daemon, "run.create", { taskId });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.body).sort(), ["ok", "run"]);
  const run = created.body.run as Record<string, unknown>;
  assert.equal(run.taskId, taskId);
  assert.equal(run.trigger, "manual");
  assert.ok(["queued", "running"].includes(run.status as string));
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed");
  const view = await taskView(daemon, taskId);
  assert.equal(view.status, "todo", "completed 未验收回 todo");
  assert.match(view.primaryThreadId ?? "", /^fake-/);
  assert.equal(view.primaryThreadStatus, "completed");
  assert.equal(view.lastRun?.threadId, view.primaryThreadId);
  // 幂等：同 requestId 重放同一响应，不重复起跑
  const sameRequestId = (created.body.run as { id: string }).id;
  const replay = await post(daemon, "run.create", { taskId }, `replay-${sameRequestId}`);
  const replaySecond = await post(daemon, "run.create", { taskId }, `replay-${sameRequestId}`);
  assert.equal(replay.status, 201);
  assert.deepEqual(replaySecond.body, replay.body);
});

test("concurrency limit holds: over-limit runs queue and start as slots free", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "400" }, { settingsOverrides: { concurrencyLimit: 1 } });
  const first = await createTask(daemon, "first");
  const second = await createTask(daemon, "second");
  await post(daemon, "run.create", { taskId: first });
  await post(daemon, "run.create", { taskId: second });
  await until(async () => (await taskView(daemon, first)).activeRun?.status === "running");
  const queued = await taskView(daemon, second);
  assert.equal(queued.activeRun?.status, "queued", "超限 Run 排队");
  assert.equal(queued.status, "running", "排队 Run 也把任务置 running 列");
  await until(async () => (await taskView(daemon, first)).lastRun?.status === "completed");
  await until(async () => (await taskView(daemon, second)).lastRun?.status === "completed");
  assert.equal((await getJson<{ runtime: { activeRuns: number } }>(daemon, "/api/state")).runtime.activeRuns, 0);
});

test("queued run can be cancelled directly without touching the driver", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "400" }, { settingsOverrides: { concurrencyLimit: 1 } });
  const first = await createTask(daemon, "occupied");
  const second = await createTask(daemon, "waiting");
  await post(daemon, "run.create", { taskId: first });
  await post(daemon, "run.create", { taskId: second });
  const cancelled = await post(daemon, "run.cancel", { taskId: second });
  assert.equal(cancelled.status, 200);
  assert.equal((cancelled.body.run as { status: string }).status, "cancelled");
  await until(async () => (await taskView(daemon, second)).status === "todo");
  await until(async () => (await taskView(daemon, first)).lastRun?.status === "completed");
});

test("cancel interrupts our own loaded thread: run cancelled, task todo, thread interrupted (A19 执行侧)", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "5000" });
  const taskId = await createTask(daemon, "interrupt me");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).inFlightWrite === true, 5_000);
  const cancelled = await post(daemon, "run.cancel", { taskId });
  assert.equal(cancelled.status, 200);
  await until(async () => (await taskView(daemon, taskId)).status === "todo");
  const view = await taskView(daemon, taskId);
  assert.equal(view.lastRun?.status, "cancelled");
  assert.equal(view.primaryThreadStatus, "interrupted", "我们持有的线程被真正打断");
  assert.deepEqual(view.badges, ["interrupted"]);
  // 幂等重放：同 requestId 再取消返回同一结果
  const state = await getJson<{ tasks: TaskView[] }>(daemon, "/api/state");
  assert.equal(state.tasks.find((task) => task.id === taskId)?.activeRun, null);
});

test("cancel with an externally active thread: task todo, thread stays running, only external_activity badge (A19)", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, "external");
  // 模拟「Desktop 还在跑」：主绑定线程原生 running，但不在本 daemon 的 app-server 实例里
  daemon.store.upsertThread({ id: "th_external", harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
  daemon.store.bindThread(taskId, "th_external");
  const run = daemon.store.createRun(taskId, "manual");
  daemon.store.markRunRunning(run.id, { threadId: "th_external" });
  const cancelled = await post(daemon, "run.cancel", { taskId });
  assert.equal(cancelled.status, 200);
  await until(async () => (await taskView(daemon, taskId)).status === "todo");
  const view = await taskView(daemon, taskId);
  assert.equal(view.lastRun?.status, "cancelled");
  assert.equal(view.primaryThreadStatus, "running", "外部线程不受我们 cancel 影响");
  assert.ok(view.badges.includes("external_activity"));
  assert.equal(view.badges.includes("interrupted"), false);
});

test("cron fires the real Run creation path through the driver (A21 执行侧)", async () => {
  // 注入可推进的时钟：整分基线上拨 61s，让 nextRunAt 落进宽限窗内（错过不补语义由 cron-ticker 测试钉住）
  const base = Date.parse("2026-10-22T08:00:00.000Z");
  const clock = { base, startedAt: Date.now(), offsetMs: 0 };
  const dir = await mkdtemp(join(tmpdir(), "tb-runs-"));
  tmpDirs.push(dir);
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(dir, "taskboard.sqlite"),
    driver: {
      command: process.execPath,
      args: [FAKE_APP_SERVER_PATH],
      env: { ...process.env, FAKE_TURN_DELAY_MS: "25" },
    },
    cronTickMs: 10,
    now: () => clock.base + clock.offsetMs + (Date.now() - clock.startedAt),
  });
  daemons.push(daemon);
  const taskId = await createTask(daemon, "scheduled", "cron work", { cron: "* * * * *" });
  clock.offsetMs = 61_000; // now 越过 08:01:00 的 nextRunAt，宽限窗（~10s）内不判“错过”
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed", 5_000);
  const view = await taskView(daemon, taskId);
  assert.equal(view.lastRun?.trigger, "cron");
  assert.equal(view.primaryThreadId, view.lastRun?.threadId);
  const annotations = await getJson<{ annotations: Array<{ kind: string }> }>(daemon, `/api/annotations?taskId=${taskId}`);
  assert.equal(annotations.annotations.some((note) => note.kind === "cron_skip"), false, "真路径不再记 cron_skip");
});

const makeCascade = async (daemon: RunningDaemon, prompts: { first: string; second: string; third?: string }) => {
  const parentId = await createTask(daemon, "parent", "parent work", { subtasksPolicy: "cascade" });
  const child1 = await createTask(daemon, "child-1", prompts.first, { parentId });
  const child2 = await createTask(daemon, "child-2", prompts.second, { parentId });
  const child3 = prompts.third === undefined ? null : await createTask(daemon, "child-3", prompts.third, { parentId });
  return { parentId, child1, child2, child3 };
};

test("cascade success: parent completed drives unarchived children in creation order, each an independent cascade Run", async () => {
  const daemon = await boot();
  const { parentId, child1, child2 } = await makeCascade(daemon, { first: "c1 work", second: "c2 work" });
  await post(daemon, "run.create", { taskId: parentId });
  await until(async () => (await taskView(daemon, child2)).lastRun?.status === "completed", 5_000);
  const parent = await taskView(daemon, parentId);
  assert.equal(parent.lastRun?.status, "completed");
  const first = await taskView(daemon, child1);
  const second = await taskView(daemon, child2);
  assert.equal(first.lastRun?.trigger, "cascade");
  assert.equal(second.lastRun?.trigger, "cascade");
  assert.notEqual(first.lastRun?.id, second.lastRun?.id, "子任务各有独立 Run");
  assert.ok(first.primaryThreadId !== second.primaryThreadId, "子任务各有独立 thread");
  for (const taskId of [parentId, child1, child2]) {
    assert.equal((await taskView(daemon, taskId)).status, "todo");
  }
});

test("cascade failure: child failed stops the chain, flips parent run to failed, third child never runs", async () => {
  const daemon = await boot();
  const { parentId, child1, child2, child3 } = await makeCascade(daemon, {
    first: "fine",
    second: "[fail] break",
    third: "never",
  });
  await post(daemon, "run.create", { taskId: parentId });
  await until(async () => (await taskView(daemon, child2)).lastRun?.status === "failed", 5_000);
  const parent = await taskView(daemon, parentId);
  assert.equal(parent.lastRun?.status, "failed", "父 Run 翻转为 failed");
  assert.equal(parent.status, "failed");
  assert.match(parent.lastRun?.failureReason ?? "", /cascade/);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const third = await taskView(daemon, child3!);
  assert.equal(third.lastRun, null, "失败后链条停止，后续子任务不起跑");
});

test("cascade cancel: child cancelled flips parent run to cancelled and parent task back to todo", async () => {
  const daemon = await boot();
  const { parentId, child1, child2 } = await makeCascade(daemon, { first: "quick", second: "[hang] hang" });
  await post(daemon, "run.create", { taskId: parentId });
  await until(async () => (await taskView(daemon, child2)).activeRun?.status === "running", 10_000);
  const cancelled = await post(daemon, "run.cancel", { taskId: child2 });
  assert.equal(cancelled.status, 200);
  await until(async () => (await taskView(daemon, parentId)).lastRun?.status === "cancelled", 10_000);
  const parent = await taskView(daemon, parentId);
  assert.equal(parent.status, "todo", "cancelled 翻转后父任务回 todo");
  const second = await taskView(daemon, child2);
  assert.equal(second.lastRun?.status, "cancelled");
});

test("cascade is process-local: a restart never resumes a half-done cascade (A23)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tb-runs-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "taskboard.sqlite");
  const driver = {
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: { ...process.env, FAKE_TURN_DELAY_MS: "25" },
  };
  const first = await startDaemon({ port: 0, dbPath, driver, cronTickMs: 10 });
  daemons.push(first);
  const parentId = await createTask(first, "restart parent", "parent", { subtasksPolicy: "cascade" });
  const child1 = await createTask(first, "r-child-1", "[hang] slow", { parentId });
  const child2 = await createTask(first, "r-child-2", "later", { parentId });
  await post(first, "run.create", { taskId: parentId });
  await until(async () => (await taskView(first, child1)).activeRun?.status === "running", 10_000);
  // 优雅关闭：driver 断连把在飞 Run 显式落失败；级联链条同进程内翻转父 Run，随后链条消亡
  await first.close();
  daemons.pop();
  const second = await startDaemon({ port: 0, dbPath, driver, cronTickMs: 10 });
  daemons.push(second);
  const child1View = await taskView(second, child1);
  assert.equal(child1View.lastRun?.status, "failed", "半截级联的在飞 Run 显式收敛");
  assert.match(child1View.lastRun?.failureReason ?? "", /exited|disconnected/i);
  assert.equal(child1View.lastRun?.threadId !== null, true, "thread 锚点保留");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await taskView(second, child2)).lastRun, null, "重启不恢复级联：后续子任务不起跑");
  const parent = await taskView(second, parentId);
  assert.equal(parent.lastRun?.status, "failed", "关闭时子 Run 失败按级联规则翻转父 Run");
  assert.match(parent.lastRun?.failureReason ?? "", /cascade/);
});

test("approval stop: run completes, approval_stop annotation recorded, needs_attention badge until a new run starts (A16)", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, "needs approval", "[approval] needs ok");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed", 5_000);
  const view = await taskView(daemon, taskId);
  assert.equal(view.status, "todo", "task_complete 是成功终局，任务回 todo 等验收");
  assert.ok(view.badges.includes("needs_attention"));
  const annotations = await getJson<{ annotations: Array<{ kind: string; body: string }> }>(daemon, `/api/annotations?taskId=${taskId}`);
  const stop = annotations.annotations.find((note) => note.kind === "approval_stop");
  assert.ok(stop !== undefined, "审批停下落审计");
  assert.match(stop!.body, /approval_policy=never/);
  // 系统内不存在自动批准路径：批准类动作类型一律 400 unknown
  const approve = await post(daemon, "run.approve", {});
  assert.equal(approve.status, 400);
  // 人工重试出口：改掉审批诉求再跑，新 Run 起跑即视为接手，徽标清除
  await post(daemon, "task.update", { taskId, prompt: "human took over, no approval needed" });
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed", 5_000);
  assert.equal((await taskView(daemon, taskId)).badges.includes("needs_attention"), false);
});

test("resume of an externally-held bound thread fails the run explicitly and marks the thread held", async () => {
  const daemon = await boot({ FAKE_HELD_THREAD: "th_held" });
  const taskId = await createTask(daemon, "held task");
  daemon.store.upsertThread({ id: "th_held", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  daemon.store.bindThread(taskId, "th_held");
  const created = await post(daemon, "run.create", { taskId });
  assert.equal(created.status, 201);
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "failed", 5_000);
  const view = await taskView(daemon, taskId);
  assert.match(view.lastRun?.failureReason ?? "", /held by another process/);
  assert.equal(view.primaryThreadStatus, "held");
  assert.equal(view.status, "failed");
  const annotations = await getJson<{ annotations: Array<{ kind: string }> }>(daemon, `/api/annotations?taskId=${taskId}`);
  assert.equal(annotations.annotations.some((note) => note.kind === "thread_resume"), false, "失败的 resume 不记接管审计");
});

test("resume of a bound thread we do not hold takes the writer lock with an audit trail", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "30", FAKE_KNOWN_THREADS: "fake_ext" });
  const taskId = await createTask(daemon, "resume me");
  daemon.store.upsertThread({ id: "fake_ext", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  daemon.store.bindThread(taskId, "fake_ext");
  const created = await post(daemon, "run.create", { taskId });
  assert.equal(created.status, 201);
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed", 5_000);
  const annotations = await getJson<{ annotations: Array<{ kind: string; body: string }> }>(daemon, `/api/annotations?taskId=${taskId}`);
  const resume = annotations.annotations.find((note) => note.kind === "thread_resume");
  assert.ok(resume !== undefined, "接管写锁必须落审计");
  assert.equal((await taskView(daemon, taskId)).primaryThreadId, "fake_ext");
  // 同一实例内已 loaded：第二次 run 不再产生 resume 审计
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed", 5_000);
  const again = await getJson<{ annotations: Array<{ kind: string }> }>(daemon, `/api/annotations?taskId=${taskId}`);
  assert.equal(again.annotations.filter((note) => note.kind === "thread_resume").length, 1);
});

test("protocol version change fails runs explicitly, every run retries a fresh app-server, no silent path switch", async () => {
  const daemon = await boot({ FAKE_PROTOCOL_VERSION: "2.0" });
  const taskId = await createTask(daemon, "version shock");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "failed", 5_000);
  const first = await taskView(daemon, taskId);
  assert.match(first.lastRun?.failureReason ?? "", /2\.0 not supported/);
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.id !== first.lastRun?.id, 5_000);
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "failed", 5_000);
  assert.match((await taskView(daemon, taskId)).lastRun?.failureReason ?? "", /2\.0 not supported/);
});

test("app-server crash mid-turn fails the run with a disconnect reason and keeps the thread anchor (crash injection)", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "60000", FAKE_CRASH_ACTIVE_TURN_MS: "60" });
  const taskId = await createTask(daemon, "crash me");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "failed", 5_000);
  const view = await taskView(daemon, taskId);
  assert.equal(view.status, "failed");
  assert.ok(
    /exited|disconnected/i.test(view.lastRun?.failureReason ?? ""),
    `failure reason names the disconnect: ${view.lastRun?.failureReason}`,
  );
  assert.match(view.lastRun?.threadId ?? "", /^fake-/, "thread 锚点保留");
});

test("run.create on a task with an active run conflicts; missing task is 404; archived/no-workspace are semantic errors", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "4000" });
  const taskId = await createTask(daemon, "busy");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).activeRun !== null);
  const busy = await post(daemon, "run.create", { taskId });
  assert.equal(busy.status, 409);
  const missing = await post(daemon, "run.create", { taskId: "t_missing" });
  assert.equal(missing.status, 404);
  const noWorkspace = await post(daemon, "task.create", { title: "nw", prompt: "", workspace: null });
  const nwId = (noWorkspace.body.task as { id: string }).id;
  const nwRun = await post(daemon, "run.create", { taskId: nwId });
  assert.equal(nwRun.status, 400);
  await post(daemon, "run.cancel", { taskId });
  const archived = await post(daemon, "task.archive", { taskId });
  assert.equal(archived.status, 200);
  const rerun = await post(daemon, "run.create", { taskId });
  assert.equal(rerun.status, 409);
  const cancelNone = await post(daemon, "run.cancel", { taskId });
  assert.equal(cancelNone.status, 404, "无活跃 Run 的取消是语义失败");
});

test("single-flight: while a send is in flight the thread slot is held and released at terminal (A11)", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "400" });
  const taskId = await createTask(daemon, "slot");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).inFlightWrite === true, 5_000);
  const state = await getJson<{ runtime: { inFlightWrites: number } }>(daemon, "/api/state");
  assert.equal(state.runtime.inFlightWrites, 1);
  await until(async () => (await taskView(daemon, taskId)).lastRun?.status === "completed", 5_000);
  const after = await getJson<{ runtime: { inFlightWrites: number } }>(daemon, "/api/state");
  assert.equal(after.runtime.inFlightWrites, 0, "终态释放线程槽");
});

test("runtime view reports the driver through the locked {available, note} field set", async () => {
  const daemon = await boot();
  const state = await getJson<{ runtime: { driver: { available: boolean; note: string } } }>(daemon, "/api/state");
  assert.deepEqual(Object.keys(state.runtime.driver).sort(), ["available", "note"]);
  assert.equal(state.runtime.driver.available, true);
  assert.match(state.runtime.driver.note, /lazi|fake-codex/);
});

test("store increments: bindThread enforces single primary; flipRun only flips completed runs", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, "store increments");
  daemon.store.upsertThread({ id: "th_a", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  daemon.store.upsertThread({ id: "th_b", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  daemon.store.bindThread(taskId, "th_a");
  assert.throws(() => daemon.store.bindThread("t_other_missing", "th_a"), /not found/);
  const other = await createTask(daemon, "second owner");
  assert.throws(() => daemon.store.bindThread(other, "th_a"), /primary/, "一个 thread 至多一个 primary");
  const run = daemon.store.createRun(taskId, "manual");
  daemon.store.finishRun(run.id, "completed");
  const flipped = daemon.store.flipRun(run.id, "failed", "cascade stop");
  assert.equal(flipped.status, "failed");
  assert.equal((await taskView(daemon, taskId)).status, "failed");
  assert.throws(() => daemon.store.flipRun(run.id, "cancelled"), /only completed runs/, "终态不得二次翻转");
});

test("raising concurrencyLimit pumps the queue immediately instead of waiting for an unrelated finish", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "2000" }, { settingsOverrides: { concurrencyLimit: 1 } });
  const first = await createTask(daemon, "occupied");
  const second = await createTask(daemon, "waiting");
  await post(daemon, "run.create", { taskId: first });
  await post(daemon, "run.create", { taskId: second });
  await until(async () => (await taskView(daemon, first)).activeRun?.status === "running");
  await until(async () => (await taskView(daemon, second)).activeRun?.status === "queued");

  const updated = await post(daemon, "settings.update", { settings: { concurrencyLimit: 2 } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  await until(async () => (await taskView(daemon, second)).activeRun?.status === "running", 3_000);
  assert.equal((await getJson<{ runtime: { activeRuns: number } }>(daemon, "/api/state")).runtime.activeRuns, 2, "改限立刻放行排队 Run");
});

test("close drains queued runs to cancelled and converges even when stopping the driver fails", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "600" }, { settingsOverrides: { concurrencyLimit: 1 } });
  const first = await createTask(daemon, "running at close");
  const second = await createTask(daemon, "queued at close");
  await post(daemon, "run.create", { taskId: first });
  await post(daemon, "run.create", { taskId: second });
  await until(async () => (await taskView(daemon, first)).activeRun?.status === "running");
  await until(async () => (await taskView(daemon, second)).activeRun?.status === "queued");

  // stopDriver 失败也不得跳过收敛：排队 Run 落 cancelled（级联等待者才能解挂），在飞执行等待收敛；
  // 失败原因在收敛完成后原样上抛（daemon 关闭顺序的处理是另一层的事，见 daemon 关闭项决定）
  await assert.rejects(
    daemon.runs.close(async () => {
      throw new Error("driver close exploded");
    }),
    /driver close exploded/,
  );
  const queued = await taskView(daemon, second);
  assert.equal(queued.lastRun?.status, "cancelled", "排队的 Run 在 close 时落 cancelled");
  assert.match(queued.lastRun?.failureReason ?? "", /shutting down/);
  assert.equal(queued.status, "todo", "取消列映射回 todo");
  assert.equal(daemon.runs.pendingCount(), 0, "close 返回后在飞执行与级联已收敛");
});

test("cancel during the thread-create window leaves no bind or policy side effects", async () => {
  const daemon = await boot({ FAKE_CREATE_DELAY_MS: "500" });
  const taskId = await createTask(daemon, "cancel in create window");
  await post(daemon, "run.create", { taskId });
  await until(async () => (await taskView(daemon, taskId)).activeRun?.status === "running");
  const cancelled = await post(daemon, "run.cancel", { taskId });
  assert.equal(cancelled.status, 200);
  await until(async () => (await taskView(daemon, taskId)).status === "todo");
  // create 迟迟返回后：取消的 Run 不落 thread 绑定/默认策略副作用
  await new Promise((resolve) => setTimeout(resolve, 700));
  const view = await taskView(daemon, taskId);
  assert.equal(view.lastRun?.status, "cancelled");
  assert.equal(view.primaryThreadId, null, "取消窗口内的 create 不得绑定 primary 线程");
  assert.equal(view.primaryThreadStatus, null);
});

test("a completion that arrives after cancel does not drive the cascade (gate on persisted status)", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "600", FAKE_INTERRUPT_LOSES_RACE: "1" });
  const { parentId, child1 } = await makeCascade(daemon, { first: "never runs", second: "also never" });
  await post(daemon, "run.create", { taskId: parentId });
  await until(async () => (await taskView(daemon, parentId)).activeRun?.status === "running");
  const cancelled = await post(daemon, "run.cancel", { taskId: parentId });
  assert.equal(cancelled.status, 200);
  await until(async () => (await taskView(daemon, parentId)).lastRun?.status === "cancelled");
  // 打断输给自然完成：迟到 completed 到达时 Run 已终态，级联与审批审计都不得再动
  await new Promise((resolve) => setTimeout(resolve, 900));
  const parent = await taskView(daemon, parentId);
  assert.equal(parent.lastRun?.status, "cancelled", "迟到完成不得改写取消终态");
  assert.equal((await taskView(daemon, child1)).lastRun, null, "取消后的迟到完成不得驱动级联");
});

test("cascade child that cannot start (archived mid-cascade) flips the parent run failed with the reason", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "300" });
  const { parentId, child1, child2 } = await makeCascade(daemon, { first: "fine", second: "archived soon" });
  await post(daemon, "run.create", { taskId: parentId });
  // 链条停在 child1 的 runTerminal 等待期间归档 child2：起跑时的 ConflictError 必须留因翻父
  await until(async () => (await taskView(daemon, child1)).activeRun?.status === "running", 5_000);
  const archived = await post(daemon, "task.archive", { taskId: child2 });
  assert.equal(archived.status, 200);
  await until(async () => (await taskView(daemon, parentId)).lastRun?.status === "failed", 5_000);
  const parent = await taskView(daemon, parentId);
  assert.equal(parent.status, "failed");
  assert.match(parent.lastRun?.failureReason ?? "", /could not start/);
  assert.equal((await taskView(daemon, child2)).lastRun, null, "归档的子任务不起跑");
});

test("nested cascade: a failed grandchild propagates the flip up the ancestor run chain", async () => {
  const daemon = await boot({ FAKE_TURN_DELAY_MS: "60" }, { settingsOverrides: { maxSubtaskDepth: 2 } });
  const parentId = await createTask(daemon, "grandparent", "gp", { subtasksPolicy: "cascade" });
  const midId = await createTask(daemon, "mid", "mid work", { parentId, subtasksPolicy: "cascade" });
  const leafId = await createTask(daemon, "leaf", "[fail] break", { parentId: midId });
  await post(daemon, "run.create", { taskId: parentId });
  await until(async () => (await taskView(daemon, leafId)).lastRun?.status === "failed", 5_000);
  await until(async () => (await taskView(daemon, parentId)).lastRun?.status === "failed", 5_000);
  const mid = await taskView(daemon, midId);
  const parent = await taskView(daemon, parentId);
  assert.equal(mid.lastRun?.status, "failed", "直接父 Run 按级联规则翻转");
  assert.match(mid.lastRun?.failureReason ?? "", /cascade stopped/);
  assert.equal(parent.lastRun?.status, "failed", "嵌套级联翻转沿父链向上传播");
  assert.match(parent.lastRun?.failureReason ?? "", /nested cascade propagation/);
  assert.equal(parent.status, "failed");
});

test("flipRun skips the task column while a newer run is active and converges run retention", async () => {
  const daemon = await boot();
  const taskId = await createTask(daemon, "flip guard");
  const run1 = daemon.store.createRun(taskId, "manual");
  daemon.store.markRunRunning(run1.id);
  daemon.store.finishRun(run1.id, "completed");
  // 任务被重新起跑后，迟到的级联翻转只改 Run 不覆盖任务当前列
  const run2 = daemon.store.createRun(taskId, "manual");
  daemon.store.markRunRunning(run2.id);
  daemon.store.flipRun(run1.id, "failed", "late cascade stop");
  assert.equal(daemon.store.getRun(run1.id)?.status, "failed");
  assert.equal(daemon.store.getTask(taskId)?.status, "running", "活跃 Run 在飞时列状态不被迟到翻转覆盖");
  daemon.store.finishRun(run2.id, "completed");
  const keep = daemon.store.getSettings().retention.runsPerTask;
  for (let i = 0; i < keep + 2; i += 1) {
    const churn = daemon.store.createRun(taskId, "manual");
    daemon.store.finishRun(churn.id, "failed", "churn");
  }
  assert.equal(daemon.store.listRuns(taskId, 500).length, keep, "终态 Run 收敛到 retention 上限");
});

test("markRunRunning keeps the first claim time across re-marks (queued wait not erased)", async () => {
  const clock = { nowMs: Date.now() };
  const daemon = await boot({}, { now: () => clock.nowMs });
  const taskId = await createTask(daemon, "clock");
  const run = daemon.store.createRun(taskId, "manual");
  clock.nowMs += 5_000;
  daemon.store.markRunRunning(run.id);
  const firstClaim = daemon.store.getRun(run.id)?.startedAt;
  clock.nowMs += 5_000;
  daemon.store.markRunRunning(run.id, { threadId: "th_remark" });
  assert.equal(daemon.store.getRun(run.id)?.startedAt, firstClaim, "二次认领不得抹掉排队等待时长");
  assert.equal(daemon.store.getRun(run.id)?.threadId, "th_remark");
});

test("single-flight transfer re-keys a held slot without an unclaimed window", () => {
  const registry = new SingleFlightRegistry();
  assert.ok(registry.tryAcquire("th_t", "resume"));
  assert.equal(registry.tryAcquire("th_t", "send"), false, "resume 持有期间第三者不得认领");
  assert.equal(registry.transfer("th_t", "send"), true, "持有者可原位平移");
  assert.equal(registry.isInFlight("th_t"), true, "平移不产生无主窗口");
  assert.equal(registry.tryAcquire("th_t", "goal"), false, "平移后槽仍被持有");
  assert.equal(registry.transfer("th_missing", "send"), false, "无持有者时平移失败");
  registry.release("th_t");
  assert.equal(registry.isInFlight("th_t"), false);
  assert.ok(registry.tryAcquire("th_t", "send"), "释放后可重新认领");
});
