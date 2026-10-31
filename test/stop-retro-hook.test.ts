/**
 * stop-retro hook（#66）：子进程级行为测试——真实 stdin 载荷驱动 scripts/stop-retro.sh，
 * 断言注入输出与主库 retro 行为。载荷通道按 ZCode Stop hook 契约（snake_case 输入键 +
 * camelCase responseText，见 issue #66 机制事实），不 mock python/bash，因为脚本本身就是被测物。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { parseRetroRecordInput } from "../src/retro-input.js";
import { Store } from "../src/store/index.js";

const hookPath = fileURLToPath(new URL("../scripts/stop-retro.sh", import.meta.url));

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeDb = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-stop-retro-"));
  tmpDirs.push(dir);
  return join(dir, "taskboard.sqlite");
};

interface HookExit {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runHook = async (stdin: string, env: NodeJS.ProcessEnv = {}): Promise<HookExit> => {
  const child: ChildProcess = spawn("bash", [hookPath], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.end(stdin);
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`hook did not exit within 30s\nstderr: ${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
  });
};

const stopInput = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: "Stop",
  session_id: "sess_hook_case",
  permission_mode: "yolo",
  cwd: "/tmp/proj",
  stop_hook_active: false,
  ...overrides,
});

const retroJsonBlock = (payload: Record<string, unknown>): string =>
  "收尾总结如下：\n```json\n" + JSON.stringify(payload) + "\n```\n";

const modelPayload = {
  conclusion: "冒烟会话：验证 hook 载荷通道",
  findings: [
    {
      category: "checks",
      finding: "hook 行为缺回归测试",
      improvement: "补 stop-retro-hook 测试",
      evidence: "第1轮：注入后直接输出 json 块",
    },
  ],
  notCovered: ["交互会话未覆盖"],
};

const openStore = async (dbPath: string): Promise<Store> => {
  const { db } = await openStateDb(dbPath);
  return new Store(db);
};

/** 经 Store 事务层预置一行（等价 hook 已注入/已完成的状态），驱动门判定分支。 */
const seedRow = async (dbPath: string, overrides: Record<string, unknown>): Promise<void> => {
  const store = await openStore(dbPath);
  store.recordRetro(
    parseRetroRecordInput({
      source: "headless",
      sessionId: "sess_hook_case",
      cwd: "/tmp/proj",
      status: "open",
      attempts: 1,
      ...overrides,
    }),
  );
  store.db.close();
};

test("首次 Stop：注入 continuation 并落 open 行（headless、attempts=1）", async () => {
  const dbPath = await makeDb();
  const run = await runHook(JSON.stringify(stopInput()), { TASKBOARD_DB_PATH: dbPath });
  assert.equal(run.code, 0, run.stderr);
  const decision = JSON.parse(run.stdout) as { continue: boolean; additionalContext: string };
  assert.equal(decision.continue, true);
  assert.match(decision.additionalContext, /sess_hook_case/);
  assert.match(decision.additionalContext, /```json/);
  const store = await openStore(dbPath);
  const row = store.getRetro({ source: "headless", sessionId: "sess_hook_case" });
  assert.equal(row?.status, "open");
  assert.equal(row?.attempts, 1);
  store.db.close();
});

test("第二次 Stop（stop_hook_active）：从 responseText 提取 JSON 落 done 行，不再注入", async () => {
  const dbPath = await makeDb();
  await runHook(JSON.stringify(stopInput()), { TASKBOARD_DB_PATH: dbPath });
  const run = await runHook(
    JSON.stringify(
      stopInput({ stop_hook_active: true, responseText: retroJsonBlock(modelPayload) }),
    ),
    { TASKBOARD_DB_PATH: dbPath },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "", "成功结算后不再 continuation");
  const store = await openStore(dbPath);
  const row = store.getRetro({ source: "headless", sessionId: "sess_hook_case" });
  assert.equal(row?.status, "done");
  assert.equal(row?.conclusion, "冒烟会话：验证 hook 载荷通道");
  assert.equal(row?.findings.length, 1);
  assert.equal(row?.attempts, 1, "成功结算不消耗重试预算");
  store.db.close();
});

test("dwf- 前缀会话（DWF 子代理）两次 Stop 均不触发", async () => {
  const dbPath = await makeDb();
  for (const stopHookActive of [false, true]) {
    const run = await runHook(
      JSON.stringify(
        stopInput({
          session_id: "dwf-run42-site@ord7",
          stop_hook_active: stopHookActive,
          responseText: retroJsonBlock(modelPayload),
        }),
      ),
      { TASKBOARD_DB_PATH: dbPath },
    );
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "");
  }
  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 0);
  store.db.close();
});

test("ZCODE_HOOK_GUARD 置位时直接放行（防环）", async () => {
  const dbPath = await makeDb();
  const run = await runHook(JSON.stringify(stopInput()), {
    TASKBOARD_DB_PATH: dbPath,
    ZCODE_HOOK_GUARD: "1",
  });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "");
  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 0);
  store.db.close();
});

test("交互会话（permission_mode=default）同样触发，source=interactive", async () => {
  const dbPath = await makeDb();
  const run = await runHook(
    JSON.stringify(stopInput({ session_id: "sess_interactive", permission_mode: "default" })),
    { TASKBOARD_DB_PATH: dbPath },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal((JSON.parse(run.stdout) as { continue: boolean }).continue, true);
  const store = await openStore(dbPath);
  assert.equal(
    store.getRetro({ source: "interactive", sessionId: "sess_interactive" })?.status,
    "open",
  );
  store.db.close();
});

test("解析失败且 attempts<3：重试注入并消耗一次预算", async () => {
  const dbPath = await makeDb();
  await runHook(JSON.stringify(stopInput()), { TASKBOARD_DB_PATH: dbPath });
  const run = await runHook(
    JSON.stringify(stopInput({ stop_hook_active: true, responseText: "我没有输出 json 块" })),
    { TASKBOARD_DB_PATH: dbPath },
  );
  assert.equal(run.code, 0, run.stderr);
  const decision = JSON.parse(run.stdout) as { continue: boolean; additionalContext: string };
  assert.equal(decision.continue, true);
  assert.match(decision.additionalContext, /重试|重新/);
  const store = await openStore(dbPath);
  const row = store.getRetro({ source: "headless", sessionId: "sess_hook_case" });
  assert.equal(row?.status, "open");
  assert.equal(row?.attempts, 2);
  store.db.close();
});

test("解析失败且 attempts≥3：记 failed 并携带 lastError", async () => {
  const dbPath = await makeDb();
  await seedRow(dbPath, { attempts: 3 });
  const run = await runHook(
    JSON.stringify(stopInput({ stop_hook_active: true, responseText: "still no json" })),
    { TASKBOARD_DB_PATH: dbPath },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "");
  const store = await openStore(dbPath);
  const row = store.getRetro({ source: "headless", sessionId: "sess_hook_case" });
  assert.equal(row?.status, "failed");
  assert.ok(row?.lastError !== null);
  assert.equal(row?.attempts, 3);
  store.db.close();
});

test("已 done 的会话不再注入", async () => {
  const dbPath = await makeDb();
  await seedRow(dbPath, { status: "done", attempts: 1 });
  const run = await runHook(JSON.stringify(stopInput()), { TASKBOARD_DB_PATH: dbPath });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "");
  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 1, "不新增行");
  store.db.close();
});

test("fail-open：stdin 不是合法 JSON 时静默退出、不落库", async () => {
  const dbPath = await makeDb();
  const run = await runHook("{not-json", { TASKBOARD_DB_PATH: dbPath });
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "");
  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 0);
  store.db.close();
});
