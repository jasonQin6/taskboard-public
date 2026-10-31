/** state 数据库打开面：空库初始化、迁移幂等、WAL/外键与损坏隔离（A1/A26 的库层）。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openStateDb } from "../src/db.js";
import { applyMigrations, MIGRATIONS } from "../src/schema.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeDbPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-db-"));
  tmpDirs.push(dir);
  return join(dir, "taskboard.sqlite");
};

/** node:sqlite 行是 null-prototype 对象，deepStrictEqual 会比原型：展开成普通对象再断言。 */
const plain = <T extends object>(rows: T[]): T[] => rows.map((row) => ({ ...row }));

const tableNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>).map((row) => row.name);

// schema 应含的全部业务表：缺一即 schema 不完整
const REQUIRED_TABLES = [
  "tasks",
  "task_threads",
  "runs",
  "threads",
  "thread_lineage",
  "thread_turns",
  "thread_evidence",
  "thread_summaries",
  "thread_evaluation_state",
  "next_action_proposals",
  "action_executions",
  "annotations",
  "registry_entries",
  "reader_sources",
  "reader_anomalies",
  "idempotency_keys",
  "settings",
  "revisions",
  "schema_migrations",
  "systemone_assessments",
  "systemone_thread_state",
  "systemone_daily_usage",
  "retro",
  "retro_combo",
];

test("fresh open initializes all required tables, WAL, foreign keys, and seeds revisions", async () => {
  const dbPath = await makeDbPath();
  const { db, created } = await openStateDb(dbPath);
  try {
    assert.equal(created, true);
    const tables = new Set(tableNames(db));
    for (const name of REQUIRED_TABLES) assert.ok(tables.has(name), `missing table: ${name}`);
    assert.equal(
      (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
      "wal",
    );
    assert.equal(
      (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
      1,
    );
    assert.deepEqual(
      plain(
        db
          .prepare("SELECT domain, revision FROM revisions ORDER BY domain")
          .all() as Array<{ domain: string; revision: number }>,
      ),
      [
        { domain: "config", revision: 0 },
        { domain: "tasks", revision: 0 },
        { domain: "threads", revision: 0 },
      ],
    );
  } finally {
    db.close();
  }
});

test("reopen applies no migrations again and is not marked as created", async () => {
  const dbPath = await makeDbPath();
  const first = await openStateDb(dbPath);
  first.db.close();
  const second = await openStateDb(dbPath);
  try {
    assert.equal(second.created, false);
    assert.deepEqual(
      plain(
        second.db
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all() as Array<{ version: number }>,
      ),
      [
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
      ],
    );
  } finally {
    second.db.close();
  }
});

test("garbage file is isolated as <db>.corrupt-<ts> and open refuses (never rebuilds)", async () => {
  const dbPath = await makeDbPath();
  await writeFile(dbPath, "definitely not a sqlite database\n", "utf8");
  await assert.rejects(openStateDb(dbPath), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /failed integrity check/);
    assert.match(error.message, /\.corrupt-/);
    assert.match(error.message, /refuses to start/);
    return true;
  });
  // 原文件被搬走，隔离文件保留了原始字节
  const siblings = await readdir(join(dbPath, ".."));
  const isolated = siblings.find((name) => name.startsWith("taskboard.sqlite.corrupt-"));
  assert.ok(isolated !== undefined, "corrupt file must be renamed in place");
  const content = await readFile(join(join(dbPath, ".."), isolated), "utf8");
  assert.equal(content, "definitely not a sqlite database\n");
});

test("valid header but corrupt body is also isolated (quick_check verdict)", async () => {
  const dbPath = await makeDbPath();
  const good = await openStateDb(dbPath);
  good.db.exec("CREATE TABLE probe (id INTEGER)");
  good.db.close();
  // 保住 SQLite 头 16 字节、毁掉页内容：open 能成功、quick_check 必须报错
  const buffer = await readFile(dbPath);
  buffer.write("XXXX", 64, "utf8");
  buffer.write("XXXX", 4096 + 8, "utf8");
  await writeFile(dbPath, buffer);
  await assert.rejects(openStateDb(dbPath), /failed integrity check|corrupt/);
  const siblings = await readdir(join(dbPath, ".."));
  assert.ok(
    siblings.some((name) => name.startsWith("taskboard.sqlite.corrupt-")),
    "corrupt file must be isolated",
  );
});

test("migration failure rolls back the whole batch", async () => {
  const dbPath = await makeDbPath();
  const { db } = await openStateDb(dbPath);
  try {
    assert.throws(
      () =>
        applyMigrations(db, [
          {
            version: 999,
            name: "boom",
            statements: [
              "CREATE TABLE should_rollback (id INTEGER)",
              "THIS IS NOT SQL",
            ],
          },
        ]),
      /not SQL|syntax/i,
    );
    // 半级 schema 与版本记录都必须回滚干净
    assert.equal(
      (
        db
          .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'should_rollback'")
          .get() as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (db.prepare("SELECT count(*) AS n FROM schema_migrations").get() as { n: number }).n,
      11,
    );
  } finally {
    db.close();
  }
});

test("partial unique index enforces one primary task per thread", async () => {
  const dbPath = await makeDbPath();
  const { db } = await openStateDb(dbPath);
  try {
    db.exec(
      "INSERT INTO tasks (id, title, prompt, created_at, updated_at) VALUES ('t1','a','',0,0)," +
        " ('t2','b','',0,0)",
    );
    db.exec("INSERT INTO threads (id, first_seen_at, updated_at) VALUES ('th1',0,0)");
    db.exec("INSERT INTO task_threads (task_id, thread_id, role, bound_at) VALUES ('t1','th1','primary',0)");
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO task_threads (task_id, thread_id, role, bound_at) VALUES ('t2','th1','primary',0)",
        ),
      /UNIQUE constraint failed/,
    );
    // 从属绑定不受限制
    db.exec("INSERT INTO task_threads (task_id, thread_id, role, bound_at) VALUES ('t2','th1','evidence_for',0)");
  } finally {
    db.close();
  }
});

test("migration history is validated by version and name: a renumbered history refuses to start", async () => {
  const dbPath = await makeDbPath();
  const { db } = await openStateDb(dbPath);
  try {
    // 模拟两侧车道曾各自占用同一 version 的历史库：只对 version 去重会静默跳过本该执行的迁移，
    // 然后在「表已存在」上炸出裸 SQLite 错误，且无修复 schema_migrations 的路径
    db.exec("UPDATE schema_migrations SET name = 'v2-worktree-execution-lane-b' WHERE version = 3");
    assert.throws(
      () => applyMigrations(db),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /migration 3 was applied as 'v2-worktree-execution-lane-b'/);
        assert.match(error.message, /expects 'v2-worktree-execution'/);
        return true;
      },
      "同版本号不同名必须显式报错拒启动，而不是静默续跑",
    );
    // 未知版本号（前向写入的更高级库）不参与校验，正常打开不误伤
    db.exec("UPDATE schema_migrations SET name = 'v2-worktree-execution' WHERE version = 3");
    db.exec("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'from-the-future', 0)");
    assert.deepEqual(applyMigrations(db), []);
  } finally {
    db.close();
  }
});

test("automation_mode_explicit migration backfills pre-existing tasks as explicit (story 49)", async () => {
  const dbPath = await makeDbPath();
  const db = new DatabaseSync(dbPath);
  try {
    // 手工搭出 v3 时代的库并插入一条升级前任务：automationMode 在迁移前就可显式设置，
    // 旧行无法区分用户选择与创建默认，只能按「显式」回填才能保住故事 49 的永不覆盖承诺
    // （schema_migrations 表本身由 applyMigrations 建立与登记，这里同步预建）
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 3)) {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 0)").run(
        migration.version,
        migration.name,
      );
    }
    db.exec("INSERT INTO tasks (id, title, prompt, created_at, updated_at) VALUES ('t_old', 'old', '', 0, 0)");

    assert.deepEqual(applyMigrations(db), [4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(
      (db.prepare("SELECT automation_mode_explicit AS v FROM tasks WHERE id = 't_old'").get() as { v: number }).v,
      1,
      "升级前已存在的任务一律回填为显式设置，不被 applyTaskboardThreadDefault 升级",
    );
    // 迁移后新插入的任务走 DEFAULT 0：仍可被创建默认策略升级为 auto
    db.exec("INSERT INTO tasks (id, title, prompt, created_at, updated_at) VALUES ('t_new', 'new', '', 0, 0)");
    assert.equal(
      (db.prepare("SELECT automation_mode_explicit AS v FROM tasks WHERE id = 't_new'").get() as { v: number }).v,
      0,
    );
  } finally {
    db.close();
  }
});

test("v6 drops the redundant task_worktrees index: v5 upgrade removes it, fresh db never has it", async () => {
  const indexExists = (db: DatabaseSync): boolean =>
    (
      db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'task_worktrees_task_idx'")
        .get() as { n: number }
    ).n > 0;
  // v5 旧库：v3 建出的冗余索引在场（钉住迁移前提：PRIMARY KEY (task_id, seq) 已隐式建同列唯一索引）；
  // 升到 v6 后索引消失，且 version+name 双校验不报警、后续迁移正常续跑
  const upgraded = new DatabaseSync(await makeDbPath());
  try {
    upgraded.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 5)) {
      for (const statement of migration.statements) upgraded.exec(statement);
      upgraded.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 0)").run(
        migration.version,
        migration.name,
      );
    }
    assert.equal(indexExists(upgraded), true, "前提：v5 库里冗余索引在场");
    assert.deepEqual(applyMigrations(upgraded), [6, 7, 8, 9, 10, 11]);
    assert.equal(indexExists(upgraded), false, "v6 必须删掉与主键隐式索引重复的 task_worktrees_task_idx");
  } finally {
    upgraded.close();
  }
  // 新库：一路 v1..v8 建出，同样没有该索引
  const fresh = await openStateDb(await makeDbPath());
  try {
    assert.equal(indexExists(fresh.db), false, "新库不应再有冗余索引");
  } finally {
    fresh.db.close();
  }
});

test("v7 backfills Codex-first internal ids into a unique cross-harness native identity", async () => {
  const dbPath = await makeDbPath();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 6)) {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 0)").run(
        migration.version,
        migration.name,
      );
    }
    db.exec("INSERT INTO threads (id, first_seen_at, updated_at) VALUES ('legacy-codex-id', 1, 1)");

    assert.deepEqual(applyMigrations(db), [7, 8, 9, 10, 11]);
    assert.deepEqual(
      plain(
        db
          .prepare("SELECT id, harness_id, native_session_id FROM threads WHERE id = 'legacy-codex-id'")
          .all() as Array<{ id: string; harness_id: string; native_session_id: string }>,
      ),
      [{ id: "legacy-codex-id", harness_id: "codex", native_session_id: "legacy-codex-id" }],
    );
    db.exec("INSERT INTO threads (id, first_seen_at, updated_at) VALUES ('other-internal-id', 2, 2)");
    assert.throws(
      () =>
        db
          .prepare(
            "UPDATE threads SET harness_id = 'codex', native_session_id = 'legacy-codex-id' WHERE id = 'other-internal-id'",
          )
          .run(),
      /UNIQUE constraint failed/,
      "(harness_id, native_session_id) must reject a duplicate even when internal ids differ",
    );
  } finally {
    db.close();
  }
});

test("v7 to v8 backfills only compacted summary record_hash without losing summary identity", async () => {
  const dbPath = await makeDbPath();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((entry) => entry.version <= 7)) {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, 0)").run(
        migration.version,
        migration.name,
      );
    }
    db.exec("INSERT INTO threads (id, first_seen_at, updated_at) VALUES ('thread-v7', 1, 1)");
    db.exec(
      "INSERT INTO thread_summaries (id, thread_id, provenance, text, source_ref, created_at) VALUES " +
        "('summary-compacted', 'thread-v7', 'compacted', 'kept compacted text', 'record-hash-v7', 10), " +
        "('summary-sample', 'thread-v7', 'sample', 'kept sample text', 'sample-ref', 20)",
    );

    assert.deepEqual(applyMigrations(db), [8, 9, 10, 11]);
    assert.deepEqual(
      plain(
        db
          .prepare(
            "SELECT id, thread_id, provenance, text, record_hash, source_id, byte_start, covered_through_turn_ordinal " +
              "FROM thread_summaries ORDER BY id DESC",
          )
          .all() as Array<Record<string, unknown>>,
      ),
      [
        {
          id: "summary-sample",
          thread_id: "thread-v7",
          provenance: "sample",
          text: "kept sample text",
          record_hash: null,
          source_id: null,
          byte_start: null,
          covered_through_turn_ordinal: null,
        },
        {
          id: "summary-compacted",
          thread_id: "thread-v7",
          provenance: "compacted",
          text: "kept compacted text",
          record_hash: "record-hash-v7",
          source_id: null,
          byte_start: null,
          covered_through_turn_ordinal: null,
        },
      ],
    );
  } finally {
    db.close();
  }
});
