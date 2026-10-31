/**
 * AutomationStore：自治族域方法（ADR-0016 #19 步④自 src/store.ts 挪出）——next_action_proposals/
 * shadow 回放两节，以及按分节归属落在本两节内的留守方法（unresolvedAnomalyCountForThread、
 * expireUnboundEvidence/expireBoundEvidence）。写方法一律经 StoreCore 的事务缝
 * （core.write：一个事务 + Touch 跨域收集 + revision 广播），跨域 touch 语义不变；
 * 公共方法签名与原 Store 逐字一致，Store 门面（src/store/index.ts）按原签名转发。
 * 协作面（只挪代码，不改关系）：collectShadowComparisons 读线程族的原生侧事实
 * （latestThreadTurn/getThread）；labelShadowComparison 门 6 经 settings.updateSettings 拨闸并经
 * 任务族的 addAnnotation 落审计——均在调用方事务内执行，与原 Store 内互调等价。
 */

import type { DatabaseSync } from "node:sqlite";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { SHADOW_LABELS, type ShadowLabel } from "../types.js";
import { newId, StoreCore } from "./core.js";
import { iso, queryAll, queryGet, queryReread, safeParseJsonObject } from "./rows.js";
import type { SettingsStore } from "./settings-store.js";
import type { TaskStore } from "./task-store.js";
import type { ThreadStore } from "./thread-store.js";

/** next_action_proposals 行视图：payload 是 Jev 结构化答案 + 门判定 + 执行结果的 JSON。 */
export interface ProposalView {
  id: string;
  threadId: string | null;
  taskId: string | null;
  status: "pending" | "accepted" | "rejected" | "expired";
  evidenceFingerprint: string;
  payload: Record<string, unknown>;
  decidedAt: string | null;
  createdAt: string;
}

/** shadow 三方对比快照（自治上线门）：no_op 基线恒定不占列，原生侧与 Jev 侧落列，人工标注三值。 */
export interface ShadowComparisonView {
  id: string;
  threadId: string;
  proposalId: string;
  /** 提案的任务（无绑定为 null）；纯引用不设外键，任务删除后门证据仍在。 */
  taskId: string | null;
  evidenceFingerprint: string;
  /** 原生侧：收集时刻的最新 turn 终态（无 turn 为 null）。 */
  nativeTurnStatus: string | null;
  /** 原生侧：最近观测的原生 goal 状态（无 goal 为 null）。 */
  nativeGoalStatus: string | null;
  jevRecommended: string;
  jevRisk: string;
  /** 提案已被自动/人工执行（executed=true 的快照标 harmful 触发门 6）。 */
  executed: boolean;
  label: ShadowLabel | null;
  labeledAt: string | null;
  createdAt: string;
}

interface ProposalRow {
  id: string;
  thread_id: string | null;
  task_id: string | null;
  status: string;
  evidence_fingerprint: string;
  payload: string;
  decided_at: number | null;
  created_at: number;
}

export class AutomationStore {
  private readonly core: StoreCore;
  private readonly settings: SettingsStore;
  private readonly tasks: TaskStore;
  private readonly threads: ThreadStore;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(core: StoreCore, settings: SettingsStore, tasks: TaskStore, threads: ThreadStore) {
    this.core = core;
    this.settings = settings;
    this.tasks = tasks;
    this.threads = threads;
    this.db = core.db;
    this.now = (): number => core.now();
  }

  // ---- next_action_proposals（Jev 提案；输出永远只进 proposal，不直接进状态机，ADR-0010） ----

  private static proposalFromRow(row: ProposalRow): ProposalView {
    return {
      id: row.id,
      threadId: row.thread_id,
      taskId: row.task_id,
      status: row.status as ProposalView["status"],
      evidenceFingerprint: row.evidence_fingerprint,
      payload: safeParseJsonObject(row.payload) ?? {},
      decidedAt: iso(row.decided_at),
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  addProposal(input: {
    threadId?: string | null;
    taskId?: string | null;
    evidenceFingerprint: string;
    payload: Record<string, unknown>;
  }): ProposalView {
    if (input.threadId != null) this.threads.requireThread(input.threadId);
    if (input.taskId != null) this.tasks.requireTask(input.taskId);
    return this.core.write((touch) => {
      const id = newId("pr");
      const now = this.now();
      this.db
        .prepare(
          "INSERT INTO next_action_proposals (id, thread_id, task_id, status, evidence_fingerprint, payload, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
        )
        .run(id, input.threadId ?? null, input.taskId ?? null, input.evidenceFingerprint, JSON.stringify(input.payload), now);
      if (input.threadId != null) touch("threads", input.threadId);
      if (input.taskId != null) touch("tasks", input.taskId);
      return AutomationStore.proposalFromRow(
        queryReread<ProposalRow>(this.db, "SELECT * FROM next_action_proposals WHERE id = ?", id),
      );
    });
  }

  getProposal(id: string): ProposalView | null {
    const row = queryGet<ProposalRow>(this.db, "SELECT * FROM next_action_proposals WHERE id = ?", id);
    return row === undefined ? null : AutomationStore.proposalFromRow(row);
  }

  listProposals(options: { status?: ProposalView["status"]; threadId?: string; taskId?: string; limit?: number } = {}): ProposalView[] {
    const limit = Math.max(1, options.limit ?? 100);
    const clauses: string[] = [];
    const params: Array<string | number | null> = [];
    if (options.status !== undefined) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.threadId !== undefined) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    if (options.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    params.push(limit);
    const rows = queryAll<ProposalRow>(
      this.db,
      `SELECT * FROM next_action_proposals${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...params,
    );
    return rows.map(AutomationStore.proposalFromRow);
  }

  /** 裁决一次写入（pending → accepted/rejected）；执行结果并入 payload；非 pending 拒绝改写。 */
  decideProposal(
    id: string,
    decision: "accepted" | "rejected",
    options: { executionResult?: Record<string, unknown> } = {},
  ): ProposalView {
    return this.core.write((touch) => {
      const row = this.db.prepare("SELECT * FROM next_action_proposals WHERE id = ?").get(id) as
        | ProposalRow
        | undefined;
      if (row === undefined) throw new NotFoundError(`proposal not found: ${id}`);
      if (row.status !== "pending") {
        throw new ConflictError(`proposal ${id} is already ${row.status}`);
      }
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (options.executionResult !== undefined) payload.executionResult = options.executionResult;
      const now = this.now();
      this.db
        .prepare("UPDATE next_action_proposals SET status = ?, payload = ?, decided_at = ? WHERE id = ?")
        .run(decision, JSON.stringify(payload), now, id);
      // 裁决终态可观测：提案列表在 /api/state 的 threads/tasks 域载荷里，不 touch 则 UI 停在 pending
      if (row.thread_id !== null) touch("threads", row.thread_id);
      if (row.task_id !== null) touch("tasks", row.task_id);
      return AutomationStore.proposalFromRow(
        queryReread<ProposalRow>(this.db, "SELECT * FROM next_action_proposals WHERE id = ?", id),
      );
    });
  }

  /** 未收敛 anomaly 计数（mark_done 证据门输入）：只计本线程 source 上 resolved=0 的行。 */
  unresolvedAnomalyCountForThread(threadId: string): number {
    const row = this.db
      .prepare(
        "SELECT count(*) AS n FROM reader_anomalies ra JOIN reader_sources rs ON rs.source_id = ra.source_id WHERE rs.thread_id = ? AND ra.resolved = 0",
      )
      .get(threadId) as { n: number };
    return row.n;
  }

  // ---- shadow 回放（自治上线门 1–3/6；词汇表「shadow」）----

  /**
   * 从已落库提案派生三方对比快照（no_op 基线恒定不占列；原生侧取收集时刻的最新 turn 终态与
   * goal 状态；Jev 侧取提案推荐与风险）。UNIQUE(thread,fingerprint,recommended) 去重；失败答案
   * （payload.ok!==true）没有可对比的 Jev 选择，不进表。
   */
  collectShadowComparisons(): { collected: number; total: number } {
    return this.core.write((touch) => {
      const rows = this.db
        .prepare("SELECT id, thread_id, task_id, status, evidence_fingerprint, payload FROM next_action_proposals")
        .all() as Array<{
        id: string;
        thread_id: string | null;
        task_id: string | null;
        status: string;
        evidence_fingerprint: string;
        payload: string;
      }>;
      const insert = this.db.prepare(
        // executed 跟随执行事实而非快照冻结：先收集后执行的提案再次 collect 时以 MAX 刷新，
        // 否则门 6（有害且已执行才 halted）永远看不到后执行的快照
        "INSERT INTO shadow_comparisons " +
          "(id, thread_id, proposal_id, task_id, evidence_fingerprint, native_turn_status, native_goal_status, jev_recommended, jev_risk, executed, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(thread_id, evidence_fingerprint, jev_recommended) DO UPDATE SET executed = MAX(executed, excluded.executed)",
      );
      let collected = 0;
      const exists = this.db.prepare(
        "SELECT 1 FROM shadow_comparisons WHERE thread_id = ? AND evidence_fingerprint = ? AND jev_recommended = ?",
      );
      for (const row of rows) {
        if (row.thread_id === null) continue;
        const payload = JSON.parse(row.payload) as {
          ok?: boolean;
          answer?: { recommended?: string; candidates?: Array<{ action: string; risk: string }> };
          executionResult?: { executed?: boolean };
        };
        const recommended = payload.ok === true ? payload.answer?.recommended : undefined;
        if (recommended === undefined) continue;
        const risk =
          payload.answer?.candidates?.find((entry) => entry.action === recommended)?.risk ?? "medium";
        const nativeTurn = this.threads.latestThreadTurn(row.thread_id);
        const thread = this.threads.getThread(row.thread_id);
        // collected 只计新收集：DO UPDATE 对已存在行（刷新 executed）也报 changes，不能计入
        const known = exists.get(row.thread_id, row.evidence_fingerprint, recommended) !== undefined;
        const result = insert.run(
          newId("sc"),
          row.thread_id,
          row.id,
          row.task_id,
          row.evidence_fingerprint,
          nativeTurn?.nativeStatus ?? null,
          thread?.goalStatus ?? null,
          recommended,
          risk,
          row.status === "accepted" && payload.executionResult?.executed === true ? 1 : 0,
          this.now(),
        );
        if (known === false) collected += Number(result.changes);
      }
      if (collected > 0) touch("config");
      const total = (this.db.prepare("SELECT count(*) AS n FROM shadow_comparisons").all() as Array<{ n: number }>)[0]!.n;
      return { collected, total };
    });
  }

  listShadowComparisons(limit = 200): ShadowComparisonView[] {
    const rows = this.db
      .prepare("SELECT * FROM shadow_comparisons ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(Math.max(1, limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => AutomationStore.shadowComparisonFromRow(row));
  }

  shadowComparisonSummary(): {
    snapshots: number;
    labeled: number;
    unlabeled: number;
    helpful: number;
    ineffective: number;
    harmful: number;
    executedHarmful: number;
  } {
    const rows = this.db
      .prepare("SELECT label, executed FROM shadow_comparisons")
      .all() as Array<{ label: string | null; executed: number }>;
    const summary = { snapshots: rows.length, labeled: 0, unlabeled: 0, helpful: 0, ineffective: 0, harmful: 0, executedHarmful: 0 };
    for (const row of rows) {
      if (row.label === null) {
        summary.unlabeled += 1;
        continue;
      }
      summary.labeled += 1;
      summary[row.label as ShadowLabel] += 1;
      if (row.label === "harmful" && row.executed === 1) summary.executedHarmful += 1;
    }
    return summary;
  }

  /** 人工标注（三值）。已执行快照被标 harmful 时门立即转 halted 并落审计标注（门 6，证据保留）。 */
  labelShadowComparison(id: string, label: ShadowLabel): ShadowComparisonView {
    if (!(SHADOW_LABELS as readonly string[]).includes(label)) {
      throw new ValidationError(`label must be one of: ${SHADOW_LABELS.join(", ")}`);
    }
    return this.core.write((touch) => {
      const row = this.db.prepare("SELECT * FROM shadow_comparisons WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      if (row === undefined) throw new NotFoundError(`shadow comparison not found: ${id}`);
      // 标注是终局证据（有害标注不可撤销，门 6 依赖它）：已标注的比较拒绝改标，防止门统计被事后改写
      if (row.label !== null && row.label !== undefined) {
        throw new ConflictError(
          `shadow comparison ${id} is already labeled '${String(row.label)}'; labels are final evidence`,
        );
      }
      this.db
        .prepare("UPDATE shadow_comparisons SET label = ?, labeled_at = ? WHERE id = ?")
        .run(label, this.now(), id);
      touch("config");
      if (label === "harmful" && row.executed === 1) {
        this.settings.updateSettings({ automationLiveGate: "halted" });
        this.tasks.addAnnotation({
          ...(row.task_id !== null && row.task_id !== undefined ? { taskId: row.task_id as string } : {}),
          threadId: row.thread_id as string,
          kind: "automation_halted",
          body: `harmful label on shadow comparison ${id} (proposal ${row.proposal_id}); automation halted per the live gate`,
        });
      }
      const updated = this.db.prepare("SELECT * FROM shadow_comparisons WHERE id = ?").get(id) as Record<string, unknown>;
      return AutomationStore.shadowComparisonFromRow(updated);
    });
  }

  private static shadowComparisonFromRow(row: Record<string, unknown>): ShadowComparisonView {
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      proposalId: row.proposal_id as string,
      taskId: (row.task_id as string | null) ?? null,
      evidenceFingerprint: row.evidence_fingerprint as string,
      nativeTurnStatus: (row.native_turn_status as string | null) ?? null,
      nativeGoalStatus: (row.native_goal_status as string | null) ?? null,
      jevRecommended: row.jev_recommended as string,
      jevRisk: row.jev_risk as string,
      executed: row.executed === 1,
      label: (row.label as ShadowLabel | null) ?? null,
      labeledAt: iso(row.labeled_at as number | null),
      createdAt: iso(row.created_at as number)!,
    };
  }

  /** A32：未绑定（无 primary 绑定）thread 的派生证据按可配阈值过期清理，返回删除条数。 */
  expireUnboundEvidence(expiredBeforeMs: number): number {
    return this.core.write((touch) => {
      const result = this.db
        .prepare(
          `DELETE FROM thread_evidence
           WHERE created_at < ?
             AND thread_id NOT IN (SELECT thread_id FROM task_threads WHERE role = 'primary')`,
        )
        .run(expiredBeforeMs);
      const deleted = Number(result.changes);
      // 证据计数/分页在 thread 载荷里：只删不推 revision 的话 UI 停在已删证据上，直到无关写发生
      if (deleted > 0) touch("threads");
      return deleted;
    });
  }

  /**
   * A32：已绑定 thread 的证据保留到 primary 任务归档后 boundEvidenceDays。
   * 参数是归档时间截点（archived_at < 截点即过期）；摘要与 anomaly 不在此清理（跟随 thread）。
   */
  expireBoundEvidence(archivedBeforeMs: number): number {
    return this.core.write((touch) => {
      const result = this.db
        .prepare(
          `DELETE FROM thread_evidence
           WHERE thread_id IN (
             SELECT tt.thread_id FROM task_threads tt
             JOIN tasks t ON t.id = tt.task_id
             WHERE tt.role = 'primary' AND t.archived = 1 AND t.archived_at IS NOT NULL AND t.archived_at < ?
           )`,
        )
        .run(archivedBeforeMs);
      const deleted = Number(result.changes);
      // 与 expireUnboundEvidence 同理（#27）：证据计数/分页在 thread 载荷里，只删不推 revision 会停在已删视图
      if (deleted > 0) touch("threads");
      return deleted;
    });
  }
}
