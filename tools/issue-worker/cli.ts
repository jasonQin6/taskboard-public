#!/usr/bin/env node
/**
 * issue-worker CLI：daemon | run --issue N --once | status | release。
 * 生产运行只依赖 Node 内置模块 + gh + git + pnpm，不依赖 tsx。
 * 本 help 即契约：改行为先改 help，再改实现。
 */
import { realGh, realGit, scanOnce, sleep, type Ctx } from "./daemon.ts";
import { AppServerLauncher } from "./daemon.ts";
import { loadConfig } from "./config.ts";
import { Store, acquireSingletonLock, singletonLockPathFor, stateDbPathFor } from "./store.ts";
import { resolveRepoName } from "./github.ts";
import { realMergeGatePort } from "./merge-gate.ts";

export const HELP = `issue-worker: GitHub issue -> PR 无人值守 daemon（ZCode DWF 执行切片）

用法：
  issue-worker daemon [--config PATH] [--once]
      常驻轮询：reconcile -> 每 5 分钟扫 ready-for-agent -> 同一时刻至多一张 active job。
      --once 只跑一轮扫描后退出（cron/冒烟用）。

  issue-worker run --issue N --once [--config PATH]
      单张 issue 跑完整生命周期到终局：claim -> 分支 -> 实现 -> 门 -> 审计 -> 交付。
      幂等：已 delivered 且无人工返工标记时为 no-op。

  issue-worker status [--config PATH] [--issue N]
      打印 active job、最近事件与 pending outbox。不拿锁，不写库。

  issue-worker release --issue N [--config PATH]
      释放一张卡住的 job（lease/claim）。持有者进程仍存活时拒绝，避免双写。

状态机：
  implementing -> gating -> auditing -> accepting -> delivered | merged
  失败分类：blocked（实现无结果/审计 stale）/ needs-info（缺信息/启动失败）/
  ready-human（重试耗尽/孤儿 run/基线错误/人工改 label）
  实现最多 3 次，交付最多 3 次；429/provider/网络退避不消耗轮次。

配置：
  JSON 文件（--config，否则 <stateDir>/config.json，否则内置默认）。
  未知键、相对路径、非法值一律 fail closed。repo 目录与 ZCode 二进制不存在则拒绝启动。
  autoMerge 默认关闭；开启后要求 ZCode+OCR 双路同 SHA 审计、GitHub required checks、
  strict freshness、真实默认分支可判定与路径策略全部通过。checks 未绿、mergeable
  未计算或临时读取失败保持 accepting，等待 timeouts.mergeMs；硬错误转 ready-human。
  审计后、远端写前重跑 controller gates。merge API 固定审过的 head SHA，409/422 转人工。
`;

interface GlobalOptions {
  configPath: string | null;
  once: boolean;
  issue: number | null;
}

const parseArgs = (argv: string[]): { command: string; options: GlobalOptions } => {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    return {
      command: "help",
      options: { configPath: null, once: false, issue: null },
    };
  }
  if (command === undefined || !["daemon", "run", "status", "release", "help", "--help", "-h"].includes(command)) {
    throw new Error(`unknown command ${JSON.stringify(command ?? "")}\n${HELP}`);
  }
  const options: GlobalOptions = { configPath: null, once: false, issue: null };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--config") {
      const value = rest[i + 1];
      if (value === undefined) throw new Error("--config requires a path");
      options.configPath = value;
      i++;
    } else if (arg === "--once") {
      options.once = true;
    } else if (arg === "--issue") {
      const value = rest[i + 1];
      const n = Number(value);
      if (value === undefined || !Number.isInteger(n) || n <= 0) {
        throw new Error("--issue requires a positive integer");
      }
      options.issue = n;
      i++;
    } else {
      throw new Error(`unknown flag ${JSON.stringify(arg)}\n${HELP}`);
    }
  }
  if (command === "run" && options.issue === null) throw new Error("run requires --issue N");
  if (command === "release" && options.issue === null) throw new Error("release requires --issue N");
  return { command, options };
};

const buildCtx = (configPath: string | null, readOnly = false): Ctx => {
  const { config } = loadConfig(configPath, process.cwd());
  const dbPath = stateDbPathFor(config.stateDir);
  const store = readOnly ? Store.openReadOnly(dbPath) : Store.open(dbPath);
  let repoName = config.repoName;
  if (repoName === "") {
    repoName = resolveRepoName(config.repo, config.timeouts.commandMs);
  }
  return { config, store, gh: realGh, git: realGit, mergeGate: realMergeGatePort, repoName };
};

const cmdStatus = (ctx: Ctx, issue: number | null): void => {
  const active = ctx.store.getActiveJob(ctx.repoName);
  if (issue !== null) {
    const job = ctx.store.getJob(ctx.repoName, issue);
    console.log(JSON.stringify(job, null, 2));
    for (const row of ctx.store.recentEvents(ctx.repoName, issue)) {
      console.log(`#${row.id} ${new Date(row.at).toISOString()} ${row.kind} ${row.detail_json}`);
    }
    for (const row of ctx.store.pendingOutbox(ctx.repoName, issue)) {
      console.log(`outbox pending ${row.action} key=${row.idempotency_key} attempts=${row.attempts}`);
    }
    return;
  }
  const jobs = ctx.store.listJobs(ctx.repoName);
  console.log(`repo: ${ctx.repoName}`);
  console.log(`active: ${active === null ? "none" : `#${active.issue} stage=${active.stage} branch=${active.branch}`}`);
  for (const job of jobs) {
    console.log(
      `#${job.issue} stage=${job.stage} branch=${job.branch ?? "-"} head=${(job.head_sha ?? "-").slice(0, 8)} pr=${job.pr_number ?? "-"}`,
    );
  }
};

const cmdRelease = (ctx: Ctx, issue: number): void => {
  const lock = acquireSingletonLock(singletonLockPathFor(ctx.config.stateDir));
  const job = ctx.store.getJob(ctx.repoName, issue);
  try {
    if (job === null) throw new Error(`no job for issue ${issue}`);
    if (job.pid !== null && job.pid > 0) {
      try {
        process.kill(job.pid, 0);
        throw new Error(`job holder pid ${job.pid} is alive; refusing to release`);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("job holder")) throw error;
      }
    }
    ctx.store.setStage(ctx.repoName, issue, "blocked", {
      last_error: "released by operator",
      lease_until: Date.now(),
    });
    ctx.store.appendEvent(ctx.repoName, issue, "released", { by: `pid:${process.pid}` });
    console.log(`released #${issue}`);
  } finally {
    lock.release();
  }
};

const cmdRunOnce = async (ctx: Ctx, issue: number): Promise<void> => {
  const lock = acquireSingletonLock(singletonLockPathFor(ctx.config.stateDir));
  const launcher = new AppServerLauncher(ctx);
  try {
    const summary = await scanOnce(ctx, launcher, { onlyIssue: issue });
    console.log(summary);
    const job = ctx.store.getJob(ctx.repoName, issue);
    if (job !== null && job.stage !== "delivered" && job.stage !== "merged") {
      process.exitCode = 1;
    }
  } finally {
    launcher.shutdown();
    lock.release();
    ctx.store.close();
  }
};

const cmdDaemon = async (ctx: Ctx, once: boolean): Promise<void> => {
  const lock = acquireSingletonLock(singletonLockPathFor(ctx.config.stateDir));
  const launcher = new AppServerLauncher(ctx);
  let stopped = false;
  const onSignal = (): void => {
    stopped = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    for (;;) {
      let summary: string;
      try {
        summary = await scanOnce(ctx, launcher);
      } catch (error) {
        summary = `scan failed: ${String(error).slice(0, 300)}`;
      }
      console.log(`[${new Date().toISOString()}] ${summary}`);
      if (once || stopped) break;
      await sleep(summary.includes(" -> delivered:") ? 0 : ctx.config.timeouts.pollMs);
      if (stopped) break;
    }
  } finally {
    launcher.shutdown();
    lock.release();
    ctx.store.close();
  }
};

const main = async (argv: string[]): Promise<void> => {
  let parsed: { command: string; options: GlobalOptions };
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exitCode = 2;
    return;
  }
  const { command, options } = parsed;
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  if (command === "status") {
    const ctx = buildCtx(options.configPath, true);
    try {
      cmdStatus(ctx, options.issue);
    } finally {
      ctx.store.close();
    }
    return;
  }
  if (command === "release") {
    const ctx = buildCtx(options.configPath);
    try {
      cmdRelease(ctx, options.issue!);
    } finally {
      ctx.store.close();
    }
    return;
  }
  if (command === "run") {
    if (!options.once) {
      console.error("run requires --once (single issue to terminal state)");
      process.exitCode = 2;
      return;
    }
    const ctx = buildCtx(options.configPath);
    await cmdRunOnce(ctx, options.issue!);
    return;
  }
  const ctx = buildCtx(options.configPath);
  await cmdDaemon(ctx, options.once);
};

await main(process.argv.slice(2));
