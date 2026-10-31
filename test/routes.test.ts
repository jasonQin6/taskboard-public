/**
 * API 路由单源契约（issue #35）：src/routes.ts 是后端路由唯一声明处，http.ts 分发与 cli.ts
 * 取用同一来源。两条静态缝：
 * 1. 字面量归零哨兵：cli.ts/http.ts 不得再散写 /api/ 路由字面量（绕过单源即红）；
 * 2. 跨面契约：web 副本（endpoints.ts，跨进程边界的前端独立副本）可构造的每个端点
 *    都落在 routes 模式面内——后端路由面变更而副本未跟（或反向）在此变红。
 * routes 声明面与实际 HTTP 分发的对齐由 test/http.test.ts 的端到端断言钉住。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  API_PREFIX,
  API_ROUTES,
  taskDetailRoute,
  threadDetailRoute,
  THREAD_SUBRESOURCE_KINDS,
  THREAD_SUBRESOURCE_ROUTES,
} from "../src/routes.js";
import {
  API as WEB_API,
  taskDetailEndpoint as webTaskDetail,
  threadDetailEndpoint as webThreadDetail,
  threadSummariesEndpoint as webThreadSummaries,
  threadChildrenEndpoint as webThreadChildren,
} from "../web/src/lib/endpoints.js";

/** routes 全部模式（固定 + 参数化）：跨面契约的匹配面。 */
const ROUTE_PATTERNS: RegExp[] = [
  ...Object.values(API_ROUTES).map((path) => new RegExp(`^${path}$`)),
  taskDetailRoute.pattern,
  threadDetailRoute.pattern,
  ...THREAD_SUBRESOURCE_KINDS.map((kind) => THREAD_SUBRESOURCE_ROUTES[kind].pattern),
];

/** 递归枚举 src 下全部 .ts 文件（晨析 10-25：哨兵从两文件白名单改全目录，新散写文件自动进网）。 */
const listSrcTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSrcTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
};

test("src/ 全目录不再散写 /api/ 路由字面量（单源 = routes.ts，验收标准归零）", () => {
  // 匹配字符串字面量开头（"/api…）与正则字面量的转义形态（\/api…）；文档注释里的 /api/xxx 不带引号，不误伤。
  // routes.ts 是声明真值源自身豁免——豁免只剩"原因枚举"，不再有第二份文件清单真值源
  const literal = /["'`]\/api|\\\/api/g;
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const files = listSrcTsFiles(srcDir).filter((file) => !file.endsWith("routes.ts"));
  assert.ok(files.length > 20, "src/ 枚举未失效（防御哨兵自身退化为空集）");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const hits = [...text.matchAll(literal)].map((match) => match[0]);
    assert.deepEqual(hits, [], `${file} 出现 routes.ts 之外的路由字面量，请改引用 routes.js 常量`);
  }
});

test("web 端点副本可构造的每个端点都被 routes 模式面匹配——后端路由面变更而副本未跟即红", () => {
  // web 副本的全部可构造端点（detail-model 的 turns/evidence 分页走 threadChildrenEndpoint）
  const webEndpoints = [
    WEB_API.state,
    WEB_API.events,
    WEB_API.actions,
    webTaskDetail("t_1"),
    webThreadDetail("th_1"),
    webThreadSummaries("th_1"),
    webThreadChildren("th_1", "turns"),
    webThreadChildren("th_1", "evidence"),
  ];
  const unmatched = webEndpoints.filter((endpoint) => !ROUTE_PATTERNS.some((pattern) => pattern.test(endpoint)));
  assert.deepEqual(unmatched, [], "web 副本端点不在 routes 模式面内：路由面与前端副本漂移");
});

test("共有固定路由恒等：web API 常量与 routes 同名路由逐字相等（state/events/actions）", () => {
  // web 副本只声明它用到的三条固定路由；db/path、annotations、proposals 是 CLI/后端读面，web 无对应物
  assert.equal(WEB_API.state, API_ROUTES.state);
  assert.equal(WEB_API.events, API_ROUTES.events);
  assert.equal(WEB_API.actions, API_ROUTES.actions);
});

test("API 域前缀恒为 /api（裸 /api 与 /api/ 前缀判定的单源，spec 字面量）", () => {
  assert.equal(API_PREFIX, "/api");
  // 固定路由全部从 API_PREFIX 派生：前缀变更或复制粘贴出新前缀在此变红
  for (const [name, path] of Object.entries(API_ROUTES)) {
    assert.ok(path.startsWith(`${API_PREFIX}/`), `API_ROUTES.${name} (${path}) 必须从 API_PREFIX 派生`);
  }
});

// ---- 参数化路由 path/match 互逆契约（issue #35 ocr 复审：解码半边收进 match，命名组取用，畸形编码受控） ----

test("path 与 match 互逆：encodeURIComponent ↔ decodeURIComponent，命名参数取用", () => {
  const threadId = "th id/1%2"; // 空格、斜杠、百分号都走编码
  const url = threadDetailRoute.path({ threadId });
  assert.equal(url, `/api/threads/${encodeURIComponent(threadId)}`);
  assert.deepEqual(threadDetailRoute.match(url), { threadId });
  assert.deepEqual(taskDetailRoute.match(taskDetailRoute.path({ taskId: "t_1" })), { taskId: "t_1" });
  // 子资源路由的 match 只暴露自身模板的命名参数
  assert.deepEqual(THREAD_SUBRESOURCE_ROUTES.turns.match("/api/threads/th_1/turns"), { threadId: "th_1" });
});

test("match 无匹配（含跨段/未知子段/他域路径）返回 null；畸形百分号编码按不匹配处理而非抛 URIError", () => {
  assert.equal(threadDetailRoute.match("/api/threads/th_1/extra"), null, ":name 不跨段，未知子段不匹配");
  assert.equal(threadDetailRoute.match("/api/tasks/t_1"), null);
  assert.equal(threadDetailRoute.match("/api/threads/%E0%A4%A"), null, "截断 UTF-8 百分号编码 → null，交分发层 404 收口");
  assert.throws(
    () => taskDetailRoute.path({} as never),
    /missing param "taskId"/,
    "模板 :name 与 Params 漂移炸在出 URL 处，而不是发出 /api/tasks/undefined",
  );
});
