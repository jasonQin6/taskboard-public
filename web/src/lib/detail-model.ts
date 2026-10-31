/**
 * 线程详情数据层（框架无关，issue #12）：React 与 node 测试共用。
 * 消费 R↔U 契约冻结的 GET /api/threads/:id 与 turns/evidence cursor 分页载荷
 * {ok, items, nextCursor}（offset 型不透明 cursor）；只读消费，未知字段原样保留。
 * 收敛（A31）：threads 域 revision 推进时按详情载荷的 turnCount/evidenceCount 重拉全部已装载页，替换而非拼接。
 */
import type { ClientProgressVerdictView } from "./board-model.js";
import { threadChildrenEndpoint, threadDetailEndpoint, threadSummariesEndpoint } from "./endpoints.js";
import { createLatestOnly } from "./latest-only.js";

export interface ClientTurn {
  id: string;
  threadId: string;
  ordinal: number;
  nativeStatus: string;
  startedAt: string | null;
  endedAt: string | null;
  sourceRef: string;
  locator?: {
    sourceRef: string | null;
    sourcePath: string | null;
    byteStart: number | null;
    recordHash: string | null;
    kind?: "start" | "terminal" | null;
  };
  [key: string]: unknown;
}

export interface ClientEvidence {
  id: string;
  threadId: string;
  kind: string;
  turnOrdinal: number | null;
  summary: string | null;
  props: unknown;
  superseded: boolean;
  createdAt: string;
  source?: {
    sourceId: string;
    sourcePath: string | null;
    byteStart: number;
    recordHash: string;
  };
  [key: string]: unknown;
}

export interface ClientThreadSummary {
  id: string;
  threadId: string;
  provenance: string;
  text: string;
  sourceRef: string | null;
  sourceId?: string | null;
  byteStart?: number | null;
  recordHash?: string | null;
  coveredThroughTurnOrdinal?: number | null;
  superseded?: boolean;
  locator?: {
    sourceRef: string | null;
    sourceId: string | null;
    sourcePath: string | null;
    byteStart: number | null;
    recordHash: string | null;
    coveredThroughTurnOrdinal: number | null;
  } | null;
  createdAt: string;
  [key: string]: unknown;
}

export interface ClientThreadDetail {
  id: string;
  harnessId: string;
  nativeSessionId: string | null;
  locator: {
    harnessId: string;
    nativeSessionId: string | null;
    sourcePath: string | null;
    byteStart: number | null;
    recordHash: string | null;
  };
  nativeStatus: string;
  semanticStatus: string | null;
  progressVerdict: ClientProgressVerdictView | null;
  title: string | null;
  turnCount: number;
  evidenceCount: number;
  latestTurn: ClientTurn | null;
  summary: {
    provenance: string;
    text: string;
    createdAt: string;
    superseded: boolean;
    locator: {
      sourceRef: string | null;
      sourceId: string | null;
      sourcePath: string | null;
      byteStart: number | null;
      recordHash: string | null;
      coveredThroughTurnOrdinal: number | null;
    } | null;
  } | null;
  lineage: { parents: unknown[]; children: unknown[] };
  bindings: Array<{ taskId: string; threadId: string; role: string; boundAt: string }>;
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  primaryTaskId: string | null;
  ignored: boolean;
  [key: string]: unknown;
}

export interface ThreadDetailState {
  threadId: string | null;
  detail: ClientThreadDetail | null;
  turns: ClientTurn[];
  /** null = 没有更多页。 */
  turnsCursor: string | null;
  evidence: ClientEvidence[];
  evidenceCursor: string | null;
  summaries: ClientThreadSummary[];
  loading: boolean;
  error: string | null;
}

export interface RevisionEvent {
  domain: string;
  revision: number;
  ids: string[];
}

export interface ThreadDetailModelOptions {
  /** 传输注入缝（观测/测试）；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** turns/evidence 每页条数（契约上限 200）。 */
  pageSize?: number;
}

const EMPTY_STATE: ThreadDetailState = {
  threadId: null,
  detail: null,
  turns: [],
  turnsCursor: null,
  evidence: [],
  evidenceCursor: null,
  summaries: [],
  loading: false,
  error: null,
};

const parsePage = (body: unknown): { items: unknown[]; nextCursor: string | null } => {
  if (typeof body !== "object" || body === null) throw new Error("page payload is not an object");
  const raw = body as Record<string, unknown>;
  return {
    items: Array.isArray(raw.items) ? raw.items : [],
    nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null,
  };
};

export class ThreadDetailModel {
  private state: ThreadDetailState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  /**
   * reload 的 latest-only 槽位（issue #36 收敛，取代原手写「在飞 + 排队」旗标与 threadId 复捕守卫）：
   * key 即 threadId——请求发起时捕获，结果返回时已切线程则丢弃；在飞时后续 reload 排队
   * （keep-last），丢弃/吞错路径的排队意图由原语内部补跑（晨析 10-25 内化 rescue）。
   * loading 置位与错误落地为模型私有语义，分别挂在 onAcquire / onError。
   */
  private readonly reloads = createLatestOnly<string | null>({
    getKey: () => this.state.threadId,
    onAcquire: () => this.set({ loading: true }),
    onError: (error) => {
      // 失败保留已有数据（看板仍可读），错误经状态暴露给视图；不外抛（open 的失败契约在 open 内判定）
      this.set({ loading: false, error: error instanceof Error ? error.message : String(error) });
    },
  });
  private inFlightTurns = false;
  private inFlightEvidence = false;
  /** 用户翻页意图（已扩大的窗口下限）：SSE 重拉不得把窗口缩回第一页。 */
  private turnsWindowFloor = 0;
  private evidenceWindowFloor = 0;

  constructor(
    private readonly baseUrl: string,
    options: ThreadDetailModelOptions = {},
  ) {
    // 浏览器的 fetch 是 Window 方法：解引用调用会 Illegal invocation，必须包一层保留 this
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 200);
  }

  // useSyncExternalStore 会解引用传入的读取器：getState 必须与 subscribe 一样是绑定成员
  getState = (): ThreadDetailState => {
    return this.state;
  };

  /** useSyncExternalStore 兼容：引用相等即不重渲染。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<ThreadDetailState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${path} failed with ${res.status}`);
    return res.json();
  }

  /** 打开线程：重置状态后装载详情与首页 turns/evidence（分页窗口由 load-more 扩大）。 */
  open = async (threadId: string): Promise<void> => {
    this.turnsWindowFloor = 0;
    this.evidenceWindowFloor = 0;
    // 在途翻页属于旧线程：合并旗标不复位的话，新线程的 load-more 会被旧请求静默吞掉
    this.inFlightTurns = false;
    this.inFlightEvidence = false;
    this.state = { ...EMPTY_STATE, threadId };
    this.emit();
    await this.reload();
    // 初次打开线程不存在等失败要向调用方抛出；reload 本身不抛（保已有数据）
    if (this.state.detail === null && this.state.error !== null) throw new Error(this.state.error);
  };

  /**
   * 全量重载：拉满「当前已装载窗口」（至少一页、至少到用户翻页下限），页序替换保证不重不漏。
   * 新 turn/evidence 只会追加在尾部（ordinal / created_at 序），窗口内旧条目原位刷新，
   * 窗口外新条目由详情载荷的 turnCount/evidenceCount 计数暴露、load-more 取入。
   * 并发语义（含 key 变化丢弃、排队自救）由 latest-only 槽位承担。
   */
  reload = async (): Promise<void> => {
    if (this.state.threadId === null) return;
    await this.reloads.run(
      async (threadId) => {
        // threadId === null 为纯防御分支（公开 API 不可达：捕获与比较之间没有 await 缝隙，
        // close/open 只会经由 key 变化丢弃命中）：与原实现一致，不发请求、不落状态
        if (threadId === null) return null;
        // 详情与 turns/evidence/summaries 相互独立（cursorAfter 只在落状态时用）：
        // 并行一趟拉齐，SSE 触发的重载不用付三倍串行往返
        const [detailBody, turnsRaw, evidenceRaw, summariesBody] = await Promise.all([
          this.getJson(threadDetailEndpoint(threadId)),
          this.loadAllPages(threadId, "turns", () => this.turnsWindow(), []),
          this.loadAllPages(threadId, "evidence", () => this.evidenceWindow(), []),
          this.getJson(threadSummariesEndpoint(threadId)),
        ]);
        return { detailBody, turnsRaw, evidenceRaw, summariesBody };
      },
      (raw) => {
        if (raw === null) return; // 对应 op 的防御早退
        const detail = (raw.detailBody as Record<string, unknown>).thread as ClientThreadDetail;
        const turns = raw.turnsRaw as ClientTurn[];
        const evidence = raw.evidenceRaw as ClientEvidence[];
        this.set({
          detail,
          turns,
          turnsCursor: this.cursorAfter(turns.length, detail.turnCount),
          evidence,
          evidenceCursor: this.cursorAfter(evidence.length, detail.evidenceCount),
          summaries: Array.isArray((raw.summariesBody as Record<string, unknown>).items)
            ? ((raw.summariesBody as Record<string, unknown>).items as ClientThreadSummary[])
            : [],
          loading: false,
          error: null,
        });
      },
    );
  };

  private turnsWindow(): number {
    return Math.max(this.state.turns.length, this.turnsWindowFloor, this.pageSize);
  }

  private evidenceWindow(): number {
    return Math.max(this.state.evidence.length, this.evidenceWindowFloor, this.pageSize);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private cursorAfter(loaded: number, total: number): string | null {
    return loaded < total ? String(loaded) : null;
  }

  /** 从 offset 0 顺序拉页直到拿满 target() 条或服务端说没了；页替换不拼接，天然去重。 */
  private async loadAllPages(
    threadId: string,
    kind: "turns" | "evidence",
    target: () => number,
    initial: unknown[],
  ): Promise<unknown[]> {
    const items: unknown[] = [...initial];
    let cursor: string | null = "0";
    while (cursor !== null) {
      const page = parsePage(
        await this.getJson(
          `${threadChildrenEndpoint(threadId, kind)}?limit=${this.pageSize}&cursor=${cursor}`,
        ),
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      if (items.length >= target()) break;
    }
    return items;
  }

  /** 装载 turns 下一页（cursor 追加式）；并发调用合并为一次。 */
  loadMoreTurns = async (): Promise<void> => {
    const cursor = this.state.turnsCursor;
    const threadId = this.state.threadId;
    if (cursor === null || threadId === null || this.inFlightTurns) return;
    this.inFlightTurns = true;
    try {
      const page = parsePage(
        await this.getJson(`${threadChildrenEndpoint(threadId, "turns")}?limit=${this.pageSize}&cursor=${cursor}`),
      );
      // 期间切换/关闭了线程：过期页直接丢弃，不得拼进新线程的时间线或改写其 cursor
      if (this.state.threadId !== threadId) return;
      const turns = [...this.state.turns, ...page.items] as ClientTurn[];
      this.turnsWindowFloor = Math.max(this.turnsWindowFloor, turns.length);
      this.set({ turns, turnsCursor: page.nextCursor });
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.inFlightTurns = false;
    }
  };

  /** 装载 evidence 下一页（cursor 追加式）；并发调用合并为一次。 */
  loadMoreEvidence = async (): Promise<void> => {
    const cursor = this.state.evidenceCursor;
    const threadId = this.state.threadId;
    if (cursor === null || threadId === null || this.inFlightEvidence) return;
    this.inFlightEvidence = true;
    try {
      const page = parsePage(
        await this.getJson(
          `${threadChildrenEndpoint(threadId, "evidence")}?limit=${this.pageSize}&cursor=${cursor}`,
        ),
      );
      // 同 loadMoreTurns：切线程后过期页直接丢弃
      if (this.state.threadId !== threadId) return;
      const evidence = [...this.state.evidence, ...page.items] as ClientEvidence[];
      this.evidenceWindowFloor = Math.max(this.evidenceWindowFloor, evidence.length);
      this.set({ evidence, evidenceCursor: page.nextCursor });
    } catch (error) {
      this.set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.inFlightEvidence = false;
    }
  };

  /** BoardModel 的 revision 事件入口：threads 域推进才重载（提案/绑定/turn 落库都推 threads 域）。 */
  handleRevisionEvent = (change: RevisionEvent): void => {
    if (change.domain !== "threads") return;
    if (this.state.threadId === null) return;
    void this.reload();
  };

  /** 关闭详情并复位状态（不持有网络资源，SSE 归 BoardModel）。 */
  close = (): void => {
    this.turnsWindowFloor = 0;
    this.evidenceWindowFloor = 0;
    this.inFlightTurns = false;
    this.inFlightEvidence = false;
    this.state = EMPTY_STATE;
    this.emit();
  };
}
