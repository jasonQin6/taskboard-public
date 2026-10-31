/**
 * 原生来源兼容缝：固定 rollout fixture 驱动真实 reader（不调真实 Codex）。
 * 覆盖票面矩阵：追加/半行/截断/重写/目录移动/zst/fork/rollback/subagent/未知 item/compacted/坏行/崩溃重跑收敛。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { createHttpServer, type TaskboardHttp } from "../src/http.js";
import { RolloutReader } from "../src/reader/scanner.js";
import { SingleFlightRegistry } from "../src/single-flight.js";
import { Store } from "../src/store/index.js";
import {
  RolloutFile,
  agentMessageItem,
  commandExecutionItem,
  compactedRecord,
  developerMessageRecord,
  errorEvent,
  fileChangeItem,
  mcpToolCallItem,
  opaqueItem,
  reasoningItem,
  sessionMeta,
  taskComplete,
  taskStarted,
  tokenUsageRecord,
  turnAborted,
  unknownRecordType,
  userMessageItem,
  writeText,
  writeZst,
  type CodexHome,
} from "./helpers/rollout.js";

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
const servers: TaskboardHttp[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (servers.length > 0) await servers.pop()!.shutdown();
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

interface Harness {
  home: CodexHome;
  store: Store;
  reader: RolloutReader;
}

let homeCounter = 0;

const boot = async (): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), `tb-reader-${(homeCounter += 1)}-`));
  tmpDirs.push(root);
  const home: CodexHome = {
    root,
    sessionsDir: join(root, "sessions"),
    archivedDir: join(root, "archived_sessions"),
  };
  const { db } = await openStateDb(join(root, "taskboard.sqlite"));
  const store = new Store(db);
  const reader = new RolloutReader(store, {
    sessionsDir: home.sessionsDir,
    archivedDir: home.archivedDir,
    scanIntervalMs: 0,
  });
  return { home, store, reader };
};

const teardown = async (harness: Harness): Promise<void> => {
  await harness.reader.stop();
};

/** 独立 HTTP 面（不经 daemon 锁）：thread turns/evidence 分页契约测试用；收尾 shutdown 断开 keep-alive。 */
const startHttp = (store: Store): TaskboardHttp =>
  createHttpServer({
    store,
    views: {
      store,
      singleFlight: new SingleFlightRegistry(),
      runtime: () => ({
        pid: 0,
        startedAt: new Date(0).toISOString(),
        powerProtection: "off",
        proxyGuard: false,
        driver: { available: false, note: "test" },
      }),
    },
    dbPath: "unused",
  });

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url);
  return (await response.json()) as T;
};

const postJson = async (port: number, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const until = async (predicate: () => Promise<boolean>, timeoutMs = 3_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
};

test("A2: full scan discovers a rollout session as an Inbox thread with turns and minimal evidence", async () => {
  const h = await boot();
  try {
    const file = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-0001", cwd: "/tmp/ws-a" }, Date.parse("2026-10-01T08:00:00Z")),
      taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
      userMessageItem(2, "turn-1", "请修复 reader 的半行问题", { threadId: "sess-0001" }, Date.parse("2026-10-01T08:00:02Z")),
      agentMessageItem(3, "turn-1", "已定位：尾行未换行导致", { threadId: "sess-0001" }, Date.parse("2026-10-01T08:00:03Z")),
      taskComplete(4, "turn-1", Date.parse("2026-10-01T08:00:04Z")),
    );
    await writeText(join(h.home.sessionsDir, "rollout-1.jsonl"), file.text());

    await h.reader.scanNow();

    const inbox = h.store.listInbox({ now: Date.parse("2026-10-01T08:30:00Z") });
    assert.equal(inbox.length, 1, "new rollout appears in inbox");
    const thread = inbox[0]!;
    assert.equal(thread.id, "sess-0001", "thread identity comes from session_meta.id");
    assert.equal(thread.nativeStatus, "completed", "last turn terminal event decides native status");
    assert.equal(thread.lastActivityAt, new Date(Date.parse("2026-10-01T08:00:04Z")).toISOString());

    const turns = h.store.listThreadTurns("sess-0001");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.id, "turn-1");
    assert.equal(turns[0]!.ordinal, 0);
    assert.equal(turns[0]!.nativeStatus, "completed");

    const evidence = h.store.listEvidencePage("sess-0001", { limit: 50 }).items;
    const kinds = evidence.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ["message", "message"], "only visible message evidence; no transcript");
    const user = evidence.find((item) => item.props?.role === "user")!;
    assert.equal(user.summary, "请修复 reader 的半行问题");
    assert.equal(user.turnOrdinal, 0);
    assert.ok(user.byteStart > 0 && user.recordHash.length === 64, "evidence carries source locator fields");
  } finally {
    await teardown(h);
  }
});

test("A8: compacted summary comes from the latest compacted record with provenance=compacted, idempotent by record hash", async () => {
  const h = await boot();
  try {
    const file = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-comp" }, Date.parse("2026-10-01T08:00:00Z")),
      compactedRecord(1, "第一次压缩：完成了一半", Date.parse("2026-10-01T08:01:00Z")),
      compactedRecord(2, "第二次压缩：全部完成并验证", Date.parse("2026-10-01T08:02:00Z")),
    );
    await writeText(join(h.home.sessionsDir, "rollout-c.jsonl"), file.text());
    await h.reader.scanNow();

    const summaries = h.store.listThreadSummaries("sess-comp");
    assert.equal(summaries.length, 1, "only the latest compaction is extracted");
    assert.equal(summaries[0]!.provenance, "compacted");
    assert.equal(summaries[0]!.text, "第二次压缩：全部完成并验证");

    await h.reader.scanNow(); // 重扫不重复提取（按记录 hash 幂等）
    assert.equal(h.store.listThreadSummaries("sess-comp").length, 1);
  } finally {
    await teardown(h);
  }
});

test("F6: source rewrite refreshes a matched summary locator and coverage as one unit", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-summary-rewrite.jsonl");
    const meta = sessionMeta(0, { sessionId: "sess-summary-rewrite" }, Date.parse("2026-10-01T08:00:00Z"));
    const compaction = compactedRecord(10, "同一个压缩摘要", Date.parse("2026-10-01T08:02:00Z"));
    await writeBumped(path, new RolloutFile(meta, compaction).text());
    await h.reader.scanNow();
    const before = h.store.listThreadSummaries("sess-summary-rewrite")[0]!;
    assert.equal(before.byteStart, byteOffsetOf(new RolloutFile(meta, compaction), compaction));
    assert.equal(before.coveredThroughTurnOrdinal, null);

    const rewritten = new RolloutFile(
      meta,
      taskStarted(1, "turn-before-compaction", {}, Date.parse("2026-10-01T08:01:00Z")),
      compaction,
    );
    await writeBumped(path, rewritten.text());
    await h.reader.scanNow();

    const summaries = h.store.listThreadSummaries("sess-summary-rewrite");
    assert.equal(summaries.length, 1, "matching compaction keeps one stable summary row");
    const after = summaries[0]!;
    assert.equal(after.text, before.text);
    assert.equal(after.recordHash, before.recordHash);
    assert.equal(after.byteStart, byteOffsetOf(rewritten, compaction), "byteStart moves with the rewritten source");
    assert.equal(after.coveredThroughTurnOrdinal, 0, "coverage is recomputed with the rewritten turn set");
    assert.equal(after.sourceId, h.store.listReaderSources()[0]!.sourceId);
    assert.equal(h.store.listThreadTurns("sess-summary-rewrite")[0]!.sourceLocatorKind, "start");
  } finally {
    await teardown(h);
  }
});

test("F6: a rewrite that removes a compaction supersedes it and latest selection cannot present a stale locator", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-summary-delete.jsonl");
    const meta = sessionMeta(0, { sessionId: "sess-summary-delete" }, Date.parse("2026-10-01T08:00:00Z"));
    const turn = taskStarted(1, "turn-kept", {}, Date.parse("2026-10-01T08:01:00Z"));
    await writeBumped(path, new RolloutFile(meta, turn, compactedRecord(2, "将被删除的摘要")).text());
    await h.reader.scanNow();
    assert.ok(h.store.latestThreadSummary("sess-summary-delete") !== null);

    await writeBumped(path, new RolloutFile(meta, turn).text());
    await h.reader.scanNow();

    assert.equal(h.store.latestThreadSummary("sess-summary-delete"), null);
    const old = h.store.listThreadSummaries("sess-summary-delete")[0] as
      | { superseded?: boolean }
      | undefined;
    assert.equal(old?.superseded, true, "removed compaction remains as an explicitly superseded record");

    const server = startHttp(h.store);
    servers.push(server);
    const port = await new Promise<number>((resolve) => {
      server.server.listen(0, "127.0.0.1", () => {
        const address = server.server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    const detail = await getJson<{ thread: { summary: unknown } }>(
      `http://127.0.0.1:${port}/api/threads/sess-summary-delete`,
    );
    assert.equal(detail.thread.summary, null);
    const summaries = await getJson<{ items: Array<{ superseded: boolean; locator: unknown }> }>(
      `http://127.0.0.1:${port}/api/threads/sess-summary-delete/summaries`,
    );
    assert.deepEqual(
      summaries.items.map((summary) => ({ superseded: summary.superseded, locator: summary.locator })),
      [{ superseded: true, locator: null }],
    );
  } finally {
    await teardown(h);
  }
});

test("F7: an incremental compaction uses the persisted same-source ordinal instead of the current empty window", async () => {
  const h = await boot();
  try {
    const pathA = join(h.home.sessionsDir, "rollout-f7-a.jsonl");
    const pathB = join(h.home.sessionsDir, "rollout-f7-b.jsonl");
    const meta = sessionMeta(0, { sessionId: "sess-f7" }, Date.parse("2026-10-01T08:00:00Z"));
    const sourceA = new RolloutFile(
      meta,
      taskStarted(1, "turn-a", {}, Date.parse("2026-10-01T08:01:00Z")),
      taskComplete(2, "turn-a", Date.parse("2026-10-01T08:02:00Z")),
      userMessageItem(3, "turn-a", "x".repeat(5_000), { threadId: "sess-f7" }),
    );
    await writeBumped(pathA, sourceA.text());
    await writeBumped(
      pathB,
      new RolloutFile(
        meta,
        taskStarted(1, "turn-b", {}, Date.parse("2026-10-01T08:03:00Z")),
        taskComplete(2, "turn-b", Date.parse("2026-10-01T08:04:00Z")),
      ).text(),
    );
    await h.reader.scanNow();
    assert.deepEqual(
      h.store.listThreadTurns("sess-f7").map((turn) => turn.id),
      ["turn-a", "turn-b"],
    );

    await appendBumped(pathA, `${compactedRecord(4, "跨窗口压缩", Date.parse("2026-10-01T08:05:00Z"))}\n`);
    await h.reader.scanNow();

    const summary = h.store.listThreadSummaries("sess-f7")[0]!;
    assert.equal(summary.text, "跨窗口压缩");
    assert.equal(summary.coveredThroughTurnOrdinal, 0, "other sources' later ordinals are not evidence for source A");
  } finally {
    await teardown(h);
  }
});

test("F7: a merged session without window turns uses its persisted same-source coverage", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-f7-merged-session.jsonl");
    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-f7-a" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-a", {}, Date.parse("2026-10-01T08:01:00Z")),
        taskComplete(2, "turn-a", Date.parse("2026-10-01T08:02:00Z")),
        userMessageItem(3, "turn-a", "x".repeat(5_000), { threadId: "sess-f7-a" }),
        sessionMeta(4, { sessionId: "sess-f7-b" }, Date.parse("2026-10-01T08:03:00Z")),
      ).text(),
    );
    await h.reader.scanNow();
    assert.equal(h.store.listThreadTurns("sess-f7-a")[0]?.ordinal, 0);
    assert.equal(h.store.listThreadTurns("sess-f7-b").length, 0);

    await appendBumped(
      path,
      `${sessionMeta(5, { sessionId: "sess-f7-a" }, Date.parse("2026-10-01T08:04:00Z"))}\n${compactedRecord(
        6,
        "merged session compaction",
        Date.parse("2026-10-01T08:05:00Z"),
      )}\n`,
    );
    await h.reader.scanNow();

    const summary = h.store.listThreadSummaries("sess-f7-a")[0]!;
    assert.equal(summary.coveredThroughTurnOrdinal, 0);
  } finally {
    await teardown(h);
  }
});

test("F7: a rewritten merged session does not seed coverage from turns deleted by the same scan", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-f7-rewritten-merged-session.jsonl");
    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-f7-rewrite-a" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-a", {}, Date.parse("2026-10-01T08:01:00Z")),
        taskComplete(2, "turn-a", Date.parse("2026-10-01T08:02:00Z")),
        userMessageItem(3, "turn-a", "x".repeat(5_000), { threadId: "sess-f7-rewrite-a" }),
        sessionMeta(4, { sessionId: "sess-f7-rewrite-b" }, Date.parse("2026-10-01T08:03:00Z")),
        taskStarted(5, "turn-b", {}, Date.parse("2026-10-01T08:04:00Z")),
        taskComplete(6, "turn-b", Date.parse("2026-10-01T08:05:00Z")),
      ).text(),
    );
    await h.reader.scanNow();
    assert.deepEqual(
      h.store.listThreadTurns("sess-f7-rewrite-a").map((turn) => [turn.id, turn.ordinal]),
      [["turn-a", 0]],
    );

    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-f7-rewrite-a" }, Date.parse("2026-10-01T08:00:00Z")),
        compactedRecord(1, "rewritten merged summary", Date.parse("2026-10-01T08:06:00Z")),
        sessionMeta(2, { sessionId: "sess-f7-rewrite-b" }, Date.parse("2026-10-01T08:07:00Z")),
      ).text(),
    );
    await h.reader.scanNow();

    assert.equal(h.store.listThreadTurns("sess-f7-rewrite-a").length, 0, "rewrite deleted session A's turn");
    const summary = h.store.listThreadSummaries("sess-f7-rewrite-a")[0]!;
    assert.equal(summary.text, "rewritten merged summary");
    assert.equal(summary.coveredThroughTurnOrdinal, null, "coverage cannot outlive the deleted turn");
  } finally {
    await teardown(h);
  }
});

test("F9: a terminal-only replay in another source records terminal fallback, not a claimed start", async () => {
  const h = await boot();
  try {
    const meta = sessionMeta(0, { sessionId: "sess-terminal-kind" }, Date.parse("2026-10-01T08:00:00Z"));
    await writeBumped(
      join(h.home.sessionsDir, "rollout-kind-a.jsonl"),
      new RolloutFile(meta, taskStarted(1, "turn-span", {}, Date.parse("2026-10-01T08:01:00Z"))).text(),
    );
    await writeBumped(
      join(h.home.sessionsDir, "rollout-kind-b.jsonl"),
      new RolloutFile(meta, taskComplete(2, "turn-span", Date.parse("2026-10-01T08:02:00Z"))).text(),
    );
    await h.reader.scanNow();

    const turn = h.store.listThreadTurns("sess-terminal-kind")[0]!;
    assert.equal(turn.nativeStatus, "completed");
    assert.equal(turn.sourceLocatorKind, "terminal");
    assert.equal(
      turn.sourceRef,
      h.store.listReaderSources().find((source) => source.path.endsWith("rollout-kind-b.jsonl"))!.sourceId,
    );
  } finally {
    await teardown(h);
  }
});

test("tool/file/reasoning/token evidence keeps only names, status, exit code, duration and paths", async () => {
  const h = await boot();
  try {
    const longOutput = "STDOUT-LINE ".repeat(400);
    const file = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-tool" }, Date.parse("2026-10-01T08:00:00Z")),
      taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
      commandExecutionItem(
        2,
        "turn-1",
        { command: ["/bin/zsh", "-lc", "deploy --token sk-ABCDEF0123456789ABCDEF0123456789"], exitCode: 3, durationSecs: 2 },
        { turnId: "turn-1" },
        Date.parse("2026-10-01T08:00:02Z"),
      ),
      fileChangeItem(
        3,
        "turn-1",
        { "/repo/src/a.ts": { type: "update" }, "/repo/src/b.ts": { type: "add" } },
        { turnId: "turn-1" },
        Date.parse("2026-10-01T08:00:03Z"),
      ),
      reasoningItem(4, "turn-1", ["检查部署脚本"], { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:04Z")),
      mcpToolCallItem(5, "turn-1", { server: "cua", tool: "js" }, { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:05Z")),
      tokenUsageRecord(
        6,
        "turn-1",
        { input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 },
        Date.parse("2026-10-01T08:00:06Z"),
      ),
      taskComplete(7, "turn-1", Date.parse("2026-10-01T08:00:07Z")),
    );
    await writeText(join(h.home.sessionsDir, "rollout-t.jsonl"), file.text());
    await h.reader.scanNow();

    const evidence = h.store.listEvidencePage("sess-tool", { limit: 100 }).items;
    const byKind = (kind: string): typeof evidence => evidence.filter((item) => item.kind === kind);

    const tool = byKind("tool");
    assert.equal(tool.length, 2);
    const exec = tool.find((item) => item.props?.tool === "exec")!;
    assert.equal(exec.props!.exitCode, 3);
    assert.equal(exec.props!.durationMs, 2000);
    assert.ok(!exec.summary!.includes("sk-ABCDEF"), "command excerpt is redacted");
    assert.ok(!JSON.stringify(evidence).includes(longOutput), "full tool output never stored");
    assert.ok(!JSON.stringify(evidence).includes("aggregated_output"));

    const change = byKind("file_change")[0]!;
    assert.equal(change.summary, "2 file(s) changed");
    const paths = (change.props!.changes as Array<{ path: string }>).map((entry) => entry.path).sort();
    assert.deepEqual(paths, ["/repo/src/a.ts", "/repo/src/b.ts"]);
    assert.ok(!JSON.stringify(change.props).includes("unified_diff"));

    const reasoning = byKind("reasoning")[0]!;
    assert.equal(reasoning.summary, "检查部署脚本");
    assert.equal(reasoning.props!.present, true);

    const usage = byKind("token_usage")[0]!;
    assert.equal(usage.props!.totalTokens, 120);
    assert.equal(usage.turnOrdinal, 0);
  } finally {
    await teardown(h);
  }
});

test("A20 observation: turn_aborted marks interrupted (never failed); error event marks failed", async () => {
  const h = await boot();
  try {
    const file = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-abort" }, Date.parse("2026-10-01T08:00:00Z")),
      taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
      turnAborted(2, "turn-1", Date.parse("2026-10-01T08:00:02Z")),
      taskStarted(3, "turn-2", {}, Date.parse("2026-10-01T08:01:01Z")),
      errorEvent(4, "turn-2", "model upstream exploded", Date.parse("2026-10-01T08:01:02Z")),
    );
    await writeText(join(h.home.sessionsDir, "rollout-ab.jsonl"), file.text());
    await h.reader.scanNow();

    const turns = h.store.listThreadTurns("sess-abort");
    assert.deepEqual(
      turns.map((turn) => [turn.id, turn.nativeStatus]),
      [
        ["turn-1", "interrupted"],
        ["turn-2", "failed"],
      ],
    );
    assert.equal(h.store.listThreads().find((thread) => thread.id === "sess-abort")!.nativeStatus, "failed");
    const error = h.store.listEvidencePage("sess-abort", { limit: 50 })
      .items.find((item) => item.kind === "turn_error")!;
    assert.equal(error.summary, "model upstream exploded");
  } finally {
    await teardown(h);
  }
});

test("bad lines, unknown types and ordinal gaps become anomalies while later records still commit", async () => {
  const h = await boot();
  try {
    const file = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-bad" }, Date.parse("2026-10-01T08:00:00Z")),
      "{\"timestamp\":\"2026-10-01T08:00:01Z\",\"ordinal\":1,\"type\":\"event_msg\",broken...",
      unknownRecordType(2, "brand_new_future_type", Date.parse("2026-10-01T08:00:02Z")),
      taskStarted(9, "turn-1", {}, Date.parse("2026-10-01T08:00:03Z")), // ordinal 3→9：缺口
      taskComplete(10, "turn-1", Date.parse("2026-10-01T08:00:04Z")),
    );
    await writeText(join(h.home.sessionsDir, "rollout-b.jsonl"), file.text());
    await h.reader.scanNow();

    const turns = h.store.listThreadTurns("sess-bad");
    assert.equal(turns.length, 1, "records after anomalies still commit");
    assert.equal(turns[0]!.nativeStatus, "completed");

    const cursor = h.store.readerCursorSummary();
    assert.ok(cursor.anomalies >= 3, `bad line + unknown type + ordinal gap expected, got ${cursor.anomalies}`);
    assert.equal(cursor.sources, 1);

    const source = h.store.listReaderSources()[0]!;
    assert.equal(source.nextOrdinal, 11, "byte/ordinal cursor advanced past anomalies");
  } finally {
    await teardown(h);
  }
});

test("unknown item types degrade to opaque evidence; scanning continues", async () => {
  const h = await boot();
  try {
    const file = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-opaque" }, Date.parse("2026-10-01T08:00:00Z")),
      taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
      opaqueItem(2, "turn-1", "BrandNewItem", Date.parse("2026-10-01T08:00:02Z")),
      taskComplete(3, "turn-1", Date.parse("2026-10-01T08:00:03Z")),
    );
    await writeText(join(h.home.sessionsDir, "rollout-o.jsonl"), file.text());
    await h.reader.scanNow();

    const evidence = h.store.listEvidencePage("sess-opaque", { limit: 50 }).items;
    const opaque = evidence.find((item) => item.kind === "opaque")!;
    assert.equal(opaque.props!.itemType, "BrandNewItem");
    assert.equal(h.store.listThreadTurns("sess-opaque")[0]!.nativeStatus, "completed");
  } finally {
    await teardown(h);
  }
});

test("A2/A31 boundary: developer/system context and full transcripts never reach the database", async () => {
  const h = await boot();
  try {
    const longUserText = "这是用户的长消息。".repeat(200); // 3600+ chars
    const secretText = "key = sk-ABCDEF0123456789ABCDEF0123456789 请继续";
    const file = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-boundary" }, Date.parse("2026-10-01T08:00:00Z")),
      developerMessageRecord(1, "SYSTEM PROMPT CONTENT THAT MUST NOT BE STORED", Date.parse("2026-10-01T08:00:01Z")),
      taskStarted(2, "turn-1", {}, Date.parse("2026-10-01T08:00:02Z")),
      userMessageItem(3, "turn-1", longUserText + secretText, { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:03Z")),
      taskComplete(4, "turn-1", Date.parse("2026-10-01T08:00:04Z")),
    );
    await writeText(join(h.home.sessionsDir, "rollout-bd.jsonl"), file.text());
    await h.reader.scanNow();

    const evidence = h.store.listEvidencePage("sess-boundary", { limit: 50 }).items;
    assert.equal(evidence.length, 1, "developer context items never become evidence");
    const message = evidence[0]!;
    assert.ok(message.summary!.length <= 281, `excerpt capped, got ${message.summary!.length}`);
    assert.ok(!message.summary!.includes("sk-ABCDEF"), "secrets redacted before storage");
    const dump = JSON.stringify(message);
    assert.ok(!dump.includes("MUST NOT BE STORED"));
    assert.ok(!dump.includes("这是用户的长消息。".repeat(50)), "full transcript text not stored");
    assert.equal(h.store.listThreads().find((t) => t.id === "sess-boundary")!.title, message.summary);
  } finally {
    await teardown(h);
  }
});

// ---- 增量与恢复（A5/A6、崩溃收敛、游标恢复） ----

let mtimeCounter = Date.parse("2026-10-01T09:00:00Z");
/** 写文件并显式前推 mtime：同尺寸重写不能靠亚毫秒 mtime 碰运气。 */
const writeBumped = async (path: string, content: string): Promise<void> => {
  await writeText(path, content);
  mtimeCounter += 60_000;
  const t = new Date(mtimeCounter);
  await utimes(path, t, t);
};

const appendBumped = async (path: string, extra: string): Promise<void> => {
  const { readFile, appendFile } = await import("node:fs/promises");
  await appendFile(path, extra, "utf8");
  void readFile; // appendFile 已保证落盘
  mtimeCounter += 60_000;
  const t = new Date(mtimeCounter);
  await utimes(path, t, t);
};

const byteOffsetOf = (file: RolloutFile, line: string): number => {
  const text = file.text();
  const index = text.indexOf(line);
  assert.ok(index >= 0, "fixture line must exist");
  return Buffer.byteLength(text.slice(0, index), "utf8");
};

const twoTurnFile = (): RolloutFile =>
  new RolloutFile(
    sessionMeta(0, { sessionId: "sess-inc" }, Date.parse("2026-10-01T08:00:00Z")),
    taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
    userMessageItem(2, "turn-1", "first question", { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:02Z")),
    taskComplete(3, "turn-1", Date.parse("2026-10-01T08:00:03Z")),
  );

const evidenceSnapshot = (store: Store, threadId: string): string[] =>
  store
    .listEvidencePage(threadId, { limit: 500, includeSuperseded: true })
    .items.map((item) => `${item.sourceId}:${item.byteStart}:${item.recordHash}:${item.superseded ? "S" : "A"}`)
    .sort();

test("A5: appending a complete turn adds exactly its evidence; a partial tail line produces nothing until complete", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-inc.jsonl");
    await writeBumped(path, twoTurnFile().text());
    await h.reader.scanNow();
    const afterFirst = evidenceSnapshot(h.store, "sess-inc");
    assert.equal(h.store.listThreadTurns("sess-inc").length, 1);

    // 半行：task_complete 只写入一半
    const completeLine = taskComplete(4, "turn-2", Date.parse("2026-10-01T08:00:04Z"));
    const startedLine = taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:00:04Z"));
    await appendBumped(path, `${startedLine}\n${completeLine.slice(0, 40)}`);
    await h.reader.scanNow();

    assert.deepEqual(evidenceSnapshot(h.store, "sess-inc"), afterFirst, "half line commits nothing");
    const halfCursor = h.store.listReaderSources()[0]!;
    assert.ok(halfCursor.consumedBytes < halfCursor.size, "cursor stops before the partial line");

    // 补完该行 + turn-2 的其余记录：本轮只新增对应证据
    const file = twoTurnFile().add(
      taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:00:04Z")),
      agentMessageItem(5, "turn-2", "second answer", { turnId: "turn-2" }, Date.parse("2026-10-01T08:00:05Z")),
      taskComplete(6, "turn-2", Date.parse("2026-10-01T08:00:06Z")),
    );
    await writeBumped(path, file.text());
    await h.reader.scanNow();

    const turns = h.store.listThreadTurns("sess-inc");
    assert.deepEqual(
      turns.map((turn) => [turn.ordinal, turn.id, turn.nativeStatus]),
      [
        [0, "turn-1", "completed"],
        [1, "turn-2", "completed"],
      ],
    );
    const active = h.store.listEvidencePage("sess-inc", { limit: 100 }).items;
    assert.equal(active.filter((item) => item.kind === "message").length, 2, "one message per turn, no duplicates");
  } finally {
    await teardown(h);
  }
});

test("A5: a turn opened in an earlier scan completes in a later scan keeping ordinal and started_at", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-span.jsonl");
    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-span" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
        userMessageItem(2, "turn-1", "still working", { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:02Z")),
      ).text(),
    );
    await h.reader.scanNow();
    const thread = h.store.listThreads().find((entry) => entry.id === "sess-span")!;
    assert.equal(thread.nativeStatus, "running", "open turn keeps thread running");
    const before = h.store.listThreadTurns("sess-span")[0]!;

    await appendBumped(path, `${taskComplete(3, "turn-1", Date.parse("2026-10-01T08:05:00Z"))}\n`);
    await h.reader.scanNow();

    const after = h.store.listThreadTurns("sess-span");
    assert.equal(after.length, 1, "same turn row, no duplicate");
    assert.equal(after[0]!.nativeStatus, "completed");
    assert.equal(after[0]!.ordinal, before.ordinal);
    assert.equal(after[0]!.startedAt, before.startedAt, "started_at preserved across passes");
    assert.equal(
      h.store.listThreads().find((entry) => entry.id === "sess-span")!.nativeStatus,
      "completed",
    );
  } finally {
    await teardown(h);
  }
});

test("A5: a pure append window (file > prefix window, no session_meta in window) attributes records to the tail session", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-append-large.jsonl");
    // 首 scan 文件必须超过 PREFIX_WINDOW(4096B)：小于它时每次追加都会命中 prefix hash 变化，
    // 被当成整文件重写（现有 A5 用例因此踩不到纯增量窗口）
    const filler = "很长的上下文内容。".repeat(400);
    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-append-large" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
        userMessageItem(2, "turn-1", filler, { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:02Z")),
        taskComplete(3, "turn-1", Date.parse("2026-10-01T08:00:03Z")),
      ).text(),
    );
    assert.ok((await (await import("node:fs/promises")).stat(path)).size > 4096, "fixture must exceed the prefix window");
    await h.reader.scanNow();
    assert.deepEqual(
      h.store.listThreadTurns("sess-append-large").map((turn) => [turn.id, turn.nativeStatus]),
      [["turn-1", "completed"]],
    );
    const cursorBefore = h.store.listReaderSources()[0]!;

    // 纯追加完整 turn（真机 rollout 的 session_meta 只在首行，追加窗口内没有 meta）
    await appendBumped(
      path,
      `${taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:10:00Z"))}\n` +
        `${agentMessageItem(5, "turn-2", "appended answer", { turnId: "turn-2" }, Date.parse("2026-10-01T08:10:01Z"))}\n` +
        `${taskComplete(6, "turn-2", Date.parse("2026-10-01T08:10:02Z"))}\n`,
    );
    await h.reader.scanNow();

    const cursorAfter = h.store.listReaderSources()[0]!;
    assert.ok(cursorAfter.consumedBytes > cursorBefore.consumedBytes, "append window was consumed");
    assert.deepEqual(
      h.store.listThreadTurns("sess-append-large").map((turn) => [turn.ordinal, turn.id, turn.nativeStatus]),
      [
        [0, "turn-1", "completed"],
        [1, "turn-2", "completed"],
      ],
      "appended turn must land with its terminal, not be dropped with the window",
    );
    assert.equal(
      h.store.listEvidencePage("sess-append-large", { limit: 100 }).items.filter((item) => item.kind === "message")
        .length,
      2,
      "appended turn's evidence lands under the tail session",
    );
    assert.equal(
      h.store.listThreads().find((entry) => entry.id === "sess-append-large")!.nativeStatus,
      "completed",
    );
  } finally {
    await teardown(h);
  }
});

test("A6: truncation rebuilds the source — removed turn's evidence superseded, kept turn restored without duplicates", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-trunc.jsonl");
    const full = twoTurnFile().add(
      taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:00:04Z")),
      userMessageItem(5, "turn-2", "second question", { turnId: "turn-2" }, Date.parse("2026-10-01T08:00:05Z")),
      taskComplete(6, "turn-2", Date.parse("2026-10-01T08:00:06Z")),
    );
    await writeBumped(path, full.text());
    await h.reader.scanNow();
    assert.equal(h.store.listThreadTurns("sess-inc").length, 2);

    // 截断：只剩 turn-1
    await writeBumped(path, twoTurnFile().text());
    await h.reader.scanNow();

    const turns = h.store.listThreadTurns("sess-inc");
    assert.deepEqual(turns.map((turn) => turn.id), ["turn-1"], "stale turn rows rebuilt away");
    const all = h.store.listEvidencePage("sess-inc", { limit: 100, includeSuperseded: true }).items;
    const turn1Active = all.filter((item) => item.superseded === false);
    assert.equal(turn1Active.filter((item) => item.kind === "message").length, 1, "kept evidence restored, not duplicated");
    assert.ok(
      all.some((item) => item.superseded === true && item.kind === "message"),
      "evidence of truncated turn superseded, not deleted",
    );

    // 重跑同一重写操作必须收敛到相同结果
    const snapshot = evidenceSnapshot(h.store, "sess-inc");
    await h.reader.scanNow();
    assert.deepEqual(evidenceSnapshot(h.store, "sess-inc"), snapshot);
  } finally {
    await teardown(h);
  }
});

test("A6: same-size rewrite (rollback) is detected and rebuilt; reruns converge", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-rw.jsonl");
    const original = twoTurnFile().add(
      taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:00:04Z")),
      userMessageItem(5, "turn-2", "doomed attempt", { turnId: "turn-2" }, Date.parse("2026-10-01T08:00:05Z")),
      taskComplete(6, "turn-2", Date.parse("2026-10-01T08:00:06Z")),
    );
    await writeBumped(path, original.text());
    await h.reader.scanNow();

    // 同尺寸重写：turn-2 换成不同内容，总大小一致
    const rolledBack = twoTurnFile().add(
      taskStarted(4, "turn-3", {}, Date.parse("2026-10-01T08:00:04Z")),
      userMessageItem(5, "turn-3", "retry attempt.", { turnId: "turn-3" }, Date.parse("2026-10-01T08:00:05Z")),
      taskComplete(6, "turn-3", Date.parse("2026-10-01T08:00:06Z")),
    );
    assert.equal(rolledBack.text().length, original.text().length, "fixture must keep the same size");
    await writeBumped(path, rolledBack.text());
    await h.reader.scanNow();

    const turns = h.store.listThreadTurns("sess-inc");
    assert.deepEqual(
      turns.map((turn) => turn.id),
      ["turn-1", "turn-3"],
      "rollback is a rewrite of the same source, not a new thread",
    );
    assert.equal(h.store.listThreads().find((entry) => entry.id === "sess-inc")!.nativeStatus, "completed");
    assert.ok(
      h.store.listEvidencePage("sess-inc", { limit: 100, includeSuperseded: true }).items.some((item) => item.superseded && item.summary === "doomed attempt"),
      "old evidence superseded",
    );
    assert.ok(
      h.store.listEvidencePage("sess-inc", { limit: 100 }).items.some((item) => item.summary === "retry attempt."),
      "new evidence active",
    );

    const snapshot = evidenceSnapshot(h.store, "sess-inc");
    await h.reader.scanNow();
    await h.reader.scanNow();
    assert.deepEqual(evidenceSnapshot(h.store, "sess-inc"), snapshot, "reruns converge to identical state");
  } finally {
    await teardown(h);
  }
});

test("crash convergence and cursor restore: reopening the database resumes incrementally without duplicate evidence", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-crash.jsonl");
    await writeBumped(path, twoTurnFile().text());
    await h.reader.scanNow();
    const before = evidenceSnapshot(h.store, "sess-inc");
    h.store.db.close();

    // 模拟重启：新 Store + 新 reader（游标来自持久化的 reader_sources）
    const { db } = await openStateDb(join(h.home.root, "taskboard.sqlite"));
    const store = new Store(db);
    const reader = new RolloutReader(store, {
      sessionsDir: h.home.sessionsDir,
      archivedDir: h.home.archivedDir,
      scanIntervalMs: 0,
    });
    try {
      await reader.scanNow();
      assert.deepEqual(evidenceSnapshot(store, "sess-inc"), before, "rescan after restart is a no-op");

      await appendBumped(
        path,
        `${taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:00:04Z"))}\n${taskComplete(5, "turn-2", Date.parse("2026-10-01T08:00:05Z"))}\n`,
      );
      await reader.scanNow();
      const turns = store.listThreadTurns("sess-inc");
      assert.deepEqual(turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
      const snapshot = evidenceSnapshot(store, "sess-inc");
      await reader.scanNow();
      assert.deepEqual(evidenceSnapshot(store, "sess-inc"), snapshot);
    } finally {
      await reader.stop();
      db.close();
    }
  } finally {
    await teardown(h);
  }
});

// ---- 目录移动 / zst / fork / subagent ----

test("A7: moving a rollout between sessions and archived_sessions keeps cursor and evidence idempotent", async () => {
  const h = await boot();
  try {
    const original = join(h.home.sessionsDir, "rollout-mv.jsonl");
    await writeBumped(original, twoTurnFile().text());
    await h.reader.scanNow();
    const before = evidenceSnapshot(h.store, "sess-inc");
    const sourceBefore = h.store.listReaderSources()[0]!;
    assert.equal(sourceBefore.path, original);

    // rename 同一文件系统：inode 不变
    const { mkdir } = await import("node:fs/promises");
    await mkdir(h.home.archivedDir, { recursive: true });
    const moved = join(h.home.archivedDir, "rollout-mv.jsonl");
    await rename(original, moved);
    await h.reader.scanNow();

    const source = h.store.listReaderSources()[0]!;
    assert.equal(source.sourceId, sourceBefore.sourceId, "inode-primary source identity survives the move");
    assert.equal(source.consumedBytes, sourceBefore.consumedBytes, "cursor survives the move");
    assert.equal(source.path, moved, "path is an attribute, updated in place");
    assert.deepEqual(evidenceSnapshot(h.store, "sess-inc"), before, "evidence untouched by the move");

    await appendBumped(moved, `${taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:00:04Z"))}\n${taskComplete(5, "turn-2", Date.parse("2026-10-01T08:00:05Z"))}\n`);
    await h.reader.scanNow();
    assert.deepEqual(
      h.store.listThreadTurns("sess-inc").map((turn) => turn.id),
      ["turn-1", "turn-2"],
      "incremental continues at the moved path",
    );
  } finally {
    await teardown(h);
  }
});

test("A2/story 24: compressed rollouts (.jsonl.zst) are readable and re-read only when size or mtime changes", async () => {
  const h = await boot();
  try {
    const zstPath = join(h.home.archivedDir, "rollout-z.jsonl.zst");
    await writeZst(zstPath, twoTurnFile().text());
    await h.reader.scanNow();

    assert.equal(h.store.listThreads().find((entry) => entry.id === "sess-inc")!.nativeStatus, "completed");
    const cursor = h.store.listReaderSources()[0]!;
    assert.equal(cursor.path, zstPath);

    await h.reader.scanNow(); // size+mtime 未变：不解压重读，游标与证据不变
    const unchanged = h.store.listReaderSources()[0]!;
    assert.deepEqual(unchanged, cursor);

    // 追加后重新压缩 + 新 mtime：增量读出新 turn
    const grown = twoTurnFile().add(
      taskStarted(4, "turn-2", {}, Date.parse("2026-10-01T08:00:04Z")),
      taskComplete(5, "turn-2", Date.parse("2026-10-01T08:00:05Z")),
    );
    await writeZst(zstPath, grown.text());
    mtimeCounter += 60_000;
    const t = new Date(mtimeCounter);
    await utimes(zstPath, t, t);
    await h.reader.scanNow();

    assert.deepEqual(
      h.store.listThreadTurns("sess-inc").map((turn) => turn.id),
      ["turn-1", "turn-2"],
    );
  } finally {
    await teardown(h);
  }
});

test("单文件读失败经 progress() 暴露路径与原因；文件恢复后条目清除", async () => {
  const h = await boot();
  try {
    const badPath = join(h.home.archivedDir, "rollout-bad.jsonl.zst");
    await mkdir(h.home.archivedDir, { recursive: true });
    await writeFile(badPath, Buffer.from("definitely not zstd"));
    const summary = await h.reader.scanNow();
    assert.equal(summary.failed, 1, "损坏 zst 记为 failed");
    const reported = h.reader.progress().fileErrors.find((entry) => entry.path === badPath);
    assert.ok(reported !== undefined, "progress 必须暴露失败文件的路径（此前只有 failed 计数）");
    assert.ok(reported.message.length > 0, "progress 必须暴露失败原因");

    // 文件自愈（重新写成合法 zst）后：成功即清除该路径的错误条目，不残留过期告警
    await writeZst(badPath, twoTurnFile().text());
    const recovered = await h.reader.scanNow();
    assert.equal(recovered.failed, 0);
    assert.equal(
      h.reader.progress().fileErrors.some((entry) => entry.path === badPath),
      false,
      "文件恢复后错误条目应清除",
    );
  } finally {
    await teardown(h);
  }
});

test("story 21 fork: a forked rollout is an independent thread joined only by lineage evidence", async () => {
  const h = await boot();
  try {
    await writeBumped(join(h.home.sessionsDir, "rollout-parent.jsonl"), twoTurnFile().text());
    // fork：新 session id + parent_thread_id，无 subagent 标记
    await writeBumped(
      join(h.home.sessionsDir, "rollout-fork.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-fork", parentThreadId: "sess-inc" }, Date.parse("2026-10-01T08:10:00Z")),
        taskStarted(1, "fork-turn-1", {}, Date.parse("2026-10-01T08:10:01Z")),
        taskComplete(2, "fork-turn-1", Date.parse("2026-10-01T08:10:02Z")),
      ).text(),
    );
    await h.reader.scanNow();

    const { db } = { db: h.store.db };
    const lineage = db.prepare("SELECT * FROM thread_lineage").all() as Array<{
      thread_id: string;
      parent_thread_id: string;
      relation: string;
    }>;
    assert.deepEqual(
      lineage.map((edge) => [edge.thread_id, edge.parent_thread_id, edge.relation]),
      [["sess-fork", "sess-inc", "fork"]],
    );
    // fork 的 turn 不并入父 thread
    assert.deepEqual(
      h.store.listThreadTurns("sess-inc").map((turn) => turn.id),
      ["turn-1"],
    );
    assert.deepEqual(
      h.store.listThreadTurns("sess-fork").map((turn) => turn.id),
      ["fork-turn-1"],
    );
  } finally {
    await teardown(h);
  }
});

test("story 21 subagent: whole-file subagent threads carry lineage; embedded subagent segments stay out of the main turn sequence", async () => {
  const h = await boot();
  try {
    // (a) 独立子代理文件：thread_source=subagent + source.subagent.thread_spawn
    await writeBumped(
      join(h.home.sessionsDir, "rollout-sub.jsonl"),
      new RolloutFile(
        sessionMeta(0, {
          sessionId: "sess-sub",
          threadSource: "subagent",
          subagentSpawn: { parentThreadId: "sess-main", depth: 1, nickname: "Hubble" },
        }, Date.parse("2026-10-01T08:20:00Z")),
        taskStarted(1, "sub-turn-1", {}, Date.parse("2026-10-01T08:20:01Z")),
        taskComplete(2, "sub-turn-1", Date.parse("2026-10-01T08:20:02Z")),
      ).text(),
    );
    // (b) 主线程文件内嵌 subagent 段：turn-2 是 subagent turn，turn-3 回到主线程
    await writeBumped(
      join(h.home.sessionsDir, "rollout-main.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-main" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
        userMessageItem(2, "turn-1", "dispatch a worker", { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:02Z")),
        taskComplete(3, "turn-1", Date.parse("2026-10-01T08:00:03Z")),
        taskStarted(4, "sub-embedded-1", { subagent: true }, Date.parse("2026-10-01T08:00:04Z")),
        userMessageItem(5, "sub-embedded-1", "worker internal prompt", { turnId: "sub-embedded-1" }, Date.parse("2026-10-01T08:00:05Z")),
        taskComplete(6, "sub-embedded-1", Date.parse("2026-10-01T08:00:06Z")),
        taskStarted(7, "turn-3", {}, Date.parse("2026-10-01T08:00:07Z")),
        taskComplete(8, "turn-3", Date.parse("2026-10-01T08:00:08Z")),
      ).text(),
    );
    await h.reader.scanNow();

    const { db } = { db: h.store.db };
    const lineage = db
      .prepare("SELECT thread_id, relation FROM thread_lineage WHERE parent_thread_id = 'sess-main' ORDER BY thread_id")
      .all() as Array<{ thread_id: string; relation: string }>;
    assert.equal(lineage.length, 1);
    assert.equal(lineage[0]!.thread_id, "sess-sub");
    assert.equal(lineage[0]!.relation, "subagent");

    // 嵌入段 turn 不进主 thread turn 序列（goal 轮数与 expected_turn_id 校验不因此错位）
    assert.deepEqual(
      h.store.listThreadTurns("sess-main").map((turn) => turn.id),
      ["turn-1", "turn-3"],
    );
    // 独立子代理线程的 turn 属于它自己的 thread
    assert.deepEqual(
      h.store.listThreadTurns("sess-sub").map((turn) => turn.id),
      ["sub-turn-1"],
    );
    // 嵌入段内容以 subagent 标注的证据落库，归属被隔离
    const subEvidence = h.store
      .listEvidencePage("sess-main", { limit: 100 })
      .items.filter((item) => item.kind === "subagent_turn" || item.props?.subagent !== undefined);
    const subTurn = subEvidence.find((item) => item.kind === "subagent_turn")!;
    assert.equal(subTurn.props!.turnId, "sub-embedded-1");
    assert.equal(subTurn.props!.startOrdinal, 4);
    const workerMessage = subEvidence.find((item) => item.kind === "message")!;
    assert.equal(workerMessage.summary, "worker internal prompt");
    assert.equal(workerMessage.turnOrdinal, null, "subagent items carry no main-thread turn ordinal");
    assert.deepEqual(
      (workerMessage.props!.subagent as { turnId: string }).turnId,
      "sub-embedded-1",
    );
  } finally {
    await teardown(h);
  }
});

test("A5: a turn opened in an earlier scan completes in a pure append window, flipping thread native status", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-span-large.jsonl");
    const filler = "跨扫描收口填充内容。".repeat(400);
    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-span-large" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
        userMessageItem(2, "turn-1", filler, { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:02Z")),
      ).text(),
    );
    await h.reader.scanNow();
    assert.equal(h.store.listThreads().find((entry) => entry.id === "sess-span-large")!.nativeStatus, "running");

    await appendBumped(path, `${taskComplete(3, "turn-1", Date.parse("2026-10-01T08:05:00Z"))}\n`);
    await h.reader.scanNow();

    const turns = h.store.listThreadTurns("sess-span-large");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.nativeStatus, "completed");
    assert.ok(turns[0]!.startedAt !== null, "started_at preserved across passes");
    assert.equal(
      h.store.listThreads().find((entry) => entry.id === "sess-span-large")!.nativeStatus,
      "completed",
      "cross-scan close is a turn sighting: thread must not stay running forever",
    );
  } finally {
    await teardown(h);
  }
});

test("story 21 subagent: a segment turn completed in a later scan never enters the main turn sequence", async () => {
  const h = await boot();
  try {
    const path = join(h.home.sessionsDir, "rollout-seg-span.jsonl");
    const filler = "段隔离填充内容。".repeat(400);
    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-seg-main" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
        userMessageItem(2, "turn-1", filler, { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:02Z")),
        taskComplete(3, "turn-1", Date.parse("2026-10-01T08:00:03Z")),
        taskStarted(4, "sub-span-1", { subagent: true }, Date.parse("2026-10-01T08:00:04Z")),
      ).text(),
    );
    await h.reader.scanNow();
    assert.deepEqual(h.store.listThreadTurns("sess-seg-main").map((turn) => turn.id), ["turn-1"]);

    // 段的 task_complete 落在下一个纯增量窗口：不得当作主 thread turn 注入序列
    await appendBumped(path, `${taskComplete(5, "sub-span-1", Date.parse("2026-10-01T08:00:06Z"))}\n`);
    await h.reader.scanNow();

    assert.deepEqual(
      h.store.listThreadTurns("sess-seg-main").map((turn) => turn.id),
      ["turn-1"],
      "embedded segment turn stays out of the main sequence across scans",
    );
    assert.equal(
      h.store.listThreads().find((entry) => entry.id === "sess-seg-main")!.nativeStatus,
      "completed",
    );
  } finally {
    await teardown(h);
  }
});

test("story 21 subagent: segment evidence follows the session that opened the segment, not the file tail", async () => {
  const h = await boot();
  try {
    // 文件中途切会话（resume/fork 落进同一文件）：段打开于 sess-seg-owner，收口在 sess-seg-tail
    await writeBumped(
      join(h.home.sessionsDir, "rollout-seg-owner.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-seg-owner" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "sub-owner-1", { subagent: true }, Date.parse("2026-10-01T08:00:01Z")),
        sessionMeta(2, { sessionId: "sess-seg-tail" }, Date.parse("2026-10-01T08:00:02Z")),
        taskComplete(3, "sub-owner-1", Date.parse("2026-10-01T08:00:03Z")),
      ).text(),
    );
    await h.reader.scanNow();

    const ownerSub = h.store
      .listEvidencePage("sess-seg-owner", { limit: 100 })
      .items.filter((item) => item.kind === "subagent_turn");
    assert.equal(ownerSub.length, 1, "segment evidence belongs to the session that opened it");
    assert.equal(ownerSub[0]!.props!.turnId, "sub-owner-1");
    assert.equal(
      h.store.listEvidencePage("sess-seg-tail", { limit: 100 }).items.some((item) => item.kind === "subagent_turn"),
      false,
      "tail session must not inherit segment evidence",
    );
  } finally {
    await teardown(h);
  }
});

test("A5: a multi-session new source seeds every session's turn state — replayed ordinals never collide across sources", async () => {
  const h = await boot();
  try {
    // source S1：session A 已有 turn-1 (ordinal 0)
    await writeBumped(
      join(h.home.sessionsDir, "rollout-ms-1.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-ms-a" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
        taskComplete(2, "turn-1", Date.parse("2026-10-01T08:00:02Z")),
      ).text(),
    );
    await h.reader.scanNow();

    // source S2：文件先 A 的续写再切 B。A 的 turn-2 若从 0 重编会撞 S1 的 (A, 0)，整个 source 卡死
    await writeBumped(
      join(h.home.sessionsDir, "rollout-ms-2.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-ms-a" }, Date.parse("2026-10-01T08:10:00Z")),
        taskStarted(1, "turn-2", {}, Date.parse("2026-10-01T08:10:01Z")),
        taskComplete(2, "turn-2", Date.parse("2026-10-01T08:10:02Z")),
        sessionMeta(3, { sessionId: "sess-ms-b" }, Date.parse("2026-10-01T08:10:03Z")),
        taskStarted(4, "turn-3", {}, Date.parse("2026-10-01T08:10:04Z")),
        taskComplete(5, "turn-3", Date.parse("2026-10-01T08:10:05Z")),
      ).text(),
    );
    await h.reader.scanNow();

    assert.equal(h.store.listReaderSources().length, 2, "S2 must commit instead of failing forever");
    assert.deepEqual(
      h.store.listThreadTurns("sess-ms-a").map((turn) => [turn.id, turn.ordinal]),
      [
        ["turn-1", 0],
        ["turn-2", 1],
      ],
    );
    assert.deepEqual(
      h.store.listThreadTurns("sess-ms-b").map((turn) => [turn.id, turn.ordinal]),
      [["turn-3", 0]],
    );
  } finally {
    await teardown(h);
  }
});

test("A2: context/usage evidence preceding its task_started back-fills the turn ordinal in the same parse", async () => {
  const h = await boot();
  try {
    await writeBumped(
      join(h.home.sessionsDir, "rollout-usage-first.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-usage-first" }, Date.parse("2026-10-01T08:00:00Z")),
        tokenUsageRecord(
          1,
          "turn-u",
          { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 15 },
          Date.parse("2026-10-01T08:00:01Z"),
        ),
        taskStarted(2, "turn-u", {}, Date.parse("2026-10-01T08:00:02Z")),
        taskComplete(3, "turn-u", Date.parse("2026-10-01T08:00:03Z")),
      ).text(),
    );
    await h.reader.scanNow();

    const usage = h.store
      .listEvidencePage("sess-usage-first", { limit: 100 })
      .items.find((item) => item.kind === "token_usage");
    assert.ok(usage !== undefined, "usage evidence lands");
    assert.equal(usage!.turnOrdinal, 0, "usage record links to its turn even when it arrived first");
  } finally {
    await teardown(h);
  }
});

// ---- daemon 装配 / HTTP 分页 / A32 保留策略 ----

test("A2: daemon is ready before the initial scan finishes; periodic cycle and manual refresh pick up new rollouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tb-reader-daemon-"));
  tmpDirs.push(root);
  const sessionsDir = join(root, "sessions");
  await writeText(
    join(sessionsDir, "rollout-1.jsonl"),
    new RolloutFile(
      sessionMeta(0, { sessionId: "sess-daemon-1" }, Date.parse("2026-10-01T08:00:00Z")),
      taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
      taskComplete(2, "turn-1", Date.parse("2026-10-01T08:00:02Z")),
    ).text(),
  );
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(root, "taskboard.sqlite"),
    codexHome: root,
    scanIntervalMs: 30,
  });
  daemons.push(daemon);
  try {
    // daemon 就绪不等待扫描：state 立即可读且 phase 不再是 unavailable
    const early = await getJson<{ runtime: { scan: { phase: string } }; inbox: unknown[] }>(
      `http://127.0.0.1:${daemon.port}/api/state`,
    );
    assert.notEqual(early.runtime.scan.phase, "unavailable");
    assert.ok(["idle", "running", "done"].includes(early.runtime.scan.phase));

    const inboxFilled = async (): Promise<boolean> => {
      const state = await getJson<{ inbox: unknown[]; runtime: { scan: { phase: string } } }>(
        `http://127.0.0.1:${daemon.port}/api/state`,
      );
      return state.runtime.scan.phase === "done" && state.inbox.length === 1;
    };
    assert.ok(await until(inboxFilled), "periodic scan brings the rollout into the inbox");

    // 手动 refresh：新文件立即扫描，不等周期
    await writeText(
      join(sessionsDir, "rollout-2.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-daemon-2" }, Date.parse("2026-10-01T08:05:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:05:01Z")),
        taskComplete(2, "turn-1", Date.parse("2026-10-01T08:05:02Z")),
      ).text(),
    );
    const refreshed = await postJson(daemon.port, "/api/actions", {
      type: "scan.refresh",
      requestId: "test-refresh-1",
    });
    assert.equal(refreshed.status, 200);
    const state = await getJson<{ inbox: unknown[]; runtime: { scan: { phase: string; sources: number } } }>(
      `http://127.0.0.1:${daemon.port}/api/state`,
    );
    assert.equal(state.inbox.length, 2, "manual refresh scans immediately");
    assert.equal(state.runtime.scan.sources, 2);
  } finally {
    await daemon.close();
    daemons.pop();
  }
});

test("GET /api/threads/:id/turns and /evidence paginate with an opaque cursor (R↔U contract shape)", async () => {
  const h = await boot();
  try {
    const lines: RolloutFile = new RolloutFile(
      sessionMeta(0, { sessionId: "sess-page" }, Date.parse("2026-10-01T08:00:00Z")),
    );
    for (let i = 1; i <= 7; i += 1) {
      lines.add(
        taskStarted(i * 2 - 1, `turn-${i}`, {}, Date.parse(`2026-10-01T08:0${i}:00Z`)),
        taskComplete(i * 2, `turn-${i}`, Date.parse(`2026-10-01T08:0${i}:01Z`)),
      );
    }
    await writeText(join(h.home.sessionsDir, "rollout-p.jsonl"), lines.text());
    await h.reader.scanNow();

    const server = startHttp(h.store);
    const port = await new Promise<number>((resolve) => {
      server.server.listen(0, "127.0.0.1", () => {
        const address = server.server.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });
    servers.push(server);
    const base = `http://127.0.0.1:${port}`;

    const page1 = await getJson<{ ok: boolean; items: Array<{ id: string }>; nextCursor: string | null }>(
      `${base}/api/threads/sess-page/turns?limit=3`,
    );
    assert.equal(page1.items.length, 3);
    assert.equal(page1.nextCursor, "3");
    const page2 = await getJson<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      `${base}/api/threads/sess-page/turns?limit=3&cursor=${page1.nextCursor}`,
    );
    assert.deepEqual(
      [...page1.items, ...page2.items].map((turn) => turn.id),
      ["turn-1", "turn-2", "turn-3", "turn-4", "turn-5", "turn-6"],
    );
    const page3 = await getJson<{ items: unknown[]; nextCursor: string | null }>(
      `${base}/api/threads/sess-page/turns?limit=3&cursor=${page2.nextCursor}`,
    );
    assert.equal(page3.items.length, 1);
    assert.equal(page3.nextCursor, null);

    const evidence = await getJson<{ ok: boolean; items: Array<{ kind: string; source: { byteStart: number; recordHash: string } }> }>(
      `${base}/api/threads/sess-page/evidence?limit=2`,
    );
    assert.ok(evidence.items.length <= 2);
    assert.ok(evidence.items.every((item) => item.source.recordHash.length === 64));
    // 未知线程 404
    const missing = await fetch(`${base}/api/threads/nope/turns`);
    assert.equal(missing.status, 404);
  } finally {
    await teardown(h);
  }
});

test("A32: unbound thread evidence expires per the configured threshold; bound thread evidence is kept", async () => {
  const root = await mkdtemp(join(tmpdir(), "tb-reader-retention-"));
  tmpDirs.push(root);
  const home: CodexHome = {
    root,
    sessionsDir: join(root, "sessions"),
    archivedDir: join(root, "archived_sessions"),
  };
  let clock = Date.parse("2026-10-01T08:00:00Z");
  const { db } = await openStateDb(join(root, "taskboard.sqlite"));
  const store = new Store(db, { now: () => clock });
  const reader = new RolloutReader(store, {
    sessionsDir: home.sessionsDir,
    archivedDir: home.archivedDir,
    scanIntervalMs: 0,
    now: () => clock,
  });
  try {
    store.updateSettings({
      retention: { runsPerTask: 20, unboundEvidenceDays: 1, boundEvidenceDays: 90 },
    });
    const path = join(home.sessionsDir, "rollout-ret.jsonl");
    await writeBumped(
      path,
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-ret" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "turn-1", {}, Date.parse("2026-10-01T08:00:01Z")),
        userMessageItem(2, "turn-1", "old message", { turnId: "turn-1" }, Date.parse("2026-10-01T08:00:02Z")),
        taskComplete(3, "turn-1", Date.parse("2026-10-01T08:00:03Z")),
      ).text(),
    );
    await reader.scanNow();
    assert.ok(store.listEvidencePage("sess-ret", { limit: 10 }).items.length >= 1);

    // 推进 2 天并追加：上一轮证据过期（未绑定，阈值 1 天），新证据保留
    clock = Date.parse("2026-10-03T08:00:00Z");
    await appendBumped(
      path,
      [
        taskStarted(4, "turn-2", {}, Date.parse("2026-10-03T08:00:01Z")),
        userMessageItem(5, "turn-2", "fresh message", { turnId: "turn-2" }, Date.parse("2026-10-03T08:00:02Z")),
        taskComplete(6, "turn-2", Date.parse("2026-10-03T08:00:03Z")),
      ]
        .map((line) => `${line}\n`)
        .join(""),
    );
    await reader.scanNow();
    const afterExpiry = store.listEvidencePage("sess-ret", { limit: 100, includeSuperseded: true }).items;
    assert.ok(!JSON.stringify(afterExpiry).includes("old message"), "expired unbound evidence cleaned");
    assert.equal(afterExpiry.length > 0, true, "fresh evidence kept");

    // 绑定后：证据不再按未绑定阈值清理
    clock = Date.parse("2026-10-05T08:00:00Z");
    const task = store.createTask({
      title: "bound",
      prompt: "",
      workspace: "/tmp/ws",
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
    store.db
      .prepare("INSERT INTO task_threads (task_id, thread_id, role, bound_at) VALUES (?, ?, 'primary', ?)")
      .run(task.id, "sess-ret", clock);
    clock = Date.parse("2026-10-09T08:00:00Z");
    await reader.scanNow();
    const kept = store.listEvidencePage("sess-ret", { limit: 100, includeSuperseded: true }).items;
    assert.ok(kept.length > 0, "bound thread evidence survives the sweep");
  } finally {
    await reader.stop();
    db.close();
  }
});

test("story 21: a rollout file that switches session mid-file attributes each segment to its own thread", async () => {
  const h = await boot();
  try {
    // 真机形态：resume/fork 落进同一文件时 session_meta 会出现两次
    await writeBumped(
      join(h.home.sessionsDir, "rollout-switch.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-first" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "first-turn", {}, Date.parse("2026-10-01T08:00:01Z")),
        userMessageItem(2, "first-turn", "original thread work", { turnId: "first-turn" }, Date.parse("2026-10-01T08:00:02Z")),
        taskComplete(3, "first-turn", Date.parse("2026-10-01T08:00:03Z")),
        sessionMeta(4, { sessionId: "sess-second", parentThreadId: "sess-first" }, Date.parse("2026-10-01T08:01:00Z")),
        taskStarted(5, "second-turn", {}, Date.parse("2026-10-01T08:01:01Z")),
        userMessageItem(6, "second-turn", "continued in new session", { turnId: "second-turn" }, Date.parse("2026-10-01T08:01:02Z")),
        taskComplete(7, "second-turn", Date.parse("2026-10-01T08:01:03Z")),
      ).text(),
    );
    const result = await h.reader.scanNow();
    assert.equal(result.failed, 0, "session switch must not fail the file");

    assert.deepEqual(
      h.store.listThreadTurns("sess-first").map((turn) => [turn.id, turn.ordinal]),
      [["first-turn", 0]],
    );
    assert.deepEqual(
      h.store.listThreadTurns("sess-second").map((turn) => [turn.id, turn.ordinal]),
      [["second-turn", 0]],
    );
    // 消息归属各自的 thread；游标行跟随文件尾部的 session
    const firstMessage = h.store
      .listEvidencePage("sess-first", { limit: 10 })
      .items.find((item) => item.kind === "message")!;
    assert.equal(firstMessage.summary, "original thread work");
    const secondMessage = h.store
      .listEvidencePage("sess-second", { limit: 10 })
      .items.find((item) => item.kind === "message")!;
    assert.equal(secondMessage.summary, "continued in new session");
    assert.equal(h.store.listReaderSources()[0]!.threadId, "sess-second");
    // 重跑收敛
    await h.reader.scanNow();
    assert.deepEqual(
      h.store.listThreadTurns("sess-first").map((turn) => turn.id),
      ["first-turn"],
    );
  } finally {
    await teardown(h);
  }
});

test("story 21: a turn id replayed in a sibling session's rollout migrates to its owning thread without collisions", async () => {
  const h = await boot();
  try {
    // 真机形态：旧 thread 的文件重放了新 thread 的 turn（同一 turn id 出现在两个文件）
    const shared = taskStarted(9, "shared-turn", {}, Date.parse("2026-10-01T08:02:00Z"));
    await writeBumped(
      join(h.home.sessionsDir, "rollout-old.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-old" }, Date.parse("2026-10-01T08:00:00Z")),
        taskStarted(1, "old-turn", {}, Date.parse("2026-10-01T08:00:01Z")),
        taskComplete(2, "old-turn", Date.parse("2026-10-01T08:00:02Z")),
        shared,
        taskComplete(10, "shared-turn", Date.parse("2026-10-01T08:02:01Z")),
      ).text(),
    );
    await writeBumped(
      join(h.home.sessionsDir, "rollout-owner.jsonl"),
      new RolloutFile(
        sessionMeta(0, { sessionId: "sess-owner" }, Date.parse("2026-10-01T08:01:00Z")),
        taskStarted(1, "shared-turn", {}, Date.parse("2026-10-01T08:02:00Z")),
        userMessageItem(2, "shared-turn", "owned here", { turnId: "shared-turn" }, Date.parse("2026-10-01T08:02:01Z")),
        taskComplete(3, "shared-turn", Date.parse("2026-10-01T08:02:02Z")),
      ).text(),
    );
    const result = await h.reader.scanNow();
    assert.equal(result.failed, 0);
    // turn 归属 owning thread；旧 thread 只留自己的 turn
    assert.deepEqual(
      h.store.listThreadTurns("sess-owner").map((turn) => turn.id),
      ["shared-turn"],
    );
    assert.deepEqual(
      h.store.listThreadTurns("sess-old").map((turn) => turn.id),
      ["old-turn"],
    );
    // 重跑收敛（扫描顺序确定 → 重放归属确定）
    await h.reader.scanNow();
    assert.deepEqual(
      h.store.listThreadTurns("sess-owner").map((turn) => turn.id),
      ["shared-turn"],
    );
  } finally {
    await teardown(h);
  }
});
