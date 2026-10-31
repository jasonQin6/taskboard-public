/**
 * 看板数据层（issue #6 / A31 客户端半边）：对真实 daemon 走公开 HTTP+SSE 缝。
 * 验证：初始收敛、SSE 按域重拉（不推全量快照）、陈旧 revision 忽略、断线重连后全域重拉不丢状态。
 * BoardModel 是框架无关模块（web/src/lib），React 仅作订阅者；这里不经浏览器。
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { ActionError, BoardModel } from "../web/src/lib/board-model.js";

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-board-"));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const boot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-board-"));
  tmpDirs.push(dir);
  const daemon = await startDaemon({ port: 0, dbPath: join(dir, "taskboard.sqlite") });
  daemons.push(daemon);
  return `http://127.0.0.1:${daemon.port}`;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const createTaskViaApi = async (base: string, title: string): Promise<{ id: string }> => {
  const res = await fetch(`${base}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "task.create", requestId: crypto.randomUUID(), title, workspace: "/tmp/ws" }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { task: { id: string } };
  return body.task;
};

test("board model: initial refresh adopts the empty board and per-domain revisions", async () => {
  const base = await boot();
  const model = new BoardModel(base);
  await model.refresh();
  const state = model.getState();
  assert.ok(state !== null);
  assert.deepEqual(state.tasks, []);
  assert.ok(typeof state.revisions.tasks === "number");
  assert.deepEqual(model.getState()?.inbox, []);
  assert.deepEqual(model.getState()?.sessions, []);
  assert.deepEqual(model.getState()?.failures, []);
  model.close();
});

test("board model: SSE revision event triggers domain refetch and converges", async () => {
  const base = await boot();
  const model = new BoardModel(base, { retryMs: 50, refetchDelayMs: 10 });
  await model.refresh();
  model.connectEvents();
  const { id } = await createTaskViaApi(base, "pushed while page open");
  await waitFor(() => model.getState()?.tasks.length === 1);
  assert.equal(model.getState()?.tasks[0]?.id, id);
  model.close();
});

test("board model: stale revision events are ignored, no refetch is issued", async () => {
  const base = await boot();
  let stateFetches = 0;
  const countingFetch: typeof fetch = (input, init) => {
    if (String(input).endsWith("/api/state")) stateFetches += 1;
    return fetch(input, init);
  };
  const model = new BoardModel(base, { fetchImpl: countingFetch, refetchDelayMs: 10 });
  await model.refresh();
  const known = model.getState()!.revisions.tasks;
  assert.ok(typeof known === "number");
  const before = stateFetches;
  model.handleRevisionEvent({ domain: "tasks", revision: known, ids: ["t_x"] });
  model.handleRevisionEvent({ domain: "tasks", revision: Math.max(0, known - 1), ids: ["t_y"] });
  assert.equal(stateFetches, before);
  // 未来 revision 仍必须触发重拉（收敛方向的推进）
  model.handleRevisionEvent({ domain: "tasks", revision: known + 5, ids: ["t_z"] });
  await waitFor(() => stateFetches > before);
  model.close();
});

test("board model: resync after SSE drop restores state written while disconnected", async () => {
  const base = await boot();
  const model = new BoardModel(base, { retryMs: 20, refetchDelayMs: 10 });
  await model.refresh();
  model.connectEvents();
  model.closeEvents();
  await createTaskViaApi(base, "written while offline a");
  await createTaskViaApi(base, "written while offline b");
  assert.equal(model.getState()?.tasks.length, 0);
  // 重连路径：connectEvents 后模型先全域重拉再消费新事件，收敛且不丢已有状态
  model.connectEvents();
  await waitFor(() => model.getState()?.tasks.length === 2);
  const titles = model.getState()!.tasks.map((task) => task.title).sort();
  assert.deepEqual(titles, ["written while offline a", "written while offline b"]);
  model.close();
});

test("board model: coalesces burst events into a single refetch", async () => {
  const base = await boot();
  let stateFetches = 0;
  const countingFetch: typeof fetch = (input, init) => {
    if (String(input).endsWith("/api/state")) stateFetches += 1;
    return fetch(input, init);
  };
  const model = new BoardModel(base, { fetchImpl: countingFetch, refetchDelayMs: 30 });
  await model.refresh();
  const before = stateFetches;
  const known = model.getState()!.revisions.tasks;
  for (let ahead = 1; ahead <= 5; ahead += 1) {
    model.handleRevisionEvent({ domain: "tasks", revision: known + ahead, ids: ["t_burst"] });
  }
  await waitFor(() => stateFetches > before);
  // 去抖窗口内的连续事件只应产生一次重拉（允许计数在去抖定时器触发后恰好 +1）
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(stateFetches, before + 1);
  model.close();
});

test("board model: debounce timer firing while a pull is in flight reruns exactly once (no loss, no dup)", async () => {
  const base = await boot();
  let stateFetches = 0;
  let gateState = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gating: typeof fetch = (input, init) => {
    if (String(input).endsWith("/api/state")) {
      stateFetches += 1;
      if (gateState) return released.then(() => fetch(input, init));
    }
    return fetch(input, init);
  };
  const model = new BoardModel(base, { fetchImpl: gating, refetchDelayMs: 10 });
  await model.refresh();
  assert.equal(stateFetches, 1);
  const known = model.getState()!.revisions.tasks;
  gateState = true;
  // 事件 A：去抖定时器到期发起 pull，被闸门停在在飞
  model.handleRevisionEvent({ domain: "tasks", revision: known + 1, ids: ["t_g1"] });
  await waitFor(() => stateFetches === 2);
  // 事件 B：定时器在 pull#2 仍在飞时到期——并入排队（keep-last），不得并发第三拉
  model.handleRevisionEvent({ domain: "tasks", revision: known + 2, ids: ["t_g2"] });
  await new Promise((resolve) => setTimeout(resolve, 40)); // > refetchDelayMs：定时器必然已到期
  assert.equal(stateFetches, 2);
  release();
  await waitFor(() => stateFetches === 3); // 排队意图出队补跑：不漏拉
  await new Promise((resolve) => setTimeout(resolve, 60)); // 结算窗口：不得再多拉
  assert.equal(stateFetches, 3);
  assert.equal(model.getState()?.lastError ?? null, null);
  model.close();
});

test("board model: runAction posts JSON with requestId and returns the payload", async () => {
  const base = await boot();
  const model = new BoardModel(base);
  const body = (await model.runAction("task.create", { title: "via model", workspace: "/tmp/ws" })) as {
    task: { id: string; title: string };
  };
  assert.equal(body.task.title, "via model");
  await model.refresh();
  assert.equal(model.getState()?.tasks.length, 1);
  model.close();
});

test("board model: close+connect during reconnect sleep must not revive the old loop as a second SSE stream", async () => {
  const base = await boot();
  let eventFetches = 0;
  let failNextEvents = true;
  const gatingFetch: typeof fetch = (input, init) => {
    if (String(input).endsWith("/api/events")) {
      eventFetches += 1;
      if (failNextEvents) {
        failNextEvents = false;
        return Promise.reject(new TypeError("simulated network failure"));
      }
      return new Promise(() => {}); // 挂起：新循环持有连接不再放手
    }
    return fetch(input, init);
  };
  const model = new BoardModel(base, { fetchImpl: gatingFetch, retryMs: 80, refetchDelayMs: 10 });
  await model.refresh();
  model.connectEvents();
  await waitFor(() => eventFetches === 1);
  // 旧循环此刻停在重连 sleep 窗口内；close+connect 会把 eventsWanted 重新置真
  model.closeEvents();
  model.connectEvents();
  await waitFor(() => eventFetches === 2);
  // 旧循环 sleep 到期：僵尸循环复活会在这里开出第三条 /api/events
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(eventFetches, 2);
  model.close();
});

test("board model: pull failures land in BoardState.lastError and clear on recovery", async () => {
  const base = await boot();
  let failState = false;
  const flaky: typeof fetch = (input, init) => {
    if (failState && String(input).endsWith("/api/state")) {
      return Promise.resolve(new Response("boom", { status: 503 }));
    }
    return fetch(input, init);
  };
  const model = new BoardModel(base, { fetchImpl: flaky, refetchDelayMs: 10 });
  await model.refresh();
  assert.equal(model.getState()?.lastError ?? null, null);
  // 死载荷 summaries/annotations 不再进状态（防契约漂移无人察觉）
  assert.equal((model.getState() as unknown as Record<string, unknown>).summaries, undefined);
  assert.equal((model.getState() as unknown as Record<string, unknown>).annotations, undefined);

  failState = true;
  const known = model.getState()!.revisions.tasks;
  model.handleRevisionEvent({ domain: "tasks", revision: known + 3, ids: ["t_err"] });
  await waitFor(() => model.getState()?.lastError !== null);
  assert.ok(String(model.getState()?.lastError).includes("503"));

  failState = false;
  model.handleRevisionEvent({ domain: "tasks", revision: known + 4, ids: ["t_err"] });
  await waitFor(() => model.getState()?.lastError === null);
  model.close();
});

test("board model: non-JSON action error body surfaces as ActionError with the HTTP status", async () => {
  const base = await boot();
  const proxy: typeof fetch = (input, init) => {
    if (String(input).endsWith("/api/actions")) {
      return Promise.resolve(
        new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
      );
    }
    return fetch(input, init);
  };
  const model = new BoardModel(base, { fetchImpl: proxy });
  await assert.rejects(
    model.runAction("task.create", { title: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof ActionError, `expected ActionError, got ${String(error)}`);
      assert.equal((error as ActionError).status, 502);
      assert.ok((error as Error).message.includes("502"));
      return true;
    },
  );
  model.close();
});
