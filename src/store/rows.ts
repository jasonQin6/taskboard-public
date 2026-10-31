/**
 * store 各族共用的行映射纯函数（ADR-0016 #19 步②自 src/store.ts 抽取）：
 * 无状态；行查询缝（queryAll/queryGet/queryReread，晨析 10-25）供 ./task-store.js 等族文件共用，
 * 行类型断言收敛于此——替代散落族内的 `as unknown as XxxRow` 双重断言仪式。
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export const queryAll = <T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T[] =>
  db.prepare(sql).all(...params) as T[];

export const queryGet = <T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T | undefined =>
  db.prepare(sql).get(...params) as T | undefined;

/**
 * 刚写入行的回读（INSERT/UPDATE 后的同事务 SELECT）：行缺失属不变量破坏，显式炸优于
 * 旧 `as unknown as XxxRow` 断言把 undefined 静默传进 fromRow 的晚崩。
 */
export const queryReread = <T>(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): T => {
  const row = queryGet<T>(db, sql, ...params);
  if (row === undefined) throw new Error(`reread row missing: ${sql}`);
  return row;
};

/** 损坏 JSON 列容错：单个坏行不得拖垮整个列表视图（props/payload/detail 是外部不可信写入面）。 */
export const safeParseJsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const iso = (ms: number | null | undefined): string | null =>
  ms === null || ms === undefined ? null : new Date(ms).toISOString();

export const plain = <T extends object>(row: T): T => ({ ...row });
