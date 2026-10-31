/**
 * isolated_worktree 执行模式（A18 + 故事 70–73）：真实临时 git 仓 + 假 app-server，
 * 断言 thread create 收到的 cwd 是 worktree 目录、主工作区分支不动、创建失败人话落账、
 * 清理显式且幂等、验收前拒绝。全部经 daemon 公共 API 缝，不调真实 Codex。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { EXIT_OK, main as cliMain } from "../src/cli.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";

const execFile = promisify(execFileCb);

/** git 对比路径用 realpath；worktree 目录清掉后父链还在，按父目录解析（macOS /var → /private/var）。 */
const gitPathOf = (path: string): string => join(realpathSync(dirname(path)), basename(path));

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录（本文件进程内生效，driver 子进程继承）
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-worktree-"));

const FAKE_APP_SERVER_PATH = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const git = async (repo: string, ...args: string[]): Promise<string> => {
  const { stdout } = await execFile("git", ["-C", repo, ...args]);
  return stdout;
};

/** 真实临时 git 仓：默认分支（不依赖本机 init.defaultBranch 名字）+ 带 extra 文件的 feature 基准分支。 */
const initRepo = async (): Promise<string> => {
  const repo = await mkdtemp(join(tmpdir(), "tb-worktree-repo-"));
  tmpDirs.push(repo);
  await git(repo, "init");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "test");
  await writeFile(join(repo, "base.txt"), "base");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "init");
  await git(repo, "checkout", "-b", "feature");
  await writeFile(join(repo, "feature.txt"), "feature");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "feature work");
  await git(repo, "checkout", "-");
  return repo;
};

const boot = async (driverEnv: Record<string, string> = {}): Promise<RunningDaemon> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-worktree-"));
  tmpDirs.push(dir);
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(dir, "taskboard.sqlite"),
    driver: {
      command: process.execPath,
      args: [FAKE_APP_SERVER_PATH],
      env: { ...process.env, FAKE_TURN_DELAY_MS: "25", ...driverEnv },
    },
    cronTickMs: 10,
  });
  daemons.push(daemon);
  return daemon;
};

const post = async (
  daemon: RunningDaemon,
  type: string,
  fields: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, requestId: `t-${Math.random().toString(36).slice(2)}`, ...fields }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const getJson = async <T>(daemon: RunningDaemon, path: string): Promise<T> => {
  const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`);
  return (await response.json()) as T;
};

const until = async (predicate: () => Promise<boolean> | boolean, timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
};

const createTask = async (
  daemon: RunningDaemon,
  extra: Record<string, unknown> = {},
): Promise<string> => {
  const response = await post(daemon, "task.create", {
    title: "isolated work",
    prompt: "do it",
    status: "todo",
    ...extra,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body.task as { id: string }).id;
};

const runToTerminal = async (
  daemon: RunningDaemon,
  taskId: string,
  terminal: "completed" | "failed",
): Promise<Record<string, unknown>> => {
  const created = await post(daemon, "run.create", { taskId });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await until(async () => {
    const payload = await getJson<{ task: { lastRun: { status: string } | null } }>(
      daemon,
      `/api/tasks/${taskId}`,
    );
    return payload.task.lastRun?.status === terminal;
  });
  const payload = await getJson<{ task: { lastRun: Record<string, unknown> } }>(daemon, `/api/tasks/${taskId}`);
  return payload.task.lastRun;
};

const fakeStats = async (daemon: RunningDaemon): Promise<{ cwds: Record<string, string> }> => {
  const client = daemon.driver.clientRef();
  assert.ok(client !== null, "app-server should be spawned after a run");
  return (await client.request("__fake/stats", {})) as { cwds: Record<string, string> };
};

interface WorktreeView {
  seq: number;
  branch: string;
  path: string;
  baseBranch: string | null;
  status: "active" | "removed";
  createdAt: string;
  removedAt: string | null;
}

const taskDetail = async (daemon: RunningDaemon, taskId: string) => {
  const payload = await getJson<{ task: { worktree: WorktreeView | null; status: string } }>(
    daemon,
    `/api/tasks/${taskId}`,
  );
  return payload.task;
};

test("A18: isolated run creates branch+worktree from the configured base branch, thread create receives that cwd, main workspace branch untouched", async () => {
  const repo = await initRepo();
  const mainBranch = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  const daemon = await boot();
  const settings = await post(daemon, "settings.update", { settings: { worktreeBaseBranch: "feature" } });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));

  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  const run = await runToTerminal(daemon, taskId, "completed");
  assert.equal(run.status, "completed");

  const detail = await taskDetail(daemon, taskId);
  const worktree = detail.worktree;
  assert.ok(worktree !== null, "task detail carries the worktree record");
  assert.equal(worktree.branch, `taskboard/${taskId}/1`);
  assert.equal(worktree.baseBranch, "feature");
  assert.equal(worktree.status, "active");
  assert.ok(existsSync(worktree.path), "worktree directory exists");

  // thread create 收到的 cwd 就是 worktree 目录（假 app-server 记录的 cwd）
  const stats = await fakeStats(daemon);
  const threadIds = Object.keys(stats.cwds);
  assert.equal(threadIds.length, 1);
  assert.equal(stats.cwds[threadIds[0]!], worktree.path);

  // worktree 内容来自基准分支 feature，并检出任务专属分支
  assert.equal(existsSync(join(worktree.path, "feature.txt")), true, "base branch content present");
  assert.equal(existsSync(join(worktree.path, "base.txt")), true, "common history present");
  const wtBranch = (await git(worktree.path, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  assert.equal(wtBranch, `taskboard/${taskId}/1`);
  assert.equal((await git(repo, "branch", "--list", `taskboard/${taskId}/1`)).trim().length > 0, true);

  // 主工作区：分支不变、无新 worktree 之外的改动（git 会输出 realpath，macOS /var → /private/var）
  assert.equal((await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim(), mainBranch);
  const worktreeList = await git(repo, "worktree", "list", "--porcelain");
  const resolved = gitPathOf(worktree.path);
  assert.match(worktreeList, new RegExp(`^worktree ${resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.equal((await git(repo, "status", "--porcelain")).trim(), "", "main workspace stays clean");
});

test("worktree is reused across runs of the same task: same branch, same cwd, one record", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const first = (await taskDetail(daemon, taskId)).worktree;
  await runToTerminal(daemon, taskId, "completed");
  const second = (await taskDetail(daemon, taskId)).worktree;
  assert.deepEqual(second, first);
  const stats = await fakeStats(daemon);
  const cwds = new Set(Object.values(stats.cwds));
  assert.equal(cwds.size, 1, "both threads created with the same worktree cwd");
  assert.equal([...cwds][0], first!.path);
});

test("worktree creation failure fails the run with a human error and keeps evidence (not a git repo)", async () => {
  const notARepo = await mkdtemp(join(tmpdir(), "tb-worktree-plain-"));
  tmpDirs.push(notARepo);
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: notARepo, workspaceMode: "isolated_worktree" });
  const run = await runToTerminal(daemon, taskId, "failed");
  assert.match(String(run.failureReason), /failed to create isolated worktree/);
  assert.match(String(run.failureReason), /not a git repository/);
  const detail = await getJson<{
    task: { annotations: Array<{ kind: string; body: string }> };
  }>(daemon, `/api/tasks/${taskId}`);
  const note = detail.task.annotations.find((entry) => entry.kind === "worktree_prepare_failed");
  assert.ok(note !== undefined, "failure evidence annotation recorded");
  assert.match(note.body, /not a git repository/);
});

test("worktree creation failure names the missing base branch", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const patch = await post(daemon, "settings.update", { settings: { worktreeBaseBranch: "nope" } });
  assert.equal(patch.status, 200);
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  const run = await runToTerminal(daemon, taskId, "failed");
  assert.match(String(run.failureReason), /failed to create isolated worktree/);
  assert.match(String(run.failureReason), /nope/);
});

test("cleanup: refused before acceptance, refused on failed tasks, explicit when done, idempotent", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const worktree = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(worktree !== null);

  // 验收前（completed 未验收 → todo）拒绝清理
  const early = await post(daemon, "worktree.clean", { taskId });
  assert.equal(early.status, 409, JSON.stringify(early.body));
  assert.match(String(early.body.error), /acceptance|done/);
  assert.ok(existsSync(worktree.path), "worktree preserved before acceptance");

  // 失败任务同样拒绝（失败保留证据）
  const failedTask = await createTask(daemon, {
    workspace: repo,
    workspaceMode: "isolated_worktree",
    prompt: "[fail] break it",
    title: "failing isolated work",
  });
  await runToTerminal(daemon, failedTask, "failed");
  const failedClean = await post(daemon, "worktree.clean", { taskId: failedTask });
  assert.equal(failedClean.status, 409);
  assert.ok(existsSync((await taskDetail(daemon, failedTask)).worktree!.path));

  // 验收（人工 move 到 done）后显式清理成功：worktree 与 branch 都删掉
  const moved = await post(daemon, "task.move", { taskId, status: "done" });
  assert.equal(moved.status, 200);
  const cleaned = await post(daemon, "worktree.clean", { taskId });
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
  assert.equal(cleaned.body.cleaned, true);
  const view = cleaned.body.worktree as WorktreeView;
  assert.equal(view.status, "removed");
  assert.ok(view.removedAt !== null);
  assert.equal(existsSync(worktree.path), false, "worktree directory removed");
  assert.equal(
    (await git(repo, "branch", "--list", worktree.branch)).trim(),
    "",
    "task branch deleted",
  );
  // 清掉的 worktree 注销；失败任务的 worktree 仍保留（证据语义）
  const list = await git(repo, "worktree", "list", "--porcelain");
  assert.doesNotMatch(list, new RegExp(gitPathOf(worktree.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(list, new RegExp(gitPathOf((await taskDetail(daemon, failedTask)).worktree!.path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // 幂等：再清一次无事发生
  const again = await post(daemon, "worktree.clean", { taskId });
  assert.equal(again.status, 200);
  assert.equal(again.body.cleaned, false);
});

test("cleanup converges when the worktree directory was already removed by hand", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const worktree = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(worktree !== null);
  await rm(worktree.path, { recursive: true, force: true });
  await post(daemon, "task.move", { taskId, status: "done" });
  const cleaned = await post(daemon, "worktree.clean", { taskId });
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
  assert.equal(cleaned.body.cleaned, true);
  assert.equal((await git(repo, "branch", "--list", worktree.branch)).trim(), "");
  assert.equal((await git(repo, "worktree", "list", "--porcelain")).includes("taskboard"), false);
});

test("a hand-deleted branch re-registers a fresh worktree and retires the stale record (no two active rows)", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const first = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(first !== null);
  // 用户手工收掉整档：目录移除 → prune 注销 → branch 删除（注册未清时 git 拒删 branch）
  await rm(first.path, { recursive: true, force: true });
  await git(repo, "worktree", "prune");
  await git(repo, "branch", "-D", first.branch);

  // 重跑走 fall-through：旧记录不得保持 active，否则两个 active 行并存、clean 永久卡死
  await runToTerminal(daemon, taskId, "completed");
  const second = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(second !== null);
  assert.equal(second.seq, 2);
  assert.equal(second.branch, `taskboard/${taskId}/2`);
  assert.equal(second.status, "active");
  assert.ok(existsSync(second.path));
  assert.equal(daemon.store.countWorktrees(taskId), 2);
  const active = daemon.store.activeWorktreeOf(taskId);
  assert.ok(active !== null && active.seq === 2, "active 只剩新档");

  // 旧 bug 的楔子：清掉新档后再重放 clean，会撞上 stale 行「删不存在的 branch」而永久 409
  await post(daemon, "task.move", { taskId, status: "done" });
  const cleaned = await post(daemon, "worktree.clean", { taskId });
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
  assert.equal(cleaned.body.cleaned, true);
  const replay = await post(daemon, "worktree.clean", { taskId });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.cleaned, false, "重放 clean 幂等无事发生，不得被 stale 行卡死");
});

test("cleanup converges when the branch was also deleted by hand", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const worktree = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(worktree !== null);
  await rm(worktree.path, { recursive: true, force: true });
  await git(repo, "worktree", "prune");
  await git(repo, "branch", "-D", worktree.branch);
  await post(daemon, "task.move", { taskId, status: "done" });
  // branch 已不存在：清理目标（目录与 branch 证据收口）已达成，视为已清而非 409
  const cleaned = await post(daemon, "worktree.clean", { taskId });
  assert.equal(cleaned.status, 200, JSON.stringify(cleaned.body));
  assert.equal(cleaned.body.cleaned, true);
  const view = cleaned.body.worktree as WorktreeView;
  assert.equal(view.seq, 1);
  assert.equal(view.status, "removed");
});

test("unmerged branch is preserved: cleanup refuses instead of silently dropping work", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const worktree = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(worktree !== null);
  // agent 在 worktree 里提交一个未合并的 commit（issue 内容承载的 commit 语义）
  await writeFile(join(worktree.path, "agent.txt"), "agent work");
  await git(worktree.path, "add", ".");
  await git(worktree.path, "commit", "-m", "agent work");
  await post(daemon, "task.move", { taskId, status: "done" });
  const cleaned = await post(daemon, "worktree.clean", { taskId });
  assert.equal(cleaned.status, 409, JSON.stringify(cleaned.body));
  assert.match(String(cleaned.body.error), /not fully merged/);
  // branch 证据还在
  assert.equal((await git(repo, "branch", "--list", worktree.branch)).trim().length > 0, true);
});

test("a done task re-run gets a fresh worktree after cleanup (next seq, new branch)", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const first = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(first !== null);
  await post(daemon, "task.move", { taskId, status: "done" });
  const cleaned = await post(daemon, "worktree.clean", { taskId });
  assert.equal(cleaned.status, 200);
  await runToTerminal(daemon, taskId, "completed");
  const second = (await taskDetail(daemon, taskId)).worktree;
  assert.ok(second !== null);
  assert.equal(second.status, "active");
  assert.equal(second.seq, 2);
  assert.equal(second.branch, `taskboard/${taskId}/2`);
  assert.notEqual(second.path, first.path);
  assert.ok(existsSync(second.path));
});

test("changing the task workspace under an active worktree fails the run instead of mixing workspaces", async () => {
  const repo = await initRepo();
  const other = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  const patched = await post(daemon, "task.update", { taskId, workspace: other });
  assert.equal(patched.status, 200);
  const run = await runToTerminal(daemon, taskId, "failed");
  assert.match(String(run.failureReason), /was created from workspace/);
});

test("settings.validate: worktreeBaseBranch must be a non-empty string or null", async () => {
  const daemon = await boot();
  const bad = await post(daemon, "settings.update", { settings: { worktreeBaseBranch: "  " } });
  assert.equal(bad.status, 400);
  const good = await post(daemon, "settings.update", { settings: { worktreeBaseBranch: null } });
  assert.equal(good.status, 200);
});

test("CLI worktree-clean: --json payload and human line", async () => {
  const repo = await initRepo();
  const daemon = await boot();
  const taskId = await createTask(daemon, { workspace: repo, workspaceMode: "isolated_worktree" });
  await runToTerminal(daemon, taskId, "completed");
  await post(daemon, "task.move", { taskId, status: "done" });
  const url = `http://127.0.0.1:${daemon.port}`;
  const capture = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    const chunks: string[] = [];
    const errs: string[] = [];
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      errs.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await cliMain(argv);
      return { code, out: chunks.join(""), err: errs.join("") };
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  };
  const jsonResult = await capture(["worktree-clean", taskId, "--json", "--url", url]);
  assert.equal(jsonResult.code, EXIT_OK, jsonResult.err);
  const payload = JSON.parse(jsonResult.out) as { ok: boolean; cleaned: boolean };
  assert.equal(payload.ok, true);
  assert.equal(payload.cleaned, true);
  const human = await capture(["worktree-clean", taskId, "--url", url]);
  assert.equal(human.code, EXIT_OK, human.err);
  assert.match(human.out, /nothing to clean/);
});

test("worktree records survive daemon restart (state is in the store, not in memory)", async () => {
  const repoA = await initRepo();
  const dir = await mkdtemp(join(tmpdir(), "tb-worktree-restart-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "taskboard.sqlite");
  const driver = {
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: { ...process.env, FAKE_TURN_DELAY_MS: "25" },
  };
  const first = await startDaemon({ port: 0, dbPath, driver });
  daemons.push(first);
  const taskId = await createTask(first, { workspace: repoA, workspaceMode: "isolated_worktree" });
  await runToTerminal(first, taskId, "completed");
  const before = (await taskDetail(first, taskId)).worktree;
  await first.close();
  daemons.pop();
  const second = await startDaemon({ port: 0, dbPath, driver });
  daemons.push(second);
  const after = (await taskDetail(second, taskId)).worktree;
  assert.deepEqual(after, before);
});
