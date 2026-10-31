/**
 * 后端 API 路由唯一声明处（issue #35；web/src/lib/endpoints.ts 的后端对称）：
 * http.ts 分发与 cli.ts 取用同一来源——固定路由记录 + 参数化路由（模板派生 pattern 与 path）。
 * web 侧文件是跨进程边界的前端独立副本，不 import 此处；三边一致由
 * test/routes.test.ts（字面量归零 + 跨面契约）与 test/http.test.ts（声明面 ↔ 实际分发）钉住。
 */

/** API 域前缀：静态回落与 API JSON 404 的分界（裸 /api 与 /api/ 前缀本身也是路由面）。 */
export const API_PREFIX = "/api";

/** 固定路由（无路径参数）：actions 是 POST 写面入口，events 是 SSE 长流，其余为 GET 读面。全部从 API_PREFIX 派生，前缀漂移不可能只在字面量层发生。 */
export const API_ROUTES = {
  state: `${API_PREFIX}/state`,
  dbPath: `${API_PREFIX}/db/path`,
  proposals: `${API_PREFIX}/proposals`,
  annotations: `${API_PREFIX}/annotations`,
  actions: `${API_PREFIX}/actions`,
  events: `${API_PREFIX}/events`,
} as const;

/** thread 子资源只读面：turns/evidence 为 cursor 分页，summaries 为全量列表。 */
export const THREAD_SUBRESOURCE_KINDS = ["turns", "evidence", "summaries"] as const;
export type ThreadSubresourceKind = (typeof THREAD_SUBRESOURCE_KINDS)[number];

/** 参数化路由：pattern 供分发（`:name` 段为命名捕获，非空单段），path 供取用（各参数段 encodeURIComponent），match 供反向解码。 */
export interface ParameterizedRoute<Params extends string> {
  readonly pattern: RegExp;
  readonly path: (params: Record<Params, string>) => string;
  /**
   * 反向取用：pathname → 已 decodeURIComponent 的命名参数（无匹配为 null），与 path() 的 encodeURIComponent 互逆。
   * 畸形百分号编码（decodeURIComponent 抛 URIError）按不匹配处理返回 null → 分发层落 JSON 404 "not found"，
   * 而不是把异常抛出请求 handler（旧行为是未捕获 crash）。
   */
  readonly match: (pathname: string) => Record<Params, string> | null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 模板编译：`:name` 段 → 命名捕获 `(?<name>[^/]+)`，字面段正则转义；pattern、path、match 从同一模板派生。 */
const defineRoute = <Params extends string>(template: string): ParameterizedRoute<Params> => {
  const segments = template.split("/");
  const pattern = new RegExp(
    `^${segments
      .map((segment) => (segment.startsWith(":") ? `(?<${segment.slice(1)}>[^/]+)` : escapeRegExp(segment)))
      .join("/")}$`,
  );
  return {
    pattern,
    path: (params) =>
      segments
        .map((segment) => {
          if (!segment.startsWith(":")) return segment;
          const name = segment.slice(1);
          const value = params[name as Params];
          // 守卫：模板 :name 与 Params 类型漂移（如改名漏改调用点）时炸在出 URL 处，而不是发出 /api/tasks/undefined
          if (value === undefined) throw new Error(`route ${template}: missing param "${name}"`);
          return encodeURIComponent(value);
        })
        .join("/"),
    match: (pathname) => {
      const exec = pattern.exec(pathname);
      if (exec === null) return null;
      const params: Record<string, string> = {};
      for (const [name, raw] of Object.entries(exec.groups ?? {})) {
        try {
          params[name] = decodeURIComponent(raw!);
        } catch {
          return null; // 畸形百分号编码（截断的 UTF-8 等）视为路由不匹配，交由上层 404 收口
        }
      }
      return params as Record<Params, string>;
    },
  };
};

/** 任务详情读面。 */
export const taskDetailRoute = defineRoute<"taskId">("/api/tasks/:taskId");

/** 线程详情读面。 */
export const threadDetailRoute = defineRoute<"threadId">("/api/threads/:threadId");

/** thread 子资源路由表：kind 由 THREAD_SUBRESOURCE_KINDS 单源派生（加子资源只改 KINDS 一处）。 */
export const THREAD_SUBRESOURCE_ROUTES = Object.fromEntries(
  THREAD_SUBRESOURCE_KINDS.map((kind) => [kind, defineRoute<"threadId">(`/api/threads/:threadId/${kind}`)]),
) as Record<ThreadSubresourceKind, ParameterizedRoute<"threadId">>;
