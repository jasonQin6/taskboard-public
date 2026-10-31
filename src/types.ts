/** V2 领域类型。措辞以 GLOSSARY.md 词汇表为准；时间在领域对象里是 ISO 字符串，库内是 ms 整数。 */

export const TASK_STATUSES = ["backlog", "todo", "running", "done", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_SOURCES = ["manual", "scan", "self_improvement", "external_issue"] as const;
export type TaskSource = (typeof TASK_SOURCES)[number];

export const ACCEPTANCE_MODES = ["human", "agent"] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];

export const AUTOMATION_MODES = ["off", "suggest", "auto"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const WORKSPACE_MODES = ["current", "isolated_worktree"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export type SubtasksPolicy = "cascade";

export const RUN_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"];

export const RUN_TRIGGERS = ["manual", "cron", "cascade", "auto"] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const THREAD_NATIVE_STATUSES = [
  "running",
  "idle",
  "completed",
  "failed",
  "interrupted",
  "held",
  "unknown",
] as const;
export type ThreadNativeStatus = (typeof THREAD_NATIVE_STATUSES)[number];

export const THREAD_BINDING_ROLES = ["primary", "derived_from", "evidence_for"] as const;
export type ThreadBindingRole = (typeof THREAD_BINDING_ROLES)[number];

export const REVISION_DOMAINS = ["tasks", "threads", "config"] as const;
export type RevisionDomain = (typeof REVISION_DOMAINS)[number];

export interface TaskSchedule {
  cron: string;
  tz: string | null;
  nextRunAt: string | null;
}

export interface TaskGoal {
  enabled: boolean;
  budgetTokens: number | null;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  workspace: string | null;
  status: TaskStatus;
  archived: boolean;
  archivedAt: string | null;
  labels: string[];
  source: TaskSource;
  acceptanceCriteria: string;
  acceptanceMode: AcceptanceMode;
  automationMode: AutomationMode;
  workspaceMode: WorkspaceMode;
  parentId: string | null;
  subtasksPolicy: SubtasksPolicy | null;
  idleThresholdMs: number | null;
  schedule: TaskSchedule | null;
  goal: TaskGoal;
  createdAt: string;
  updatedAt: string;
}

export interface Run {
  id: string;
  taskId: string;
  status: RunStatus;
  trigger: RunTrigger;
  threadId: string | null;
  orphaned: boolean;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface Thread {
  id: string;
  nativeStatus: ThreadNativeStatus;
  title: string | null;
  lastActivityAt: string | null;
  firstSeenAt: string;
  ignored: boolean;
  primaryTaskId: string | null;
  /** 最近一次 goal 操作观测到的 Codex 原生 goal 状态（证据缓存；null = 无 goal）。 */
  goalStatus: string | null;
}

export interface ThreadBinding {
  taskId: string;
  threadId: string;
  role: ThreadBindingRole;
  boundAt: string;
}

export interface ThreadLineageEdge {
  threadId: string;
  parentThreadId: string;
  relation: string;
  createdAt: string;
}

export interface Annotation {
  id: string;
  taskId: string | null;
  threadId: string | null;
  kind: string;
  body: string;
  createdAt: string;
}

/** Action Execution：goal/sample 等控制调用的执行审计（不产生 Run）。 */
export interface ActionExecution {
  id: string;
  action: string;
  status: "pending" | "running" | "completed" | "failed";
  trigger: "manual" | "auto";
  taskId: string | null;
  threadId: string | null;
  requestId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
  endedAt: string | null;
}

export interface RetentionSettings {
  runsPerTask: number;
  unboundEvidenceDays: number;
  boundEvidenceDays: number;
}

export interface Settings {
  automationPaused: boolean;
  idleThresholdMs: number;
  concurrencyLimit: number;
  preventIdleSleep: boolean;
  maxSubtaskDepth: number;
  retention: RetentionSettings;
  jevModel: string | null;
  jevEffort: string | null;
  sampleEnabled: boolean;
  trustedProxyHosts: string[];
  proxyTokenEnv: string | null;
  /** isolated_worktree 的基准分支；null 表示用 workspace 仓的 HEAD（需求「自改进 Issue」）。 */
  worktreeBaseBranch: string | null;
  /** SystemOne 进度判断开关（ADR-0019；默认启用，Evidence 会外发给 provider）。 */
  systemoneEnabled: boolean;
  /** SystemOne 模型；null = 用 provider 内置默认（magpie 为 typesafe/jev-latest）。 */
  systemoneModel: string | null;
  /** SystemOne 每日 token 预算（UTC 日，input+output 合计，非负整数；0 = 当日不调用）。 */
  systemoneDailyTokenBudget: number;
  /** SystemOne 网关令牌的环境变量名；只存名字不存密钥，值只从环境读。 */
  systemoneTokenEnv: string | null;
  /** 自治上线门模式（词汇表「shadow」）；流转只经 shadow.collect/shadow.label/automation.live.enter 门判定。 */
  automationLiveGate: AutomationGateMode;
}

/**
 * settings 键全集的唯一声明处。Record 映射经 satisfies 双向钉死与 Settings 接口一致：
 * 键拼错、漏登新键、多登废键、重复键都是编译错。settings.update 的可写键（actions 的
 * SETTINGS_UPDATE_KEYS）从本全集减门键派生，不另列清单；与 DEFAULT_SETTINGS 值面的
 * 对齐由 test/settings-keys.test.ts 运行期钉住。
 */
const SETTINGS_KEY_MAP = {
  automationPaused: true,
  idleThresholdMs: true,
  concurrencyLimit: true,
  preventIdleSleep: true,
  maxSubtaskDepth: true,
  retention: true,
  jevModel: true,
  jevEffort: true,
  sampleEnabled: true,
  trustedProxyHosts: true,
  proxyTokenEnv: true,
  worktreeBaseBranch: true,
  systemoneEnabled: true,
  systemoneModel: true,
  systemoneDailyTokenBudget: true,
  systemoneTokenEnv: true,
  automationLiveGate: true,
} as const satisfies Record<keyof Settings, true>;

export const SETTINGS_KEYS: ReadonlyArray<keyof Settings> = Object.keys(
  SETTINGS_KEY_MAP,
) as ReadonlyArray<keyof Settings>;

export interface RevisionChange {
  domain: RevisionDomain;
  revision: number;
  ids: string[];
}

/**
 * 一次 isolated worktree 创建的持久记录（task_worktrees 表）。
 * 保留语义：Run 终态与验收都不删记录；只有显式清理写 removedAt（A18/故事 73）。
 */
export interface WorktreeRecord {
  taskId: string;
  /** 同一任务第几次创建（从 1 起）；清理后再跑新开一档，历史记录不覆盖。 */
  seq: number;
  branch: string;
  path: string;
  /** 创建时冻结的基准分支；null = 当时按 HEAD 创建。 */
  baseBranch: string | null;
  /** worktree 所属主仓（创建时冻结；任务改指其他 workspace 后按此拒绝混用）。 */
  sourceWorkspace: string;
  createdAt: string;
  removedAt: string | null;
}

export type PowerProtectionStatus = "off" | "idle" | "active" | "unavailable";

/**
 * 自治上线门模式（需求「自治上线门」，持久化在 settings → 重启不复活/不跳级）：
 * shadow（默认，只评估不自动执行）→ live（门通过后进入，≤5 个任务低风险自动执行）→
 * halted（出现有害动作立即停，只能留证据，本构建不提供自动恢复路径）。
 */
export const AUTOMATION_GATE_MODES = ["shadow", "live", "halted"] as const;
export type AutomationGateMode = (typeof AUTOMATION_GATE_MODES)[number];

/**
 * shadow 快照的人工标注（词汇表「shadow」三值：有帮助/无效/有害）。
 * 已执行快照被标 harmful 时门立即转 halted（自治上线门 6）。
 * 与 schema.ts shadow_comparisons 的 CHECK (label IN (...)) 同一词汇：改动必须两侧同步
 * （test/store.test.ts 有逐值插入一致性断言），否则会以 SQLite 约束错误而不是 ValidationError 暴露。
 */
export const SHADOW_LABELS = ["helpful", "ineffective", "harmful"] as const;
export type ShadowLabel = (typeof SHADOW_LABELS)[number];

/**
 * 执行面接受的提案动作（确定性语义；决策面单源，issue #34）：提案执行面（jev-executor）的
 * accept 分派与 automation 的 AutoExecutionDecision/执行计划 action 联合均从本常量 typeof 派生
 * （同 AUTOMATION_GATE_MODES 先例）——新增可执行动作只改这一处，决策面与执行面不可能漂移。
 * retry_run/create_child_task/ask_user/mark_blocked 本构建 propose-only（需求「Jev」：默认只生成
 * 提案，接受时明确拒绝）；types.ts 无依赖，automation 反向引用不成环。
 */
export const EXECUTABLE_PROPOSAL_ACTIONS = ["continue_thread", "annotate", "mark_done", "no_op"] as const;
export type ExecutableProposalAction = (typeof EXECUTABLE_PROPOSAL_ACTIONS)[number];

/**
 * 评估层「待关注」标注与徽标来源（A16；issue #34 常量化，照 EXECUTABLE_PROPOSAL_ACTIONS 同款归宿）：
 * 评估结论即等待人信号——落库（评估收口）与看板比对（views 徽标）都引用本常量，不散裸字符串。
 * 跨落库/看板比对的词汇表键值放无依赖叶子：views.ts（纯读侧）直接引用本模块，不为此依赖
 * jev 服务编排图（jev.ts re-export 保持既有 import 路径零变化，读写两侧同源）。
 */
export const NEEDS_ATTENTION_KIND = "needs_attention";

/**
 * critical 风险永不执行（词汇表「风险等级」）的共享判定与拒绝原因（晨析 2026-10-25）：决策面
 * （automation.decideAutoExecution）与执行面（jev-executor.acceptProposal）此前各留一份
 * risk 字面镜像，改风险策略（如未来放行 medium）两侧互不提醒。落无依赖叶子（同
 * EXECUTABLE_PROPOSAL_ACTIONS 归宿），mark_done 证据门的 riskNotCritical 条件同源取反。
 */
export const isCriticalRisk = (risk: string): boolean => risk === "critical";
export const CRITICAL_RISK_NEVER_EXECUTED_REASON = "critical risk is never executed";
