/**
 * S2（#43）：Codex fixture 经真实 reader/adapter 落库后，详情 API 的 turn 终态、
 * 原生摘要与 source locator 必须可核对；摘要缺失时如实为 null，而不是伪造正文。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import {
  RolloutFile,
  compactedRecord,
  errorEvent,
  resetClock,
  sessionMeta,
  taskComplete,
  taskStarted,
  turnAborted,
  userMessageItem,
  writeText,
  type CodexHome,
} from "./helpers/rollout.js";

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const makeHome = async (): Promise<CodexHome> => {
  const root = await mkdtemp(join(tmpdir(), "tb-codex-detail-"));
  tmpDirs.push(root);
  return {
    root,
    sessionsDir: join(root, "sessions"),
    archivedDir: join(root, "archived_sessions"),
  };
};

const getJson = async (base: string, path: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${base}${path}`)).json()) as Record<string, unknown>;

const boot = async (home: CodexHome): Promise<{ daemon: RunningDaemon; base: string }> => {
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(home.root, "taskboard.sqlite"),
    codexHome: home.root,
    scanIntervalMs: 0,
  });
  daemons.push(daemon);
  await daemon.harnesses.scanNow();
  return { daemon, base: `http://127.0.0.1:${daemon.port}` };
};

test("S2 detail: turn terminal states, bad lines, and compacted provenance are verifiable from source", async () => {
  resetClock();
  const home = await makeHome();
  const sessionId = "sess-s2-turn-states";
  const file = new RolloutFile(
    sessionMeta(0, { sessionId, cwd: "/tmp/ws/s2" }, Date.parse("2026-10-26T01:00:00Z")),
    taskStarted(1, "turn-ok", {}, Date.parse("2026-10-26T01:00:01Z")),
    userMessageItem(2, "turn-ok", "完成第一步", { threadId: sessionId }, Date.parse("2026-10-26T01:00:02Z")),
    compactedRecord(3, "原生压缩：第一步已完成并验证", Date.parse("2026-10-26T01:00:03Z")),
    taskComplete(4, "turn-ok", Date.parse("2026-10-26T01:00:04Z")),
    taskStarted(5, "turn-fail", {}, Date.parse("2026-10-26T01:00:05Z")),
    errorEvent(6, "turn-fail", "tool failed", Date.parse("2026-10-26T01:00:06Z")),
    taskStarted(7, "turn-abort", {}, Date.parse("2026-10-26T01:00:07Z")),
    turnAborted(8, "turn-abort", Date.parse("2026-10-26T01:00:08Z")),
    "{\"timestamp\":\"2026-10-26T01:00:09Z\",\"ordinal\":9,\"type\":\"event_msg\",broken...",
    userMessageItem(10, "turn-abort", "坏行之后仍可读", { threadId: sessionId }, Date.parse("2026-10-26T01:00:10Z")),
  );
  const path = join(home.sessionsDir, "rollout-s2.jsonl");
  await writeText(path, file.text());
  const before = await readFile(path, "utf8");

  const { daemon, base } = await boot(home);

  const detail = (await getJson(base, `/api/threads/${sessionId}`)).thread as Record<string, unknown>;
  assert.equal(detail.harnessId, "codex");
  assert.equal(detail.nativeSessionId, sessionId);
  assert.equal(detail.nativeStatus, "interrupted");
  assert.equal((detail.locator as { sourcePath: string }).sourcePath, path);

  const page = await getJson(base, `/api/threads/${sessionId}/turns?limit=50`);
  const turns = page.items as Array<Record<string, unknown>>;
  assert.deepEqual(turns.map((turn) => turn.nativeStatus), ["completed", "failed", "interrupted"]);
  for (const turn of turns) {
    const locator = turn.locator as Record<string, unknown>;
    assert.equal(locator.sourcePath, path);
    assert.equal(typeof locator.byteStart, "number");
    assert.equal(typeof locator.recordHash, "string");
  }

  const summaries = await getJson(base, `/api/threads/${sessionId}/summaries`);
  const summary = (summaries.items as Array<Record<string, unknown>>)[0]!;
  assert.equal(summary.provenance, "compacted");
  assert.equal(summary.text, "原生压缩：第一步已完成并验证");
  const summaryLocator = summary.locator as Record<string, unknown>;
  assert.equal(summaryLocator.sourcePath, path);
  assert.equal(summaryLocator.sourceId, daemon.store.listReaderSources()[0]!.sourceId);
  assert.equal(typeof summaryLocator.byteStart, "number");
  assert.equal(typeof summaryLocator.recordHash, "string");
  assert.equal(summaryLocator.coveredThroughTurnOrdinal, 0);

  const evidence = await getJson(base, `/api/threads/${sessionId}/evidence?limit=100`);
  const evidenceItems = evidence.items as Array<Record<string, unknown>>;
  assert.deepEqual(
    evidenceItems.map((item) => ({ summary: item.summary, kind: item.kind })),
    [
      { summary: "完成第一步", kind: "message" },
      { summary: "tool failed", kind: "turn_error" },
      { summary: "坏行之后仍可读", kind: "message" },
    ],
    "坏行后的 item 不得丢失",
  );
  for (const item of evidenceItems) {
    const source = item.source as Record<string, unknown>;
    assert.equal(source.sourcePath, path);
    assert.equal(typeof source.byteStart, "number");
    assert.equal(typeof source.recordHash, "string");
  }
  // 坏行进入 anomaly，但不阻塞后续记录或摘要
  assert.ok(daemon.store.readerCursorSummary().anomalies >= 1);
  assert.equal(daemon.store.listThreadSummaries(sessionId).length, 1);
  assert.equal(await readFile(path, "utf8"), before, "详情读取不得改写 Codex JSONL");
});

test("S2 detail: a session without a compacted record reports none instead of inventing a summary", async () => {
  resetClock();
  const home = await makeHome();
  const sessionId = "sess-s2-no-summary";
  const file = new RolloutFile(
    sessionMeta(0, { sessionId, cwd: "/tmp/ws/none" }, Date.parse("2026-10-26T02:00:00Z")),
    taskStarted(1, "turn-1", {}, Date.parse("2026-10-26T02:00:01Z")),
    userMessageItem(2, "turn-1", "没有压缩记录", { threadId: sessionId }, Date.parse("2026-10-26T02:00:02Z")),
    taskComplete(3, "turn-1", Date.parse("2026-10-26T02:00:03Z")),
  );
  await writeText(join(home.sessionsDir, "rollout-s2-none.jsonl"), file.text());

  const { base } = await boot(home);
  const detail = (await getJson(base, `/api/threads/${sessionId}`)).thread as Record<string, unknown>;
  assert.equal(detail.summary, null);
  const summaries = await getJson(base, `/api/threads/${sessionId}/summaries`);
  assert.deepEqual(summaries.items, []);
  assert.equal(summaries.nextCursor, null);
});

test("S2 detail: an unreadable source degrades locally without hiding other observed sessions", async () => {
  resetClock();
  const home = await makeHome();
  const healthyId = "sess-s2-healthy";
  await writeText(
    join(home.sessionsDir, "rollout-healthy.jsonl"),
    new RolloutFile(
      sessionMeta(0, { sessionId: healthyId, cwd: "/tmp/ws/ok" }, Date.parse("2026-10-26T03:00:00Z")),
      taskStarted(1, "turn-1", {}, Date.parse("2026-10-26T03:00:01Z")),
      taskComplete(2, "turn-1", Date.parse("2026-10-26T03:00:02Z")),
    ).text(),
  );
  // 缺 session_meta 的坏 source：无法归属会话，但扫描必须继续并完成
  await writeFile(join(home.sessionsDir, "rollout-broken.jsonl"), "not json\n", "utf8");

  const { daemon, base } = await boot(home);
  const state = await getJson(base, "/api/state");
  assert.ok(
    (state.sessions as Array<{ nativeSessionId: string }>).some((session) => session.nativeSessionId === healthyId),
    "healthy session remains visible",
  );
  const detail = (await getJson(base, `/api/threads/${healthyId}`)).thread as Record<string, unknown>;
  assert.equal(detail.nativeStatus, "completed");
  assert.equal(detail.summary, null);
  assert.equal(daemon.harnesses.scanProgress().phase, "done");
});
