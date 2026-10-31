/** POST /api/actions 的统一写入口：按 type 分发，requestId 幂等（成功响应入环形表，失败不缓存可重试）。
 * executeAction 是 async：run.cancel 需要等 driver 打断在飞 turn；同 requestId 顺序重放仍走环形表缓存。 */

import { CapabilityNotImplementedError, ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { type GoalActionOp, type GoalService } from "./goals.js";
import type { JevService } from "./jev.js";
import type { RunManager } from "./runs.js";
import type { Store } from "./store/index.js";
import type { SummaryService } from "./summary.js";
import type { SystemOneService } from "./systemone/service.js";
import { parseCreateTaskInput, parseUpdateTaskInput } from "./task-input.js";
import { evaluateShadowGateVerdict } from "./automation.js";
import {
  SETTINGS_KEYS,
  SHADOW_LABELS,
  TASK_STATUSES,
  THREAD_BINDING_ROLES,
  type Settings,
  type ShadowLabel,
  type TaskStatus,
  type ThreadBindingRole,
} from "./types.js";
import { taskCard, worktreeViewOf, type ViewContext } from "./views.js";
import type { WorktreeManager } from "./worktree.js";

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

export interface ActionContext {
  store: Store;
  views: ViewContext;
  /** daemon 装配的 Run 生命周期入口；缺省时 run.* 明确 501（测试/裸装配场景）。 */
  runs?: RunManager;
  /** daemon 装配的 goal/sample 执行面；缺省时 goal.* / thread.sample 明确 501（测试/裸装配场景）。 */
  goals?: GoalService;
  /** daemon 装配的 isolated worktree 执行面；缺省时 worktree.clean 明确 501。 */
  worktrees?: WorktreeManager;
  /** daemon 装配的摘要评估数据面；缺省时 summary.* 明确 501（测试/裸装配场景）。 */
  summaries?: SummaryService;
  /** daemon 装配的 Jev 决策面；缺省时 jev.* / proposal.* 明确 501（测试/裸装配场景）。 */
  jev?: JevService;
  /** daemon 装配的 SystemOne 判定面；缺省时 systemone.* 明确 501（测试/裸装配场景）。 */
  systemone?: SystemOneService;
}

const MAX_REQUEST_ID = 200;

const asRecord = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError("action body must be a JSON object");
  }
  return raw as Record<string, unknown>;
};

const requireString = (body: Record<string, unknown>, key: string): string => {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${key} is required`);
  }
  return value;
};

const stripEnvelope = (body: Record<string, unknown>): Record<string, unknown> => {
  const { type: _type, requestId: _requestId, taskId: _taskId, ...rest } = body;
  return rest;
};

const parseThreadRole = (body: Record<string, unknown>): ThreadBindingRole | undefined => {
  const role = body.role;
  if (role === undefined) return undefined;
  if (typeof role !== "string" || !(THREAD_BINDING_ROLES as readonly string[]).includes(role)) {
    throw new ValidationError(`role must be one of: ${THREAD_BINDING_ROLES.join(", ")}`);
  }
  return role as ThreadBindingRole;
};

/** settings.update 可写键 = 键全集 − 门键（automationLiveGate 只经门判定动作流转，update 收它等于跳级）。 */
export const SETTINGS_UPDATE_KEYS: ReadonlyArray<Exclude<keyof Settings, "automationLiveGate">> =
  SETTINGS_KEYS.filter(
    (key): key is Exclude<keyof Settings, "automationLiveGate"> => key !== "automationLiveGate",
  );

const requireRuns = (ctx: ActionContext): RunManager => {
  if (ctx.runs === undefined) {
    throw new CapabilityNotImplementedError(
      "run actions need the harness driver runtime (the daemon assembles it)",
    );
  }
  return ctx.runs;
};

const requireGoals = (ctx: ActionContext): GoalService => {
  if (ctx.goals === undefined) {
    throw new CapabilityNotImplementedError(
      "goal and sample actions need the harness driver runtime (the daemon assembles it)",
    );
  }
  return ctx.goals;
};

const requireSummaries = (ctx: ActionContext): SummaryService => {
  if (ctx.summaries === undefined) {
    throw new CapabilityNotImplementedError(
      "summary actions need the harness driver runtime (the daemon assembles it)",
    );
  }
  return ctx.summaries;
};

const requireJev = (ctx: ActionContext): JevService => {
  if (ctx.jev === undefined) {
    throw new CapabilityNotImplementedError(
      "jev and proposal actions need the harness driver runtime (the daemon assembles it)",
    );
  }
  return ctx.jev;
};

const requireWorktrees = (ctx: ActionContext): WorktreeManager => {
  if (ctx.worktrees === undefined) {
    throw new CapabilityNotImplementedError(
      "worktree actions need the worktree runtime (the daemon assembles it next to the database)",
    );
  }
  return ctx.worktrees;
};

const requireSystemOne = (ctx: ActionContext): SystemOneService => {
  if (ctx.systemone === undefined) {
    throw new CapabilityNotImplementedError(
      "systemone actions need the systemone runtime (the daemon assembles it)",
    );
  }
  return ctx.systemone;
};

/** 可见会话批次上限：UI 按 64 分块；超出一批的请求拒绝而不是截断，避免静默漏判。导出供跨端契约测试钉住与 web 侧相等。 */
export const MAX_SYSTEMONE_VISIBLE = 64;

const parseVisibleThreadIds = (body: Record<string, unknown>): string[] => {
  const raw = body.threadIds;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SYSTEMONE_VISIBLE) {
    throw new ValidationError(`threadIds must be an array of 1..${MAX_SYSTEMONE_VISIBLE} ids`);
  }
  const ids = raw.map((id) => {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new ValidationError("threadIds must contain non-empty strings");
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new ValidationError("threadIds must be unique");
  return ids;
};

const dispatch = async (ctx: ActionContext, type: string, body: Record<string, unknown>): Promise<ActionResult> => {
  const { store, views } = ctx;
  switch (type) {
    case "task.create": {
      const task = store.createTask(parseCreateTaskInput(stripEnvelope(body)));
      return { status: 201, body: { ok: true, task: taskCard(views, task) } };
    }
    case "task.update": {
      const taskId = requireString(body, "taskId");
      const task = store.updateTask(taskId, parseUpdateTaskInput(stripEnvelope(body)));
      return { status: 200, body: { ok: true, task: taskCard(views, task) } };
    }
    case "task.move": {
      const taskId = requireString(body, "taskId");
      const status = body.status;
      if (typeof status !== "string" || !(TASK_STATUSES as readonly string[]).includes(status)) {
        throw new ValidationError(`status must be one of: ${TASK_STATUSES.join(", ")}`);
      }
      const task = store.moveTask(taskId, status as TaskStatus);
      return { status: 200, body: { ok: true, task: taskCard(views, task) } };
    }
    case "task.archive": {
      const task = store.archiveTask(requireString(body, "taskId"));
      return { status: 200, body: { ok: true, task: taskCard(views, task) } };
    }
    case "task.unarchive": {
      const task = store.unarchiveTask(requireString(body, "taskId"));
      return { status: 200, body: { ok: true, task: taskCard(views, task) } };
    }
    case "task.delete": {
      const deleted = store.deleteTask(requireString(body, "taskId"));
      return { status: 200, body: { ok: true, deleted } };
    }
    // thread 绑定/忽略是 taskboard 自有数据，直接走 Store 事务；primary 唯一性由 bindThread 保证
    case "thread.bind": {
      const taskId = requireString(body, "taskId");
      const threadId = requireString(body, "threadId");
      const binding = store.bindThread(taskId, threadId, { role: parseThreadRole(body) });
      return {
        status: 200,
        body: {
          ok: true,
          binding,
          thread: store.getThread(threadId),
          task: taskCard(views, store.requireTask(taskId)),
        },
      };
    }
    case "thread.unbind": {
      const thread = store.unbindThread(requireString(body, "taskId"), requireString(body, "threadId"), {
        role: parseThreadRole(body),
      });
      return { status: 200, body: { ok: true, thread } };
    }
    case "thread.ignore":
    case "thread.unignore": {
      const thread = store.setThreadIgnored(requireString(body, "threadId"), type === "thread.ignore");
      return { status: 200, body: { ok: true, thread } };
    }
    case "automation.pause":
    case "automation.resume": {
      const settings = store.updateSettings({ automationPaused: type === "automation.pause" });
      return { status: 200, body: { ok: true, automationPaused: settings.automationPaused } };
    }
    // 自治上线门（门 1–4）：快照收集与人工标注是 shadow 阶段的数据面；进 live 只经门判定
    // （≥20 快照、零有害、Jev 至少一次优于 no_op）。settings.update 白名单刻意不含
    // automationLiveGate——门模式绕过判定直改等于跳级。halted 无自动恢复：有害标注不可撤销，
    // 有害>0 使判定恒不通过（本构建口径，词汇表「shadow」）。
    case "shadow.collect": {
      const shadow = store.collectShadowComparisons();
      return { status: 200, body: { ok: true, shadow } };
    }
    case "shadow.label": {
      const label = body.label;
      if (typeof label !== "string" || !(SHADOW_LABELS as readonly string[]).includes(label)) {
        throw new ValidationError(`label must be one of: ${SHADOW_LABELS.join(", ")}`);
      }
      const comparison = store.labelShadowComparison(requireString(body, "comparisonId"), label as ShadowLabel);
      return { status: 200, body: { ok: true, comparison } };
    }
    case "automation.live.enter": {
      // halted 是终局门（有害标注不可撤销，判定恒不通过）：显式拒绝而不是让判定再拒一次，
      // 语义上区分「还没进门」与「已被永久关门」
      if (store.getSettings().automationLiveGate === "halted") {
        throw new ConflictError("automation is halted; this build provides no recovery path back to live");
      }
      const summary = store.shadowComparisonSummary();
      const verdict = evaluateShadowGateVerdict(summary);
      if (!verdict.pass) {
        throw new ConflictError(`automation live gate rejected: ${verdict.failures.join("; ")}`);
      }
      const settings = store.updateSettings({ automationLiveGate: "live" });
      return { status: 200, body: { ok: true, gate: settings.automationLiveGate, shadow: summary } };
    }
    case "scan.refresh": {
      // 手动立即扫描（需求「增量与恢复」）；无 reader 的装配明确 501
      if (views.scanNow === undefined) {
        throw new CapabilityNotImplementedError(
          "scan.refresh is not available in this build; the Codex reader is not wired into this assembly",
        );
      }
      return { status: 200, body: { ok: true, scan: await views.scanNow() } };
    }
    case "settings.update": {
      const patch = asRecord(body.settings);
      for (const key of Object.keys(patch)) {
        if (!(SETTINGS_UPDATE_KEYS as readonly string[]).includes(key)) {
          throw new ValidationError(`unknown settings key: ${key}`);
        }
      }
      const settings = store.updateSettings(patch as Partial<Settings>);
      // 提高并发上限要立刻放行排队 Run：pump 只在建单/取消/终局时自触发，改限后不等下一个自然触发
      if ("concurrencyLimit" in patch) ctx.runs?.pump();
      return { status: 200, body: { ok: true, settings } };
    }
    case "run.create": {
      const run = requireRuns(ctx).createRunForTask(requireString(body, "taskId"), "manual");
      return { status: 201, body: { ok: true, run } };
    }
    case "run.cancel": {
      const run = await requireRuns(ctx).cancelRun(requireString(body, "taskId"));
      return { status: 200, body: { ok: true, run } };
    }
    // native goal：全部是 Action Execution（不产生 Run）；授权门与能力错误在 GoalService 内。
    // switch 分支即词表（GOAL_ACTION_OPS 同源），op 无需再校验
    case "goal.set":
    case "goal.get":
    case "goal.status":
    case "goal.pause":
    case "goal.resume":
    case "goal.clear": {
      const op = type.slice("goal.".length) as GoalActionOp;
      const goal = await requireGoals(ctx).executeGoalOp(op, requireString(body, "taskId"), {
        requestId: String(body.requestId),
      });
      return { status: 200, body: { ok: true, goal } };
    }
    // 摘要评估数据面（S1）：评估写经 GoalService 的 thread.sample 单飞动作行落账，
    // summary.* 自身不再开动作行（同线程双在飞动作行会撞单飞唯一索引）
    case "summary.evaluate": {
      const evaluation = await requireSummaries(ctx).evaluateThread(requireString(body, "threadId"), {
        ...(body.force === true ? { force: true } : {}),
        requestId: String(body.requestId),
      });
      return { status: 200, body: { ok: true, evaluation } };
    }
    case "summary.resume": {
      const state = await requireSummaries(ctx).resumeBreaker(requireString(body, "threadId"), {
        requestId: String(body.requestId),
      });
      return { status: 200, body: { ok: true, state } };
    }
    case "thread.sample": {
      const sample = await requireGoals(ctx).sampleThread(requireString(body, "threadId"), {
        requestId: String(body.requestId),
      });
      return { status: 200, body: { ok: true, sample } };
    }
    // Jev 决策面（S2）：一次性 ephemeral 评估；输出只进提案，不直接进状态机（ADR-0010）
    case "jev.evaluate": {
      const evaluation = await requireJev(ctx).evaluateThread(requireString(body, "threadId"), {
        ...(body.force === true ? { force: true } : {}),
        requestId: String(body.requestId),
      });
      return { status: 200, body: { ok: true, evaluation } };
    }
    // 提案裁决：accept 执行（执行面限定确定性动作，审计落动作行与执行结果）；reject 只落终态
    case "proposal.accept": {
      const proposal = await requireJev(ctx).acceptProposal(requireString(body, "proposalId"), {
        requestId: String(body.requestId),
      });
      return { status: 200, body: { ok: true, proposal } };
    }
    case "proposal.reject": {
      const proposal = await requireJev(ctx).rejectProposal(requireString(body, "proposalId"), {
        requestId: String(body.requestId),
      });
      return { status: 200, body: { ok: true, proposal } };
    }
    // isolated worktree 的显式清理：幂等；验收前/失败任务/活跃 Run 由 WorktreeManager 拒绝（A18/故事 73）
    case "worktree.clean": {
      const result = await requireWorktrees(ctx).clean(requireString(body, "taskId"));
      return { status: 200, body: { ok: true, cleaned: result.cleaned, worktree: worktreeViewOf(result.worktree) } };
    }
    // SystemOne 是带外只读判定：visible 只启动后台评估并立即返回，refresh 等待一次强制判定，
    // resume 只清该线程的判定断路器；三者都不产生 Run/Task/Proposal 变更。
    case "systemone.visible": {
      const service = requireSystemOne(ctx);
      const summary = service.visible(parseVisibleThreadIds(body));
      return { status: 200, body: { ok: true, ...summary } };
    }
    case "systemone.refresh": {
      const service = requireSystemOne(ctx);
      const outcome = await service.refresh(requireString(body, "threadId"));
      if (outcome.view === null) throw new NotFoundError(`thread not found: ${outcome.threadId}`);
      return { status: 200, body: { ok: true, outcome } };
    }
    case "systemone.resume": {
      const service = requireSystemOne(ctx);
      const view = await service.resume(requireString(body, "threadId"));
      return { status: 200, body: { ok: true, view } };
    }
    default: {
      throw new ValidationError(`unknown action type: ${type}`);
    }
  }
};

/**
 * requestId 幂等环的同步占位：dispatch 已是 async，recall→remember 之间并发同 id 请求会各自
 * 执行副作用、最后只有一个能落环形表（另一个 500 且副作用已发生）。同步 claim 让并发重复
 * 共享首次执行——与顺序重放的缓存语义一致。
 */
interface InFlightClaim {
  type: string;
  result: Promise<ActionResult>;
}
const inFlightClaims = new WeakMap<ActionContext, Map<string, InFlightClaim>>();

export const executeAction = async (ctx: ActionContext, rawBody: unknown): Promise<ActionResult> => {
  const body = asRecord(rawBody);
  const type = requireString(body, "type");
  const requestId = requireString(body, "requestId");
  if (requestId.length > MAX_REQUEST_ID) {
    throw new ValidationError(`requestId must be at most ${MAX_REQUEST_ID} characters`);
  }
  const recalled = ctx.store.recallResponse(requestId);
  if (recalled !== null) {
    if (recalled.action !== type) {
      throw new ConflictError(
        `requestId ${requestId} was already used for ${recalled.action}, not ${type}`,
      );
    }
    return { status: recalled.status, body: recalled.response as Record<string, unknown> };
  }
  let claims = inFlightClaims.get(ctx);
  if (claims === undefined) {
    claims = new Map();
    inFlightClaims.set(ctx, claims);
  }
  const pending = claims.get(requestId);
  if (pending !== undefined) {
    if (pending.type !== type) {
      throw new ConflictError(`requestId ${requestId} is in flight for ${pending.type}, not ${type}`);
    }
    return pending.result;
  }
  const execution = (async () => {
    const result = await dispatch(ctx, type, body);
    ctx.store.rememberResponse(requestId, type, result.status, result.body);
    return result;
  })();
  claims.set(requestId, { type, result: execution });
  try {
    return await execution;
  } finally {
    // 失败不缓存（可重试）：占位随之撤销，重试与并发重试都走全新执行
    claims.delete(requestId);
  }
};
