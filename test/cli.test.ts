/**
 * CLI：进程内 main() 覆盖全部基础命令与退出码（0/1/2/3）；子进程覆盖 `start` 的双启失败与 SIGTERM 放锁（A25 的 CLI 侧）。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { EXIT_FAILURE, EXIT_OK, EXIT_UNREACHABLE, EXIT_USAGE, main } from "../src/cli.js";
import { daemonLockPathFor } from "../src/daemon-lock.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录（本文件进程内生效，spawn 子进程继承）
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-cli-"));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-cli-"));
  tmpDirs.push(dir);
  return dir;
};

const bootDaemon = async (): Promise<{ daemon: RunningDaemon; url: string }> => {
  const dir = await makeDir();
  const daemon = await startDaemon({ port: 0, dbPath: join(dir, "taskboard.sqlite") });
  daemons.push(daemon);
  return { daemon, url: `http://127.0.0.1:${daemon.port}` };
};

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 调 main() 并截获 stdout/stderr（恢复原函数，避免污染测试运行器输出）。 */
const cli = async (argv: string[]): Promise<CliResult> => {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
};

const json = <T>(result: CliResult): T => JSON.parse(result.stdout) as T;

const FAKE_APP_SERVER_PATH = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

/** 带 driver 的 boot 变体：run/cancel CLI 测试经假 app-server 走真 Run，绝不 spawn 真 codex。 */
const bootDriverDaemon = async (driverEnv: Record<string, string> = {}): Promise<{ daemon: RunningDaemon; url: string }> => {
  const dir = await makeDir();
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(dir, "taskboard.sqlite"),
    driver: {
      command: process.execPath,
      args: [FAKE_APP_SERVER_PATH],
      env: { ...process.env, FAKE_TURN_DELAY_MS: "30", ...driverEnv },
    },
  });
  daemons.push(daemon);
  return { daemon, url: `http://127.0.0.1:${daemon.port}` };
};

test("task lifecycle through the CLI with --json and exit 0", async () => {
  const { url } = await bootDaemon();
  const u = ["--url", url, "--json"];
  const created = await cli(["create", "--title", "Demo", "--workspace", "/tmp/ws", "--label", "x", "--cron", "0 9 * * *", ...u]);
  assert.equal(created.code, EXIT_OK, created.stderr);
  const task = json<{ ok: true; task: { id: string; status: string; schedule: { cron: string } } }>(created).task;
  assert.equal(task.status, "todo");
  assert.equal(task.schedule.cron, "0 9 * * *");

  const list = await cli(["list", ...u]);
  assert.equal(json<{ ok: true; tasks: unknown[] }>(list).tasks.length, 1);

  const got = await cli(["get", task.id, ...u]);
  assert.equal(got.code, EXIT_OK);
  assert.equal(json<{ task: { id: string } }>(got).task.id, task.id);

  const updated = await cli(["update", task.id, "--title", "Demo 2", "--clear-cron", ...u]);
  assert.equal(updated.code, EXIT_OK, updated.stderr);
  assert.equal(json<{ task: { title: string; schedule: null } }>(updated).task.title, "Demo 2");
  assert.equal(json<{ task: { schedule: null } }>(updated).task.schedule, null);

  const moved = await cli(["move", task.id, "done", ...u]);
  assert.equal(json<{ task: { status: string } }>(moved).task.status, "done");

  const archived = await cli(["archive", task.id, ...u]);
  assert.equal(json<{ task: { archived: boolean } }>(archived).task.archived, true);
  const hidden = await cli(["list", ...u]);
  assert.equal(json<{ tasks: unknown[] }>(hidden).tasks.length, 0);
  const shown = await cli(["list", "--archived", ...u]);
  assert.equal(json<{ tasks: unknown[] }>(shown).tasks.length, 1);
  const unarchived = await cli(["unarchive", task.id, ...u]);
  assert.equal(json<{ task: { archived: boolean } }>(unarchived).task.archived, false);

  const waited = await cli(["wait", task.id, ...u]);
  assert.equal(waited.code, EXIT_OK);
  assert.equal(json<{ quiet: boolean }>(waited).quiet, true);

  const paused = await cli(["pause-automation", ...u]);
  assert.equal(json<{ automationPaused: boolean }>(paused).automationPaused, true);
  const resumed = await cli(["resume-automation", ...u]);
  assert.equal(json<{ automationPaused: boolean }>(resumed).automationPaused, false);

  const status = await cli(["status", ...u]);
  assert.equal(status.code, EXIT_OK);
  assert.equal(json<{ tasks: number }>(status).tasks, 1);

  const deleted = await cli(["delete", task.id, ...u]);
  assert.equal(deleted.code, EXIT_OK);
  assert.deepEqual(json<{ deleted: { id: string } }>(deleted).deleted.id, task.id);
});

test("human output lines are readable and errors are one line on stderr", async () => {
  const { url } = await bootDaemon();
  const created = await cli(["create", "--title", "Human", "--url", url]);
  assert.match(created.stdout, /^created t_\w+ \(todo\): Human\n$/);
  const missing = await cli(["get", "t_nope", "--url", url]);
  assert.equal(missing.code, EXIT_FAILURE);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr.split("\n").filter((line) => line.length > 0).length, 1);
  assert.match(missing.stderr, /^Error: task not found\n$/);
});

test("exit 2 for usage errors: unknown command, missing id, invalid flag, no command", async () => {
  const { url } = await bootDaemon();
  const unknown = await cli(["frobnicate", "--url", url]);
  assert.equal(unknown.code, EXIT_USAGE);
  assert.match(unknown.stderr, /unknown command: frobnicate/);
  const noId = await cli(["get", "--url", url]);
  assert.equal(noId.code, EXIT_USAGE);
  assert.match(noId.stderr, /taskId is required/);
  // 缺参文案跟命令的实际参数走：晨析 10-25 条目——复用校验器曾让 thread/proposal 命令报 taskId
  const noThreadId = await cli(["inspect-thread", "--url", url]);
  assert.equal(noThreadId.code, EXIT_USAGE);
  assert.match(noThreadId.stderr, /threadId is required/);
  const noProposalId = await cli(["accept-proposal", "--url", url]);
  assert.equal(noProposalId.code, EXIT_USAGE);
  assert.match(noProposalId.stderr, /proposalId is required/);
  const badFlag = await cli(["create", "--title", "x", "--bogus", "--url", url]);
  assert.equal(badFlag.code, EXIT_USAGE);
  const noTitle = await cli(["create", "--url", url]);
  assert.equal(noTitle.code, EXIT_USAGE);
  assert.match(noTitle.stderr, /--title is required/);
  const bare = await cli([]);
  assert.equal(bare.code, EXIT_USAGE);
  assert.match(bare.stdout, /^taskboard — /);
  const help = await cli(["help"]);
  assert.equal(help.code, EXIT_OK);
});

test("exit 1 for semantic failures; exit 3 when the daemon is unreachable", async () => {
  const { url } = await bootDaemon();
  const badStatus = await cli(["move", "t_x", "doing", "--url", url]);
  assert.equal(badStatus.code, EXIT_FAILURE);
  const relative = await cli(["create", "--title", "x", "--workspace", "relative", "--url", url]);
  assert.equal(relative.code, EXIT_FAILURE);
  assert.match(relative.stderr, /absolute/);
  // proposals/summaries 是真实读面：未知线程按语义失败（exit 1），不是“构建未实现”
  const missingSummaries = await cli(["summaries", "t_x", "--url", url]);
  assert.equal(missingSummaries.code, EXIT_FAILURE);
  assert.match(missingSummaries.stderr, /thread not found/);
  const unreachable = await cli(["status", "--url", "http://127.0.0.1:1"]);
  assert.equal(unreachable.code, EXIT_UNREACHABLE);
  assert.match(unreachable.stderr, /cannot reach taskboard daemon/);
});

test("wait times out with exit 1 and a human hint when a run stays active", async () => {
  const { daemon, url } = await bootDaemon();
  const created = await cli(["create", "--title", "busy", "--workspace", "/tmp/ws", "--url", url, "--json"]);
  const id = json<{ task: { id: string } }>(created).task.id;
  daemon.store.createRun(id, "manual");
  const waited = await cli(["wait", id, "--timeout", "1", "--url", url]);
  assert.equal(waited.code, EXIT_FAILURE);
  assert.match(waited.stderr, /still active after 1s/);
});

test("run/cancel go through real Runs: --json payload, exit 0, human line, cancel interrupts a hanging turn", async () => {
  const { url } = await bootDriverDaemon();
  const u = ["--url", url];
  const created = await cli(["create", "--title", "cli run", "--prompt", "work", "--workspace", "/tmp/ws", ...u, "--json"]);
  const id = json<{ task: { id: string } }>(created).task.id;

  const requestId = "cli-run-once";
  const started = await cli(["run", id, "--request-id", requestId, ...u, "--json"]);
  assert.equal(started.code, EXIT_OK, started.stderr);
  const payload = json<{ ok: true; run: { id: string; taskId: string; status: string; trigger: string } }>(started);
  assert.equal(payload.ok, true);
  assert.equal(payload.run.taskId, id);
  assert.equal(payload.run.trigger, "manual");
  assert.ok(["queued", "running"].includes(payload.run.status));
  const quiet = await cli(["wait", id, "--timeout", "10", ...u]);
  assert.equal(quiet.code, EXIT_OK, quiet.stderr);
  // 幂等重放：同 --request-id 复用缓存响应，不再起第二个 Run
  const again = await cli(["run", id, "--request-id", requestId, ...u, "--json"]);
  assert.equal(json<{ run: { id: string } }>(again).run.id, payload.run.id);

  const hangTask = await cli(["create", "--title", "cli cancel", "--prompt", "[hang] hang", "--workspace", "/tmp/ws", ...u, "--json"]);
  const hangId = json<{ task: { id: string } }>(hangTask).task.id;
  await cli(["run", hangId, ...u]);
  const cancelled = await cli(["cancel", hangId, ...u]);
  assert.equal(cancelled.code, EXIT_OK, cancelled.stderr);
  assert.match(cancelled.stdout, /^cancelled r_/);
  const settled = await cli(["wait", hangId, "--timeout", "5", ...u, "--json"]);
  assert.equal(settled.code, EXIT_OK);
  assert.equal(json<{ lastRun: { status: string } | null }>(settled).lastRun?.status, "cancelled");
});

test("goal subcommand drives the native goal: set/get/pause lines, goal text from task, usage error, help entry", async () => {
  const { url } = await bootDriverDaemon();
  const u = ["--url", url];
  const created = await cli([
    "create", "--title", "cli goal", "--prompt", "goal work", "--workspace", "/tmp/ws", "--goal", ...u, "--json",
  ]);
  const id = json<{ task: { id: string } }>(created).task.id;
  const started = await cli(["run", id, ...u]);
  assert.equal(started.code, EXIT_OK, started.stderr);
  const quiet = await cli(["wait", id, "--timeout", "10", ...u]);
  assert.equal(quiet.code, EXIT_OK, quiet.stderr);

  const set = await cli(["goal", "set", id, ...u]);
  assert.equal(set.code, EXIT_OK, set.stderr);
  assert.match(set.stdout, /^goal set /);

  // goal 文本来自任务目标与验收描述，不接受自由文本（用户故事 61）
  const got = await cli(["goal", "get", id, ...u, "--json"]);
  assert.equal(got.code, EXIT_OK, got.stderr);
  const payload = json<{ ok: true; goal: { op: string; goalStatus: string | null; text: string | null } }>(got);
  assert.equal(payload.goal.op, "get");
  assert.equal(payload.goal.goalStatus, "active");
  assert.match(payload.goal.text ?? "", /goal work/);

  const paused = await cli(["goal", "pause", id, ...u]);
  assert.equal(paused.code, EXIT_OK, paused.stderr);
  assert.match(paused.stdout, /status paused/);

  const usage = await cli(["goal", "wat", id, "--url", url]);
  assert.equal(usage.code, EXIT_USAGE);
  assert.match(usage.stderr, /usage: taskboard goal/);

  // help 列出 goal 子命令
  const help = await cli(["--help"]);
  assert.match(help.stdout, /taskboard goal </);
});

test("thread commands: bind/unbind/ignore/unignore through actions, inspect-thread reads the detail feed", async () => {
  const { daemon, url } = await bootDaemon();
  const u = ["--url", url, "--json"];
  daemon.store.upsertThread({ id: "th_cli", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", title: "cli thread", lastActivityAt: daemon.store.now() });
  const created = await cli(["create", "--title", "host", "--workspace", "/tmp/ws", ...u]);
  const taskId = json<{ task: { id: string } }>(created).task.id;
  const inboxIds = async (): Promise<string[]> => {
    const state = (await (await fetch(`${url}/api/state`)).json()) as { inbox: Array<{ id: string }> };
    return state.inbox.map((thread) => thread.id);
  };

  // 绑定 → Inbox 立即移除；inspect-thread 给出详情形状
  const bound = await cli(["bind-thread", taskId, "th_cli", ...u]);
  assert.equal(bound.code, EXIT_OK, bound.stderr);
  const binding = json<{ ok: true; binding: { role: string }; thread: { primaryTaskId: string } }>(bound);
  assert.equal(binding.binding.role, "primary");
  assert.equal(binding.thread.primaryTaskId, taskId);
  assert.deepEqual(await inboxIds(), []);

  const inspected = await cli(["inspect-thread", "th_cli", ...u]);
  assert.equal(inspected.code, EXIT_OK, inspected.stderr);
  const detail = json<{ ok: true; thread: Record<string, unknown> }>(inspected).thread;
  assert.equal(detail.nativeStatus, "idle");
  assert.equal((detail.primaryTaskId as string | null), taskId);
  assert.deepEqual(detail.bindings, [{ taskId, threadId: "th_cli", role: "primary", boundAt: (detail.bindings as Array<{ boundAt: string }>)[0]!.boundAt }]);
  assert.deepEqual((detail.lineage as { parents: unknown[]; children: unknown[] }), { parents: [], children: [] });
  assert.equal(detail.turnCount, 0);
  assert.equal(detail.summary, null);
  assert.equal(detail.semanticStatus, null);

  // primary 唯一：另一个任务抢 primary 报 409 语义失败（exit 1，stderr 一行）
  const second = await cli(["create", "--title", "rival", ...u]);
  const secondId = json<{ task: { id: string } }>(second).task.id;
  const clash = await cli(["bind-thread", secondId, "th_cli", "--url", url]);
  assert.equal(clash.code, EXIT_FAILURE);
  assert.match(clash.stderr, /primary/);

  // 忽略/恢复与解绑：人读输出各一行
  const ignored = await cli(["ignore-thread", "th_cli", "--url", url]);
  assert.equal(ignored.code, EXIT_OK, ignored.stderr);
  assert.match(ignored.stdout, /^ignored th_cli\n$/);
  const unignored = await cli(["unignore-thread", "th_cli", "--url", url]);
  assert.match(unignored.stdout, /^unignored th_cli\n$/);
  const unbound = await cli(["unbind-thread", taskId, "th_cli", "--url", url]);
  assert.equal(unbound.code, EXIT_OK, unbound.stderr);
  assert.match(unbound.stdout, /^unbound th_cli from /);
  // 解绑后 thread 回 Inbox（30 天窗口内、未忽略）
  assert.deepEqual(await inboxIds(), ["th_cli"]);
  // 解绑不存在的绑定 → 404 语义失败
  const again = await cli(["unbind-thread", taskId, "th_cli", "--url", url]);
  assert.equal(again.code, EXIT_FAILURE);
  assert.match(again.stderr, /not bound/);
});

test("db path resolves locally without a daemon and honours --db / TASKBOARD_DB_PATH", async () => {
  const dir = await makeDir();
  const flagged = await cli(["db", "path", "--db", join(dir, "x.sqlite"), "--json"]);
  assert.equal(flagged.code, EXIT_OK);
  assert.equal(json<{ path: string }>(flagged).path, join(dir, "x.sqlite"));
  const previous = process.env.TASKBOARD_DB_PATH;
  process.env.TASKBOARD_DB_PATH = join(dir, "env.sqlite");
  try {
    const fromEnv = await cli(["db", "path"]);
    assert.equal(fromEnv.stdout.trim(), join(dir, "env.sqlite"));
  } finally {
    if (previous === undefined) delete process.env.TASKBOARD_DB_PATH;
    else process.env.TASKBOARD_DB_PATH = previous;
  }
  const bad = await cli(["db", "dump"]);
  assert.equal(bad.code, EXIT_USAGE);
});

// ---- 子进程：start 的进程边界语义 ----

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoaderPath = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));

const spawnCliWithEnv = (args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess =>
  spawn(process.execPath, ["--import", pathToFileURL(tsxLoaderPath).href, cliPath, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

const spawnCli = (args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess =>
  spawnCliWithEnv(args, { ...process.env, ...env }, repoRoot);

interface SubprocessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const waitForExit = (child: ChildProcess, timeoutMs = 30_000): Promise<SubprocessExit> =>
  new Promise((resolve, reject) => {
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
      reject(new Error(`subprocess did not exit within ${timeoutMs}ms\nstderr: ${stderr}`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout, stderr });
    });
  });

const waitForListening = (child: ChildProcess, timeoutMs = 30_000): Promise<{ port: number }> =>
  new Promise((resolve, reject) => {
    let stdout = "";
    const guard = setTimeout(() => reject(new Error(`daemon did not report listening\n${stdout}`)), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (line.includes('"event":"listening"')) {
          clearTimeout(guard);
          resolve(JSON.parse(line) as { port: number });
        }
      }
    });
    child.once("close", (code) => {
      clearTimeout(guard);
      reject(new Error(`daemon exited early with ${code}\n${stdout}`));
    });
  });

test("CLI loads .env from cwd; process env wins; missing file is not an error", async () => {
  const dir = await makeDir();
  const emptyDir = await makeDir();
  const fileDb = join(dir, "from-file.sqlite");
  const shellDb = join(dir, "from-shell.sqlite");
  const customEnv = join(dir, "custom.env");
  const customDb = join(dir, "from-custom.sqlite");
  await writeFile(join(dir, ".env"), `TASKBOARD_DB_PATH=${fileDb}\n`);
  await writeFile(customEnv, `TASKBOARD_DB_PATH=${customDb}\n`);

  const baseEnv = { ...process.env };
  delete baseEnv.TASKBOARD_DB_PATH;
  delete baseEnv.TASKBOARD_ENV_FILE;

  const fromFile = await waitForExit(spawnCliWithEnv(["db", "path"], baseEnv, dir));
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.equal(fromFile.stdout.trim(), fileDb);

  const fromShell = await waitForExit(
    spawnCliWithEnv(["db", "path"], { ...baseEnv, TASKBOARD_DB_PATH: shellDb }, dir),
  );
  assert.equal(fromShell.code, 0, fromShell.stderr);
  assert.equal(fromShell.stdout.trim(), shellDb, "process env must override .env");

  const fromCustom = await waitForExit(
    spawnCliWithEnv(["db", "path"], { ...baseEnv, TASKBOARD_ENV_FILE: customEnv }, emptyDir),
  );
  assert.equal(fromCustom.code, 0, fromCustom.stderr);
  assert.equal(fromCustom.stdout.trim(), customDb);

  const missing = await waitForExit(spawnCliWithEnv(["db", "path"], baseEnv, emptyDir));
  assert.equal(missing.code, 0, missing.stderr);
});

test("CLI start: second daemon on the same db exits non-zero naming the holder pid; SIGTERM releases the lock", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const first = spawnCli(["start", "--port", "0", "--db", dbPath]);
  const firstExit = waitForExit(first, 60_000);
  await waitForListening(first);
  try {
    const second = spawnCli(["start", "--port", "0", "--db", dbPath]);
    const exit = await waitForExit(second);
    assert.notEqual(exit.code, 0);
    assert.match(exit.stderr, new RegExp(`holder pid ${first.pid}`));
    assert.equal(exit.stderr.includes("    at "), false, "no stack trace on stderr");
  } finally {
    first.kill("SIGTERM");
  }
  const exit = await firstExit;
  assert.equal(exit.code, 0);
  await assert.rejects(stat(daemonLockPathFor(dbPath)), /ENOENT/);
});

// ---- 命令分发表与 HELP 对齐（晨析条目7：命令清单三处对齐风险收敛） ----

test("命令分发表 COMMANDS 与 HELP 命令清单一一对应", async () => {
  const { COMMANDS, HELP } = await import("../src/cli.js");
  // 独立真值：工具契约（词汇表「工具契约」）钉死的子命令面，29 个
  const EXPECTED = [
    "accept-proposal", "archive", "bind-thread", "cancel", "create", "db", "delete", "get",
    "goal", "ignore-thread", "inspect-thread", "list", "move", "pause-automation", "proposals",
    "refresh", "reject-proposal", "resume-automation", "retro", "run", "start", "status",
    "summaries", "unarchive", "unbind-thread", "unignore-thread", "update", "wait", "worktree-clean",
  ];
  assert.deepEqual(Object.keys(COMMANDS).sort(), [...EXPECTED].sort(), "表键 = 契约命令面");
  const inHelp = [
    ...new Set(
      [...HELP.matchAll(/^  taskboard (\S+)/gm)]
        .map((m) => m[1] ?? "")
        .filter((name) => name !== "help"), // help 走 main 前置分支，不进表
    ),
  ]; // 同名命名空间多条 usage 行（retro record / retro combo-record）只记一次命令
  assert.deepEqual([...inHelp].sort(), [...EXPECTED].sort(), "HELP 列出的命令 = 表键（加命令漏 HELP 或漏表在此变红）");
});

test("原型链键不得被当命令分发：constructor/toString/__proto__ 走 unknown command（ocr 集成复审回归钉）", async () => {
  for (const command of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    const exit = await main([command]);
    assert.equal(exit, EXIT_USAGE, `taskboard ${command} 必须 EXIT_USAGE，而非解析 Object.prototype 成员`);
  }
});

// ---- HELP flag 面与实现 flag 面逐命令对齐（issue #35 ocr 复审：union 级对齐抓不住单命令漏 flag——
// create/update 丢 --request-id 时 request-id 仍经 goal/bind-thread 留在 union 里，两向 union 断言全绿） ----

/** HELP usage 区块逐命令拆解：`  taskboard <cmd>` 起头，缩进续行并入同一命令，非缩进行收束区块；
 * 同命令多条头行（retro 五个子命令面各占一行）累积 flag 集，不做覆盖重置。 */
const helpUsageFlags = async (): Promise<Map<string, string[]>> => {
  const { HELP } = await import("../src/cli.js");
  const perCommand = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of HELP.split("\n")) {
    const head = line.match(/^  taskboard (\S+)/);
    if (head !== null) {
      current = head[1]!;
      const flags = [...line.matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1]!);
      perCommand.set(current, [...(perCommand.get(current) ?? []), ...flags]);
      continue;
    }
    if (current === null) continue;
    if (/^\s/.test(line)) {
      perCommand.get(current)!.push(...[...line.matchAll(/--([a-z][a-z0-9-]*)/g)].map((match) => match[1]!));
    } else {
      current = null; // 离开 usage 区块（Environment: 等顶层小节）
    }
  }
  return perCommand;
};

/** main 手工处理的全局 flag（不走 parseArgs 声明）：start/retro 是本地进程（无 --url，retro 直连库）；db 本地解析、不连 daemon，无 --url。 */
const GLOBAL_FLAGS: Record<string, string[]> = { start: [], db: ["json"], retro: ["json"] };
const globalFlags = (command: string): string[] => GLOBAL_FLAGS[command] ?? ["json", "url"];

test("HELP usage 行逐命令对齐声明 option 面：每命令 flag 集 === COMMAND_FLAG_OPTIONS[cmd] ∪ task 字段表（create/update）∪ 全局", async () => {
  const { COMMANDS, COMMAND_FLAG_OPTIONS, TASK_FIELD_TABLE } = await import("../src/cli.js");
  const tableFlags = TASK_FIELD_TABLE.map((entry: { flag: string }) => entry.flag);
  const declaredCommands = Object.keys(COMMAND_FLAG_OPTIONS as object).sort();
  assert.deepEqual(declaredCommands, Object.keys(COMMANDS).sort(), "flag 真值表必须覆盖全部命令（漏命令即红）");
  const usage = await helpUsageFlags();
  for (const [command, flags] of usage) {
    if (command === "help") continue; // help 是裸命令，不吃全局 flag
    const face = (COMMAND_FLAG_OPTIONS as Record<string, Record<string, unknown>>)[command] ?? {};
    const expected = [
      ...new Set([
        ...Object.keys(face),
        ...(command === "create" || command === "update" ? tableFlags : []),
        ...globalFlags(command),
      ]),
    ].sort();
    assert.deepEqual(
      [...new Set(flags)].sort(),
      expected,
      `HELP usage 行 taskboard ${command} 的 flag 集与声明 option 面不对齐（漏 flag 或 HELP/实现漂移）`,
    );
  }
  assert.deepEqual(
    [...usage.keys()].filter((command) => command !== "help").sort(),
    declaredCommands,
    "HELP 列出的命令与 flag 真值表一一对应",
  );
});

test("--request-id 的 option 声明收敛单处（票面：4 处重复收敛到 REQUEST_ID_OPTIONS）", () => {
  const text = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");
  const declarations = [...text.matchAll(/"request-id":\s*\{\s*type:/g)].length;
  assert.equal(declarations, 1, `--request-id option 声明必须只有 1 处（REQUEST_ID_OPTIONS），现为 ${declarations}`);
});

// ---- --request-id 透传直测（ocr 复审回归钉：create/update 曾在严格解析下 exit 2，
// 读侧死读恒 undefined → 恒落 cli-<uuid> 兜底，caller 幂等键失效） ----

test("create --request-id 透传到 actions 幂等环：store 记录 caller 的 id，而非 cli-<uuid> 兜底", async () => {
  const { daemon, url } = await bootDaemon();
  const first = await cli(["create", "--title", "rid", "--request-id", "ocr-create-1", "--url", url, "--json"]);
  assert.equal(first.code, EXIT_OK, first.stderr);
  const recorded = daemon.store.recallResponse("ocr-create-1");
  assert.ok(recorded !== null, "--request-id 必须透传到 postAction（兜底 cli-<uuid> 在幂等环查不到 caller 的 id）");
  assert.equal(recorded.action, "task.create");
  // 同 id 重放：第二个 create 拿缓存响应，不新建任务
  const second = await cli(["create", "--title", "rid", "--request-id", "ocr-create-1", "--url", url, "--json"]);
  assert.equal(second.code, EXIT_OK, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout), "同 --request-id 幂等重放");
  assert.equal(daemon.store.listTasks().length, 1, "透传则只建一个任务；兜底 cli-<uuid> 会建两个");
});

test("update --request-id 透传：同款幂等重放", async () => {
  const { daemon, url } = await bootDaemon();
  const created = await cli(["create", "--title", "before", "--url", url, "--json"]);
  const id = (JSON.parse(created.stdout) as { task: { id: string } }).task.id;
  const first = await cli(["update", id, "--title", "after", "--request-id", "ocr-update-1", "--url", url, "--json"]);
  assert.equal(first.code, EXIT_OK, first.stderr);
  const recorded = daemon.store.recallResponse("ocr-update-1");
  assert.ok(recorded !== null, "update 的 --request-id 必须透传到 postAction");
  assert.equal(recorded.action, "task.update");
  const second = await cli(["update", id, "--title", "after", "--request-id", "ocr-update-1", "--url", url, "--json"]);
  assert.equal(second.code, EXIT_OK, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout), "同 --request-id 幂等重放");
});

// ---- task 字段单表行为哨兵（issue #35：单表化后解析行为零变化） ----

test("task 字段 flag 四类异质行为：直通/改名、labels 数组、positiveInt 转换与报错、goal 布尔", async () => {
  const { daemon, url } = await bootDaemon();
  const u = ["--url", url, "--json"];

  // positiveInt 数值转换的报错路径（transform 类）
  const badIdle = await cli(["create", "--title", "x", "--idle-threshold-ms", "abc", ...u]);
  assert.equal(badIdle.code, EXIT_USAGE);
  assert.match(badIdle.stderr, /--idle-threshold-ms must be a positive integer, got: abc/);
  const zeroBudget = await cli(["create", "--title", "x", "--goal-budget-tokens", "0", ...u]);
  assert.equal(zeroBudget.code, EXIT_USAGE);
  assert.match(zeroBudget.stderr, /--goal-budget-tokens must be a positive integer/);

  const parent = await cli(["create", "--title", "parent", ...u]);
  const parentId = json<{ task: { id: string } }>(parent).task.id;

  // 一条 create 盖全表：改名直通 ×6、数组 labels、positiveInt ×2、布尔 goal
  const created = await cli([
    "create", "--title", "fields", "--prompt", "p", "--workspace", "/tmp/ws",
    "--parent", parentId, "--acceptance", "agent", "--automation", "suggest",
    "--workspace-mode", "isolated_worktree", "--subtasks-policy", "cascade",
    "--acceptance-criteria", "done well", "--label", "a", "--label", "b",
    "--cron", "*/5 * * * *",
    "--idle-threshold-ms", "5000", "--goal", "--goal-budget-tokens", "1200",
    ...u,
  ]);
  assert.equal(created.code, EXIT_OK, created.stderr);
  const task = json<{ task: Record<string, unknown> }>(created).task;
  assert.equal(task.parentId, parentId, "parent → parentId 改名直通");
  assert.equal(task.acceptanceMode, "agent", "acceptance → acceptanceMode");
  assert.equal(task.automationMode, "suggest", "automation → automationMode");
  assert.equal(task.workspaceMode, "isolated_worktree", "workspace-mode → workspaceMode");
  assert.equal(task.subtasksPolicy, "cascade", "subtasks-policy → subtasksPolicy");
  assert.equal(task.acceptanceCriteria, "done well", "acceptance-criteria → acceptanceCriteria");
  assert.deepEqual(task.labels, ["a", "b"], "label 数组 → labels");
  assert.equal(task.idleThresholdMs, 5000, "idle-threshold-ms → idleThresholdMs 数值转换");
  const stored = daemon.store.getTask(task.id as string);
  assert.equal(stored?.goal.enabled, true, "goal → goalEnabled 布尔（card 视图不透出，store 直查）");
  assert.equal(stored?.goal.budgetTokens, 1200, "goal-budget-tokens → goalBudgetTokens 数值转换");

  // update 侧置空单表盖全五条：反义 no-goal 与 clear-*（UPDATE_CLEAR_TABLE 的真值另一半）
  const updated = await cli([
    "update", task.id as string,
    "--no-goal", "--clear-parent", "--clear-labels", "--clear-cron", "--clear-subtasks-policy",
    ...u,
  ]);
  assert.equal(updated.code, EXIT_OK, updated.stderr);
  const after = daemon.store.getTask(task.id as string);
  assert.equal(after?.goal.enabled, false, "no-goal → goalEnabled false");
  assert.equal(after?.parentId, null, "clear-parent → parentId null");
  assert.deepEqual(after?.labels, [], "clear-labels → labels 空数组");
  assert.equal(after?.schedule, null, "clear-cron → schedule null（cron 是 schedule 的成分，置空即无调度）");
  assert.equal(after?.subtasksPolicy, null, "clear-subtasks-policy → subtasksPolicy null");
});
