/**
 * 提案执行面（词汇表「提案执行面」；issue #34 / Commit 1 自 JevService 抽出）：
 * 人工 accept（proposal.accept）与自动放行（JevService.executeAutoProposal 分派）共用同一执行面，
 * 只覆盖确定性动作：continue_thread（唯一出站写路径）、annotate、mark_done（人工确认即 done）、
 * no_op（确认）；propose-only 动作明确拒绝，critical 风险任何路径都不执行。
 * 共享依赖构造注入：store 写面（beginActionExecution/finishActionExecution/decideProposal，
 * 以及执行所需读写原语 getProposal/requireTask/upsertThread/addAnnotation/moveTask/now/listProposals）、
 * driver（continue_thread 的 isLoaded/resumeThread/send）、singleFlight（thread 槽互斥）。
 * 服务级 closed 守卫留在 JevService.acceptProposal 转发处，本类不持服务生命周期。
 */

import type { AutoExecutionPlan } from "./automation.js";
import type { CodexDriver } from "./driver/codex-driver.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { CODEX_HARNESS_ID } from "./harness/ids.js";
import {
  composeContinueMessage,
  isJevProposalPayload,
  JEV_SUMMARY_SHORT_MAX_CHARS,
  type JevAction,
  type JevAnswerCandidate,
} from "./jev-answer.js";
import { THREAD_RESUME_KIND } from "./runs.js";
import { redactExcerpt } from "./redact.js";
import type { SingleFlightRegistry } from "./single-flight.js";
import type { ProposalView, Store } from "./store/index.js";
import {
  CRITICAL_RISK_NEVER_EXECUTED_REASON,
  EXECUTABLE_PROPOSAL_ACTIONS,
  isCriticalRisk,
  type ExecutableProposalAction,
  type Task,
} from "./types.js";

/**
 * 执行面动作守卫：accept 时判定 recommended 是否可执行。单源枚举 EXECUTABLE_PROPOSAL_ACTIONS
 * 在 types.ts（决策面 automation 同源派生，#34）；守卫留执行面，因为入参口径是 Jev 答案动作。
 */
export const isExecutableProposalAction = (action: JevAction): action is ExecutableProposalAction =>
  (EXECUTABLE_PROPOSAL_ACTIONS as readonly string[]).includes(action);

/**
 * 提案执行口径：人工 accept（user 授权，requestId 可选）与自动执行（票 #21「执行计划」的
 * 放行形态，authorizedBy/requestId/confidence 全部来自计划）共用同一执行面。
 */
export type ProposalExecutionOptions =
  | { trigger: "manual"; authorizedBy: "user"; requestId?: string; confidence: number | null }
  | ({ trigger: "auto" } & Extract<AutoExecutionPlan, { execute: true }>);

export interface ProposalExecutorOptions {
  store: Store;
  driver: CodexDriver;
  singleFlight: SingleFlightRegistry;
}

export class ProposalExecutor {
  private readonly store: Store;
  private readonly driver: CodexDriver;
  private readonly singleFlight: ProposalExecutorOptions["singleFlight"];

  constructor(options: ProposalExecutorOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.singleFlight = options.singleFlight;
  }

  /**
   * 人工接受提案并执行（proposal.accept）。执行面只覆盖确定性动作：continue_thread（固定模板，
   * A14 白名单）、annotate、mark_done（人工确认即 done）；no_op（确认）；其余动作是 propose-only，
   * 明确拒绝绝不静默成功。critical 风险任何路径都不执行（词汇表「风险等级」）。
   * 自动执行（trigger=auto）复用同一执行面，仅授权来源与审计不同。
   */
  async acceptProposal(
    proposalId: string,
    options: { requestId?: string } = {},
  ): Promise<ProposalView> {
    const proposal = this.store.getProposal(proposalId);
    if (proposal === null) throw new NotFoundError(`proposal not found: ${proposalId}`);
    if (proposal.status !== "pending") throw new ConflictError(`proposal ${proposalId} is already ${proposal.status}`);
    // payload 是持久化后读出的不可信数据：读侧唯一入口 isJevProposalPayload（写侧契约 parseJevAnswer
    // 的镜像守卫）；失败提案与形变/跨版本写入在此受控拒绝，不内联 cast 静默 undefined
    const payload = proposal.payload;
    // 两类来源同入此分支（ocr 复审 2026-10-25）：ok:false 的失败评估与 ok:true 但形变/跨版本的
    // 损坏 payload——文案区分开，排障读者不把写入损坏误读成一次被记录的失败评估
    if (!isJevProposalPayload(payload)) {
      throw new ConflictError(`proposal ${proposalId} is a failed or malformed Jev answer; there is nothing to execute`);
    }
    const { answer } = payload;
    const recommended = answer.recommended;
    if (!isExecutableProposalAction(recommended)) {
      throw new ValidationError(
        `proposal action ${recommended} is propose-only in this build; only ${EXECUTABLE_PROPOSAL_ACTIONS.join(", ")} execute on acceptance`,
      );
    }
    if (proposal.taskId === null) throw new ConflictError(`proposal ${proposalId} has no task to act on`);
    const task = this.store.requireTask(proposal.taskId);
    // recommended 无匹配候选（跨版本写入方/损坏）时显式受控拒绝，不留给 find(...)! 的
    // TypeError（人工 accept 路径会是 500）
    const candidate = answer.candidates.find((entry) => entry.action === recommended);
    if (candidate === undefined) {
      throw new ConflictError(
        `proposal ${proposalId} payload is inconsistent: recommended action ${recommended} has no matching candidate`,
      );
    }
    // critical 永不执行的共享判定与原因（types.ts 单源）：决策面 automation 同源引用，改风险策略两侧同感
    if (isCriticalRisk(candidate.risk)) {
      throw new ConflictError(`proposal ${proposalId} carries critical risk; ${CRITICAL_RISK_NEVER_EXECUTED_REASON}`);
    }
    const executionOptions: ProposalExecutionOptions = {
      trigger: "manual",
      authorizedBy: "user",
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      confidence: answer.confidence,
    };
    if (recommended === "continue_thread") {
      return this.executeContinueThread(proposal, task, candidate, executionOptions);
    }
    return this.executeLocalProposal(proposal, task, candidate, recommended, executionOptions);
  }

  /** continue_thread 是唯一出站写路径：单飞 + 按需 resume（写锁审计）+ 固定模板发送 + 全程审计。
   * 人工 accept 与自动放行（executeAutoProposal）都经此方法。 */
  async executeContinueThread(
    proposal: ProposalView,
    task: Task,
    candidate: JevAnswerCandidate,
    options: ProposalExecutionOptions,
  ): Promise<ProposalView> {
    const proposalId = proposal.id;
    const threadId = proposal.threadId;
    if (threadId === null) throw new ConflictError(`proposal ${proposalId} has no thread to continue`);
    const action = this.store.beginActionExecution({
      action: "proposal.continue_thread",
      trigger: options.trigger,
      taskId: task.id,
      threadId,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      detail: {
        proposalId,
        risk: candidate.risk,
        confidence: options.confidence,
        authorizedBy: options.authorizedBy,
      },
    });
    // finish 的 detail 是整体替换：授权口径（authorizedBy/risk/confidence）必须并进每个终态 detail
    //（含两个失败终态），动作行单点可读全部审计字段（与 executeLocalProposal 终态同款）
    const authorizationAudit = {
      proposalId,
      risk: candidate.risk,
      confidence: options.confidence,
      authorizedBy: options.authorizedBy,
    };
    if (!this.singleFlight.tryAcquire(threadId, "proposal")) {
      this.store.finishActionExecution(action.id, "failed", { ...authorizationAudit, reason: "single-flight" });
      throw new ConflictError(`thread ${threadId} already has an in-flight write (single-flight)`);
    }
    try {
      const previousAction = this.previousActionOf(threadId);
      const message = composeContinueMessage(
        { title: task.title, acceptanceCriteria: task.acceptanceCriteria },
        previousAction,
      );
      if (!this.driver.isLoaded(threadId)) {
        try {
          await this.driver.resumeThread({ threadId, idempotencyKey: `resume/proposal/${proposalId}` });
        } catch (error) {
          if (error instanceof ConflictError) {
            this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: "held" });
          }
          throw error;
        }
        this.store.addAnnotation({
          taskId: task.id,
          threadId,
          kind: THREAD_RESUME_KIND,
          body: `writer lock taken for proposal ${proposalId} execution (bound thread; may materialize compacted rollups)`,
        });
      }
      const terminal = await this.driver.send({
        threadId,
        message,
        idempotencyKey: `proposal/${proposalId}`,
      });
      // 自驱 turn 即线程活动：让空闲阈值从这次推进重新计时（自驱节奏的下限）
      this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, lastActivityAt: this.store.now() });
      // finish 的 detail 是整体替换：把授权口径并进终态 detail，动作行单点可读全部审计字段
      this.store.finishActionExecution(action.id, "completed", {
        ...authorizationAudit,
        previousAction,
        message,
        turn: terminal,
      });
      return this.store.decideProposal(proposalId, "accepted", {
        executionResult: { executed: true, authorizedBy: options.authorizedBy, previousAction, message, turn: terminal },
      });
    } catch (error) {
      this.store.finishActionExecution(action.id, "failed", {
        ...authorizationAudit,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.singleFlight.release(threadId);
    }
  }

  /** 无 Codex 写路径的执行面：mark_done（列移动）/ annotate（标注）/ no_op（确认）。
   * 人工 accept 都经此方法；自动放行只有 annotate/mark_done 进来——no_op 在分派层
   * （JevService.executeAutoProposal）直接确认返回，靠 automation.plan 行的 acknowledged
   * 留痕且不写终态动作行（写终态动作行会翻转证据指纹、解除 A12 去重）。 */
  executeLocalProposal(
    proposal: ProposalView,
    task: Task,
    candidate: JevAnswerCandidate,
    recommended: Exclude<ExecutableProposalAction, "continue_thread">,
    options: ProposalExecutionOptions,
  ): ProposalView {
    const action = this.store.beginActionExecution({
      action: `proposal.${recommended}`,
      trigger: options.trigger,
      taskId: task.id,
      threadId: proposal.threadId,
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
      detail: {
        proposalId: proposal.id,
        risk: candidate.risk,
        confidence: options.confidence,
        authorizedBy: options.authorizedBy,
      },
    });
    // finish 的 detail 是整体替换：授权口径（authorizedBy/risk/confidence）必须并进每个终态 detail，
    // 动作行单点可读全部审计字段（与 continue_thread 终态同款）
    const authorizationAudit = {
      proposalId: proposal.id,
      risk: candidate.risk,
      confidence: options.confidence,
      authorizedBy: options.authorizedBy,
    };
    try {
      if (recommended === "mark_done") {
        this.store.moveTask(task.id, "done");
        this.store.finishActionExecution(action.id, "completed", { ...authorizationAudit, movedTo: "done" });
        return this.store.decideProposal(proposal.id, "accepted", {
          executionResult: { executed: true, authorizedBy: options.authorizedBy, movedTo: "done" },
        });
      }
      if (recommended === "annotate") {
        const note = this.store.addAnnotation({
          taskId: task.id,
          threadId: proposal.threadId,
          kind: options.trigger === "auto" ? "auto_annotate" : "proposal_annotate",
          body: redactExcerpt(candidate.reasonShort, JEV_SUMMARY_SHORT_MAX_CHARS),
        });
        this.store.finishActionExecution(action.id, "completed", { ...authorizationAudit, annotationId: note.id });
        return this.store.decideProposal(proposal.id, "accepted", {
          executionResult: { executed: true, authorizedBy: options.authorizedBy, annotationId: note.id },
        });
      }
      if (recommended === "no_op") {
        // no_op：人工接受即确认“无需动作”；审计 detail 与自动放行同字段 acknowledged:true
        // （晨析 2026-10-25，此前四名各表）。本分支只有人工路径到达：自动 no_op 不落终态动作行，
        // 其确认留痕在 automation.plan 行（jev.ts executeAutoProposal）。
        this.store.finishActionExecution(action.id, "completed", { ...authorizationAudit, acknowledged: true });
        return this.store.decideProposal(proposal.id, "accepted", {
          executionResult: { executed: false, authorizedBy: options.authorizedBy, reason: "no-op" },
        });
      }
      // 单源枚举穷尽收口（#34）：EXECUTABLE_PROPOSAL_ACTIONS 新增第 5 个动作时本行编译报错，
      // 「决策面与执行面不可能漂移」由 tsc 兜底——而非静默落进 no_op（人工 accept 守卫会放行
      // 新动作，自动分派同样汇入本方法，此处一处收口即覆盖两条路径）。运行期不可达：仅为
      // 满足返回类型，防御性抛错而非静默。
      const exhaustive: never = recommended;
      void exhaustive;
      throw new ValidationError(`unreachable executable action: ${String(exhaustive)}`);
    } catch (error) {
      // store 写失败也必须终结动作行：否则悬挂的 running 行经唯一部分索引卡死该线程全部后续动作。
      // 自动路径的错误由 track() 收口，人工路径如实返回 500——审计行单点可读失败原因
      this.store.finishActionExecution(action.id, "failed", {
        ...authorizationAudit,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** 上一步动作（模板白名单变量）：本线程最近一条已执行提案的动作枚举值；没有则 no_op。
   * 经读侧唯一守卫取 answer：形变/跨版本 payload 按缺省回落，不再内联 cast。 */
  private previousActionOf(threadId: string): JevAction {
    const last = this.store.listProposals({ threadId, status: "accepted", limit: 1 })[0];
    if (last === undefined || !isJevProposalPayload(last.payload)) return "no_op";
    return last.payload.answer.recommended;
  }
}
