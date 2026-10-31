/**
 * 多线程 watch 薄封装：一条前台命令盯住多个 codexhost 线程，退出即全部到终态。
 * 只报告执行状态，不判定正确性或验收结论——验收仍由主线程自己读结果做。
 *
 * 为什么是轮询：codexhost 的 `thread wait` 只接受单线程，多开会得到碎片化通知
 * （本轮实践里 15/29 分钟各断一次）。这里在同一个进程里串行读快照，
 * 调用方只发一次命令，所以没有 agent 侧轮询。
 *
 * 用法：pnpm exec tsx scripts/watch-threads.ts <thread>... [--interval-ms N] [--timeout-ms N]
 */
import { spawnSync } from "node:child_process";

export interface ThreadSnapshot {
  thread: string;
  status: string;
  progress: string;
}

/** codexhost 用 "running" 表示未终态；其余（completed/failed/cancelled/...）都按终态处理。 */
export const isTerminalStatus = (status: string): boolean =>
  status !== "running" && status !== "pending" && status !== "queued" && status !== "";

const FAILURE_STATUSES = new Set(["failed", "cancelled", "canceled", "error"]);

export interface TickResult {
  lines: string[];
  /** 本轮结束后仍非终态的线程。 */
  running: string[];
  failed: string[];
}

/** 纯函数：对比上一轮状态，产出状态迁移行（首轮总是输出）。 */
export const diffSnapshots = (
  previous: Map<string, string>,
  snapshots: ThreadSnapshot[],
): TickResult => {
  const lines: string[] = [];
  const running: string[] = [];
  const failed: string[] = [];
  for (const snapshot of snapshots) {
    const before = previous.get(snapshot.thread);
    if (before !== snapshot.status) {
      const progress = snapshot.progress === "" ? "" : ` — ${snapshot.progress}`;
      lines.push(`[${snapshot.thread}] ${before ?? "new"} -> ${snapshot.status}${progress}`);
    }
    if (isTerminalStatus(snapshot.status)) {
      if (FAILURE_STATUSES.has(snapshot.status)) failed.push(snapshot.thread);
    } else {
      running.push(snapshot.thread);
    }
  }
  return { lines, running, failed };
};

/** 退出码：0 全绿终态；2 有线程失败/取消；124 超时仍在跑（运行检查点，非失败）。 */
export const exitCodeFor = (
  running: string[],
  failed: string[],
): { code: number; reason: string } => {
  if (running.length > 0) {
    return { code: 124, reason: `${running.length} 个线程仍在跑（运行检查点，不代表失败）` };
  }
  if (failed.length > 0) return { code: 2, reason: `${failed.length} 个线程非成功终态` };
  return { code: 0, reason: "全部线程到终态" };
};

const readThread = (thread: string, timeoutMs: number): ThreadSnapshot | string => {
  const result = spawnSync("codexhost", ["thread", "read", thread, "--format", "compact"], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.error !== undefined) return `codexhost 调用失败：${result.error.message}`;
  if (result.status !== 0) {
    return `codexhost read 退出码 ${result.status}：${(result.stderr ?? "").trim().slice(0, 300)}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout ?? "");
  } catch {
    return `codexhost read 输出不是 JSON：${(result.stdout ?? "").slice(0, 200)}`;
  }
  if (typeof parsed !== "object" || parsed === null) return "codexhost read 输出不是对象";
  const row = parsed as Record<string, unknown>;
  return {
    thread: typeof row["thread"] === "string" ? row["thread"] : thread,
    status: typeof row["status"] === "string" ? row["status"] : "",
    progress: typeof row["progress"] === "string" ? row["progress"].replace(/\s+/g, " ").slice(0, 160) : "",
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const parseFlags = (argv: string[]): { threads: string[]; intervalMs: number; timeoutMs: number } => {
  const threads: string[] = [];
  let intervalMs = 20_000;
  let timeoutMs = 30 * 60_000;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--interval-ms") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--interval-ms 需要正整数");
      intervalMs = value;
    } else if (arg === "--timeout-ms") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0) throw new Error("--timeout-ms 需要正整数");
      timeoutMs = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`未知参数 ${arg}`);
    } else {
      threads.push(arg);
    }
  }
  if (threads.length === 0) throw new Error("至少给一个线程引用");
  return { threads, intervalMs, timeoutMs };
};

const main = async (argv: string[]): Promise<number> => {
  const { threads, intervalMs, timeoutMs } = parseFlags(argv);
  console.log(`watch ${threads.length} 个线程；只报执行状态，不代表验收通过。`);
  const previous = new Map<string, string>();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshots: ThreadSnapshot[] = [];
    for (const thread of threads) {
      const snapshot = readThread(thread, Math.min(60_000, Math.max(1_000, deadline - Date.now())));
      if (typeof snapshot === "string") {
        console.error(`ERROR [${thread}] ${snapshot}`);
        return 1;
      }
      snapshots.push(snapshot);
    }
    const tick = diffSnapshots(previous, snapshots);
    for (const line of tick.lines) console.log(line);
    for (const snapshot of snapshots) previous.set(snapshot.thread, snapshot.status);
    const timedOut = Date.now() >= deadline;
    if (tick.running.length === 0 || timedOut) {
      const { code, reason } = exitCodeFor(tick.running, tick.failed);
      console.log(`done: ${reason}`);
      return code;
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
};

const invokedDirectly = process.argv[1]?.endsWith("watch-threads.ts") === true;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`watch-threads FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
