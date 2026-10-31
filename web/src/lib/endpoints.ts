/**
 * 后端 HTTP 路由的前端唯一声明处（晨析条目 6）：web 层不再散写 `/api/...` 字符串，
 * 路由改名/加域在此单点改。后端路由面在 src/http.ts；本文件与其对齐由
 * test/revision-domains.test.ts 的契约测试钉住（域集合两侧漂移变红）。
 */

/** 固定路由（无参数）。 */
export const API = {
  state: "/api/state",
  events: "/api/events",
  actions: "/api/actions",
} as const;

/** 线程详情根端点（原生状态/绑定/lineage/最近 turn/摘要入口）。 */
export const threadDetailEndpoint = (threadId: string): string =>
  `/api/threads/${encodeURIComponent(threadId)}`;

/** 线程摘要分页。 */
export const threadSummariesEndpoint = (threadId: string): string =>
  `${threadDetailEndpoint(threadId)}/summaries`;

/** 线程子资源分页（turns / evidence 等以 kind 区分）。 */
export const threadChildrenEndpoint = (threadId: string, kind: string): string =>
  `${threadDetailEndpoint(threadId)}/${kind}`;

/** 任务详情（web 端经 BoardModel.getJson 拉取）。 */
export const taskDetailEndpoint = (taskId: string): string => `/api/tasks/${encodeURIComponent(taskId)}`;

/**
 * revision 域集合的前端副本（后端唯一声明处在 src/types.ts 的 REVISION_DOMAINS）。
 * 两侧一致由 test/revision-domains.test.ts 契约钉死；board-model 对未知域保守重拉，
 * 本副本供编译期引用与漂移检测，不改变运行时行为。
 */
export const REVISION_DOMAINS = ["tasks", "threads", "config"] as const;
export type RevisionDomain = (typeof REVISION_DOMAINS)[number];
