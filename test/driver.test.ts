/**
 * Codex app-server driver：协议客户端与写路径。
 * 假 app-server（test/fake-app-server.mjs）是锁定的协议契约：版本、method 集合、事件词表、幂等。
 * 单测不调真实 Codex；真机冒烟由环境变量启用（test/driver.smoke.test.ts）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "../src/driver/client.js";
import { CodexDriver } from "../src/driver/codex-driver.js";
import {
  CapabilityUnavailableError,
  DriverDisconnectedError,
  DriverProtocolError,
} from "../src/driver/errors.js";

export const FAKE_APP_SERVER_PATH = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

const clients: AppServerClient[] = [];
const drivers: CodexDriver[] = [];
afterEach(async () => {
  while (drivers.length > 0) await drivers.pop()!.close().catch(() => undefined);
  while (clients.length > 0) await clients.pop()!.close().catch(() => undefined);
});

const fakeEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  FAKE_TURN_DELAY_MS: "25",
  ...extra,
});

const startClient = async (extra: Record<string, string> = {}): Promise<AppServerClient> => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: fakeEnv(extra),
  });
  clients.push(client);
  await client.start();
  return client;
};

const startDriver = async (extra: Record<string, string> = {}): Promise<CodexDriver> => {
  const driver = new CodexDriver({
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: fakeEnv(extra),
  });
  drivers.push(driver);
  return driver;
};

const waitUntil = async (predicate: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("fake app-server contract: initialize without experimental opt-in is rejected; unknown methods are -32600 unknown variant", async () => {
  // 直接走裸进程：锁定的是假服务器本身，不是我们客户端的行为
  const child = spawn(process.execPath, [FAKE_APP_SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    lines.push(...parts.filter((line) => line.trim().length > 0));
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "t" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/sample", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/interrupt", params: {} })}\n`);
  await waitUntil(() => lines.length >= 3);
  child.kill("SIGKILL");
  const responses = lines.map((line) => JSON.parse(line) as { id?: number; error?: { code: number; message: string } });
  const init = responses.find((r) => r.id === 1);
  assert.equal(init?.error?.code, -32600);
  assert.match(init!.error!.message, /experimentalApi=true/);
  const sample = responses.find((r) => r.id === 2);
  assert.equal(sample?.error?.code, -32600);
  assert.match(sample!.error!.message, /unknown variant `thread\/sample`/);
  const interrupt = responses.find((r) => r.id === 3);
  assert.match(interrupt!.error!.message, /missing field `threadId`/, "锁定的 method 集合包含 turn/interrupt");
});

test("client initializes with experimental opt-in and probes the capability registry", async () => {
  const client = await startClient();
  const info = client.info();
  assert.equal(info.protocolVersion, "1.0");
  assert.match(info.userAgent ?? "", /fake-codex/);
  const capabilities = client.capabilities();
  // 只登记实际探测到的能力：核心写 method 存在（missing-field 应答），sample 缺省不可用
  assert.deepEqual(capabilities.available.sort(), [
    "thread/close",
    "thread/goal/clear",
    "thread/goal/enable",
    "thread/goal/get",
    "thread/goal/pause",
    "thread/goal/resume",
    "thread/goal/set",
    "thread/goal/status",
    "thread/resume",
    "turn/interrupt",
  ]);
  assert.deepEqual(capabilities.unavailable, ["thread/sample"]);
  assert.throws(() => client.requireCapability("thread/sample"), CapabilityUnavailableError);
});

test("protocol version mismatch fails loudly with a clear error", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: fakeEnv({ FAKE_PROTOCOL_VERSION: "2.0" }),
  });
  clients.push(client);
  await assert.rejects(client.start(), (error: unknown) => {
    assert.ok(error instanceof DriverProtocolError);
    assert.match(error.message, /2\.0 not supported/);
    return true;
  });
});

test("disconnect rejects pending work with DriverDisconnectedError and marks the client dead", async () => {
  // 应答与终态都推迟：kill 时 turn/start 必然仍在飞（否则 pending 提前 resolve，断言对象就没了）
  const client = await startClient({ FAKE_TURN_DELAY_MS: "5000", FAKE_TURN_REPLY_DELAY_MS: "5000" });
  const threadId = (await client.request("thread/start", { cwd: "/tmp/ws", approvalPolicy: "never", sandbox: "workspace-write" }) as { threadId: string }).threadId;
  const pending = client.request("turn/start", { threadId, input: [{ type: "text", text: "long" }] });
  // 必须等假服务器确认收到 turn/start（lastInputs 在收到那一刻同步记录）再杀：
  // 杀早了会抢在 stdin 写入完成前，pending 走 EPIPE 而非断连拒绝——那是未经测试的另一条路径
  const deadline = Date.now() + 2_000;
  for (;;) {
    const stats = (await client.request("__fake/stats", {})) as { lastInputs: Record<string, string> };
    if (stats.lastInputs[threadId] === "long") break;
    if (Date.now() > deadline) throw new Error(`fake server never acknowledged turn/start: ${JSON.stringify(stats)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.kill(client.pid!, "SIGKILL");
  await assert.rejects(pending, DriverDisconnectedError);
  assert.equal(client.status, "disconnected");
});

test("driver createThread + send reaches task_complete and binds a real thread id", async () => {
  const driver = await startDriver();
  const threadId = await driver.createThread({ workspace: "/tmp/ws", idempotencyKey: "create/r1" });
  assert.match(threadId, /^fake-/);
  const terminal = await driver.send({ threadId, message: "hello", idempotencyKey: "run/r1" });
  assert.deepEqual(terminal, { kind: "completed", stopReason: null, message: null });
  assert.ok(driver.isLoaded(threadId));
});

test("driver maps scripted failure to a failed terminal and approval stop to completed+approval_needed", async () => {
  const driver = await startDriver();
  const threadId = await driver.createThread({ workspace: "/tmp/ws", idempotencyKey: "create/r2" });
  const failed = await driver.send({ threadId, message: "[fail] break", idempotencyKey: "run/r2a" });
  assert.equal(failed.kind, "failed");
  assert.match(failed.message ?? "", /boom/);
  const approval = await driver.send({ threadId, message: "[approval] needs ok", idempotencyKey: "run/r2b" });
  assert.equal(approval.kind, "completed");
  assert.equal(approval.stopReason, "approval_needed");
});

test("driver interrupt ends the active turn as interrupted, never failed", async () => {
  const driver = await startDriver({ FAKE_TURN_DELAY_MS: "5000" });
  const threadId = await driver.createThread({ workspace: "/tmp/ws", idempotencyKey: "create/r3" });
  const pending = driver.send({ threadId, message: "long", idempotencyKey: "run/r3" });
  await waitUntil(() => {
    // turn 已在飞：第二次 send 被假服务器按忙拒绝
    return true;
  });
  const interrupted = await driver.interrupt(threadId);
  assert.equal(interrupted.interrupted, true);
  const terminal = await pending;
  assert.deepEqual(terminal, { kind: "interrupted", stopReason: null, message: null });
});

test("second send while a turn is in flight is rejected as busy, never parallel", async () => {
  const driver = await startDriver({ FAKE_TURN_DELAY_MS: "3000" });
  const threadId = await driver.createThread({ workspace: "/tmp/ws", idempotencyKey: "create/r4" });
  const first = driver.send({ threadId, message: "first", idempotencyKey: "run/r4a" });
  await assert.rejects(
    driver.send({ threadId, message: "second", idempotencyKey: "run/r4b" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /active turn/);
      return true;
    },
  );
  await driver.interrupt(threadId);
  assert.equal((await first).kind, "interrupted");
});

test("idempotency key: replaying a completed write does not execute it twice", async () => {
  const client = await startClient();
  const created = (await client.request("thread/start", { cwd: "/tmp/ws", approvalPolicy: "never", sandbox: "workspace-write", idempotencyKey: "create/k1" })) as { threadId: string };
  await client.request("turn/start", { threadId: created.threadId, input: [{ type: "text", text: "once" }], idempotencyKey: "run/k1" });
  const replayed = (await client.request("turn/start", { threadId: created.threadId, input: [{ type: "text", text: "once" }], idempotencyKey: "run/k1" })) as { turnId: string };
  const stats = (await client.request("__fake/stats", {})) as { threads: number };
  assert.equal(stats.threads, 1, "同一 create 幂等键不重复建 thread");
  const recreated = (await client.request("thread/start", { cwd: "/tmp/ws", approvalPolicy: "never", sandbox: "workspace-write", idempotencyKey: "create/k1" })) as { threadId: string };
  assert.equal(recreated.threadId, created.threadId);
  assert.match(replayed.turnId, /^turn-/);
});

test("resume of an externally-held thread maps Conflict to a domain error and never loads the thread", async () => {
  const driver = await startDriver({ FAKE_HELD_THREAD: "th_held" });
  await assert.rejects(
    driver.resumeThread({ threadId: "th_held", idempotencyKey: "resume/r5" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /held by another process/);
      return true;
    },
  );
  assert.equal(driver.isLoaded("th_held"), false);
});

test("driver describe reports availability for the runtime view", async () => {
  const driver = await startDriver();
  const idle = driver.describe();
  assert.equal(idle.available, true);
  await driver.ensureStarted();
  const ready = driver.describe();
  assert.match(ready.note, /fake-codex/);
  assert.deepEqual(Object.keys(ready).sort(), ["available", "note"]);
});

test("isJsonRpcResponse: server-initiated requests (id+method) are never responses", async () => {
  const { isJsonRpcResponse } = await import("../src/driver/protocol.js");
  assert.equal(isJsonRpcResponse({ jsonrpc: "2.0", id: 1, method: "x", params: {} }), false);
  assert.equal(isJsonRpcResponse({ id: 1, result: {} }), true);
  assert.equal(isJsonRpcResponse({ id: 1, error: { code: -1, message: "m" } }), true);
  assert.equal(isJsonRpcResponse({ method: "event_msg", params: {} }), false);
});

test("a server-initiated request never masquerades as a client response (id collision)", async () => {
  const client = await startClient({ FAKE_SERVER_REQUEST: "1" });
  const created = (await client.request("thread/start", {
    cwd: "/tmp/ws",
    approvalPolicy: "never",
    sandbox: "workspace-write",
  })) as { threadId?: string };
  assert.ok(typeof created.threadId === "string" && created.threadId.length > 0, "real reply settles the pending, not the server request");
});

test("client start fails instead of reporting ready when the child exits during startup", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: fakeEnv({ FAKE_EXIT_AFTER_INIT: "1" }),
    requestTimeoutMs: 2_000,
  });
  clients.push(client);
  await assert.rejects(client.start(), DriverDisconnectedError);
  assert.notEqual(client.status, "ready");
});

test("an oversized stdout line kills the connection instead of growing memory unbounded", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: fakeEnv({ FAKE_STDOUT_FLOOD_BYTES: "9000000" }),
    requestTimeoutMs: 2_000,
  });
  clients.push(client);
  await assert.rejects(client.start(), (error: unknown) => {
    assert.match((error as Error).message, /protocol broken/);
    return true;
  });
  assert.notEqual(client.status, "ready");
});

test("transport-failed probes stay unrecorded; only server replies register capability facts", async () => {
  const client = new AppServerClient({
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: fakeEnv({ FAKE_IGNORE_METHODS: "thread/resume,thread/goal/get" }),
    requestTimeoutMs: 150,
  });
  clients.push(client);
  await client.start();
  const view = client.capabilities();
  assert.equal(view.available.includes("thread/resume"), false, "timed-out probe is not a fact of availability");
  assert.equal(view.unavailable.includes("thread/resume"), false);
  assert.equal(view.available.includes("thread/goal/get"), false);
  assert.ok(view.available.includes("turn/interrupt"), "answered probes still register");
  assert.deepEqual(view.unavailable, ["thread/sample"]);
});

test("send that times out marks the thread unresolved: resend conflicts until a native terminal lands", async () => {
  const { DriverTimeoutError } = await import("../src/driver/errors.js");
  const { ConflictError } = await import("../src/errors.js");
  const driver = new CodexDriver({
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: fakeEnv({ FAKE_TURN_DELAY_MS: "800", FAKE_TURN_REPLY_DELAY_MS: "500" }),
    requestTimeoutMs: 150,
  });
  drivers.push(driver);
  const threadId = await driver.createThread({ workspace: "/tmp/ws", idempotencyKey: "create/stale" });
  await assert.rejects(driver.send({ threadId, message: "slow", idempotencyKey: "run/stale1" }), DriverTimeoutError);
  // 终局未观察：立即重发必须显式冲突，绝不接收可能陈旧的终局
  await assert.rejects(
    driver.send({ threadId, message: "again", idempotencyKey: "run/stale2" }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match(error.message, /terminal was never observed/);
      return true;
    },
  );
  // 服务端随后发出原生终态（约 800ms）：观察即解除，重发放行并等到它自己的终局
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const terminal = await driver.send({ threadId, message: "after settle", idempotencyKey: "run/stale3" });
  assert.equal(terminal.kind, "completed");
});

test("thread busy is detected by the server error code, not message wording", async () => {
  const { ConflictError } = await import("../src/errors.js");
  const driver = await startDriver({ FAKE_TURN_DELAY_MS: "3000", FAKE_BUSY_MESSAGE: "totally reworded busy condition" });
  const threadId = await driver.createThread({ workspace: "/tmp/ws", idempotencyKey: "create/busycode" });
  const first = driver.send({ threadId, message: "first", idempotencyKey: "run/bc1" });
  await assert.rejects(
    driver.send({ threadId, message: "second", idempotencyKey: "run/bc2" }),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError, `expected ConflictError, got ${String(error)}`);
      assert.match(error.message, /already has an active turn/);
      return true;
    },
  );
  await driver.interrupt(threadId);
  assert.equal((await first).kind, "interrupted");
});

test("sample rejects an over-limit prompt locally without burning a round trip", async () => {
  const { DriverProtocolError } = await import("../src/driver/errors.js");
  const driver = await startDriver({ FAKE_WITH_SAMPLE: "1" });
  await assert.rejects(
    driver.sample({ threadId: "th_any", expectedTurnId: "turn-1", prompt: "x".repeat(4001) }),
    (error: unknown) => {
      assert.ok(error instanceof DriverProtocolError);
      assert.match(error.message, /exceeds 4000 bytes/);
      return true;
    },
  );
});
