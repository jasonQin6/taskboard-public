/**
 * daemon 静态服务（issue #6）：构建产物由 daemon 提供，CSP 限制脚本来源。
 * 直接装配 createHttpServer + 临时产物目录，不经 daemon 锁；收尾 shutdown() 内含 closeAllConnections。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { createHttpServer, type TaskboardHttp } from "../src/http.js";
import { SingleFlightRegistry } from "../src/single-flight.js";
import { Store } from "../src/store/index.js";
import type { ViewContext } from "../src/views.js";

const tmpDirs: string[] = [];
const servers: TaskboardHttp[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.shutdown();
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-static-"));
  tmpDirs.push(dir);
  return dir;
};

const writeFakeBuild = async (root: string): Promise<void> => {
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><html><body>board-entry-marker</body></html>");
  await writeFile(join(root, "assets", "app-abc123.js"), "console.log(1)");
  await writeFile(join(root, "assets", "app-abc123.css"), "body{}");
};

const boot = async (webDir?: string): Promise<{ port: number; base: string }> => {
  const dir = await makeTempDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const { db } = await openStateDb(dbPath);
  const store = new Store(db);
  const views: ViewContext = {
    store,
    singleFlight: new SingleFlightRegistry(),
    runtime: () => ({
      pid: process.pid,
      startedAt: new Date(0).toISOString(),
      powerProtection: "off",
      proxyGuard: false,
      driver: { available: false, note: "test" },
    }),
  };
  const http = createHttpServer({
    store,
    views,
    dbPath,
    ...(webDir !== undefined ? { webDir } : {}),
  });
  servers.push(http);
  const port = await new Promise<number>((resolve) => {
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return { port, base: `http://127.0.0.1:${port}` };
};

interface RawResponse {
  status: number;
  contentType: string;
  csp: string | undefined;
  cacheControl: string | undefined;
  body: string;
}

const rawGet = (port: number, path: string, method: "GET" | "HEAD" = "GET"): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          csp: res.headers["content-security-policy"],
          cacheControl: res.headers["cache-control"],
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });

interface BoardFixture {
  root: string;
  port: number;
  base: string;
}

const bootWithBoard = async (): Promise<BoardFixture> => {
  const dir = await makeTempDir();
  const root = join(dir, "webroot");
  await writeFakeBuild(root);
  const { port, base } = await boot(root);
  return { root, port, base };
};

test("static: serves index.html at / with CSP restricting scripts to self", async () => {
  const { port } = await bootWithBoard();
  const res = await rawGet(port, "/");
  assert.equal(res.status, 200);
  assert.match(res.contentType, /^text\/html/);
  assert.match(res.body, /board-entry-marker/);
  assert.match(res.csp ?? "", /script-src 'self'/);
  assert.equal(res.cacheControl, "no-store");
});

test("static: serves hashed assets with correct MIME and shared CSP", async () => {
  const { port } = await bootWithBoard();
  const js = await rawGet(port, "/assets/app-abc123.js");
  assert.equal(js.status, 200);
  assert.match(js.contentType, /^text\/javascript/);
  assert.match(js.csp ?? "", /script-src 'self'/);
  assert.equal(js.cacheControl, "no-store");
  const css = await rawGet(port, "/assets/app-abc123.css");
  assert.equal(css.status, 200);
  assert.match(css.contentType, /^text\/css/);
});

test("static: extension-less deep paths fall back to the SPA entry", async () => {
  const { port } = await bootWithBoard();
  const res = await rawGet(port, "/tasks/t-123/detail");
  assert.equal(res.status, 200);
  assert.match(res.contentType, /^text\/html/);
  assert.match(res.body, /board-entry-marker/);
});

test("static: path traversal never escapes webDir", async () => {
  const { port } = await bootWithBoard();
  for (const evil of ["/../taskboard.sqlite", "/..%2f..%2ftaskboard.sqlite", "/assets/%2e%2e/%2e%2e/taskboard.sqlite"]) {
    const res = await rawGet(port, evil);
    assert.ok(res.status === 404 || res.status === 400, evil);
    // SQLite 文件头是 "SQLite format 3"：头部泄露即为穿越成功
    assert.doesNotMatch(res.body, /SQLite format/);
    assert.match(res.body, /board build not found/);
  }
});

test("static: missing asset with extension 404s without falling back to the entry", async () => {
  const { port } = await bootWithBoard();
  const res = await rawGet(port, "/missing-abc123.png");
  assert.equal(res.status, 404);
});

test("static: HEAD returns headers without a body", async () => {
  const { port } = await bootWithBoard();
  const res = await rawGet(port, "/", "HEAD");
  assert.equal(res.status, 200);
  assert.match(res.contentType, /^text\/html/);
  assert.equal(res.body, "");
});

test("static: without webDir the board route 404s with a build hint; API keeps working", async () => {
  const { port, base } = await boot();
  const res = await rawGet(port, "/");
  assert.equal(res.status, 404);
  assert.match(res.body, /pnpm build:web/);
  const state = await fetch(`${base}/api/state`);
  assert.equal(state.status, 200);
});

test("static: with webDir the API surface is unchanged", async () => {
  const { base } = await bootWithBoard();
  const state = await fetch(`${base}/api/state`);
  assert.equal(state.status, 200);
  const body = (await state.json()) as Record<string, unknown>;
  assert.equal(body.ok, true);
});
