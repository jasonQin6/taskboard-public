/**
 * HTTP 面：state/detail 契约、CSRF 基线（A27）、代理栅栏四分支（A28）、动作幂等、SSE 只广播 domain/revision/ids（A31 的服务端半边）。
 * 直接装配 createHttpServer + 临时库，不经 daemon 锁；收尾 shutdown() 内含 closeAllConnections。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { get as httpGet, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { assembleProxyGuard } from "../src/http-guard.js";
import { checkCsrf, createHttpServer, type TaskboardHttp } from "../src/http.js";
import { SingleFlightRegistry } from "../src/single-flight.js";
import {
  API_PREFIX,
  API_ROUTES,
  taskDetailRoute,
  threadDetailRoute,
  THREAD_SUBRESOURCE_KINDS,
  THREAD_SUBRESOURCE_ROUTES,
} from "../src/routes.js";
import { Store } from "../src/store/index.js";
import { stateView, type ViewContext } from "../src/views.js";

const tmpDirs: string[] = [];
const servers: TaskboardHttp[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.shutdown();
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface Harness {
  store: Store;
  port: number;
  base: string;
}

const boot = async (options: { proxy?: { hosts: string[]; token?: string }; now?: () => number } = {}): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-http-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "taskboard.sqlite");
  const { db } = await openStateDb(dbPath);
  const store = new Store(db, { now: options.now });
  const singleFlight = new SingleFlightRegistry();
  const views: ViewContext = {
    store,
    singleFlight,
    runtime: () => ({
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      powerProtection: "off",
      proxyGuard: options.proxy !== undefined,
      driver: { available: false, note: "test" },
    }),
  };
  const proxyGuard =
    options.proxy === undefined
      ? undefined
      : assembleProxyGuard({
          trustedProxyHosts: options.proxy.hosts,
          ...(options.proxy.token !== undefined ? { proxyToken: options.proxy.token } : {}),
        });
  const http = createHttpServer({
    store,
    views,
    dbPath,
    ...(proxyGuard !== undefined ? { proxyGuard } : {}),
  });
  servers.push(http);
  const port = await new Promise<number>((resolve) => {
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return { store, port, base: `http://127.0.0.1:${port}` };
};

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const getJson = async (base: string, path: string, headers: Record<string, string> = {}): Promise<JsonResponse> => {
  const response = await fetch(`${base}${path}`, { headers });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const post = async (
  base: string,
  body: unknown,
  headers: Record<string, string> = {},
  raw?: string,
): Promise<JsonResponse> => {
  const response = await fetch(`${base}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** fetch 会丢弃自定义 Host 头：Host 相关用例走原始 http.request。 */
const rawPost = (port: number, headers: Record<string, string>, body: string): Promise<JsonResponse> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/actions",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
        agent: false,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Record<string, unknown> }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });

let requestCounter = 0;
const action = (type: string, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  type,
  requestId: `req-${process.pid}-${requestCounter++}`,
  ...fields,
});

test("GET /api/state exposes revisions, collections (empty when unsourced) and runtime", async () => {
  const { base } = await boot();
  const { status, body } = await getJson(base, "/api/state");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.revisions, { tasks: 0, threads: 0, config: 0 });
  for (const key of ["tasks", "threads", "inbox", "sessions", "failures", "summaries", "proposals", "annotations"]) {
    assert.deepEqual(body[key], [], `${key} must be an empty collection`);
  }
  const runtime = body.runtime as Record<string, unknown>;
  assert.equal(runtime.automationPaused, false);
  assert.equal(runtime.concurrencyLimit, 2);
  assert.equal(runtime.activeRuns, 0);
  assert.equal(runtime.inFlightWrites, 0);
  assert.equal(runtime.powerProtection, "off");
  assert.deepEqual(runtime.scan, {
    phase: "unavailable",
    sources: 0,
    anomalies: 0,
    filesTotal: 0,
    filesDone: 0,
    lastCompletedAt: null,
  });
  assert.equal((runtime.driver as { available: boolean }).available, false);
});

test("CSRF baseline: non-JSON POST, cross-site Origin, null Origin and foreign Host are rejected; loopback passes", async () => {
  const { base, port } = await boot();
  const body = JSON.stringify(action("automation.pause"));
  // 表单 POST（浏览器简单请求）→ 415
  const form = await fetch(`${base}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "type=automation.pause",
  });
  assert.equal(form.status, 415);
  // 跨站 Origin → 403
  const cross = await post(base, null, { origin: "https://evil.example" }, body);
  assert.equal(cross.status, 403);
  assert.match(String(cross.body.error), /cross-site/);
  const nullOrigin = await post(base, null, { origin: "null" }, body);
  assert.equal(nullOrigin.status, 403);
  // 无 Origin 但 Host 被 DNS rebinding 改写 → 403
  const rebinding = await rawPost(port, { host: "evil.example" }, body);
  assert.equal(rebinding.status, 403);
  assert.match(String(rebinding.body.error), /host not allowed/);
  // 同源 Origin（127.0.0.1 / localhost / [::1]）→ 通过
  for (const origin of [`http://127.0.0.1:${port}`, "http://localhost:3000", "http://[::1]:8080"]) {
    const ok = await post(base, action("automation.pause"), { origin });
    assert.equal(ok.status, 200, `origin ${origin} must pass`);
  }
  // 无 Origin + 回环 Host（CLI/fetch 的形态）→ 通过
  const cli = await post(base, action("automation.resume"));
  assert.equal(cli.status, 200);
  assert.equal(cli.body.automationPaused, false);
});

test("checkCsrf accepts explicitly allowed hosts for reverse-proxy setups", () => {
  assert.equal(
    checkCsrf({ "content-type": "application/json", host: "board.internal:8443" }, ["board.internal"]).ok,
    true,
  );
  assert.equal(checkCsrf({ "content-type": "application/json", host: "board.internal" }).ok, false);
  assert.equal(
    checkCsrf({ "content-type": "application/json; charset=utf-8", origin: "https://board.internal" }, [
      "board.internal",
    ]).ok,
    true,
  );
});

test("actions: create/move/archive/unarchive/delete through the unified entry; detail endpoint", async () => {
  const { base } = await boot();
  const created = await post(base, action("task.create", { title: "A", prompt: "p", workspace: "/tmp/ws", labels: ["x"] }));
  assert.equal(created.status, 201);
  const task = created.body.task as Record<string, unknown>;
  assert.equal(task.status, "todo");
  assert.equal(task.archived, false);
  assert.deepEqual(task.labels, ["x"]);
  assert.equal(task.lastRun, null);
  assert.equal(task.activeRun, null);
  assert.equal(task.primaryThreadId, null);
  assert.deepEqual(task.badges, []);
  assert.equal(task.summaryStatus, "none");
  const id = task.id as string;

  const moved = await post(base, action("task.move", { taskId: id, status: "done" }));
  assert.equal((moved.body.task as { status: string }).status, "done");
  const badMove = await post(base, action("task.move", { taskId: id, status: "doing" }));
  assert.equal(badMove.status, 400);

  const archived = await post(base, action("task.archive", { taskId: id }));
  assert.equal((archived.body.task as { archived: boolean }).archived, true);
  const unarchived = await post(base, action("task.unarchive", { taskId: id }));
  assert.equal((unarchived.body.task as { archived: boolean }).archived, false);

  const detail = await getJson(base, `/api/tasks/${id}`);
  assert.equal(detail.status, 200);
  const detailTask = detail.body.task as Record<string, unknown>;
  assert.deepEqual(detailTask.runs, []);
  assert.deepEqual(detailTask.threads, []);
  assert.deepEqual(detailTask.children, []);
  assert.equal(detailTask.inFlightWrite, false);

  const child = await post(base, action("task.create", { title: "child", parentId: id }));
  assert.equal(child.status, 201);
  const deleted = await post(base, action("task.delete", { taskId: id }));
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.deleted, {
    id,
    danglingChildren: [(child.body.task as { id: string }).id],
    unboundThreads: [],
  });
  assert.equal((await getJson(base, `/api/tasks/${id}`)).status, 404);
});

test("idempotency: same requestId replays the stored response; reuse for another type is 409; missing is 400", async () => {
  const { base, store } = await boot();
  const payload = action("task.create", { title: "once" });
  const first = await post(base, payload);
  const second = await post(base, payload);
  assert.equal(second.status, 201);
  assert.deepEqual(second.body, first.body);
  assert.equal(store.listTasks().length, 1);
  const clash = await post(base, { ...payload, type: "automation.pause" });
  assert.equal(clash.status, 409);
  const missing = await post(base, { type: "automation.pause" });
  assert.equal(missing.status, 400);
  assert.match(String(missing.body.error), /requestId/);
});

test("unassembled capabilities fail loudly with 501 and name the missing runtime; unknown types are 400", async () => {
  const { base } = await boot();
  const run = await post(base, action("run.create", { taskId: "t_x" }));
  assert.equal(run.status, 501);
  assert.match(String(run.body.error), /harness driver runtime/);
  // 裸装配下 run.* 明确 501；这里钉 501 与未知类型
  const unknown = await post(base, action("task.explode"));
  assert.equal(unknown.status, 400);
  const badJson = await post(base, null, {}, "{not json");
  assert.equal(badJson.status, 400);
});

test("automation pause/resume persists in settings and bumps the config revision only", async () => {
  const { base } = await boot();
  const paused = await post(base, action("automation.pause"));
  assert.equal(paused.body.automationPaused, true);
  let state = await getJson(base, "/api/state");
  assert.equal((state.body.runtime as { automationPaused: boolean }).automationPaused, true);
  assert.deepEqual(state.body.revisions, { tasks: 0, threads: 0, config: 1 });
  await post(base, action("automation.resume"));
  state = await getJson(base, "/api/state");
  assert.equal((state.body.runtime as { automationPaused: boolean }).automationPaused, false);
  const bad = await post(base, action("settings.update", { settings: { bogus: 1 } }));
  assert.equal(bad.status, 400);
});

test("SSE broadcasts only {domain, revision, ids[]} frames", async () => {
  const { base, port } = await boot();
  const frames: string[] = [];
  const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: "/api/events" }, resolve);
    req.on("error", reject);
  });
  assert.equal(stream.headers["content-type"], "text/event-stream; charset=utf-8");
  stream.setEncoding("utf8");
  let buffer = "";
  const gotFrame = new Promise<void>((resolve) => {
    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (part.startsWith("event: revision")) {
          frames.push(part);
          resolve();
        }
      }
    });
  });
  const created = await post(base, action("task.create", { title: "sse" }));
  await gotFrame;
  const data = JSON.parse(frames[0]!.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(data, { domain: "tasks", revision: 1, ids: [(created.body.task as { id: string }).id] });
  assert.deepEqual(Object.keys(data).sort(), ["domain", "ids", "revision"]);
  stream.destroy();
});

test("proxy guard off: behaviour equals bare loopback; on: write face needs trusted source + token, read face loopback passes", async () => {
  // 开栅栏且 127.0.0.1 受信 + 令牌：读面放行、写面缺令牌 401、错令牌 401、对令牌通过
  const guarded = await boot({ proxy: { hosts: ["127.0.0.1"], token: "s3cret" } });
  assert.equal((await getJson(guarded.base, "/api/state")).status, 200);
  assert.equal((await post(guarded.base, action("automation.pause"))).status, 401);
  assert.equal((await post(guarded.base, action("automation.pause"), { "x-taskboard-token": "nope" })).status, 401);
  const ok = await post(guarded.base, action("automation.pause"), { "x-taskboard-token": "s3cret" });
  assert.equal(ok.status, 200);
  // 受信列表不含回环：写面本机也被拒（同机反代与本机来源不可区分），读面仍放行
  const remoteOnly = await boot({ proxy: { hosts: ["10.0.0.0/8"], token: "s3cret" } });
  assert.equal((await getJson(remoteOnly.base, "/api/state")).status, 200);
  const untrusted = await post(remoteOnly.base, action("automation.pause"), { "x-taskboard-token": "s3cret" });
  assert.equal(untrusted.status, 403);
  // 栅栏关：无令牌直接通过（与裸 loopback 一致）
  const bare = await boot();
  assert.equal((await post(bare.base, action("automation.pause"))).status, 200);
  assert.equal((await getJson(bare.base, "/api/state")).status, 200);
});

test("card badges: interrupted and external_activity derive from the primary thread, not columns", async () => {
  const { base, store } = await boot();
  const created = await post(base, action("task.create", { title: "b", workspace: "/tmp/ws" }));
  const id = (created.body.task as { id: string }).id;
  // 主绑定 fixture：此处用底层数据库造 primary 绑定（绑定写面经 Store）
  const bindPrimary = (nativeStatus: string): void => {
    store.upsertThread({ id: "th_b", harnessId: CODEX_HARNESS_ID, nativeStatus: nativeStatus as never, lastActivityAt: store.now() });
    store.db
      .prepare("INSERT OR REPLACE INTO task_threads (task_id, thread_id, role, bound_at) VALUES (?, ?, 'primary', ?)")
      .run(id, "th_b", store.now());
  };
  const badges = async (): Promise<string[]> => {
    const detail = await getJson(base, `/api/tasks/${id}`);
    return (detail.body.task as { badges: string[] }).badges;
  };
  // Run 取消 + thread 仍在原生 running：只亮外部活动徽标，任务列不被拉回 running
  const run = store.createRun(id, "manual");
  bindPrimary("running");
  store.finishRun(run.id, "cancelled");
  const card = store.getTask(id)!;
  assert.equal(card.status, "todo");
  assert.deepEqual(await badges(), ["external_activity"]);
  // interrupted：只作徽标，不进 failed
  store.db.prepare("UPDATE threads SET native_status = 'interrupted' WHERE id = 'th_b'").run();
  assert.deepEqual(await badges(), ["interrupted"]);
});

test("read endpoints: db path, proposals, annotations, thread 404 and empty pages", async () => {
  const { base, store } = await boot();
  const dbPath = await getJson(base, "/api/db/path");
  assert.equal(dbPath.body.ok, true);
  assert.match(String(dbPath.body.path), /taskboard\.sqlite$/);
  assert.deepEqual((await getJson(base, "/api/proposals")).body, { ok: true, proposals: [] });
  const task = store.createTask({
    title: "n",
    prompt: "",
    workspace: null,
    status: "todo",
    labels: [],
    source: "manual",
    acceptanceCriteria: "",
    acceptanceMode: "human",
    automationMode: "suggest",
    workspaceMode: "current",
    parentId: null,
    subtasksPolicy: null,
    idleThresholdMs: null,
    cron: null,
    tz: null,
    goalEnabled: false,
    goalBudgetTokens: null,
  });
  store.addAnnotation({ taskId: task.id, kind: "note", body: "hello" });
  const notes = await getJson(base, `/api/annotations?taskId=${task.id}`);
  assert.equal((notes.body.annotations as unknown[]).length, 1);
  assert.equal((await getJson(base, "/api/threads/nope")).status, 404);
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: Date.now() });
  assert.deepEqual((await getJson(base, "/api/threads/th_1/turns")).body, { ok: true, items: [], nextCursor: null });
  assert.equal((await getJson(base, "/api/nope")).status, 404);
});

test("thread.bind/unbind/ignore/unignore go live: inbox immediate effect and primary conflict is 409", async () => {
  // 冻结时钟：断言里 new Date(store.now()) 必须与 store 内部落库时间戳逐毫秒一致
  const { base, store } = await boot({ now: () => Date.parse("2026-10-21T10:00:00.000Z") });
  const created = await post(base, action("task.create", { title: "B", prompt: "p", workspace: "/tmp/ws" }));
  const taskId = (created.body.task as { id: string }).id;
  store.upsertThread({ id: "th_bind", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", title: "session", lastActivityAt: store.now() });

  const inboxBefore = await getJson(base, "/api/state");
  assert.deepEqual(inboxBefore.body.inbox, [{ id: "th_bind", nativeStatus: "idle", title: "session", lastActivityAt: new Date(store.now()).toISOString(), firstSeenAt: new Date(store.now()).toISOString(), ignored: false, primaryTaskId: null, goalStatus: null }]);

  const bound = await post(base, action("thread.bind", { taskId, threadId: "th_bind" }));
  assert.equal(bound.status, 200);
  assert.equal(bound.body.ok, true);
  assert.deepEqual(bound.body.binding, { taskId, threadId: "th_bind", role: "primary", boundAt: new Date(store.now()).toISOString() });
  assert.equal((bound.body.thread as { primaryTaskId: string | null }).primaryTaskId, taskId);
  assert.equal((bound.body.task as { primaryThreadId: string | null }).primaryThreadId, "th_bind");
  assert.deepEqual((await getJson(base, "/api/state")).body.inbox, []);

  // 一个 thread 不能成为两个 Task 的 primary：409，且从属角色允许另挂证据链
  const second = await post(base, action("task.create", { title: "C", prompt: "p" }));
  const secondId = (second.body.task as { id: string }).id;
  const clash = await post(base, action("thread.bind", { taskId: secondId, threadId: "th_bind" }));
  assert.equal(clash.status, 409);
  assert.match(String(clash.body.error), /primary/);
  const derived = await post(base, action("thread.bind", { taskId: secondId, threadId: "th_bind", role: "evidence_for" }));
  assert.equal(derived.status, 200);
  assert.equal((derived.body.thread as { primaryTaskId: string | null }).primaryTaskId, taskId);

  // 解绑 primary：thread 回 Inbox（从属绑定不拦）
  const unbound = await post(base, action("thread.unbind", { taskId, threadId: "th_bind" }));
  assert.equal(unbound.status, 200);
  assert.equal((unbound.body.thread as { primaryTaskId: string | null }).primaryTaskId, null);
  assert.deepEqual((await getJson(base, "/api/state")).body.inbox.map((thread: { id: string }) => thread.id), ["th_bind"]);
  const notBound = await post(base, action("thread.unbind", { taskId, threadId: "th_bind" }));
  assert.equal(notBound.status, 404);

  // 忽略与恢复立即生效（A3）
  const ignored = await post(base, action("thread.ignore", { threadId: "th_bind" }));
  assert.equal(ignored.status, 200);
  assert.equal((ignored.body.thread as { ignored: boolean }).ignored, true);
  assert.deepEqual((await getJson(base, "/api/state")).body.inbox, []);
  const unignored = await post(base, action("thread.unignore", { threadId: "th_bind" }));
  assert.equal(unignored.status, 200);
  assert.equal((unignored.body.thread as { ignored: boolean }).ignored, false);
  assert.deepEqual((await getJson(base, "/api/state")).body.inbox.map((thread: { id: string }) => thread.id), ["th_bind"]);
});

test("GET /api/threads/:id returns thread detail: native status, bindings, lineage, latest turn, summary entry", async () => {
  const { base, store } = await boot({ now: () => Date.parse("2026-10-21T10:00:00.000Z") });
  const created = await post(base, action("task.create", { title: "D", prompt: "p", workspace: "/tmp/ws" }));
  const taskId = (created.body.task as { id: string }).id;
  store.upsertThread({ id: "th_det", harnessId: CODEX_HARNESS_ID, nativeStatus: "running", title: "detail thread", lastActivityAt: store.now() });
  store.bindThread(taskId, "th_det");
  store.db
    .prepare("INSERT INTO thread_turns (id, thread_id, ordinal, native_status, started_at, ended_at, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("turn_1", "th_det", 0, "completed", store.now() - 1000, store.now(), "src_1");
  store.db
    .prepare("INSERT INTO thread_summaries (id, thread_id, provenance, text, source_ref, created_at) VALUES (?, ?, 'compacted', ?, NULL, ?)")
    .run("sm_det", "th_det", "compacted summary", store.now());
  store.db
    .prepare("INSERT INTO thread_lineage (thread_id, parent_thread_id, relation, created_at) VALUES (?, ?, ?, ?)")
    .run("th_det", "th_parent", "fork", store.now());
  store.db
    .prepare("INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal, kind, summary, props, superseded, created_at) VALUES (?, ?, ?, 0, ?, NULL, 'user_message', ?, NULL, 0, ?)")
    .run("ev_det", "th_det", "src_1", "hash1", "hello", store.now());

  const missing = await getJson(base, "/api/threads/th_missing");
  assert.equal(missing.status, 404);
  const detail = await getJson(base, "/api/threads/th_det");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.ok, true);
  const thread = detail.body.thread as Record<string, unknown>;
  assert.deepEqual(Object.keys(thread).sort(), [
    "bindings", "evidenceCount", "firstSeenAt", "goalStatus", "harnessId", "id", "ignored", "lastActivityAt",
    "latestTurn", "lineage", "locator", "nativeSessionId", "nativeStatus", "primaryTaskId", "progressVerdict",
    "semanticStatus", "summary", "title", "turnCount",
  ]);
  assert.equal(thread.nativeStatus, "running");
  assert.deepEqual(thread.bindings, [{ taskId, threadId: "th_det", role: "primary", boundAt: new Date(store.now()).toISOString() }]);
  // (th_det, th_parent) 边从 th_det 视角是 parent 边；children 列的是以 th_det 为 parent 的边
  assert.deepEqual(thread.lineage, {
    parents: [{ threadId: "th_det", parentThreadId: "th_parent", relation: "fork", createdAt: new Date(store.now()).toISOString() }],
    children: [],
  });
  assert.equal(thread.turnCount, 1);
  assert.equal(thread.evidenceCount, 1);
  assert.deepEqual(thread.latestTurn, {
    id: "turn_1",
    threadId: "th_det",
    ordinal: 0,
    nativeStatus: "completed",
    startedAt: new Date(store.now() - 1000).toISOString(),
    endedAt: new Date(store.now()).toISOString(),
    sourceRef: "src_1",
    locator: { sourceRef: "src_1", sourcePath: null, byteStart: null, recordHash: null, kind: null },
  });
  assert.deepEqual(thread.summary, {
    provenance: "compacted",
    text: "compacted summary",
    createdAt: new Date(store.now()).toISOString(),
    superseded: false,
    locator: {
      sourceRef: null,
      sourceId: null,
      sourcePath: null,
      byteStart: null,
      recordHash: null,
      coveredThroughTurnOrdinal: null,
    },
  });
  // 本装配未注入 SystemOne：入口存在但值恒 null
  assert.equal(thread.semanticStatus, null);
  assert.equal(thread.progressVerdict, null);
});

test("thread summaries project a superseded row without any stale top-level locator fields", async () => {
  const { base, store } = await boot();
  store.upsertThread({ id: "th_superseded", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.db
    .prepare(
      `INSERT INTO thread_summaries (
         id, thread_id, provenance, text, source_ref, source_id, byte_start, record_hash,
         covered_through_turn_ordinal, superseded, created_at
       ) VALUES (?, ?, 'compacted', ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      "sm_superseded",
      "th_superseded",
      "removed compaction",
      "hash_removed",
      "src_removed",
      41,
      "hash_removed",
      7,
      store.now(),
    );

  const response = await getJson(base, "/api/threads/th_superseded/summaries");
  assert.equal(response.status, 200);
  const item = (response.body.items as Array<Record<string, unknown>>)[0]!;
  assert.equal(item.locator, null);
  assert.deepEqual(
    {
      sourceRef: item.sourceRef,
      sourceId: item.sourceId,
      byteStart: item.byteStart,
      recordHash: item.recordHash,
      coveredThroughTurnOrdinal: item.coveredThroughTurnOrdinal,
    },
    {
      sourceRef: null,
      sourceId: null,
      byteStart: null,
      recordHash: null,
      coveredThroughTurnOrdinal: null,
    },
  );
});

test("A30 full flow: deleting the task removes it from the board, keeps children, and threads return to the inbox", async () => {
  const { base, store } = await boot({ now: () => Date.parse("2026-10-21T10:00:00.000Z") });
  const parent = await post(base, action("task.create", { title: "P", prompt: "p", workspace: "/tmp/ws" }));
  const parentId = (parent.body.task as { id: string }).id;
  const child = await post(base, action("task.create", { title: "ch", parentId }));
  const childId = (child.body.task as { id: string }).id;
  store.upsertThread({ id: "th_orphan", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: store.now() });
  await post(base, action("thread.bind", { taskId: parentId, threadId: "th_orphan" }));
  assert.deepEqual((await getJson(base, "/api/state")).body.inbox, []);

  const deleted = await post(base, action("task.delete", { taskId: parentId }));
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.body.deleted, { id: parentId, danglingChildren: [childId], unboundThreads: ["th_orphan"] });
  assert.equal((await getJson(base, `/api/tasks/${parentId}`)).status, 404);
  assert.equal((await getJson(base, `/api/tasks/${childId}`)).status, 200);
  const state = await getJson(base, "/api/state");
  assert.deepEqual(state.body.inbox.map((thread: { id: string }) => thread.id), ["th_orphan"]);
});

test("GET /api (no trailing slash) is the API domain: JSON 404, never the SPA fallback", async () => {
  const { writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "tb-http-apibare-"));
  tmpDirs.push(dir);
  await writeFile(join(dir, "index.html"), "<html>spa</html>");
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const store = new Store(db);
  const views = { store, runtime: () => ({}) } as unknown as ViewContext;
  const http = createHttpServer({ store, views, dbPath: join(dir, "x.sqlite"), webDir: dir });
  servers.push(http);
  const port = await new Promise<number>((resolve) => {
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}/api`);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type")?.includes("application/json"), true, "API 域恒 JSON");
  assert.equal(body.ok, false, "API 客户端要拿到 JSON 错误而不是 index.html");
});

test("?limit= (present but empty) falls back to the default page size instead of clamping to 1", async () => {
  const { base, store } = await boot();
  store.upsertThread({ id: "th-limit", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  for (const turnId of ["t1", "t2", "t3"]) {
    store.commitSourceScan({
      source: {
        sourceId: `src-${turnId}`,
        path: `/tmp/${turnId}.jsonl`,
        threadId: "th-limit",
        inode: 1,
        size: 1,
        mtime: 1,
        consumedBytes: 1,
        prefixHash: "p",
        tailHash: null,
        nextOrdinal: 1,
        parserVersion: 1,
        rewritten: false,
      },
      threads: [],
      turns: [{ id: turnId, threadId: "th-limit", ordinal: Number(turnId.slice(1)) - 1, nativeStatus: "completed", startedAt: null, endedAt: null, sourceRef: `src-${turnId}` }],
      evidence: [],
      supersedeEvidence: false,
      rebuildTurns: false,
      anomalies: [],
      resolveAnomalies: false,
      summaries: [],
      lineage: [],
    });
  }
  const { body } = await getJson(base, "/api/threads/th-limit/turns?limit=");
  assert.equal((body.items as unknown[]).length, 3, "空串 limit 回默认页宽（≥3），不钳成 1 条/页");
  assert.equal(body.nextCursor, null);
});

test("/summaries responses carry nextCursor:null to match the shared page contract shape", async () => {
  const { base, store } = await boot();
  store.upsertThread({ id: "th-sum", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.addThreadSummary({ threadId: "th-sum", provenance: "compacted", text: "baseline" });
  const { body } = await getJson(base, "/api/threads/th-sum/summaries");
  assert.equal(body.ok, true);
  assert.ok(Array.isArray(body.items));
  assert.equal(body.nextCursor, null, "全量列表贴合 {ok, items, nextCursor} 页面契约形状");
});

test("concurrent duplicate requestIds share the first execution instead of double-running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tb-http-claim-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const store = new Store(db);
  let goalCalls = 0;
  const slowGoals = {
    executeGoalOp: async (): Promise<Record<string, unknown>> => {
      goalCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { taskId: "t1", threadId: "th1", op: "status", goalStatus: null, text: null };
    },
  } as unknown as ConstructorParameters<typeof createHttpServer>[0]["goals"];
  const views = { store, runtime: () => ({}) } as unknown as ViewContext;
  const http = createHttpServer({ store, views, dbPath: join(dir, "x.sqlite"), goals: slowGoals });
  servers.push(http);
  const port = await new Promise<number>((resolve) => {
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const fire = (): Promise<JsonResponse> =>
    post(base, { type: "goal.status", taskId: "t1", requestId: "claim-dup-1" });
  const [a, b] = await Promise.all([fire(), fire()]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, `并发同 id 请求共享首次执行，不做一半后 500：${JSON.stringify(b.body)}`);
  assert.equal(goalCalls, 1, `副作用只发生一次（got ${goalCalls}）`);
  const replay = await fire();
  assert.deepEqual(replay.body, a.body, "结束后仍走幂等环缓存");
});

test("a failing static read returns 500 instead of escaping as an unhandled rejection", async () => {
  const { chmod, mkdir, writeFile } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "tb-http-static-"));
  tmpDirs.push(dir);
  await mkdir(dir, { recursive: true });
  const entry = join(dir, "index.html");
  await writeFile(entry, "<html></html>");
  await chmod(entry, 0o000);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const store = new Store(db);
  const views = { store, runtime: () => ({}) } as unknown as ViewContext;
  const logged: string[] = [];
  const http = createHttpServer({
    store,
    views,
    dbPath: join(dir, "x.sqlite"),
    webDir: dir,
    onLog: (event) => logged.push(String(event.event)),
  });
  servers.push(http);
  const port = await new Promise<number>((resolve) => {
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 500, "静态读失败以 500 收口，不悬挂也不崩 daemon");
  assert.ok(logged.includes("static_serve_failed"), "失败经 onLog 留痕");
  await chmod(entry, 0o644);
});

// ---- 路由单源（issue #35）：routes.ts 声明面 ↔ 实际分发对齐 ----

test("routes 声明面与实际分发对齐：声明的每条路由都被处理（非 not-found），未声明路径 404", async () => {
  const { store, base } = await boot();
  store.upsertThread({ id: "th-routes", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", title: "routes", lastActivityAt: store.now() });

  // 固定 GET 读面：从 routes 声明面驱动（减去 actions/events 两个非 GET 读面），
  // routes 新增声明而 http 分发未接线时在此变红
  const nonReadRoutes = new Set<string>([API_ROUTES.actions, API_ROUTES.events]);
  for (const path of Object.values(API_ROUTES)) {
    if (nonReadRoutes.has(path)) continue;
    const { status, body } = await getJson(base, path);
    assert.notEqual(status, 404, `GET ${path} 已在 routes.ts 声明，不得 404`);
    assert.equal(status, 200, `GET ${path} → ${status}: ${JSON.stringify(body)}`);
  }

  // POST 写面入口：声明的入口把未知动作以 400 收口（区分于 not-found 404）
  const unknownAction = await post(base, { type: "no.such.action" });
  assert.equal(unknownAction.status, 400, "actions 入口收口未知动作为 400，而非 not-found");

  // SSE 特判路由：声明的 events 路径必须进入事件流（text/event-stream），而不是 404
  await new Promise<void>((resolve, reject) => {
    const req = httpGet(`${base}${API_ROUTES.events}`, (res) => {
      try {
        assert.equal(res.statusCode, 200);
        assert.ok(String(res.headers["content-type"]).includes("text/event-stream"), "events 走 SSE 特判");
        res.destroy();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });

  // 参数化路由：真实资源逐条命中（task 详情、线程详情与三个子资源）
  const created = await post(base, action("task.create", { title: "routes", workspace: "/tmp/ws" }));
  const taskId = (created.body.task as { id: string }).id;
  const taskHit = await getJson(base, taskDetailRoute.path({ taskId }));
  assert.equal(taskHit.status, 200);
  assert.equal((taskHit.body.task as { id: string }).id, taskId);
  const taskMiss = await getJson(base, taskDetailRoute.path({ taskId: "t_nope" }));
  assert.equal(taskMiss.status, 404, "pattern 命中而资源缺失：404 task not found（区别于路由不存在）");
  assert.equal(taskMiss.body.error, "task not found");
  const threadHit = await getJson(base, threadDetailRoute.path({ threadId: "th-routes" }));
  assert.equal(threadHit.status, 200);
  for (const kind of THREAD_SUBRESOURCE_KINDS) {
    const page = await getJson(base, THREAD_SUBRESOURCE_ROUTES[kind].path({ threadId: "th-routes" }));
    assert.equal(page.status, 200, `子资源 ${kind} 命中`);
    assert.equal(page.body.ok, true);
  }

  // 反向：未在 routes 声明的 API 路径必须 404（分发不得超出声明面）
  const undeclared = await getJson(base, `${API_PREFIX}/frobnicate`);
  assert.equal(undeclared.status, 404);
  assert.equal(undeclared.body.error, "not found");

  // thread 域未知子段：路由不存在（"not found"），区别于 pattern 命中而资源缺失（"thread not found"）——
  // 钉住锚定语义：defineRoute 丢 ^...$ 或 :name 放宽为跨段时，这里从路由 404 漂成资源 404/误吞 200
  const unknownSub = await getJson(base, `${threadDetailRoute.path({ threadId: "th-routes" })}/bogus`);
  assert.equal(unknownSub.status, 404);
  assert.equal(unknownSub.body.error, "not found");
  const extraTurns = await getJson(base, `${THREAD_SUBRESOURCE_ROUTES.turns.path({ threadId: "th-routes" })}/extra`);
  assert.equal(extraTurns.status, 404);
  assert.equal(extraTurns.body.error, "not found");
});

test("畸形百分号编码（截断 UTF-8）按不匹配收口 404，不把 URIError 抛出请求 handler 崩进程（ocr 复审）", async () => {
  const { base } = await boot();
  const malformed = await getJson(base, "/api/threads/%E0%A4%A");
  assert.equal(malformed.status, 404);
  assert.equal(malformed.body.error, "not found");
  // 进程仍存活：后续请求正常应答
  const alive = await getJson(base, "/api/state");
  assert.equal(alive.status, 200);
});

test("stateView 按 threads revision 记忆化 observe：同 revision 复用快照，revision 推进后重查", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tb-http-memo-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const store = new Store(db);
  let observeCalls = 0;
  const views = {
    store,
    singleFlight: { count: () => 0 },
    runtime: () => ({}),
    harnesses: {
      capabilityManifests: () => [],
      observe: () => {
        observeCalls += 1;
        return {
          sessions: [],
          failures: [
            {
              code: "source_unreadable",
              message: "not json",
              scope: { kind: "source", harnessId: CODEX_HARNESS_ID, sourceId: "/tmp/rollout-broken.jsonl" },
              retryable: true,
            },
          ],
        };
      },
    },
    sessionCache: { threadsRevision: -1, sessions: [], failures: [] },
  } as unknown as ViewContext;
  const first = stateView(views);
  assert.equal(observeCalls, 1);
  const second = stateView(views);
  assert.equal(observeCalls, 1, "同 threads revision 命中缓存，不重查 observe");
  assert.deepEqual(second.sessions, first.sessions);
  assert.deepEqual(second.failures, first.failures, "缓存命中的 sessions/failures 与首查深相等");
  store.write((touch) => touch("threads"));
  stateView(views);
  assert.equal(observeCalls, 2, "threads revision 推进后缓存失效并重查");
});
