/**
 * CodexDriver：Harness Driver 的 Codex 实现（create/resume/send/interrupt/goal/sample/close）。
 * 依赖一个懒维护的长驻 app-server 客户端：断连/失败后下次使用重建并重新 initialize，
 * 绝不在失败时静默切换写路径（需求「Codex 调度与原生能力」）。
 * 单飞由调用方（RunManager/GoalService）持有线程槽；driver 只负责协议与会话事实（loaded 集合）。
 */

import { ConflictError, NotFoundError } from "../errors.js";
import { AppServerClient, ServerReplyError, type SecretEnvKeys } from "./client.js";
import {
  goalMethod,
  goalViewOf,
  M_THREAD_CLOSE,
  M_THREAD_RESUME,
  M_THREAD_SAMPLE,
  M_THREAD_START,
  M_TURN_INTERRUPT,
  M_TURN_START,
  SAMPLE_MAX_PROMPT_BYTES,
  SELF_DRIVEN_APPROVAL_POLICY,
  SELF_DRIVEN_SANDBOX,
  SERVER_ERROR_CONFLICT,
  SERVER_ERROR_THREAD_BUSY,
  SERVER_ERROR_THREAD_NOT_FOUND,
  terminalOfEventMsg,
  type GoalOpName,
  type GoalView,
  type TurnTerminal,
} from "./protocol.js";
import {
  DriverDisconnectedError,
  DriverProtocolError,
  DriverTimeoutError,
} from "./errors.js";

export interface DriverOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  secretEnvKeys?: SecretEnvKeys;
  requestTimeoutMs?: number;
}

export interface DriverDescribe {
  available: boolean;
  note: string;
}

export class CodexDriver {
  private client: AppServerClient | null = null;
  private readonly loaded = new Set<string>();
  private readonly eventHandlers = new Set<(threadId: string, type: string, msg: Record<string, unknown>) => void>();
  /** 在飞 turn 的终态等待：断连时整体拒绝（否则 executeRun 永久悬挂）。 */
  private readonly terminalRejects = new Set<(error: Error) => void>();
  /** 每 thread 的在飞 turn/start：interrupt 必须排在它之后，否则打断落在 turn 开始前变成 no-op。 */
  private readonly turnStarts = new Map<string, Promise<unknown>>();
  /**
   * send 以超时收场且终局未观察的 thread：turn 可能仍在服务端在飞。这些线程的下一次 send
   * 必须显式冲突，直到该线程任一原生终态到达——否则陈旧终局会错配新等待（破坏「终局只认原生终态」）。
   */
  private readonly unresolvedTurns = new Set<string>();
  private starting: Promise<AppServerClient> | null = null;
  /** 关闭栅栏：close 之后的 spawn 完成体必须自行丢弃新 client，否则子进程无人关闭而泄漏。 */
  private closed = false;

  constructor(private readonly options: DriverOptions) {}

  /** 视图用：当前客户端引用（可能为 null = 尚未 spawn）。 */
  clientRef(): AppServerClient | null {
    return this.client;
  }

  /** 订阅事件流（换客户端后自动挂到新客户端）。返回退订函数。 */
  onEventMsg(handler: (threadId: string, type: string, msg: Record<string, unknown>) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  isLoaded(threadId: string): boolean {
    return this.loaded.has(threadId);
  }

  describe(): DriverDescribe {
    const client = this.client;
    if (client === null) {
      return { available: true, note: "no app-server spawned yet (spawns lazily on first run)" };
    }
    if (client.healthy()) {
      const info = client.info();
      return {
        available: true,
        note: `app-server ready${info.userAgent !== null ? ` (${info.userAgent})` : ""}`,
      };
    }
    return {
      available: false,
      note: `app-server unavailable: ${client.describeError() ?? "not connected"}; a fresh one spawns on the next run`,
    };
  }

  /** 确保有一个健康客户端；失败不缓存坏客户端（下次调用重试全新 spawn）。 */
  ensureStarted(): Promise<AppServerClient> {
    if (this.closed) return Promise.reject(new DriverDisconnectedError("driver is shutting down; no new app-server"));
    if (this.client?.healthy()) return Promise.resolve(this.client);
    this.starting ??= this.spawnAndInitialize().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async spawnAndInitialize(): Promise<AppServerClient> {
    const client = new AppServerClient({
      command: this.options.command,
      ...(this.options.args !== undefined ? { args: this.options.args } : {}),
      ...(this.options.env !== undefined ? { env: this.options.env } : {}),
      ...(this.options.secretEnvKeys !== undefined ? { secretEnvKeys: this.options.secretEnvKeys } : {}),
      ...(this.options.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.options.requestTimeoutMs }
        : {}),
    });
    client.onEventMsg((notification) => {
      for (const handler of [...this.eventHandlers]) {
        handler(notification.threadId, notification.msg.type, notification.msg);
      }
      // 疑似僵尸 turn 的收口观察：该线程任一原生终态到达即解除，放行后续 send
      if (terminalOfEventMsg(notification.msg.type, notification.msg) !== null) {
        this.unresolvedTurns.delete(notification.threadId);
      }
    });
    client.onExit((detail) => {
      this.loaded.clear();
      // 换 app-server 实例 = 旧实例里的在飞 turn 全部作废：终局疑点随之清空
      this.unresolvedTurns.clear();
      for (const reject of [...this.terminalRejects]) {
        reject(new DriverDisconnectedError(`app-server exited while a turn was in flight: ${detail}`));
      }
      this.terminalRejects.clear();
    });
    try {
      await client.start();
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    // 关闭栅栏：start 期间 close() 已到，新 client（连同子进程）就地丢弃，绝不赋值出去
    if (this.closed) {
      await client.close().catch(() => undefined);
      throw new DriverDisconnectedError("driver closed while the app-server was starting");
    }
    this.client = client;
    // 换客户端 = 换 app-server 实例：旧实例里「已加载」的事实全部失效
    this.loaded.clear();
    return client;
  }

  async createThread(input: { workspace: string; idempotencyKey: string }): Promise<string> {
    const client = await this.ensureStarted();
    try {
      const result = (await client.request(M_THREAD_START, {
        cwd: input.workspace,
        approvalPolicy: SELF_DRIVEN_APPROVAL_POLICY,
        sandbox: SELF_DRIVEN_SANDBOX,
        idempotencyKey: input.idempotencyKey,
      })) as { threadId?: unknown };
      if (typeof result.threadId !== "string" || result.threadId.length === 0) {
        throw new DriverDisconnectedError(`thread/start returned no threadId: ${JSON.stringify(result)}`);
      }
      this.loaded.add(result.threadId);
      return result.threadId;
    } catch (error) {
      throw this.wrap(error, input.idempotencyKey);
    }
  }

  /** 接管已绑定线程的写锁（写邻接操作，调用方负责落审计）。Conflict → 领域 ConflictError。 */
  async resumeThread(input: { threadId: string; idempotencyKey: string }): Promise<void> {
    const client = await this.ensureStarted();
    try {
      await client.request(M_THREAD_RESUME, { threadId: input.threadId, idempotencyKey: input.idempotencyKey });
      this.loaded.add(input.threadId);
    } catch (error) {
      throw this.wrap(error, input.threadId);
    }
  }

  /**
   * 发送消息并等待该 turn 的原生终态。turn 在飞时再次发送按 busy 冲突拒绝，绝不并行。
   * turn/start 的 RPC promise 同步登记进 turnStarts：interrupt 排在它之后，
   * 保证打断落在 turn 真正开始之后（否则早到的 interrupt 是 no-op，turn 变僵尸）。
   */
  send(input: { threadId: string; message: string; idempotencyKey: string }): Promise<TurnTerminal> {
    const startRpc = (async () => {
      if (this.unresolvedTurns.has(input.threadId)) {
        // 上一次 send 超时且终局未观察：先收到的同线程终局可能是陈旧 turn 的，绝不拿它结算新等待
        throw new ConflictError(
          `thread ${input.threadId} may still have an in-flight turn whose terminal was never observed; ` +
            "wait for a native terminal before sending again",
        );
      }
      const client = await this.ensureStarted();
      const wait = this.waitTurnTerminal(client, input.threadId);
      try {
        await client.request(M_TURN_START, {
          threadId: input.threadId,
          input: [{ type: "text", text: input.message }],
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        wait.abandon();
        // 超时意味着 turn/start 可能已被服务端受理：记终局疑点，等原生终态到达再放行
        if (error instanceof DriverTimeoutError) this.unresolvedTurns.add(input.threadId);
        throw this.wrap(error, input.threadId);
      }
      return wait;
    })();
    this.turnStarts.set(input.threadId, startRpc);
    void startRpc
      .finally(() => {
        if (this.turnStarts.get(input.threadId) === startRpc) this.turnStarts.delete(input.threadId);
      })
      .catch(() => undefined); // 失败由下面的返回链交给调用方，这里只防 unhandled rejection
    return startRpc.then((wait) => wait.terminal);
  }

  /** turn interrupt（cancel 的协议形态）。先等该 thread 在飞的 turn/start 落线，保证打断真的命中在飞 turn。 */
  async interrupt(threadId: string): Promise<{ interrupted: boolean }> {
    const client = await this.ensureStarted();
    await this.turnStarts.get(threadId)?.catch(() => undefined);
    try {
      const result = (await client.request(M_TURN_INTERRUPT, { threadId })) as { interrupted?: unknown };
      return { interrupted: result.interrupted === true };
    } catch (error) {
      throw this.wrap(error, threadId);
    }
  }

  /**
   * 原生 goal 操作（enable/set/get/pause/resume/clear/status）。写操作带 idempotencyKey；
   * 能力注册表记录该 method 不存在时抛 CapabilityUnavailableError，绝不回退自造 goal loop。
   */
  async goalOp(input: {
    op: GoalOpName;
    threadId: string;
    text?: string;
    budgetTokens?: number | null;
    idempotencyKey?: string;
  }): Promise<GoalView> {
    const client = await this.ensureStarted();
    const method = goalMethod(input.op);
    client.requireCapability(method);
    const params: Record<string, unknown> = { threadId: input.threadId };
    if (input.op === "enable" || input.op === "set") {
      params.text = input.text ?? "";
      if (input.budgetTokens != null) params.budgetTokens = input.budgetTokens;
    }
    if (input.op !== "get" && input.op !== "status" && input.idempotencyKey !== undefined) {
      params.idempotencyKey = input.idempotencyKey;
    }
    try {
      const result = await client.request(method, params);
      return goalViewOf(input.threadId, result);
    } catch (error) {
      throw this.wrap(error, input.threadId);
    }
  }

  /**
   * thread/sample 采样（experimental）。调用方负责：resume/loaded 前置、expectedTurnId 校验来源、
   * 采样后释放写锁。expected_turn_id 失配等服务端拒绝原样抛出（ServerReplyError），由上层回落基线。
   */
  async sample(input: { threadId: string; expectedTurnId: string; prompt: string }): Promise<string> {
    // 线上约束（runtime facts）：prompt ≤ SAMPLE_MAX_PROMPT_BYTES。本地先挡，
    // 超限在服务端只会得到语焉不详的 -32600，且长 prompt 早已烧掉一轮 resume/close
    const promptBytes = Buffer.byteLength(input.prompt, "utf8");
    if (promptBytes > SAMPLE_MAX_PROMPT_BYTES) {
      throw new DriverProtocolError(
        `thread/sample prompt exceeds ${SAMPLE_MAX_PROMPT_BYTES} bytes (got ${promptBytes})`,
      );
    }
    const client = await this.ensureStarted();
    client.requireCapability(M_THREAD_SAMPLE);
    try {
      const result = (await client.request(M_THREAD_SAMPLE, {
        threadId: input.threadId,
        expectedTurnId: input.expectedTurnId,
        prompt: input.prompt,
      })) as { text?: unknown };
      if (typeof result?.text !== "string") {
        throw new DriverProtocolError(`thread/sample returned no text: ${JSON.stringify(result)}`);
      }
      return result.text;
    } catch (error) {
      throw this.wrap(error, input.threadId);
    }
  }

  /** 释放线程写锁（sample 收尾）。成功后从 loaded 集合移除：下次写操作需重新 resume。 */
  async closeThread(threadId: string): Promise<void> {
    const client = await this.ensureStarted();
    client.requireCapability(M_THREAD_CLOSE);
    try {
      await client.request(M_THREAD_CLOSE, { threadId });
    } catch (error) {
      throw this.wrap(error, threadId);
    }
    this.loaded.delete(threadId);
  }

  /**
   * 关闭：先立栅栏再等在飞 spawn 落定——spawn 完成体看到栅栏自行关闭新 client（子进程绝不离场）；
   * 随后关闭已就位 client。栅栏先于一切关闭动作，保证 close 返回后没有任何子进程可被赋值进来。
   */
  async close(): Promise<void> {
    this.closed = true;
    await this.starting?.catch(() => undefined);
    const client = this.client;
    this.client = null;
    this.loaded.clear();
    if (client !== null) await client.close();
  }

  /**
   * 先挂终态监听再发请求，避免终态早于订阅到达。
   * task_started 只表进行中；未知事件类型不作终局（与 reader 同款降级纪律）。
   * 断连时等待整体拒绝（client onExit → terminalRejects）。
   */
  private waitTurnTerminal(
    client: AppServerClient,
    threadId: string,
  ): { terminal: Promise<TurnTerminal>; abandon: () => void } {
    let settled = false;
    let settleTerminal: ((terminal: TurnTerminal) => void) | null = null;
    let rejectTerminal: ((error: Error) => void) | null = null;
    const terminal = new Promise<TurnTerminal>((resolve, reject) => {
      settleTerminal = resolve;
      rejectTerminal = reject;
    });
    const onDisconnect = (error: Error): void => {
      if (settled) return;
      settled = true;
      this.terminalRejects.delete(onDisconnect);
      unsubscribe();
      rejectTerminal?.(error);
    };
    const unsubscribe = client.onEventMsg((notification) => {
      if (notification.threadId !== threadId) return;
      if (notification.msg.type === "task_started") return;
      const mapped = terminalOfEventMsg(notification.msg.type, notification.msg);
      if (mapped === null || settled) return;
      settled = true;
      this.terminalRejects.delete(onDisconnect);
      unsubscribe();
      settleTerminal?.(mapped);
    });
    this.terminalRejects.add(onDisconnect);
    return {
      terminal,
      abandon: () => {
        onDisconnect(new DriverDisconnectedError(`terminal wait on thread ${threadId} abandoned`));
        // abandon 是主动放弃：吞掉 rejection，调用方已有原始失败要报
        terminal.catch(() => undefined);
      },
    };
  }

  /** 服务端业务错误 → 领域错误；传输层断连 → 丢弃客户端（下次重建）。 */
  private wrap(error: unknown, threadId: string): Error {
    if (error instanceof ServerReplyError) {
      if (error.code === SERVER_ERROR_CONFLICT) {
        return new ConflictError(`thread ${threadId} is held by another process (writer lock conflict)`);
      }
      if (error.code === SERVER_ERROR_THREAD_NOT_FOUND) {
        return new NotFoundError(`thread not found: ${threadId}`);
      }
      // 忙判以协议错误码为准；message 子串只是对未带码变体的兜底（措辞随时会变）
      if (error.code === SERVER_ERROR_THREAD_BUSY || error.message.includes("active turn")) {
        return new ConflictError(`thread ${threadId} already has an active turn`);
      }
      return error;
    }
    if (error instanceof DriverDisconnectedError) {
      this.client = null;
      this.loaded.clear();
      return error;
    }
    return error as Error;
  }
}
