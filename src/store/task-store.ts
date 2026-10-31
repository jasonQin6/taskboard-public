/**
 * TaskStore：任务族域方法（ADR-0016 #19 步②自 src/store.ts 挪出）——tasks/runs/cron 调度面/
 * annotations/action executions/worktrees 记录六节。写方法一律经 StoreCore 的事务缝
 * （core.write：一个事务 + Touch 跨域收集 + revision 广播），跨域 touch 语义不变；
 * 公共方法签名与原 Store 逐字一致，Store 门面（src/store/index.ts，src/store.ts 为 re-export 垫片）按原签名转发。
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { nextRunAfter, parseCron, validateTimeZone } from "../cron.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { normalizeLabels } from "../labels.js";
import type { CreateTaskInput, UpdateTaskInput } from "../task-input.js";
import { newId, StoreCore } from "./core.js";
import { iso, plain, queryAll, queryGet, queryReread, safeParseJsonObject } from "./rows.js";
import type { SettingsStore } from "./settings-store.js";
import {
  ACTIVE_RUN_STATUSES,
  TASK_STATUSES,
  type ActionExecution,
  type Annotation,
  type Run,
  type RunStatus,
  type RunTrigger,
  type Task,
  type TaskStatus,
  type WorktreeRecord,
} from "../types.js";

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  workspace: string | null;
  status: string;
  archived: number;
  archived_at: number | null;
  labels: string;
  source: string;
  acceptance_criteria: string;
  acceptance_mode: string;
  automation_mode: string;
  automation_mode_explicit: number;
  workspace_mode: string;
  parent_id: string | null;
  subtasks_policy: string | null;
  idle_threshold_ms: number | null;
  cron_expr: string | null;
  cron_tz: string | null;
  next_run_at: number | null;
  goal_enabled: number;
  goal_budget_tokens: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  task_id: string;
  status: string;
  trigger: string;
  thread_id: string | null;
  orphaned: number;
  failure_reason: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

interface ActionExecutionRow {
  id: string;
  action: string;
  status: string;
  trigger: string;
  task_id: string | null;
  thread_id: string | null;
  request_id: string | null;
  detail: string | null;
  created_at: number;
  ended_at: number | null;
}

interface WorktreeRow {
  task_id: string;
  seq: number;
  branch: string;
  path: string;
  base_branch: string | null;
  source_workspace: string;
  created_at: number;
  removed_at: number | null;
}

export class TaskStore {
  private readonly core: StoreCore;
  private readonly settings: SettingsStore;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(core: StoreCore, settings: SettingsStore) {
    this.core = core;
    this.settings = settings;
    this.db = core.db;
    this.now = (): number => core.now();
  }

  // ---- tasks ----

  private static taskFromRow(row: TaskRow): Task {
    return {
      id: row.id,
      title: row.title,
      prompt: row.prompt,
      workspace: row.workspace,
      status: row.status as TaskStatus,
      archived: row.archived === 1,
      archivedAt: iso(row.archived_at),
      labels: JSON.parse(row.labels) as string[],
      source: row.source as Task["source"],
      acceptanceCriteria: row.acceptance_criteria,
      acceptanceMode: row.acceptance_mode as Task["acceptanceMode"],
      automationMode: row.automation_mode as Task["automationMode"],
      workspaceMode: row.workspace_mode as Task["workspaceMode"],
      parentId: row.parent_id,
      subtasksPolicy: row.subtasks_policy === "cascade" ? "cascade" : null,
      idleThresholdMs: row.idle_threshold_ms,
      schedule:
        row.cron_expr === null
          ? null
          : { cron: row.cron_expr, tz: row.cron_tz, nextRunAt: iso(row.next_run_at) },
      goal: { enabled: row.goal_enabled === 1, budgetTokens: row.goal_budget_tokens },
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private fetchTaskRow(id: string): TaskRow | null {
    return (this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null;
  }

  getTask(id: string): Task | null {
    const row = this.fetchTaskRow(id);
    return row === null ? null : TaskStore.taskFromRow(plain(row));
  }

  requireTask(id: string): Task {
    const task = this.getTask(id);
    if (task === null) throw new NotFoundError(`task not found: ${id}`);
    return task;
  }

  listTasks(options: { includeArchived?: boolean } = {}): Task[] {
    const includeArchived = options.includeArchived ?? true;
    const rows = queryAll<TaskRow>(
      this.db,
      includeArchived
        ? "SELECT * FROM tasks ORDER BY created_at, rowid"
        : "SELECT * FROM tasks WHERE archived = 0 ORDER BY created_at, rowid",
    );
    return rows.map((row) => TaskStore.taskFromRow(plain(row)));
  }

  childIds(taskId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM tasks WHERE parent_id = ? ORDER BY created_at, rowid")
      .all(taskId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /** 到根任务的父子跳数；成环数据按「已在环上」收口（上限防御）。 */
  private depthOf(taskId: string, visited = new Set<string>()): number {
    let current: string | null = taskId;
    let depth = 0;
    const seen = visited;
    while (current !== null) {
      if (seen.has(current)) return depth;
      seen.add(current);
      const row = this.fetchTaskRow(current);
      if (row === null) return depth;
      current = row.parent_id;
      if (current !== null) depth += 1;
      if (depth > 64) return depth;
    }
    return depth;
  }

  /** 该任务之下最深的子树高度（自身=0）。挂新父时用它保证整棵子树不越限。 */
  private subtreeHeight(taskId: string): number {
    const childRows = this.db
      .prepare("SELECT id FROM tasks WHERE parent_id = ?")
      .all(taskId) as Array<{ id: string }>;
    let height = 0;
    for (const child of childRows) {
      height = Math.max(height, 1 + this.subtreeHeight(child.id));
    }
    return height;
  }

  private validateParentRules(taskId: string | null, parentId: string | null): void {
    if (parentId === null) return;
    const parentRow = this.fetchTaskRow(parentId);
    if (parentRow === null) throw new ValidationError(`parent task not found: ${parentId}`);
    if (parentRow.archived === 1) {
      throw new ValidationError(`parent task is archived: ${parentId}`);
    }
    if (taskId !== null) {
      // 沿新父链向上：出现自己即成环（含间接环）。成环先于深度判定，错误更本质
      let cursor: string | null = parentId;
      const guard = new Set<string>();
      while (cursor !== null) {
        if (cursor === taskId) {
          throw new ValidationError("parent would create a cycle");
        }
        if (guard.has(cursor)) break;
        guard.add(cursor);
        const row = this.fetchTaskRow(cursor);
        cursor = row?.parent_id ?? null;
      }
    }
    const settings = this.settings.getSettings();
    const subtree = taskId === null ? 0 : this.subtreeHeight(taskId);
    const newDepth = this.depthOf(parentId) + 1;
    if (newDepth + subtree > settings.maxSubtaskDepth) {
      throw new ValidationError(
        `subtask depth would reach ${newDepth + subtree}, max allowed is ${settings.maxSubtaskDepth}`,
      );
    }
  }

  private resolveCronNext(cron: string, tz: string | null, fromMs: number): number {
    try {
      const next =
        tz === null ? nextRunAfter(cron, new Date(fromMs)) : nextRunAfter(cron, new Date(fromMs), tz);
      return next.getTime();
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  private validateCronPair(cron: string | null, tz: string | null): void {
    if (tz !== null && cron === null) {
      throw new ValidationError("tz requires cron to be set");
    }
    if (cron === null) return;
    try {
      parseCron(cron);
      if (tz !== null) validateTimeZone(tz);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error));
    }
  }

  createTask(input: CreateTaskInput): Task {
    this.validateCronPair(input.cron, input.tz);
    this.validateParentRules(null, input.parentId);
    const now = this.now();
    const id = newId("t");
    const nextRunAt =
      input.cron === null ? null : this.resolveCronNext(input.cron, input.tz, now);
    return this.core.write((touch) => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, title, prompt, workspace, status, labels, source,
             acceptance_criteria, acceptance_mode, automation_mode, automation_mode_explicit, workspace_mode,
             parent_id, subtasks_policy, idle_threshold_ms, cron_expr, cron_tz, next_run_at,
             goal_enabled, goal_budget_tokens, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.title,
          input.prompt,
          input.workspace,
          input.status,
          JSON.stringify(input.labels),
          input.source,
          input.acceptanceCriteria,
          input.acceptanceMode,
          input.automationMode,
          input.automationModeExplicit ? 1 : 0,
          input.workspaceMode,
          input.parentId,
          input.subtasksPolicy,
          input.idleThresholdMs,
          input.cron,
          input.tz,
          nextRunAt,
          input.goalEnabled ? 1 : 0,
          input.goalBudgetTokens,
          now,
          now,
        );
      touch("tasks", id);
      return this.requireTask(id);
    });
  }

  updateTask(id: string, patch: UpdateTaskInput): Task {
    const before = this.requireTask(id);
    if (patch.cron !== undefined || patch.tz !== undefined) {
      const cron = patch.cron === undefined ? before.schedule?.cron ?? null : patch.cron;
      const tz =
        patch.tz === undefined
          ? patch.cron === undefined
            ? before.schedule?.tz ?? null
            : null
          : patch.tz;
      this.validateCronPair(cron, tz);
    }
    if (patch.parentId !== undefined) {
      this.validateParentRules(id, patch.parentId);
    }
    const now = this.now();
    return this.core.write((touch) => {
      const assignments: string[] = [];
      const values: SQLInputValue[] = [];
      const set = (column: string, value: SQLInputValue): void => {
        assignments.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.title !== undefined) set("title", patch.title);
      if (patch.prompt !== undefined) set("prompt", patch.prompt);
      if (patch.workspace !== undefined) set("workspace", patch.workspace);
      if (patch.labels !== undefined) set("labels", JSON.stringify(normalizeLabels(patch.labels)));
      if (patch.acceptanceCriteria !== undefined) set("acceptance_criteria", patch.acceptanceCriteria);
      if (patch.acceptanceMode !== undefined) set("acceptance_mode", patch.acceptanceMode);
      if (patch.automationMode !== undefined) {
        set("automation_mode", patch.automationMode);
        // 显式更新即用户选择：此后任何默认策略都不得再覆盖（需求「默认策略」）
        set("automation_mode_explicit", 1);
      }
      if (patch.workspaceMode !== undefined) set("workspace_mode", patch.workspaceMode);
      if (patch.parentId !== undefined) set("parent_id", patch.parentId);
      if (patch.subtasksPolicy !== undefined) set("subtasks_policy", patch.subtasksPolicy);
      if (patch.idleThresholdMs !== undefined) set("idle_threshold_ms", patch.idleThresholdMs);
      if (patch.goalEnabled !== undefined) set("goal_enabled", patch.goalEnabled ? 1 : 0);
      if (patch.goalBudgetTokens !== undefined) set("goal_budget_tokens", patch.goalBudgetTokens);
      if (patch.cron !== undefined || patch.tz !== undefined) {
        const cron = patch.cron === undefined ? before.schedule?.cron ?? null : patch.cron;
        const tz =
          patch.tz === undefined
            ? patch.cron === undefined
              ? before.schedule?.tz ?? null
              : null
            : patch.tz;
        // 更换 cron 或时区作废 nextRunAt 并从现在重算（需求「cron」）
        set("cron_expr", cron);
        set("cron_tz", cron === null ? null : tz);
        set("next_run_at", cron === null ? null : this.resolveCronNext(cron, tz, now));
      }
      set("updated_at", now);
      this.db
        .prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values, id);
      touch("tasks", id);
      return this.requireTask(id);
    });
  }

  /**
   * taskboard 为任务创建并绑定主线程后的默认策略（需求「默认策略」/故事 49）：
   * 仍处于创建默认（suggest 且用户从未显式设置）的任务升级为 auto；显式设置过的任何模式都不动。
   */
  applyTaskboardThreadDefault(taskId: string): Task {
    return this.core.write((touch) => {
      const row = this.fetchTaskRow(taskId);
      if (row === null) throw new NotFoundError(`task not found: ${taskId}`);
      if (row.automation_mode_explicit === 0 && row.automation_mode === "suggest") {
        this.db
          .prepare("UPDATE tasks SET automation_mode = 'auto', updated_at = ? WHERE id = ?")
          .run(this.now(), taskId);
        touch("tasks", taskId);
      }
      return this.requireTask(taskId);
    });
  }

  moveTask(id: string, status: TaskStatus): Task {
    if (!(TASK_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError(`status must be one of: ${TASK_STATUSES.join(", ")}`);
    }
    this.requireTask(id);
    return this.core.write((touch) => {
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, this.now(), id);
      touch("tasks", id);
      return this.requireTask(id);
    });
  }

  archiveTask(id: string): Task {
    this.requireTask(id);
    const active = this.activeRunOf(id);
    if (active !== null) {
      throw new ConflictError(`task has active run ${active.id}; cancel it before archiving`);
    }
    return this.core.write((touch) => {
      // 归档即退出调度：nextRunAt 置空，恢复时从当下重算（不会补跑停机窗口）
      this.db
        .prepare("UPDATE tasks SET archived = 1, archived_at = ?, next_run_at = NULL, updated_at = ? WHERE id = ?")
        .run(this.now(), this.now(), id);
      touch("tasks", id);
      return this.requireTask(id);
    });
  }

  unarchiveTask(id: string): Task {
    const task = this.requireTask(id);
    return this.core.write((touch) => {
      const now = this.now();
      const nextRunAt =
        task.schedule === null ? null : this.resolveCronNext(task.schedule.cron, task.schedule.tz, now);
      this.db
        .prepare(
          "UPDATE tasks SET archived = 0, archived_at = NULL, next_run_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(nextRunAt, now, id);
      touch("tasks", id);
      return this.requireTask(id);
    });
  }

  deleteTask(id: string): { id: string; danglingChildren: string[]; unboundThreads: string[] } {
    const task = this.requireTask(id);
    const active = this.activeRunOf(id);
    if (active !== null) {
      throw new ConflictError(`task has active run ${active.id}; cancel it before deleting`);
    }
    return this.core.write((touch) => {
      const childRows = this.db
        .prepare("SELECT id FROM tasks WHERE parent_id = ?")
        .all(id) as Array<{ id: string }>;
      // 绑定随任务级联删除：thread 自动回到 Inbox（不删除 thread 与证据）
      const threadRows = this.db
        .prepare("SELECT thread_id FROM task_threads WHERE task_id = ?")
        .all(id) as Array<{ thread_id: string }>;
      const now = this.now();
      const annotate = this.db.prepare(
        "INSERT INTO annotations (id, task_id, thread_id, kind, body, created_at) VALUES (?, ?, NULL, ?, ?, ?)",
      );
      for (const child of childRows) {
        // parent_id 是 ON DELETE SET NULL：悬空子任务保留，并在其审计流里留下说明
        annotate.run(newId("a"), child.id, "parent_deleted", `parent task ${id} (${task.title}) was deleted`, now);
        touch("tasks", child.id);
      }
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      touch("tasks", id);
      for (const row of threadRows) touch("threads", row.thread_id);
      return {
        id,
        danglingChildren: childRows.map((row) => row.id),
        unboundThreads: threadRows.map((row) => row.thread_id),
      };
    });
  }

  // ---- runs ----

  private static runFromRow(row: RunRow): Run {
    return {
      id: row.id,
      taskId: row.task_id,
      status: row.status as RunStatus,
      trigger: row.trigger as RunTrigger,
      threadId: row.thread_id,
      orphaned: row.orphaned === 1,
      failureReason: row.failure_reason,
      createdAt: new Date(row.created_at).toISOString(),
      startedAt: iso(row.started_at),
      endedAt: iso(row.ended_at),
    };
  }

  createRun(taskId: string, trigger: RunTrigger): Run {
    const task = this.requireTask(taskId);
    if (task.archived) throw new ConflictError(`task is archived: ${taskId}`);
    if (task.workspace === null) {
      throw new ValidationError(`task has no workspace: ${taskId}`);
    }
    if (this.activeRunOf(taskId) !== null) {
      throw new ConflictError(`task ${taskId} already has an active run`);
    }
    return this.core.write((touch) => {
      const id = newId("r");
      this.db
        .prepare(
          "INSERT INTO runs (id, task_id, status, trigger, created_at) VALUES (?, ?, 'queued', ?, ?)",
        )
        .run(id, taskId, trigger, this.now());
      // Run queued/running → 任务列 running（需求「Run 终态与看板列映射」）
      this.db
        .prepare("UPDATE tasks SET status = 'running', updated_at = ? WHERE id = ?")
        .run(this.now(), taskId);
      touch("tasks", taskId);
      const row = queryReread<RunRow>(this.db, "SELECT * FROM runs WHERE id = ?", id);
      return TaskStore.runFromRow(plain(row));
    });
  }

  getRun(runId: string): Run | null {
    const row = queryGet<RunRow>(this.db, "SELECT * FROM runs WHERE id = ?", runId);
    return row === undefined ? null : TaskStore.runFromRow(plain(row));
  }

  /** 全局排队 Run，按创建先后（并发上限的队列泵按此顺序起跑）。 */
  listQueuedRuns(): Run[] {
    const rows = queryAll<RunRow>(this.db, "SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at, rowid");
    return rows.map((row) => TaskStore.runFromRow(plain(row)));
  }

  /**
   * 级联翻转原语：只允许把 completed 的 Run 翻成 failed/cancelled（其余终态不得二次翻转）；
   * 「子任务 Run 非 completed 即停」的判定由调用方（runs.ts driveCascade）负责，本方法不检查子任务。
   * 列映射与 finishRun 一致（failed→failed、cancelled→todo）。
   */
  flipRun(runId: string, status: "failed" | "cancelled", failureReason?: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new NotFoundError(`run not found: ${runId}`);
    return this.core.write((touch) => {
      const updated = queryAll<RunRow>(
        this.db,
        "UPDATE runs SET status = ?, ended_at = ?, failure_reason = COALESCE(?, failure_reason) " +
          "WHERE id = ? AND status = 'completed' RETURNING *",
        status,
        this.now(),
        failureReason ?? null,
        runId,
      );
      if (updated.length === 0) {
        throw new ConflictError(
          `run ${runId} is ${row.status}; only completed runs can be flipped by cascade`,
        );
      }
      const column: TaskStatus = status === "failed" ? "failed" : "todo";
      // 级联翻转可能迟到：期间任务已被重新起跑/人工移动时不得覆盖当前列状态
      if (this.activeRunOf(row.task_id) === null) {
        this.db
          .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
          .run(column, this.now(), row.task_id);
      }
      this.pruneRuns(row.task_id);
      touch("tasks", row.task_id);
      return TaskStore.runFromRow(plain(updated[0]!));
    });
  }

  markRunRunning(runId: string, options: { threadId?: string } = {}): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new NotFoundError(`run not found: ${runId}`);
    return this.core.write((touch) => {
      // 只允许从活跃态转 running：建线程窗口内被取消的 Run 不得被复活（终态一次写入）。
      // started_at 只落首次认领时刻：ensureThreadForRun 的二次 mark 不得抹掉排队等待时长
      const updated = queryAll<RunRow>(
        this.db,
        "UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ?), thread_id = COALESCE(?, thread_id) " +
          "WHERE id = ? AND status IN ('queued', 'running') RETURNING *",
        this.now(),
        options.threadId ?? null,
        runId,
      );
      if (updated.length === 0) {
        throw new ConflictError(`run ${runId} is ${row.status}; only queued/running runs can start`);
      }
      touch("tasks", row.task_id);
      return TaskStore.runFromRow(plain(updated[0]!));
    });
  }

  finishRun(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    options: { failureReason?: string; threadId?: string } = {},
  ): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new NotFoundError(`run not found: ${runId}`);
    if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status)) {
      throw new ConflictError(`run ${runId} is already ${row.status}`);
    }
    return this.core.write((touch) => {
      this.db
        .prepare(
          "UPDATE runs SET status = ?, ended_at = ?, failure_reason = ?, thread_id = COALESCE(?, thread_id) WHERE id = ?",
        )
        .run(status, this.now(), options.failureReason ?? null, options.threadId ?? null, runId);
      // 列映射：completed→todo（等待人工/证据门验收）；failed→failed；cancelled→todo
      const column: TaskStatus =
        status === "failed" ? "failed" : "todo";
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
        .run(column, this.now(), row.task_id);
      this.pruneRuns(row.task_id);
      touch("tasks", row.task_id);
      const updated = queryReread<RunRow>(this.db, "SELECT * FROM runs WHERE id = ?", runId);
      return TaskStore.runFromRow(plain(updated));
    });
  }

  private pruneRuns(taskId: string): void {
    const settings = this.settings.getSettings();
    const keep = settings.retention.runsPerTask;
    // 只裁终态 run；活跃 run 无论多旧都保留
    this.db
      .prepare(
        `DELETE FROM runs WHERE task_id = ? AND id IN (
           SELECT id FROM runs WHERE task_id = ? AND status NOT IN ('queued','running')
           ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(taskId, taskId, keep);
  }

  listRuns(taskId: string, limit = 20): Run[] {
    const rows = queryAll<RunRow>(
      this.db,
      "SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      taskId,
      limit,
    );
    return rows.map((row) => TaskStore.runFromRow(plain(row)));
  }

  activeRunOf(taskId: string): Run | null {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as RunRow | undefined;
    return row === undefined ? null : TaskStore.runFromRow(plain(row));
  }

  countActiveRuns(): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM runs WHERE status IN ('queued','running')")
      .get() as { n: number };
    return row.n;
  }

  /** 防休眠窗口只认真正在跑的 run：排队不计入（需求「防休眠」）。 */
  countRunningRuns(): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM runs WHERE status = 'running'")
      .get() as { n: number };
    return row.n;
  }

  // ---- cron 调度面 ----

  /** 到期任务（含已归档者：归档时 nextRunAt 已置空，这里只兜底竞态）。 */
  listDueCronTasks(nowMs: number): Task[] {
    const rows = queryAll<TaskRow>(
      this.db,
      "SELECT * FROM tasks WHERE cron_expr IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, rowid",
      nowMs,
    );
    return rows.map((row) => TaskStore.taskFromRow(plain(row)));
  }

  /** 触发后立刻从 fromMs 起算下一次；错过的窗口不补（需求「cron」）。 */
  advanceCron(taskId: string, fromMs: number): Task {
    const task = this.requireTask(taskId);
    return this.core.write((touch) => {
      const next =
        task.schedule === null || task.archived
          ? null
          : this.resolveCronNext(task.schedule.cron, task.schedule.tz, fromMs);
      this.db.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?").run(next, taskId);
      touch("tasks", taskId);
      return this.requireTask(taskId);
    });
  }

  /**
   * 重启对账：running→failed(orphaned)（保留 thread 锚点）、queued→cancelled、
   * pending/running 动作执行→failed(orphaned)，任务回可重跑态（A24）。
   */
  reconcileOnStartup(): {
    orphanedRuns: string[];
    cancelledRuns: string[];
    failedActions: string[];
    resetTaskIds: string[];
  } {
    return this.core.write((touch) => {
      const now = this.now();
      const orphaned = this.db
        .prepare(
          "UPDATE runs SET status = 'failed', orphaned = 1, failure_reason = ?, ended_at = ? " +
            "WHERE status = 'running' RETURNING id, task_id",
        )
        .all("orphaned by daemon restart", now) as Array<{ id: string; task_id: string }>;
      const cancelled = this.db
        .prepare(
          "UPDATE runs SET status = 'cancelled', failure_reason = ?, ended_at = ? " +
            "WHERE status = 'queued' RETURNING id, task_id",
        )
        .all("cancelled by daemon restart", now) as Array<{ id: string; task_id: string }>;
      const failedActions = this.db
        .prepare(
          "UPDATE action_executions SET status = 'failed', detail = ?, ended_at = ? " +
            "WHERE status IN ('pending','running') RETURNING id",
        )
        .all(JSON.stringify({ reason: "orphaned by daemon restart" }), now) as Array<{ id: string }>;
      const reset = this.db
        .prepare("UPDATE tasks SET status = 'todo', updated_at = ? WHERE status = 'running' RETURNING id")
        .all(now) as Array<{ id: string }>;
      const taskIds = new Set<string>();
      for (const row of [...orphaned, ...cancelled]) {
        taskIds.add(row.task_id);
        touch("tasks", row.task_id);
      }
      for (const row of reset) {
        taskIds.add(row.id);
        touch("tasks", row.id);
      }
      return {
        orphanedRuns: orphaned.map((row) => row.id),
        cancelledRuns: cancelled.map((row) => row.id),
        failedActions: failedActions.map((row) => row.id),
        resetTaskIds: [...taskIds],
      };
    });
  }

  // ---- annotations ----

  addAnnotation(input: {
    taskId?: string | null;
    threadId?: string | null;
    kind: string;
    body: string;
  }): Annotation {
    return this.core.write((touch) => {
      const id = newId("a");
      const now = this.now();
      this.db
        .prepare(
          "INSERT INTO annotations (id, task_id, thread_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, input.taskId ?? null, input.threadId ?? null, input.kind, input.body, now);
      if (input.taskId != null) touch("tasks", input.taskId);
      if (input.threadId != null) touch("threads", input.threadId);
      return {
        id,
        taskId: input.taskId ?? null,
        threadId: input.threadId ?? null,
        kind: input.kind,
        body: input.body,
        createdAt: new Date(now).toISOString(),
      };
    });
  }

  listAnnotations(options: { taskId?: string; threadId?: string; limit?: number } = {}): Annotation[] {
    const limit = options.limit ?? 200;
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(options.taskId);
    }
    if (options.threadId !== undefined) {
      clauses.push("thread_id = ?");
      params.push(options.threadId);
    }
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    const rows = this.db
      .prepare(`SELECT * FROM annotations${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params, limit) as Array<{
      id: string;
      task_id: string | null;
      thread_id: string | null;
      kind: string;
      body: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      threadId: row.thread_id,
      kind: row.kind,
      body: row.body,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  /**
   * 每任务最近 limit 条注记，一次查询（看板轮询热路径的批量面，等价于对每个任务
   * listAnnotations({taskId, limit})——含排序与截断语义；无注记的任务不产生条目）。
   */
  recentAnnotationsByTask(limit: number): Map<string, Annotation[]> {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, thread_id, kind, body, created_at FROM (
           SELECT *, rowid AS rid, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC, rowid DESC) AS rn
           FROM annotations WHERE task_id IS NOT NULL
         ) WHERE rn <= ? ORDER BY task_id, created_at DESC, rid DESC`,
      )
      .all(limit) as Array<{
      id: string;
      task_id: string;
      thread_id: string | null;
      kind: string;
      body: string;
      created_at: number;
    }>;
    const byTask = new Map<string, Annotation[]>();
    for (const row of rows) {
      const list = byTask.get(row.task_id) ?? [];
      list.push({
        id: row.id,
        taskId: row.task_id,
        threadId: row.thread_id,
        kind: row.kind,
        body: row.body,
        createdAt: new Date(row.created_at).toISOString(),
      });
      byTask.set(row.task_id, list);
    }
    return byTask;
  }

  // ---- action executions（goal/sample 等控制调用的执行审计；单飞的数据库级兜底索引） ----

  private static actionFromRow(row: ActionExecutionRow): ActionExecution {
    return {
      id: row.id,
      action: row.action,
      status: row.status as ActionExecution["status"],
      trigger: row.trigger as ActionExecution["trigger"],
      taskId: row.task_id,
      threadId: row.thread_id,
      requestId: row.request_id,
      detail: row.detail === null ? null : safeParseJsonObject(row.detail),
      createdAt: new Date(row.created_at).toISOString(),
      endedAt: iso(row.ended_at),
    };
  }

  /**
   * 登记一条 in-flight 动作执行。同 thread 已有未终态动作时撞 singleflight 唯一索引 →
   * 领域 ConflictError（与进程内 SingleFlightRegistry 互补的数据库级兜底）。
   */
  beginActionExecution(input: {
    action: string;
    trigger: ActionExecution["trigger"];
    taskId?: string | null;
    threadId?: string | null;
    requestId?: string | null;
    detail?: Record<string, unknown> | null;
  }): ActionExecution {
    if (input.taskId != null) this.requireTask(input.taskId);
    return this.core.write((touch) => {
      const id = newId("ax");
      const now = this.now();
      try {
        this.db
          .prepare(
            "INSERT INTO action_executions (id, action, status, trigger, task_id, thread_id, request_id, detail, created_at) " +
              "VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            input.action,
            input.trigger,
            input.taskId ?? null,
            input.threadId ?? null,
            input.requestId ?? null,
            input.detail === null || input.detail === undefined ? null : JSON.stringify(input.detail),
            now,
          );
      } catch (error) {
        // 唯一部分索引兜底的判定按 SQLite 错误码（2067=CONSTRAINT_UNIQUE、1555=CONSTRAINT_PRIMARYKEY）：
        // message 文案跨驱动/版本会变，按子串匹配会把这个领域冲突静默降级成 500
        const errcode = (error as { errcode?: number } | null)?.errcode;
        if (errcode === 2067 || errcode === 1555) {
          throw new ConflictError(
            `thread ${input.threadId ?? "?"} already has an in-flight action execution (database single-flight)`,
          );
        }
        throw error;
      }
      if (input.taskId != null) touch("tasks", input.taskId);
      if (input.threadId != null) touch("threads", input.threadId);
      return TaskStore.actionFromRow(
        queryReread<ActionExecutionRow>(this.db, "SELECT * FROM action_executions WHERE id = ?", id),
      );
    });
  }

  /** 终态一次写入；终态后不得改写（与 Run 一致）。 */
  finishActionExecution(
    id: string,
    status: "completed" | "failed",
    detail?: Record<string, unknown>,
  ): void {
    this.core.write(() => {
      const result = this.db
        .prepare(
          "UPDATE action_executions SET status = ?, detail = COALESCE(?, detail), ended_at = ? " +
            "WHERE id = ? AND status IN ('pending','running')",
        )
        .run(status, detail === undefined ? null : JSON.stringify(detail), this.now(), id);
      if (Number(result.changes) === 0) {
        throw new ConflictError(`action execution ${id} is not in flight`);
      }
    });
  }

  listActionExecutions(options: { taskId?: string; threadId?: string; limit?: number } = {}): ActionExecution[] {
    const limit = Math.max(1, options.limit ?? 100);
    const where =
      options.taskId !== undefined
        ? " WHERE task_id = ?"
        : options.threadId !== undefined
          ? " WHERE thread_id = ?"
          : "";
    const filterParam = options.taskId ?? options.threadId;
    const rows = queryAll<ActionExecutionRow>(
      this.db,
      `SELECT * FROM action_executions${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      ...(filterParam !== undefined ? [filterParam] : []),
      limit,
    );
    return rows.map(TaskStore.actionFromRow);
  }

  // ---- isolated worktree 记录（git 操作在 WorktreeManager；这里只管落库事实） ----

  private static worktreeFromRow(row: WorktreeRow): WorktreeRecord {
    return {
      taskId: row.task_id,
      seq: row.seq,
      branch: row.branch,
      path: row.path,
      baseBranch: row.base_branch,
      sourceWorkspace: row.source_workspace,
      createdAt: new Date(row.created_at).toISOString(),
      removedAt: iso(row.removed_at),
    };
  }

  /** 当前生效（未清理）的 worktree 记录；没有则 null。 */
  activeWorktreeOf(taskId: string): WorktreeRecord | null {
    const row = this.db
      .prepare("SELECT * FROM task_worktrees WHERE task_id = ? AND removed_at IS NULL ORDER BY seq DESC LIMIT 1")
      .get(taskId) as WorktreeRow | undefined;
    return row === undefined ? null : TaskStore.worktreeFromRow(row);
  }

  /** 最近一条记录（含已清理）：视图与幂等清理的展示面。 */
  latestWorktreeOf(taskId: string): WorktreeRecord | null {
    const row = this.db
      .prepare("SELECT * FROM task_worktrees WHERE task_id = ? ORDER BY seq DESC LIMIT 1")
      .get(taskId) as WorktreeRow | undefined;
    return row === undefined ? null : TaskStore.worktreeFromRow(row);
  }

  countWorktrees(taskId: string): number {
    const row = this.db
      .prepare("SELECT count(*) AS n FROM task_worktrees WHERE task_id = ?")
      .get(taskId) as { n: number };
    return row.n;
  }

  insertWorktree(record: {
    taskId: string;
    seq: number;
    branch: string;
    path: string;
    baseBranch: string | null;
    sourceWorkspace: string;
  }): WorktreeRecord {
    return this.core.write((touch) => {
      this.db
        .prepare(
          `INSERT INTO task_worktrees (task_id, seq, branch, path, base_branch, source_workspace, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.taskId,
          record.seq,
          record.branch,
          record.path,
          record.baseBranch,
          record.sourceWorkspace,
          this.now(),
        );
      touch("tasks", record.taskId);
      return this.requireWorktree(record.taskId, record.seq);
    });
  }

  /** 显式清理的终笔：只写 removedAt，branch/commit 证据留在 git 仓由 git 决定去留。 */
  markWorktreeRemoved(taskId: string, seq: number): WorktreeRecord {
    return this.core.write((touch) => {
      const result = this.db
        .prepare(
          "UPDATE task_worktrees SET removed_at = ? WHERE task_id = ? AND seq = ? AND removed_at IS NULL",
        )
        .run(this.now(), taskId, seq);
      if (Number(result.changes) === 0) {
        throw new ConflictError(`worktree ${taskId}/${seq} is already removed`);
      }
      touch("tasks", taskId);
      return this.requireWorktree(taskId, seq);
    });
  }

  private requireWorktree(taskId: string, seq: number): WorktreeRecord {
    const row = this.db
      .prepare("SELECT * FROM task_worktrees WHERE task_id = ? AND seq = ?")
      .get(taskId, seq) as WorktreeRow | undefined;
    if (row === undefined) throw new NotFoundError(`worktree record not found: ${taskId}/${seq}`);
    return TaskStore.worktreeFromRow(row);
  }
}
