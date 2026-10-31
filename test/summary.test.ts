/**
 * Summary 数据面（issue #10 / S1）：两层摘要的评估状态、no-op 指纹去重（A12 前半）与断路器
 * （A13）。Store 层用例直接构造 Store；服务层用例走 daemon 公共 API 缝（HTTP + store 注入）
 * + 假 app-server（ADR-0012）——本机 0.163.0 无 thread/sample，一律不调真实 Codex。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openStateDb } from "../src/db.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { NotFoundError } from "../src/errors.js";
import { Store } from "../src/store/index.js";

// ---- Store 层：thread_evaluation_state 原语与证据指纹 ----

const tmpDirs: string[] = [];
afterEach(async () => {
  await closeDaemons();
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

// ---- daemon 缝：假 app-server + HTTP（ADR-0012） ----

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录（本文件进程内生效，driver 子进程继承）
const CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-summary-"));
process.env.CODEX_HOME = CODEX_HOME;

const FAKE_APP_SERVER_PATH = fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url));

const daemons: RunningDaemon[] = [];
const daemonTmpDirs: string[] = [];
const closeDaemons = async (): Promise<void> => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  assert.equal(
    process.getActiveResourcesInfo().includes("ProcessWrap"),
    false,
    "child process handle leaked after daemon close",
  );
  while (daemonTmpDirs.length > 0) await rm(daemonTmpDirs.pop()!, { recursive: true, force: true });
};

const boot = async (
  driverEnv: Record<string, string> = {},
  extraDriver: Record<string, unknown> = {},
): Promise<RunningDaemon> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-summary-d-"));
  daemonTmpDirs.push(dir);
  const daemon = await startDaemon({
    port: 0,
    dbPath: join(dir, "taskboard.sqlite"),
    driver: {
      command: process.execPath,
      args: [FAKE_APP_SERVER_PATH],
      env: { ...process.env, ...driverEnv },
      ...extraDriver,
    },
    scanIntervalMs: 20,
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

// 评估可能瞬时 409（上一次动作的槽异步释放有延迟）：只对 409 有界重试，其余状态原样返回，
// 交给调用处 status 断言带真实 body 失败——先保住证据，再消竞态
const evaluateUntilSettled = async (
  daemon: RunningDaemon,
  threadId: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const response = await post(daemon, "summary.evaluate", { threadId });
    if (response.status !== 409 || Date.now() > deadline) return response;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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

/** 在测试 CODEX_HOME 里落一条外部线程 rollout：session_id 即 threadId，带一个已完成 turn。 */
const seedRollout = async (threadId: string, turnId: string): Promise<void> => {
  const { resetClock, sessionMeta, taskComplete, taskStarted } = await import("./helpers/rollout.js");
  resetClock();
  const lines = [
    sessionMeta(0, { sessionId: threadId, cwd: "/tmp/ws" }),
    taskStarted(1, turnId),
    taskComplete(2, turnId),
  ].join("\n");
  const dir = join(CODEX_HOME, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `rollout-${threadId}.jsonl`), `${lines}\n`);
};

const waitThreadSeen = async (daemon: RunningDaemon, threadId: string, turnCount = 1): Promise<void> => {
  await until(async () => {
    const payload = await getJson<{ thread?: { turnCount: number } | null }>(daemon, `/api/threads/${threadId}`);
    return payload.thread?.turnCount === turnCount;
  });
};

const createTask = async (daemon: RunningDaemon, title: string): Promise<string> => {
  const response = await post(daemon, "task.create", {
    title,
    prompt: "do it",
    workspace: "/tmp/ws",
    status: "todo",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body.task as { id: string }).id;
};

interface Harness {
  store: Store;
  nowMs: { value: number };
}

const makeStore = async (): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-summary-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  const nowMs = { value: Date.parse("2026-10-21T10:00:00.000Z") };
  return { store: new Store(db, { now: () => nowMs.value }), nowMs };
};

const scanPatch = (
  threadId: string,
  turns: Array<{ id: string; ordinal: number; nativeStatus: "running" | "completed" | "failed" | "interrupted" }>,
) => ({
  source: {
    sourceId: `src-${threadId}`,
    path: `/tmp/rollout-${threadId}.jsonl`,
    threadId,
    inode: 1,
    size: 100,
    mtime: 1,
    consumedBytes: 100,
    prefixHash: "h",
    tailHash: null,
    nextOrdinal: null,
    parserVersion: 1,
    rewritten: false,
  },
  threads: [{ id: threadId, harnessId: CODEX_HARNESS_ID, nativeStatus: null, title: null, lastActivityAt: 1 }],
  turns: turns.map((turn) => ({ ...turn, threadId, startedAt: 1, endedAt: 2, sourceRef: "rollout:1" })),
  evidence: [],
  anomalies: [],
  summaries: [],
  lineage: [],
  resolveAnomalies: false,
});

test("evaluation state starts empty and settling records fingerprint, no-op conclusion, and timestamp", async () => {
  const { store, nowMs } = await makeStore();
  assert.equal(store.getEvaluationState("th_1"), null);
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, lastActivityAt: 1 });

  store.recordEvaluationSettled("th_1", "t0:a-");
  const state = store.getEvaluationState("th_1");
  assert.ok(state !== null);
  assert.equal(state.threadId, "th_1");
  assert.equal(state.evidenceFingerprint, "t0:a-");
  assert.equal(state.lastNoOp, true);
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(state.breakerOpen, false);
  assert.equal(state.lastEvaluatedAt, new Date(nowMs.value).toISOString());
});

test("threadEvidenceFingerprint reflects turns (incl. interrupted) and terminal actions, never time alone", async () => {
  const { store, nowMs } = await makeStore();
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, lastActivityAt: 1 });
  const baseline = store.threadEvidenceFingerprint("th_1");

  // 时间流逝本身不是证据（词汇表：不用时间戳当指纹）
  nowMs.value += 60_000;
  assert.equal(store.threadEvidenceFingerprint("th_1"), baseline);

  store.commitSourceScan(scanPatch("th_1", [{ id: "turn_1", ordinal: 1, nativeStatus: "completed" }]));
  const withTurn = store.threadEvidenceFingerprint("th_1");
  assert.notEqual(withTurn, baseline);

  // 同一 turn 状态翻转（running→completed 式）也改变指纹：按状态计数
  store.commitSourceScan(
    scanPatch("th_1", [
      { id: "turn_1", ordinal: 1, nativeStatus: "completed" },
      { id: "turn_2", ordinal: 2, nativeStatus: "interrupted" },
    ]),
  );
  const withInterrupted = store.threadEvidenceFingerprint("th_1");
  assert.notEqual(withInterrupted, withTurn);

  // 上一次动作进入终态 → 新证据；未终态动作不算
  const action = store.beginActionExecution({ action: "thread.sample", trigger: "manual", threadId: "th_1" });
  assert.equal(store.threadEvidenceFingerprint("th_1"), withInterrupted);
  store.finishActionExecution(action.id, "completed", {});
  assert.notEqual(store.threadEvidenceFingerprint("th_1"), withInterrupted);
});

test("consecutive failures open the breaker with an audit annotation at 3; failures are not no_op", async () => {
  const { store } = await makeStore();
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, lastActivityAt: 1 });
  store.recordEvaluationSettled("th_1", "t0:a-");

  const first = store.recordEvaluationFailure("th_1", "app-server request thread/sample timed out");
  assert.equal(first.consecutiveFailures, 1);
  assert.equal(first.breakerOpen, false);
  const second = store.recordEvaluationFailure("th_1", "boom");
  assert.equal(second.breakerOpen, false);
  const third = store.recordEvaluationFailure("th_1", "boom");
  assert.equal(third.consecutiveFailures, 3);
  assert.equal(third.breakerOpen, true);

  // 失败不当 no_op：已消费的指纹与 no_op 结论保持原样（新 turn 后仍允许重试）
  const state = store.getEvaluationState("th_1");
  assert.ok(state !== null);
  assert.equal(state.evidenceFingerprint, "t0:a-");
  assert.equal(state.lastNoOp, true);

  // 落审计：断路器打开必须留痕
  const annotations = store.listAnnotations().filter((a) => a.threadId === "th_1");
  const opened = annotations.filter((a) => a.kind === "evaluation_breaker_opened");
  assert.equal(opened.length, 1, JSON.stringify(annotations));
  assert.ok(opened[0].body.includes("3 consecutive failures"));
  assert.ok(opened[0].body.includes("boom"), opened[0].body);
});

test("a settled evaluation breaks the failure chain; reset clears breaker and failures but keeps evidence", async () => {
  const { store } = await makeStore();
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, lastActivityAt: 1 });
  store.recordEvaluationFailure("th_1", "boom");
  store.recordEvaluationFailure("th_1", "boom");

  store.recordEvaluationSettled("th_1", "t1:a1");
  const afterSettle = store.recordEvaluationFailure("th_1", "boom");
  assert.equal(afterSettle.consecutiveFailures, 1);
  assert.equal(afterSettle.breakerOpen, false);

  // 打开后的 reset：清断路器与连败计数，保留证据指纹（不凭空制造新证据），并落恢复审计
  store.recordEvaluationFailure("th_1", "boom");
  store.recordEvaluationFailure("th_1", "boom");
  const resumed = store.resetEvaluationBreaker("th_1");
  assert.equal(resumed.breakerOpen, false);
  assert.equal(resumed.consecutiveFailures, 0);
  assert.equal(resumed.evidenceFingerprint, "t1:a1");
  const annotations = store.listAnnotations().filter((a) => a.threadId === "th_1");
  assert.equal(annotations.filter((a) => a.kind === "evaluation_breaker_resumed").length, 1);

  // 未打开时的 reset 是幂等空操作：不重复落恢复审计
  store.resetEvaluationBreaker("th_1");
  assert.equal(
    store.listAnnotations().filter((a) => a.threadId === "th_1" && a.kind === "evaluation_breaker_resumed").length,
    1,
  );
});

test("breaker 注记只在开闸/恢复跃迁落一次并推动线程域 revision；已开闸后的连败不再重复落", async () => {
  const { store } = await makeStore();
  store.upsertThread({ id: "th_1", harnessId: CODEX_HARNESS_ID, lastActivityAt: 1 });
  store.recordEvaluationFailure("th_1", "boom");
  store.recordEvaluationFailure("th_1", "boom");
  const revisionBefore = store.revisions().threads;

  const third = store.recordEvaluationFailure("th_1", "boom x3");
  assert.equal(third.breakerOpen, true);
  assert.equal(store.revisions().threads, revisionBefore + 1, "自动评估是静默路径：开闸审计必须自推 revision 触发 SSE");
  assert.equal(store.listAnnotations().filter((a) => a.kind === "evaluation_breaker_opened").length, 1);

  // 已开闸后每多败一次：计数继续涨，但注记与 revision 都不动（只在 closed→open 跃迁落）
  const fourth = store.recordEvaluationFailure("th_1", "boom x4");
  assert.equal(fourth.consecutiveFailures, 4);
  assert.equal(fourth.breakerOpen, true);
  assert.equal(store.listAnnotations().filter((a) => a.kind === "evaluation_breaker_opened").length, 1, "重复开闸不得重发注记");
  assert.equal(store.revisions().threads, revisionBefore + 1, "非跃迁失败不推 revision");

  // 恢复跃迁同样落一次注记并推 revision；未开闸的 reset 是幂等空操作
  const resumed = store.resetEvaluationBreaker("th_1");
  assert.equal(resumed.breakerOpen, false);
  assert.equal(store.listAnnotations().filter((a) => a.kind === "evaluation_breaker_resumed").length, 1);
  assert.equal(store.revisions().threads, revisionBefore + 2, "恢复审计同样要走域广播");
  store.resetEvaluationBreaker("th_1");
  assert.equal(store.revisions().threads, revisionBefore + 2, "未开闸的 reset 不推 revision");
});

test("evaluation state mutations require an existing thread", async () => {
  const { store } = await makeStore();
  assert.throws(() => store.recordEvaluationSettled("ghost", "t0:a-"), NotFoundError);
  assert.throws(() => store.recordEvaluationFailure("ghost", "boom"), NotFoundError);
  assert.throws(() => store.resetEvaluationBreaker("ghost"), NotFoundError);
});

// ---- GoalService 失败分类：驱动级失败必须在结果上可辨（断路器的计数依据） ----

test("thread.sample reports a driver-level failure class when sampling times out (A13 失败分类)", async () => {
  const daemon = await boot(
    { FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-slow", FAKE_SAMPLE_DELAY_MS: "1500" },
    { requestTimeoutMs: 150 },
  );
  await seedRollout("ext-slow", "turn_1");
  await waitThreadSeen(daemon, "ext-slow");
  const taskId = await createTask(daemon, "slow sample");
  const bound = await post(daemon, "thread.bind", { taskId, threadId: "ext-slow" });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));

  const sampled = await post(daemon, "thread.sample", { threadId: "ext-slow" });
  assert.equal(sampled.status, 200, JSON.stringify(sampled.body));
  const sample = sampled.body.sample as Record<string, unknown>;
  // 超时是驱动级失败（断路器计数依据），不是如实回落：结果必须带 failureKind 供评估层分类
  assert.equal(sample.provenance, "none");
  assert.equal(sample.failureKind, "timeout");
  assert.match(String(sample.reason), /timed out/);
});

// ---- SummaryService 评估数据面：summary.evaluate（HTTP 动作缝） ----

/** 追加一个已完成 turn 到既有 rollout（新 ordinal，时间戳前跳）。 */
const appendCompletedTurn = async (threadId: string, turnId: string, ordinal: number): Promise<void> => {
  const { resetClock, sessionMeta, taskComplete, taskStarted, tick } = await import("./helpers/rollout.js");
  resetClock();
  const lines = [taskStarted(ordinal, turnId, tick()), taskComplete(ordinal + 1, turnId, tick())].join("\n");
  const path = join(CODEX_HOME, "sessions", `rollout-${threadId}.jsonl`);
  const { readFile, appendFile } = await import("node:fs/promises");
  if (!(await readFile(path, "utf8")).includes("session_meta")) {
    await appendFile(path, `${sessionMeta(0, { sessionId: threadId, cwd: "/tmp/ws" })}\n`);
  }
  await appendFile(path, `${lines}\n`);
};

interface EvaluationOutcomeView {
  threadId: string;
  performed: boolean;
  skipReason: string | null;
  sampled: boolean;
  failed: boolean;
  failureKind: string | null;
  provenance: "sample" | "compacted" | "none";
  held: boolean;
  reason: string | null;
  state: {
    lastEvaluatedAt: string | null;
    evidenceFingerprint: string | null;
    lastNoOp: boolean;
    consecutiveFailures: number;
    breakerOpen: boolean;
  };
}

const bindExternalThread = async (daemon: RunningDaemon, threadId: string, title: string): Promise<string> => {
  await seedRollout(threadId, "turn_1");
  await waitThreadSeen(daemon, threadId);
  const taskId = await createTask(daemon, title);
  const bound = await post(daemon, "thread.bind", { taskId, threadId });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  return taskId;
};

test("summary.evaluate samples a bound thread, lands the summary, and settles evaluation state (故事 35/36)", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-eval" });
  await bindExternalThread(daemon, "ext-eval", "evaluated");

  const evaluation = await post(daemon, "summary.evaluate", { threadId: "ext-eval" });
  assert.equal(evaluation.status, 200, JSON.stringify(evaluation.body));
  const outcome = evaluation.body.evaluation as unknown as EvaluationOutcomeView;
  assert.equal(outcome.performed, true);
  assert.equal(outcome.sampled, true);
  assert.equal(outcome.failed, false);
  assert.equal(outcome.provenance, "sample");
  assert.equal(outcome.held, false);
  assert.equal(outcome.state.lastNoOp, true);
  assert.equal(outcome.state.breakerOpen, false);
  assert.ok(outcome.state.evidenceFingerprint !== null);

  // 两层之一落库：sample 摘要进 thread_summaries 并抬升任务卡 summaryStatus
  const summaries = daemon.store.listThreadSummaries("ext-eval");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].provenance, "sample");
  const detail = await getJson<{ thread: { summary: { provenance: string } | null } }>(daemon, "/api/threads/ext-eval");
  assert.equal(detail.thread.summary?.provenance, "sample");
});

test("summary.evaluate skips repeat evaluation without new evidence and re-evaluates on a new turn (A12 前半)", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-dedup" });
  await bindExternalThread(daemon, "ext-dedup", "dedup");
  const first = await post(daemon, "summary.evaluate", { threadId: "ext-dedup" });
  assert.equal((first.body.evaluation as unknown as EvaluationOutcomeView).sampled, true);

  // 无新证据：不重复触发 sample（不落新摘要行）
  const repeat = await post(daemon, "summary.evaluate", { threadId: "ext-dedup" });
  assert.equal(repeat.status, 200, JSON.stringify(repeat.body));
  const repeatOutcome = repeat.body.evaluation as unknown as EvaluationOutcomeView;
  assert.equal(repeatOutcome.performed, false);
  assert.equal(repeatOutcome.skipReason, "no_new_evidence");
  assert.equal(daemon.store.listThreadSummaries("ext-dedup").length, 1);

  // 人工强制刷新：无新证据也允许显式重评
  const forced = await post(daemon, "summary.evaluate", { threadId: "ext-dedup", force: true });
  assert.equal((forced.body.evaluation as unknown as EvaluationOutcomeView).performed, true);

  // 新 completed turn：指纹变化 → 再次允许采样
  await appendCompletedTurn("ext-dedup", "turn_2", 3);
  await waitThreadSeen(daemon, "ext-dedup", 2);
  const afterTurn = await post(daemon, "summary.evaluate", { threadId: "ext-dedup" });
  const afterTurnOutcome = afterTurn.body.evaluation as unknown as EvaluationOutcomeView;
  assert.equal(afterTurnOutcome.performed, true);
  assert.equal(afterTurnOutcome.sampled, true);
  const summaries = daemon.store.listThreadSummaries("ext-dedup");
  // 首评 + 人工强制重评 + 新 turn 各落一条：每 thread 多轮结构化摘要（故事 35）
  assert.equal(summaries.length, 3, "每个 thread 多轮结构化摘要（故事 35）");
  assert.equal(summaries[2].text, "fake sample of ext-dedup at turn_2");
});

test("summary.evaluate falls back honestly (held, capability missing, inbox) without breaker failures (A10 评估侧)", async () => {
  // 写锁被外部持有：回落基线、held 如实记录、不计时失败
  const held = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-held2", FAKE_HELD_THREAD: "ext-held2" });
  await bindExternalThread(held, "ext-held2", "held eval");
  const heldOutcome = (await post(held, "summary.evaluate", { threadId: "ext-held2" })).body
    .evaluation as unknown as EvaluationOutcomeView;
  assert.equal(heldOutcome.sampled, false);
  assert.equal(heldOutcome.failed, false);
  assert.equal(heldOutcome.held, true);
  assert.equal(heldOutcome.state.lastNoOp, true);
  assert.equal(heldOutcome.state.consecutiveFailures, 0);
  const detail = await getJson<{ thread: { nativeStatus: string | null } }>(held, "/api/threads/ext-held2");
  assert.equal(detail.thread.nativeStatus, "held");
  // held 后无新证据不重复触发：不锤持有中的线程
  const repeat = (await post(held, "summary.evaluate", { threadId: "ext-held2" })).body
    .evaluation as unknown as EvaluationOutcomeView;
  assert.equal(repeat.performed, false);

  // 能力缺失（本机 0.163.0 镜像）：如实回落、重复显式评估也不开断路器
  const capable = await boot({ FAKE_KNOWN_THREADS: "ext-old2" });
  await bindExternalThread(capable, "ext-old2", "capability missing");
  const first = (await post(capable, "summary.evaluate", { threadId: "ext-old2" })).body
    .evaluation as unknown as EvaluationOutcomeView;
  assert.equal(first.sampled, false);
  assert.equal(first.failed, false);
  assert.equal(first.provenance, "none");
  const forcedTwice = await post(capable, "summary.evaluate", { threadId: "ext-old2", force: true });
  const forcedOutcome = forcedTwice.body.evaluation as unknown as EvaluationOutcomeView;
  assert.equal(forcedOutcome.state.breakerOpen, false);
  assert.equal(forcedOutcome.state.consecutiveFailures, 0);

  // Inbox 未绑定线程：永不 resume，回落 none 并落定
  const inbox = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-inbox2" });
  await seedRollout("ext-inbox2", "turn_1");
  await waitThreadSeen(inbox, "ext-inbox2");
  const inboxOutcome = (await post(inbox, "summary.evaluate", { threadId: "ext-inbox2" })).body
    .evaluation as unknown as EvaluationOutcomeView;
  assert.equal(inboxOutcome.sampled, false);
  assert.equal(inboxOutcome.provenance, "none");
  assert.equal(inboxOutcome.held, false);
  assert.equal(
    inbox.store.listAnnotations().filter((a) => a.kind === "thread_resume").length,
    0,
    "Inbox 线程不得发生 resume",
  );
});

// ---- 断路器（A13）：三连驱动级失败 → 熔断 + 审计 + 阻塞，人工 resume 恢复 ----

const breakerBoot = async (driverEnv: Record<string, string> = {}, extraDriver: Record<string, unknown> = {}) => {
  const daemon = await boot(
    { FAKE_WITH_SAMPLE: "1", ...driverEnv },
    { requestTimeoutMs: 150, ...extraDriver },
  );
  return daemon;
};

test("evaluation breaker opens after 3 consecutive sample failures, audits, and blocks until resume (A13)", async () => {
  const daemon = await breakerBoot({
    FAKE_KNOWN_THREADS: "ext-breaker",
    FAKE_SAMPLE_DELAY_MS: "1500",
  });
  await bindExternalThread(daemon, "ext-breaker", "breaker");

  const outcomes: EvaluationOutcomeView[] = [];
  for (let i = 0; i < 3; i += 1) {
    const response = await post(daemon, "summary.evaluate", { threadId: "ext-breaker" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    outcomes.push(response.body.evaluation as unknown as EvaluationOutcomeView);
  }
  assert.deepEqual(
    outcomes.map((o) => o.failureKind),
    ["timeout", "timeout", "timeout"],
  );
  assert.deepEqual(
    outcomes.map((o) => o.state.breakerOpen),
    [false, false, true],
  );
  assert.deepEqual(
    outcomes.map((o) => o.state.consecutiveFailures),
    [1, 2, 3],
  );
  assert.equal(outcomes[2].sampled, false);
  assert.equal(outcomes[2].failed, true);

  // 熔断落审计
  const opened = daemon.store.listAnnotations().filter(
    (a) => a.threadId === "ext-breaker" && a.kind === "evaluation_breaker_opened",
  );
  assert.equal(opened.length, 1, JSON.stringify(daemon.store.listAnnotations()));
  assert.ok(opened[0].body.includes("timed out"));

  // 熔断后评估被拒（force 也不行），人工 resume 恢复并留痕
  const blocked = await post(daemon, "summary.evaluate", { threadId: "ext-breaker", force: true });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(String(blocked.body.error), /breaker/);
  const resumed = await post(daemon, "summary.resume", { threadId: "ext-breaker" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal((resumed.body.state as { breakerOpen: boolean }).breakerOpen, false);
  assert.equal(
    daemon.store
      .listAnnotations()
      .filter((a) => a.threadId === "ext-breaker" && a.kind === "evaluation_breaker_resumed").length,
    1,
  );

  // 恢复后评估重新可达：再次超时只计 1 次连败，不再熔断
  const after = await post(daemon, "summary.evaluate", { threadId: "ext-breaker" });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const afterOutcome = after.body.evaluation as unknown as EvaluationOutcomeView;
  assert.equal(afterOutcome.failed, true);
  assert.equal(afterOutcome.state.consecutiveFailures, 1);
  assert.equal(afterOutcome.state.breakerOpen, false);
});

test("connection errors count toward the breaker as disconnected failures (A13 连接错误)", async () => {
  const daemon = await breakerBoot({
    FAKE_KNOWN_THREADS: "ext-exit",
    FAKE_EXIT_ON_SAMPLE: "1",
  });
  await bindExternalThread(daemon, "ext-exit", "exit on sample");

  for (let i = 0; i < 3; i += 1) {
    const response = await post(daemon, "summary.evaluate", { threadId: "ext-exit" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const outcome = response.body.evaluation as unknown as EvaluationOutcomeView;
    assert.equal(outcome.failed, true, JSON.stringify(outcome));
    assert.equal(outcome.failureKind, "disconnected");
    assert.equal(outcome.state.breakerOpen, i === 2);
  }
  const blocked = await post(daemon, "summary.evaluate", { threadId: "ext-exit" });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
});

// ---- 触发面（故事 48 数据面）与断路器持久化（A13 重启恢复） ----

test("a terminal action or an interrupted turn re-arms evaluation without new completed turns (故事 48)", async () => {
  const daemon = await boot({ FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-rearm" });
  await bindExternalThread(daemon, "ext-rearm", "re-arm");
  const firstResponse = await evaluateUntilSettled(daemon, "ext-rearm");
  assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.body));
  assert.equal((firstResponse.body.evaluation as unknown as EvaluationOutcomeView).performed, true);
  const secondResponse = await evaluateUntilSettled(daemon, "ext-rearm");
  assert.equal(secondResponse.status, 200, JSON.stringify(secondResponse.body));
  assert.equal(
    (secondResponse.body.evaluation as unknown as EvaluationOutcomeView).performed,
    false,
    "无新证据不重复触发",
  );

  // 上一次动作进入终态（另一次 thread.sample 手动动作）→ 待评估
  const manual = await post(daemon, "thread.sample", { threadId: "ext-rearm" });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  const afterActionResponse = await evaluateUntilSettled(daemon, "ext-rearm");
  assert.equal(afterActionResponse.status, 200, JSON.stringify(afterActionResponse.body));
  assert.equal(
    (afterActionResponse.body.evaluation as unknown as EvaluationOutcomeView).performed,
    true,
    "动作终态后应重新允许评估",
  );

  // thread interrupted（turn_aborted 落 rollout）→ 待评估
  const { resetClock, sessionMeta, taskStarted, turnAborted, tick } = await import("./helpers/rollout.js");
  resetClock();
  const lines = [taskStarted(5, "turn_int", tick()), turnAborted(6, "turn_int", tick())].join("\n");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(join(CODEX_HOME, "sessions", "rollout-ext-rearm.jsonl"), `${lines}\n`);
  await waitThreadSeen(daemon, "ext-rearm", 2);
  const afterInterruptResponse = await evaluateUntilSettled(daemon, "ext-rearm");
  assert.equal(afterInterruptResponse.status, 200, JSON.stringify(afterInterruptResponse.body));
  assert.equal(
    (afterInterruptResponse.body.evaluation as unknown as EvaluationOutcomeView).performed,
    true,
    "thread interrupted 后应重新允许评估",
  );
});

test("breaker state persists across daemon restart; manual resume recovers on the new instance (A13 重启恢复)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tb-summary-restart-"));
  daemonTmpDirs.push(dir);
  const dbPath = join(dir, "taskboard.sqlite");
  const driver = {
    command: process.execPath,
    args: [FAKE_APP_SERVER_PATH],
    env: { ...process.env, FAKE_WITH_SAMPLE: "1", FAKE_KNOWN_THREADS: "ext-restart", FAKE_SAMPLE_DELAY_MS: "1500" },
    requestTimeoutMs: 150,
  };

  const first = await startDaemon({ port: 0, dbPath, driver, scanIntervalMs: 20 });
  await bindExternalThread(first, "ext-restart", "restart");
  for (let i = 0; i < 3; i += 1) {
    await post(first, "summary.evaluate", { threadId: "ext-restart" });
  }
  const state = first.store.getEvaluationState("ext-restart");
  assert.ok(state !== null && state.breakerOpen, "熔断应已打开");
  await first.close();
  daemons.splice(daemons.indexOf(first), 1);

  // 新实例同一数据库：断路器状态持久化并随重启恢复（不自动复活评估）
  const second = await startDaemon({ port: 0, dbPath, driver, scanIntervalMs: 20 });
  daemons.push(second);
  const blocked = await post(second, "summary.evaluate", { threadId: "ext-restart" });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.equal(
    second.store.getEvaluationState("ext-restart")?.breakerOpen,
    true,
    "重启后断路器仍为打开",
  );

  const resumed = await post(second, "summary.resume", { threadId: "ext-restart" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const after = await post(second, "summary.evaluate", { threadId: "ext-restart" });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  const afterOutcome = after.body.evaluation as unknown as EvaluationOutcomeView;
  assert.equal(afterOutcome.failed, true, "慢采样依旧失败，但评估已重新可达");
  assert.equal(afterOutcome.state.consecutiveFailures, 1);
  assert.equal(afterOutcome.state.breakerOpen, false);
});

test("driver-level failure outcome reports held from the thread's native status (held 口径一致)", async () => {
  const daemon = await breakerBoot({
    FAKE_KNOWN_THREADS: "ext-held-timeout",
    FAKE_IGNORE_METHODS: "thread/resume",
  });
  await bindExternalThread(daemon, "ext-held-timeout", "held-timeout");
  daemon.store.upsertThread({ id: "ext-held-timeout", harnessId: CODEX_HARNESS_ID, nativeStatus: "held" });
  const response = await post(daemon, "summary.evaluate", { threadId: "ext-held-timeout" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const outcome = response.body.evaluation as unknown as EvaluationOutcomeView;
  assert.equal(outcome.failed, true);
  assert.equal(outcome.failureKind, "timeout");
  assert.equal(outcome.held, true, "held 取线程原生状态，不得在失败出口硬编码 false");
});

test("summary.resume 把 requestId 记进恢复审计（可关联操作请求）", async () => {
  const daemon = await breakerBoot({ FAKE_KNOWN_THREADS: "ext-resume-req", FAKE_SAMPLE_DELAY_MS: "1500" });
  await bindExternalThread(daemon, "ext-resume-req", "resume-req");
  for (let i = 0; i < 3; i += 1) {
    await post(daemon, "summary.evaluate", { threadId: "ext-resume-req" });
  }
  const resumed = await post(daemon, "summary.resume", { threadId: "ext-resume-req", requestId: "req-abc123" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const resumedAnnotations = daemon.store
    .listAnnotations()
    .filter((a) => a.threadId === "ext-resume-req" && a.kind === "evaluation_breaker_resumed");
  assert.equal(resumedAnnotations.length, 1);
  assert.ok(resumedAnnotations[0]!.body.includes("req-abc123"), resumedAnnotations[0]!.body);
});
