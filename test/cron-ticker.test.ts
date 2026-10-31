/** cron 触发器：到点起单（与手动同路径）、错过不补、活跃 Run/归档/缺 workspace 跳过并记原因、IANA tz 墙钟。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CronTicker, CRON_SKIP_KIND, type FireOutcome } from "../src/cron-ticker.js";
import { openStateDb } from "../src/db.js";
import { Store } from "../src/store/index.js";
import type { Task } from "../src/types.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface Harness {
  store: Store;
  nowMs: { value: number };
  fired: Task[];
  outcomes: FireOutcome[];
}

const makeHarness = async (onFire?: FireOutcome): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-cron-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const nowMs = { value: Date.parse("2026-10-21T08:00:00.000Z") };
  const store = new Store(db, { now: () => nowMs.value });
  const fired: Task[] = [];
  return { store, nowMs, fired, outcomes: [] };
};

const tickerFor = (h: Harness, outcome?: FireOutcome): CronTicker =>
  new CronTicker({
    store: h.store,
    onFire: async (task) => {
      h.fired.push(task);
      return outcome ?? { fired: true, runId: h.store.createRun(task.id, "cron").id };
    },
    now: () => h.nowMs.value,
  });

const createCronTask = (h: Harness, cron: string, tz: string | null = null, workspace: string | null = "/tmp/ws"): Task =>
  h.store.createTask({
    title: "cron task",
    prompt: "",
    workspace,
    status: "todo",
    labels: [],
    source: "manual",
    acceptanceCriteria: "",
    acceptanceMode: "human",
    automationMode: "suggest",
    workspaceMode: "current",
    parentId: null,
    subtasksPolicy: null,
    idleThresholdMs: null,
    cron,
    tz,
    goalEnabled: false,
    goalBudgetTokens: null,
  });

const lastSkip = (h: Harness, taskId: string): string | null => {
  const notes = h.store.listAnnotations({ taskId });
  return notes.length === 0 ? null : notes[0]!.body;
};

test("due task fires once through the run creation path and immediately advances nextRunAt", async () => {
  const h = await makeHarness();
  const ticker = tickerFor(h);
  // 建单时 nextRunAt 从 now 起算：下一分钟到期
  const task = createCronTask(h, "* * * * *");
  const due = Date.parse(task.schedule!.nextRunAt!);
  h.nowMs.value = due + 5_000; // 宽限窗内
  await ticker.tick();
  assert.equal(h.fired.length, 1);
  const runs = h.store.listRuns(task.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.trigger, "cron");
  // 触发后立刻推进：再 tick 不重复起单
  h.nowMs.value += 5_000;
  await ticker.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.store.listRuns(task.id).length, 1);
  const after = h.store.getTask(task.id)!;
  assert.ok(Date.parse(after.schedule!.nextRunAt!) > h.nowMs.value);
});

test("missed window beyond grace is skipped, not backfilled", async () => {
  const h = await makeHarness();
  const ticker = tickerFor(h);
  const task = createCronTask(h, "0 9 * * *");
  // 停机跨越：到期时刻已落后超过宽限窗（默认 tick 30s + 10s）
  h.nowMs.value = Date.parse(task.schedule!.nextRunAt!) + 10 * 60_000;
  await ticker.tick();
  assert.equal(h.fired.length, 0);
  assert.match(lastSkip(h, task.id)!, /not backfilled/);
  const after = h.store.getTask(task.id)!;
  assert.ok(Date.parse(after.schedule!.nextRunAt!) > h.nowMs.value);
});

test("active run skips the trigger with a recorded reason", async () => {
  const h = await makeHarness();
  const ticker = tickerFor(h);
  const task = createCronTask(h, "* * * * *");
  const manual = h.store.createRun(task.id, "manual");
  h.nowMs.value = Date.parse(task.schedule!.nextRunAt!) + 5_000;
  await ticker.tick();
  assert.equal(h.fired.length, 0);
  assert.match(lastSkip(h, task.id)!, new RegExp(`active run ${manual.id}`));
  h.store.finishRun(manual.id, "completed");
  h.store.advanceCron(task.id, h.nowMs.value);
  // 下一窗口恢复触发
  h.nowMs.value = Date.parse(h.store.getTask(task.id)!.schedule!.nextRunAt!) + 5_000;
  await ticker.tick();
  assert.equal(h.fired.length, 1);
});

test("missing workspace skips with a recorded reason", async () => {
  const h = await makeHarness();
  const ticker = tickerFor(h);
  const task = createCronTask(h, "* * * * *", null, null);
  h.nowMs.value = Date.parse(task.schedule!.nextRunAt!) + 5_000;
  await ticker.tick();
  assert.equal(h.fired.length, 0);
  assert.match(lastSkip(h, task.id)!, /no workspace/);
});

test("onFire returning not-fired records the reason without leaving a stuck run", async () => {
  const h = await makeHarness();
  const ticker = tickerFor(h, { fired: false, reason: "harness driver is unavailable in this assembly" });
  const task = createCronTask(h, "* * * * *");
  h.nowMs.value = Date.parse(task.schedule!.nextRunAt!) + 5_000;
  await ticker.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.store.listRuns(task.id).length, 0);
  assert.match(lastSkip(h, task.id)!, /unavailable in this assembly/);
});

test("archived task with a due nextRunAt (race) is skipped and disarmed", async () => {
  const h = await makeHarness();
  const ticker = tickerFor(h);
  const task = createCronTask(h, "* * * * *");
  h.store.archiveTask(task.id);
  // 人为恢复一个到期 nextRunAt 模拟「归档与到期并发」的竞态
  h.store.db
    .prepare("UPDATE tasks SET next_run_at = ? WHERE id = ?")
    .run(h.nowMs.value - 5_000, task.id);
  await ticker.tick();
  assert.equal(h.fired.length, 0);
  assert.match(lastSkip(h, task.id)!, /archived/);
  assert.equal(h.store.getTask(task.id)!.schedule!.nextRunAt, null);
});

test("tz task fires by wall clock in that timezone", async () => {
  const h = await makeHarness();
  const ticker = tickerFor(h);
  // 上海 09:00 = UTC 01:00：在 08:00Z（上海 16:00）建单，次日上海 09:00 触发
  const task = createCronTask(h, "0 9 * * *", "Asia/Shanghai");
  assert.equal(task.schedule!.tz, "Asia/Shanghai");
  const due = Date.parse(task.schedule!.nextRunAt!);
  assert.equal(new Date(due).toISOString(), "2026-10-22T01:00:00.000Z");
  h.nowMs.value = due + 5_000;
  await ticker.tick();
  assert.equal(h.fired.length, 1);
  assert.equal(h.store.listRuns(task.id).length, 1);
});
