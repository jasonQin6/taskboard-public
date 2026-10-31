import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { CodexAdapter, CODEX_PROVENANCE } from "../src/harness/codex/adapter.js";
import type { HarnessAdapter } from "../src/harness/contract.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { Store } from "../src/store/index.js";
import {
  RolloutFile,
  rec,
  sessionMeta,
  taskComplete,
  taskStarted,
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
  const root = await mkdtemp(join(tmpdir(), "tb-harness-"));
  tmpDirs.push(root);
  return {
    root,
    sessionsDir: join(root, "sessions"),
    archivedDir: join(root, "archived_sessions"),
  };
};

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const keysOf = (value: object): string[] => Object.keys(value).sort();

const fixedFixture = (sessionId: string): RolloutFile => {
  const meta = sessionMeta(0, { sessionId, cwd: "/tmp/workspace/alpha" }, Date.parse("2026-10-26T01:00:00Z"));
  return new RolloutFile(
    meta,
    taskStarted(1, "turn-1", {}, Date.parse("2026-10-26T01:00:01Z")),
    userMessageItem(
      2,
      "turn-1",
      "实现只读观察闭环",
      { threadId: sessionId },
      Date.parse("2026-10-26T01:00:02Z"),
    ),
    taskComplete(3, "turn-1", Date.parse("2026-10-26T01:00:03Z")),
  );
};

test("Codex adapter: fixed fixture yields a native snapshot with cursor, locator, and stable field sets", async () => {
  const home = await makeHome();
  const dbPath = join(home.root, "taskboard.sqlite");
  const { db } = await openStateDb(dbPath);
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  const text = fixedFixture("sess-contract").text();
  const path = join(home.sessionsDir, "rollout-contract.jsonl");
  await writeText(path, text);
  const before = await stat(path);

  try {
    await adapter.scanNow();
    const observation = new HarnessRegistry([adapter]).observe();
    assert.equal(observation.sessions.length, 1);
    assert.deepEqual(observation.failures, []);
    const session = observation.sessions[0]!;
    const manifest = adapter.capabilityManifest();
    assert.deepEqual(keysOf(manifest), [
      "capabilities",
      "degradations",
      "displayName",
      "harnessId",
      "readOnly",
      "readPaths",
      "schemaVersion",
    ]);
    assert.equal(manifest.readOnly, true);

    assert.deepEqual(keysOf(session), [
      "cursor",
      "harnessId",
      "id",
      "lastActivityAt",
      "locator",
      "nativeGroup",
      "nativeSessionId",
      "nativeStatus",
      "provenance",
      "title",
      "unknownFields",
      "workspace",
    ]);
    assert.equal(session.id, "sess-contract");
    assert.equal(session.harnessId, "codex");
    assert.equal(session.nativeSessionId, "sess-contract");
    assert.equal(session.title, "实现只读观察闭环");
    assert.equal(session.workspace, "/tmp/workspace/alpha");
    assert.equal(session.nativeStatus, "completed");
    assert.equal(session.nativeGroup, "user");
    assert.equal(session.provenance, CODEX_PROVENANCE);
    assert.deepEqual(session.unknownFields, []);
    assert.deepEqual(keysOf(session.locator), [
      "byteStart",
      "harnessId",
      "nativeSessionId",
      "recordHash",
      "sourcePath",
    ]);
    assert.equal(session.locator.sourcePath, path);
    assert.equal(session.locator.byteStart, 0);
    assert.equal(
      session.locator.recordHash,
      sha256(sessionMeta(0, { sessionId: "sess-contract", cwd: "/tmp/workspace/alpha" }, Date.parse("2026-10-26T01:00:00Z"))),
    );
    assert.deepEqual(keysOf(session.cursor!), [
      "contentPosition",
      "parserVersion",
      "prefixHash",
      "sourceUnitId",
      "tailHash",
    ]);
    assert.equal(session.cursor!.contentPosition, Buffer.byteLength(text));

    await adapter.scanNow();
    assert.equal(adapter.observe().sessions.length, 1, "repeated scan must not duplicate sessions");
    const after = await stat(path);
    assert.equal(await readFile(path, "utf8"), text, "observation must not rewrite Codex JSONL");
    assert.equal(after.ino, before.ino);
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("HarnessRegistry converts one adapter failure into a scoped, retryable Failure", () => {
  const broken: HarnessAdapter = {
    capabilityManifest: () => ({
      harnessId: "broken",
      displayName: "Broken",
      schemaVersion: "broken/1",
      readOnly: true,
      capabilities: ["session.list"],
      readPaths: [],
      degradations: ["adapter_failed"],
    }),
    observe: () => {
      throw new Error("socket closed");
    },
  };
  const observation = new HarnessRegistry([broken]).observe();
  assert.deepEqual(observation.sessions, []);
  assert.deepEqual(observation.failures, [
    {
      code: "adapter_failed",
      message: "socket closed",
      scope: { kind: "harness", harnessId: "broken" },
      retryable: true,
    },
  ]);
});

test("unknown Codex fields degrade to unknown without guessing or blocking the session", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  await writeText(
    join(home.sessionsDir, "rollout-unknown.jsonl"),
    `${rec(0, "session_meta", { session_id: "sess-unknown", id: "sess-unknown" })}\n`,
  );

  try {
    await adapter.scanNow();
    const observation = adapter.observe();
    assert.equal(observation.sessions.length, 1);
    const session = observation.sessions[0]!;
    assert.equal(session.nativeStatus, "unknown");
    assert.equal(session.title, null);
    assert.equal(session.workspace, null);
    assert.equal(session.nativeGroup, null);
    assert.deepEqual(session.unknownFields.sort(), ["nativeGroup", "nativeStatus", "title", "workspace"]);
    assert.notEqual(session.locator.recordHash, null, "unknown fields do not erase the source record identity");
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("daemon state exposes the fixed Codex fixture as an idempotent observed session", async () => {
  const home = await makeHome();
  const fixture = fixedFixture("sess-daemon");
  await writeText(join(home.sessionsDir, "rollout-daemon.jsonl"), fixture.text());
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(home.root, "taskboard.sqlite"),
    codexHome: home.root,
    scanIntervalMs: 0,
  });
  daemons.push(daemon);
  await daemon.harnesses.scanNow();

  const readState = async (): Promise<{
    sessions: Array<Record<string, unknown>>;
    failures: unknown[];
  }> => (await (await fetch(`http://127.0.0.1:${daemon.port}/api/state`)).json()) as never;
  const first = await readState();
  assert.equal(first.sessions.length, 1);
  assert.deepEqual(first.failures, []);
  assert.equal(first.sessions[0]!.nativeSessionId, "sess-daemon");
  assert.equal(first.sessions[0]!.workspace, "/tmp/workspace/alpha");

  await daemon.harnesses.scanNow();
  const second = await readState();
  assert.equal(second.sessions.length, 1, "daemon state must not duplicate a rescanned session");
  assert.equal(second.sessions[0]!.id, first.sessions[0]!.id);
});

// ---- A1: locator 双写与 FailureCode/registry 回归网（纯测试，零行为变更） ----

test("fix-A1: patchReaderSourcePath keeps reader_sources and threads in sync without duplicating threads", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    await writeText(join(home.sessionsDir, "rollout-a1.jsonl"), fixedFixture("sess-a1").text());
    await adapter.scanNow();
    const before = store.listReaderSources()[0]!;
    assert.equal(store.listThreads().length, 1);
    const moved = join(home.sessionsDir, "rollout-a1-renamed.jsonl");
    store.patchReaderSourcePath(before.sourceId, moved);
    assert.equal(store.listReaderSources()[0]!.path, moved);
    assert.equal(store.listObservedSessions("codex")[0]!.sourcePath, moved);
    // 幂等：同参重放不产生新行、不漂移
    store.patchReaderSourcePath(before.sourceId, moved);
    assert.equal(store.listReaderSources().length, 1);
    assert.equal(store.listThreads().length, 1);
    assert.equal(store.listObservedSessions("codex").length, 1);
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("fix-A1: scanner move updates threads.source_path with a single threads row", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    const original = join(home.sessionsDir, "rollout-a1-mv.jsonl");
    await writeText(original, fixedFixture("sess-a1-mv").text());
    await adapter.scanNow();
    assert.equal(store.listObservedSessions("codex")[0]!.sourcePath, original);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(home.archivedDir, { recursive: true });
    const moved = join(home.archivedDir, "rollout-a1-mv.jsonl");
    await rename(original, moved);
    await adapter.scanNow();
    const sources = store.listReaderSources();
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.path, moved);
    const observed = store.listObservedSessions("codex");
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.sourcePath, moved);
    assert.equal(store.listThreads().length, 1);
    await adapter.scanNow();
    assert.equal(adapter.observe().sessions.length, 1, "rescan after move must stay idempotent");
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("fix-A1: null byteStart/recordHash yields source_locator_incomplete while the session stays visible", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    await writeText(join(home.sessionsDir, "rollout-a1-loc.jsonl"), fixedFixture("sess-a1-loc").text());
    await adapter.scanNow();
    // source_path 置空会使行消失于 listObservedSessions（WHERE source_path IS NOT NULL），
    // 因此 locator 缺失回归只清 byteStart/recordHash，保持会话可见
    db.prepare("UPDATE threads SET source_byte_start = NULL, source_record_hash = NULL WHERE id = 'sess-a1-loc'").run();
    const observation = adapter.observe();
    assert.equal(observation.sessions.length, 1);
    assert.equal(observation.sessions[0]!.locator.byteStart, null);
    assert.equal(observation.sessions[0]!.locator.recordHash, null);
    const failure = observation.failures.find((entry) => entry.code === "source_locator_incomplete");
    assert.notEqual(failure, undefined);
    assert.deepEqual(failure!.scope, { kind: "session", harnessId: "codex", nativeSessionId: "sess-a1-loc" });
    assert.equal(failure!.retryable, true);
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("fix-A1: illegal native_status with CHECK bypassed degrades to unknown_native_status", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    await writeText(join(home.sessionsDir, "rollout-a1-st.jsonl"), fixedFixture("sess-a1-st").text());
    await adapter.scanNow();
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare("UPDATE threads SET native_status = 'bogus' WHERE id = 'sess-a1-st'").run();
    const observation = adapter.observe();
    assert.equal(observation.sessions.length, 1);
    assert.equal(observation.sessions[0]!.nativeStatus, "unknown");
    const failure = observation.failures.find((entry) => entry.code === "unknown_native_status");
    assert.notEqual(failure, undefined);
    assert.deepEqual(failure!.scope, { kind: "session", harnessId: "codex", nativeSessionId: "sess-a1-st" });
    assert.equal(failure!.retryable, false);
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("fix-A1: broken zst surfaces source_unreadable without blocking healthy sessions", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    await writeText(join(home.sessionsDir, "rollout-a1-ok.jsonl"), fixedFixture("sess-a1-ok").text());
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(home.archivedDir, { recursive: true });
    await writeFile(join(home.archivedDir, "rollout-a1-broken.jsonl.zst"), "not-zstd-bytes\n", "utf8");
    await adapter.scanNow();
    const observation = adapter.observe();
    assert.equal(observation.sessions.length, 1);
    assert.equal(observation.sessions[0]!.nativeSessionId, "sess-a1-ok");
    const failure = observation.failures.find((entry) => entry.code === "source_unreadable");
    assert.notEqual(failure, undefined);
    assert.equal(failure!.scope.kind, "source");
    assert.equal(failure!.retryable, true);
    // fileErrors 已收进 adapter 内部：对外只断言扫描收敛且健康会话不受影响
    assert.equal(adapter.progress().phase, "done");
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("fix-A1: HarnessRegistry rejects duplicate harness ids", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const first = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  const second = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    assert.throws(() => new HarnessRegistry([first, second]), /duplicate harness adapter/);
  } finally {
    await first.stop();
    await second.stop();
    db.close();
  }
});

test("fix-A3: latestReaderSourceByThread matches legacy latest-wins grouping with sourceId tiebreak", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    await writeText(join(home.sessionsDir, "rollout-a3-a.jsonl"), fixedFixture("sess-a3-a").text());
    await writeText(join(home.sessionsDir, "rollout-a3-b.jsonl"), fixedFixture("sess-a3-b").text());
    await adapter.scanNow();
    const ids = store.listReaderSources().map((source) => source.sourceId).sort();
    assert.equal(ids.length, 2);
    const [lo, hi] = ids as [string, string];
    // 同 thread、同 updatedAt：tiebreak 取 source_id 大者
    db.prepare("UPDATE reader_sources SET thread_id = 'sess-shared', updated_at = 1000").run();
    const tied = store.latestReaderSourceByThread();
    assert.equal(tied.size, 1);
    assert.equal(tied.get("sess-shared")!.sourceId, hi);
    // 时间戳优先：updatedAt 大者胜，即使 source_id 更小
    db.prepare("UPDATE reader_sources SET updated_at = 2000 WHERE source_id = ?").run(lo);
    const timed = store.latestReaderSourceByThread();
    assert.equal(timed.get("sess-shared")!.sourceId, lo);
    // 与旧手写分组逐键一致
    const sources = store.listReaderSources();
    const legacy = new Map<string, (typeof sources)[number]>();
    for (const source of sources) {
      const current = legacy.get(source.threadId);
      if (
        current === undefined ||
        source.updatedAt > current.updatedAt ||
        (source.updatedAt === current.updatedAt && source.sourceId > current.sourceId)
      ) {
        legacy.set(source.threadId, source);
      }
    }
    assert.equal(timed.size, legacy.size);
    for (const [key, value] of legacy) assert.deepEqual(timed.get(key), value);
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("fix-B1: adapter lifecycle delegates start/scanNow/progress/stop to the encapsulated reader", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    await writeText(join(home.sessionsDir, "rollout-b1.jsonl"), fixedFixture("sess-b1").text());
    const summary = (await adapter.scanNow()) as { filesTotal: number; changed: number };
    assert.equal(summary.filesTotal, 1);
    assert.equal(summary.changed, 1);
    const progress = adapter.progress();
    assert.deepEqual(keysOf(progress), ["filesDone", "filesTotal", "lastCompletedAt", "phase"]);
    assert.equal(progress.phase, "done");
    assert.equal(progress.filesTotal, 1);
    assert.ok(progress.lastCompletedAt !== null);
    assert.equal(adapter.observe().sessions.length, 1);
    // start/stop 走同一面：start 后 timer 未起（scanIntervalMs: 0），stop 正常收敛
    adapter.start();
    await adapter.stop();
  } finally {
    await adapter.stop();
    db.close();
  }
});

test("fix-B1: registry fans scan out to every adapter and aggregates progress", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const real = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  const calls: string[] = [];
  const stub: HarnessAdapter = {
    capabilityManifest: () => ({
      harnessId: "stub",
      displayName: "Stub",
      schemaVersion: "stub/1",
      readOnly: true,
      capabilities: ["session.list"],
      readPaths: [],
      degradations: [],
    }),
    observe: () => ({ sessions: [], failures: [] }),
    start: () => {
      calls.push("start");
    },
    stop: async () => {
      calls.push("stop");
    },
    progress: () => ({ phase: "done", filesTotal: 5, filesDone: 5, lastCompletedAt: "2026-10-26T00:00:00.000Z" }),
    scanNow: async () => {
      calls.push("scanNow");
      return { stub: true };
    },
  };
  const registry = new HarnessRegistry([real, stub]);
  try {
    await writeText(join(home.sessionsDir, "rollout-b1-fan.jsonl"), fixedFixture("sess-b1-fan").text());
    registry.start();
    assert.deepEqual(calls, ["start"]);
    const summaries = await registry.scanNow();
    assert.equal(summaries.length, 2);
    assert.deepEqual(calls, ["start", "scanNow"]);
    const progress = registry.scanProgress();
    // 聚合：计数相加（real 扫到 1 个文件 + stub 上报 5），完成时间取最大
    assert.equal(progress.filesTotal, 6);
    assert.equal(progress.filesDone, 6);
    assert.equal(progress.phase, "done");
    // 空 registry：全零 idle，scanNow 为空数组，stop 为空操作
    const empty = new HarnessRegistry([]);
    assert.deepEqual(empty.scanProgress(), { phase: "idle", filesTotal: 0, filesDone: 0, lastCompletedAt: null });
    assert.deepEqual(await empty.scanNow(), []);
    await empty.stop();
    await registry.stop();
    assert.deepEqual(calls, ["start", "scanNow", "stop"]);
  } finally {
    await real.stop();
    db.close();
  }
});

test("issue-49: registry.stop 逐个隔离——单个 stop 抛错不阻断其余，聚合错误携带失败者 harnessId", async () => {
  const calls: string[] = [];
  const good = (id: string): HarnessAdapter => ({
    capabilityManifest: () => ({
      harnessId: id,
      displayName: id,
      schemaVersion: "stub/1",
      readOnly: true,
      capabilities: ["session.list"],
      readPaths: [],
      degradations: [],
    }),
    observe: () => ({ sessions: [], failures: [] }),
    start: () => {},
    stop: async () => {
      calls.push(id);
    },
    progress: () => ({ phase: "idle", filesTotal: 0, filesDone: 0, lastCompletedAt: null }),
    scanNow: async () => ({}),
  });
  const bad: HarnessAdapter = {
    ...good("bad"),
    stop: async () => {
      throw new Error("boom-stop");
    },
  };
  const registry = new HarnessRegistry([good("a"), bad, good("b")]);
  await assert.rejects(registry.stop(), /registry stop failed: bad: boom-stop/);
  assert.deepEqual(calls, ["a", "b"]);
});

test("issue-49: registry.stop 全员成功时不抛", async () => {
  const calls: string[] = [];
  const good: HarnessAdapter = {
    capabilityManifest: () => ({
      harnessId: "ok",
      displayName: "Ok",
      schemaVersion: "stub/1",
      readOnly: true,
      capabilities: ["session.list"],
      readPaths: [],
      degradations: [],
    }),
    observe: () => ({ sessions: [], failures: [] }),
    start: () => {},
    stop: async () => {
      calls.push("stop");
    },
    progress: () => ({ phase: "idle", filesTotal: 0, filesDone: 0, lastCompletedAt: null }),
    scanNow: async () => ({}),
  };
  await new HarnessRegistry([good]).stop();
  assert.deepEqual(calls, ["stop"]);
});

test("issue-49: registry phase 聚合——done+idle 不得高估为 done", async () => {
  const stub = (id: string, phase: "idle" | "running" | "done"): HarnessAdapter => ({
    capabilityManifest: () => ({
      harnessId: id,
      displayName: id,
      schemaVersion: "stub/1",
      readOnly: true,
      capabilities: ["session.list"],
      readPaths: [],
      degradations: [],
    }),
    observe: () => ({ sessions: [], failures: [] }),
    start: () => {},
    stop: async () => {},
    progress: () => ({ phase, filesTotal: 0, filesDone: 0, lastCompletedAt: null }),
    scanNow: async () => ({}),
  });
  assert.equal(new HarnessRegistry([stub("a", "done"), stub("b", "idle")]).scanProgress().phase, "idle");
  assert.equal(new HarnessRegistry([stub("a", "done"), stub("b", "done")]).scanProgress().phase, "done");
  assert.equal(new HarnessRegistry([stub("a", "idle"), stub("b", "running")]).scanProgress().phase, "running");
  assert.equal(new HarnessRegistry([stub("a", "done"), stub("b", "running")]).scanProgress().phase, "running");
});

test("issue-49: codex stop 后复触发拒绝——scanNow 零摘要不落库，start 不重武装", async () => {
  const home = await makeHome();
  const { db } = await openStateDb(join(home.root, "taskboard.sqlite"));
  const store = new Store(db);
  const adapter = new CodexAdapter(store, { codexHome: home.root, scanIntervalMs: 0 });
  try {
    await writeText(join(home.sessionsDir, "rollout-post-stop.jsonl"), fixedFixture("sess-post-stop").text());
    await adapter.scanNow();
    const completedAt = adapter.progress().lastCompletedAt;
    assert.ok(completedAt !== null);
    const sourcesBefore = store.listReaderSources().length;
    await adapter.stop();
    const phaseAfterStop = adapter.progress().phase;
    adapter.start();
    assert.equal(
      adapter.progress().phase,
      phaseAfterStop,
      "stop 后 start 不得重建 timer 或改变收敛相位",
    );
    const summary = (await adapter.scanNow()) as { filesTotal: number; changed: number };
    assert.equal(summary.filesTotal, 0);
    assert.equal(summary.changed, 0);
    assert.equal(store.listReaderSources().length, sourcesBefore, "post-stop 拒绝必须零落库");
    assert.equal(adapter.progress().lastCompletedAt, completedAt, "post-stop 不得前移完成时间");
  } finally {
    await adapter.stop();
    db.close();
  }
});
