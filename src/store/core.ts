/**
 * StoreCore：state 写入面的底盘（ADR-0016 #19 步①落位）——事务与域 revision（write 深缝）、
 * 幂等键、newId（settings 域已外挪 ./settings-store.ts，晨析 10-25 收窄为纯底盘）。域方法按族
 * 拆分后由各族 store 经此进事务；Store 门面（src/store/index.ts）把本底盘的公共方法按原签名转发。
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { REVISION_DOMAINS, type RevisionChange, type RevisionDomain } from "../types.js";

export const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

export const IDEMPOTENCY_RING = 256;

export interface Touch {
  (domain: RevisionDomain, id?: string): void;
}

/** 域 revision 的键集合唯一声明处在 REVISION_DOMAINS（types.ts）；本类型从它派生，不另列键。 */
type TouchedDomains = Record<RevisionDomain, Set<string>>;

export class StoreCore {
  private readonly listeners = new Set<(changes: RevisionChange[]) => void>();
  private active: TouchedDomains | null = null;
  private readonly nowMs: () => number;

  constructor(
    readonly db: DatabaseSync,
    options: { now?: () => number } = {},
  ) {
    this.nowMs = options.now ?? (() => Date.now());
  }

  readonly now = (): number => this.nowMs();

  // ---- 事务与域 revision ----

  subscribe(listener: (changes: RevisionChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(changes: RevisionChange[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(changes);
      } catch {
        // 监听者异常不得影响写入方
      }
    }
  }

  write<T>(fn: (touch: Touch) => T): T {
    if (this.active !== null) return fn(this.buildTouch(this.active));
    const touched: TouchedDomains = { tasks: new Set(), threads: new Set(), config: new Set() };
    this.active = touched;
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn(this.buildTouch(touched));
      const changes = this.bumpRevisions(touched);
      this.db.exec("COMMIT");
      this.active = null;
      if (changes.length > 0) this.emit(changes);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.active = null;
      throw error;
    }
  }

  private buildTouch(touched: TouchedDomains): Touch {
    return (domain, id) => {
      const set = touched[domain];
      if (id !== undefined) set.add(id);
      else set.add("*");
    };
  }

  private bumpRevisions(touched: TouchedDomains): RevisionChange[] {
    const changes: RevisionChange[] = [];
    for (const domain of REVISION_DOMAINS) {
      const ids = touched[domain];
      if (ids.size === 0) continue;
      const row = this.db
        .prepare("UPDATE revisions SET revision = revision + 1 WHERE domain = ? RETURNING revision")
        .get(domain) as { revision: number } | undefined;
      if (row === undefined) {
        throw new Error(`revisions row missing for domain ${domain}`);
      }
      // "*" 表示未指明具体 id（如 settings 变更）；有具体 id 时不广播星号
      const concrete = [...ids].filter((id) => id !== "*");
      changes.push({ domain, revision: row.revision, ids: concrete.length > 0 ? concrete : ["*"] });
    }
    return changes;
  }

  revisions(): Record<RevisionDomain, number> {
    const rows = this.db.prepare("SELECT domain, revision FROM revisions").all() as Array<{
      domain: string;
      revision: number;
    }>;
    const out = { tasks: 0, threads: 0, config: 0 } as Record<RevisionDomain, number>;
    for (const row of rows) {
      if (row.domain === "tasks" || row.domain === "threads" || row.domain === "config") {
        out[row.domain] = row.revision;
      }
    }
    return out;
  }

  // ---- 幂等键 ----

  recallResponse(requestId: string): { action: string; status: number; response: unknown } | null {
    const row = this.db
      .prepare("SELECT action, status, response FROM idempotency_keys WHERE request_id = ?")
      .get(requestId) as { action: string; status: number; response: string } | undefined;
    if (row === undefined) return null;
    return { action: row.action, status: row.status, response: JSON.parse(row.response) };
  }

  rememberResponse(requestId: string, action: string, status: number, response: unknown): void {
    this.write(() => {
      this.db
        .prepare(
          "INSERT INTO idempotency_keys (request_id, action, status, response, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(requestId, action, status, JSON.stringify(response), this.now());
      // 环形表：只留最近 256 条；按 rowid 而非时间戳裁，同一毫秒内的插入也保持先后
      this.db
        .prepare(
          `DELETE FROM idempotency_keys WHERE rowid IN (
             SELECT rowid FROM idempotency_keys ORDER BY rowid DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(IDEMPOTENCY_RING);
    });
  }
}
