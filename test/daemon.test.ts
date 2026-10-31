/**
 * daemon 装配：A1 空库启动、A24 重启对账、A25 双启/接管、A26 损坏拒启、优雅关闭、
 * 防休眠 runtime 态（A29 的 daemon 侧）、settings 覆盖持久化、栅栏配置错误失败关闭并放锁。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonLockHeldError, daemonLockPathFor } from "../src/daemon-lock.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { DatabaseCorruptError, openStateDb } from "../src/db.js";
import type { PowerGuard } from "../src/power-guard.js";
import { Store } from "../src/store/index.js";
import type { PowerProtectionStatus } from "../src/types.js";
import { resetClock, sessionMeta, taskComplete, taskStarted } from "./helpers/rollout.js";

const FAKE_APP_SERVER_PATH = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录（本文件进程内生效）
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-daemon-"));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-daemon-"));
  tmpDirs.push(dir);
  return dir;
};

const boot = async (overrides: Partial<Parameters<typeof startDaemon>[0]> & { dbPath: string }): Promise<RunningDaemon> => {
  const daemon = await startDaemon({ port: 0, ...overrides });
  daemons.push(daemon);
  return daemon;
};

const getJson = async <T>(port: number, path: string): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return (await response.json()) as T;
};

const postJson = async (
  port: number,
  type: string,
  fields: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`http://127.0.0.1:${port}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, requestId: `t-${Math.random().toString(36).slice(2)}`, ...fields }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const createInput = (title: string, workspace: string | null = "/tmp/ws") => ({
  title,
  prompt: "",
  workspace,
  status: "todo" as const,
  labels: [],
  source: "manual" as const,
  acceptanceCriteria: "",
  acceptanceMode: "human" as const,
  automationMode: "suggest" as const,
  workspaceMode: "current" as const,
  parentId: null,
  subtasksPolicy: null,
  idleThresholdMs: null,
  cron: null,
  tz: null,
  goalEnabled: false,
  goalBudgetTokens: null,
});

test("A1: fresh start initializes an empty schema, five columns empty, db path readable, lock released on close", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const daemon = await boot({ dbPath });
  assert.ok(await exists(dbPath));
  assert.ok(await exists(daemonLockPathFor(dbPath)));
  const state = await getJson<{ ok: boolean; tasks: unknown[]; revisions: Record<string, number> }>(daemon.port, "/api/state");
  assert.equal(state.ok, true);
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.revisions, { tasks: 0, threads: 0, config: 0 });
  const path = await getJson<{ path: string }>(daemon.port, "/api/db/path");
  assert.equal(path.path, dbPath);
  await daemon.close();
  daemons.pop();
  assert.equal(await exists(daemonLockPathFor(dbPath)), false);
});

test("A25: second daemon on the same db fails reporting holder pid; after the first closes (or goes stale) it takes over", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const first = await boot({ dbPath, lockHeartbeatMs: 0, lockStaleMs: 60_000 });
  await assert.rejects(
    startDaemon({ port: 0, dbPath, lockHeartbeatMs: 0, lockStaleMs: 60_000 }),
    (error: unknown) => {
      assert.ok(error instanceof DaemonLockHeldError);
      assert.equal(error.holderPid, process.pid);
      return true;
    },
  );
  await first.close();
  daemons.pop();
  const second = await boot({ dbPath, lockHeartbeatMs: 0 });
  assert.ok(second.port > 0);
  await second.close();
  daemons.pop();
  // 持有者被 kill -9：心跳停摆、mtime 陈旧 → 可接管
  const ghost = await boot({ dbPath, lockHeartbeatMs: 0 });
  const dead = new Date(Date.now() - 10 * 60_000);
  await utimes(daemonLockPathFor(dbPath), dead, dead);
  const takeover = await startDaemon({ port: 0, dbPath, lockHeartbeatMs: 0, lockStaleMs: 90_000 });
  daemons.push(takeover);
  const content = JSON.parse(await readFile(daemonLockPathFor(dbPath), "utf8")) as { pid: number };
  assert.equal(content.pid, process.pid);
  await ghost.close().catch(() => undefined);
});

test("A26: corrupt database is isolated as .corrupt-<ts>, daemon refuses to start and releases the lock", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  await writeFile(dbPath, "garbage, not sqlite\n", "utf8");
  await assert.rejects(startDaemon({ port: 0, dbPath }), (error: unknown) => {
    assert.ok(error instanceof DatabaseCorruptError);
    assert.match(error.message, /refuses to start/);
    return true;
  });
  const names = await readdir(dir);
  assert.ok(names.some((name) => name.startsWith("taskboard.sqlite.corrupt-")), "corrupt file isolated");
  assert.equal(names.includes("taskboard.sqlite"), false, "no empty database was rebuilt");
  assert.equal(await exists(daemonLockPathFor(dbPath)), false, "lock released after refusal");
});

test("A24: leftover running/queued runs are reconciled on restart; thread anchor kept; tasks back to todo", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  {
    const { db } = await openStateDb(dbPath);
    const store = new Store(db);
    const a = store.createTask(createInput("a"));
    const b = store.createTask(createInput("b"));
    const runA = store.createRun(a.id, "manual");
    store.markRunRunning(runA.id, { threadId: "th_keep" });
    store.createRun(b.id, "cron");
    db.close();
  }
  const daemon = await boot({ dbPath });
  const state = await getJson<{
    tasks: Array<{ title: string; status: string; lastRun: { status: string; orphaned: boolean; threadId: string | null } }>;
    runtime: { activeRuns: number };
  }>(daemon.port, "/api/state");
  const byTitle = Object.fromEntries(state.tasks.map((task) => [task.title, task]));
  assert.equal(byTitle.a!.status, "todo");
  assert.equal(byTitle.b!.status, "todo");
  assert.equal(byTitle.a!.lastRun.status, "failed");
  assert.equal(byTitle.a!.lastRun.orphaned, true);
  assert.equal(byTitle.a!.lastRun.threadId, "th_keep");
  assert.equal(byTitle.b!.lastRun.status, "cancelled");
  assert.equal(state.runtime.activeRuns, 0);
});

test("graceful close ends SSE streams and frees the port even with keep-alive clients", async () => {
  const dir = await makeDir();
  const daemon = await boot({ dbPath: join(dir, "taskboard.sqlite") });
  const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port: daemon.port, path: "/api/events" }, resolve);
    req.on("error", reject);
  });
  const ended = new Promise<void>((resolve) => stream.on("close", () => resolve()));
  stream.resume(); // paused 模式下 end/close 不会触发
  await fetch(`http://127.0.0.1:${daemon.port}/api/state`); // keep-alive 连接
  const started = Date.now();
  await daemon.close();
  daemons.pop();
  await ended;
  assert.ok(Date.now() - started < 2_000, "close must not wait for idle keep-alive sockets");
  await assert.rejects(fetch(`http://127.0.0.1:${daemon.port}/api/state`));
});

test("close 先停 HTTP（ADR-0014）：关闭开始即拒新连接，在飞请求的应答仍送达、不撞已关服务", async () => {
  const dir = await makeDir();
  // 预置外部线程 rollout（绑定后 sample 才走 resume+sample+close 的真实 driver 路径）；
  // 必须在 boot 前落盘：本文件 boot 未注入 scanIntervalMs，增量扫描 30s 后才再来一遍
  resetClock();
  const sessionsDir = join(process.env.CODEX_HOME!, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(
    join(sessionsDir, `rollout-ext-slow.jsonl`),
    // 末尾必须有换行：无换行的最后一行按「截断半行」兼容语义被丢弃（ADR-0012），task_complete 会丢
    [sessionMeta(0, { sessionId: "ext-slow", cwd: "/tmp/ws" }), taskStarted(1, "turn_1"), taskComplete(2, "turn_1")].join(
      "\n",
    ) + "\n",
  );
  // 假 app-server 对 thread/sample 应答前延迟 1s：制造一个必然横跨关闭起点的在飞处理器
  const daemon = await boot({
    dbPath: join(dir, "taskboard.sqlite"),
    driver: {
      command: process.execPath,
      args: [FAKE_APP_SERVER_PATH],
      env: {
        ...process.env,
        FAKE_WITH_SAMPLE: "1",
        FAKE_KNOWN_THREADS: "ext-slow",
        FAKE_SAMPLE_DELAY_MS: "1000",
      },
    },
  });
  const until = async (predicate: () => Promise<boolean>): Promise<void> => {
    for (let deadline = Date.now() + 3_000; Date.now() < deadline; ) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.ok(await predicate(), "condition not met within 3s");
  };
  await until(async () => {
    try {
      const detail = await getJson<{ thread?: { turnCount: number } }>(daemon.port, "/api/threads/ext-slow");
      return detail.thread !== undefined && detail.thread.turnCount === 1;
    } catch {
      return false; // reader 初始扫描完成前 404
    }
  });
  const taskId = daemon.store.createTask(createInput("sample-close")).id;
  const bound = await postJson(daemon.port, "thread.bind", { taskId, threadId: "ext-slow" });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  // 在飞 sample 先出发，等它真正进入 driver 延迟窗口再关（readJsonBody/入队可能还没落位）
  const sampled = postJson(daemon.port, "thread.sample", { threadId: "ext-slow" });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const started = Date.now();
  const closing = daemon.close();
  daemons.pop();
  // 新顺序下监听此刻已停：新连接必须被拒，而不是收下请求落成 409 噪声（旧顺序此处仍能拿到响应）
  await assert.rejects(fetch(`http://127.0.0.1:${daemon.port}/api/state`));
  // 在飞处理器的应答仍送达：其 store/driver 调用发生在服务还全开时（provenance=sample 证明走的是
  // 真实 resume+sample+close driver 路径而非快速回落，回落也应 200 但不会横跨关闭窗口）
  const sampleResult = await sampled;
  assert.equal(sampleResult.status, 200, JSON.stringify(sampleResult.body));
  assert.equal(
    (sampleResult.body.sample as { provenance: string }).provenance,
    "sample",
    JSON.stringify(sampleResult.body),
  );
  await closing;
  await assert.rejects(fetch(`http://127.0.0.1:${daemon.port}/api/state`));
  assert.ok(Date.now() - started < 5_000, "close must not hang behind the drained handler");
});

test("daemon 不把默认、设置项或调用方登记的凭据传给 app-server 子进程", async () => {
  const dir = await makeDir();
  const capture = join(dir, "child-env.json");
  const previousToken = process.env.TASKBOARD_SYSTEMONE_TOKEN;
  const previousCustom = process.env.TASKBOARD_TEST_CUSTOM_TOKEN;
  const previousCallback = process.env.TASKBOARD_TEST_CALLBACK_TOKEN;
  process.env.TASKBOARD_SYSTEMONE_TOKEN = "super-secret-token";
  process.env.TASKBOARD_TEST_CUSTOM_TOKEN = "custom-secret-token";
  process.env.TASKBOARD_TEST_CALLBACK_TOKEN = "callback-secret-token";
  try {
    const daemon = await boot({
      dbPath: join(dir, "taskboard.sqlite"),
      driver: {
        command: process.execPath,
        args: [FAKE_APP_SERVER_PATH],
        env: { ...process.env, FAKE_ENV_CAPTURE: capture },
        secretEnvKeys: () => ["TASKBOARD_TEST_CALLBACK_TOKEN"],
      },
    });
    daemon.store.updateSettings({ systemoneTokenEnv: "TASKBOARD_TEST_CUSTOM_TOKEN" });
    await daemon.driver.ensureStarted();
    const childEnv = JSON.parse(await readFile(capture, "utf8")) as Record<string, string>;
    assert.equal(childEnv.TASKBOARD_SYSTEMONE_TOKEN, undefined);
    assert.equal(childEnv.TASKBOARD_TEST_CUSTOM_TOKEN, undefined);
    assert.equal(childEnv.TASKBOARD_TEST_CALLBACK_TOKEN, undefined);
    assert.equal(childEnv.FAKE_ENV_CAPTURE, capture);
  } finally {
    if (previousToken === undefined) delete process.env.TASKBOARD_SYSTEMONE_TOKEN;
    else process.env.TASKBOARD_SYSTEMONE_TOKEN = previousToken;
    if (previousCustom === undefined) delete process.env.TASKBOARD_TEST_CUSTOM_TOKEN;
    else process.env.TASKBOARD_TEST_CUSTOM_TOKEN = previousCustom;
    if (previousCallback === undefined) delete process.env.TASKBOARD_TEST_CALLBACK_TOKEN;
    else process.env.TASKBOARD_TEST_CALLBACK_TOKEN = previousCallback;
  }
});

const makeGuardSpy = (initial: PowerProtectionStatus = "idle"): { guard: PowerGuard; calls: string[] } => {
  const calls: string[] = [];
  let held = false;
  return {
    calls,
    guard: {
      acquire: async () => {
        calls.push("acquire");
        held = true;
      },
      release: async () => {
        calls.push("release");
        held = false;
      },
      status: () => (initial === "unavailable" ? "unavailable" : held ? "active" : "idle"),
    },
  };
};

const until = async (predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
};

test("power protection: off by default; enabled guard holds only while a run is running; unavailable platform does not block runs", async () => {
  const dir = await makeDir();
  const off = await boot({ dbPath: join(dir, "off.sqlite") });
  const offState = await getJson<{ runtime: { powerProtection: string } }>(off.port, "/api/state");
  assert.equal(offState.runtime.powerProtection, "off");

  const spy = makeGuardSpy();
  const on = await boot({
    dbPath: join(dir, "on.sqlite"),
    settingsOverrides: { preventIdleSleep: true },
    powerGuard: spy.guard,
  });
  const powerOf = async (): Promise<string> =>
    (await getJson<{ runtime: { powerProtection: string } }>(on.port, "/api/state")).runtime.powerProtection;
  assert.equal(await powerOf(), "idle");
  const task = on.store.createTask(createInput("long"));
  const run = on.store.createRun(task.id, "manual");
  // 排队不计入窗口
  assert.equal(await powerOf(), "idle");
  on.store.markRunRunning(run.id);
  assert.ok(await until(async () => (await powerOf()) === "active"));
  on.store.finishRun(run.id, "completed");
  assert.ok(await until(async () => (await powerOf()) === "idle"));
  assert.deepEqual(spy.calls, ["acquire", "release"]);

  const unavailable = makeGuardSpy("unavailable");
  const degraded = await boot({
    dbPath: join(dir, "degraded.sqlite"),
    settingsOverrides: { preventIdleSleep: true },
    powerGuard: unavailable.guard,
  });
  const degradedTask = degraded.store.createTask(createInput("still runs"));
  const degradedRun = degraded.store.createRun(degradedTask.id, "manual");
  degraded.store.markRunRunning(degradedRun.id);
  const degradedState = await getJson<{ runtime: { powerProtection: string; activeRuns: number } }>(degraded.port, "/api/state");
  assert.equal(degradedState.runtime.powerProtection, "unavailable");
  assert.equal(degradedState.runtime.activeRuns, 1);
});

test("settings overrides persist across restarts; invalid proxy guard config fails closed and releases the lock", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const first = await boot({ dbPath, settingsOverrides: { concurrencyLimit: 5, maxSubtaskDepth: 3 } });
  await first.close();
  daemons.pop();
  const second = await boot({ dbPath });
  const state = await getJson<{ runtime: { concurrencyLimit: number } }>(second.port, "/api/state");
  assert.equal(state.runtime.concurrencyLimit, 5);
  assert.equal(second.store.getSettings().maxSubtaskDepth, 3);
  await second.close();
  daemons.pop();
  // 栅栏开了但令牌环境变量缺失：失败关闭，且锁已释放
  await assert.rejects(
    startDaemon({
      port: 0,
      dbPath,
      settingsOverrides: { trustedProxyHosts: ["10.0.0.1"], proxyTokenEnv: "TB_TEST_TOKEN_MISSING" },
      env: {},
    }),
    /TB_TEST_TOKEN_MISSING/,
  );
  assert.equal(await exists(daemonLockPathFor(dbPath)), false);
  // 清掉坏配置，后续测试文件不受影响
  const repair = await boot({ dbPath, settingsOverrides: { trustedProxyHosts: [], proxyTokenEnv: null } });
  assert.equal((await getJson<{ runtime: { proxyGuard: boolean } }>(repair.port, "/api/state")).runtime.proxyGuard, false);
});

test("resolveDaemonConfig: 空串环境变量视为未设置，不把 resolve('') 落到 cwd（CODEX_HOME/TASKBOARD_WEB_DIR）", async () => {
  const { defaultWebDir, resolveDaemonConfig } = await import("../src/daemon.js");
  const codex = resolveDaemonConfig({ env: { CODEX_HOME: "" } });
  assert.equal(codex.codexHome, join(homedir(), ".codex"), "CODEX_HOME= 不得把扫描根指到 cwd");
  const web = resolveDaemonConfig({ env: { TASKBOARD_WEB_DIR: "" } });
  assert.equal(web.webDir, defaultWebDir(), "TASKBOARD_WEB_DIR= 不得把静态根指到 cwd");
  const explicit = resolveDaemonConfig({ env: {}, codexHome: "/tmp/explicit-codex", webDir: "/tmp/explicit-web" });
  assert.equal(explicit.codexHome, resolve("/tmp/explicit-codex"));
  assert.equal(explicit.webDir, resolve("/tmp/explicit-web"));
  const spaced = resolveDaemonConfig({ env: { CODEX_HOME: "   " } });
  assert.equal(spaced.codexHome, join(homedir(), ".codex"), "纯空白同空串处理");
});

test("A20: interrupted 评估的非领域失败留结构化日志（不再静默吞）", async () => {
  const { resetClock, sessionMeta, taskStarted, turnAborted } = await import("./helpers/rollout.js");
  const dir = await makeDir();
  // 先建任务+绑定，再落 interrupted rollout：reader 收口 interrupted turn 时线程已绑定
  const daemon = await boot({ dbPath: join(dir, "taskboard.sqlite"), scanIntervalMs: 0, codexHome: dir });
  const post = async (path: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${daemon.port}` },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const created = await post("/api/actions", {
    type: "task.create",
    requestId: "a20-log-create",
    title: "a20-log",
    prompt: "do it",
    workspace: "/tmp/ws",
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const taskId = (created.body.task as { id: string }).id;
  daemon.store.upsertThread({ id: "th-a20-log", harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
  assert.equal(
    (await post("/api/actions", { type: "thread.bind", requestId: "a20-log-bind", taskId, threadId: "th-a20-log" })).status,
    200,
  );

  resetClock();
  const lines = [
    sessionMeta(0, { sessionId: "th-a20-log", cwd: "/tmp/ws" }),
    taskStarted(1, "turn-1"),
    turnAborted(2, "turn-1"),
  ];
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "sessions"), { recursive: true });
  await writeFile(join(dir, "sessions", "rollout-a20.jsonl"), `${lines.join("\n")}\n`);

  // 注入非领域失败：evaluateThread 直接拒绝（领域异常仍静默，store/driver 异常必须留痕）
  (daemon.jev as unknown as { evaluateThread: () => Promise<never> }).evaluateThread = () =>
    Promise.reject(new Error("injected driver outage"));
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string, ...rest: unknown[]) => boolean }).write = (
    chunk: string,
    ...rest: unknown[]
  ) => {
    chunks.push(String(chunk));
    return originalWrite(chunk, ...(rest as []));
  };
  try {
    await daemon.harnesses.scanNow();
  } finally {
    (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
  assert.ok(
    chunks.some((chunk) => chunk.includes("interrupted_evaluation_failed") && chunk.includes("injected driver outage")),
    `非领域失败必须留日志，got: ${chunks.join("|").slice(0, 500)}`,
  );
});

test("fileErrors 集合变化推 threads revision（error-only 扫描可见性），无变化不空转", async () => {
  const dir = await makeDir();
  const daemon = await boot({ dbPath: join(dir, "taskboard.sqlite"), scanIntervalMs: 0, codexHome: dir });
  await daemon.harnesses.scanNow();
  const baseline = daemon.store.revisions().threads;
  await mkdir(join(dir, "sessions"), { recursive: true });
  // 坏行 jsonl 会逐行降级为 anomaly 而不抛；只有坏 zst（解压失败）才进 fileErrors
  await writeFile(join(dir, "sessions", "rollout-broken.jsonl.zst"), "not zst payload", "utf8");
  await daemon.harnesses.scanNow();
  const afterBad = daemon.store.revisions().threads;
  assert.ok(afterBad > baseline, "坏文件首次进集合必须推 threads revision");
  const state = await getJson<{ failures: Array<{ code: string }> }>(daemon.port, "/api/state");
  assert.ok(
    state.failures.some((failure) => failure.code === "source_unreadable"),
    "state 必须暴露 source_unreadable failure",
  );
  await daemon.harnesses.scanNow();
  assert.equal(daemon.store.revisions().threads, afterBad, "同一坏文件无变化时不再推 revision");
});

test("issue-49: codexHome=null 装配 registry 为空——scan 相位 unavailable 且 scan.refresh 明确 501", async () => {
  const dir = await makeDir();
  const daemon = await boot({ dbPath: join(dir, "taskboard.sqlite"), codexHome: null });
  assert.equal(daemon.harnesses.size(), 0, "codexHome=null 时 registry 必须为空");
  const state = await getJson<{ runtime: { scan: { phase: string } } }>(daemon.port, "/api/state");
  assert.equal(state.runtime.scan.phase, "unavailable");
  const refreshed = await postJson(daemon.port, "scan.refresh", {});
  assert.equal(refreshed.status, 501, JSON.stringify(refreshed.body));
});

test("issue-49: registry.size 如实反映装配规模", async () => {
  const dir = await makeDir();
  const daemon = await boot({ dbPath: join(dir, "taskboard.sqlite"), scanIntervalMs: 0, codexHome: dir });
  assert.equal(daemon.harnesses.size(), 1, "codex 装配时 registry 非空，scan 端点必须存在");
  const state = await getJson<{ runtime: { scan: { phase: string } } }>(daemon.port, "/api/state");
  assert.notEqual(state.runtime.scan.phase, "unavailable");
});
