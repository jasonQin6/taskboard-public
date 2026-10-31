/** 领域层：事务、域 revision、任务校验（标签/工作区/父子深度成环/cron）、run 列映射、重启对账、幂等环。 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { ConflictError, NotFoundError, ValidationError } from "../src/errors.js";
import { parseCreateTaskInput, parseUpdateTaskInput } from "../src/task-input.js";
import { AutomationStore } from "../src/store/automation-store.js";
import { StoreCore } from "../src/store/core.js";
import { Store } from "../src/store/index.js";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  SettingsStore,
  validateSettingsPatch,
} from "../src/store/settings-store.js";
import { TaskStore } from "../src/store/task-store.js";
import { ThreadStore } from "../src/store/thread-store.js";
import { SHADOW_LABELS } from "../src/types.js";
import type { RevisionChange } from "../src/types.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface Harness {
  store: Store;
  nowMs: { value: number };
  dir: string;
}

const makeStore = async (): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-store-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const nowMs = { value: Date.parse("2026-10-21T10:00:00.000Z") };
  return { store: new Store(db, { now: () => nowMs.value }), nowMs, dir };
};

const createInput = (overrides: Record<string, unknown> = {}): ReturnType<typeof parseCreateTaskInput> =>
  parseCreateTaskInput({ title: "demo", prompt: "do it", workspace: "/tmp/w", ...overrides });

test("create task applies defaults and bumps only the tasks domain revision", async () => {
  const { store } = await makeStore();
  const changes: RevisionChange[] = [];
  store.subscribe((batch) => changes.push(...batch));
  const task = store.createTask(createInput());
  assert.equal(task.status, "todo");
  assert.equal(task.source, "manual");
  assert.equal(task.acceptanceMode, "human");
  assert.equal(task.automationMode, "suggest");
  assert.equal(task.workspaceMode, "current");
  assert.equal(task.goal.enabled, false);
  assert.equal(task.schedule, null);
  assert.deepEqual(task.labels, []);
  assert.equal(store.revisions().tasks, 1);
  assert.equal(store.revisions().threads, 0);
  assert.equal(store.revisions().config, 0);
  assert.deepEqual(changes, [{ domain: "tasks", revision: 1, ids: [task.id] }]);
});

test("labels normalize: trim, drop empty, dedupe, truncate to 8", async () => {
  const { store } = await makeStore();
  const task = store.createTask(
    createInput({ labels: [" a ", "", "a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
  );
  assert.deepEqual(task.labels, ["a", "b", "c", "d", "e", "f", "g", "h"]);
});

test("workspace must be an absolute path when present", async () => {
  const { store } = await makeStore();
  assert.throws(
    () => store.createTask(createInput({ workspace: "relative/path" })),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError);
      assert.match(error.message, /absolute/);
      return true;
    },
  );
  const noWorkspace = store.createTask(createInput({ workspace: null }));
  assert.equal(noWorkspace.workspace, null);
});

test("title is required", async () => {
  const { store } = await makeStore();
  assert.throws(() => store.createTask(createInput({ title: "  " })), ValidationError);
});

test("cron validation: bad expression rejected, tz without cron rejected, good pair stores nextRunAt", async () => {
  const { store } = await makeStore();
  assert.throws(() => store.createTask(createInput({ cron: "61 * * * *" })), ValidationError);
  assert.throws(() => store.createTask(createInput({ tz: "Asia/Shanghai" })), ValidationError);
  assert.throws(
    () => store.createTask(createInput({ cron: "* * * * *", tz: "Not/AZone" })),
    ValidationError,
  );
  const task = store.createTask(createInput({ cron: "30 3 * * *", tz: "Asia/Shanghai" }));
  assert.ok(task.schedule !== null);
  assert.equal(task.schedule.cron, "30 3 * * *");
  assert.equal(task.schedule.tz, "Asia/Shanghai");
  assert.ok(task.schedule.nextRunAt !== null);
  // 2026-10-21T10:00Z = 上海 18:00；次日 03:30（不存在夏令时）
  assert.equal(task.schedule.nextRunAt, "2026-10-21T19:30:00.000Z");
});

test("changing cron or tz invalidates nextRunAt and recomputes from now", async () => {
  const { store, nowMs } = await makeStore();
  const task = store.createTask(createInput({ cron: "0 9 * * *" }));
  const firstNext = task.schedule?.nextRunAt;
  nowMs.value += 6 * 3600_000;
  const updated = store.updateTask(task.id, parseUpdateTaskInput({ cron: "0 10 * * *" }));
  assert.ok(updated.schedule !== null);
  assert.notEqual(updated.schedule.nextRunAt, firstNext);
  // 清掉 cron：schedule 归空
  const cleared = store.updateTask(task.id, parseUpdateTaskInput({ cron: null }));
  assert.equal(cleared.schedule, null);
});

test("subtask depth: default cap 1, configurable to 3, cycles and archived parents rejected", async () => {
  const { store } = await makeStore();
  const root = store.createTask(createInput({ title: "root" }));
  const child = store.createTask(createInput({ title: "child", parentId: root.id }));
  assert.equal(child.parentId, root.id);
  assert.throws(
    () => store.createTask(createInput({ title: "grandchild", parentId: child.id })),
    /depth/,
  );
  store.updateSettings({ maxSubtaskDepth: 2 });
  const grandchild = store.createTask(createInput({ title: "grandchild", parentId: child.id }));
  // 成环：把 root 挂到自己的孙任务下（间接环）
  assert.throws(
    () => store.updateTask(root.id, parseUpdateTaskInput({ parentId: grandchild.id })),
    /cycle/,
  );
  // 归档父不可挂
  store.archiveTask(child.id);
  assert.throws(
    () => store.createTask(createInput({ title: "x", parentId: child.id })),
    /archived/,
  );
});

test("delete parent keeps children (dangling) with annotation; delete reports unbound threads", async () => {
  const { store } = await makeStore();
  const parent = store.createTask(createInput({ title: "parent" }));
  const child = store.createTask(createInput({ title: "child", parentId: parent.id }));
  // 绑定随任务级联删除：thread 自动回到 Inbox（不删除 thread 与证据）
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, lastActivityAt: store.now() });
  store.bindThread(parent.id, "th_1");
  const result = store.deleteTask(parent.id);
  assert.equal(result.id, parent.id);
  assert.deepEqual(result.danglingChildren, [child.id]);
  assert.deepEqual(result.unboundThreads, ["th_1"]);
  const survivor = store.getTask(child.id);
  assert.ok(survivor !== null);
  assert.equal(survivor.parentId, null);
  const notes = store.listAnnotations({ taskId: child.id });
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.kind, "parent_deleted");
  // thread 回到 Inbox（无 primary 绑定、未忽略、窗口内）
  const inbox = store.listInbox();
  assert.deepEqual(inbox.map((thread) => thread.id), ["th_1"]);
});

test("archive refuses active run, exits scheduling; unarchive re-arms from now", async () => {
  const { store, nowMs } = await makeStore();
  const task = store.createTask(createInput({ cron: "0 9 * * *" }));
  const run = store.createRun(task.id, "manual");
  assert.throws(() => store.archiveTask(task.id), ConflictError);
  store.finishRun(run.id, "completed");
  const archived = store.archiveTask(task.id);
  assert.equal(archived.schedule?.nextRunAt, null);
  nowMs.value += 7 * 24 * 3600_000;
  const back = store.unarchiveTask(task.id);
  assert.ok(back.schedule?.nextRunAt !== null);
  // 恢复后从当下重算，不补停机窗口
  assert.ok(Date.parse(back.schedule.nextRunAt) > nowMs.value);
});

test("runs: workspace required, single active run, column mapping on finish, retention 20", async () => {
  const { store } = await makeStore();
  const noWs = store.createTask(createInput({ title: "no-ws", workspace: null }));
  assert.throws(() => store.createRun(noWs.id, "manual"), /workspace/);
  const task = store.createTask(createInput({ title: "runs" }));
  const run = store.createRun(task.id, "cron");
  assert.equal(run.status, "queued");
  assert.equal(store.getTask(task.id)!.status, "running");
  assert.throws(() => store.createRun(task.id, "manual"), ConflictError);
  // 取消后回 todo，可再跑
  store.finishRun(run.id, "cancelled");
  assert.equal(store.getTask(task.id)!.status, "todo");
  const failed = store.createRun(task.id, "manual");
  store.finishRun(failed.id, "failed", { failureReason: "boom", threadId: "th_anchor" });
  assert.equal(store.getTask(task.id)!.status, "failed");
  assert.equal(store.listRuns(task.id)[0]!.threadId, "th_anchor");
  const done = store.createRun(task.id, "manual");
  store.finishRun(done.id, "completed");
  // acceptance=human：completed 不直接进 done，回 todo 等验收
  assert.equal(store.getTask(task.id)!.status, "todo");
  // 保留策略：每任务最多 20 条 run
  for (let i = 0; i < 24; i += 1) {
    const extra = store.createRun(task.id, "manual");
    store.finishRun(extra.id, "completed");
  }
  assert.equal(store.listRuns(task.id, 100).length, 20);
});

test("restart reconciliation: running→failed(orphaned) keeps thread, queued→cancelled, tasks reset to todo", async () => {
  const { store } = await makeStore();
  const a = store.createTask(createInput({ title: "a" }));
  const b = store.createTask(createInput({ title: "b" }));
  const runA = store.createRun(a.id, "manual");
  store.markRunRunning(runA.id, { threadId: "th_orphan" });
  const runB = store.createRun(b.id, "cron");
  // 遗留 pending 动作执行（先造数再跑执行）
  store.db
    .prepare(
      "INSERT INTO action_executions (id, action, status, trigger, task_id, thread_id, created_at) VALUES (?, ?, 'pending', 'auto', ?, 'th_orphan', ?)",
    )
    .run("ae_1", "continue_thread", a.id, store.now());
  const result = store.reconcileOnStartup();
  assert.deepEqual(result.orphanedRuns, [runA.id]);
  assert.deepEqual(result.cancelledRuns, [runB.id]);
  assert.deepEqual(result.failedActions, ["ae_1"]);
  assert.deepEqual(new Set(result.resetTaskIds), new Set([a.id, b.id]));
  const orphan = store.listRuns(a.id).find((candidate) => candidate.id === runA.id)!;
  assert.equal(orphan.status, "failed");
  assert.equal(orphan.orphaned, true);
  // 孤儿 run 保留 thread 锚点
  assert.equal(orphan.threadId, "th_orphan");
  const cancelled = store.listRuns(b.id).find((candidate) => candidate.id === runB.id)!;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(store.getTask(a.id)!.status, "todo");
  assert.equal(store.getTask(b.id)!.status, "todo");
  // 幂等：再跑一次对账没有新的孤儿
  const again = store.reconcileOnStartup();
  assert.deepEqual(again, { orphanedRuns: [], cancelledRuns: [], failedActions: [], resetTaskIds: [] });
});

test("idempotency ring keeps only the most recent 256 entries", async () => {
  const { store } = await makeStore();
  for (let i = 0; i < 300; i += 1) {
    store.rememberResponse(`req-${i}`, "task.create", 200, { ok: true, i });
  }
  assert.equal(store.recallResponse("req-0"), null);
  assert.equal(store.recallResponse("req-43"), null);
  // 第 256 条最旧的恰好是 req-44（300-256）
  assert.equal(store.recallResponse("req-44")?.status, 200);
  assert.deepEqual(store.recallResponse("req-299"), { action: "task.create", status: 200, response: { ok: true, i: 299 } });
  const total = (store.db.prepare("SELECT count(*) AS n FROM idempotency_keys").get() as { n: number }).n;
  assert.equal(total, 256);
});

test("settings: defaults, validated updates, unknown keys rejected", async () => {
  const { store } = await makeStore();
  const defaults = store.getSettings();
  assert.equal(defaults.automationPaused, false);
  assert.equal(defaults.idleThresholdMs, 600_000);
  assert.equal(defaults.concurrencyLimit, 2);
  assert.equal(defaults.maxSubtaskDepth, 1);
  const updated = store.updateSettings({ automationPaused: true, idleThresholdMs: 120_000 });
  assert.equal(updated.automationPaused, true);
  assert.equal(updated.idleThresholdMs, 120_000);
  assert.equal(store.getSettings().automationPaused, true);
  assert.equal(store.revisions().config, 1);
  assert.throws(() => store.updateSettings({ maxSubtaskDepth: 4 }), ValidationError);
  assert.throws(() => store.updateSettings({ concurrencyLimit: 0 }), ValidationError);
  assert.throws(
    () => store.updateSettings({ automationLiveGate: "bogus" }),
    (error: unknown) => error instanceof ValidationError && /one of: shadow, live, halted/.test(error.message),
    "gate 词汇从 AUTOMATION_GATE_MODES 派生：数组加模式后提示语跟随，拒收不变",
  );
  assert.throws(() => store.updateSettings({ nonsense: 1 }), ValidationError);
});

test("settings 纯函数直测（晨析 10-25 自 core 外挪）：mergeSettings 并集/未知键丢弃、validateSettingsPatch 逐键拒绝", () => {
  const merged = mergeSettings(DEFAULT_SETTINGS, {
    idleThresholdMs: 1000,
    retention: { runsPerTask: 5 },
    bogusKey: "x",
  });
  assert.equal(merged.idleThresholdMs, 1000, "库内值覆盖默认");
  assert.equal(merged.retention.runsPerTask, 5, "retention 子对象按字段并集（库内只存补丁）");
  assert.equal(
    merged.retention.unboundEvidenceDays,
    DEFAULT_SETTINGS.retention.unboundEvidenceDays,
    "未存字段回落默认",
  );
  assert.equal("bogusKey" in merged, false, "未知键丢弃，不透传进 Settings");
  assert.equal(mergeSettings(DEFAULT_SETTINGS, {}).idleThresholdMs, 600_000, "空存储 = 纯默认");
  assert.throws(() => validateSettingsPatch({ nonsense: 1 }), ValidationError);
  assert.throws(() => validateSettingsPatch({ concurrencyLimit: 0 }), ValidationError);
  assert.throws(() => validateSettingsPatch({ trustedProxyHosts: [""] }), ValidationError, "空串 host 拒收");
});

test("not found errors are typed", async () => {
  const { store } = await makeStore();
  assert.throws(() => store.requireTask("t_missing"), NotFoundError);
  assert.throws(() => store.moveTask("t_missing", "done"), NotFoundError);
});

test("bindThread defaults to primary; unbind removes it and the thread returns to the inbox", async () => {
  const { store, nowMs } = await makeStore();
  const task = store.createTask(createInput());
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  const binding = store.bindThread(task.id, "th_1");
  assert.deepEqual(binding, {
    taskId: task.id,
    threadId: "th_1",
    role: "primary",
    boundAt: new Date(nowMs.value).toISOString(),
  });
  assert.equal(store.getThread("th_1")!.primaryTaskId, task.id);
  assert.deepEqual(store.listInbox().map((thread) => thread.id), []);
  assert.equal(store.primaryThreadOf(task.id)!.id, "th_1");

  const removed = store.unbindThread(task.id, "th_1");
  assert.equal(removed.primaryTaskId, null);
  assert.deepEqual(store.listInbox().map((thread) => thread.id), ["th_1"]);
});

test("binding bumps the threads domain revision with the thread id", async () => {
  const { store, nowMs } = await makeStore();
  const task = store.createTask(createInput());
  store.upsertThread({ id: "th_rev", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  store.upsertThread({ id: "th_rev2", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  const changes: RevisionChange[] = [];
  store.subscribe((batch) => changes.push(...batch));
  store.bindThread(task.id, "th_rev");
  assert.deepEqual(changes, [{ domain: "threads", revision: 3, ids: ["th_rev"] }]);
});

test("a thread cannot become the primary of two tasks; derived roles never claim control", async () => {
  const { store, nowMs } = await makeStore();
  const first = store.createTask(createInput({ title: "first" }));
  const second = store.createTask(createInput({ title: "second" }));
  store.upsertThread({ id: "th_x", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  store.bindThread(first.id, "th_x");
  assert.throws(() => store.bindThread(second.id, "th_x"), ConflictError);
  // 从属关系不占 primary 席位：另一个任务可以留证据链，但不能接管自动化
  const derived = store.bindThread(second.id, "th_x", { role: "evidence_for" });
  assert.equal(derived.role, "evidence_for");
  assert.equal(store.getThread("th_x")!.primaryTaskId, first.id);
  assert.equal(store.primaryThreadOf(second.id), null);
  // 同角色重复绑定幂等，不重写 boundAt
  assert.equal(store.bindThread(first.id, "th_x").role, "primary");
});

test("bind/unbind validate task, thread and role; unbind requires an existing binding", async () => {
  const { store, nowMs } = await makeStore();
  const task = store.createTask(createInput());
  store.upsertThread({ id: "th_v", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  assert.throws(() => store.bindThread("t_missing", "th_v"), NotFoundError);
  assert.throws(() => store.bindThread(task.id, "th_missing"), NotFoundError);
  assert.throws(() => store.bindThread(task.id, "th_v", { role: "parent_of" }), ValidationError);
  assert.throws(() => store.unbindThread(task.id, "th_v"), NotFoundError);
  store.bindThread(task.id, "th_v", { role: "derived_from" });
  store.bindThread(task.id, "th_v", { role: "primary" });
  // 只删指定角色：derived_from 解绑后 primary 席位不动，线程不回 Inbox
  const removed = store.unbindThread(task.id, "th_v", { role: "derived_from" });
  assert.equal(removed.primaryTaskId, task.id);
  assert.deepEqual(store.listInbox().map((thread) => thread.id), []);
  store.unbindThread(task.id, "th_v");
  assert.deepEqual(store.listInbox().map((thread) => thread.id), ["th_v"]);
});

test("a task can hold several threads (story 15): retries and forks attach as separate bindings", async () => {
  const { store, nowMs } = await makeStore();
  const task = store.createTask(createInput());
  store.upsertThread({ id: "th_retry", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  store.upsertThread({ id: "th_fork", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  store.bindThread(task.id, "th_retry");
  store.bindThread(task.id, "th_fork");
  assert.deepEqual(store.threadsOf(task.id).map((thread) => thread.id).sort(), ["th_fork", "th_retry"]);
  // primary 唯一约束是 per-thread 的：任务可持多个 primary 绑定，线程侧互不冲突
  assert.deepEqual(store.threadBindings("th_retry").map((binding) => binding.role), ["primary"]);
  assert.deepEqual(store.threadBindings("th_fork").map((binding) => binding.role), ["primary"]);
  // 两个线程都因此退出 Inbox
  assert.deepEqual(store.listInbox().map((thread) => thread.id), []);
});

test("primaryThreadOf picks the earliest-bound primary thread deterministically (representative for UI)", async () => {
  const { store, nowMs } = await makeStore();
  const task = store.createTask(createInput());
  store.upsertThread({ id: "th_z_early", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  store.upsertThread({ id: "th_a_late", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  // 代表线程 = 绑定最早的 primary 线程；绑定顺序与 thread_id 字典序相反，
  // 无 ORDER BY 时查询走 PK 索引按字典序返回，恰好暴露任意性（红）
  store.bindThread(task.id, "th_z_early");
  store.bindThread(task.id, "th_a_late");
  assert.equal(store.primaryThreadOf(task.id)!.id, "th_z_early");
  // 代表线程被解绑后回退到次早绑定，不落 null
  store.unbindThread(task.id, "th_z_early");
  assert.equal(store.primaryThreadOf(task.id)!.id, "th_a_late");
});

test("A3: inbox shows only threads active within the 30-day window and not ignored; ignore/unignore take effect immediately", async () => {
  const { store, nowMs } = await makeStore();
  store.upsertThread({ id: "th_fresh", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value - 29 * 86_400_000 });
  store.upsertThread({ id: "th_stale", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value - 31 * 86_400_000 });
  assert.deepEqual(store.listInbox().map((thread) => thread.id), ["th_fresh"]);
  // 忽略立即生效，恢复立即回显；30 天是显示窗口不是删除策略（stale 线程与数据仍在）
  store.setThreadIgnored("th_fresh", true);
  assert.deepEqual(store.listInbox().map((thread) => thread.id), []);
  store.setThreadIgnored("th_fresh", false);
  assert.deepEqual(store.listInbox().map((thread) => thread.id), ["th_fresh"]);
  assert.equal(store.getThread("th_stale")!.id, "th_stale");
  // 窗口本身可调（按调用方覆盖，不落库）
  assert.deepEqual(store.listInbox({ windowDays: 40 }).map((thread) => thread.id), ["th_fresh", "th_stale"]);
});

test("A32: evidence of a thread bound to an archived task expires after the configured bound window; summaries and anomalies follow the thread", async () => {
  const { store, nowMs } = await makeStore();
  store.updateSettings({ retention: { runsPerTask: 20, unboundEvidenceDays: 90, boundEvidenceDays: 7 } });
  const task = store.createTask(createInput());
  store.upsertThread({ id: "th_arch", harnessId: CODEX_HARNESS_ID, lastActivityAt: nowMs.value });
  store.bindThread(task.id, "th_arch");
  const seed = store.db.prepare(
    "INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal, kind, summary, props, superseded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
  );
  seed.run("ev_old", "th_arch", "src_1", 0, "h1", null, "user_message", "old", null, Date.parse("2026-10-01T00:00:00Z"));
  seed.run("ev_new", "th_arch", "src_1", 10, "h2", null, "user_message", "new", null, nowMs.value);
  store.db
    .prepare(
      "INSERT INTO thread_summaries (id, thread_id, provenance, text, source_ref, created_at) VALUES (?, ?, 'compacted', ?, NULL, ?)",
    )
    .run("sm_1", "th_arch", "summary text", Date.parse("2026-10-01T00:00:00Z"));
  store.db
    .prepare(
      "INSERT INTO reader_anomalies (id, source_id, kind, detail, byte_offset, resolved, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)",
    )
    .run("an_1", "src_1", "bad_line", "detail", Date.parse("2026-10-01T00:00:00Z"));

  // 未归档：已绑定证据不清理（扫针 cutoff = now - boundDays）
  store.expireBoundEvidence(nowMs.value - 7 * 86_400_000);
  assert.equal(store.listEvidencePage("th_arch", { limit: 10 }).total, 2);

  // 归档 7 天内：保留；过了 7 天窗口：证据清掉，摘要与 anomaly 跟随 thread 保留
  store.archiveTask(task.id);
  const archivedAt = Date.parse(store.requireTask(task.id).archivedAt!);
  store.expireBoundEvidence(archivedAt + 6 * 86_400_000 - 7 * 86_400_000);
  assert.equal(store.listEvidencePage("th_arch", { limit: 10 }).total, 2);
  store.expireBoundEvidence(archivedAt + 8 * 86_400_000 - 7 * 86_400_000);
  assert.equal(store.listEvidencePage("th_arch", { limit: 10 }).total, 0);
  assert.ok(store.latestThreadSummary("th_arch") !== null);
  const openAnomalies = store.db
    .prepare("SELECT count(*) AS n FROM reader_anomalies WHERE source_id = 'src_1' AND resolved = 0")
    .get() as { n: number };
  assert.equal(openAnomalies.n, 1);
});

test("commitSourceScan: evidence re-attribution follows the new thread like turns do (upsert updates thread_id)", async () => {
  const { store } = await makeStore();
  const base = {
    source: {
      sourceId: "src_reattr",
      path: "/tmp/rollout.jsonl",
      threadId: "th_new",
      inode: 1,
      size: 100,
      mtime: 1,
      consumedBytes: 100,
      prefixHash: "p",
      tailHash: "t",
      nextOrdinal: 2,
      parserVersion: 1,
      rewritten: true,
    },
    threads: [],
    turns: [],
    evidence: [
      {
        threadId: "th_new",
        sourceId: "src_reattr",
        byteStart: 10,
        recordHash: "hash_1",
        turnOrdinal: null,
        kind: "message",
        summary: "same record",
        props: null,
      },
    ],
    supersedeEvidence: true,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: true,
    summaries: [],
    lineage: [],
  };
  store.commitSourceScan({ ...base, source: { ...base.source, threadId: "th_old" }, evidence: [{ ...base.evidence[0]!, threadId: "th_old" }] });
  assert.equal(store.listEvidencePage("th_old", { limit: 10 }).total, 1);

  // 同一记录（同 source/byte/hash）被重放归到另一 thread：归属必须跟随重放结果，与 turn 的迁移规则一致
  store.commitSourceScan(base);
  assert.equal(store.listEvidencePage("th_old", { limit: 10 }).total, 0);
  assert.equal(store.listEvidencePage("th_new", { limit: 10 }).total, 1);
});

test("数据库级单飞兜底：同 thread 第二笔未终态动作撞部分唯一索引，映射为 ConflictError 而非裸驱动错误", async () => {
  const { store } = await makeStore();
  store.upsertThread({ id: "th_sf", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  const first = store.beginActionExecution({ action: "thread.sample", trigger: "manual", threadId: "th_sf" });
  assert.throws(
    () => store.beginActionExecution({ action: "jev.evaluate", trigger: "auto", threadId: "th_sf" }),
    (error: unknown) => error instanceof ConflictError && /database single-flight/.test(error.message),
    "兜底判定按 errcode 而非错误文案，且必须以领域冲突（而非 500）暴露",
  );
  // 终态后槽位释放
  store.finishActionExecution(first.id, "completed", {});
  const next = store.beginActionExecution({ action: "thread.sample", trigger: "manual", threadId: "th_sf" });
  assert.equal(next.status, "running");
});

test("expireUnboundEvidence 删除时推动 threads 域 revision，空删不推（A32 广播语义）", async () => {
  const { store } = await makeStore();
  store.upsertThread({ id: "th_exp", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  // 直接种一行过期证据：删除判定只看 created_at 与绑定状态，真实扫描路径由 reader 测试覆盖
  store.db
    .prepare(
      "INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal, kind, summary, props, superseded, created_at) " +
        "VALUES ('ev_old', 'th_exp', 'src_old', 0, 'h', NULL, 'message', 'old', NULL, 0, 1)",
    )
    .run();
  const before = store.revisions().threads;
  assert.equal(store.expireUnboundEvidence(2), 1, "created_at 早于截点的未绑定证据被删除");
  assert.equal(store.revisions().threads, before + 1, "证据计数在 thread 载荷里：只删不推 revision 会停在已删视图");
  assert.equal(store.expireUnboundEvidence(2), 0, "无行可删");
  assert.equal(store.revisions().threads, before + 1, "空删不动 revision");
});

test("损坏 JSON 列容错：props/payload/detail 坏行降级，不拖垮列表视图", async () => {
  const { store } = await makeStore();
  const task = store.createTask(createInput());
  store.upsertThread({ id: "th_bad", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.db
    .prepare(
      "INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal, kind, summary, props, superseded, created_at) " +
        "VALUES ('ev_bad', 'th_bad', 'src_bad', 0, 'h', NULL, 'message', 'bad row', '{not-json', 0, 1)",
    )
    .run();
  store.db
    .prepare(
      "INSERT INTO next_action_proposals (id, thread_id, task_id, evidence_fingerprint, status, payload, created_at) " +
        "VALUES ('np_bad', 'th_bad', ?, 'fp:bad', 'pending', '{bad-json', 1)",
    )
    .run(task.id);
  store.db
    .prepare(
      "INSERT INTO action_executions (id, action, status, trigger, task_id, thread_id, request_id, detail, created_at) " +
        "VALUES ('ax_bad', 'thread.sample', 'completed', 'manual', ?, 'th_bad', NULL, '[oops', 1)",
    )
    .run(task.id);

  // 单个坏行只降级自身字段，其余行与整个列表调用照常返回
  const evidence = store.listEvidencePage("th_bad", { limit: 10 }).items;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.props, null, "坏 props 降级为 null");
  const proposal = store.listProposals().find((row) => row.id === "np_bad")!;
  assert.deepEqual(proposal.payload, {}, "坏 payload 降级为空对象");
  const execution = store.listActionExecutions({ threadId: "th_bad" }).find((row) => row.id === "ax_bad")!;
  assert.equal(execution.detail, null, "坏 detail 降级为 null");
});

test("commitSourceScan: turn 槽被另一 turn id 占住时单行降级为 anomaly，事务不回滚（残形防御）", async () => {
  const { store } = await makeStore();
  store.db
    .prepare("INSERT INTO thread_turns (id, thread_id, ordinal, native_status, source_ref) VALUES ('turn_holder', 'th_slot', 1, 'completed', 'src_other')")
    .run();
  store.commitSourceScan({
    source: {
      sourceId: "src_slot",
      path: "/tmp/rollout-slot.jsonl",
      threadId: "th_slot",
      inode: 1,
      size: 10,
      mtime: 1,
      consumedBytes: 10,
      prefixHash: "p",
      tailHash: "t",
      nextOrdinal: 2,
      parserVersion: 1,
      rewritten: false,
    },
    threads: [{ id: "th_slot", harnessId: CODEX_HARNESS_ID, nativeStatus: null, title: null, lastActivityAt: 1 }],
    turns: [{ id: "turn_main", threadId: "th_slot", ordinal: 1, nativeStatus: "completed", startedAt: 1, endedAt: 2, sourceRef: "src_slot" }],
    evidence: [],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  });
  // 不抛：整事务回滚会让该 source 每轮重扫同一文件、游标永不前进（静默毒丸）
  const anomalies = store.db
    .prepare("SELECT detail FROM reader_anomalies WHERE kind = 'turn_slot_conflict' AND resolved = 0")
    .all() as Array<{ detail: string }>;
  assert.equal(anomalies.length, 1);
  assert.match(anomalies[0]!.detail, /turn_main/);
  assert.ok(store.db.prepare("SELECT 1 FROM thread_turns WHERE id = 'turn_holder'").get(), "占位 turn 不被破坏");
});

test("SHADOW_LABELS 与 shadow_comparisons CHECK 同一词汇：逐值可落库、CHECK 外拒收、标注校验拒非法值", async () => {
  const { store } = await makeStore();
  const schemaSql = (
    store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'shadow_comparisons'").get() as { sql: string }
  ).sql;
  const checkMatch = schemaSql.match(/label IN \(([^)]*)\)/);
  assert.ok(checkMatch, "schema 必须保留 label CHECK 约束");
  const checkLabels = checkMatch[1]!.split(",").map((raw) => raw.trim().replaceAll("'", "")).sort();
  assert.deepEqual(checkLabels, [...SHADOW_LABELS].sort(), "词汇两处硬编码：一侧加值另一侧必须同步（否则 500 而非 400）");

  // 逐值插入：每个 SHADOW_LABELS 值都必须通过 CHECK 约束
  const insert = store.db.prepare(
    "INSERT INTO shadow_comparisons (id, thread_id, proposal_id, evidence_fingerprint, jev_recommended, jev_risk, executed, label, created_at) " +
      "VALUES (?, 'th_lbl', 'np_lbl', ?, 'continue_thread', 'low', 1, ?, 1)",
  );
  for (const label of SHADOW_LABELS) {
    insert.run(`sc_lbl_${label}`, `fp:${label}`, label);
  }
  assert.throws(
    () => insert.run("sc_lbl_bogus", "fp:bogus", "bogus"),
    /CHECK constraint/,
    "CHECK 外词汇必须被 schema 拒收",
  );
  // 标注入口的领域校验在 SQL 之前拦截非法值（ValidationError 而非 SQLite 约束错误）
  assert.throws(
    () => store.labelShadowComparison("sc_lbl_helpful", "bogus" as never),
    ValidationError,
  );
});

test("批量读取（latestThreadSummaries/recentAnnotationsByTask）与逐个查询 deepEqual 等价", async () => {
  const { store, nowMs } = await makeStore();
  // 夹具：3 个任务/线程；每线程多条摘要（含同 created_at 的 rowid 决胜）；一个任务注记数超页宽 50
  const threads: Array<{ taskId: string; threadId: string }> = [];
  for (let i = 0; i < 3; i += 1) {
    const task = store.createTask(createInput({ title: `t${i}` }));
    store.upsertThread({ id: `th${i}`, harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
    store.bindThread(task.id, `th${i}`);
    threads.push({ taskId: task.id, threadId: `th${i}` });
  }
  // 摘要：多轮 + 同 created_at 平级（rowid 决胜必须与 latestThreadSummary 一致：后插者赢）
  for (const { threadId } of threads) {
    store.addThreadSummary({ threadId, provenance: "compacted", text: "old" });
    store.addThreadSummary({ threadId, provenance: "sample", text: "newer" });
    const sameTs = store.db.prepare("SELECT created_at FROM thread_summaries ORDER BY rowid DESC LIMIT 1").get() as {
      created_at: number;
    };
    store.db
      .prepare("UPDATE thread_summaries SET created_at = ? WHERE rowid = (SELECT MAX(rowid) FROM thread_summaries)")
      .run(sameTs.created_at);
    store.addThreadSummary({ threadId, provenance: "none", text: "same-ts-later-insert" });
    store.db
      .prepare("UPDATE thread_summaries SET created_at = ? WHERE rowid = (SELECT MAX(rowid) FROM thread_summaries)")
      .run(sameTs.created_at);
  }
  // 注记：task0 塞 55 条（超 50 页宽），task1 恰 1 条，task2 零条；再塞一条 task_id 为 NULL 的注记
  for (let i = 0; i < 55; i += 1) {
    store.addAnnotation({ taskId: threads[0]!.taskId, threadId: threads[0]!.threadId, kind: "note", body: `n${i}` });
  }
  store.addAnnotation({ taskId: threads[1]!.taskId, kind: "note", body: "single" });
  store.addAnnotation({ kind: "note", body: "orphan" });

  const summaries = store.latestThreadSummaries();
  for (const thread of store.listThreads()) {
    assert.deepEqual(
      summaries.get(thread.id) ?? null,
      store.latestThreadSummary(thread.id),
      `thread ${thread.id} 的批量最新摘要必须与逐线程查询一致`,
    );
  }
  const byTask = store.recentAnnotationsByTask(50);
  for (const task of store.listTasks()) {
    assert.deepEqual(
      byTask.get(task.id) ?? [],
      store.listAnnotations({ taskId: task.id, limit: 50 }),
      `task ${task.id} 的批量注记必须与逐任务查询一致（含排序与 50 条截断）`,
    );
  }
  // 无注记线程/任务不产生幻影条目
  assert.equal(byTask.has(threads[2]!.taskId), false);
  assert.equal(store.recentAnnotationsByTask(50).size, 2);
  void nowMs;
});

test("latestThreadSummaries returns the persisted active summary as superseded=false", async () => {
  const { store } = await makeStore();
  store.upsertThread({ id: "th_latest", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.addThreadSummary({ threadId: "th_latest", provenance: "compacted", text: "active" });

  const latest = store.latestThreadSummaries().get("th_latest");
  assert.ok(latest !== undefined);
  assert.equal(latest.superseded, false);
});

test("rewritten source scan touches threads whose compacted summaries it supersedes", async () => {
  const { store } = await makeStore();
  store.upsertThread({ id: "th_orphan_summary", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  const source = {
    sourceId: "src_rewrite_summary",
    path: "/tmp/rollout-rewrite-summary.jsonl",
    threadId: "th_orphan_summary",
    inode: 91,
    size: 10,
    mtime: 1,
    consumedBytes: 10,
    prefixHash: "p",
    tailHash: "t",
    nextOrdinal: 1,
    parserVersion: 1,
    rewritten: false,
  };
  const base = {
    source,
    threads: [],
    turns: [],
    evidence: [],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  };
  store.commitSourceScan({
    ...base,
    summaries: [
      {
        threadId: "th_orphan_summary",
        text: "removed by rewrite",
        sourceRef: "hash_removed",
        byteStart: 0,
        recordHash: "hash_removed",
      },
    ],
  });

  const before = store.revisions().threads;
  const changes: RevisionChange[] = [];
  const unsubscribe = store.subscribe((batch) => changes.push(...batch));
  store.commitSourceScan({
    ...base,
    source: { ...source, rewritten: true },
    supersedeEvidence: true,
    rebuildTurns: true,
    resolveAnomalies: true,
  });
  unsubscribe();

  assert.equal(store.listThreadSummaries("th_orphan_summary")[0]?.superseded, true);
  assert.deepEqual(changes, [
    { domain: "threads", revision: before + 1, ids: ["th_orphan_summary"] },
  ]);
});

test("expireBoundEvidence 删除时同样推动 threads 域 revision，空删不推（#27：与 unbound 姊妹方法对齐）", async () => {
  const { store, nowMs } = await makeStore();
  // 归档任务 + primary 绑定线程 + 一行证据：bound 过期判定看 archived_at（注入时钟毫秒）与 primary 绑定
  const task = store.createTask(
    parseCreateTaskInput({ title: "archived bound", prompt: "p", workspace: "/tmp/ws" }),
  );
  store.upsertThread({ id: "th_bound", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle" });
  store.bindThread(task.id, "th_bound");
  store.archiveTask(task.id);
  const archivedBefore = nowMs.value + 1; // 截点晚于归档时刻：该任务的 bound 证据算过期
  store.db
    .prepare(
      "INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal, kind, summary, props, superseded, created_at) " +
        "VALUES ('ev_bound_old', 'th_bound', 'src_old', 0, 'h', NULL, 'message', 'old', NULL, 0, 1)",
    )
    .run();
  const before = store.revisions().threads;
  assert.equal(store.expireBoundEvidence(archivedBefore), 1, "归档任务的 primary 线程过期证据被删除");
  assert.equal(store.revisions().threads, before + 1, "#27：只删不推会让 UI 停在已删证据计数上");
  assert.equal(store.expireBoundEvidence(archivedBefore), 0, "无行可删");
  assert.equal(store.revisions().threads, before + 1, "空删不动 revision");
});

test("issue-49: 跨 harness 同 id 冲突时首插身份保留（主键稳定优先，不静默改写）", async () => {
  const { store } = await makeStore();
  const base = {
    sourceId: "src_harness_first",
    path: "/tmp/rollout-harness.jsonl",
    threadId: "th_shared",
    inode: 7,
    size: 10,
    mtime: 1,
    consumedBytes: 10,
    prefixHash: "p",
    tailHash: "t",
    nextOrdinal: 1,
    parserVersion: 1,
    rewritten: false,
  };
  const patchFor = (harnessId: string) => ({
    source: base,
    threads: [{ id: "th_shared", harnessId, nativeStatus: "completed" as const, title: null, lastActivityAt: 1 }],
    turns: [],
    evidence: [],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  });
  store.commitSourceScan(patchFor("codex"));
  store.commitSourceScan(patchFor("zcode"));
  // 主键稳定：同 id 第二次提交不翻倍、不改写首插 harness 身份
  assert.equal(store.listThreads().length, 1);
  assert.equal(store.threadIdentity("th_shared").harnessId, "codex");
});

test("issue-49: latestReaderSourceByThread 不收录 thread_id 为空串的幻影源行", async () => {
  const { store } = await makeStore();
  store.db
    .prepare(
      "INSERT INTO reader_sources (source_id, path, thread_id, inode, size, mtime, consumed_bytes, prefix_hash, tail_hash, next_ordinal, parser_version, rewritten, updated_at) " +
        "VALUES ('src_phantom', '/tmp/phantom.jsonl', '', 99, 10, 1, 10, 'p', NULL, 1, 1, 0, 1)",
    )
    .run();
  const map = store.latestReaderSourceByThread();
  assert.equal(map.has(""), false, "空串 thread_id 是脏键，不得进入每线程最新 source 映射");
});

test("StoreCore 嵌套重入（#37）：harmful 标注事务中途炸——settings/标签/审计注记随外层一并回滚", async () => {
  // 缝：AutomationStore.labelShadowComparison 门 6 路径——core.write 外层事务内嵌套
  // settings.updateSettings（settings-store.ts，经 core.write 事务缝）与 tasks.addAnnotation，
  // 原子性完全依赖 core.write 的重入复用（core.ts active 判空续写同一事务）。注入手法：手工组装
  // 族 store，TaskStore 子类只覆写 addAnnotation 令其抛错——AutomationStore 与 StoreCore 全是
  // 真实代码，最小侵入且不触碰 store 实现。
  class ExplodingAuditTasks extends TaskStore {
    override addAnnotation(...input: Parameters<TaskStore["addAnnotation"]>): never {
      void input;
      throw new Error("audit annotation exploded (injected)");
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "tb-store-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const core = new StoreCore(db, { now: () => Date.parse("2026-10-21T10:00:00.000Z") });
  const settings = new SettingsStore(core);
  const tasks = new ExplodingAuditTasks(core, settings);
  const threads = new ThreadStore(core, tasks);
  const automation = new AutomationStore(core, settings, tasks, threads);

  // 已执行（executed=1）的 shadow 快照 + 默认门 shadow：harmful 标注必然走进门 6 嵌套写分支
  db.prepare(
    "INSERT INTO shadow_comparisons (id, thread_id, proposal_id, evidence_fingerprint, jev_recommended, jev_risk, executed, label, created_at) " +
      "VALUES ('sc_reentry', 'th_reentry', 'np_reentry', 'fp:reentry', 'continue_thread', 'high', 1, NULL, 1)",
  ).run();

  assert.throws(
    () => automation.labelShadowComparison("sc_reentry", "harmful"),
    /audit annotation exploded/,
    "注入的审计炸点必须从真实门 6 路径原样穿出：updateSettings 嵌套写完成在前，addAnnotation 在后",
  );
  // 原子性三连：嵌套 settings upsert 与外层 UPDATE 同处一个事务，炸点 ROLLBACK 必须一并撤销。
  // 若重入复用失效（嵌套写各自开事务），updateSettings 要么已提交不回滚（门残留 halted），要么
  // 在外层事务未决时 BEGIN IMMEDIATE 直接冲突——任一形态都过不了下面的断言。
  assert.equal(settings.getSettings().automationLiveGate, "shadow", "settings 变更回滚：门不置 halted（部分写不残留）");
  assert.equal(automation.listShadowComparisons()[0]!.label, null, "label UPDATE 一并回滚：终局证据不留半截");
  const notes = (db.prepare("SELECT count(*) AS n FROM annotations").get() as { n: number }).n;
  assert.equal(notes, 0, "harmful 审计注记未落库（addAnnotation 抛错即整体回滚）");
  assert.deepEqual(core.revisions(), { tasks: 0, threads: 0, config: 0 }, "全库零提交：域 revision 一格未动");
});
