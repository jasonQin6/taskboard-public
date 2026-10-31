/**
 * HTTP 面：只绑 loopback、无认证。安全基线 = 代理栅栏（可选，默认关）→ CSRF（POST 必须 JSON + Origin/Host 回环或显式允许）。
 * SSE 只广播 {domain, revision, ids[]}，客户端按域重拉，不推全量快照。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { executeAction, type ActionContext } from "./actions.js";
import type { GoalService } from "./goals.js";
import { httpStatusFor } from "./errors.js";
import { evaluateProxyGuard, PROXY_TOKEN_HEADER, type ProxyGuardConfig } from "./http-guard.js";
import type { JevService } from "./jev.js";
import type { RunManager } from "./runs.js";
import {
  API_PREFIX,
  API_ROUTES,
  taskDetailRoute,
  threadDetailRoute,
  THREAD_SUBRESOURCE_KINDS,
  THREAD_SUBRESOURCE_ROUTES,
  type ParameterizedRoute,
  type ThreadSubresourceKind,
} from "./routes.js";
import { createStaticHandler, STATIC_CSP } from "./static-files.js";
import type { ReaderTurn, Store } from "./store/index.js";
import type { RevisionChange, Thread } from "./types.js";
import type { SummaryService } from "./summary.js";
import type { SystemOneService } from "./systemone/service.js";
import { stateView, taskDetail, type ViewContext } from "./views.js";
import type { WorktreeManager } from "./worktree.js";

export interface HttpServerOptions {
  store: Store;
  views: ViewContext;
  dbPath: string;
  /** Run 生命周期入口（daemon 装配）；缺省时 run.* 动作按「无 driver 运行时」明确 501。 */
  runs?: RunManager;
  /** goal/sample 执行面（daemon 装配）；缺省时 goal.* / thread.sample 明确 501。 */
  goals?: GoalService;
  /** isolated worktree 执行面（daemon 装配）；缺省时 worktree.clean 按无 worktree 运行时明确 501。 */
  worktrees?: WorktreeManager;
  /** 摘要评估数据面（daemon 装配）；缺省时 summary.* 按无评估运行时明确 501。 */
  summaries?: SummaryService;
  /** Jev 决策面（daemon 装配）；缺省时 jev.* / proposal.* 按无决策运行时明确 501。 */
  jev?: JevService;
  /** SystemOne 判定面（daemon 装配）；缺省时 systemone.* 按无判定运行时明确 501。 */
  systemone?: SystemOneService;
  proxyGuard?: ProxyGuardConfig;
  /** CSRF 允许的额外 Host/Origin 主机名（反代场景）；回环恒允许。 */
  allowedHosts?: readonly string[];
  sseHeartbeatMs?: number;
  /** 前端构建产物目录；缺省或目录缺 index.html 时看板路由返回带构建提示的 404。 */
  webDir?: string;
  /** daemon 日志缝：HTTP 面的异常事件（静态服务失败等）经它进 daemon 结构化日志。 */
  onLog?: (event: Record<string, unknown>) => void;
}

export interface TaskboardHttp {
  server: Server;
  /**
   * 收尾（ADR-0014）：先结束 SSE 长流与空闲 keep-alive，再停监听并排空在飞处理器
   * （应答仍可送达），全部排空后 closeAllConnections 兜底断连（fetch keep-alive 会挂住进程）。
   */
  shutdown: () => Promise<void>;
}

const MAX_BODY_BYTES = 1_048_576;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const isoOrNull = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** reader_sources 的一次性 sourceId→path 索引（避免逐 turn/逐摘要重扫全表）。 */
const readerSourcePaths = (store: Store): ReadonlyMap<string, string> =>
  new Map(store.listReaderSources().map((source) => [source.sourceId, source.path] as const));

/** turn locator 的 sourcePath：按 turn 自己的 sourceRef 解析；sourceRef=null（旧行）显式降级为线程最新 source。 */
const turnSourcePath = (
  sources: ReadonlyMap<string, string>,
  sourceRef: string | null,
  fallback: string | null,
): string | null => (sourceRef === null ? fallback : (sources.get(sourceRef) ?? null));

/** 摘要 locator 的 sourcePath：sourceId=null（sample/legacy）恒 null，不回退线程 rollout path 伪造来源。 */
const summarySourcePath = (sources: ReadonlyMap<string, string>, sourceId: string | null): string | null =>
  sourceId === null ? null : (sources.get(sourceId) ?? null);

/** turn 的线上形状（详情与 turns 分页共用；R↔U 契约：字段只增不删）。 */
const turnView = (turn: ReaderTurn, sourcePath: string | null): unknown => ({
  id: turn.id,
  threadId: turn.threadId,
  ordinal: turn.ordinal,
  nativeStatus: turn.nativeStatus,
  startedAt: isoOrNull(turn.startedAt),
  endedAt: isoOrNull(turn.endedAt),
  sourceRef: turn.sourceRef,
  locator: {
    sourceRef: turn.sourceRef,
    sourcePath,
    byteStart: turn.sourceByteStart,
    recordHash: turn.sourceRecordHash,
    kind: turn.sourceLocatorKind,
  },
});

/** GET /api/threads/:id 的详情载荷：原生状态、绑定、lineage、最近 turn、摘要入口；语义状态由 SystemOne 投影（未装配时 null）。 */
const threadDetail = (store: Store, thread: Thread, systemone?: SystemOneService): unknown => {
  const summary = store.latestThreadSummary(thread.id);
  const latestTurn = store.latestThreadTurn(thread.id);
  const identity = store.threadIdentity(thread.id);
  const sources = readerSourcePaths(store);
  const progressVerdict = systemone?.view(thread.id) ?? null;
  return {
    ...thread,
    harnessId: identity.harnessId,
    nativeSessionId: identity.nativeSessionId,
    locator: {
      harnessId: identity.harnessId,
      nativeSessionId: identity.nativeSessionId,
      sourcePath: identity.sourcePath,
      byteStart: identity.sourceByteStart,
      recordHash: identity.sourceRecordHash,
    },
    bindings: store.threadBindings(thread.id),
    lineage: store.threadLineage(thread.id),
    // 计数与分页同源（evidence 不含 superseded），避免详情与分页页脚对不上
    turnCount: store.listTurnsPage(thread.id, { limit: 1 }).total,
    evidenceCount: store.listEvidencePage(thread.id, { limit: 1 }).total,
    latestTurn:
      latestTurn === null
        ? null
        : turnView(latestTurn, turnSourcePath(sources, latestTurn.sourceRef, identity.sourcePath)),
    summary:
      summary === null
        ? null
        : {
            provenance: summary.provenance,
            text: summary.text,
            createdAt: summary.createdAt,
            superseded: summary.superseded,
            locator: {
              sourceRef: summary.sourceRef,
              sourceId: summary.sourceId,
              sourcePath: summarySourcePath(sources, summary.sourceId),
              byteStart: summary.byteStart,
              recordHash: summary.recordHash,
              coveredThroughTurnOrdinal: summary.coveredThroughTurnOrdinal,
            },
          },
    // stale 也显示旧 verdict 的 status（视图另有 state/degradation 提示），不把旧判断伪装成当前
    semanticStatus: progressVerdict?.verdict?.status ?? null,
    progressVerdict,
  };
};

/** turns/evidence 的 cursor 分页载荷（R↔U 契约形状：{ok, items, nextCursor}，cursor 为不透明偏移）。 */
const threadRecordsPage = (store: Store, threadId: string, kind: "turns" | "evidence", url: URL): unknown => {
  const limitText = url.searchParams.get("limit");
  // `?limit=`（空串）是笔误不是 0：回默认页宽，而不是钳出 1 条/页
  const limitRaw = limitText === null || limitText.trim() === "" ? DEFAULT_PAGE_SIZE : Number(limitText);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const offsetRaw = Number(url.searchParams.get("cursor") ?? 0);
  const offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  if (kind === "turns") {
    const { items, total } = store.listTurnsPage(threadId, { limit, offset });
    const sources = readerSourcePaths(store);
    const fallback = store.threadIdentity(threadId).sourcePath;
    const next = offset + items.length;
    return {
      ok: true,
      items: items.map((turn) => turnView(turn, turnSourcePath(sources, turn.sourceRef, fallback))),
      nextCursor: next < total ? String(next) : null,
    };
  }
  const { items, total } = store.listEvidencePage(threadId, { limit, offset });
  const next = offset + items.length;
  return {
    ok: true,
    items: items.map((item) => ({
      id: item.id,
      threadId: item.threadId,
      kind: item.kind,
      turnOrdinal: item.turnOrdinal,
      summary: item.summary,
      props: item.props,
      source: {
        sourceId: item.sourceId,
        sourcePath: item.sourcePath,
        byteStart: item.byteStart,
        recordHash: item.recordHash,
      },
      superseded: item.superseded,
      createdAt: item.createdAt,
    })),
    nextCursor: next < total ? String(next) : null,
  };
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'",
};

/** thread 域匹配表：详情与子资源同一模板族（子资源优先）。静态面，模块级只建一次（GET 读面被 UI 轮询）。 */
const THREAD_MATCHERS: ReadonlyArray<readonly [ParameterizedRoute<"threadId">, ThreadSubresourceKind | null]> = [
  ...THREAD_SUBRESOURCE_KINDS.map((kind) => [THREAD_SUBRESOURCE_ROUTES[kind], kind] as const),
  [threadDetailRoute, null],
];

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
};

const sendError = (res: ServerResponse, status: number, error: string): void =>
  sendJson(res, status, { ok: false, error });

/** Host 头 → 主机名（剥端口；IPv6 字面量保留方括号）。 */
const hostnameOf = (hostHeader: string): string => {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(0, end + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
};

const hostAllowed = (hostname: string, allowed: readonly string[]): boolean =>
  LOOPBACK_HOSTNAMES.has(hostname) || allowed.includes(hostname);

export type CsrfVerdict = { ok: true } | { ok: false; status: number; error: string };

/** CSRF 基线：POST 只收 application/json；Origin 存在则必须是允许来源，否则 Host 必须是允许主机。 */
export const checkCsrf = (
  headers: { "content-type"?: string; origin?: string; host?: string },
  allowedHosts: readonly string[] = [],
): CsrfVerdict => {
  const mediaType = (headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, error: "POST requires Content-Type: application/json" };
  }
  const origin = headers.origin;
  if (origin !== undefined) {
    let hostname: string | undefined;
    try {
      const url = new URL(origin);
      if (url.protocol === "http:" || url.protocol === "https:") hostname = url.hostname === "::1" ? "[::1]" : url.hostname;
    } catch {
      hostname = undefined;
    }
    // "null" origin（沙箱 iframe/file://）与非 http(s) 来源一律视为跨站
    if (hostname === undefined || !hostAllowed(hostname, allowedHosts)) {
      return { ok: false, status: 403, error: `cross-site request rejected (origin ${origin})` };
    }
    return { ok: true };
  }
  const host = headers.host;
  if (host === undefined || !hostAllowed(hostnameOf(host), allowedHosts)) {
    return { ok: false, status: 403, error: `request host not allowed (${host ?? "missing"})` };
  }
  return { ok: true };
};

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });

export const createHttpServer = (options: HttpServerOptions): TaskboardHttp => {
  const { store, views, dbPath } = options;
  const allowedHosts = options.allowedHosts ?? [];
  const sseClients = new Set<ServerResponse>();
  const actionCtx: ActionContext = {
    store,
    views,
    ...(options.runs !== undefined ? { runs: options.runs } : {}),
    ...(options.goals !== undefined ? { goals: options.goals } : {}),
    ...(options.worktrees !== undefined ? { worktrees: options.worktrees } : {}),
    ...(options.summaries !== undefined ? { summaries: options.summaries } : {}),
    ...(options.jev !== undefined ? { jev: options.jev } : {}),
    ...(options.systemone !== undefined ? { systemone: options.systemone } : {}),
  };
  const staticHandler = options.webDir !== undefined ? createStaticHandler(options.webDir) : undefined;

  const serveStatic = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> => {
    try {
      const file = staticHandler === undefined ? undefined : await staticHandler(pathname);
      if (file === undefined) {
        sendError(res, 404, "board build not found; run `pnpm build:web` to produce web/dist");
        return;
      }
      res.writeHead(200, {
        "content-type": file.contentType,
        "cache-control": file.cacheControl,
        "x-content-type-options": "nosniff",
        "content-security-policy": STATIC_CSP,
      });
      res.end(file.body);
    } catch (error) {
      // 调用点裸 void：这里的 rejection 没有 catch，Node >=24 会以 unhandledRejection 整体退出
      // daemon（如构建中途替换产物时 stat→readFile 竞态 ENOENT）
      options.onLog?.({
        event: "static_serve_failed",
        path: pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      if (res.headersSent) {
        res.end();
        return;
      }
      sendError(res, 500, "static asset read failed");
    }
  };

  const broadcast = (changes: RevisionChange[]): void => {
    for (const change of changes) {
      const frame = `event: revision\ndata: ${JSON.stringify(change)}\n\n`;
      for (const client of sseClients) client.write(frame);
    }
  };
  const unsubscribe = store.subscribe(broadcast);

  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(": ping\n\n");
  }, options.sseHeartbeatMs ?? 25_000);
  heartbeat.unref();

  const handleGet = (url: URL, res: ServerResponse): void => {
    const path = url.pathname;
    if (path === API_ROUTES.state) {
      sendJson(res, 200, stateView(views));
      return;
    }
    if (path === API_ROUTES.dbPath) {
      sendJson(res, 200, { ok: true, path: dbPath });
      return;
    }
    if (path === API_ROUTES.proposals) {
      sendJson(res, 200, { ok: true, proposals: store.listProposals({ limit: 200 }) });
      return;
    }
    if (path === API_ROUTES.annotations) {
      const taskId = url.searchParams.get("taskId") ?? undefined;
      sendJson(res, 200, {
        ok: true,
        annotations: store.listAnnotations(taskId === undefined ? {} : { taskId }),
      });
      return;
    }
    // 命名参数取用与解码统一走 match()（与 path() 的 encodeURIComponent 互逆）；畸形百分号编码按不匹配落 404
    const taskParams = taskDetailRoute.match(path);
    if (taskParams !== null) {
      const task = store.getTask(taskParams.taskId);
      if (task === null) {
        sendError(res, 404, "task not found");
        return;
      }
      sendJson(res, 200, { ok: true, task: taskDetail(views, task) });
      return;
    }
    // thread 域：详情与子资源同一模板族（子资源优先；并集互斥，未知子段仍 404，分发语义与单正则时代一致）
    for (const [route, kind] of THREAD_MATCHERS) {
      const params = route.match(path);
      if (params === null) continue;
      const threadId = params.threadId;
      const thread = store.listThreads().find((candidate) => candidate.id === threadId);
      if (thread === undefined) {
        sendError(res, 404, "thread not found");
        return;
      }
      if (kind === "summaries") {
        // 摘要读取（S2 故事 35：多轮结构化摘要）：全量列表无分页，nextCursor 恒 null 以贴合页面契约形状
        const sources = readerSourcePaths(store);
        sendJson(res, 200, {
          ok: true,
          items: store.listThreadSummaries(thread.id).map((summary) =>
            summary.superseded
              ? {
                  ...summary,
                  sourceRef: null,
                  sourceId: null,
                  byteStart: null,
                  recordHash: null,
                  coveredThroughTurnOrdinal: null,
                  locator: null,
                }
              : {
                  ...summary,
                  locator: {
                    sourceRef: summary.sourceRef,
                    sourceId: summary.sourceId,
                    sourcePath: summarySourcePath(sources, summary.sourceId),
                    byteStart: summary.byteStart,
                    recordHash: summary.recordHash,
                    coveredThroughTurnOrdinal: summary.coveredThroughTurnOrdinal,
                  },
                },
          ),
          nextCursor: null,
        });
        return;
      }
      if (kind !== null) {
        sendJson(res, 200, threadRecordsPage(store, thread.id, kind, url));
        return;
      }
      sendJson(res, 200, { ok: true, thread: threadDetail(store, thread, options.systemone) });
      return;
    }
    sendError(res, 404, "not found");
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    sseClients.add(res);
    req.on("close", () => {
      sseClients.delete(res);
    });
  };

  const handlePost = async (url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (url.pathname !== API_ROUTES.actions) {
      sendError(res, 404, "not found");
      return;
    }
    const csrf = checkCsrf(
      {
        "content-type": req.headers["content-type"],
        origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
        host: req.headers.host,
      },
      allowedHosts,
    );
    if (!csrf.ok) {
      sendError(res, csrf.status, csrf.error);
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendError(res, 400, error instanceof Error ? error.message : String(error));
      return;
    }
    try {
      const result = await executeAction(actionCtx, body);
      sendJson(res, result.status, result.body);
    } catch (error) {
      sendError(res, httpStatusFor(error), error instanceof Error ? error.message : String(error));
    }
  };

  // 在飞请求计数：shutdown 排空语义的依据（server.close 只能表达「连接终结」，表达不了「处理器排空」）
  let activeRequests = 0;
  let notifyDrained: (() => void) | null = null;

  const server = createServer((req, res) => {
    activeRequests += 1;
    res.once("close", () => {
      activeRequests -= 1;
      if (activeRequests === 0) notifyDrained?.();
    });
    const verdict = evaluateProxyGuard(options.proxyGuard, {
      method: req.method,
      remoteAddress: req.socket.remoteAddress,
      tokenHeader: req.headers[PROXY_TOKEN_HEADER],
    });
    if (!verdict.allowed) {
      sendError(res, verdict.status, verdict.error);
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" || req.method === "HEAD") {
      if (url.pathname === API_ROUTES.events) {
        handleEvents(req, res);
        return;
      }
      // 裸 /api 也是 API 域：落 JSON 404，而不是 SPA 回落把 HTML 当 API 响应
      if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
        void serveStatic(req, res, url.pathname);
        return;
      }
      handleGet(url, res);
      return;
    }
    if (req.method === "POST") {
      void handlePost(url, req, res);
      return;
    }
    sendError(res, 405, "method not allowed");
  });

  const shutdown = async (): Promise<void> => {
    unsubscribe();
    clearInterval(heartbeat);
    // SSE 是永不应答的长流：不先 end，server.close 永远等不到它们收尾
    for (const client of sseClients) client.end();
    sseClients.clear();
    server.closeIdleConnections();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // 排空在飞处理器（ADR-0014）：应答仍可送达。不能直接等 server.close 回调——它的语义是
    // 「等所有连接终结」，keep-alive 空闲连接没有自然终结点，会把关闭挂住数秒
    if (activeRequests > 0) {
      await new Promise<void>((resolve) => {
        notifyDrained = resolve;
      });
    }
    // 全部排空后再兜底断掉残余连接（fetch keep-alive 会挂住进程，ADR-0012），server.close 随即落定
    server.closeAllConnections();
    await closed;
  };

  return { server, shutdown };
};
