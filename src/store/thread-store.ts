/**
 * ThreadStore：线程族域方法（ADR-0016 #19 步③自 src/store.ts 挪出）——threads 读取面/
 * thread 绑定/reader 扫描游标/reader 写面/线程评估状态五节。写方法一律经 StoreCore 的事务缝
 * （core.write：一个事务 + Touch 跨域收集 + revision 广播），跨域 touch 语义不变；
 * 公共方法签名与原 Store 逐字一致，Store 门面（src/store/index.ts，src/store.ts 为 re-export 垫片）按原签名转发。
 * 协作面（只挪代码，不改关系）：reader 写面（commitSourceScan 等）是 reader/scanner 的唯一
 * 入库通道；评估状态节被 jev/automation/summary 消费——调用面仍经 Store 门面。
 */

import type { DatabaseSync } from "node:sqlite";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import {
  THREAD_BINDING_ROLES,
  type Thread,
  type ThreadBinding,
  type ThreadBindingRole,
  type ThreadLineageEdge,
  type ThreadNativeStatus,
} from "../types.js";
import { newId, StoreCore } from "./core.js";
import { iso, queryAll, queryGet, safeParseJsonObject } from "./rows.js";
import type { TaskStore } from "./task-store.js";

interface ThreadRow {
  id: string;
  harness_id: string;
  native_session_id: string | null;
  native_status: string;
  title: string | null;
  workspace: string | null;
  native_group: string | null;
  source_path: string | null;
  source_byte_start: number | null;
  source_record_hash: string | null;
  last_activity_at: number | null;
  first_seen_at: number;
  ignored: number;
  ignored_at: number | null;
  goal_status: string | null;
}

export type ReaderTurnStatus = "running" | "completed" | "failed" | "interrupted";
export type ReaderSourceLocatorKind = "start" | "terminal";

export interface ReaderTurn {
  id: string;
  threadId: string;
  ordinal: number;
  nativeStatus: ReaderTurnStatus;
  startedAt: number | null;
  endedAt: number | null;
  sourceRef: string | null;
  /** 原 source unit 内定位；sourceLocatorKind 区分起点与终态回退，旧行位置未知时为 null。 */
  sourceByteStart: number | null;
  sourceRecordHash: string | null;
  sourceLocatorKind: ReaderSourceLocatorKind | null;
}

interface ReaderTurnRow {
  id: string;
  thread_id: string;
  ordinal: number;
  native_status: string;
  started_at: number | null;
  ended_at: number | null;
  source_ref: string | null;
  source_byte_start: number | null;
  source_record_hash: string | null;
  source_locator_kind: string | null;
}

export interface ReaderSourceView {
  sourceId: string;
  path: string;
  threadId: string;
  inode: number;
  size: number;
  mtime: number;
  consumedBytes: number;
  prefixHash: string;
  tailHash: string | null;
  nextOrdinal: number | null;
  parserVersion: number;
  rewritten: boolean;
  updatedAt: string;
}

export interface ObservedSessionRecord {
  id: string;
  harnessId: string;
  nativeSessionId: string | null;
  nativeStatus: string;
  title: string | null;
  workspace: string | null;
  nativeGroup: string | null;
  lastActivityAt: number | null;
  sourcePath: string | null;
  sourceByteStart: number | null;
  sourceRecordHash: string | null;
}

interface ReaderSourceRow {
  source_id: string;
  path: string;
  thread_id: string;
  inode: number;
  size: number;
  mtime: number;
  consumed_bytes: number;
  prefix_hash: string;
  tail_hash: string | null;
  next_ordinal: number | null;
  parser_version: number;
  rewritten: number;
  updated_at: number;
}

export interface EvidenceView {
  id: string;
  threadId: string;
  sourceId: string;
  byteStart: number;
  recordHash: string;
  turnOrdinal: number | null;
  kind: string;
  summary: string | null;
  props: Record<string, unknown> | null;
  superseded: boolean;
  createdAt: string;
  /** evidence 所属 source unit 的路径；source 已失联时为 null（由投影层如实降级）。 */
  sourcePath: string | null;
}

interface EvidenceRow {
  id: string;
  thread_id: string;
  source_id: string;
  byte_start: number;
  record_hash: string;
  turn_ordinal: number | null;
  kind: string;
  summary: string | null;
  props: string | null;
  superseded: number;
  created_at: number;
  source_path: string | null;
}

export interface ThreadSummaryView {
  id: string;
  threadId: string;
  provenance: "compacted" | "sample" | "none";
  text: string;
  sourceRef: string | null;
  /** compacted：source unit + 字节位置 + 记录 hash；sample/none 或旧行为 null。 */
  sourceId: string | null;
  byteStart: number | null;
  recordHash: string | null;
  /** 摘要覆盖到的最后 turn ordinal（compacted 记录当时的最后已知 turn）；未知为 null。 */
  coveredThroughTurnOrdinal: number | null;
  /** source rewrite 删除 compaction 后保留文本审计，但不再作为可回源摘要。 */
  superseded: boolean;
  createdAt: string;
}

/** 每线程评估状态（词汇表「no-op 指纹」「断路器」）：只记结论与证据键，不记时间戳型指纹。 */
export interface ThreadEvaluationStateView {
  threadId: string;
  lastEvaluatedAt: string | null;
  evidenceFingerprint: string | null;
  lastNoOp: boolean;
  consecutiveFailures: number;
  breakerOpen: boolean;
  updatedAt: string;
}

/** 断路器阈值：sample/Jev 连续失败 3 次暂停该线程自动评估（需求「Summary 与 Next Action」）。 */
export const EVALUATION_BREAKER_THRESHOLD = 3;

/** 断路器审计 annotation kind：打开（落审计）与人工 resume（恢复留痕）。 */
export const EVALUATION_BREAKER_OPENED_ANNOTATION = "evaluation_breaker_opened";
export const EVALUATION_BREAKER_RESUMED_ANNOTATION = "evaluation_breaker_resumed";

interface SummaryRow {
  id: string;
  thread_id: string;
  provenance: string;
  text: string;
  source_ref: string | null;
  source_id: string | null;
  byte_start: number | null;
  record_hash: string | null;
  covered_through_turn_ordinal: number | null;
  superseded: number;
  created_at: number;
}

const summaryFromRow = (row: SummaryRow): ThreadSummaryView => ({
  id: row.id,
  threadId: row.thread_id,
  provenance: row.provenance as ThreadSummaryView["provenance"],
  text: row.text,
  sourceRef: row.source_ref,
  sourceId: row.source_id,
  byteStart: row.byte_start,
  recordHash: row.record_hash,
  coveredThroughTurnOrdinal: row.covered_through_turn_ordinal,
  superseded: row.superseded !== 0,
  createdAt: new Date(row.created_at).toISOString(),
});

/** reader 一次 source unit 扫描的提交载荷；字段语义见 commitSourceScan。 */
export interface SourceScanPatch {
  source: {
    sourceId: string;
    path: string;
    threadId: string;
    inode: number;
    size: number;
    mtime: number;
    consumedBytes: number;
    prefixHash: string;
    tailHash: string | null;
    nextOrdinal: number | null;
    parserVersion: number;
    /** 本轮是否判定为重写重建（reader_sources.rewritten 记录最近一轮判定）。 */
    rewritten: boolean;
  };
  /**
   * 文件内出现过的 session（按首现顺序）。一个文件可能中途切换 session（resume/fork 同文件），
   * 故按 thread 逐个 upsert；nativeStatus null 表示本轮无 turn 事件，保留库内既有状态。
   */
  threads: Array<{
    id: string;
    harnessId: string;
    nativeSessionId?: string;
    nativeStatus: ThreadNativeStatus | null;
    title: string | null;
    workspace?: string | null;
    nativeGroup?: string | null;
    sourcePath?: string | null;
    sourceByteStart?: number | null;
    sourceRecordHash?: string | null;
    lastActivityAt: number;
  }>;
  turns: Array<{
    id: string;
    threadId: string;
    ordinal: number;
    nativeStatus: ReaderTurnStatus;
    startedAt: number | null;
    endedAt: number | null;
    sourceRef: string;
    sourceByteStart?: number | null;
    sourceRecordHash?: string | null;
    sourceLocatorKind?: ReaderSourceLocatorKind | null;
  }>;
  evidence: Array<{
    threadId: string;
    sourceId: string;
    byteStart: number;
    recordHash: string;
    turnOrdinal: number | null;
    kind: string;
    summary: string | null;
    props: Record<string, unknown> | null;
  }>;
  /** 重写重建：先 supersede 该 source 全部旧证据再幂等恢复（不删行）。 */
  supersedeEvidence: boolean;
  /** 重写重建：旧行 turn 随 source_ref 删除后按稳定 id 重建（单事务内收敛）。 */
  rebuildTurns: boolean;
  anomalies: Array<{ sourceId: string; kind: string; detail: string; byteOffset: number }>;
  /** 重写重建：该 source 旧 anomaly 全部置 resolved，再记录新内容中的异常。 */
  resolveAnomalies: boolean;
  summaries: Array<{
    threadId: string;
    text: string;
    sourceRef: string;
    byteStart?: number | null;
    recordHash?: string | null;
    coveredThroughTurnOrdinal?: number | null;
  }>;
  lineage: Array<{ threadId: string; parentThreadId: string; relation: string }>;
}

const readerSourceFromRow = (row: ReaderSourceRow): ReaderSourceView => ({
  sourceId: row.source_id,
  path: row.path,
  threadId: row.thread_id,
  inode: row.inode,
  size: row.size,
  mtime: row.mtime,
  consumedBytes: row.consumed_bytes,
  prefixHash: row.prefix_hash,
  tailHash: row.tail_hash,
  nextOrdinal: row.next_ordinal,
  parserVersion: row.parser_version,
  rewritten: row.rewritten === 1,
  updatedAt: new Date(row.updated_at).toISOString(),
});

const readerTurnFromRow = (row: ReaderTurnRow): ReaderTurn => ({
  id: row.id,
  threadId: row.thread_id,
  ordinal: row.ordinal,
  nativeStatus: row.native_status as ReaderTurnStatus,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  sourceRef: row.source_ref,
  sourceByteStart: row.source_byte_start,
  sourceRecordHash: row.source_record_hash,
  sourceLocatorKind: row.source_locator_kind as ReaderSourceLocatorKind | null,
});

const evidenceFromRow = (row: EvidenceRow): EvidenceView => ({
  id: row.id,
  threadId: row.thread_id,
  sourceId: row.source_id,
  byteStart: row.byte_start,
  recordHash: row.record_hash,
  turnOrdinal: row.turn_ordinal,
  kind: row.kind,
  summary: row.summary,
  props: row.props === null ? null : safeParseJsonObject(row.props),
  superseded: row.superseded === 1,
  createdAt: new Date(row.created_at).toISOString(),
  sourcePath: row.source_path,
});

export class ThreadStore {
  private readonly core: StoreCore;
  private readonly tasks: TaskStore;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(core: StoreCore, tasks: TaskStore) {
    this.core = core;
    this.tasks = tasks;
    this.db = core.db;
    this.now = (): number => core.now();
  }

  // ---- threads（读取面；reader 写入面见下方「reader 写面」段） ----

  upsertThread(input: {
    id: string;
    /** 身份由调用方显式传入：store 不再拥有具体 harness 的默认值（ADR-0018 身份对）。 */
    harnessId: string;
    nativeStatus?: ThreadNativeStatus;
    title?: string | null;
    lastActivityAt?: number | null;
    /** 记录最近观测的 goal 状态（证据缓存）。 */
    goalStatus?: string;
    /** 显式清除 goal 状态（goal clear / 服务端返回 null）。与 goalStatus 互斥使用。 */
    clearGoalStatus?: boolean;
  }): Thread {
    return this.core.write((touch) => {
      const now = this.now();
      const existing = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(input.id) as
        | ThreadRow
        | undefined;
      if (existing === undefined) {
        this.db
          .prepare(
            "INSERT INTO threads (id, harness_id, native_session_id, native_status, title, last_activity_at, " +
              "first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.id,
            input.harnessId,
            input.id,
            input.nativeStatus ?? "unknown",
            input.title ?? null,
            input.lastActivityAt ?? null,
            now,
            now,
          );
      } else {
        this.db
          .prepare(
            "UPDATE threads SET native_status = COALESCE(?, native_status), title = COALESCE(?, title), " +
              "last_activity_at = COALESCE(?, last_activity_at), updated_at = ? WHERE id = ?",
          )
          .run(
            input.nativeStatus ?? null,
            input.title ?? null,
            input.lastActivityAt ?? null,
            now,
            input.id,
          );
      }
      // goal 状态是三态写入（set/clear/keep），主 upsert 的 COALESCE 表达不了显式清空，单独收口
      if (input.clearGoalStatus === true || input.goalStatus !== undefined) {
        this.db
          .prepare("UPDATE threads SET goal_status = ?, updated_at = ? WHERE id = ?")
          .run(input.clearGoalStatus === true ? null : (input.goalStatus ?? null), now, input.id);
      }
      touch("threads", input.id);
      return this.requireThread(input.id);
    });
  }

  /** 原为 Store 的 private 辅助（步③随族搬入）；协作节（如 AutomationStore.addProposal）经注入的 ThreadStore 实例调用，门面不暴露 requireThread。 */
  requireThread(id: string): Thread {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
    if (row === undefined) throw new NotFoundError(`thread not found: ${id}`);
    const primary = this.db
      .prepare("SELECT task_id FROM task_threads WHERE thread_id = ? AND role = 'primary'")
      .get(id) as { task_id: string } | undefined;
    return {
      id: row.id,
      nativeStatus: row.native_status as Thread["nativeStatus"],
      title: row.title,
      lastActivityAt: iso(row.last_activity_at),
      firstSeenAt: new Date(row.first_seen_at).toISOString(),
      ignored: row.ignored === 1,
      primaryTaskId: primary?.task_id ?? null,
      goalStatus: row.goal_status,
    };
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(id);
    return row === undefined ? null : this.requireThread(id);
  }

  /** Thread 读取面不带 workspace；SystemOne 事实需要会话工作目录，单独取列。 */
  threadWorkspace(threadId: string): string | null {
    const row = this.db
      .prepare("SELECT workspace FROM threads WHERE id = ?")
      .get(threadId) as { workspace: string | null } | undefined;
    return row?.workspace ?? null;
  }

  listThreads(): Thread[] {
    const rows = this.db.prepare("SELECT id FROM threads ORDER BY first_seen_at").all() as Array<{
      id: string;
    }>;
    return rows.map((row) => this.requireThread(row.id));
  }

  /** Inbox：无 primary 绑定、未忽略、窗口内有活动的线程（30 天是显示窗口不是删除策略）。 */
  listInbox(options: { now?: number; windowDays?: number } = {}): Thread[] {
    const now = options.now ?? this.now();
    const windowDays = options.windowDays ?? 30;
    const rows = this.db
      .prepare(
        `SELECT t.id FROM threads t
         WHERE t.ignored = 0
           AND NOT EXISTS (SELECT 1 FROM task_threads tt WHERE tt.thread_id = t.id AND tt.role = 'primary')
           AND t.last_activity_at IS NOT NULL AND t.last_activity_at >= ?
         ORDER BY t.last_activity_at DESC`,
      )
      .all(now - windowDays * 86_400_000) as Array<{ id: string }>;
    return rows.map((row) => this.requireThread(row.id));
  }

  setThreadIgnored(id: string, ignored: boolean): Thread {
    this.requireThread(id);
    return this.core.write((touch) => {
      this.db
        .prepare("UPDATE threads SET ignored = ?, ignored_at = ?, updated_at = ? WHERE id = ?")
        .run(ignored ? 1 : 0, ignored ? this.now() : null, this.now(), id);
      touch("threads", id);
      return this.requireThread(id);
    });
  }

  listObservedSessions(harnessId: string): ObservedSessionRecord[] {
    const rows = queryAll<ThreadRow>(
      this.db,
      `SELECT * FROM threads
       WHERE harness_id = ? AND source_path IS NOT NULL
       ORDER BY COALESCE(last_activity_at, 0) DESC, first_seen_at, rowid`,
      harnessId,
    );
    return rows.map((row) => ({
      id: row.id,
      harnessId: row.harness_id,
      nativeSessionId: row.native_session_id,
      nativeStatus: row.native_status,
      title: row.title,
      workspace: row.workspace,
      nativeGroup: row.native_group,
      lastActivityAt: row.last_activity_at,
      sourcePath: row.source_path,
      sourceByteStart: row.source_byte_start,
      sourceRecordHash: row.source_record_hash,
    }));
  }

  // ---- thread 绑定（taskboard 自有数据；primary 唯一由部分唯一索引兜底） ----

  /**
   * 绑定 thread 到 task。primary 是自动化控制权：一个 thread 至多一个 primary Task，
   * 已被其他任务占用的 primary 席位拒绝（409）；derived_from/evidence_for 只作证据链，不限数量。
   * 同一 (task, thread, role) 重复绑定幂等返回既有绑定。
   */
  bindThread(
    taskId: string,
    threadId: string,
    options: { role?: ThreadBindingRole } = {},
  ): ThreadBinding {
    const role = options.role ?? "primary";
    if (!(THREAD_BINDING_ROLES as readonly string[]).includes(role)) {
      throw new ValidationError(`role must be one of: ${THREAD_BINDING_ROLES.join(", ")}`);
    }
    this.tasks.requireTask(taskId);
    this.requireThread(threadId);
    return this.core.write((touch) => {
      const existing = this.db
        .prepare("SELECT bound_at FROM task_threads WHERE task_id = ? AND thread_id = ? AND role = ?")
        .get(taskId, threadId, role) as { bound_at: number } | undefined;
      if (existing !== undefined) {
        return { taskId, threadId, role, boundAt: new Date(existing.bound_at).toISOString() };
      }
      if (role === "primary") {
        const holder = this.db
          .prepare("SELECT task_id FROM task_threads WHERE thread_id = ? AND role = 'primary'")
          .get(threadId) as { task_id: string } | undefined;
        if (holder !== undefined) {
          throw new ConflictError(
            `thread ${threadId} is already bound to task ${holder.task_id} as primary; unbind it first`,
          );
        }
      }
      const now = this.now();
      this.db
        .prepare("INSERT INTO task_threads (task_id, thread_id, role, bound_at) VALUES (?, ?, ?, ?)")
        .run(taskId, threadId, role, now);
      touch("threads", threadId);
      return { taskId, threadId, role, boundAt: new Date(now).toISOString() };
    });
  }

  /** 解绑指定角色；绑定不存在（含 task 不存在）按 NotFound 报。返回解绑后的 thread。 */
  unbindThread(
    taskId: string,
    threadId: string,
    options: { role?: ThreadBindingRole } = {},
  ): Thread {
    const role = options.role ?? "primary";
    if (!(THREAD_BINDING_ROLES as readonly string[]).includes(role)) {
      throw new ValidationError(`role must be one of: ${THREAD_BINDING_ROLES.join(", ")}`);
    }
    this.requireThread(threadId);
    return this.core.write((touch) => {
      const result = this.db
        .prepare("DELETE FROM task_threads WHERE task_id = ? AND thread_id = ? AND role = ?")
        .run(taskId, threadId, role);
      if (Number(result.changes) === 0) {
        throw new NotFoundError(`thread ${threadId} is not bound to task ${taskId} with role ${role}`);
      }
      touch("threads", threadId);
      return this.requireThread(threadId);
    });
  }

  threadBindings(threadId: string): ThreadBinding[] {
    const rows = this.db
      .prepare(
        "SELECT task_id, thread_id, role, bound_at FROM task_threads WHERE thread_id = ? ORDER BY bound_at, rowid",
      )
      .all(threadId) as Array<{ task_id: string; thread_id: string; role: ThreadBindingRole; bound_at: number }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      threadId: row.thread_id,
      role: row.role,
      boundAt: new Date(row.bound_at).toISOString(),
    }));
  }

  threadLineage(threadId: string): { parents: ThreadLineageEdge[]; children: ThreadLineageEdge[] } {
    const map = (row: { thread_id: string; parent_thread_id: string; relation: string; created_at: number }): ThreadLineageEdge => ({
      threadId: row.thread_id,
      parentThreadId: row.parent_thread_id,
      relation: row.relation,
      createdAt: new Date(row.created_at).toISOString(),
    });
    const parents = this.db
      .prepare(
        "SELECT thread_id, parent_thread_id, relation, created_at FROM thread_lineage WHERE thread_id = ? ORDER BY created_at, rowid",
      )
      .all(threadId) as Array<{ thread_id: string; parent_thread_id: string; relation: string; created_at: number }>;
    const children = this.db
      .prepare(
        "SELECT thread_id, parent_thread_id, relation, created_at FROM thread_lineage WHERE parent_thread_id = ? ORDER BY created_at, rowid",
      )
      .all(threadId) as Array<{ thread_id: string; parent_thread_id: string; relation: string; created_at: number }>;
    return { parents: parents.map(map), children: children.map(map) };
  }

  /** 跨 Harness 身份与 source locator（详情页按 native id 回源，不把内部 id 当原生身份）。 */
  threadIdentity(threadId: string): { harnessId: string; nativeSessionId: string | null; sourcePath: string | null; sourceByteStart: number | null; sourceRecordHash: string | null } {
    const row = queryGet<ThreadRow>(this.db, "SELECT * FROM threads WHERE id = ?", threadId);
    if (row === undefined) throw new NotFoundError(`thread not found: ${threadId}`);
    return {
      harnessId: row.harness_id,
      nativeSessionId: row.native_session_id,
      sourcePath: row.source_path,
      sourceByteStart: row.source_byte_start,
      sourceRecordHash: row.source_record_hash,
    };
  }

  latestThreadTurn(threadId: string): ReaderTurn | null {
    const row = this.db
      .prepare("SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1")
      .get(threadId) as ReaderTurnRow | undefined;
    return row === undefined ? null : readerTurnFromRow(row);
  }

  /** 最近一个「已完成」turn：sample 的 expected_turn_id 校验来源（reader 视角，非 app-server 视角）。 */
  latestCompletedTurn(threadId: string): ReaderTurn | null {
    const row = this.db
      .prepare(
        "SELECT * FROM thread_turns WHERE thread_id = ? AND native_status = 'completed' ORDER BY ordinal DESC LIMIT 1",
      )
      .get(threadId) as ReaderTurnRow | undefined;
    return row === undefined ? null : readerTurnFromRow(row);
  }

  primaryThreadOf(taskId: string): Thread | null {
    // 代表线程 = 绑定最早的 primary（与 threadBindings 的展示序一致）；无 ORDER BY 时
    // 规划器走 PK 索引按 thread_id 字典序返回，任务挂多 primary 绑定时代表会漂移
    const row = this.db
      .prepare(
        "SELECT thread_id FROM task_threads WHERE task_id = ? AND role = 'primary' ORDER BY bound_at, rowid LIMIT 1",
      )
      .get(taskId) as { thread_id: string } | undefined;
    return row === undefined ? null : this.requireThread(row.thread_id);
  }

  threadsOf(taskId: string): Thread[] {
    const rows = this.db
      .prepare("SELECT thread_id FROM task_threads WHERE task_id = ?")
      .all(taskId) as Array<{ thread_id: string }>;
    return rows.map((row) => this.requireThread(row.thread_id));
  }

  /** 任务维度的绑定角色（thread → 该任务下的 role）：任务详情契约 threads[].role 的数据面。 */
  bindingsOfTask(taskId: string): Array<{ threadId: string; role: ThreadBindingRole }> {
    const rows = this.db
      .prepare("SELECT thread_id, role FROM task_threads WHERE task_id = ? ORDER BY bound_at, rowid")
      .all(taskId) as Array<{ thread_id: string; role: ThreadBindingRole }>;
    return rows.map((row) => ({ threadId: row.thread_id, role: row.role }));
  }

  // ---- reader 扫描游标（恢复骨架：daemon state 暴露进度） ----

  readerCursorSummary(): { sources: number; anomalies: number } {
    const sources = (this.db.prepare("SELECT count(*) AS n FROM reader_sources").get() as { n: number }).n;
    const anomalies = (this.db
      .prepare("SELECT count(*) AS n FROM reader_anomalies WHERE resolved = 0")
      .get() as { n: number }).n;
    return { sources, anomalies };
  }

  // ---- reader 写面：rollout source/turn/证据/摘要/anomaly 的唯一入库通道 ----

  readerSourceByInode(inode: number): ReaderSourceView | null {
    const row = this.db
      .prepare("SELECT * FROM reader_sources WHERE inode = ?")
      .get(inode) as ReaderSourceRow | undefined;
    return row === undefined ? null : readerSourceFromRow(row);
  }

  listReaderSources(): ReaderSourceView[] {
    const rows = queryAll<ReaderSourceRow>(this.db, "SELECT * FROM reader_sources ORDER BY path");
    return rows.map(readerSourceFromRow);
  }

  /** 单线程最新 source；facts 只关心一个线程，避免为每个会话重建全量 map。 */
  latestReaderSource(threadId: string): ReaderSourceView | null {
    const row = this.db
      .prepare(
        "SELECT * FROM reader_sources WHERE thread_id = ? ORDER BY updated_at DESC, source_id DESC LIMIT 1",
      )
      .get(threadId) as ReaderSourceRow | undefined;
    return row === undefined ? null : readerSourceFromRow(row);
  }

  /** 每线程最新 source，一次窗口查询（与旧手写 latest-wins 分组语义等价：updated_at 大者胜，同值取 source_id 大者）。 */
  latestReaderSourceByThread(): Map<string, ReaderSourceView> {
    const rows = queryAll<ReaderSourceRow>(
      this.db,
           `SELECT source_id, path, thread_id, inode, size, mtime, consumed_bytes,
              prefix_hash, tail_hash, next_ordinal, parser_version, rewritten, updated_at FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY updated_at DESC, source_id DESC) AS rn
           FROM reader_sources WHERE thread_id <> ''
         ) WHERE rn = 1`,
    );
    return new Map(rows.map((row) => [row.thread_id, readerSourceFromRow(row)] as const));
  }

  /** 文件移动只改 path 属性（source_id 不变，幂等键不失效）；不推域 revision，游标不是看板状态。 */
  patchReaderSourcePath(sourceId: string, path: string): void {
    this.core.write(() => {
      const source = this.db
        .prepare("SELECT thread_id, path FROM reader_sources WHERE source_id = ?")
        .get(sourceId) as { thread_id: string; path: string } | undefined;
      this.db
        .prepare("UPDATE reader_sources SET path = ?, updated_at = ? WHERE source_id = ?")
        .run(path, this.now(), sourceId);
      if (source !== undefined) {
        this.db
          .prepare(
            "UPDATE threads SET source_path = ?, updated_at = ? " +
              "WHERE native_session_id = ? AND source_path = ?",
          )
          .run(path, this.now(), source.thread_id, source.path);
      }
    });
  }

  /**
   * 一次 source unit 扫描结果的原子提交：游标 + thread + turns + 证据 + anomaly + 摘要 + lineage。
   * 重写路径在事务内先 supersede 旧证据（不删行）、删除被重写 source 的旧行 turn 再重建——
   * 单事务保证崩溃后重跑收敛到相同结果（需求「增量与恢复」）。
   */
  commitSourceScan(patch: SourceScanPatch): void {
    this.core.write((touch) => {
      const now = this.now();
      const s = patch.source;
      this.db
        .prepare(
          `INSERT INTO reader_sources (source_id, path, thread_id, inode, size, mtime, consumed_bytes,
             prefix_hash, tail_hash, next_ordinal, parser_version, rewritten, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_id) DO UPDATE SET
             path = excluded.path, thread_id = excluded.thread_id, inode = excluded.inode,
             size = excluded.size, mtime = excluded.mtime, consumed_bytes = excluded.consumed_bytes,
             prefix_hash = excluded.prefix_hash, tail_hash = excluded.tail_hash,
             next_ordinal = excluded.next_ordinal, parser_version = excluded.parser_version,
             rewritten = excluded.rewritten, updated_at = excluded.updated_at`,
        )
        .run(
          s.sourceId,
          s.path,
          s.threadId,
          s.inode,
          s.size,
          s.mtime,
          s.consumedBytes,
          s.prefixHash,
          s.tailHash,
          s.nextOrdinal,
          s.parserVersion,
          s.rewritten ? 1 : 0,
          now,
        );
      for (const t of patch.threads) {
        const harnessId = t.harnessId;
        const nativeSessionId = t.nativeSessionId ?? t.id;
        // 跨 harness 同 id 视为上游身份 bug：主键稳定优先，首插身份保留（ADR-0018 身份对的保守选择）
        // 更新面刻意不碰 harness_id/native_session_id，传入身份只在首插时生效
        // title 只落首个可见 user 消息；last_activity 取事件 timestamp 的 MAX（跨 source 安全）
        // 更新侧复用 excluded 列引用，免去“同值传两遍”的位置参数错位；
        // 唯独 native_status 插入缺省 "unknown" 而更新需 null-preserving，excluded 无法区分两者，故保留单个位置参数
        this.db
          .prepare(
            `INSERT INTO threads (
               id, harness_id, native_session_id, native_status, title, workspace, native_group,
               source_path, source_byte_start, source_record_hash, last_activity_at, first_seen_at, updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               native_status = COALESCE(?, native_status),
               title = COALESCE(title, excluded.title),
               workspace = COALESCE(excluded.workspace, workspace),
               native_group = COALESCE(excluded.native_group, native_group),
               source_path = COALESCE(excluded.source_path, source_path),
               source_byte_start = COALESCE(excluded.source_byte_start, source_byte_start),
               source_record_hash = COALESCE(excluded.source_record_hash, source_record_hash),
               last_activity_at = MAX(COALESCE(excluded.last_activity_at, 0), COALESCE(last_activity_at, 0)),
               updated_at = excluded.updated_at`,
          )
          .run(
            t.id,
            harnessId,
            nativeSessionId,
            t.nativeStatus ?? "unknown",
            t.title,
            t.workspace ?? null,
            t.nativeGroup ?? null,
            t.sourcePath ?? null,
            t.sourceByteStart ?? null,
            t.sourceRecordHash ?? null,
            t.lastActivityAt,
            now,
            now,
            t.nativeStatus ?? null,
          );
        touch("threads", t.id);
      }
      const threadId = patch.threads.length > 0 ? patch.threads[0]!.id : (s.threadId !== "" ? s.threadId : null);
      if (patch.rebuildTurns && threadId !== null) {
        this.db.prepare("DELETE FROM thread_turns WHERE source_ref = ?").run(s.sourceId);
      }
      for (const turn of patch.turns) {
        // 同一 turn id 可能被另一 thread 的 rollout 重放（resume 链）：归属跟随最近一次 task_started
        // 所在的 thread 整行迁移；started_at 仅在新值为空时保留（跨轮补终态不丢最初开始时间）
        // source_ref + byte_start + record_hash + kind 必须同源。start 记录比 terminal fallback
        // 更有信息量；同一 source 内补到 start 时，定位三元组也要一起升级。
        try {
          this.db
            .prepare(
              `INSERT INTO thread_turns (id, thread_id, ordinal, native_status, started_at, ended_at, source_ref,
                 source_byte_start, source_record_hash, source_locator_kind)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 thread_id = excluded.thread_id, ordinal = excluded.ordinal,
                 native_status = excluded.native_status, started_at = COALESCE(excluded.started_at, started_at),
                 ended_at = excluded.ended_at, source_ref = excluded.source_ref,
                 source_byte_start = CASE WHEN excluded.source_ref IS NOT thread_turns.source_ref
                   THEN excluded.source_byte_start
                   WHEN excluded.source_locator_kind = 'start' AND thread_turns.source_locator_kind IS NOT 'start'
                   THEN excluded.source_byte_start
                   ELSE COALESCE(thread_turns.source_byte_start, excluded.source_byte_start) END,
                 source_record_hash = CASE WHEN excluded.source_ref IS NOT thread_turns.source_ref
                   THEN excluded.source_record_hash
                   WHEN excluded.source_locator_kind = 'start' AND thread_turns.source_locator_kind IS NOT 'start'
                   THEN excluded.source_record_hash
                   ELSE COALESCE(thread_turns.source_record_hash, excluded.source_record_hash) END,
                 source_locator_kind = CASE
                   WHEN excluded.source_ref IS NOT thread_turns.source_ref THEN excluded.source_locator_kind
                   WHEN excluded.source_locator_kind = 'start' THEN 'start'
                   WHEN thread_turns.source_locator_kind IS NULL
                     AND thread_turns.source_byte_start IS NULL
                     AND thread_turns.source_record_hash IS NULL
                   THEN excluded.source_locator_kind
                   ELSE thread_turns.source_locator_kind END`,
            )
            .run(
              turn.id,
              turn.threadId,
              turn.ordinal,
              turn.nativeStatus,
              turn.startedAt,
              turn.endedAt,
              turn.sourceRef,
              turn.sourceByteStart ?? null,
              turn.sourceRecordHash ?? null,
              turn.sourceLocatorKind ?? null,
            );
        } catch (error) {
          // ON CONFLICT(id) 只吸收 id 相撞；(thread_id, ordinal) 槽被另一 turn id 占住时唯一约束
          // 仍会炸（scanner 逐 session 序种子已消除已知触发形，这里是残形防御）。单行降级成
          // anomaly：整事务回滚会让该 source 每轮重扫同一文件、游标永不前进（静默毒丸）
          const errcode = (error as { errcode?: number } | null)?.errcode;
          if (errcode !== 2067 && errcode !== 1555) throw error;
          this.db
            .prepare(
              "INSERT INTO reader_anomalies (id, source_id, kind, detail, byte_offset, resolved, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
            )
            .run(
              newId("an"),
              s.sourceId,
              "turn_slot_conflict",
              `turn ${turn.id} skipped: slot ${turn.threadId}#${turn.ordinal} is held by another turn id`,
              0,
              now,
            );
        }
      }
      if (patch.supersedeEvidence && threadId !== null) {
        this.db
          .prepare("UPDATE thread_evidence SET superseded = 1 WHERE source_id = ?")
          .run(s.sourceId);
      }
      for (const item of patch.evidence) {
        this.db
          .prepare(
            `INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal,
               kind, summary, props, superseded, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
             ON CONFLICT(source_id, byte_start, record_hash) DO UPDATE SET
               thread_id = excluded.thread_id,
               turn_ordinal = excluded.turn_ordinal, kind = excluded.kind, summary = excluded.summary,
               props = excluded.props, superseded = 0`,
          )
          .run(
            newId("ev"),
            item.threadId,
            item.sourceId,
            item.byteStart,
            item.recordHash,
            item.turnOrdinal,
            item.kind,
            item.summary,
            item.props === null ? null : JSON.stringify(item.props),
            now,
          );
      }
      if (patch.resolveAnomalies) {
        this.db
          .prepare("UPDATE reader_anomalies SET resolved = 1 WHERE source_id = ?")
          .run(s.sourceId);
      }
      for (const anomaly of patch.anomalies) {
        this.db
          .prepare(
            "INSERT INTO reader_anomalies (id, source_id, kind, detail, byte_offset, resolved, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
          )
          .run(newId("an"), anomaly.sourceId, anomaly.kind, anomaly.detail, anomaly.byteOffset, now);
      }
      if (s.rewritten) {
        const supersededThreads = queryAll<{ thread_id: string }>(
          this.db,
          `SELECT DISTINCT thread_id FROM thread_summaries
           WHERE provenance = 'compacted' AND source_id = ? AND superseded = 0`,
          s.sourceId,
        );
        this.db
          .prepare(
            "UPDATE thread_summaries SET superseded = 1 WHERE provenance = 'compacted' AND source_id = ?",
          )
          .run(s.sourceId);
        for (const thread of supersededThreads) touch("threads", thread.thread_id);
      }
      for (const summary of patch.summaries) {
        const recordHash = summary.recordHash ?? summary.sourceRef;
        // 记录 hash 是 compaction 的稳定身份；rewrite 移动同一行时更新 locator，新增 compaction 则新增一行。
        const existing = this.db
          .prepare(
            `SELECT id FROM thread_summaries
             WHERE thread_id = ? AND provenance = 'compacted' AND source_id = ? AND record_hash = ?
             LIMIT 1`,
          )
          .get(summary.threadId, s.sourceId, recordHash) as { id: string } | undefined;
        if (existing === undefined) {
          this.db
            .prepare(
              `INSERT INTO thread_summaries (id, thread_id, provenance, text, source_ref, source_id, byte_start,
                 record_hash, covered_through_turn_ordinal, created_at)
               VALUES (?, ?, 'compacted', ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              newId("sm"),
              summary.threadId,
              summary.text,
              summary.sourceRef,
              s.sourceId,
              summary.byteStart ?? null,
              recordHash,
              summary.coveredThroughTurnOrdinal ?? null,
              now,
            );
          touch("threads", summary.threadId);
        } else {
          this.db
            .prepare(
              `UPDATE thread_summaries
               SET text = ?, source_ref = ?, source_id = ?, byte_start = ?, record_hash = ?,
                   covered_through_turn_ordinal = ?, superseded = 0
               WHERE id = ?`,
            )
            .run(
              summary.text,
              summary.sourceRef,
              s.sourceId,
              summary.byteStart ?? null,
              recordHash,
              summary.coveredThroughTurnOrdinal ?? null,
              existing.id,
            );
          touch("threads", summary.threadId);
        }
      }
      for (const edge of patch.lineage) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO thread_lineage (thread_id, parent_thread_id, relation, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(edge.threadId, edge.parentThreadId, edge.relation, now);
        touch("threads", edge.threadId);
        touch("threads", edge.parentThreadId);
      }
    });
  }

  listThreadTurns(threadId: string): ReaderTurn[] {
    const rows = queryAll<ReaderTurnRow>(
      this.db,
      "SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY ordinal",
      threadId,
    );
    return rows.map(readerTurnFromRow);
  }

  listTurnsPage(
    threadId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: ReaderTurn[]; total: number } {
    const limit = Math.max(1, options.limit ?? 50);
    const offset = Math.max(0, options.offset ?? 0);
    const total = queryGet<{ n: number }>(
      this.db,
      "SELECT count(*) AS n FROM thread_turns WHERE thread_id = ?",
      threadId,
    )!.n;
    const rows = queryAll<ReaderTurnRow>(
      this.db,
      "SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY ordinal LIMIT ? OFFSET ?",
      threadId,
      limit,
      offset,
    );
    return { items: rows.map(readerTurnFromRow), total };
  }

  listEvidencePage(
    threadId: string,
    options: { limit?: number; offset?: number; includeSuperseded?: boolean } = {},
  ): { items: EvidenceView[]; total: number } {
    const limit = Math.max(1, options.limit ?? 50);
    const offset = Math.max(0, options.offset ?? 0);
    const where = options.includeSuperseded === true ? "" : " AND superseded = 0";
    const total = queryGet<{ n: number }>(
      this.db,
      `SELECT count(*) AS n FROM thread_evidence WHERE thread_id = ?${where}`,
      threadId,
    )!.n;
    const rows = queryAll<EvidenceRow>(
      this.db,
      `SELECT e.*, s.path AS source_path FROM thread_evidence e
       LEFT JOIN reader_sources s ON s.source_id = e.source_id
       WHERE e.thread_id = ?${where} ORDER BY e.created_at, e.rowid LIMIT ? OFFSET ?`,
      threadId,
      limit,
      offset,
    );
    return { items: rows.map(evidenceFromRow), total };
  }

  latestThreadSummary(threadId: string): ThreadSummaryView | null {
    const row = this.db
      .prepare(
        `SELECT * FROM thread_summaries
         WHERE thread_id = ? AND superseded = 0
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId) as SummaryRow | undefined;
    return row === undefined ? null : summaryFromRow(row);
  }

  /** 每线程最新一条摘要，一次窗口查询（等价于对每线程 latestThreadSummary；无摘要线程不产生条目）。 */
  latestThreadSummaries(): Map<string, ThreadSummaryView> {
    const rows = queryAll<SummaryRow>(
      this.db,
      `SELECT id, thread_id, provenance, text, source_ref, source_id, byte_start, record_hash,
              covered_through_turn_ordinal, superseded, created_at FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC, rowid DESC) AS rn
           FROM thread_summaries
           WHERE superseded = 0
         ) WHERE rn = 1`,
    );
    return new Map(rows.map((row) => [row.thread_id, summaryFromRow(row)]));
  }

  listThreadSummaries(threadId: string): ThreadSummaryView[] {
    const rows = queryAll<SummaryRow>(
      this.db,
      "SELECT * FROM thread_summaries WHERE thread_id = ? ORDER BY created_at, rowid",
      threadId,
    );
    return rows.map(summaryFromRow);
  }

  /** sample 摘要入库通道（compacted 走 reader 的 commitSourceScan）。文本必须先过脱敏+截断。 */
  addThreadSummary(input: {
    threadId: string;
    provenance: ThreadSummaryView["provenance"];
    text: string;
    sourceRef?: string | null;
    byteStart?: number | null;
    recordHash?: string | null;
    coveredThroughTurnOrdinal?: number | null;
  }): ThreadSummaryView {
    this.requireThread(input.threadId);
    return this.core.write((touch) => {
      const id = newId("sm");
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO thread_summaries (id, thread_id, provenance, text, source_ref, byte_start, record_hash,
             covered_through_turn_ordinal, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.threadId,
          input.provenance,
          input.text,
          input.sourceRef ?? null,
          input.byteStart ?? null,
          input.recordHash ?? null,
          input.coveredThroughTurnOrdinal ?? null,
          now,
        );
      touch("threads", input.threadId);
      return {
        id,
        threadId: input.threadId,
        provenance: input.provenance,
        text: input.text,
        sourceRef: input.sourceRef ?? null,
        sourceId: null,
        byteStart: input.byteStart ?? null,
        recordHash: input.recordHash ?? null,
        coveredThroughTurnOrdinal: input.coveredThroughTurnOrdinal ?? null,
        superseded: false,
        createdAt: new Date(now).toISOString(),
      };
    });
  }

  // ---- 线程评估状态（no-op 指纹 / 断路器；词汇表「评估状态」） ----

  getEvaluationState(threadId: string): ThreadEvaluationStateView | null {
    const row = this.db
      .prepare("SELECT * FROM thread_evaluation_state WHERE thread_id = ?")
      .get(threadId) as
      | {
          thread_id: string;
          last_evaluated_at: number | null;
          evidence_fingerprint: string | null;
          last_no_op: number;
          consecutive_failures: number;
          breaker_open: number;
          updated_at: number;
        }
      | undefined;
    return row === undefined
      ? null
      : {
          threadId: row.thread_id,
          lastEvaluatedAt: row.last_evaluated_at === null ? null : new Date(row.last_evaluated_at).toISOString(),
          evidenceFingerprint: row.evidence_fingerprint,
          lastNoOp: row.last_no_op === 1,
          consecutiveFailures: row.consecutive_failures,
          breakerOpen: row.breaker_open === 1,
          updatedAt: new Date(row.updated_at).toISOString(),
        };
  }

  /**
   * 证据指纹：turn 计数按 native_status 分计 + 最近一个终态动作 id。只用库内事实行，
   * 不用时间戳（词汇表「no-op 指纹」：时间流逝本身不是证据；turn 状态翻转也要改变指纹）。
   */
  threadEvidenceFingerprint(threadId: string): string {
    const turns = this.db
      .prepare("SELECT native_status, count(*) AS n FROM thread_turns WHERE thread_id = ? GROUP BY native_status")
      .all(threadId) as Array<{ native_status: string; n: number }>;
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of turns) {
      byStatus[row.native_status] = row.n;
      total += row.n;
    }
    const lastTerminalAction = this.db
      .prepare(
        `SELECT id FROM action_executions
         WHERE thread_id = ? AND status IN ('completed','failed')
         ORDER BY COALESCE(ended_at, created_at) DESC, rowid DESC LIMIT 1`,
      )
      .get(threadId) as { id: string } | undefined;
    const counts = ["running", "completed", "failed", "interrupted"]
      .map((status) => `${status[0]}${byStatus[status] ?? 0}`)
      .join("");
    return `t${total}:${counts}:a${lastTerminalAction?.id ?? "-"}`;
  }

  /**
   * 评估落定（sample 成功、如实回落基线或 Jev 决策落提案）：消费当前证据、连败计数清零。
   * noOp 是本轮结论（S1 数据面恒为 no_op；S2 Jev 的结论跟 recommended 走）——A12 的去重只对
   * no_op 结论生效，非 no_op 结论允许下次评估重新触发。
   */
  recordEvaluationSettled(threadId: string, fingerprint: string, options: { noOp?: boolean } = {}): ThreadEvaluationStateView {
    const noOp = options.noOp ?? true;
    this.requireThread(threadId);
    return this.core.write(() => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO thread_evaluation_state
             (thread_id, last_evaluated_at, evidence_fingerprint, last_no_op, consecutive_failures, breaker_open, updated_at)
           VALUES (?, ?, ?, ?, 0, 0, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             last_evaluated_at = excluded.last_evaluated_at,
             evidence_fingerprint = excluded.evidence_fingerprint,
             last_no_op = excluded.last_no_op,
             consecutive_failures = 0,
             updated_at = excluded.updated_at`,
        )
        .run(threadId, now, fingerprint, noOp ? 1 : 0, now);
      return this.getEvaluationState(threadId)!;
    });
  }

  /**
   * 评估失败（超时/断连/协议非法输出等驱动级失败）：只计连败并按阈值开断路器（同事务落审计），
   * 不动已消费的指纹与 no_op 结论——失败不当 no_op，新证据出现后仍允许重试直到熔断。
   */
  recordEvaluationFailure(threadId: string, reason: string): ThreadEvaluationStateView {
    this.requireThread(threadId);
    return this.core.write((touch) => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO thread_evaluation_state
             (thread_id, last_evaluated_at, evidence_fingerprint, last_no_op, consecutive_failures, breaker_open, updated_at)
           VALUES (?, NULL, NULL, 0, 1, 0, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             consecutive_failures = thread_evaluation_state.consecutive_failures + 1,
             updated_at = excluded.updated_at`,
        )
        .run(threadId, now);
      const row = this.db
        .prepare("SELECT consecutive_failures FROM thread_evaluation_state WHERE thread_id = ?")
        .get(threadId) as { consecutive_failures: number };
      if (row.consecutive_failures >= EVALUATION_BREAKER_THRESHOLD) {
        // 只在 closed→open 跃迁落注记：并发在飞评估越过阈值后每多败一次就重发一条
        const opened = this.db
          .prepare("UPDATE thread_evaluation_state SET breaker_open = 1 WHERE thread_id = ? AND breaker_open = 0")
          .run(threadId);
        if (Number(opened.changes) > 0) {
          this.db
            .prepare(
              "INSERT INTO annotations (id, task_id, thread_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .run(
              newId("an"),
              null,
              threadId,
              EVALUATION_BREAKER_OPENED_ANNOTATION,
              `evaluation breaker opened after ${row.consecutive_failures} consecutive failures; ` +
                `auto evaluation paused for this thread until manual resume; last failure: ${reason}`,
              now,
            );
          // 自动评估是静默路径（无 HTTP 活动可搭车）：注记变更必须推动线程域 revision
          touch("threads", threadId);
        }
      }
      return this.getEvaluationState(threadId)!;
    });
  }

  /** 人工 resume：清断路器与连败计数；保留证据指纹（恢复不凭空制造新证据）；打开过才落恢复审计。 */
  resetEvaluationBreaker(threadId: string, options: { requestId?: string } = {}): ThreadEvaluationStateView {
    this.requireThread(threadId);
    return this.core.write((touch) => {
      const wasOpen = this.db
        .prepare("SELECT breaker_open FROM thread_evaluation_state WHERE thread_id = ?")
        .get(threadId) as { breaker_open: number } | undefined;
      this.db
        .prepare(
          `INSERT INTO thread_evaluation_state
             (thread_id, last_evaluated_at, evidence_fingerprint, last_no_op, consecutive_failures, breaker_open, updated_at)
           VALUES (?, NULL, NULL, 0, 0, 0, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             consecutive_failures = 0,
             breaker_open = 0,
             updated_at = excluded.updated_at`,
        )
        .run(threadId, this.now());
      if (wasOpen !== undefined && wasOpen.breaker_open === 1) {
        this.db
          .prepare(
            "INSERT INTO annotations (id, task_id, thread_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            newId("an"),
            null,
            threadId,
            EVALUATION_BREAKER_RESUMED_ANNOTATION,
            "evaluation breaker manually resumed; auto evaluation re-enabled for this thread" +
              (options.requestId !== undefined ? ` (request ${options.requestId})` : ""),
            this.now(),
          );
        // 自动评估路径无 HTTP 活动可搭车：恢复审计也要推动线程域 revision
        touch("threads", threadId);
      }
      return this.getEvaluationState(threadId)!;
    });
  }
}
