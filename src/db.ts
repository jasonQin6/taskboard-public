/** state 数据库打开面：损坏隔离、WAL、迁移。绝不静默清空重建（词汇表「损坏隔离」）。 */

import { mkdir, rename } from "node:fs/promises";
import { access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, seedRevisions } from "./schema.js";

const BUSY_TIMEOUT_MS = 5_000;

export class DatabaseCorruptError extends Error {
  constructor(
    readonly dbPath: string,
    readonly isolatedPath: string,
    cause: unknown,
  ) {
    super(
      `database at ${dbPath} failed integrity check; ` +
        `the corrupt file has been moved to ${isolatedPath} and taskboard refuses to start ` +
        `(it never rebuilds an empty database over existing data); ` +
        `cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "DatabaseCorruptError";
  }
}

const fileExists = async (path: string): Promise<boolean> =>
  access(path, constants.F_OK)
    .then(() => true)
    .catch(() => false);

/** 本地时间紧凑戳（ms 精度），用于 `.corrupt-<ts>` 后缀，避免冒号入文件名。 */
const corruptStamp = (now = new Date()): string => {
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  );
};

const isolateCorruptDb = async (dbPath: string, cause: unknown): Promise<never> => {
  const stamp = corruptStamp();
  // WAL/SHM 随主文件一起搬走：新库不得继承旧 sidecar 里的事务残骸
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${dbPath}${suffix}`;
    if (await fileExists(from)) {
      await rename(from, `${dbPath}${suffix}.corrupt-${stamp}`);
    }
  }
  throw new DatabaseCorruptError(dbPath, `${dbPath}.corrupt-${stamp}`, cause);
};

export interface OpenStateDbResult {
  db: DatabaseSync;
  /** 本次打开是否新建了空库（false = 已有库被复用）。 */
  created: boolean;
}

/**
 * WAL 换模对并发连接会立即 SQLITE_BUSY 且不走 busy handler（SQLite 约束：换模期间不得有
 * 其他活跃连接）；daemon 与短命 CLI 可能同时首开同一空库（ADR-0023 多写进程），用短退避
 * 重试吸收对端的初始化窗口，而不是把竞态抛给调用方。换模幂等，重试无副作用。
 */
const setWalJournalMode = async (db: DatabaseSync): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (attempt >= 20 || !String(error).includes("locked")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
};

/**
 * 打开（必要时初始化）state 数据库。顺序固定：
 * 存在性检查 → 打开 → quick_check（失败即隔离拒启）→ WAL/外键 → 迁移 → 种子。
 */
export const openStateDb = async (dbPath: string): Promise<OpenStateDbResult> => {
  await mkdir(dirname(dbPath), { recursive: true });
  const existed = await fileExists(dbPath);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, {
      timeout: BUSY_TIMEOUT_MS,
      enableForeignKeyConstraints: true,
    });
  } catch (error) {
    // 打开即炸的已存在文件（非 SQLite 内容等）与不存在文件要分开：后者属于初始化失败
    if (!existed) throw error;
    return isolateCorruptDb(dbPath, error);
  }
  try {
    const row = db.prepare("PRAGMA quick_check").get() as
      | { quick_check?: string | number }
      | undefined;
    const verdict = row?.quick_check;
    if (verdict !== "ok") {
      throw new Error(`quick_check reported: ${String(verdict)}`);
    }
  } catch (error) {
    db.close();
    return isolateCorruptDb(dbPath, error);
  }
  await setWalJournalMode(db);
  applyMigrations(db);
  seedRevisions(db);
  return { db, created: !existed };
};

/** 只读便捷面：SQLITE_BUSY 不会因写锁重试而放大（timeout 同写侧）。 */
export const openStateDbReadOnly = (dbPath: string): DatabaseSync =>
  new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
