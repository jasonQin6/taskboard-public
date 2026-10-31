import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { Store } from "../src/store/index.js";
import { ZcodeAdapter, ZCODE_HARNESS_ID, ZCODE_MAPPER_VERSION } from "../src/harness/zcode/adapter.js";
import { buildZcodeFixtureDb } from "../src/harness/zcode/fixture.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import type { HarnessAdapter } from "../src/harness/contract.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-zcode-"));
  tmpDirs.push(dir);
  return dir;
};

const openStore = async (dir: string): Promise<{ store: Store; close: () => void }> => {
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  return { store: new Store(db), close: () => db.close() };
};

const T0 = Date.parse("2026-10-26T03:00:00Z");

const codexStubAdapter = (nativeSessionId: string): HarnessAdapter => ({
  capabilityManifest: () => ({
    harnessId: "codex",
    displayName: "Codex",
    schemaVersion: "codex-rollout/1",
    readOnly: true,
    capabilities: ["session.list"],
    readPaths: [],
    degradations: [],
  }),
  observe: () => ({
    sessions: [
      {
        id: nativeSessionId,
        harnessId: "codex",
        nativeSessionId,
        title: "codex stub",
        workspace: "/tmp/codex",
        nativeStatus: "idle",
        lastActivityAt: new Date(T0).toISOString(),
        nativeGroup: "user",
        unknownFields: [],
        locator: {
          harnessId: "codex",
          nativeSessionId,
          sourcePath: "/tmp/codex/rollout.jsonl",
          byteStart: 0,
          recordHash: "0".repeat(64),
        },
        cursor: null,
        provenance: "codex:rollout-jsonl@1",
      },
    ],
    failures: [],
  }),
  // stub 不参与生命周期断言(那些归 harness-contract 的 codex 真实现),只需满足契约面
  start: () => {},
  stop: async () => {},
  progress: () => ({ phase: "idle", filesTotal: 0, filesDone: 0, lastCompletedAt: null }),
  scanNow: async () => ({}),
});

test("zcode adapter: fixture sessions map into snapshots and land in the shared store", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_alpha",
      directory: "/tmp/workspace/alpha",
      title: "实现 ZCode 只读 adapter",
      taskType: "interactive",
      timeUpdated: T0 + 5_000,
      turns: [
        { turnId: "turn-1", status: "completed", startedAt: T0, completedAt: T0 + 1_000 },
        { turnId: "turn-2", status: "error", startedAt: T0 + 2_000, completedAt: T0 + 3_000 },
      ],
      messages: [
        { role: "user", created: T0 },
        { role: "assistant", created: T0 + 2_000, completed: T0 + 3_000 },
      ],
    },
    {
      id: "session_beta",
      directory: "/tmp/workspace/beta",
      title: "进行中的会话",
      taskType: "subagent_child",
      timeUpdated: T0 + 6_000,
      turns: [{ turnId: "turn-1", status: "completed", startedAt: T0 + 4_000, completedAt: T0 + 5_000 }],
      messages: [{ role: "assistant", created: T0 + 6_000 }],
    },
    {
      id: "session_gamma",
      directory: "/tmp/workspace/gamma",
      title: "",
      taskType: "interactive",
      timeUpdated: T0 + 1_000,
    },
  ]);
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    await adapter.scanNow();
    const observation = adapter.observe();
    assert.deepEqual(observation.failures, []);
    assert.equal(observation.sessions.length, 3);

    const alpha = observation.sessions.find((session) => session.nativeSessionId === "session_alpha")!;
    assert.equal(alpha.id, "zcode:session_alpha");
    assert.equal(alpha.harnessId, "zcode");
    assert.equal(alpha.title, "实现 ZCode 只读 adapter");
    assert.equal(alpha.workspace, "/tmp/workspace/alpha");
    assert.equal(alpha.nativeGroup, "interactive");
    // 最近 turn error → failed，与 Codex「最近终态原样保留」口径一致
    assert.equal(alpha.nativeStatus, "failed");
    assert.equal(alpha.provenance, `zcode:sqlite@${ZCODE_MAPPER_VERSION}`);
    assert.deepEqual(alpha.unknownFields, []);
    assert.equal(alpha.locator.sourcePath, dbPath);
    assert.equal(alpha.locator.recordHash !== null, true);
    assert.notEqual(alpha.cursor, null);
    assert.equal(alpha.cursor!.parserVersion, ZCODE_MAPPER_VERSION);

    const beta = observation.sessions.find((session) => session.nativeSessionId === "session_beta")!;
    // 最新 assistant 消息未收尾 → running（等价 Codex open turn）
    assert.equal(beta.nativeStatus, "running");
    assert.equal(beta.nativeGroup, "subagent_child");

    const gamma = observation.sessions.find((session) => session.nativeSessionId === "session_gamma")!;
    // 无 turn 无消息 → unknown 降级；空串标题（NOT NULL 列）也投影回 unknown
    assert.equal(gamma.nativeStatus, "unknown");
    assert.deepEqual(gamma.unknownFields.sort(), ["nativeStatus", "title"]);

    const turns = store.listThreadTurns("zcode:session_alpha");
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.nativeStatus, "completed");
    assert.equal(turns[1]!.nativeStatus, "failed");
    assert.equal(turns[1]!.endedAt, T0 + 3_000);
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: repeated scans stay idempotent and never touch the source db bytes", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_once",
      title: "幂等",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  const before = await stat(dbPath);
  const beforeBytes = await readFile(dbPath);
  try {
    await adapter.scanNow();
    await adapter.scanNow();
    const observation = adapter.observe();
    assert.equal(observation.sessions.length, 1, "rescan must not duplicate sessions");
    assert.equal(store.listThreadTurns("zcode:session_once").length, 1);
    assert.equal(store.listReaderSources().length, 1);
    const after = await stat(dbPath);
    const afterBytes = await readFile(dbPath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.deepEqual(afterBytes, beforeBytes, "observation must not rewrite the zcode sqlite");
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: WAL-mode source is scanned without modifying db/wal/shm", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_wal",
      title: "wal",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  // 真实库是 WAL 形态：写侧连接切 WAL 并落一条改动；连接保持打开，避免 close 触发
  // 自动 checkpoint 清掉 -wal/-shm（那会让「只读扫描不碰 wal」无从断言）
  const { DatabaseSync } = await import("node:sqlite");
  const writer = new DatabaseSync(dbPath);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('session_wal2', 'p', 's', '/tmp/w', 'w2', 'v', ?, ?)").run(T0, T0 + 2);
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const walBefore = await readFile(walPath);

  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  const dbBefore = await readFile(dbPath);
  try {
    await adapter.scanNow();
    const observation = adapter.observe();
    assert.equal(observation.sessions.length, 2, "wal sessions are visible through the readOnly connection");
    assert.deepEqual(await readFile(dbPath), dbBefore, "readOnly scan must not checkpoint into the main db");
    const walAfter = await readFile(walPath);
    assert.deepEqual(walAfter, walBefore, "readOnly scan must not rewrite the wal");
    await stat(shmPath);
  } finally {
    await adapter.stop();
    close();
    writer.close();
  }
});

test("zcode adapter: schema drift degrades to a structured failure without blocking codex", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(
    join(dir, "zcode"),
    [{ id: "session_drift", title: "x", timeUpdated: T0 }],
    { omitColumn: "session.directory" },
  );
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    await adapter.scanNow();
    const observation = adapter.observe();
    assert.deepEqual(observation.sessions, []);
    assert.equal(observation.failures.length, 1);
    assert.equal(observation.failures[0]!.code, "source_unreadable");
    assert.equal(observation.failures[0]!.retryable, false);
    assert.match(observation.failures[0]!.message, /session\.directory/);
    assert.match(adapter.capabilityManifest().schemaVersion, /zcode-sqlite\/unknown/);
    // 失败也算「完成的一轮」:attempted 的源单位计数 done,失败细节走 observe().failures
    // (与 reader 逐文件口径同构:单文件失败不吞掉整轮的 done/lastCompletedAt)
    const progress = adapter.progress();
    assert.equal(progress.phase, "done");
    assert.equal(progress.filesTotal, 1);
    assert.equal(progress.filesDone, 1);
    assert.notEqual(progress.lastCompletedAt, null);

    const registry = new HarnessRegistry([codexStubAdapter("codex_peer"), adapter]);
    const merged = registry.observe();
    assert.equal(merged.sessions.length, 1, "codex sessions stay visible while zcode degrades");
    assert.equal(merged.sessions[0]!.harnessId, "codex");
    assert.equal(merged.failures.length, 1);
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: unmapped turn status degrades to an anomaly, not a guess", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_weird",
      title: "未知状态",
      timeUpdated: T0,
      turns: [
        { turnId: "ok", status: "completed", startedAt: T0, completedAt: T0 + 1 },
        { turnId: "weird", status: "paused_mid_flight", startedAt: T0 + 2 },
      ],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    await adapter.scanNow();
    const turns = store.listThreadTurns("zcode:session_weird");
    assert.equal(turns.length, 1, "unmapped turn must not enter the turn table");
    assert.equal(turns[0]!.nativeStatus, "completed");
    const source = store.listReaderSources().find((entry) => entry.path === dbPath)!;
    assert.notEqual(source, undefined);
    assert.equal(
      store.readerCursorSummary().anomalies >= 1,
      true,
      "the skipped turn is recorded as an anomaly for audit",
    );
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: malformed message.data degrades to an anomaly and never blocks other sessions", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_badjson",
      title: "坏消息",
      timeUpdated: T0 + 1,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
    {
      id: "session_healthy",
      title: "好会话",
      timeUpdated: T0 + 3,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0 + 2, completedAt: T0 + 3 }],
      messages: [{ role: "assistant", created: T0 + 2, completed: T0 + 3 }],
    },
  ]);
  // 审计复现口径(#44 r2):一行 message.data 直接写成非法 JSON。
  // 修复前:latestMessages 查询的裸 json_extract 整轮抛 malformed JSON,
  // scanFailure 不落、observe().failures 空,其它会话也被拖死。
  const { DatabaseSync } = await import("node:sqlite");
  const corruptor = new DatabaseSync(dbPath);
  corruptor.prepare("UPDATE message SET data='{not-json' WHERE session_id = 'session_badjson'").run();
  corruptor.close();

  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    const summary = await adapter.scanNow();
    assert.equal(summary.anomalies >= 1, true, "非法 message.data 必须落 anomaly 供审计展示");
    const observation = adapter.observe();
    assert.deepEqual(observation.failures, [], "降级走 anomaly 通道,不伪造 source 级失败");
    const bad = observation.sessions.find((session) => session.nativeSessionId === "session_badjson");
    // 非法最新消息只废掉 running 判定(保守回退 turn 终态),不丢会话、不误报 running
    assert.equal(bad?.nativeStatus, "completed");
    const healthy = observation.sessions.find((session) => session.nativeSessionId === "session_healthy");
    assert.equal(healthy?.nativeStatus, "completed", "单行坏数据不得阻塞其它会话");
    assert.equal(store.listObservedSessions(ZCODE_HARNESS_ID).length, 2);
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: an unexpected pass crash lands a retryable failure before rethrowing", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_crash",
      title: "提交即炸",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  // store 是注入依赖:在其边界做最小替身让 commitSourceScan 意外崩溃,
  // 钉住「pass 级意外异常必须先落 scanFailure 再重抛」——修复前 failures 空、
  // 周期扫描轮轮白跑(start 吞掉 reject),属静默失败
  const crashingStore = Object.assign(Object.create(store), {
    commitSourceScan(): void {
      throw new Error("store exploded");
    },
  }) as Store;
  const adapter = new ZcodeAdapter(crashingStore, { dbPath, scanIntervalMs: 0 });
  try {
    await assert.rejects(adapter.scanNow(), /store exploded/);
    const observation = adapter.observe();
    assert.equal(observation.failures.length, 1);
    assert.equal(observation.failures[0]!.code, "adapter_failed");
    assert.equal(observation.failures[0]!.retryable, true);
    assert.match(observation.failures[0]!.message, /store exploded/);
    assert.equal(adapter.progress().phase, "idle", "崩溃轮次回 idle,不伪造 done");
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: scanNow after stop() short-circuits to a zero summary without touching the store", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_afterstop",
      title: "停后不来",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  // stop() 契约(:148):返回后不允许再有本 adapter 的落库写入在途。
  // 修复前 scanNow 无 stopped 守卫,stop 后调用仍开新 pass 经 commitSourceScan 落库
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    await adapter.stop();
    const summary = await adapter.scanNow();
    assert.deepEqual(summary, { sessions: 0, turns: 0, anomalies: 0, skipped: false });
    assert.equal(store.listObservedSessions(ZCODE_HARNESS_ID).length, 0, "stop 返回后不得再开 pass 落库");
    assert.equal(adapter.progress().phase, "idle");
    assert.equal(adapter.progress().lastCompletedAt, null);
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: fork lineage lands only when both ends are observed", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_parent",
      title: "父会话",
      timeUpdated: T0,
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
    {
      id: "session_fork",
      title: "子会话",
      taskType: "fork",
      parentId: "session_parent",
      timeUpdated: T0 + 1,
      messages: [{ role: "assistant", created: T0 + 1, completed: T0 + 2 }],
    },
    {
      id: "session_orphan_fork",
      title: "父不在库内的 fork",
      taskType: "fork",
      parentId: "session_missing",
      timeUpdated: T0 + 2,
      messages: [{ role: "assistant", created: T0 + 2, completed: T0 + 3 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    await adapter.scanNow();
    const forkLineage = store.threadLineage("zcode:session_fork");
    assert.equal(forkLineage.parents.length, 1);
    assert.equal(forkLineage.parents[0]!.parentThreadId, "zcode:session_parent");
    assert.equal(forkLineage.parents[0]!.relation, "fork");
    // 悬空 fork 不落 lineage：父端不存在时挂上即悬空引用
    assert.deepEqual(store.threadLineage("zcode:session_orphan_fork").parents, []);
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: registry merges zcode and codex sessions onto one board", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_board",
      title: "同屏",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    await adapter.scanNow();
    const registry = new HarnessRegistry([codexStubAdapter("codex_board"), adapter]);
    const merged = registry.observe();
    assert.equal(merged.failures.length, 0);
    const harnessIds = merged.sessions.map((session) => session.harnessId).sort();
    assert.deepEqual(harnessIds, ["codex", "zcode"]);
    assert.equal(merged.sessions.every((session) => session.provenance.length > 0), true);
    assert.equal(ZCODE_HARNESS_ID, "zcode");
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: progress walks idle → running → done with honest counts and timestamps", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_prog",
      title: "进度",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  let nowMs = T0 + 100_000;
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0, now: () => nowMs });
  try {
    assert.deepEqual(adapter.progress(), {
      phase: "idle",
      filesTotal: 0,
      filesDone: 0,
      lastCompletedAt: null,
    });

    // scanNow 的同步前缀置 running;整库是单源单位:total=1,done 要等 pass 收敛
    const pass = adapter.scanNow();
    assert.deepEqual(adapter.progress(), {
      phase: "running",
      filesTotal: 1,
      filesDone: 0,
      lastCompletedAt: null,
    });
    const summary = await pass;
    assert.deepEqual(summary, { sessions: 1, turns: 1, anomalies: 0, skipped: false });
    assert.deepEqual(adapter.progress(), {
      phase: "done",
      filesTotal: 1,
      filesDone: 1,
      lastCompletedAt: new Date(nowMs).toISOString(),
    });

    // 水位跳过也是完成的一轮:lastCompletedAt 前进,不重放不重复落库
    nowMs += 5_000;
    const skipped = await adapter.scanNow();
    assert.deepEqual(skipped, { sessions: 0, turns: 0, anomalies: 0, skipped: true });
    assert.equal(adapter.progress().lastCompletedAt, new Date(nowMs).toISOString());
    assert.equal(store.listObservedSessions(ZCODE_HARNESS_ID).length, 1);
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: start() scans immediately, stop() awaits the in-flight pass, restart is a no-op", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_life",
      title: "生命周期",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  let nowMs = T0 + 100_000;
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0, now: () => nowMs });
  try {
    // daemon 就绪不等待扫描:start() 触发立即扫描,stop() 负责等在飞 pass 收敛
    adapter.start();
    nowMs += 1_000;
    await adapter.stop();
    assert.equal(adapter.progress().phase, "done");
    assert.equal(adapter.progress().lastCompletedAt, new Date(nowMs).toISOString());
    assert.equal(store.listObservedSessions(ZCODE_HARNESS_ID).length, 1);

    // stop 后 start 不复活扫描:daemon 生命周期里 adapter 不重启,重启属新进程
    nowMs += 1_000;
    adapter.start();
    assert.equal(adapter.progress().lastCompletedAt, new Date(T0 + 101_000).toISOString());
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: concurrent scanNow calls coalesce into one pass", async () => {
  const dir = await makeDir();
  const dbPath = await buildZcodeFixtureDb(join(dir, "zcode"), [
    {
      id: "session_single",
      title: "单飞",
      timeUpdated: T0,
      turns: [{ turnId: "t1", status: "completed", startedAt: T0, completedAt: T0 + 1 }],
      messages: [{ role: "assistant", created: T0, completed: T0 + 1 }],
    },
  ]);
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, { dbPath, scanIntervalMs: 0 });
  try {
    const first = adapter.scanNow();
    const second = adapter.scanNow();
    // async 方法各包一层外层 promise,单飞钉在「解析到同一个 summary 对象」:并发调用共享同一次 pass
    assert.equal(await first, await second, "并发调用必须共享同一个在飞 pass,绝不并行扫同一源");
    const summary = await second;
    assert.equal(summary.skipped, false);
    assert.equal(store.listObservedSessions(ZCODE_HARNESS_ID).length, 1);
    assert.equal(store.listThreadTurns("zcode:session_single").length, 1);
  } finally {
    await adapter.stop();
    close();
  }
});

test("zcode adapter: missing source degrades to a retryable failure over a completed pass", async () => {
  const dir = await makeDir();
  const { store, close } = await openStore(dir);
  const adapter = new ZcodeAdapter(store, {
    dbPath: join(dir, "missing", "db.sqlite"),
    scanIntervalMs: 0,
    now: () => T0,
  });
  try {
    const summary = await adapter.scanNow();
    assert.deepEqual(summary, { sessions: 0, turns: 0, anomalies: 0, skipped: false });
    assert.equal(adapter.progress().phase, "done");
    assert.equal(adapter.progress().lastCompletedAt, new Date(T0).toISOString());
    const observation = adapter.observe();
    assert.equal(observation.sessions.length, 0);
    assert.equal(observation.failures.length, 1);
    assert.equal(observation.failures[0]!.code, "source_unreadable");
    assert.equal(observation.failures[0]!.retryable, true);
  } finally {
    await adapter.stop();
    close();
  }
});
