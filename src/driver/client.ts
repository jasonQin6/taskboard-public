/**
 * Codex app-server 协议客户端：spawn 长驻子进程、initialize（experimental opt-in）、
 * 能力探测注册表、请求关联、断连处理。不变量「单条 Codex 写路径」的传输底座：
 * 一个 daemon 实例至多持有一个健康客户端；断连后在飞请求整体失败，绝不换路。
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  asEventMsgNotification,
  EVENT_MSG_METHOD,
  isJsonRpcResponse,
  isUnknownVariantError,
  M_INITIALIZE,
  PROBED_METHODS,
  SUPPORTED_PROTOCOL_MAJOR,
  type EventMsgNotification,
} from "./protocol.js";
import {
  CapabilityUnavailableError,
  DriverDisconnectedError,
  DriverProtocolError,
  DriverTimeoutError,
} from "./errors.js";

export type SecretEnvKeys = readonly string[] | (() => readonly string[]);

export interface AppServerClientOptions {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** 每次 spawn 前求值：设置可能在懒启动前变化。 */
  secretEnvKeys?: SecretEnvKeys;
  /** 单个 JSON-RPC 请求的应答超时；超时只判该请求失败，不断连。 */
  requestTimeoutMs?: number;
}

export type ClientStatus = "starting" | "ready" | "disconnected" | "failed";

/** 单行 stdout 缓冲上限：超过即判协议损坏并断连（防误行/恶意子进程驱动无限内存增长）。 */
const MAX_STDOUT_LINE_BUFFER = 8 * 1024 * 1024;
/** 启动探测的应答上限：几秒不应答的探测方法不会应答，绝不拖满整个请求超时。 */
const PROBE_TIMEOUT_MS = 5_000;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface ClientInfo {
  protocolVersion: string | null;
  userAgent: string | null;
  codexHome: string | null;
}

export interface CapabilityView {
  available: string[];
  unavailable: string[];
}

/** 能力注册表：只登记实际探测/观察到的方法存在性，绝不臆测。 */
export class CapabilityRegistry {
  private readonly entries = new Map<string, boolean>();

  record(method: string, available: boolean): void {
    this.entries.set(method, available);
  }

  isAvailable(method: string): boolean | null {
    return this.entries.get(method) ?? null;
  }

  requireAvailable(method: string): void {
    if (this.entries.get(method) === false) throw new CapabilityUnavailableError(method);
  }

  view(): CapabilityView {
    const available: string[] = [];
    const unavailable: string[] = [];
    for (const [method, ok] of this.entries) (ok ? available : unavailable).push(method);
    return { available: available.sort(), unavailable: unavailable.sort() };
  }
}

export class AppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<(notification: EventMsgNotification) => void>();
  private readonly exitHandlers = new Set<(detail: string) => void>();
  private readonly registry = new CapabilityRegistry();
  private readonly timeoutMs: number;
  private state: ClientStatus = "starting";
  private lastError: string | null = null;
  private handshake: ClientInfo = { protocolVersion: null, userAgent: null, codexHome: null };

  constructor(private readonly options: AppServerClientOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get status(): ClientStatus {
    return this.state;
  }

  info(): ClientInfo {
    return this.handshake;
  }

  capabilities(): CapabilityView {
    return this.registry.view();
  }

  requireCapability(method: string): void {
    this.registry.requireAvailable(method);
  }

  /** spawn + initialize + 探测。任一步失败标记 failed 并原样抛出（调用方决定重建时机）。 */
  async start(): Promise<void> {
    if (this.state === "ready") return;
    this.state = "starting";
    try {
      this.spawnChild();
      const result = (await this.request(M_INITIALIZE, {
        clientInfo: { name: "taskboard", title: "taskboard", version: "0.1.0" },
        // experimental API opt-in：thread/sample、goal 等 capability 的前置（调研文档）
        capabilities: { experimentalApi: true },
      })) as Record<string, unknown>;
      this.handshake = {
        protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : null,
        userAgent: typeof result.userAgent === "string" ? result.userAgent : null,
        codexHome: typeof result.codexHome === "string" ? result.codexHome : null,
      };
      this.checkProtocolVersion(this.handshake.protocolVersion);
      await this.probeCapabilities();
      if (this.child === null) {
        // 探测期间子进程退出：探测错误被吞但存在性全未知，绝不把无进程的客户端标成 ready
        throw new DriverDisconnectedError(this.lastError ?? "app-server exited during startup");
      }
      this.state = "ready";
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.killChild("SIGKILL");
      throw error;
    }
  }

  private spawnChild(): void {
    const env = { ...process.env, ...this.options.env };
    // 凭据只属于 provider，app-server 子进程不需要也不得继承
    const secretEnvKeys =
      typeof this.options.secretEnvKeys === "function"
        ? this.options.secretEnvKeys()
        : this.options.secretEnvKeys;
    for (const key of secretEnvKeys ?? []) delete env[key];
    this.child = spawn(this.options.command, this.options.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = this.child;
    child.on("error", (error) => this.handleExit(`app-server failed to start: ${error.message}`));
    child.on("exit", (code, signal) =>
      this.handleExit(`app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
    );
    // 只处理完整换行行：半截行与 Codex rollout 语义一致，留到补齐
    let buffer = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_STDOUT_LINE_BUFFER) {
        // 无换行的巨型行意味着协议已破：斩断连接，防止线性内存膨胀
        this.handleExit(`app-server stdout line exceeds ${MAX_STDOUT_LINE_BUFFER} chars; protocol broken`);
        child.kill("SIGKILL");
        return;
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) this.handleLine(line);
    });
    // EPIPE 等写失败若无监听会以 uncaught exception 崩掉 daemon：交给 handleExit 统一收口
    child.stdin!.on("error", (error: Error) => {
      this.handleExit(`app-server stdin failed: ${error.message}`);
    });
    // stderr 只留尾巴用于人话诊断，绝不当作协议
    let stderrTail = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2_000);
    });
    child.once("exit", () => {
      if (stderrTail.trim().length > 0) this.lastError = stderrTail.trim().split("\n").pop()!.slice(0, 500);
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // 非 JSON 行丢弃，不当作协议失败
    }
    if (!isJsonRpcResponse(message)) {
      const record = message as { method?: unknown; id?: unknown };
      if (typeof record.method === "string" && record.id !== undefined && record.id !== null) {
        // 服务端主动请求：本客户端只消费通知。显式回 -32601，绝不让它撞 pending 的客户端 id
        try {
          this.child?.stdin?.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: record.id,
              error: { code: -32601, message: `client does not accept server-initiated requests: ${record.method}` },
            })}\n`,
          );
        } catch {
          // 对端已死：exit/error 事件负责收口
        }
        return;
      }
      const notification = asEventMsgNotification((message as { params?: unknown })?.params);
      if (notification !== null && (message as { method?: string }).method === EVENT_MSG_METHOD) {
        for (const handler of [...this.notificationHandlers]) handler(notification);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) return; // 迟到/未知 id 的应答忽略
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) {
      pending.reject(new ServerReplyError(message.error.code, message.error.message));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleExit(detail: string): void {
    if (this.state === "disconnected" || this.state === "failed") return; // failed 由 start() 标记，保持粘滞
    this.state = "disconnected";
    if (this.lastError === null) this.lastError = detail;
    for (const [id, pending] of [...this.pending]) {
      clearTimeout(pending.timer);
      pending.reject(new DriverDisconnectedError(detail));
      this.pending.delete(id);
    }
    this.child = null;
    for (const handler of [...this.exitHandlers]) handler(detail);
  }

  /** 断连通知：在飞 turn 终态等待（非请求挂起）靠它整体失败，否则 executeRun 会永久悬挂。 */
  onExit(handler: (detail: string) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  private checkProtocolVersion(version: string | null): void {
    if (version === null) return; // 真机 0.163.0 不回 protocolVersion：缺省视为兼容，userAgent 已记录
    const major = Number.parseInt(version.split(".")[0] ?? "", 10);
    if (!Number.isInteger(major) || major !== SUPPORTED_PROTOCOL_MAJOR) {
      throw new DriverProtocolError(
        `app-server protocol version ${version} not supported (client speaks ${SUPPORTED_PROTOCOL_MAJOR}.x)`,
      );
    }
  }

  /**
   * 探测只探测空参数必然停在参数校验的 method（无副作用）；-32600 unknown variant 即不存在。
   * 探测相互独立且无副作用：并发跑、短超时，坏 app-server 不再拖长启动；
   * 只有服务端业务应答才算存在性事实，传输层失败不记录不臆测。
   */
  private async probeCapabilities(): Promise<void> {
    const probeTimeoutMs = Math.min(this.timeoutMs, PROBE_TIMEOUT_MS);
    await Promise.all(
      PROBED_METHODS.map(async (method) => {
        try {
          await this.rawRequest(method, {}, probeTimeoutMs);
          this.registry.record(method, true);
        } catch (error) {
          if (error instanceof ServerReplyError && isUnknownVariantError(error.code, error.message)) {
            this.registry.record(method, false);
          } else if (error instanceof ServerReplyError) {
            // 已知 method 停在参数校验（missing field 等）：method 存在
            this.registry.record(method, true);
          }
          // 传输层失败（超时/断连）：存在性未知，保持 null
        }
      }),
    );
  }

  /** 事件通知订阅；换客户端后由 driver 重新挂接。返回退订函数。 */
  onEventMsg(handler: (notification: EventMsgNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.state === "disconnected" || this.state === "failed" || this.child === null) {
      throw new DriverDisconnectedError("app-server is not running; a new client is needed");
    }
    return this.rawRequest(method, params);
  }

  private rawRequest(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number = this.timeoutMs,
  ): Promise<unknown> {
    const child = this.child;
    if (child === null || child.stdin === null || child.stdin.destroyed) {
      return Promise.reject(new DriverDisconnectedError("app-server stdin is closed"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DriverTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        // 同步写失败：立刻了结该请求，不等超时
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new DriverDisconnectedError(`app-server stdin write failed: ${String(error)}`));
      }
    });
  }

  healthy(): boolean {
    return this.state === "ready" && this.child !== null;
  }

  describeError(): string | null {
    return this.lastError;
  }

  /** 优雅关闭：先 end stdin（留出在飞 turn 收尾窗口），随后 SIGTERM 兜底 SIGKILL。 */
  async close(): Promise<void> {
    await this.killChild("SIGTERM");
  }

  private killChild(signal: NodeJS.Signals): Promise<void> {
    const child = this.child;
    if (child === null) return Promise.resolve();
    this.child = null;
    return new Promise((resolve) => {
      const exited = new Promise<void>((resolveExit) => {
        child.once("exit", () => resolveExit());
      });
      child.stdin?.end();
      child.kill(signal);
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      void exited.then(() => {
        clearTimeout(force);
        resolve();
      });
    });
  }
}

/** app-server 应答里的 JSON-RPC error 对象（服务端业务错误，区别于传输层失败）。 */
export class ServerReplyError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerReplyError";
  }
}
