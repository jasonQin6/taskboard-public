/**
 * 工具契约快照：每个 `--json` 子命令的字段集合与类型稳定，不钉动态值（id/时间戳）。
 * V2 契约从零重建，不承诺兼容 V1 字段；字段集合只增不删，消费方必须容忍未知字段。
 * 有意变更字段集合时：先改本快照与实现——快照即字段级契约的可执行真相源。
 * 运行时真相源是 `taskboard help`：这里同时断言 HELP 覆盖实现与计划中的子命令清单。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { HELP, main } from "../src/cli.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { parseCreateTaskInput } from "../src/task-input.js";

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录（本文件进程内生效）
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-contract-"));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const boot = async (): Promise<{ daemon: RunningDaemon; url: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-contract-"));
  tmpDirs.push(dir);
  const daemon = await startDaemon({ port: 0, dbPath: join(dir, "taskboard.sqlite") });
  daemons.push(daemon);
  return { daemon, url: `http://127.0.0.1:${daemon.port}` };
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const cli = async (argv: string[]): Promise<CliResult> => {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
};

const parse = (result: CliResult): Record<string, unknown> => {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

const keysOf = (value: unknown): string[] => Object.keys(value as object).sort();

// ---- 钉死的字段集合 ----

const TASK_CARD_KEYS = [
  "acceptanceCriteria",
  "acceptanceMode",
  "activeRun",
  "archived",
  "archivedAt",
  "automationMode",
  "badges",
  "childrenCount",
  "createdAt",
  "goal",
  "goalStatus",
  "id",
  "idleThresholdMs",
  "labels",
  "lastCronSkip",
  "lastRun",
  "parentId",
  "primaryThreadId",
  "primaryThreadStatus",
  "prompt",
  "schedule",
  "source",
  "status",
  "subtasksPolicy",
  "summaryStatus",
  "threadCount",
  "title",
  "updatedAt",
  "workspace",
  "workspaceMode",
  "worktree",
];

const TASK_DETAIL_KEYS = [...TASK_CARD_KEYS, "annotations", "children", "inFlightWrite", "runs", "threads"].sort();

const RUN_KEYS = ["createdAt", "endedAt", "failureReason", "id", "orphaned", "startedAt", "status", "taskId", "threadId", "trigger"];

const RUNTIME_KEYS = [
  "activeRuns",
  "automationLiveGate",
  "automationPaused",
  "concurrencyLimit",
  "driver",
  "inFlightWrites",
  "manifests",
  "pid",
  "powerProtection",
  "proxyGuard",
  "scan",
  "startedAt",
  "systemone",
];

const MANIFEST_KEYS = ["capabilities", "degradations", "displayName", "harnessId", "readOnly", "readPaths", "schemaVersion"];

// 线程详情载荷（GET /api/threads/:id，inspect-thread --json 同源）：与 U2 的冻结边界，字段只增不删
const THREAD_DETAIL_KEYS = [
  "bindings",
  "evidenceCount",
  "firstSeenAt",
  "goalStatus",
  "harnessId",
  "id",
  "ignored",
  "lastActivityAt",
  "latestTurn",
  "lineage",
  "locator",
  "nativeSessionId",
  "nativeStatus",
  "primaryTaskId",
  "progressVerdict",
  "semanticStatus",
  "summary",
  "title",
  "turnCount",
];

const THREAD_BINDING_KEYS = ["boundAt", "role", "taskId", "threadId"];

const TURN_KEYS = ["endedAt", "id", "locator", "nativeStatus", "ordinal", "sourceRef", "startedAt", "threadId"];

const PROPOSAL_KEYS = ["createdAt", "decidedAt", "evidenceFingerprint", "id", "payload", "status", "taskId", "threadId"];

const SUMMARY_KEYS = [
  "byteStart",
  "coveredThroughTurnOrdinal",
  "createdAt",
  "id",
  "locator",
  "provenance",
  "recordHash",
  "sourceId",
  "sourceRef",
  "superseded",
  "text",
  "threadId",
];

const assertTaskCard = (task: unknown): void => {
  assert.deepEqual(keysOf(task), TASK_CARD_KEYS);
  const card = task as Record<string, unknown>;
  assert.equal(typeof card.id, "string");
  assert.equal(typeof card.title, "string");
  assert.equal(typeof card.prompt, "string");
  assert.ok(["backlog", "todo", "running", "done", "failed"].includes(card.status as string));
  assert.equal(typeof card.archived, "boolean");
  assert.ok(Array.isArray(card.labels));
  assert.ok(Array.isArray(card.badges));
  assert.deepEqual(keysOf(card.goal), ["budgetTokens", "enabled"]);
  if (card.schedule !== null) assert.deepEqual(keysOf(card.schedule), ["cron", "nextRunAt", "tz"]);
  if (card.lastRun !== null) assert.deepEqual(keysOf(card.lastRun), RUN_KEYS);
  if (card.activeRun !== null) assert.deepEqual(keysOf(card.activeRun), RUN_KEYS);
};

test("contract: create/update/move/archive/unarchive return {ok, task} with the task card field set", async () => {
  const { url } = await boot();
  const u = ["--url", url, "--json"];
  const created = parse(await cli(["create", "--title", "c", "--workspace", "/tmp/ws", "--cron", "0 9 * * *", ...u]));
  assert.deepEqual(keysOf(created), ["ok", "task"]);
  assert.equal(created.ok, true);
  assertTaskCard(created.task);
  const id = (created.task as { id: string }).id;
  for (const argv of [
    ["update", id, "--title", "d"],
    ["move", id, "backlog"],
    ["archive", id],
    ["unarchive", id],
  ]) {
    const payload = parse(await cli([...argv, ...u]));
    assert.deepEqual(keysOf(payload), ["ok", "task"], argv[0]);
    assertTaskCard(payload.task);
  }
});

test("contract: get returns {ok, task} with the detail field set; runs carry the run field set", async () => {
  const { daemon, url } = await boot();
  const u = ["--url", url, "--json"];
  const created = parse(await cli(["create", "--title", "g", "--workspace", "/tmp/ws", ...u]));
  const id = (created.task as { id: string }).id;
  const run = daemon.store.createRun(id, "manual");
  daemon.store.finishRun(run.id, "completed");
  const got = parse(await cli(["get", id, ...u]));
  assert.deepEqual(keysOf(got), ["ok", "task"]);
  const task = got.task as Record<string, unknown>;
  assert.deepEqual(keysOf(task), TASK_DETAIL_KEYS);
  assert.equal(typeof task.inFlightWrite, "boolean");
  const runs = task.runs as unknown[];
  assert.equal(runs.length, 1);
  assert.deepEqual(keysOf(runs[0]), RUN_KEYS);
  assert.deepEqual(keysOf((task.lastRun as object)), RUN_KEYS);
});

test("contract: list, status, delete, wait, pause/resume, db path", async () => {
  const { url } = await boot();
  const u = ["--url", url, "--json"];
  const created = parse(await cli(["create", "--title", "l", ...u]));
  const id = (created.task as { id: string }).id;

  const list = parse(await cli(["list", ...u]));
  assert.deepEqual(keysOf(list), ["ok", "revision", "tasks"]);
  assert.equal(typeof list.revision, "number");
  for (const task of list.tasks as unknown[]) assertTaskCard(task);

  const status = parse(await cli(["status", ...u]));
  assert.deepEqual(keysOf(status), [
    "failures",
    "inbox",
    "ok",
    "pid",
    "proposals",
    "revisions",
    "runtime",
    "sessions",
    "tasks",
    "url",
  ]);
  assert.deepEqual(keysOf(status.revisions), ["config", "tasks", "threads"]);
  assert.deepEqual(keysOf(status.runtime), RUNTIME_KEYS);
  const runtime = status.runtime as Record<string, unknown>;
  assert.ok(["off", "idle", "active", "unavailable"].includes(runtime.powerProtection as string));
  assert.deepEqual(keysOf(runtime.scan), ["anomalies", "filesDone", "filesTotal", "lastCompletedAt", "phase", "sources"]);
  assert.deepEqual(keysOf(runtime.driver), ["available", "note"]);
  const manifests = runtime.manifests as unknown[];
  assert.ok(Array.isArray(manifests), "runtime.manifests 必须是数组");
  assert.ok(manifests.length >= 1, "装配中的 daemon 至少暴露一个 manifest");
  for (const manifest of manifests) assert.deepEqual(keysOf(manifest), MANIFEST_KEYS);
  assert.ok(
    manifests.some((manifest) => (manifest as { harnessId: string }).harnessId === "codex"),
    "manifests 必须含 codex 项",
  );

  const waited = parse(await cli(["wait", id, ...u]));
  assert.deepEqual(keysOf(waited), ["lastRun", "ok", "quiet", "status", "taskId"]);
  assert.equal(waited.quiet, true);

  const paused = parse(await cli(["pause-automation", ...u]));
  assert.deepEqual(keysOf(paused), ["automationPaused", "ok"]);
  const resumed = parse(await cli(["resume-automation", ...u]));
  assert.deepEqual(keysOf(resumed), ["automationPaused", "ok"]);

  const deleted = parse(await cli(["delete", id, ...u]));
  assert.deepEqual(keysOf(deleted), ["deleted", "ok"]);
  assert.deepEqual(keysOf(deleted.deleted), ["danglingChildren", "id", "unboundThreads"]);

  const dbPath = parse(await cli(["db", "path", "--json"]));
  assert.deepEqual(keysOf(dbPath), ["default", "ok", "path"]);
});

test("contract: errors are exit 1/2/3 with one stderr line and no JSON on stdout; wait timeout emits a {ok:false} JSON", async () => {
  const { daemon, url } = await boot();
  const semantic = await cli(["move", "t_missing", "done", "--url", url, "--json"]);
  assert.equal(semantic.code, 1);
  assert.equal(semantic.stdout, "");
  assert.match(semantic.stderr, /^Error: [^\n]+\n$/);
  const usage = await cli(["move", "--url", url, "--json"]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^Error: [^\n]+\n$/);
  const unreachable = await cli(["list", "--url", "http://127.0.0.1:1", "--json"]);
  assert.equal(unreachable.code, 3);
  assert.equal(unreachable.stdout, "");
  // wait 超时：stdout 一条 {ok:false,error:"timeout",...} 供脚本判别，stderr 人话，exit 1
  const created = parse(await cli(["create", "--title", "w", "--workspace", "/tmp/ws", "--url", url, "--json"]));
  daemon.store.createRun((created.task as { id: string }).id, "manual");
  const timeout = await cli(["wait", (created.task as { id: string }).id, "--timeout", "1", "--url", url, "--json"]);
  assert.equal(timeout.code, 1);
  const payload = JSON.parse(timeout.stdout) as Record<string, unknown>;
  assert.equal(payload.ok, false);
  assert.equal(payload.error, "timeout");
  assert.deepEqual(keysOf(payload), ["error", "ok", "task", "timeoutSeconds"]);
});

test("contract: inspect-thread returns {ok, thread} with the thread detail field set; turns page is {ok, items, nextCursor}", async () => {
  const { daemon, url } = await boot();
  const u = ["--url", url, "--json"];
  const created = parse(await cli(["create", "--title", "it", "--workspace", "/tmp/ws", ...u]));
  const taskId = (created.task as { id: string }).id;
  const now = daemon.store.now();
  daemon.store.upsertThread({ id: "th_c", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", title: "contract", lastActivityAt: now });
  daemon.store.bindThread(taskId, "th_c");
  daemon.store.db
    .prepare(
      "INSERT INTO thread_turns (id, thread_id, ordinal, native_status, started_at, ended_at, source_ref) VALUES ('turn_c', 'th_c', 0, 'completed', ?, ?, 'src')",
    )
    .run(now - 10, now);

  const inspected = parse(await cli(["inspect-thread", "th_c", ...u]));
  assert.deepEqual(keysOf(inspected), ["ok", "thread"]);
  const thread = inspected.thread as Record<string, unknown>;
  assert.deepEqual(keysOf(thread), THREAD_DETAIL_KEYS);
  // 语义状态入口：评估层填充，本构建恒 null
  assert.equal(thread.semanticStatus, null);
  assert.deepEqual(keysOf((thread.bindings as unknown[])[0]), THREAD_BINDING_KEYS);
  assert.deepEqual(keysOf(thread.lineage), ["children", "parents"]);
  assert.deepEqual(keysOf(thread.latestTurn), TURN_KEYS);
  assert.equal(thread.summary, null);

  const page = (await (await fetch(`${url}/api/threads/th_c/turns`)).json()) as Record<string, unknown>;
  assert.deepEqual(keysOf(page), ["items", "nextCursor", "ok"]);
  assert.deepEqual(keysOf((page.items as unknown[])[0]), TURN_KEYS);
});

test("contract: proposals list + accept/reject-proposal + thread summaries page field sets", async () => {
  const { daemon, url } = await boot();
  const u = ["--url", url, "--json"];
  const now = daemon.store.now();
  daemon.store.upsertThread({ id: "th_pr", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: now });
  const task = daemon.store.createTask(
    parseCreateTaskInput({ title: "pr", prompt: "p", workspace: "/tmp/ws" }),
  );
  daemon.store.bindThread(task.id, "th_pr");
  const answer = {
    needsAttention: false,
    progress: "p",
    summaryShort: "s",
    candidates: [{ action: "no_op", reasonShort: "quiet", risk: "low", evidenceRefs: [] }],
    recommended: "no_op",
    confidence: 0.9,
  };
  const first = daemon.store.addProposal({
    threadId: "th_pr",
    taskId: task.id,
    evidenceFingerprint: "t0:a-",
    payload: { ok: true, answer, model: null, effort: null },
  });
  const second = daemon.store.addProposal({
    threadId: "th_pr",
    taskId: task.id,
    evidenceFingerprint: "t0:a-",
    payload: { ok: true, answer, model: null, effort: null },
  });

  const list = parse(await cli(["proposals", ...u]));
  assert.deepEqual(keysOf(list), ["ok", "proposals"]);
  assert.equal((list.proposals as unknown[]).length, 2);
  assert.deepEqual(keysOf((list.proposals as unknown[])[0]), PROPOSAL_KEYS);

  const accepted = parse(await cli(["accept-proposal", first.id, ...u]));
  assert.deepEqual(keysOf(accepted), ["ok", "proposal"]);
  assert.deepEqual(keysOf(accepted.proposal), PROPOSAL_KEYS);
  assert.equal((accepted.proposal as { status: string }).status, "accepted");

  const rejected = parse(await cli(["reject-proposal", second.id, ...u]));
  assert.deepEqual(keysOf(rejected), ["ok", "proposal"]);
  assert.equal((rejected.proposal as { status: string }).status, "rejected");

  // 裁决终态后重放：exit 1 一行人话（幂等由 requestId 环保证，跨 requestId 拒绝）
  const replay = await cli(["accept-proposal", first.id, ...u]);
  assert.equal(replay.code, 1);
  assert.match(replay.stderr, /^Error: [^\n]+\n$/);

  daemon.store.addThreadSummary({ threadId: "th_pr", provenance: "compacted", text: "compacted baseline" });
  const sums = parse(await cli(["summaries", "th_pr", ...u]));
  // 全量列表无分页：nextCursor 恒 null（贴合 turns/evidence 的 {ok, items, nextCursor} 页面契约形状）
  assert.deepEqual(keysOf(sums), ["items", "nextCursor", "ok"]);
  assert.equal(sums.nextCursor, null);
  assert.deepEqual(keysOf((sums.items as unknown[])[0]), SUMMARY_KEYS);
});

test("HELP lists every implemented command", () => {
  const implemented = [
    "start",
    "status",
    "list",
    "get",
    "create",
    "update",
    "move",
    "archive",
    "unarchive",
    "delete",
    "run",
    "cancel",
    "goal",
    "worktree-clean",
    "bind-thread",
    "unbind-thread",
    "ignore-thread",
    "unignore-thread",
    "inspect-thread",
    "wait",
    "refresh",
    "pause-automation",
    "resume-automation",
    "summaries",
    "proposals",
    "accept-proposal",
    "reject-proposal",
    "db path",
    "retro record",
    "retro attempt",
    "retro combo-record",
    "retro combo-get",
    "retro combo-list",
    "retro combo-same-type",
    "help",
  ];
  for (const command of implemented) {
    assert.match(HELP, new RegExp(`^  taskboard ${command.replace(" ", " ")}\\b`, "m"), command);
  }
  // 没有“计划中”的子命令：占位清单已全部转正，HELP 不再有 Not-yet 段
  assert.equal(HELP.includes("Not yet available"), false);
  assert.match(HELP, /Exit codes: 0 ok, 1 semantic failure or timeout, 2 usage error, 3 daemon unreachable/);
});
