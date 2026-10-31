/**
 * Jev：选择与语义判断层（issue #15 / S2，ADR-0010）。经 driver 一次性 ephemeral 调用
 * （thread/sample 同款路径：resume→sample→close，不写原 thread、不改会话状态、用 Codex 自身凭据）。
 * 输入按不可信数据处理；输出必须是结构化 JSON 且只进 proposal，绝不直接进状态机。
 * 非法输出/选项越界/超时=失败：只存失败提案，不推进；驱动级失败计入断路器（词汇表「断路器」）。
 * 本模块留评估编排与对外门面：纯函数区在 jev-answer/jev-gate，提案执行面在 jev-executor
 * （issue #34 / Commit 1 下沉， ProposalExecutor 见词汇表「提案执行面」）；
 * re-export 保持既有 import 路径零变化。
 */

import { CapabilityUnavailableError } from "./driver/errors.js";
import { type CodexDriver } from "./driver/codex-driver.js";
import {
  automationGateSnapshot,
  planAutoExecution,
  type AutoExecutionProposal,
} from "./automation.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { classifySampleFailure, type SampleFailureKind } from "./goals.js";
import { CODEX_HARNESS_ID } from "./harness/ids.js";
import { THREAD_RESUME_KIND } from "./runs.js";
import { redactExcerpt } from "./redact.js";
import type { ProposalView, ReaderTurnStatus, Store, ThreadEvaluationStateView } from "./store/index.js";
import { NEEDS_ATTENTION_KIND, type Task } from "./types.js";
import {
  buildJevPrompt,
  isJevProposalPayload,
  JEV_SUMMARY_SHORT_MAX_CHARS,
  parseJevAnswer,
  PROMPT_ANNOTATION_ITEMS,
  PROMPT_EVIDENCE_ITEMS,
  type JevAction,
  type JevAnswer,
  type JevAnswerCandidate,
} from "./jev-answer.js";
import { evaluateMarkDoneGate, type MarkDoneGateVerdict } from "./jev-gate.js";
import { ProposalExecutor, type ProposalExecutionOptions } from "./jev-executor.js";

// ---- 下沉模块的兼容 re-export：对外 import 面保持零变化（issue #34 / Commit 1） ----

export * from "./jev-answer.js";
export * from "./jev-gate.js";
// 执行面动作枚举单源在 types.ts（#34）：jev-executor 只留守卫；re-export 保持既有 import 路径零变化
export { EXECUTABLE_PROPOSAL_ACTIONS, type ExecutableProposalAction } from "./types.js";
// 评估层「待关注」常量单源在 types.ts（#34，与 EXECUTABLE_PROPOSAL_ACTIONS 同归宿：views 读侧
// 直接引用无依赖叶子，不为此引入对 jev 服务编排图的运行时依赖）；re-export 保持 import 路径零变化
export { NEEDS_ATTENTION_KIND } from "./types.js";
export { isExecutableProposalAction } from "./jev-executor.js";

// ---- JevService：评估执行面（提案只进表；失败只存失败提案；断路器与 S1 同一行） ----

/**
 * 一次自动执行的待办：评估已收口（提案已落表、needs_attention 标注已落），单飞槽释放后
 * fire-and-forget 执行（close 时收敛）。只携带分派所需的评估结论与上下文，不做任何门判定——
 * 执行计划在起跑时经门快照（晚读）+ planAutoExecution 一次成型（词汇表「执行计划」）。
 */
interface AutoExecutionTodo {
  proposalId: string;
  threadId: string | null;
  task: Task;
  /** 提案面（automation 单源）：planAutoExecution 的评估结论输入。 */
  proposal: AutoExecutionProposal;
  candidate: JevAnswerCandidate;
  /** recommended=mark_done 的证据门判定（verdict 整体进门快照，deny reason 带 failed 键名）；其余动作为 null。 */
  gate: MarkDoneGateVerdict | null;
}

/** 一次 Jev 评估的外部可见结果（HTTP 动作缝）。 */
export interface JevEvaluationOutcome {
  threadId: string;
  taskId: string | null;
  /** false = 去重命中未触发评估（skipReason 说明）。 */
  performed: boolean;
  skipReason: "no_new_evidence" | null;
  /** 本轮拿到了合法结构化答案并落了提案结论（含 no_op）。 */
  decided: boolean;
  /** 本轮新插入了一条提案行（重复指纹+推荐不重复插入）。 */
  proposed: boolean;
  /** 驱动级失败/非法输出（已计入断路器连败）。 */
  failed: boolean;
  failureKind: SampleFailureKind | null;
  held: boolean;
  proposalId: string | null;
  recommended: JevAction | null;
  /** recommended=mark_done 时的证据门判定（其余动作为 null）。 */
  gate: MarkDoneGateVerdict | null;
  reason: string | null;
  /** 评估状态行：环境性回落（held/能力缺失/无 turn）不落评估状态，可能为 null。 */
  state: ThreadEvaluationStateView | null;
}

export interface JevServiceOptions {
  store: Store;
  driver: CodexDriver;
  singleFlight: import("./single-flight.js").SingleFlightRegistry;
}

export class JevService {
  private readonly store: Store;
  private readonly driver: CodexDriver;
  private readonly singleFlight: JevServiceOptions["singleFlight"];
  /** 提案执行面（词汇表「提案执行面」）：三兄弟（accept/continue_thread/local）在 executor，本类分派。 */
  private readonly executor: ProposalExecutor;
  private readonly executions = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: JevServiceOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.singleFlight = options.singleFlight;
    this.executor = new ProposalExecutor(options);
  }

  /** daemon 关闭前在飞评估收敛（关闭顺序在 runs/driver 之前）。 */
  pendingCount(): number {
    return this.executions.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.executions]);
  }

  /** 在飞登记：close() 等全部落定（与 GoalService 同款收口）。 */
  private track<T>(execution: Promise<T>): Promise<T> {
    this.executions.add(execution);
    void execution
      .catch(() => undefined)
      .finally(() => {
        this.executions.delete(execution);
      });
    return execution;
  }

  /**
   * 对一个已绑定 Task 的线程跑一轮 Jev 评估：去重（A12）→ ephemeral 调用（resume→sample→close，
   * 写锁审计同 sample 纪律）→ 严格解析 → 提案落表（ADR-0010：不进状态机）→ 评估状态落定。
   * trigger=interrupted 是 A20 的自动触发面、trigger=auto 是自动化 scheduler 的触发面
   * （两者动作行 trigger=auto；manual 是显式动作，绝不触发自动执行）。
   */
  evaluateThread(
    threadId: string,
    options: { force?: boolean; requestId?: string; trigger?: "manual" | "interrupted" | "auto" } = {},
  ): Promise<JevEvaluationOutcome> {
    const execution = (async () => this.runEvaluation(threadId, options))();
    return this.track(execution);
  }

  /**
   * JevEvaluationOutcome 基准构造入口（晨析 2026-10-25）：默认 shape 单源，各收口只 patch 差量。
   * （offeredRefs 的漂移在失败提案 payload 而非 outcome——统一见 settleInvalid 的 addProposal。）
   */
  private baseOutcome(threadId: string, taskId: string | null): JevEvaluationOutcome {
    return {
      threadId,
      taskId,
      performed: true,
      skipReason: null,
      decided: false,
      proposed: false,
      failed: false,
      failureKind: null,
      held: false,
      proposalId: null,
      recommended: null,
      gate: null,
      reason: null,
      state: this.store.getEvaluationState(threadId),
    };
  }

  private async runEvaluation(
    threadId: string,
    options: { force?: boolean; requestId?: string; trigger?: "manual" | "interrupted" | "auto" },
  ): Promise<JevEvaluationOutcome> {
    const noop = (patch: Partial<JevEvaluationOutcome>): JevEvaluationOutcome => ({
      ...this.baseOutcome(threadId, null),
      ...patch,
    });
    if (this.closed) throw new ConflictError("jev service is shutting down");
    const thread = this.store.getThread(threadId);
    if (thread === null) throw new NotFoundError(`thread not found: ${threadId}`);
    const taskId = thread.primaryTaskId;
    if (taskId === null) {
      throw new ValidationError(`thread ${threadId} is not bound to a task; Jev evaluates bound threads only`);
    }
    const task = this.store.requireTask(taskId);
    const settings = this.store.getSettings();
    // 全局 pause 立即停止新评估（需求「自动化与权限」）；off 只观察不评估
    if (settings.automationPaused) {
      throw new ConflictError("automation is paused; Jev evaluations are stopped until resumed");
    }
    if (task.automationMode === "off") {
      throw new ConflictError(`task ${taskId} has automation=off; Jev does not evaluate it`);
    }
    const state = this.store.getEvaluationState(threadId);
    if (state?.breakerOpen === true) {
      // 断路器是保险丝：force 也不能绕过，恢复只走人工 resume（词汇表「断路器」）
      throw new ConflictError(
        `evaluation breaker is open for thread ${threadId}; auto evaluation is paused until manual resume`,
      );
    }
    const fingerprintBefore = this.store.threadEvidenceFingerprint(threadId);
    if (options.force !== true && state !== null && state.lastNoOp && state.evidenceFingerprint === fingerprintBefore) {
      return noop({
        performed: false,
        skipReason: "no_new_evidence",
        taskId,
        state,
      });
    }
    const action = this.store.beginActionExecution({
      action: "jev.evaluate",
      trigger: options.trigger === "manual" ? "manual" : "auto",
      taskId,
      threadId,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      detail: { model: settings.jevModel, effort: settings.jevEffort },
    });
    // 单飞与 send/goal/sample 共享同一线程槽（A11）；动作行先落账再拿槽，失败按失败收口
    if (!this.singleFlight.tryAcquire(threadId, "proposal")) {
      this.store.finishActionExecution(action.id, "failed", { reason: "single-flight" });
      throw new ConflictError(`thread ${threadId} already has an in-flight write (single-flight)`);
    }
    let settled: { outcome: JevEvaluationOutcome; autoTodo: AutoExecutionTodo | null };
    try {
      const prompt = this.buildPrompt(threadId, task);
      const prepared = await this.prepareEphemeral(threadId, action.id).catch((error: unknown) => ({
        // resume/ensure-start 等驱动级失败走与 sample 同一条失败收口：终结动作行、失败提案、
        // 计入断路器。只上抛不落账的话，单飞唯一部分索引会卡死该线程全部后续动作直到重启
        outcome: this.settleFailure(action.id, threadId, taskId, error, prompt.offeredRefs, settings.jevModel, settings.jevEffort),
      }));
      if ("outcome" in prepared) return prepared.outcome;
      const { needResume, expectedTurnId } = prepared;
      let sampled: string;
      try {
        sampled = await this.driver.sample({
          threadId,
          expectedTurnId,
          prompt: prompt.prompt,
        });
      } catch (error) {
        if (needResume) await this.releaseLock(threadId, taskId);
        return this.settleFailure(action.id, threadId, taskId, error, prompt.offeredRefs, settings.jevModel, settings.jevEffort);
      }
      if (needResume) await this.releaseLock(threadId, taskId);
      let answer: JevAnswer;
      try {
        answer = parseJevAnswer(sampled, prompt.offeredRefs);
      } catch (error) {
        // 非法输出/越界选项按失败处理：失败提案 + 断路器 protocol 计数（词汇表「断路器」）
        const reason = error instanceof Error ? error.message : String(error);
        return this.settleInvalid(action.id, threadId, taskId, reason, prompt.offeredRefs, settings.jevModel, settings.jevEffort);
      }
      settled = this.settleAnswer(
        action.id,
        threadId,
        taskId,
        task,
        answer,
        prompt.refKinds,
        settings.jevModel,
        settings.jevEffort,
        options.trigger ?? "manual",
      );
    } finally {
      this.singleFlight.release(threadId);
    }
    // 自动执行在评估的单飞槽释放后进行：continue_thread 的 send 需要重新拿槽，绝不与评估并行。
    // 只登记不 await：评估结果先返回，执行收敛由 track() 在 close 时兜底。
    if (settled.autoTodo !== null) {
      const todo = settled.autoTodo;
      void this.track(this.executeAutoProposal(todo));
    }
    return settled.outcome;
  }

  /**
   * 自动执行（trigger=auto 的评估落定后，票 #21「执行计划」接线）：起跑时经门快照单点
   * （automationGateSnapshot）晚读 store 当下门状态，planAutoExecution 一次成型执行计划后按计划
   * 分派；授权口径（authorizedBy/requestId/confidence）全部来自计划，执行方法内不拼装。
   * 计划落定即落 automation.plan 审计动作行（票 #22，放行与拒绝都落，单点流水可查全部自动执行
   * 判定）；计划拒绝或提案已被裁决时不执行，提案保持 pending 供人工裁决；needs_attention 标注
   * 已在评估收口落（A16 徽标语义）。
   */
  private async executeAutoProposal(todo: AutoExecutionTodo): Promise<void> {
    // 起跑让位一跳：评估结果先返回（fire-and-forget 的字面语义），门快照晚读发生在让位之后——
    // 评估收口与执行起跑之间切 halted/打开 pause 的窗口照样拦下（变异验证钉死这一接线）
    await new Promise((resolve) => setImmediate(resolve));
    const gateSnapshot = automationGateSnapshot(this.store, todo.task.id, todo.gate);
    const plan = planAutoExecution(gateSnapshot, todo.proposal);
    // 计划行生成即落（#22）：detail 是执行计划的字面投影——拒绝形态 {execute,reason}，放行形态
    // 完整授权口径（authorizedBy/requestId/confidence/risk/action）。begin 一次写全，finish 只翻
    // completed 终态（detail 是整体替换，不重写）。threadId 刻意留空：终态动作 id 是证据指纹的
    // 一部分（按 thread 计），计划行是决策审计不是线程新证据，带上会让 deny/no_op 场景每 tick
    // 重评估烧模型（解除 A12/调度层去重）；行仍带 taskId/requestId，按任务或全局流水单点可查。
    // no_op 放行的 detail 加 acknowledged:true（#34）：确认不写终态动作行（写它会翻转证据指纹、
    // 解除 A12 去重），plan 行自身就是「这次自动放行是一次确认」的落库留痕。
    const planRow = this.store.beginActionExecution({
      action: "automation.plan",
      trigger: "auto",
      taskId: todo.task.id,
      ...(plan.execute ? { requestId: plan.requestId } : {}),
      detail: {
        ...plan,
        ...(plan.execute && plan.action === "no_op" ? { acknowledged: true } : {}),
      },
    });
    this.store.finishActionExecution(planRow.id, "completed");
    if (!plan.execute) return;
    const proposal = this.store.getProposal(todo.proposalId);
    if (proposal === null || proposal.status !== "pending") return;
    const executionOptions: ProposalExecutionOptions = { ...plan, trigger: "auto" };
    if (plan.action === "continue_thread") {
      if (todo.threadId === null) return;
      await this.executor.executeContinueThread(proposal, todo.task, todo.candidate, executionOptions).catch(() => undefined);
      return;
    }
    if (plan.action === "no_op") {
      // no-op 确认不写终态动作行：终态动作 id 会翻转证据指纹，反而解除 A12 去重（每 tick 重复烧模型）。
      // 提案保持 pending 供人工裁决；评估状态已按 no_op 落定（lastNoOp + 指纹），调度层去重同样命中
      return;
    }
    this.executor.executeLocalProposal(proposal, todo.task, todo.candidate, plan.action, executionOptions);
  }

  /** 组评估 prompt：thread 最新摘要 + 最近证据/标注（全部经脱敏截断；refs 是 Jev 唯一可引用集）。 */
  private buildPrompt(threadId: string, task: Task): { prompt: string; offeredRefs: string[]; refKinds: Record<string, string> } {
    const summary = this.store.latestThreadSummary(threadId);
    // 取数条数与 prompt 组装同源（jev-answer 的 PROMPT_*_ITEMS）：改报价上限时取数自动跟随，
    // offeredRefs 与 refKinds 的对齐不靠人肉记忆
    const evidence = this.store
      .listEvidencePage(threadId, { limit: PROMPT_EVIDENCE_ITEMS })
      .items.map((item) => ({ id: item.id, kind: item.kind, summary: item.summary }));
    const annotations = this.store
      .listAnnotations({ limit: 200 })
      .filter((note) => note.threadId === threadId)
      .slice(0, PROMPT_ANNOTATION_ITEMS)
      .map((note) => ({ id: note.id, kind: note.kind, body: note.body }));
    const built = buildJevPrompt({
      task: { title: task.title, acceptanceCriteria: task.acceptanceCriteria },
      summary: summary === null ? null : { provenance: summary.provenance, text: summary.text },
      evidence,
      annotations,
    });
    const refKinds: Record<string, string> = {};
    for (const item of evidence) refKinds[item.id] = item.kind;
    // 标注即人工标注：映射为证据门保留类 "annotation"（词汇表「证据门」）
    for (const note of annotations) refKinds[note.id] = "annotation";
    return { ...built, refKinds };
  }

  /**
   * ephemeral 前置：能力探测、expected turn、按需 resume（写锁审计；Conflict → held 如实回落，
   * 不计连败）。返回 {outcome} 表示评估未触达模型（环境状态），由调用方原样返回。
   */
  private async prepareEphemeral(
    threadId: string,
    actionId: string,
  ): Promise<{ needResume: boolean; expectedTurnId: string } | { outcome: JevEvaluationOutcome }> {
    const taskId = this.store.getThread(threadId)?.primaryTaskId ?? null;
    const client = await this.driver.ensureStarted();
    try {
      client.requireCapability("thread/sample");
    } catch (error) {
      if (error instanceof CapabilityUnavailableError) {
        this.store.finishActionExecution(actionId, "completed", { reason: "thread/sample is not available on this app-server" });
        return {
          outcome: this.outcomeForEnvironment(threadId, taskId, "thread/sample is not available on this app-server; Jev cannot evaluate"),
        };
      }
      throw error;
    }
    const expected = this.store.latestCompletedTurn(threadId);
    if (expected === null) {
      this.store.finishActionExecution(actionId, "completed", { reason: "no completed turn is known to the reader" });
      return {
        outcome: this.outcomeForEnvironment(threadId, taskId, "no completed turn is known to the reader; expected_turn_id cannot be validated"),
      };
    }
    const needResume = !this.driver.isLoaded(threadId);
    if (needResume) {
      // 采样后必须能释放写锁：close 能力缺失就不接管（与 sample 同纪律）
      try {
        client.requireCapability("thread/close");
      } catch (error) {
        if (error instanceof CapabilityUnavailableError) {
          this.store.finishActionExecution(actionId, "completed", { reason: "thread/close is not available on this app-server" });
          return {
            outcome: this.outcomeForEnvironment(threadId, taskId, "thread/close is not available; the writer lock could not be released after sampling"),
          };
        }
        throw error;
      }
      try {
        await this.driver.resumeThread({ threadId, idempotencyKey: `resume/jev/${threadId}` });
      } catch (error) {
        if (error instanceof ConflictError) {
          this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: "held" });
          this.store.finishActionExecution(actionId, "completed", { reason: "thread is held by another process (writer lock conflict)", held: true });
          return {
            outcome: this.outcomeForEnvironment(threadId, taskId, "thread is held by another process (writer lock conflict)", { held: true }),
          };
        }
        throw error;
      }
      // 写邻接审计：resume 接管写锁且可能 materialize .jsonl.zst（ADR-0003 唯一例外）
      this.store.addAnnotation({
        ...(taskId !== null ? { taskId } : {}),
        threadId,
        kind: THREAD_RESUME_KIND,
        body: `writer lock taken for Jev evaluation (bound thread; may materialize compacted rollups)`,
      });
    }
    return { needResume, expectedTurnId: expected.id };
  }

  /** 环境性回落（held/能力缺失/无 turn/服务端拒绝）：不是失败，不计连败，无提案。 */
  private outcomeForEnvironment(threadId: string, taskId: string | null, reason: string, patch: Partial<JevEvaluationOutcome> = {}): JevEvaluationOutcome {
    return { ...this.baseOutcome(threadId, taskId), reason, ...patch };
  }

  /** 驱动级失败：失败提案 + 断路器计数（同 S1 一条计数路径）。 */
  private settleFailure(
    actionId: string,
    threadId: string,
    taskId: string,
    error: unknown,
    offeredRefs: string[],
    model: string | null,
    effort: string | null,
  ): JevEvaluationOutcome {
    const reason = error instanceof Error ? error.message : String(error);
    const failureKind = classifySampleFailure(error);
    this.store.finishActionExecution(actionId, "failed", { reason, ...(failureKind !== null ? { failureKind } : {}) });
    if (failureKind === null) {
      // app-server 应用层拒绝（busy/turn 失配等）是环境状态：如实回落，不算失败
      return this.outcomeForEnvironment(threadId, taskId, reason);
    }
    this.store.addProposal({
      threadId,
      taskId,
      evidenceFingerprint: this.store.threadEvidenceFingerprint(threadId),
      payload: { ok: false, error: { kind: failureKind, message: reason }, model, effort, offeredRefs },
    });
    const state = this.store.recordEvaluationFailure(threadId, reason);
    return { ...this.baseOutcome(threadId, taskId), failed: true, failureKind, reason, state };
  }

  /** 非法输出/越界选项：失败提案 + 断路器 protocol 计数（词汇表「断路器」：非法输出算失败）。 */
  private settleInvalid(
    actionId: string,
    threadId: string,
    taskId: string,
    reason: string,
    offeredRefs: string[],
    model: string | null,
    effort: string | null,
  ): JevEvaluationOutcome {
    this.store.finishActionExecution(actionId, "failed", { reason, failureKind: "protocol" });
    // 两类失败 payload（驱动失败/非法输出）同带 offeredRefs（晨析 2026-10-25：先前只驱动失败带，
    // 有无无测试钉住疑无意漂移）——审计单点可读当时的报价集，人工复评不必重推 prompt
    this.store.addProposal({
      threadId,
      taskId,
      evidenceFingerprint: this.store.threadEvidenceFingerprint(threadId),
      payload: { ok: false, error: { kind: "protocol", message: reason }, model, effort, offeredRefs },
    });
    const state = this.store.recordEvaluationFailure(threadId, reason);
    return { ...this.baseOutcome(threadId, taskId), failed: true, failureKind: "protocol", reason, state };
  }

  /**
   * 合法答案收口（票 #21：评估收口只落提案与 needs_attention 标注）：门判定 → 提案落表
   * （重复指纹+推荐不重复插）→ needs_attention 标注（A16 徽标语义，无论门放行与否都落）→
   * 评估状态按结论落定 → 生成自动执行待办（执行计划在起跑时晚读门快照一次成型，不在此预生成）。
   */
  private settleAnswer(
    actionId: string,
    threadId: string,
    taskId: string,
    task: Task,
    answer: JevAnswer,
    refKinds: Record<string, string>,
    model: string | null,
    effort: string | null,
    trigger: "manual" | "interrupted" | "auto",
  ): { outcome: JevEvaluationOutcome; autoTodo: AutoExecutionTodo | null } {
    const candidate = answer.candidates.find((entry) => entry.action === answer.recommended)!;
    let gate: MarkDoneGateVerdict | null = null;
    if (answer.recommended === "mark_done") {
      const turns = this.store.listThreadTurns(threadId);
      const latest = turns[turns.length - 1] ?? null;
      gate = evaluateMarkDoneGate({
        task: {
          acceptanceMode: task.acceptanceMode,
          automationMode: task.automationMode,
          acceptanceCriteria: task.acceptanceCriteria,
        },
        latestTurnStatus: (latest?.nativeStatus ?? null) as ReaderTurnStatus,
        unresolvedAnomalies: this.store.unresolvedAnomalyCountForThread(threadId),
        risk: candidate.risk,
        evidenceRefKinds: refKinds,
        refs: candidate.evidenceRefs,
      });
    }
    // 指纹取评估之后：本轮 jev.evaluate 动作行自身进终态也是已消费证据（与 S1 同款自差规避）
    this.store.finishActionExecution(actionId, "completed", {
      recommended: answer.recommended,
      confidence: answer.confidence,
      needsAttention: answer.needsAttention,
    });
    const fingerprint = this.store.threadEvidenceFingerprint(threadId);
    // 重复指纹检测走读侧唯一守卫（晨析 2026-10-25）：形变 payload 按未重复处理，不内联 cast
    const duplicate = this.store
      .listProposals({ threadId, status: "pending" })
      .find(
        (p) =>
          p.evidenceFingerprint === fingerprint &&
          isJevProposalPayload(p.payload) &&
          p.payload.answer.recommended === answer.recommended,
      );
    const proposal =
      duplicate ??
      this.store.addProposal({
        threadId,
        taskId,
        evidenceFingerprint: fingerprint,
        payload: {
          ok: true,
          answer,
          model,
          effort,
          refKinds,
          ...(gate !== null ? { gate } : {}),
        },
      });
    const state = this.store.recordEvaluationSettled(threadId, fingerprint, { noOp: answer.recommended === "no_op" });
    // needs_attention 标注在评估收口落（A16 徽标数据面）：评估结论本身就是待关注信号，
    // 无论门快照判定放行与否都落；标注时机在提案落表之后，人工触发评估不落（用户在场）
    if (trigger === "auto" && answer.needsAttention) {
      this.store.addAnnotation({
        taskId: task.id,
        ...(threadId !== null ? { threadId } : {}),
        kind: NEEDS_ATTENTION_KIND,
        body: redactExcerpt(answer.progress, JEV_SUMMARY_SHORT_MAX_CHARS),
      });
    }
    const outcome: JevEvaluationOutcome = {
      ...this.baseOutcome(threadId, taskId),
      decided: true,
      proposed: duplicate === undefined,
      proposalId: proposal.id,
      recommended: answer.recommended,
      gate,
      state,
    };
    // 自动执行的待办在评估收口生成（只带评估结论与分派上下文，不含任何门判定），真正执行
    // 等单飞槽释放后（runEvaluation 的 finally 之外）经门快照晚读 + planAutoExecution 一次成型
    const autoTodo: AutoExecutionTodo | null =
      trigger === "auto"
        ? {
            proposalId: proposal.id,
            threadId,
            task,
            proposal: {
              proposalId: proposal.id,
              action: answer.recommended,
              risk: candidate.risk,
              needsAttention: answer.needsAttention,
              confidence: answer.confidence,
            },
            candidate,
            gate,
          }
        : null;
    return { outcome, autoTodo };
  }

  /** 采样收尾释放写锁；释放失败落审计（与 sample 同款，不留悬锁）。 */
  private async releaseLock(threadId: string, taskId: string | null): Promise<void> {
    try {
      await this.driver.closeThread(threadId);
    } catch (error) {
      this.store.addAnnotation({
        ...(taskId !== null ? { taskId } : {}),
        threadId,
        kind: "thread_close_failed",
        body: `failed to release the writer lock after Jev evaluation: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /**
   * 人工接受提案并执行（proposal.accept）。执行面本体在 ProposalExecutor.acceptProposal
   * （issue #34 / Commit 1 抽出），此处保留服务级 closed 守卫后转发，对外调用面（actions/http）
   * 不经改动。
   */
  async acceptProposal(
    proposalId: string,
    options: { requestId?: string } = {},
  ): Promise<ProposalView> {
    if (this.closed) throw new ConflictError("jev service is shutting down");
    return this.executor.acceptProposal(proposalId, options);
  }

  /** 人工拒绝提案：只落裁决终态（无 Codex 写、无动作行）。 */
  async rejectProposal(proposalId: string, _options: { requestId?: string } = {}): Promise<ProposalView> {
    if (this.closed) throw new ConflictError("jev service is shutting down");
    const proposal = this.store.getProposal(proposalId);
    if (proposal === null) throw new NotFoundError(`proposal not found: ${proposalId}`);
    if (proposal.status !== "pending") throw new ConflictError(`proposal ${proposalId} is already ${proposal.status}`);
    return this.store.decideProposal(proposalId, "rejected", {
      executionResult: { executed: false, authorizedBy: "user", rejected: true },
    });
  }
}
