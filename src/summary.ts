/**
 * SummaryService：摘要两层结构（compacted 基线 + sample 增强）的评估数据面与断路器（issue #10/S1）。
 * 不含 Jev 判断与提案（#15/S2）——本服务消费证据的方式是驱动 #8 的 sample 路径
 * （GoalService.sampleThread：resume→校验 expected turn→ephemeral 采样→close，写锁 Conflict /
 * 能力缺失一律如实回落基线）。评估纪律（词汇表「no-op 指纹」）：指纹未变且上次结论 no_op 就不重复
 * 触发 sample；新 completed turn、thread interrupted、上一次动作进入终态改变指纹，人工刷新用
 * force 绕过去重。断路器（词汇表「断路器」）：驱动级失败（超时/断连/协议非法输出）连续 3 次熔断
 * 该线程评估并落审计，人工 resume 恢复；如实回落（held/能力缺失/Inbox）不是失败。
 */

import { ConflictError, NotFoundError } from "./errors.js";
import { classifySampleFailure, type GoalService, type SampleFailureKind } from "./goals.js";
import type { Store, ThreadEvaluationStateView } from "./store/index.js";

export interface EvaluationOutcome {
  threadId: string;
  /** false = 去重命中未触发 sample（skipReason 说明）；true = 本轮真的跑了一次评估。 */
  performed: boolean;
  skipReason: "no_new_evidence" | null;
  /** 本轮 sample 成功并落了 provenance=sample 的新摘要。 */
  sampled: boolean;
  /** 本轮发生驱动级失败（已计入断路器连败）。 */
  failed: boolean;
  failureKind: SampleFailureKind | null;
  /** 本轮结束时该线程摘要的 provenance（sample 成功=sample；回落=最近基线或 none）。 */
  provenance: "sample" | "compacted" | "none";
  held: boolean;
  reason: string | null;
  state: ThreadEvaluationStateView;
}

export interface SummaryServiceOptions {
  store: Store;
  goals: GoalService;
}

export class SummaryService {
  private readonly store: Store;
  private readonly goals: GoalService;

  constructor(options: SummaryServiceOptions) {
    this.store = options.store;
    this.goals = options.goals;
  }

  /**
   * 对一个线程跑一轮评估数据面：去重检查 → sample（两层摘要的增强层，失败如实回落基线层）→
   * 记录评估状态（指纹、结论、连败/断路器）。force=人工强制刷新，跳过去重但不跳过断路器。
   */
  async evaluateThread(
    threadId: string,
    options: { force?: boolean; requestId?: string } = {},
  ): Promise<EvaluationOutcome> {
    const thread = this.store.getThread(threadId);
    if (thread === null) throw new NotFoundError(`thread not found: ${threadId}`);
    const state = this.store.getEvaluationState(threadId);
    if (state?.breakerOpen === true) {
      // 断路器是保险丝：force 也不能绕过，恢复只走人工 resume（词汇表「断路器」：不自动恢复）
      throw new ConflictError(
        `evaluation breaker is open for thread ${threadId}; auto evaluation is paused until manual resume`,
      );
    }
    const fingerprintBefore = this.store.threadEvidenceFingerprint(threadId);
    if (options.force !== true && state !== null && state.lastNoOp && state.evidenceFingerprint === fingerprintBefore) {
      return {
        threadId,
        performed: false,
        skipReason: "no_new_evidence",
        sampled: false,
        failed: false,
        failureKind: null,
        provenance: this.store.latestThreadSummary(threadId)?.provenance ?? "none",
        held: thread.nativeStatus === "held",
        reason: null,
        state,
      };
    }
    let sample: Awaited<ReturnType<GoalService["sampleThread"]>>;
    try {
      sample = await this.goals.sampleThread(
        threadId,
        options.requestId !== undefined ? { requestId: options.requestId } : {},
      );
    } catch (error) {
      // resume/ensure-start 等在 GoalService 外抛的失败：驱动级（超时/断连/协议）计入连败并
      // 以 failed=true 的结果返回（HTTP 200）；其余错误（单飞冲突等）原样上抛
      const failureKind = classifySampleFailure(error);
      if (failureKind === null) throw error;
      const nextState = this.store.recordEvaluationFailure(threadId, error instanceof Error ? error.message : String(error));
      return {
        threadId,
        performed: true,
        skipReason: null,
        sampled: false,
        failed: true,
        failureKind,
        provenance: this.store.latestThreadSummary(threadId)?.provenance ?? "none",
        held: thread.nativeStatus === "held",
        reason: error instanceof Error ? error.message : String(error),
        state: nextState,
      };
    }
    // 落定指纹取评估之后：本轮 sample 自己的动作终态（thread.sample 进出）也是已消费证据，
    // 否则下轮评估会因指纹自差而永远无法命中去重
    const fingerprintAfter = this.store.threadEvidenceFingerprint(threadId);
    if (sample.provenance === "sample") {
      const nextState = this.store.recordEvaluationSettled(threadId, fingerprintAfter);
      return {
        threadId,
        performed: true,
        skipReason: null,
        sampled: true,
        failed: false,
        failureKind: null,
        provenance: "sample",
        held: false,
        reason: null,
        state: nextState,
      };
    }
    if (sample.failureKind !== undefined) {
      const nextState = this.store.recordEvaluationFailure(threadId, sample.reason);
      return {
        threadId,
        performed: true,
        skipReason: null,
        sampled: false,
        failed: true,
        failureKind: sample.failureKind,
        provenance: sample.provenance,
        held: sample.held,
        reason: sample.reason,
        state: nextState,
      };
    }
    // 如实回落（held/能力缺失/无已完成 turn/Inbox）：不是失败，但同样消费本轮评估机会，
    // 结论 no_op——持有中的线程不会在被释放前被反复锤击，新证据到来时自然再评估
    const nextState = this.store.recordEvaluationSettled(threadId, fingerprintAfter);
    return {
      threadId,
      performed: true,
      skipReason: null,
      sampled: false,
      failed: false,
      failureKind: null,
      provenance: sample.provenance,
      held: sample.held,
      reason: sample.reason,
      state: nextState,
    };
  }

  /** 人工 resume：清断路器与连败（Store 同事务落恢复审计），返回恢复后的评估状态。 */
  async resumeBreaker(threadId: string, options: { requestId?: string } = {}): Promise<ThreadEvaluationStateView> {
    if (this.store.getThread(threadId) === null) throw new NotFoundError(`thread not found: ${threadId}`);
    return this.store.resetEvaluationBreaker(
      threadId,
      options.requestId !== undefined ? { requestId: options.requestId } : {},
    );
  }
}
