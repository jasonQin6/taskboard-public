/**
 * ZCode 权威库 schema 探针：adapter 只消费这里钉住的表/列集合。上游升级改列名时，
 * 探针失败会让整个 harness 降级为结构化 failure（而不是猜错语义），这是 ADR-0018
 * unknown 降级在 schema 层的对应物。真实库实测记录见 issue #44 评论。
 */

import { DatabaseSync } from "node:sqlite";

/** 表 → 必需列。缺任何一项即判 schema 不匹配，不做部分读取。 */
export const ZCODE_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  session: ["id", "directory", "title", "task_type", "parent_id", "time_created", "time_updated", "time_compacting", "time_archived"],
  turn_usage: ["session_id", "turn_id", "status", "started_at", "completed_at"],
  message: ["session_id", "time_created", "data"],
  schema_migration: ["id", "app_version"],
});

export interface ZcodeSchemaProbe {
  /** true = 必需表列全部在场，可以安全读取。 */
  ok: boolean;
  /** 缺失项，形如 "session.directory"；供 failure message 与审计。 */
  missing: string[];
  /** schema_migration id 集合（确定性顺序），进 capabilityManifest.schemaVersion。 */
  migrationIds: string[];
  /** 最近一次迁移的 app_version；探不到为 null。 */
  appVersion: string | null;
}

export const ZCODE_SCHEMA_VERSION_UNKNOWN = "zcode-sqlite/unknown";

/** 只读打开。WAL 库以 readOnly 连接访问，不产生 checkpoint 也不改 -shm/-wal。 */
export const openZcodeDbReadOnly = (dbPath: string): DatabaseSync =>
  new DatabaseSync(dbPath, { readOnly: true });

const columnsOf = (db: DatabaseSync, table: string): Set<string> => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
};

export const probeZcodeSchema = (db: DatabaseSync): ZcodeSchemaProbe => {
  const missing: string[] = [];
  for (const [table, columns] of Object.entries(ZCODE_REQUIRED_COLUMNS)) {
    const present = columnsOf(db, table);
    for (const column of columns) {
      if (!present.has(column)) missing.push(`${table}.${column}`);
    }
  }
  let migrationIds: string[] = [];
  let appVersion: string | null = null;
  if (missing.length === 0) {
    const rows = db
      .prepare("SELECT id, app_version FROM schema_migration ORDER BY id")
      .all() as Array<{ id: string; app_version: string | null }>;
    migrationIds = rows.map((row) => row.id);
    for (const row of rows) {
      if (row.app_version !== null) appVersion = row.app_version;
    }
  }
  return { ok: missing.length === 0, missing, migrationIds, appVersion };
};

export const zcodeSchemaVersion = (probe: ZcodeSchemaProbe): string => {
  if (!probe.ok || probe.migrationIds.length === 0) return ZCODE_SCHEMA_VERSION_UNKNOWN;
  const last = probe.migrationIds[probe.migrationIds.length - 1]!;
  // 迁移 id 是单调增的 schema 指纹（如 0024_session_database_identity），比 app_version 更稳定
  return `zcode-sqlite/${last}`;
};
