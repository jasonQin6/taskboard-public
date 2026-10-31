/**
 * SystemOne 编排层（ADR-0019）：把 provider 判定落到 SystemOneStore 的事务写入，并守住三条硬线——
 * 1) 只有 success/failure/manual_reset 三类转换写库并 touch threads，其余路径零写入零 touch
 *    （visible-POST→SSE 自触发环的结构性断路）；
 * 2) verdict 与 attempt 行绝不进指纹输入（Jev 自重臂陷阱的结构性隔离，指纹只来自 facts）；
 * 3) 不复用 thread_evaluation_state / SingleFlightRegistry：这里是带外只读评估，并发上限、
 *    单飞合并、auth/connection 冷却都在本进程内自持。
 */

import { NotFoundError } from "../errors.js";
import type { Store } from "../store/index.js";
import type { Settings } from "../types.js";
import {
  isEvidenceRefsSubset,
  isNonNegativeInt,
  isSemanticStatus,
  isValidConfidence,
  SYSTEMONE_PROMPT_VERSION,
  SYSTEMONE_QUESTION_VERSION,
  type ProgressVerdict,
  type ProgressVerdictView,
  type SystemOneDegradationCode,
  type SystemOneFailureCode,
  type SystemOneRuntimeView,
} from "./contract.js";
import { systemOneFactsEmpty, fingerprintInputOfJudgeInput, readJudgeInput } from "./facts.js";
import { evidenceFingerprintOf, systemoneCacheKeyOf, systemoneVersionKeyOf } from "./fingerprint.js";
import { SystemOneProviderError } from "./errors.js";
import type { JudgeInput, JudgeResult, SystemOneProvider } from "./provider.js";

/** 工程默认值：常量，不做成 settings。 */
export const SYSTEMONE_EVAL_TIMEOUT_MS = 15_000;
export const SYSTEMONE_BACKOFF_MS = 30_000;
export const SYSTEMONE_BREAKER_THRESHOLD = 3;
export const SYSTEMONE_MAX_CONCURRENCY = 2;
export const SYSTEMONE_PROVIDER_COOLDOWN_MS = 30_000;

const STATUS_LABELS: Readonly<Record<ProgressVerdict["status"], string>> = {
  progressing: "进行中",
  waiting_user: "等待用户",
  blocked: "受阻",
  complete: "已完成",
  needs_attention: "需要关注",
  unknown: "无法判断",
};

/** reasonShort 必须由确定性模板生成：模型自由文本永不入库。 */
const reasonShortOf = (status: ProgressVerdict["status"], input: JudgeInput): string => {
  const turn = input.turns.latest === null ? "无 turn 记录" : `最新 turn #${input.turns.latest.ordinal}`;
  return `${STATUS_LABELS[status]} · ${turn} · ${input.evidence.length} 条证据`;
};

export interface SystemOneOutcome {
  threadId: string;
  called: boolean;
  degradation: SystemOneDegradationCode | null;
  view: ProgressVerdictView | null;
}

export class SystemOneService {
  private readonly store: Store;
  private readonly provider: SystemOneProvider;
  private readonly settings: () => Settings;
  private readonly now: () => number;

  private inUse = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<SystemOneOutcome>>();
  private readonly closeController = new AbortController();
  private cooldownUntil: number | null = null;
  private closing = false;

  constructor(deps: { store: Store; provider: SystemOneProvider; settings: () => Settings; now?: () => number }) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.settings = deps.settings;
    this.now = deps.now ?? Date.now;
  }

  /** 同步预检只拦「确定不用调 provider」的线程；其余在后台评估，响应不等 provider。 */
  visible(threadIds: readonly string[]): {
    visible: number;
    started: number;
    skipped: Array<{ threadId: string; reason: SystemOneDegradationCode }>;
  } {
    const skipped: Array<{ threadId: string; reason: SystemOneDegradationCode }> = [];
    let started = 0;
    const settings = this.settings();
    const availability = this.provider.available(settings);
    const usage = this.store.systemoneUsageToday(this.now());
    const budgetExhausted =
      usage.inputTokens + usage.outputTokens >= settings.systemoneDailyTokenBudget;
    for (const threadId of threadIds) {
      const view = this.view(threadId);
      // 未知线程无可判断对象（action 层把 view=null 的 refresh 映射为 404）
      const reason: SystemOneDegradationCode | null =
        view === null
          ? "no_evidence"
          : !settings.systemoneEnabled
            ? "disabled"
            : this.closing || !availability.ok || this.cooldownActive()
              ? "provider_unavailable"
              : budgetExhausted
                ? "budget_exhausted"
                : null;
      if (reason !== null) {
        skipped.push({ threadId, reason });
        continue;
      }
      started += 1;
      void this.evaluate(threadId).catch(() => undefined);
    }
    return { visible: threadIds.length, started, skipped };
  }

  async evaluate(threadId: string, options?: { force?: boolean }): Promise<SystemOneOutcome> {
    const force = options?.force === true;
    const view = this.view(threadId);
    if (view === null) return { threadId, called: false, degradation: "no_evidence", view: null };
    const settings = this.settings();
    if (!settings.systemoneEnabled) return { threadId, called: false, degradation: "disabled", view };
    if (this.closing || !this.provider.available(settings).ok || this.cooldownActive()) {
      return { threadId, called: false, degradation: "provider_unavailable", view };
    }
    const input = readJudgeInput(this.store, threadId)!;
    if (systemOneFactsEmpty(input)) return { threadId, called: false, degradation: "no_evidence", view };
    const model = this.provider.resolveModel();
    const fingerprint = evidenceFingerprintOf(fingerprintInputOfJudgeInput(input));
    const cacheKey = systemoneCacheKeyOf({
      fingerprint,
      provider: this.provider.id,
      model,
      promptVersion: SYSTEMONE_PROMPT_VERSION,
      questionVersion: SYSTEMONE_QUESTION_VERSION,
    });
    // 顺序有讲究：cache → breaker → backoff；force 只绕 cache 与 backoff，断路器始终生效
    if (!force) {
      const hit = this.store.systemoneCacheHit({ threadId, cacheKey });
      if (hit !== null) return { threadId, called: false, degradation: null, view: hit };
    }
    const state = this.store.systemoneState(threadId);
    if (state?.breaker_open === 1) return { threadId, called: false, degradation: "breaker_open", view };
    if (!force && state?.last_degradation_at !== null && state?.last_degradation_at !== undefined) {
      if (state.last_degradation_at + SYSTEMONE_BACKOFF_MS > this.now()) {
        return { threadId, called: false, degradation: "backoff", view };
      }
    }
    const pending = this.inFlight.get(threadId);
    if (pending !== undefined) return pending;
    const execution = this.runEvaluation(threadId, input, { fingerprint, cacheKey, model });
    this.inFlight.set(threadId, execution);
    try {
      return await execution;
    } finally {
      if (this.inFlight.get(threadId) === execution) this.inFlight.delete(threadId);
    }
  }

  refresh(threadId: string): Promise<SystemOneOutcome> {
    return this.evaluate(threadId, { force: true });
  }

  resume(threadId: string): ProgressVerdictView {
    const view = this.store.systemoneView(threadId);
    if (view === null) throw new NotFoundError(`thread not found: ${threadId}`);
    const model = this.provider.resolveModel();
    return this.store.systemoneResumeBreaker({
      threadId,
      versionKey: this.currentVersionKey(model),
      provider: this.provider.id,
      model,
    });
  }

  view(threadId: string): ProgressVerdictView | null {
    return this.store.systemoneView(threadId, this.currentVersionKey());
  }

  views(): ProgressVerdictView[] {
    return this.store.systemoneViews(undefined, this.currentVersionKey());
  }

  runtime(): SystemOneRuntimeView {
    const settings = this.settings();
    const usage = this.store.systemoneUsageToday(this.now());
    const usedTokens = usage.inputTokens + usage.outputTokens;
    const limitTokens = settings.systemoneDailyTokenBudget;
    const availability = this.provider.available(settings);
    return {
      enabled: settings.systemoneEnabled,
      provider: this.provider.id,
      model: this.provider.resolveModel(),
      promptVersion: SYSTEMONE_PROMPT_VERSION,
      questionVersion: SYSTEMONE_QUESTION_VERSION,
      available: !this.closing && availability.ok && !this.cooldownActive(),
      unavailableReason:
        this.closing
          ? "closing"
          : !settings.systemoneEnabled
            ? "disabled"
            : !availability.ok
              ? availability.reason
              : this.cooldownActive()
                ? "provider cooldown after an auth or connection failure"
                : null,
      externalData: [
        "会话 id（harness/native_session_id）、标题、原生状态与 workspace",
        "最近 20 个 turn 的 ordinal、原生状态与窗口内计数（附总数）",
        "source cursor",
        "最近 20 条证据的 id、kind、turn 序号与脱敏摘要",
        "原生摘要文本",
        "主绑定任务 id/标题、标签与人工注记（脱敏截断）",
      ],
      budget: {
        day: usage.day,
        usedTokens,
        limitTokens,
        exhausted: usedTokens >= limitTokens,
      },
      concurrency: { limit: SYSTEMONE_MAX_CONCURRENCY, inFlight: this.inFlight.size },
      breaker: { threshold: SYSTEMONE_BREAKER_THRESHOLD, backoffMs: SYSTEMONE_BACKOFF_MS },
    };
  }

  /** 关闭：置旗、abort 在飞 judge、等全部在飞收敛；收敛路径看到 closing 不再写库。 */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.closeController.abort();
    const pending = [...this.inFlight.values()];
    await Promise.allSettled(pending);
  }

  private cooldownActive(): boolean {
    return this.cooldownUntil !== null && this.now() < this.cooldownUntil;
  }

  private currentVersionKey(model: string = this.provider.resolveModel()): string {
    return systemoneVersionKeyOf({
      provider: this.provider.id,
      model,
      promptVersion: SYSTEMONE_PROMPT_VERSION,
      questionVersion: SYSTEMONE_QUESTION_VERSION,
    });
  }

  private async acquireSlot(): Promise<() => void> {
    if (this.inUse < SYSTEMONE_MAX_CONCURRENCY && this.waiters.length === 0) {
      this.inUse += 1;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.makeRelease();
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inUse -= 1;
      while (this.inUse < SYSTEMONE_MAX_CONCURRENCY && this.waiters.length > 0) {
        this.inUse += 1;
        this.waiters.shift()!();
      }
    };
  }

  private async runEvaluation(
    threadId: string,
    input: JudgeInput,
    keys: { fingerprint: string; cacheKey: string; model: string },
  ): Promise<SystemOneOutcome> {
    const release = await this.acquireSlot();
    try {
      const view = this.store.systemoneView(threadId, this.currentVersionKey(keys.model));
      if (this.closing) return { threadId, called: false, degradation: "provider_unavailable", view };
      // 预检在入队前，排队期间用户可能关掉 SystemOne，或另一线程已触发 auth/connection 冷却；
      // 拿到槽位后必须重检，否则整批排队调用会绕过禁用与冷却。
      const settings = this.settings();
      if (!settings.systemoneEnabled) return { threadId, called: false, degradation: "disabled", view };
      if (!this.provider.available(settings).ok || this.cooldownActive()) {
        return { threadId, called: false, degradation: "provider_unavailable", view };
      }
      const usage = this.store.systemoneUsageToday(this.now());
      const usedTokens = usage.inputTokens + usage.outputTokens;
      if (usedTokens >= settings.systemoneDailyTokenBudget) {
        return { threadId, called: false, degradation: "budget_exhausted", view };
      }
      const startedAt = this.now();
      const signal = AbortSignal.any([this.closeController.signal, AbortSignal.timeout(SYSTEMONE_EVAL_TIMEOUT_MS)]);
      let result: JudgeResult;
      try {
        result = await this.provider.judge(input, signal);
        // 防线收敛：provider 已校验输出；fake provider 绕过 wire 时这里仍是契约边界
        if (
          !isSemanticStatus(result.status) ||
          !isValidConfidence(result.confidence) ||
          !isEvidenceRefsSubset(result.evidenceRefs, input.allowedEvidenceIds) ||
          (result.usage !== null &&
            (!isNonNegativeInt(result.usage.inputTokens) || !isNonNegativeInt(result.usage.outputTokens)))
        ) {
          throw new SystemOneProviderError("invalid_output", "judge result violated the contract");
        }
      } catch (error) {
        const code: SystemOneFailureCode =
          error instanceof SystemOneProviderError ? error.code : "invalid_output";
        if (code === "auth" || code === "connection") {
          this.cooldownUntil = this.now() + SYSTEMONE_PROVIDER_COOLDOWN_MS;
        }
        if (!this.closing) {
          const failureView = this.store.systemoneRecordFailure({
            threadId,
            cacheKey: keys.cacheKey,
            fingerprint: keys.fingerprint,
            versionKey: this.currentVersionKey(keys.model),
            provider: this.provider.id,
            model: keys.model,
            outcome: code,
            failureMessage: error instanceof Error ? error.message : String(error),
            latencyMs: this.now() - startedAt,
          });
          return { threadId, called: true, degradation: code, view: failureView };
        }
        return { threadId, called: true, degradation: code, view };
      }
      // close 后判成也不落库：结果随关闭丢弃
      if (this.closing) {
        return { threadId, called: true, degradation: "provider_unavailable", view };
      }
      const verdict: ProgressVerdict = {
        status: result.status,
        confidence: result.confidence,
        reasonShort: reasonShortOf(result.status, input),
        evidenceRefs: [...result.evidenceRefs],
        coversThrough: input.cursor,
        provenance: `systemone:${this.provider.id}/${keys.model}@${SYSTEMONE_PROMPT_VERSION}`,
        assessedAt: new Date(this.now()).toISOString(),
      };
      const successView = this.store.systemoneRecordSuccess({
        threadId,
        cacheKey: keys.cacheKey,
        fingerprint: keys.fingerprint,
        versionKey: this.currentVersionKey(keys.model),
        provider: this.provider.id,
        model: keys.model,
        verdict,
        latencyMs: this.now() - startedAt,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      });
      return { threadId, called: true, degradation: null, view: successView };
    } finally {
      release();
    }
  }
}
