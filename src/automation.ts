/**
 * 自动化 scheduler（issue #11 / A12）：按空闲阈值调度已绑定任务的 Jev 评估。
 * off 不评估不动作；suggest/auto 都触发评估（执行面差异在 JevService 的自动执行策略）。
 * 触发节奏（词汇表「no-op 指纹」+ 需求「自动化与权限」）：
 *   - 线程空闲（距最近活动 ≥ 阈值，任务可覆盖）且任务未完成才触发；
 *   - 同一证据指纹已落定结论（无论 no_op 还是已提案的动作）不再重复调用模型——
 *     no_op 去重在 JevService（A12），调度层把同一规则推广到任意结论，避免非 no_op 结论每 tick 烧钱；
 *     新证据（新 turn / 刚执行动作）改变指纹后自然再武装；
 *   - 全局 pause 立即停止新评估（cron 是用户显式调度，不受 pause 影响，也不归本调度器管）。
 * 时间语义：now 注入（与 CronTicker 同款）；tick 只决定轮询频率，不参与阈值判定。
 */

import type { Store, ThreadEvaluationStateView } from "./store/index.js";
import {
  CRITICAL_RISK_NEVER_EXECUTED_REASON,
  isCriticalRisk,
  type AutomationGateMode,
  type AutomationMode,
  type ExecutableProposalAction,
} from "./types.js";
import type { JevAction, JevRisk } from "./jev-answer.js";
import type { MarkDoneGateVerdict } from "./jev-gate.js";

export const DEFAULT_AUTOMATION_TICK_MS = 30_000;

/**
 * 单个 tick 内候选评估的并发上限：一次 Jev 评估（resume+sample+close）可达数十秒，严格串行会让
 * 每多一个空闲线程就线性拉长全部线程的调度延迟。单飞注册表已保证跨 thread 并行安全，小窗口
 * 常量即可；每 thread 的 inFlight 防重入保留，窗口值刻意不做成配置（免调参面扩张）。
 */
export const EVALUATION_CONCURRENCY = 3;

/**
 * 自治上线门的 live 限额（需求「自治上线门」4）：进入 live 后同时自动执行的任务上限。
 * 以 created_at 顺序取前 N 个合格任务；完成/失败/归档的任务让出名额（滚动限额）。
 */
export const LIVE_TASK_LIMIT = 5;

/** live 配额内可自动执行的任务（确定性：按创建序取前 LIVE_TASK_LIMIT 个合格任务）。 */
export const liveQuotaTaskIds = (store: Store): string[] =>
  store
    .listTasks({ includeArchived: false })
    .filter(
      (task) =>
        task.automationMode === "auto" &&
        (task.status === "backlog" || task.status === "todo" || task.status === "running") &&
        store.primaryThreadOf(task.id) !== null,
    )
    .slice(0, LIVE_TASK_LIMIT)
    .map((task) => task.id);

/**
 * 自动执行决策（判别联合）。action 不再手写四元组镜像（#34）：从 types.ts 的
 * EXECUTABLE_PROPOSAL_ACTIONS 单源派生（同 2990dc4b 手法），与执行面共用一个枚举——
 * 删/改任一动作，本联合与 decideAutoExecution 分支、jev-executor 分派同时 tsc 报错。
 */
export type AutoExecutionDecision =
  | { execute: true; action: ExecutableProposalAction }
  | { execute: false; reason: string };

/**
 * 自动执行策略（需求「自动化与权限」+「自治上线门」；纯函数，阈值校准落点）：
 * 只有 trigger=auto 且任务 automation=auto、全局未 pause、live 门已进入、配额内，才允许
 * 低风险 continue_thread/annotate；mark_done 是 acceptance=agent 的唯一例外，走证据门；
 * propose-only 动作与 needs_attention 一律只提案；critical 风险任何路径都拒绝。
 */
export const decideAutoExecution = (input: {
  trigger: "manual" | "interrupted" | "auto";
  automationMode: AutomationMode;
  automationPaused: boolean;
  gateMode: AutomationGateMode;
  withinLiveQuota: boolean;
  needsAttention: boolean;
  action: JevAction;
  risk: JevRisk;
  /** recommended=mark_done 的证据门完整判定；其余动作为 null。deny reason 携带 failed 键名列表（#34）。 */
  markDoneGate: MarkDoneGateVerdict | null;
}): AutoExecutionDecision => {
  if (input.trigger !== "auto") {
    return { execute: false, reason: "manual evaluations wait for user adjudication" };
  }
  if (input.automationPaused) return { execute: false, reason: "automation is paused" };
  if (input.automationMode !== "auto") return { execute: false, reason: "task is not automation=auto" };
  if (input.gateMode !== "live") {
    return {
      execute: false,
      reason: `automation live gate is '${input.gateMode}'; auto execution requires the shadow gate to pass and live entry`,
    };
  }
  if (!input.withinLiveQuota) {
    return { execute: false, reason: `live task limit (${LIVE_TASK_LIMIT}) reached` };
  }
  // critical 永不执行：判定与原因引用 types.ts 共享单源（执行面 jev-executor 同源，晨析 2026-10-25）
  if (isCriticalRisk(input.risk)) return { execute: false, reason: CRITICAL_RISK_NEVER_EXECUTED_REASON };
  if (input.needsAttention) {
    return { execute: false, reason: "Jev flagged needs_attention; waiting for the user" };
  }
  if (input.action === "continue_thread" || input.action === "annotate") {
    return input.risk === "low"
      ? { execute: true, action: input.action }
      : { execute: false, reason: `risk '${input.risk}' exceeds the low-risk live policy` };
  }
  if (input.action === "mark_done") {
    // deny reason 携带 verdict.failed 的键名列表（#34）：动作行单点可读「哪几条前置没过」，
    // 不再需要翻门快照/评估状态拼结论；failed 空数组（防御形态）保持单句、不带冒号尾。
    if (input.markDoneGate?.eligible === true) return { execute: true, action: "mark_done" };
    const failed = input.markDoneGate?.failed ?? [];
    return {
      execute: false,
      reason:
        failed.length > 0
          ? `mark_done evidence gate not satisfied: ${failed.join(", ")}`
          : "mark_done evidence gate not satisfied",
    };
  }
  if (input.action === "no_op") return { execute: true, action: "no_op" };
  return { execute: false, reason: `${input.action} is propose-only; user confirmation required` };
};

// ---- 票 #20：门快照单点与 planAutoExecution 执行计划（#18 决策面，ADR-0015） ----

/**
 * 门快照（词汇表「门快照」）：自动执行判定所需的全部门状态，一次读齐。
 * 门模式/全局 pause/live 配额/任务 automation 模式来自 store；证据门判定是评估自带结论
 * （MarkDoneGateVerdict 整体），由调用方随身带入而非 store 状态。
 */
export interface AutomationGateSnapshot {
  automationMode: AutomationMode;
  automationPaused: boolean;
  gateMode: AutomationGateMode;
  withinLiveQuota: boolean;
  /** recommended=mark_done 的证据门完整判定（verdict 整体带入，deny reason 用 failed 键名）；其余动作为 null。 */
  markDoneGate: MarkDoneGateVerdict | null;
}

/**
 * 薄读取层（#18 故事 13）：读取面是唯一入口——执行面不再各自从 store 捞 settings/配额拼判定输入。
 * 执行起跑时读取（晚读）：评估收口后、分派前门被切到 halted/打开 pause 的窗口照样拦下。
 */
export const automationGateSnapshot = (
  store: Store,
  taskId: string,
  evidenceGate: MarkDoneGateVerdict | null,
): AutomationGateSnapshot => ({
  // 任务缺失按 off 读取：fail-closed，decideAutoExecution 会以「not automation=auto」拒绝
  automationMode: store.getTask(taskId)?.automationMode ?? "off",
  automationPaused: store.getSettings().automationPaused,
  gateMode: store.getSettings().automationLiveGate,
  withinLiveQuota: liveQuotaTaskIds(store).includes(taskId),
  markDoneGate: evidenceGate,
});

/** 提案面：planAutoExecution 需要的评估结论字段（提案落表后不变）。 */
export interface AutoExecutionProposal {
  proposalId: string;
  action: JevAction;
  risk: JevRisk;
  needsAttention: boolean;
  confidence: number | null;
}

/**
 * 执行计划（词汇表「执行计划」）：一次成型的判别联合。放行形态带完整执行口径
 * （authorizedBy="automation:auto"、requestId 派生自提案、confidence、risk），执行面只做
 * 「取计划 → 分派」；拒绝形态带结构化 reason，供 automation.plan 动作行审计（接线在票 #21）。
 */
export type AutoExecutionPlan =
  | {
      execute: true;
      action: Extract<AutoExecutionDecision, { execute: true }>["action"];
      authorizedBy: "automation:auto";
      requestId: string;
      confidence: number | null;
      risk: JevRisk;
    }
  | { execute: false; reason: string };

/**
 * 自动执行计划（#18）：组合 live 动作门（decideAutoExecution，不吞并——准入判定与放行判定
 * 语义不同，两层门判定函数保持独立）与执行口径拼装。纯函数，阈值校准仍以 decideAutoExecution 为落点。
 */
export const planAutoExecution = (
  gate: AutomationGateSnapshot,
  proposal: AutoExecutionProposal,
): AutoExecutionPlan => {
  const decision = decideAutoExecution({
    trigger: "auto",
    automationMode: gate.automationMode,
    automationPaused: gate.automationPaused,
    gateMode: gate.gateMode,
    withinLiveQuota: gate.withinLiveQuota,
    needsAttention: proposal.needsAttention,
    action: proposal.action,
    risk: proposal.risk,
    markDoneGate: gate.markDoneGate,
  });
  if (!decision.execute) return { execute: false, reason: decision.reason };
  return {
    execute: true,
    action: decision.action,
    authorizedBy: "automation:auto",
    requestId: `auto/${proposal.proposalId}`,
    confidence: proposal.confidence,
    risk: proposal.risk,
  };
};

/** 门 1：shadow 阶段至少收集的真实 thread 快照数。 */
export const SHADOW_MIN_SNAPSHOTS = 20;

export interface ShadowGateSummaryStats {
  snapshots: number;
  helpful: number;
  ineffective: number;
  harmful: number;
  executedHarmful: number;
}

export interface ShadowGateVerdict {
  pass: boolean;
  failures: string[];
}

/**
 * 门 4 判定（纯函数，阈值校准落点）：快照数达标（门 1）、零有害（门 6 的前置）、
 * Jev 至少一次优于 no_op（helpful ≥ 1）。不满足的条件全部列出，供动作错误信息一次讲清。
 */
export const evaluateShadowGateVerdict = (summary: ShadowGateSummaryStats): ShadowGateVerdict => {
  const failures: string[] = [];
  if (summary.snapshots < SHADOW_MIN_SNAPSHOTS) {
    failures.push(`only ${summary.snapshots} shadow snapshots collected; the gate requires ${SHADOW_MIN_SNAPSHOTS}`);
  }
  if (summary.harmful > 0) {
    failures.push(`${summary.harmful} harmful label(s) recorded; the gate requires zero harmful actions`);
  }
  if (summary.helpful === 0) {
    failures.push("Jev never outperformed no_op: at least one helpful label is required");
  }
  return { pass: failures.length === 0, failures };
};


export interface IdleEvaluationCandidate {
  threadId: string;
  taskId: string;
}

/**
 * 调度层去重：该线程在当前证据指纹下已有落定结论（评估状态指向同一指纹）→ 不再触发。
 * 与 JevService 的 no_op 去重（A12）独立成层：这里连动作行都不落，彻底避免轮询噪音。
 */
export const evaluationAlreadySettledForFingerprint = (
  state: ThreadEvaluationStateView | null,
  fingerprint: string,
): boolean => state !== null && state.evidenceFingerprint === fingerprint;

export const idleEvaluationCandidates = (
  store: Store,
  nowMs: number,
): IdleEvaluationCandidate[] => {
  const settings = store.getSettings();
  if (settings.automationPaused) return [];
  const candidates: IdleEvaluationCandidate[] = [];
  for (const task of store.listTasks({ includeArchived: false })) {
    if (task.automationMode === "off") continue;
    if (task.status === "done" || task.status === "failed") continue;
    if (store.activeRunOf(task.id) !== null) continue;
    const primary = store.primaryThreadOf(task.id);
    if (primary === null) continue;
    const lastActivity = primary.lastActivityAt === null ? null : Date.parse(primary.lastActivityAt);
    if (lastActivity === null) continue;
    const threshold = task.idleThresholdMs ?? settings.idleThresholdMs;
    if (nowMs - lastActivity < threshold) continue;
    const state = store.getEvaluationState(primary.id);
    if (state?.breakerOpen === true) continue;
    if (evaluationAlreadySettledForFingerprint(state, store.threadEvidenceFingerprint(primary.id))) continue;
    candidates.push({ threadId: primary.id, taskId: task.id });
  }
  return candidates;
};

export interface AutomationSchedulerOptions {
  store: Store;
  /** 评估入口由 daemon 注入（接 JevService.evaluateThread，trigger=auto）；调度器不直接依赖 Jev。 */
  onEvaluate: (candidate: IdleEvaluationCandidate) => Promise<unknown> | unknown;
  now?: () => number;
  intervalMs?: number;
}

export class AutomationScheduler {
  private readonly store: AutomationSchedulerOptions["store"];
  private readonly onEvaluate: AutomationSchedulerOptions["onEvaluate"];
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private readonly inFlight = new Set<string>();
  private ticking = false;
  private stopped = false;

  constructor(options: AutomationSchedulerOptions) {
    this.store = options.store;
    this.onEvaluate = options.onEvaluate;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? DEFAULT_AUTOMATION_TICK_MS;
  }

  start(): void {
    if (this.timer !== undefined) return;
    // 复位 stopped：stop/start 循环复用同一实例（进程内重启、测试）必须复活调度，
    // 否则 stop 后 start 装出活 interval 却 tick 即返回——静默失灵比崩溃更难查
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 在飞评估数（测试与关闭路径用；评估本身的收敛在 JevService.close）。 */
  pendingCount(): number {
    return this.inFlight.size;
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const nowMs = this.now();
      const candidates = idleEvaluationCandidates(this.store, nowMs);
      let next = 0;
      // 有界并发窗口：单飞注册表保证跨 thread 并行安全；每 thread 的 inFlight 防重入保留
      const worker = async (): Promise<void> => {
        for (;;) {
          if (this.stopped) return;
          const candidate = candidates[next];
          next += 1;
          if (candidate === undefined) return;
          if (this.inFlight.has(candidate.threadId)) continue;
          this.inFlight.add(candidate.threadId);
          try {
            await this.onEvaluate(candidate);
          } catch {
            // 评估失败/拒绝（pause、断路器、单飞冲突）由 JevService 落账；调度器只负责不堆积
          } finally {
            this.inFlight.delete(candidate.threadId);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(EVALUATION_CONCURRENCY, candidates.length) }, () => worker()),
      );
    } finally {
      this.ticking = false;
    }
  }
}
