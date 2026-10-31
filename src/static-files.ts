/**
 * 静态产物服务：只读地提供前端构建目录（web/dist）。
 * 解析结果必须留在 webDir 内（防路径穿越）；未带扩展名的路径回落 SPA 入口，而不是 404。
 */

import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

export interface StaticFileResponse {
  contentType: string;
  cacheControl: string;
  body: Buffer;
}

/** UI 面的 CSP：脚本只许自身产物；样式放行内联（React 的 style 属性需要），但脚本面是硬边界。 */
export const STATIC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const INDEX_BASENAME = "index.html";

export const createStaticHandler = (webDir: string) => {
  const root = resolve(webDir);
  const entryPath = join(root, INDEX_BASENAME);
  const serveIndex = async (): Promise<StaticFileResponse | undefined> => {
    const entry = await existingFile(entryPath);
    return entry === undefined ? undefined : serve(entry);
  };
  return async (urlPath: string): Promise<StaticFileResponse | undefined> => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(urlPath);
    } catch {
      return undefined;
    }
    if (decoded === "/" || decoded === "") return serveIndex();
    if (decoded.includes("\0")) return undefined;
    // 先 normalize 再拼回 root：任何形态的 .. 都不允许越出产物目录
    const relative = normalize(decoded).replace(/^([.][.][/\\])+/, "");
    const absolute = resolve(root, `.${sep}${relative}`);
    if (!absolute.startsWith(root + sep)) return undefined;

    const file = await existingFile(absolute);
    if (file !== undefined) return serve(file);
    // SPA 回落仅对无扩展名路径：丢失的带扩展名产物应 404，而不是把 HTML 当脚本返回
    if (extname(decoded) === "") return serveIndex();
    return undefined;
  };
};

const existingFile = async (path: string): Promise<string | undefined> => {
  try {
    const info = await stat(path);
    return info.isFile() ? path : undefined;
  } catch {
    return undefined;
  }
};

const serve = async (path: string): Promise<StaticFileResponse> => {
  const contentType = MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  return {
    contentType,
    // 产物目录同时承担 dev 与 prod：入口与资产统一 no-store，改版即时生效（loopback 本机服务，无缓存收益）
    cacheControl: "no-store",
    body: await readFile(path),
  };
};
