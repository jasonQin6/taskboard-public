/**
 * RunManager：Run 生命周期的进程内驱动。手动/cron/cascade 走同一条 createRunForTask 创建路径；
 * 全局并发上限（settings.concurrencyLimit）内起跑、超限 queued；终局只认 event_msg 原生 turn 终态
 * （task_complete 成功、turn_aborted=interrupted→cancelled、error→failed）。
 * 级联是进程内状态，不跨重启恢复（重启对账收敛半截 Run，链条本身丢弃）。
 * 单飞：send 从发出到该 turn 终态持有线程槽；本 Run 取消自己的 turn 不经槽竞争。
 */

import type { CodexDriver } from "./driver/codex-driver.js";
import { terminalOfEventMsg, type TurnTerminal } from "./driver/protocol.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { CODEX_HARNESS_ID } from "./harness/ids.js";
import type { SingleFlightRegistry, InFlightKind } from "./single-flight.js";
import type { Store } from "./store/index.js";
import type { FireOutcome } from "./cron-ticker.js";
import type { WorktreeManager } from "./worktree.js";
import { ACTIVE_RUN_STATUSES, type Run, type RunStatus, type RunTrigger, type Task } from "./types.js";

/** 自驱 turn 因需审批停下的审计与徽标来源（A16）。 */
export const APPROVAL_STOP_KIND = "approval_stop";
/** 接管已绑定线程写锁的审计（resume 是扫描只读的唯一写邻接例外）。 */
export const THREAD_RESUME_KIND = "thread_resume";
/** isolated worktree 准备失败的审计（Run 失败证据，故事 71/73）。 */
export const WORKTREE_PREPARE_FAILED_KIND = "worktree_prepare_failed";
/** worktree 清理后重跑换绑新线程的审计（旧 primary 解绑是控制权转移，必须留痕）。 */
export const WORKTREE_SWITCHED_KIND = "worktree_switched";

const nativeStatusOf = (kind: TurnTerminal["kind"]): "completed" | "interrupted" | "failed" =>
  kind === "completed" ? "completed" : kind === "interrupted" ? "interrupted" : "failed";

export interface RunManagerOptions {
  store: Store;
  driver: CodexDriver;
  singleFlight: SingleFlightRegistry;
  /** isolated_worktree 模式的目录准备面；缺省时该模式明确失败（裸装配/测试可省）。 */
  worktrees?: WorktreeManager;
  now?: () => number;
}

export class RunManager {
  private readonly store: Store;
  private readonly driver: CodexDriver;
  private readonly singleFlight: SingleFlightRegistry;
  private readonly worktrees: WorktreeManager | undefined;
  private readonly executions = new Map<string, Promise<void>>();
  private readonly cascadeChains = new Set<Promise<void>>();
  private readonly terminalWaiters = new Map<string, Array<(status: RunStatus) => void>>();
  private pumping = false;
  private pumpAgain = false;
  private closed = false;

  constructor(options: RunManagerOptions) {
    this.store = options.store;
    this.driver = options.driver;
    this.singleFlight = options.singleFlight;
    this.worktrees = options.worktrees;
    options.driver.onEventMsg((threadId, type, msg) => {
      // 自有线程的进行中事实：task_started → 原生 running（第一方观察）
      if (type === "task_started") {
        this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
        return;
      }
      // 无 Run 的原生 turn 终态（goal 续跑等）也要落线程原生状态：wait 的 goal 模式语义靠它收敛
      const terminal = terminalOfEventMsg(type, msg);
      if (terminal !== null) this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: nativeStatusOf(terminal.kind) });
    });
  }

  /** 唯一 Run 创建路径（manual/cron/cascade 共用）。校验失败抛领域错误。 */
  createRunForTask(taskId: string, trigger: RunTrigger): Run {
    if (this.closed) throw new ConflictError("run manager is shutting down");
    const run = this.store.createRun(taskId, trigger);
    this.pump();
    return run;
  }

  /** cron 到点的入口：与手动同一条创建路径；失败转成跳过原因（CronTicker 落审计）。 */
  cronFire(task: Task): FireOutcome {
    try {
      const run = this.createRunForTask(task.id, "cron");
      return { fired: true, runId: run.id };
    } catch (error) {
      return { fired: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 取消任务当前活跃 Run：先落终态（任务回 todo），再尽力打断自己持有的线程。 */
  async cancelRun(taskId: string): Promise<Run> {
    const active = this.store.activeRunOf(taskId);
    if (active === null) throw new NotFoundError(`task ${taskId} has no active run`);
    const finished = this.store.finishRun(active.id, "cancelled", { failureReason: "cancelled by user" });
    this.resolveWaiters(active.id, "cancelled");
    const threadId = finished.threadId;
    if (threadId !== null && this.driver.isLoaded(threadId)) {
      try {
        await this.driver.interrupt(threadId);
      } catch (error) {
        // 打断失败不改变取消事实：thread 留在原地，任务回 todo（A19 的外部活动分支）
        this.store.addAnnotation({
          taskId,
          threadId,
          kind: "cancel_interrupt_failed",
          body: `interrupt failed after cancel: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    this.pump();
    return this.store.getRun(active.id) ?? finished;
  }

  /** 并发上限内按创建顺序起跑排队 Run；起跑=同步认领（queued→running），执行异步。 */
  pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      for (;;) {
        if (this.closed) break;
        const limit = this.store.getSettings().concurrencyLimit;
        if (this.store.countRunningRuns() >= limit) break;
        const next = this.store.listQueuedRuns()[0];
        if (next === undefined) break;
        this.store.markRunRunning(next.id);
        const execution = this.executeRun(next.id);
        this.executions.set(next.id, execution);
        void execution
          .catch(() => undefined)
          .finally(() => {
            this.executions.delete(next.id);
            this.pump();
          });
      }
    } finally {
      this.pumping = false;
    }
    if (this.pumpAgain && !this.closed) {
      this.pumpAgain = false;
      this.pump();
    }
  }

  /** 在飞（未终态）Run 数：测试与关闭路径用。 */
  pendingCount(): number {
    return this.executions.size + this.cascadeChains.size;
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (run === null || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return;
    const task = this.store.getTask(run.taskId);
    if (task === null) {
      this.finishGuarded(runId, "failed", "task disappeared");
      return;
    }
    let slotKind: InFlightKind | null = null;
    // 绑定目标：本 Run 先前的锚点（重入）或任务的主绑定线程；都没有才新建
    let threadId: string | null = run.threadId ?? this.store.primaryThreadOf(task.id)?.id ?? null;
    try {
      const ensured = await this.ensureThreadForRun(task, runId, threadId);
      threadId = ensured.threadId;
      // resume 路径已把槽平移成 send：不释放再认领（微任务窗口会被第三者插队打成假冲突）
      if (ensured.holdsSend) slotKind = "send";
      const current = this.store.getRun(runId);
      if (current === null || current.status !== "running") {
        // 等待 resume/create 期间已被取消：平移来的槽必须就地归还
        if (slotKind !== null && threadId !== null) {
          this.singleFlight.release(threadId);
          slotKind = null;
        }
        return;
      }
      if (slotKind === null) {
        if (!this.singleFlight.tryAcquire(threadId, "send")) {
          throw new ConflictError(`thread ${threadId} already has an in-flight write (single-flight)`);
        }
        slotKind = "send";
      }
      const terminal = await this.driver.send({
        threadId,
        message: task.prompt,
        idempotencyKey: `run/${runId}`,
      });
      this.singleFlight.release(threadId);
      slotKind = null;
      await this.settleRun(runId, task.id, threadId, terminal);
    } catch (error) {
      if (slotKind !== null && threadId !== null) {
        this.singleFlight.release(threadId);
        slotKind = null;
      }
      this.failRun(runId, error);
    } finally {
      this.pump();
    }
  }

  /**
   * 已绑定线程走 resume（审计落库），未绑定走 create+绑定；Conflict 显式失败。
   * 返回 holdsSend：resume 成功后槽已平移成 send 仍被本 Run 持有，executeRun 不得再认领或漏释放。
   */
  private async ensureThreadForRun(
    task: Task,
    runId: string,
    boundThreadId: string | null,
  ): Promise<{ threadId: string; holdsSend: boolean }> {
    if (boundThreadId !== null && task.workspaceMode === "isolated_worktree" && this.worktrees !== undefined) {
      if (this.store.activeWorktreeOf(task.id) === null) {
        // worktree 已被显式清理：旧 thread 的 cwd 已失效，不得 resume 进悬空目录——
        // 解绑旧 primary（换绑记审计），转下方 create 路径拿全新的隔离目录与 branch
        this.store.unbindThread(task.id, boundThreadId, { role: "primary" });
        this.store.addAnnotation({
          taskId: task.id,
          threadId: boundThreadId,
          kind: WORKTREE_SWITCHED_KIND,
          body: `run ${runId}: worktree was cleaned after acceptance; thread ${boundThreadId} (cwd gone) unbound — a fresh worktree and thread are created for this run`,
        });
        boundThreadId = null;
      } else {
        // 校验任务 workspace 与 worktree 记录一致；目录被外部移走时顺带自愈重挂
        await this.worktrees.ensureForTask(task);
      }
    }
    if (boundThreadId !== null) {
      // 锚点先落：resume 冲突或 send 失败时 thread 锚点仍在（A24 语义一致）
      this.store.markRunRunning(runId, { threadId: boundThreadId });
      let resumedToSend = false;
      if (!this.driver.isLoaded(boundThreadId)) {
        if (!this.singleFlight.tryAcquire(boundThreadId, "resume")) {
          throw new ConflictError(`thread ${boundThreadId} already has an in-flight write (single-flight)`);
        }
        try {
          await this.driver.resumeThread({ threadId: boundThreadId, idempotencyKey: `resume/${runId}` });
          // resume 即成功：槽原位平移成 send，绝不出现无主窗口
          resumedToSend = this.singleFlight.transfer(boundThreadId, "send");
          this.store.addAnnotation({
            taskId: task.id,
            threadId: boundThreadId,
            kind: THREAD_RESUME_KIND,
            body: `writer lock taken for run ${runId} (bound thread; may materialize compacted rollups)`,
          });
        } catch (error) {
          if (error instanceof ConflictError) {
            // 写锁被外部进程持有：线程记 held（原生状态，非失败），Run 按失败显式落账
            this.store.upsertThread({ id: boundThreadId, harnessId: CODEX_HARNESS_ID, nativeStatus: "held" });
          }
          throw error;
        } finally {
          // 平移成功则 send 阶段继续持有；仅 resume 本身失败/冲突时在这里归还
          if (!resumedToSend) this.singleFlight.release(boundThreadId);
        }
      }
      return { threadId: boundThreadId, holdsSend: resumedToSend };
    }
    const workspace = await this.workspaceForNewThread(task, runId);
    const created = await this.driver.createThread({ workspace, idempotencyKey: `create/${runId}` });
    // create 窗口内已被取消：不落绑定/默认策略副作用（cancelRun 对无 threadId 的 Run 只落终态不 interrupt），
    // 返回后由 executeRun 的状态复查收口
    const current = this.store.getRun(runId);
    if (current === null || current.status !== "running") return { threadId: created, holdsSend: false };
    this.store.upsertThread({ id: created, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
    // 与人工 thread.bind 同一条 primary 绑定写路径（新建 thread 不会撞 primary 席位）
    this.store.bindThread(task.id, created);
    // taskboard 创建并绑定主线程 → 默认策略生效（suggest 且未显式设置的任务升级 auto，故事 49）
    this.store.applyTaskboardThreadDefault(task.id);
    this.store.markRunRunning(runId, { threadId: created });
    return { threadId: created, holdsSend: false };
  }

  /**
   * 新建线程的 cwd：current 直接用任务 workspace；isolated_worktree 由 WorktreeManager
   * 从基准分支准备目录（A18）。准备失败落审计证据后原样抛出——Run 按硬执行失败落账。
   */
  private async workspaceForNewThread(task: Task, runId: string): Promise<string> {
    if (task.workspaceMode !== "isolated_worktree") {
      if (task.workspace === null) throw new ValidationError(`task has no workspace: ${task.id}`);
      return task.workspace;
    }
    if (this.worktrees === undefined) {
      throw new ValidationError(
        `task ${task.id} is isolated_worktree but this assembly has no worktree runtime (daemon wires it)`,
      );
    }
    try {
      return (await this.worktrees.ensureForTask(task)).path;
    } catch (error) {
      this.store.addAnnotation({
        taskId: task.id,
        kind: WORKTREE_PREPARE_FAILED_KIND,
        body: `isolated worktree preparation failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
  }

  private async settleRun(runId: string, taskId: string, threadId: string, terminal: TurnTerminal): Promise<void> {
    this.store.upsertThread({ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: nativeStatusOf(terminal.kind) });
    if (terminal.kind === "completed") {
      this.finishGuarded(runId, "completed");
      // finishGuarded 会因 cancel 抢先落终态而安静让位：级联与审批注记只认持久化 status，
      // 迟到的完成不得替已取消的 Run 续走后续（以库里的事实为准，不以本次写入是否赢为准）
      const settled = this.store.getRun(runId);
      if (settled === null || settled.status !== "completed") return;
      if (terminal.stopReason === "approval_needed") {
        this.store.addAnnotation({
          taskId,
          threadId,
          kind: APPROVAL_STOP_KIND,
          body: `run ${runId} stopped for user approval (approval_policy=never; taskboard has no approval path — continue in Desktop/TUI)`,
        });
      }
      const fresh = this.store.getTask(taskId);
      if (fresh?.subtasksPolicy === "cascade") this.driveCascade(fresh.id, runId);
      return;
    }
    if (terminal.kind === "interrupted") {
      // turn_aborted 是 interrupted 不是 failed：Run 记 cancelled，任务回 todo（A20 列语义）
      this.finishGuarded(runId, "cancelled", "turn interrupted");
      return;
    }
    this.finishGuarded(runId, "failed", terminal.message ?? "turn failed");
  }

  private failRun(runId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    const run = this.store.getRun(runId);
    if (run === null || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return;
    this.finishGuarded(runId, "failed", reason);
  }

  /** 终态只写一次：cancel 先到时这里安静让位（打断与取消的竞态）；是否真落成由调用方复查持久状态判定。 */
  private finishGuarded(runId: string, status: "completed" | "failed" | "cancelled", failureReason?: string): void {
    try {
      this.store.finishRun(
        runId,
        status,
        failureReason !== undefined ? { failureReason } : {},
      );
    } catch (error) {
      if (error instanceof ConflictError) return;
      throw error;
    }
    this.resolveWaiters(runId, status);
  }

  /** 级联链条：父 Run completed 后按创建顺序驱动未归档子任务；任一子 Run 非 completed 即停并翻转父 Run。
   *  嵌套级联的迟到翻转沿任务父链向上传播（propagateCascadeStop），本链条被翻转时自检退出。 */
  private driveCascade(parentTaskId: string, parentRunId: string): void {
    const chain = (async () => {
      const children = this.store
        .childIds(parentTaskId)
        .map((id) => this.store.getTask(id))
        .filter((child): child is Task => child !== null && !child.archived);
      for (const child of children) {
        if (this.closed) return;
        // 自身被迟到翻转（嵌套级联向上传播）即停：本链的父 Run 已不再 completed
        const own = this.store.getRun(parentRunId);
        if (own === null || own.status !== "completed") return;
        // 子任务已被人工起跑时直接沿用它在飞的 Run，不重复创建
        let childRun: Run | null = this.store.activeRunOf(child.id);
        if (childRun === null) {
          try {
            childRun = this.createRunForTask(child.id, "cascade");
          } catch (error) {
            if (this.closed) return; // shutting down：链条就地丢弃，重启对账收敛
            // 先查与 create 之间人工恰好起跑也走 ConflictError：再查一次沿用，不误翻父 Run
            childRun = this.store.activeRunOf(child.id);
            if (childRun === null) {
              // 起跑失败不得静默吞（archived 中途归档/无 workspace 等都到这）：留因翻转父 Run
              this.stopCascade(
                parentTaskId,
                parentRunId,
                "failed",
                `cascade stopped: child task ${child.id} could not start: ` +
                  `${error instanceof Error ? error.message : String(error)}`,
              );
              return;
            }
          }
        }
        const status = await this.runTerminal(childRun.id);
        if (status === "completed") continue;
        this.stopCascade(
          parentTaskId,
          parentRunId,
          status === "failed" ? "failed" : "cancelled",
          status === "failed"
            ? `cascade stopped: child task ${child.id} run failed`
            : `cascade stopped: child task ${child.id} run cancelled`,
        );
        return;
      }
    })();
    this.cascadeChains.add(chain);
    void chain.finally(() => this.cascadeChains.delete(chain)).catch(() => undefined);
  }

  /** 级联停止：父 Run 翻转（只作用于 completed，已被人工移动时不覆盖）+ 沿任务父链向上传播。 */
  private stopCascade(parentTaskId: string, parentRunId: string, status: "failed" | "cancelled", reason: string): void {
    try {
      this.store.flipRun(parentRunId, status, reason);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // 父 Run 已被人工移动/取消时不强行覆盖：级联翻转只作用于 completed
      return;
    }
    this.propagateCascadeStop(parentTaskId, status);
  }

  /** 嵌套级联的失败传播：子树翻转后，祖先任务最近一条 completed Run 一并翻转，直到非级联祖先。 */
  private propagateCascadeStop(taskId: string, status: "failed" | "cancelled"): void {
    let current: Task | null = this.store.getTask(taskId);
    while (current !== null && current.parentId !== null) {
      const parentTask = this.store.getTask(current.parentId);
      if (parentTask === null) return;
      const ancestorRun = this.store.listRuns(parentTask.id, 1)[0];
      if (ancestorRun === undefined) return;
      try {
        this.store.flipRun(
          ancestorRun.id,
          status,
          `cascade stopped: descendant task ${current.id} run ${status} (nested cascade propagation)`,
        );
      } catch {
        return; // 祖先 Run 非 completed（已终态/人工移动/非级联路径）：传播到此为止
      }
      current = parentTask;
    }
  }

  /** 子 Run 终态的进程内等待（不跨重启；重启后等待者随链条一起消失）。 */
  private runTerminal(runId: string): Promise<RunStatus> {
    const run = this.store.getRun(runId);
    if (run !== null && !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return Promise.resolve(run.status);
    }
    return new Promise<RunStatus>((resolve) => {
      const waiters = this.terminalWaiters.get(runId) ?? [];
      waiters.push(resolve);
      this.terminalWaiters.set(runId, waiters);
    });
  }

  private resolveWaiters(runId: string, status: RunStatus): void {
    const waiters = this.terminalWaiters.get(runId);
    if (waiters === undefined) return;
    this.terminalWaiters.delete(runId);
    for (const waiter of waiters) waiter(status);
  }

  /**
   * daemon 关闭：先停 driver（在飞 send 随断连显式失败并落 failed），再等执行与级联收敛。
   * 级联与排队状态就地丢弃：重启对账负责半截 Run，链条绝不跨进程恢复。
   */
  async close(stopDriver?: () => Promise<void>): Promise<void> {
    this.closed = true;
    try {
      await stopDriver?.();
    } finally {
      // 排队中的 Run 无人再起跑（pump 已随 closed 停）：落 cancelled 让级联等待者收敛，close 不得悬挂；
      // stopDriver 失败也不得跳过收敛，否则 daemon 关闭顺序中断、HTTP/DB 泄漏
      for (const run of this.store.listQueuedRuns()) {
        this.finishGuarded(run.id, "cancelled", "run manager is shutting down");
      }
      const pending = [...this.executions.values(), ...this.cascadeChains];
      await Promise.allSettled(pending);
    }
  }
}
