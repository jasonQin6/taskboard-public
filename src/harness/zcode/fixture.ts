/**
 * ZCode 源库 fixture：按 probe.ts 钉住的表/列集合构造最小 SQLite，形态对齐
 * ~/.zcode/cli/db/db.sqlite 实测结构（issue #44 探针记录）。可注入 schema 缺损
 * （omitColumn/omitTable）驱动降级路径。仅供测试，不进运行时。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface ZcodeFixtureTurn {
  turnId: string;
  status: string;
  startedAt: number;
  completedAt?: number | null;
}

export interface ZcodeFixtureMessage {
  id?: string;
  role: "user" | "assistant";
  created: number;
  completed?: number | null;
}

export interface ZcodeFixtureSession {
  id: string;
  directory?: string;
  title?: string;
  taskType?: string;
  parentId?: string | null;
  timeCreated?: number;
  timeUpdated?: number;
  turns?: ZcodeFixtureTurn[];
  messages?: ZcodeFixtureMessage[];
}

export interface ZcodeFixtureOptions {
  /** 形如 "session.directory"：建库时省略该列，制造 schema 漂移。 */
  omitColumn?: string;
  /** 形如 "message"：整表不建。 */
  omitTable?: string;
  migrationId?: string;
  appVersion?: string;
}

const CREATE_SESSIONS = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    path TEXT,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    task_type TEXT NOT NULL DEFAULT 'interactive'
  )`;

const CREATE_TURN_USAGE = `
  CREATE TABLE turn_usage (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (session_id, turn_id)
  )`;

const CREATE_MESSAGE = `
  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL,
    sequence INTEGER
  )`;

const CREATE_SCHEMA_MIGRATION = `
  CREATE TABLE schema_migration (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    app_version TEXT,
    time_applied INTEGER NOT NULL
  )`;

const stripColumn = (ddl: string, column: string): string => {
  // 只需处理 fixture 自己生成的建表 DDL：按行剔除目标列定义
  const lines = ddl.split("\n").filter((line) => !line.trim().startsWith(`${column} `));
  return lines.join("\n");
};

export const buildZcodeFixtureDb = async (
  dir: string,
  sessions: ZcodeFixtureSession[],
  options: ZcodeFixtureOptions = {},
): Promise<string> => {
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "db.sqlite");
  // DatabaseSync 无 :memory: + 路径复用需求冲突，直接落文件（测试断言只读性正好以它为目标）
  await writeFile(dbPath, "");
  const db = new DatabaseSync(dbPath);
  try {
    if (options.omitTable !== "session") {
      db.exec(options.omitColumn === "session.directory" ? stripColumn(CREATE_SESSIONS, "directory") : CREATE_SESSIONS);
    }
    if (options.omitTable !== "turn_usage") db.exec(CREATE_TURN_USAGE);
    if (options.omitTable !== "message") db.exec(CREATE_MESSAGE);
    if (options.omitTable !== "schema_migration") db.exec(CREATE_SCHEMA_MIGRATION);
    if (options.omitTable !== "schema_migration") {
      db.prepare("INSERT INTO schema_migration (id, checksum, app_version, time_applied) VALUES (?, 'x', ?, 1)").run(
        options.migrationId ?? "0024_session_database_identity",
        options.appVersion ?? "0.16.9",
      );
    }
    const insertSession = db.prepare(
      options.omitColumn === "session.directory"
        ? "INSERT INTO session (id, project_id, parent_id, slug, title, version, time_created, time_updated, task_type) " +
            "VALUES (?, 'proj', ?, ?, ?, 'v1', ?, ?, ?)"
        : "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, task_type) " +
            "VALUES (?, 'proj', ?, ?, ?, ?, 'v1', ?, ?, ?)",
    );
    const insertTurn = db.prepare(
      "INSERT INTO turn_usage (session_id, turn_id, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)",
    );
    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    for (const session of sessions) {
      const args: SQLInputValue[] = [
        session.id,
        session.parentId ?? null,
        session.id,
        ...(options.omitColumn === "session.directory"
          ? []
          : [session.directory ?? "/tmp/workspace/zcode-fixture"]),
        session.title ?? "",
        session.timeCreated ?? session.timeUpdated ?? 1,
        session.timeUpdated ?? 1,
        session.taskType ?? "interactive",
      ];
      insertSession.run(...args);
      for (const turn of session.turns ?? []) {
        insertTurn.run(session.id, turn.turnId, turn.status, turn.startedAt, turn.completedAt ?? null);
      }
      let sequence = 0;
      for (const message of session.messages ?? []) {
        const data: Record<string, unknown> = { role: message.role, time: { created: message.created } };
        if (message.completed !== null && message.completed !== undefined) {
          (data.time as Record<string, unknown>).completed = message.completed;
        }
        insertMessage.run(message.id ?? `msg_${session.id}_${sequence}`, session.id, message.created, message.created, JSON.stringify(data));
        sequence += 1;
      }
    }
  } finally {
    db.close();
  }
  return dbPath;
};
