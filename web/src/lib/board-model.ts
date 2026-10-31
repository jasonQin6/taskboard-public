/**
 * 看板数据层（框架无关）：React 与 node 测试共用。
 * 契约（需求「API 与 CLI」）：SSE 只推 {domain, revision, ids}，客户端按域重拉，
 * 不接收全量快照；断线重连后全域重拉，revision 追上即收敛。
 * 对 state/tasks 载荷只读消费，未知字段原样保留（字段集合只增不删）。
 */
import { API } from "./endpoints.js";
import { createLatestOnly } from "./latest-only.js";

export interface ClientRun {
  id: string;
  status: string;
  trigger: string;
  threadId: string | null;
  orphaned: boolean;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  [key: string]: unknown;
}

export interface ClientTask {
  id: string;
  title: string;
  prompt: string;
  workspace: string | null;
  status: string;
  archived: boolean;
  labels: string[];
  acceptanceMode: string;
  automationMode: string;
  parentId: string | null;
  primaryThreadId: string | null;
  primaryThreadStatus: string | null;
  threadCount: number;
  childrenCount: number;
  badges: string[];
  summaryStatus: string;
  activeRun: ClientRun | null;
  lastRun: ClientRun | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ClientThread {
  id: string;
  nativeStatus: string;
  title: string | null;
  lastActivityAt: string | null;
  ignored: boolean;
  primaryTaskId: string | null;
  [key: string]: unknown;
}

export interface ClientSourceLocator {
  harnessId: string;
  nativeSessionId: string;
  sourcePath: string | null;
  byteStart: number | null;
  recordHash: string | null;
  [key: string]: unknown;
}

export interface ClientSessionSnapshot {
  id: string;
  harnessId: string;
  nativeSessionId: string;
  title: string | null;
  workspace: string | null;
  nativeStatus: string;
  lastActivityAt: string | null;
  nativeGroup: string | null;
  unknownFields: string[];
  locator: ClientSourceLocator;
  cursor: unknown;
  provenance: string;
  [key: string]: unknown;
}

export interface ClientFailure {
  code: string;
  message: string;
  scope: { kind: string; harnessId: string; [key: string]: unknown };
  retryable: boolean;
  [key: string]: unknown;
}

export interface ClientProgressVerdict {
  status: string;
  confidence: number;
  reasonShort: string;
  evidenceRefs: string[];
  coversThrough: unknown;
  provenance: string;
  assessedAt: string;
  [key: string]: unknown;
}

export interface ClientProgressVerdictView {
  threadId: string;
  state: string;
  verdict: ClientProgressVerdict | null;
  degradation: { code: string; message: string; at: string } | null;
  breakerOpen: boolean;
  lastAttemptAt: string | null;
  [key: string]: unknown;
}

export interface ClientSystemOneRuntime {
  enabled: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  questionVersion: string;
  available: boolean;
  unavailableReason: string | null;
  externalData: string[];
  budget: { day: string; usedTokens: number; limitTokens: number; exhausted: boolean };
  concurrency: { limit: number; inFlight: number };
  breaker: { threshold: number; backoffMs: number };
  [key: string]: unknown;
}

export interface ClientRuntime {
  // 嵌套字段一律 optional：部分/旧载荷（runtime 为 null 或缺键）不得在类型层说谎，
  // 消费方各自兜底（如 App 的 ?? false），否则未来解引用会在运行时炸且无编译信号
  automationPaused?: boolean;
  scan?: { phase: string; sources: number; anomalies: number };
  driver?: { available: boolean; note: string };
  systemone?: ClientSystemOneRuntime | null;
  [key: string]: unknown;
}

export interface BoardState {
  revisions: Record<string, number>;
  tasks: ClientTask[];
  threads: ClientThread[];
  inbox: ClientThread[];
  sessions: ClientSessionSnapshot[];
  failures: ClientFailure[];
  proposals: unknown[];
  progressVerdicts: ClientProgressVerdictView[];
  runtime: ClientRuntime;
  /** 客户端合成字段（非服务端载荷）：最近一次全域重拉失败原因，成功后复位 null；视图据此提示。 */
  lastError: string | null;
  [key: string]: unknown;
}

export interface RevisionEvent {
  domain: string;
  revision: number;
  ids: string[];
}

export interface BoardModelOptions {
  /** 传输注入缝（观测/测试）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 事件去抖窗口：突发事件合并为一次重拉。 */
  refetchDelayMs?: number;
  /** SSE 断线后的重连等待。 */
  retryMs?: number;
}

/** 与服务端 MAX_SYSTEMONE_VISIBLE 对齐：一批登记上限，超出由模型切块。导出供跨端契约测试钉住相等。 */
export const SYSTEMONE_VISIBLE_BATCH = 64;

export class ActionError extends Error {
  constructor(
    public readonly status: number,
    public readonly payload: Record<string, unknown>,
  ) {
    super(String(payload.error ?? `action failed with ${status}`));
  }
}

const parseState = (body: unknown): BoardState => {
  if (typeof body !== "object" || body === null) throw new Error("state payload is not an object");
  const raw = body as Record<string, unknown>;
  return {
    revisions: (raw.revisions ?? {}) as Record<string, number>,
    tasks: (raw.tasks ?? []) as ClientTask[],
    threads: (raw.threads ?? []) as ClientThread[],
    inbox: (raw.inbox ?? []) as ClientThread[],
    sessions: (raw.sessions ?? []) as ClientSessionSnapshot[],
    failures: (raw.failures ?? []) as ClientFailure[],
    proposals: (raw.proposals ?? []) as unknown[],
    progressVerdicts: (raw.progressVerdicts ?? []) as ClientProgressVerdictView[],
    runtime: (raw.runtime ?? {}) as ClientRuntime,
    lastError: null,
    // summaries/annotations 是服务端快照的死载荷（无 web 消费方，线程摘要在 ThreadDetailModel），
    // 不复制进状态：无人认领的字段只会掩盖契约漂移
  };
};

/** SSE 流解析：只认 event/data 字段，注释与 retry 交给上层重连逻辑。 */
export const consumeSse = async (
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
): Promise<void> => {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  const dispatch = (): void => {
    if (dataLines.length > 0) onEvent(eventName === "" ? "message" : eventName, dataLines.join("\n"));
    eventName = "";
    dataLines = [];
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        let line = buffer.slice(0, newlineAt);
        buffer = buffer.slice(newlineAt + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          dispatch();
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") eventName = value;
          else if (field === "data") dataLines.push(value);
        }
        newlineAt = buffer.indexOf("\n");
      }
    }
    dispatch();
  } finally {
    reader.releaseLock();
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class BoardModel {
  private state: BoardState | null = null;
  private revisions: Record<string, number> = {};
  private readonly listeners = new Set<() => void>();
  private readonly revisionListeners = new Set<(change: RevisionEvent) => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly refetchDelayMs: number;
  private readonly retryMs: number;
  /**
   * pull 的 latest-only 槽位（issue #36 收敛，取代原手写「在飞 + 排队」旗标）：
   * 全域拉取无作用域 key（恒定 → key 变化丢弃分支不可达），在飞合并与 keep-last 排队由原语承担；
   * onError 落 lastError 后重抛——重抛路径不自救补跑（晨析 10-25 内化 rescue 后的原语规则），
   * 失败后残留的排队意图与原实现一致（交由下一次 pull 在循环开头清零），失败不自救重试。
   */
  private readonly pulls = createLatestOnly<string>({
    getKey: () => "board",
    onError: (error) => {
      // 持续失败不能只静默留旧数据：失败原因进状态让视图有提示；再抛出保持 refresh 的失败契约不变
      if (this.state !== null) {
        this.state = { ...this.state, lastError: error instanceof Error ? error.message : String(error) };
        this.emit();
      }
      throw error;
    },
  });
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private eventsController: AbortController | null = null;
  private eventsWanted = false;
  /** 事件循环世代：close+connect 会重开循环，停在重连 sleep 的旧循环凭世代号识别自己已退役。 */
  private eventGeneration = 0;

  constructor(
    private readonly baseUrl: string,
    options: BoardModelOptions = {},
  ) {
    // 浏览器的 fetch 是 Window 方法：解引用调用会 Illegal invocation，必须包一层保留 this
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.refetchDelayMs = options.refetchDelayMs ?? 50;
    this.retryMs = options.retryMs ?? 2000;
  }

  // useSyncExternalStore 会解引用传入的读取器：getState 必须与 subscribe 一样是绑定成员
  getState = (): BoardState | null => {
    return this.state;
  };

  /** useSyncExternalStore 兼容：引用相等即不重渲染。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * 附加订阅：转发「非陈旧」的 revision 事件（与触发看板重拉同源，陈旧事件不转发）。
   * 详情层等局部视图用它做按域收敛，不开第二条 SSE 连接。
   */
  onRevision = (listener: (change: RevisionEvent) => void): (() => void) => {
    this.revisionListeners.add(listener);
    return () => {
      this.revisionListeners.delete(listener);
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** 全量拉取一次状态并落盘（并发语义——在飞合并、keep-last 排队、失败契约——由 latest-only 槽位承担）。 */
  private async pull(): Promise<void> {
    await this.pulls.run(
      async () => {
        const res = await this.fetchImpl(`${this.baseUrl}${API.state}`, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`state fetch failed with ${res.status}`);
        return parseState(await res.json());
      },
      (state) => {
        this.state = state;
        this.revisions = { ...state.revisions };
        this.emit();
      },
    );
  }

  /** 全量重拉（初装、断线重连、手动刷新）。 */
  refresh = async (): Promise<void> => {
    await this.pull();
  };

  handleRevisionEvent = (change: RevisionEvent): void => {
    const known = this.revisions[change.domain];
    // 已追上的事件视为收敛，不再重拉；未知域（未来新增）按未知处理，保守重拉
    if (known !== undefined && change.revision <= known) return;
    for (const listener of this.revisionListeners) listener(change);
    this.scheduleRefetch();
  };

  private scheduleRefetch(): void {
    if (this.refetchTimer !== null) return;
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      void this.pull().catch(() => undefined);
    }, this.refetchDelayMs);
  }

  connectEvents(): void {
    // 重入保护：React StrictMode 的 effect 双调用不得产生两条事件循环
    if (this.eventsWanted) return;
    this.eventsWanted = true;
    this.eventGeneration += 1;
    void this.eventLoop(this.eventGeneration);
  }

  /** 只停事件流（模拟断线）；重连用 connectEvents，模型会先全域重拉再消费新事件。 */
  closeEvents(): void {
    this.eventsWanted = false;
    this.eventsController?.abort();
    this.eventsController = null;
  }

  close(): void {
    this.closeEvents();
    if (this.refetchTimer !== null) {
      clearTimeout(this.refetchTimer);
      this.refetchTimer = null;
    }
  }

  private async eventLoop(generation: number): Promise<void> {
    while (this.eventsWanted && generation === this.eventGeneration) {
      this.eventsController = new AbortController();
      const controller = this.eventsController;
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${API.events}`, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || res.body === null) throw new Error(`event stream failed with ${res.status}`);
        // 重连建立即全域重拉：断线窗口内的变更靠 pull 收敛，而不是依赖事件重放
        void this.pull().catch(() => undefined);
        await consumeSse(res.body, (event, data) => {
          if (event !== "revision") return;
          try {
            this.handleRevisionEvent(JSON.parse(data) as RevisionEvent);
          } catch {
            // 坏帧不致断流；漏掉的重拉由下一个事件或重连兜底
          }
        });
      } catch {
        // abort（closeEvents）或网络错误都走同一条重连路径
      }
      if (!this.eventsWanted || controller.signal.aborted || generation !== this.eventGeneration) return;
      await sleep(this.retryMs);
      // sleep 期间 closeEvents+connectEvents 会把 eventsWanted 重新置真并推进世代：
      // 旧循环到此必须退役，否则复活后会与新循环各开一条 SSE（僵尸双流，revision 双投递）
      if (generation !== this.eventGeneration) return;
    }
  }

  /** 局部视图（任务详情抽屉）复用同一传输缝的 JSON GET：与看板共享注入与观测，非 2xx 抛 ActionError。 */
  getJson = async (path: string): Promise<unknown> => {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new ActionError(res.status, { error: `GET ${path} failed with ${res.status}` });
    return res.json();
  };

  async runAction(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}${API.actions}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type, requestId: crypto.randomUUID(), ...fields }),
    });
    // 先查状态码再信任载荷：代理 HTML / 纯文本错误体必须是带状态的 ActionError，不是裸 SyntaxError
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = { error: `action failed with ${res.status}` };
    }
    if (!res.ok) throw new ActionError(res.status, body);
    return body;
  }

  /** 只登记可见会话并启动后台判定；命中缓存不写库，供 UI 按 revision 自动触发而不形成刷新环。 */
  assessVisible = async (threadIds: string[]): Promise<void> => {
    const unique = [...new Set(threadIds)];
    for (let start = 0; start < unique.length; start += SYSTEMONE_VISIBLE_BATCH) {
      await this.runAction("systemone.visible", {
        threadIds: unique.slice(start, start + SYSTEMONE_VISIBLE_BATCH),
      });
    }
  };

  /** 显式强制再判定（绕过缓存）；按钮专用，自动触发器不得调用。 */
  refreshVerdict = async (threadId: string): Promise<Record<string, unknown>> =>
    this.runAction("systemone.refresh", { threadId });

  /** 只清该线程的判定断路器，不影响 Harness 会话状态。 */
  resumeVerdict = async (threadId: string): Promise<Record<string, unknown>> =>
    this.runAction("systemone.resume", { threadId });
}
