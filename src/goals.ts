/**
 * GoalService：Codex 原生 goal 与 thread/sample 的执行面。两者都是 Action Execution，不产生 Run
 * （词汇表「动作执行」）；写操作经单飞（进程内 registry + action_executions 唯一索引兜底），
 * 与 send 共享同一线程槽。goal 只在用户显式启用（task.goal.enabled）时设置，Jev 不得自行升级；
 * goal 状态只作证据缓存，不直接决定 Task done。sample 是「扫描只读」的唯一写邻接例外
 * （ADR-0003）：仅对已绑定 Task 的线程试探性 resume（落审计）→ 校验 expected turn →
 * ephemeral 采样（不写原 rollout）→ close 释放锁；能力缺失/写锁 Conflict/turn 失配一律
 * 回落 compacted 基线并如实记录。daemon 关闭顺序见 ADR-0014：in-flight 动作在 runs/driver close 前收敛。
 */

import type { CodexDriver } from "./driver/codex-driver.js";
import {
  CapabilityUnavailableError,
  DriverDisconnectedError,
  DriverProtocolError,
  DriverTimeoutError,
} from "./driver/errors.js";
import { SAMPLE_PROMPT } from "./driver/protocol.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { CODEX_HARNESS_ID } from "./harness/ids.js";
import { COMPACTED_SUMMARY_CHARS } from "./reader/parse.js";
import { redactExcerpt } from "./redact.js";
import { THREAD_RESUME_KIND } from "./runs.js";
import type { SingleFlightRegistry } from "./single-flight.js";
import type { Store } from "./store/index.js";
import type { Task } from "./types.js";

/** HTTP 动作层的 goal 操作（driver 级另有 enable，供协议完整性；动作层 set 即启用语义）。 */
export const GOAL_ACTION_OPS = ["set", "get", "status", "pause", "resume", "clear"] as const;
export type GoalActionOp = (typeof GOAL_ACTION_OPS)[number];

export interface GoalActionResult {
  taskId: string;
  threadId: string;
  op: GoalActionOp;
  /** Codex 原生 goal 状态词（active/paused/complete/budget_limited…）；null = 无 goal。 */
  goalStatus: string | null;
  /** goal.get 时的 goal 文本；其他操作为 null。 */
  text: string | null;
}

export type SampleResult =
  | { threadId: string; provenance: "sample"; text: string; held: false; reason: null }
  | {
      threadId: string;
      provenance: "compacted" | "none";
      text: string | null;
      held: boolean;
      reason: string;
      /** 驱动级失败分类（超时/断连/协议非法输出）：断路器的计数依据；如实回落（held/能力缺失）不带此字段。 */
      failureKind?: SampleFailureKind;
    };

/**
 * sample/Jev 的断路器失败分类（词汇表「断路器」）：超时、连接错误、协议非法输出。
 * app-server 的应用层拒绝（线程忙、expected turn 失配等）是环境状态，不算失败、走如实回落。
 */
export type SampleFailureKind = "timeout" | "disconnected" | "protocol";

export const classifySampleFailure = (error: unknown): SampleFailureKind | null => {
  if (error instanceof DriverTimeoutError) return "timeout";
  if (error instanceof DriverDisconnectedError) return "disconnected";
  if (error instanceof DriverProtocolError) return "protocol";
  return null;
};

export interface GoalServiceOptions {
  store: Store;
  driver: CodexDriver;
  singleFlight: SingleFlightRegistry;
  /** 防休眠接线：goal 续跑窗口（无 Run 的线程活动）计入平台保护。 */
  power: { setGoalContinuation: (threadId: string, active: boolean) => void };
}

/** goal 文本来自 Task 的目标与验收描述（需求「Native goal」），不接受自由文本。 */
export const composeGoalText = (task: Task): string => {
  const parts = [task.prompt.trim().length > 0 ? task.prompt.trim() : task.title];
  const acceptance = task.acceptanceCriteria.trim();
  if (acceptance.length > 0) parts.push(`Acceptance criteria:\n${acceptance}`);
  return parts.join("\n\n");
};

export class GoalService {
  private readonly store: Store;
  private readonly driver: CodexDriver;
  private readonly singleFlight: SingleFlightRegistry;
  private readonly power: GoalServiceOptions["power"];
  private readonly executions = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: GoalServiceOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.singleFlight = options.singleFlight;
    this.power = options.power;
  }

  /** daemon 关闭前在飞 goal/sample 动作收敛（关闭顺序：runs/driver 之前）。 */
  pendingCount(): number {
    return this.executions.size;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.executions]);
  }

  executeGoalOp(op: GoalActionOp, taskId: string, options: { requestId?: string } = {}): Promise<GoalActionResult> {
    const execution = (async () => this.runGoalOp(op, taskId, options))();
    return this.track(execution);
  }

  sampleThread(threadId: string, options: { requestId?: string } = {}): Promise<SampleResult> {
    const execution = (async () => this.runSample(threadId, options))();
    return this.track(execution);
  }

  /** 在飞登记：close() 等全部落定；rejection 仍由返回的 promise 交给调用方。 */
  private track<T>(execution: Promise<T>): Promise<T> {
    this.executions.add(execution);
    void execution
      .catch(() => undefined)
      .finally(() => {
        this.executions.delete(execution);
      });
    return execution;
  }

  private async runGoalOp(op: GoalActionOp, taskId: string, options: { requestId?: string }): Promise<GoalActionResult> {
    if (this.closed) throw new ConflictError("goal service is shutting down");
    const task = this.store.requireTask(taskId);
    const thread = this.store.primaryThreadOf(taskId);
    if (thread === null) {
      throw new ValidationError(`task ${taskId} has no primary thread bound; goal operations need a bound thread`);
    }
    // 用户授权门：只有任务被用户显式配置为 goal 模式才允许设置（Jev 不得自行升级，用户故事 61/64）
    if (op === "set" && !task.goal.enabled) {
      throw new ValidationError(
        `task ${taskId} has not enabled goal execution mode; a user must enable it first (task.update goal=true)`,
      );
    }
    const action = this.store.beginActionExecution({
      action: `goal.${op}`,
      trigger: "manual",
      taskId: task.id,
      threadId: thread.id,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    if (!this.singleFlight.tryAcquire(thread.id, "goal")) {
      this.store.finishActionExecution(action.id, "failed", { reason: "single-flight" });
      throw new ConflictError(`thread ${thread.id} already has an in-flight write (single-flight)`);
    }
    let resumedHere = false;
    try {
      resumedHere = await this.ensureThreadLoaded(task.id, thread.id, `goal ${op}`);
      const view = await this.driver.goalOp({
        op,
        threadId: thread.id,
        ...(op === "set"
          ? {
              text: composeGoalText(task),
              ...(task.goal.budgetTokens !== null ? { budgetTokens: task.goal.budgetTokens } : {}),
            }
          : {}),
        idempotencyKey: `goal/${action.id}`,
      });
      if (view.status === null) {
        this.store.upsertThread({ id: thread.id, harnessId: CODEX_HARNESS_ID, clearGoalStatus: true });
      } else {
        this.store.upsertThread({ id: thread.id, harnessId: CODEX_HARNESS_ID, goalStatus: view.status });
      }
      this.wireContinuation(op, thread.id);
      this.store.finishActionExecution(action.id, "completed", { goalStatus: view.status });
      // 读操作不开续跑窗口：本次 resume 接管的写锁用完即还，不长期占用其他写路径
      if (resumedHere && (op === "get" || op === "status" || op === "pause" || op === "clear")) {
        await this.releaseLock(thread.id, task.id);
      }
      return { taskId: task.id, threadId: thread.id, op, goalStatus: view.status, text: view.text };
    } catch (error) {
      this.store.finishActionExecution(action.id, "failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.singleFlight.release(thread.id);
    }
  }

  private async runSample(threadId: string, options: { requestId?: string } = {}): Promise<SampleResult> {
    if (this.closed) throw new ConflictError("goal service is shutting down");
    const thread = this.store.getThread(threadId);
    if (thread === null) throw new NotFoundError(`thread not found: ${threadId}`);
    const action = this.store.beginActionExecution({
      action: "thread.sample",
      trigger: "manual",
      threadId,
      ...(thread.primaryTaskId !== null ? { taskId: thread.primaryTaskId } : {}),
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    // 与 send/goal 共享单飞槽（A11）：拿不到就明确拒绝；动作行按失败落账
    if (!this.singleFlight.tryAcquire(threadId, "sample")) {
      this.store.finishActionExecution(action.id, "failed", { reason: "single-flight" });
      throw new ConflictError(`thread ${threadId} already has an in-flight write (single-flight)`);
    }
    try {
      // Inbox（无 primary 绑定）线程永不 resume——先于一切驱动行为检查（ADR-0003）
      if (thread.primaryTaskId === null) {
        return this.completeBaseline(
          action.id,
          threadId,
          "thread is not bound to a task; inbox threads are never resumed",
          false,
        );
      }
      const client = await this.driver.ensureStarted();
      try {
        client.requireCapability("thread/sample");
      } catch (error) {
        if (error instanceof CapabilityUnavailableError) {
          return this.completeBaseline(action.id, threadId, "thread/sample is not available on this app-server", false);
        }
        throw error;
      }
      const expected = this.store.latestCompletedTurn(threadId);
      if (expected === null) {
        return this.completeBaseline(
          action.id,
          threadId,
          "no completed turn is known to the reader; expected_turn_id cannot be validated",
          false,
        );
      }
      const needResume = !this.driver.isLoaded(threadId);
      if (needResume) {
        // 采样后必须能释放写锁：close 能力缺失就不接管（避免把锁握到 app-server 退出）
        try {
          client.requireCapability("thread/close");
        } catch (error) {
          if (error instanceof CapabilityUnavailableError) {
            return this.completeBaseline(
              action.id,
              threadId,
              "thread/close is not available on this app-server; the writer lock could not be released after sampling",
              false,
            );
          }
          throw error;
        }
        try {
          await this.driver.resumeThread({ threadId, idempotencyKey: `resume/sample/${threadId}` });
        } catch (error) {
          if (error instanceof ConflictError) {
            this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: "held" });
            return this.completeBaseline(
              action.id,
              threadId,
              "thread is held by another process (writer lock conflict)",
              true,
            );
          }
          throw error;
        }
        // 写邻接审计：resume 接管写锁且可能 materialize .jsonl.zst（ADR-0003 唯一例外）
        this.store.addAnnotation({
          taskId: thread.primaryTaskId,
          threadId,
          kind: THREAD_RESUME_KIND,
          body: `writer lock taken for thread sample (bound thread; may materialize compacted rollups)`,
        });
      }
      let sampled: string;
      try {
        sampled = await this.driver.sample({ threadId, expectedTurnId: expected.id, prompt: SAMPLE_PROMPT });
      } catch (error) {
        if (needResume) await this.releaseLock(threadId, thread.primaryTaskId);
        const failureKind = classifySampleFailure(error) ?? undefined;
        return this.completeBaseline(
          action.id,
          threadId,
          error instanceof Error ? error.message : String(error),
          false,
          failureKind,
        );
      }
      // 出站标准 = 入站标准：sample 文本与 compacted 摘要同截断、同脱敏
      const text = redactExcerpt(sampled, COMPACTED_SUMMARY_CHARS);
      try {
        this.store.addThreadSummary({ threadId, provenance: "sample", text });
        this.store.finishActionExecution(action.id, "completed", { provenance: "sample", expectedTurnId: expected.id });
      } finally {
        // 采样成功后的落库无论成败都必须释放写锁：锁泄漏期间单飞已放行，其他写路径会误判线程空闲
        if (needResume) await this.releaseLock(threadId, thread.primaryTaskId);
      }
      return { threadId, provenance: "sample", text, held: false, reason: null };
    } catch (error) {
      // resume/ensure-start 等在收口前抛出的驱动级失败：终结动作行再上抛（与 runGoalOp 同款）。
      // 悬挂的 running 行经唯一部分索引卡死该线程全部后续动作，直到 daemon 重启对账
      const failureKind = classifySampleFailure(error);
      this.store.finishActionExecution(action.id, "failed", {
        reason: error instanceof Error ? error.message : String(error),
        ...(failureKind !== null ? { failureKind } : {}),
      });
      throw error;
    } finally {
      this.singleFlight.release(threadId);
    }
  }

  /** 回落路径统一收口：动作行记 completed+fallback；基线 = 最近 compacted 摘要，没有就如实 none（A10）。 */
  private completeBaseline(
    actionId: string,
    threadId: string,
    reason: string,
    held: boolean,
    failureKind?: SampleFailureKind,
  ): SampleResult {
    this.store.finishActionExecution(actionId, "completed", {
      fallback: "compacted",
      reason,
      ...(held ? { held } : {}),
    });
    const latest = this.store.latestThreadSummary(threadId);
    if (latest !== null && latest.provenance === "compacted") {
      return {
        threadId,
        provenance: "compacted",
        text: latest.text,
        held,
        reason,
        ...(failureKind !== undefined ? { failureKind } : {}),
      };
    }
    return { threadId, provenance: "none", text: null, held, reason, ...(failureKind !== undefined ? { failureKind } : {}) };
  }

  private async releaseLock(threadId: string, taskId: string | null): Promise<void> {
    try {
      await this.driver.closeThread(threadId);
    } catch (error) {
      this.store.addAnnotation({
        ...(taskId !== null ? { taskId } : {}),
        threadId,
        kind: "thread_close_failed",
        body: `failed to release the writer lock after sampling: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  /** goal 续跑窗口：set/resume 开窗、pause/clear 关窗（防休眠接线；进程内状态不跨重启）。 */
  private wireContinuation(op: GoalActionOp, threadId: string): void {
    if (this.closed) return;
    if (op === "set" || op === "resume") this.power.setGoalContinuation(threadId, true);
    if (op === "pause" || op === "clear") this.power.setGoalContinuation(threadId, false);
  }

  /** goal 写操作需要线程加载在本实例：未加载则试探性 resume（审计落库；Conflict → held）。返回本次是否发生了 resume。 */
  private async ensureThreadLoaded(taskId: string, threadId: string, purpose: string): Promise<boolean> {
    if (this.driver.isLoaded(threadId)) return false;
    try {
      await this.driver.resumeThread({ threadId, idempotencyKey: `resume/goal/${threadId}` });
    } catch (error) {
      if (error instanceof ConflictError) {
        this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: "held" });
      }
      throw error;
    }
    this.store.addAnnotation({
      taskId,
      threadId,
      kind: THREAD_RESUME_KIND,
      body: `writer lock taken for ${purpose} (bound thread; may materialize compacted rollups)`,
    });
    return true;
  }
}
