/**
 * issue-worker 控制面存储：job/run/outbox/event 四表 + 单例锁。
 * 全部写操作走 BEGIN IMMEDIATE；lease 决定同一时刻只有一个 active job。
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** 终局 stage：job 不再被 scan 接管，lease 释放。 */
export const TERMINAL_STAGES = new Set(["delivered", "merged", "ready-human", "needs-info", "blocked"]);
/** 活跃 stage：全局至多一个（按 repo 计）。 */
export const ACTIVE_STAGES = new Set([
  "claimed",
  "implementing",
  "gating",
  "auditing",
  "accepting",
]);

export type JobStage =
  | "claimed"
  | "implementing"
  | "gating"
  | "auditing"
  | "accepting"
  | "delivered"
  | "merged"
  | "ready-human"
  | "needs-info"
  | "blocked";

export interface JobRow {
  repo: string;
  issue: number;
  stage: string;
  branch: string | null;
  base_sha: string | null;
  head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  run_id: string | null;
  run_session_id: string | null;
  pid: number | null;
  log_dir: string | null;
  implementation_attempt: number;
  rework_round: number;
  delivery_attempt: number;
  input_digest: string | null;
  evidence_json: string | null;
  merge_evidence_json: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  run_key: string;
  run_id: string | null;
  job_repo: string;
  job_issue: number;
  kind: string;
  session_id: string | null;
  pid: number | null;
  log_dir: string | null;
  args_json: string;
  status: string;
  started_at: number;
  ended_at: number | null;
}

export interface OutboxRow {
  id: number;
  repo: string;
  issue: number;
  action: string;
  idempotency_key: string;
  payload_json: string;
  state: string;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  id: number;
  repo: string;
  issue: number;
  at: number;
  kind: string;
  detail_json: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job (
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  stage TEXT NOT NULL,
  branch TEXT,
  base_sha TEXT,
  head_sha TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  run_id TEXT,
  run_session_id TEXT,
  pid INTEGER,
  log_dir TEXT,
  implementation_attempt INTEGER NOT NULL DEFAULT 0,
  rework_round INTEGER NOT NULL DEFAULT 0,
  delivery_attempt INTEGER NOT NULL DEFAULT 0,
  input_digest TEXT,
  evidence_json TEXT,
  merge_evidence_json TEXT,
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, issue)
);
CREATE TABLE IF NOT EXISTS run (
  run_key TEXT PRIMARY KEY,
  run_id TEXT UNIQUE,
  job_repo TEXT NOT NULL,
  job_issue INTEGER NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  pid INTEGER,
  log_dir TEXT,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (action, idempotency_key)
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  issue INTEGER NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox (repo, issue, state);
CREATE INDEX IF NOT EXISTS idx_event_issue ON event (repo, issue, id);
`;

export class Store {
  readonly db: DatabaseSync;
  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(dbPath: string): Store {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(SCHEMA);
    const jobColumns = db.prepare("PRAGMA table_info(job)").all() as { name?: string }[];
    if (!jobColumns.some((column) => column.name === "evidence_json")) {
      db.exec("ALTER TABLE job ADD COLUMN evidence_json TEXT");
    }
    if (!jobColumns.some((column) => column.name === "merge_evidence_json")) {
      db.exec("ALTER TABLE job ADD COLUMN merge_evidence_json TEXT");
    }
    return new Store(db);
  }

  static openReadOnly(dbPath: string): Store {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  /** 写事务：BEGIN IMMEDIATE 抢写锁，异常回滚。读-改-写必须包在这里面。 */
  transact<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 回滚本身失败已无可为，抛原始错误
      }
      throw error;
    }
  }

  getJob(repo: string, issue: number): JobRow | null {
    const row = this.db.prepare("SELECT * FROM job WHERE repo = ? AND issue = ?").get(repo, issue);
    return (row as JobRow | undefined) ?? null;
  }

  getActiveJob(repo: string): JobRow | null {
    const placeholders = [...ACTIVE_STAGES].map(() => "?").join(",");
    const row = this.db
      .prepare(`SELECT * FROM job WHERE repo = ? AND stage IN (${placeholders}) LIMIT 1`)
      .get(repo, ...ACTIVE_STAGES);
    return (row as JobRow | undefined) ?? null;
  }

  listJobs(repo: string): JobRow[] {
    return this.db
      .prepare("SELECT * FROM job WHERE repo = ? ORDER BY issue")
      .all(repo) as unknown as JobRow[];
  }

  upsertClaim(input: {
    repo: string;
    issue: number;
    branch: string;
    baseSha: string;
    digest: string;
    owner: string;
    leaseUntil: number;
    mode: "implement" | "rework";
    previousHeadSha?: string;
  }): JobRow {
    return this.transact(() => {
      const active = this.getActiveJob(input.repo);
      if (active !== null && active.issue !== input.issue) {
        throw new Error(`another job is active for ${input.repo}: issue ${active.issue}`);
      }
      const existing = this.getJob(input.repo, input.issue);
      const now = Date.now();
      const baseSha = input.baseSha === "" ? (existing?.base_sha ?? "") : input.baseSha;
      if (existing === null) {
        this.db
          .prepare(
            `INSERT INTO job (repo, issue, stage, branch, base_sha, head_sha, pr_number, pr_url,
             run_id, run_session_id, pid, log_dir, implementation_attempt, rework_round,
             delivery_attempt, input_digest, merge_evidence_json, lease_owner, lease_until, last_error,
             created_at, updated_at)
             VALUES (?, ?, 'claimed', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            input.repo,
            input.issue,
            input.branch,
            baseSha,
            input.previousHeadSha ?? null,
            null,
            null,
            null,
            null,
            process.pid,
            null,
            input.digest,
            null,
            input.owner,
            input.leaseUntil,
            now,
            now,
          );
      } else {
        if (existing.stage !== "claimed" && !TERMINAL_STAGES.has(existing.stage)) {
          throw new Error(`issue ${input.issue} already has active job stage=${existing.stage}`);
        }
        const startsNewRun = TERMINAL_STAGES.has(existing.stage);
        this.db
          .prepare(
            `UPDATE job SET stage = 'claimed', branch = ?, base_sha = ?,
             run_id = ?, run_session_id = ?, log_dir = ?,
             implementation_attempt = ?, rework_round = ?, delivery_attempt = ?,
             evidence_json = ?, merge_evidence_json = ?,
             lease_owner = ?, lease_until = ?, pid = ?, input_digest = ?,
             last_error = NULL, updated_at = ? WHERE repo = ? AND issue = ?`,
          )
          .run(
            input.branch,
            baseSha,
            startsNewRun ? null : existing.run_id,
            startsNewRun ? null : existing.run_session_id,
            startsNewRun ? null : existing.log_dir,
            startsNewRun ? 0 : existing.implementation_attempt,
            startsNewRun ? 0 : existing.rework_round,
            startsNewRun ? 0 : existing.delivery_attempt,
            startsNewRun ? null : existing.evidence_json,
            startsNewRun ? null : existing.merge_evidence_json,
            input.owner,
            input.leaseUntil,
            process.pid,
            input.digest,
            now,
            input.repo,
            input.issue,
          );
      }
      const row = this.getJob(input.repo, input.issue);
      if (row === null) throw new Error("claim did not persist");
      return row;
    });
  }

  setStage(repo: string, issue: number, stage: JobStage, patch: Partial<JobRow> = {}): void {
    this.transact(() => {
      const columns: string[] = ["stage = ?", "updated_at = ?"];
      const values: SQLInputValue[] = [stage, Date.now()];
      for (const [key, value] of Object.entries(patch)) {
        columns.push(`${key} = ?`);
        values.push(value as SQLInputValue);
      }
      values.push(repo, issue);
      this.db
        .prepare(`UPDATE job SET ${columns.join(", ")} WHERE repo = ? AND issue = ?`)
        .run(...values);
    });
  }

  recordRun(row: Omit<RunRow, "ended_at"> & { ended_at?: number | null }): void {
    this.db
      .prepare(
        `INSERT INTO run (run_key, run_id, job_repo, job_issue, kind, session_id, pid,
         log_dir, args_json, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_key) DO UPDATE SET run_id = excluded.run_id,
           session_id = excluded.session_id, pid = excluded.pid, log_dir = excluded.log_dir,
           args_json = excluded.args_json, status = excluded.status, ended_at = excluded.ended_at`,
      )
      .run(
        row.run_key,
        row.run_id,
        row.job_repo,
        row.job_issue,
        row.kind,
        row.session_id,
        row.pid,
        row.log_dir,
        row.args_json,
        row.status,
        row.started_at,
        row.ended_at ?? null,
      );
  }

  getRun(runKey: string): RunRow | null {
    const row = this.db.prepare("SELECT * FROM run WHERE run_key = ?").get(runKey);
    return (row as RunRow | undefined) ?? null;
  }

  listRuns(repo: string, issue: number): RunRow[] {
    return this.db
      .prepare("SELECT * FROM run WHERE job_repo = ? AND job_issue = ? ORDER BY started_at, run_key")
      .all(repo, issue) as unknown as RunRow[];
  }

  enqueueOutbox(input: {
    repo: string;
    issue: number;
    action: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO outbox (repo, issue, action, idempotency_key, payload_json, state,
         attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
         ON CONFLICT (action, idempotency_key) DO NOTHING`,
      )
      .run(
        input.repo,
        input.issue,
        input.action,
        input.idempotencyKey,
        JSON.stringify(input.payload),
        now,
        now,
      );
  }

  pendingOutbox(repo: string, issue: number): OutboxRow[] {
    return this.db
      .prepare("SELECT * FROM outbox WHERE repo = ? AND issue = ? AND state = 'pending' ORDER BY id")
      .all(repo, issue) as unknown as OutboxRow[];
  }

  getOutbox(action: string, key: string): OutboxRow | null {
    const row = this.db
      .prepare("SELECT * FROM outbox WHERE action = ? AND idempotency_key = ?")
      .get(action, key);
    return (row as OutboxRow | undefined) ?? null;
  }

  markOutbox(
    action: string,
    key: string,
    state: "done" | "failed" | "pending",
    lastError?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE outbox SET state = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
         WHERE action = ? AND idempotency_key = ?`,
      )
      .run(state, lastError ?? null, Date.now(), action, key);
  }

  appendEvent(repo: string, issue: number, kind: string, detail: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO event (repo, issue, at, kind, detail_json) VALUES (?, ?, ?, ?, ?)")
      .run(repo, issue, Date.now(), kind, JSON.stringify(detail));
  }

  recentEvents(repo: string, issue: number, limit = 20): EventRow[] {
    return this.db
      .prepare("SELECT * FROM event WHERE repo = ? AND issue = ? ORDER BY id DESC LIMIT ?")
      .all(repo, issue, limit) as unknown as EventRow[];
  }
}

export const leaseAlive = (job: JobRow, now = Date.now()): boolean =>
  job.lease_until !== null && job.lease_until > now;

export interface SingletonLock {
  release: () => void;
}

/**
 * 进程单例锁：O_EXCL 建文件写 PID；已存在时检查持有者是否存活，
 * 存活则拒绝，死亡或超 staleMs 则接管。退出时删锁（幂等）。
 */
export const acquireSingletonLock = (
  lockPath: string,
  options: { staleMs?: number; heartbeatMs?: number } = {},
): SingletonLock => {
  const staleMs = options.staleMs ?? 90_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  mkdirSync(dirname(lockPath), { recursive: true });
  const claim = (): void => {
    const fd = openSync(lockPath, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
  };
  try {
    claim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw error;
    let holderPid = -1;
    let mtime = 0;
    try {
      const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
      if (typeof raw.pid === "number") holderPid = raw.pid;
    } catch {
      holderPid = -1;
    }
    try {
      mtime = statSync(lockPath).mtimeMs;
    } catch {
      mtime = 0;
    }
    let alive = false;
    if (holderPid > 0) {
      try {
        process.kill(holderPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive && Date.now() - mtime < staleMs) {
      throw new Error(`another issue-worker holds ${lockPath} (pid ${holderPid})`);
    }
    renameSync(lockPath, `${lockPath}.stale-${Date.now()}`);
    claim();
  }
  const heartbeat = setInterval(() => {
    try {
      writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
    } catch {
      // 心跳失败不打断主循环，下次文件检查会发现
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      try {
        const raw = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
        if (raw.pid !== process.pid) return;
      } catch {
        return;
      }
      try {
        rmSync(lockPath, { force: true });
      } catch {
        // 删锁失败不抛错，避免掩盖主流程错误
      }
    },
  };
};

export const singletonLockPathFor = (stateDir: string): string => join(stateDir, "singleton.lock");
export const stateDbPathFor = (stateDir: string): string => join(stateDir, "state.sqlite3");
