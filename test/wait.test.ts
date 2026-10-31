/** wait 静止判定：无活跃 Run、主线程非 running、无 in-flight 写；只读轮询；超时。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isQuiet, waitForQuiet, type QuietSnapshot } from "../src/wait.js";
import type { Run } from "../src/types.js";

const run = (status: Run["status"]): Run => ({
  id: "r_1",
  taskId: "t_1",
  status,
  trigger: "manual",
  threadId: null,
  orphaned: false,
  failureReason: null,
  createdAt: "2026-10-21T00:00:00.000Z",
  startedAt: null,
  endedAt: null,
});

const snapshot = (overrides: Partial<QuietSnapshot> = {}): QuietSnapshot => ({
  taskId: "t_1",
  status: "todo",
  activeRun: null,
  lastRun: null,
  primaryThreadStatus: null,
  inFlightWrite: false,
  ...overrides,
});

test("isQuiet: each of the three conditions alone breaks quietness", () => {
  assert.equal(isQuiet(snapshot()), true);
  assert.equal(isQuiet(snapshot({ activeRun: run("queued") })), false);
  assert.equal(isQuiet(snapshot({ activeRun: run("running") })), false);
  // goal 续跑期间：没有 Run 但主线程原生 running → 仍不静止
  assert.equal(isQuiet(snapshot({ primaryThreadStatus: "running" })), false);
  assert.equal(isQuiet(snapshot({ inFlightWrite: true })), false);
  // idle/completed/interrupted/held 的线程都算静止
  for (const status of ["idle", "completed", "interrupted", "held", "failed", "unknown"] as const) {
    assert.equal(isQuiet(snapshot({ primaryThreadStatus: status })), true, status);
  }
});

test("waitForQuiet returns immediately when already quiet and never sleeps", async () => {
  let sleeps = 0;
  const outcome = await waitForQuiet({
    fetchSnapshot: async () => snapshot({ lastRun: run("completed") }),
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(outcome.kind, "quiet");
  assert.equal(sleeps, 0);
  assert.equal(outcome.snapshot.lastRun?.status, "completed");
});

test("waitForQuiet polls until the run reaches a terminal state and the thread settles", async () => {
  const frames: QuietSnapshot[] = [
    snapshot({ activeRun: run("running") }),
    snapshot({ activeRun: run("running"), primaryThreadStatus: "running" }),
    snapshot({ activeRun: null, primaryThreadStatus: "running", lastRun: run("completed") }),
    snapshot({ activeRun: null, primaryThreadStatus: "idle", lastRun: run("completed") }),
  ];
  let clock = 0;
  let polls = 0;
  const outcome = await waitForQuiet(
    {
      fetchSnapshot: async () => frames[Math.min(polls++, frames.length - 1)]!,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
    { timeoutMs: 60_000, intervalMs: 1_000 },
  );
  assert.equal(outcome.kind, "quiet");
  assert.equal(polls, 4);
  assert.equal(clock, 3_000);
});

test("waitForQuiet times out with the last snapshot", async () => {
  let clock = 0;
  const outcome = await waitForQuiet(
    {
      fetchSnapshot: async () => snapshot({ activeRun: run("running") }),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
    { timeoutMs: 5_000, intervalMs: 2_000 },
  );
  assert.equal(outcome.kind, "timeout");
  assert.equal(outcome.snapshot.activeRun?.status, "running");
  // 最后一次 sleep 被截到 deadline，不会越过超时
  assert.equal(clock, 5_000);
});
