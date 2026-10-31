/** schema 真相源：ADR-0001「SQLite 作为唯一事实源」。迁移只增不删，事务内逐级执行。 */

import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

/**
 * v2-foundation：V2 第一版全量表结构。
 * reader/summary/评估层的写入面在 Store（经单一写者落库）；
 * 主绑定部分唯一索引与单飞兜底索引属于数据库级契约，建库即生效。
 */
const V2_FOUNDATION: Migration = {
  version: 1,
  name: "v2-foundation",
  statements: [
    `CREATE TABLE revisions (
      domain TEXT PRIMARY KEY CHECK (domain IN ('tasks','threads','config')),
      revision INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      workspace TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog','todo','running','done','failed')),
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      labels TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual','scan','self_improvement','external_issue')),
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      acceptance_mode TEXT NOT NULL DEFAULT 'human' CHECK (acceptance_mode IN ('human','agent')),
      automation_mode TEXT NOT NULL DEFAULT 'suggest' CHECK (automation_mode IN ('off','suggest','auto')),
      workspace_mode TEXT NOT NULL DEFAULT 'current' CHECK (workspace_mode IN ('current','isolated_worktree')),
      parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      subtasks_policy TEXT CHECK (subtasks_policy IS NULL OR subtasks_policy = 'cascade'),
      idle_threshold_ms INTEGER,
      cron_expr TEXT,
      cron_tz TEXT,
      next_run_at INTEGER,
      goal_enabled INTEGER NOT NULL DEFAULT 0,
      goal_budget_tokens INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX tasks_parent_idx ON tasks(parent_id)`,
    `CREATE INDEX tasks_active_idx ON tasks(status) WHERE archived = 0`,
    `CREATE INDEX tasks_next_run_idx ON tasks(next_run_at) WHERE next_run_at IS NOT NULL`,
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      native_status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (native_status IN ('running','idle','completed','failed','interrupted','held','unknown')),
      title TEXT,
      last_activity_at INTEGER,
      first_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ignored INTEGER NOT NULL DEFAULT 0,
      ignored_at INTEGER
    )`,
    `CREATE INDEX threads_inbox_idx ON threads(last_activity_at) WHERE ignored = 0`,
    `CREATE TABLE task_threads (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('primary','derived_from','evidence_for')),
      bound_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, thread_id, role)
    )`,
    // 一个 thread 至多一个 primary Task：领域不变量的数据库级强制
    `CREATE UNIQUE INDEX task_threads_primary_uniq ON task_threads(thread_id) WHERE role = 'primary'`,
    `CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled')),
      trigger TEXT NOT NULL CHECK (trigger IN ('manual','cron','cascade','auto')),
      thread_id TEXT,
      orphaned INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER
    )`,
    `CREATE INDEX runs_task_idx ON runs(task_id, created_at)`,
    `CREATE INDEX runs_active_idx ON runs(task_id) WHERE status IN ('queued','running')`,
    `CREATE TABLE action_executions (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
      trigger TEXT NOT NULL CHECK (trigger IN ('manual','auto')),
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT,
      request_id TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    )`,
    // 数据库级单飞兜底：同一 thread 至多一个未终态动作执行
    `CREATE UNIQUE INDEX action_executions_singleflight
      ON action_executions(thread_id) WHERE status IN ('pending','running') AND thread_id IS NOT NULL`,
    `CREATE TABLE next_action_proposals (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','accepted','rejected','expired')),
      evidence_fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL,
      decided_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE annotations (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      thread_id TEXT,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX annotations_task_idx ON annotations(task_id, created_at)`,
    `CREATE TABLE registry_entries (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE thread_lineage (
      thread_id TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, parent_thread_id, relation)
    )`,
    `CREATE TABLE thread_turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      native_status TEXT NOT NULL
        CHECK (native_status IN ('running','completed','failed','interrupted')),
      started_at INTEGER,
      ended_at INTEGER,
      source_ref TEXT,
      UNIQUE (thread_id, ordinal)
    )`,
    `CREATE TABLE reader_sources (
      source_id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      inode INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      consumed_bytes INTEGER NOT NULL,
      prefix_hash TEXT NOT NULL,
      tail_hash TEXT,
      next_ordinal INTEGER,
      parser_version INTEGER NOT NULL,
      rewritten INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE thread_evidence (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      byte_start INTEGER NOT NULL,
      record_hash TEXT NOT NULL,
      turn_ordinal INTEGER,
      kind TEXT NOT NULL,
      summary TEXT,
      props TEXT,
      superseded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE (source_id, byte_start, record_hash)
    )`,
    `CREATE INDEX thread_evidence_thread_idx ON thread_evidence(thread_id) WHERE superseded = 0`,
    `CREATE TABLE thread_summaries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK (provenance IN ('compacted','sample','none')),
      text TEXT NOT NULL,
      source_ref TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX thread_summaries_thread_idx ON thread_summaries(thread_id, created_at)`,
    `CREATE TABLE thread_evaluation_state (
      thread_id TEXT PRIMARY KEY,
      last_evaluated_at INTEGER,
      evidence_fingerprint TEXT,
      last_no_op INTEGER NOT NULL DEFAULT 0,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      breaker_open INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE reader_anomalies (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE idempotency_keys (
      request_id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      status INTEGER NOT NULL,
      response TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  ],
};

/**
 * v2-goal-status：原生 goal 的最近观测状态缓存（per-thread，opaque 字符串，词汇来自 Codex）。
 * 只作证据展示（任务详情/线程详情），不参与状态机判定（用户故事 63）。
 */
const V2_GOAL_STATUS: Migration = {
  version: 2,
  name: "v2-goal-status",
  statements: ["ALTER TABLE threads ADD COLUMN goal_status TEXT"],
};

// v2-worktree-execution：isolated_worktree 模式的持久记录（issue #9 / 故事 70–73）。
// 只记创建事实与显式清理时间戳；branch/commit 证据本身留在 git 仓里，这里绝不复刻内容。
// 两侧车道曾各自占用 version 2，合并时 worktree 迁移让位重编号为 3（V2 期无持久库，安全）。
const V2_WORKTREE_EXECUTION: Migration = {
  version: 3,
  name: "v2-worktree-execution",
  statements: [
    `CREATE TABLE task_worktrees (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      base_branch TEXT,
      source_workspace TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER,
      PRIMARY KEY (task_id, seq)
    )`,
    `CREATE INDEX task_worktrees_task_idx ON task_worktrees(task_id, seq)`,
  ],
};

// v2-automation-default-policy：automation 默认策略需要区分「用户显式设置」与「创建默认值」
// （issue #11 / 故事 49）：taskboard 创建并绑定主线程时只把仍处于创建默认（suggest 且未显式设置）
// 的任务升级为 auto，用户显式选择任何模式都永不被覆盖。
const V2_AUTOMATION_DEFAULT_POLICY: Migration = {
  version: 4,
  name: "v2-automation-default-policy",
  statements: [
    "ALTER TABLE tasks ADD COLUMN automation_mode_explicit INTEGER NOT NULL DEFAULT 0",
    // 迁移时已存在的任务一律按「显式设置」回填：旧行无法区分用户选择与创建默认，
    // 宁可永不升级，也不让默认策略覆盖升级前的用户显式选择（故事 49）。新插入行走 DEFAULT 0。
    "UPDATE tasks SET automation_mode_explicit = 1",
  ],
};

// v2-shadow-gate：自治上线门的 shadow 回放数据（issue #11 / 门 1–3，故事 87/88）。
// 每行是一份真实 thread 快照的三方对比：no_op 基线（不动作，恒定）× 原生侧（最新 turn 终态 +
// 最近 goal 状态）× Jev 选择（从已落库提案派生）。executed 由 collect 的 upsert 随执行事实刷新
//（store.collectShadowComparisons：ON CONFLICT DO UPDATE MAX），快照其余字段保持首采冻结。
// 人工标注三值（与 types.ts SHADOW_LABELS 同一词汇，test 有一致性断言）；无外键——提案与
// 线程只增不删，快照在其后仍然可读。
const V2_SHADOW_GATE: Migration = {
  version: 5,
  name: "v2-shadow-gate",
  statements: [
    `CREATE TABLE shadow_comparisons (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL,
      task_id TEXT,
      evidence_fingerprint TEXT NOT NULL,
      native_turn_status TEXT,
      native_goal_status TEXT,
      jev_recommended TEXT NOT NULL,
      jev_risk TEXT NOT NULL,
      executed INTEGER NOT NULL DEFAULT 0,
      label TEXT CHECK (label IN ('helpful','ineffective','harmful')),
      labeled_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE (thread_id, evidence_fingerprint, jev_recommended)
    )`,
    `CREATE INDEX shadow_comparisons_label_idx ON shadow_comparisons(label)`,
  ],
};

// v6-drop-worktree-index：删掉 v3 带入的冗余索引 task_worktrees_task_idx——表是 rowid 表，
// PRIMARY KEY (task_id, seq) 已隐式建同列唯一索引（sqlite_autoindex），同一列集双份索引让
// 每次 worktree 建/清都付双倍索引写成本，却没有任何查询收益（前缀查 task_id 也走主键索引）。
// 迁移只增不删：v3 的 CREATE INDEX 原样保留，新库靠本迁移把它再删掉。
const V6_DROP_WORKTREE_INDEX: Migration = {
  version: 6,
  name: "v6-drop-worktree-index",
  statements: ["DROP INDEX task_worktrees_task_idx"],
};

/**
 * v7-cross-harness-session-identity：threads.id 保留为内部主键，新增
 * (harness_id, native_session_id) 跨 Harness 身份；旧 Codex-first 行把 id 回填为 native id。
 * locator/workspace/native_group 是同一条原生会话的可重建投影，不是 overlay。
 */
const V7_CROSS_HARNESS_SESSION_IDENTITY: Migration = {
  version: 7,
  name: "v7-cross-harness-session-identity",
  statements: [
    "ALTER TABLE threads ADD COLUMN harness_id TEXT NOT NULL DEFAULT 'codex'",
    "ALTER TABLE threads ADD COLUMN native_session_id TEXT",
    "ALTER TABLE threads ADD COLUMN workspace TEXT",
    "ALTER TABLE threads ADD COLUMN native_group TEXT",
    "ALTER TABLE threads ADD COLUMN source_path TEXT",
    "ALTER TABLE threads ADD COLUMN source_byte_start INTEGER",
    "ALTER TABLE threads ADD COLUMN source_record_hash TEXT",
    "UPDATE threads SET native_session_id = id WHERE native_session_id IS NULL",
    `CREATE UNIQUE INDEX threads_harness_native_uniq
      ON threads(harness_id, native_session_id)
      WHERE native_session_id IS NOT NULL`,
    "CREATE INDEX threads_harness_activity_idx ON threads(harness_id, last_activity_at)",
  ],
};

/**
 * v8-phase1-session-detail-locators：详情页需要把每条 turn、证据和原生摘要定位回
 * source unit。历史行没有字节位置时保留 null，由投影层如实标记 locator 不完整。
 */
const V8_PHASE1_SESSION_DETAIL_LOCATORS: Migration = {
  version: 8,
  name: "v8-phase1-session-detail-locators",
  statements: [
    "ALTER TABLE thread_turns ADD COLUMN source_byte_start INTEGER",
    "ALTER TABLE thread_turns ADD COLUMN source_record_hash TEXT",
    "ALTER TABLE thread_summaries ADD COLUMN source_id TEXT",
    "ALTER TABLE thread_summaries ADD COLUMN byte_start INTEGER",
    "ALTER TABLE thread_summaries ADD COLUMN record_hash TEXT",
    "ALTER TABLE thread_summaries ADD COLUMN covered_through_turn_ordinal INTEGER",
    "UPDATE thread_summaries SET record_hash = source_ref WHERE provenance = 'compacted' AND record_hash IS NULL",
  ],
};

const V9_SYSTEMONE_ASSESSMENTS: Migration = {
  version: 9,
  name: "v9-systemone-assessments",
  statements: [
    `CREATE TABLE systemone_assessments (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      cache_key TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      version_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      question_version TEXT NOT NULL,
      outcome TEXT NOT NULL,
      status TEXT, confidence REAL, reason_short TEXT, evidence_refs TEXT,
      covers_through TEXT, provenance TEXT,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      failure_message TEXT,
      assessed_at INTEGER NOT NULL
    )`,
    "CREATE INDEX systemone_assessments_thread_idx ON systemone_assessments(thread_id, assessed_at DESC)",
    "CREATE INDEX systemone_assessments_cache_idx ON systemone_assessments(thread_id, cache_key, assessed_at DESC)",
    `CREATE TABLE systemone_thread_state (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      breaker_open INTEGER NOT NULL DEFAULT 0,
      breaker_opened_at INTEGER,
      last_degradation_code TEXT,
      last_degradation_at INTEGER,
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE systemone_daily_usage (
      day TEXT PRIMARY KEY,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0
    )`,
  ],
};

const V10_LOCATOR_LIFECYCLE: Migration = {
  version: 10,
  name: "v10-locator-lifecycle",
  statements: [
    `ALTER TABLE thread_turns ADD COLUMN source_locator_kind TEXT
      CHECK (source_locator_kind IN ('start','terminal'))`,
    "ALTER TABLE thread_summaries ADD COLUMN superseded INTEGER NOT NULL DEFAULT 0",
  ],
};

/**
 * v11-retro-ledger：retro 子功能的两张表（#65，形态由 ADR-0023 放行）。
 * `retro` 承接原 ~/.zcode/hooks/retro-ledger.sqlite 的状态机（status/attempts 的
 * 「未处理/failed 且 attempts<3 可重试」语义）并扩展为可携带复盘产物载荷
 * （conclusion/findings/not_covered）；身份 = (source, session_id) 或 (source, attempt_id)，
 * 两个部分唯一索引各守一边，跨键冲突由 repository 层显式报错。
 * `retro_combo` 承接原 ~/.retro/combos.jsonl 的 schema v1 字段（存量已经 backfill 导入并归档
 * .retired，映射与迁移决策见 ADR-0024），session_id 即幂等键（同 session 刷新，first_seen 首见冻结）。
 */
const V11_RETRO_LEDGER: Migration = {
  version: 11,
  name: "v11-retro-ledger",
  statements: [
    `CREATE TABLE retro (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source IN ('interactive','headless','attempt')),
      session_id TEXT,
      attempt_id TEXT,
      issue_number INTEGER,
      cwd TEXT NOT NULL,
      session_date TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      prompt_version TEXT NOT NULL,
      hook_version TEXT NOT NULL,
      conclusion TEXT,
      findings_json TEXT NOT NULL,
      not_covered_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('open','done','failed','skipped')),
      attempts INTEGER NOT NULL DEFAULT 1,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE UNIQUE INDEX retro_source_session_uniq ON retro(source, session_id)
      WHERE session_id IS NOT NULL`,
    `CREATE UNIQUE INDEX retro_source_attempt_uniq ON retro(source, attempt_id)
      WHERE attempt_id IS NOT NULL`,
    `CREATE INDEX retro_updated_idx ON retro(updated_at DESC)`,
    `CREATE TABLE retro_combo (
      session_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1,
      ts TEXT NOT NULL,
      cwd TEXT NOT NULL,
      source TEXT NOT NULL,
      task TEXT NOT NULL,
      form TEXT,
      form_hint TEXT,
      skills_json TEXT NOT NULL,
      verdict_json TEXT NOT NULL,
      actual_json TEXT NOT NULL,
      outcome_json TEXT NOT NULL,
      issue_json TEXT,
      artifact_json TEXT,
      verify_json TEXT,
      blocker_json TEXT,
      retro_path TEXT,
      gap TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )`,
    `CREATE INDEX retro_combo_last_seen_idx ON retro_combo(last_seen DESC)`,
  ],
};

export const MIGRATIONS: readonly Migration[] = [
  V2_FOUNDATION,
  V2_GOAL_STATUS,
  V2_WORKTREE_EXECUTION,
  V2_AUTOMATION_DEFAULT_POLICY,
  V2_SHADOW_GATE,
  V6_DROP_WORKTREE_INDEX,
  V7_CROSS_HARNESS_SESSION_IDENTITY,
  V8_PHASE1_SESSION_DETAIL_LOCATORS,
  V9_SYSTEMONE_ASSESSMENTS,
  V10_LOCATOR_LIFECYCLE,
  V11_RETRO_LEDGER,
];

const EPOCH_SECONDS = 1_000;

/** 逐级应用未跑过的迁移；整批包在一个事务里，任一失败全部回滚（不留半级 schema）。 */
export const applyMigrations = (
  db: DatabaseSync,
  extra: readonly Migration[] = [],
): number[] => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
  );
  const appliedRowsBefore = db.prepare("SELECT version, name FROM schema_migrations").all() as Array<{
    version: number;
    name: string;
  }>;
  // 同版本号不同名 = 两侧车道曾各自占用该版本号：直接续跑会在错误的历史上建表并卡死后续迁移
  for (const row of appliedRowsBefore) {
    const known = [...MIGRATIONS, ...extra].find((migration) => migration.version === row.version);
    if (known !== undefined && known.name !== row.name) {
      throw new Error(
        `migration ${row.version} was applied as '${row.name}', but this build expects '${known.name}'; ` +
          "refusing to start on a mismatched schema history",
      );
    }
  }
  const runAll = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  db.exec("BEGIN IMMEDIATE");
  let ranVersions: number[] = [];
  try {
    // 已应用版本必须在写锁内重读（ADR-0023 多写进程）：并发首开的另一进程可能在本进程
    // 上次快照之后、本次拿锁之前已提交同一批迁移，锁外快照会让 pending 重复执行并炸在
    // 「table already exists」上
    const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    const applied = new Set(appliedRows.map((row) => row.version));
    const pending = [...MIGRATIONS, ...extra]
      .filter((migration) => !applied.has(migration.version))
      .sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      for (const statement of migration.statements) db.exec(statement);
      runAll.run(migration.version, migration.name, Math.floor(Date.now() / EPOCH_SECONDS));
    }
    ranVersions = pending.map((migration) => migration.version);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return ranVersions;
};

/** 建库后种子的域 revision 初值（重复执行幂等）。 */
export const seedRevisions = (db: DatabaseSync): void => {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO revisions (domain, revision) VALUES (?, 0)",
  );
  insert.run("tasks");
  insert.run("threads");
  insert.run("config");
};
