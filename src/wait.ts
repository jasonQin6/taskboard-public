/** taskboard wait：只读轮询至任务「静止」。不写库、不改状态、不推 revision（需求「wait」）。 */

import type { Run, ThreadNativeStatus } from "./types.js";

export const WAIT_DEFAULT_TIMEOUT_S = 600;
export const WAIT_POLL_INTERVAL_MS = 2_000;

/** 判静止所需的最小快照（GET /api/tasks/:id 的子集）。 */
export interface QuietSnapshot {
  taskId: string;
  status: string;
  activeRun: Run | null;
  lastRun: Run | null;
  primaryThreadStatus: ThreadNativeStatus | null;
  inFlightWrite: boolean;
}

/** 静止 = 无活跃 Run、主绑定 thread 不是原生 running、无 in-flight 写。覆盖 once 与 goal 续跑。 */
export const isQuiet = (snapshot: QuietSnapshot): boolean =>
  snapshot.activeRun === null &&
  snapshot.primaryThreadStatus !== "running" &&
  !snapshot.inFlightWrite;

export type WaitOutcome =
  | { kind: "quiet"; snapshot: QuietSnapshot }
  | { kind: "timeout"; snapshot: QuietSnapshot };

export interface WaitDeps {
  fetchSnapshot: () => Promise<QuietSnapshot>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const waitForQuiet = async (
  deps: WaitDeps,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<WaitOutcome> => {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_S * 1000;
  const intervalMs = options.intervalMs ?? WAIT_POLL_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  let snapshot = await deps.fetchSnapshot();
  for (;;) {
    if (isQuiet(snapshot)) return { kind: "quiet", snapshot };
    if (now() >= deadline) return { kind: "timeout", snapshot };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    snapshot = await deps.fetchSnapshot();
  }
};
