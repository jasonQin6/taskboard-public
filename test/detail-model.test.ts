/**
 * 线程详情数据层（issue #12）：对真实 daemon 走公开 HTTP 缝（GET /api/threads/:id 与
 * turns/evidence/summaries 分页载荷，R↔U 契约冻结形状）。验证：open 装载、cursor 分页追加、
 * SSE 按域重拉收敛（A31）、error 不丢已有数据。框架无关模块，React 仅作订阅者。
 */
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { BoardModel } from "../web/src/lib/board-model.js";
import { ThreadDetailModel } from "../web/src/lib/detail-model.js";

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，测试指到空目录
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "tb-codexhome-detail-"));

const tmpDirs: string[] = [];
const daemons: RunningDaemon[] = [];
afterEach(async () => {
  while (daemons.length > 0) await daemons.pop()!.close().catch(() => undefined);
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const boot = async (): Promise<{ daemon: RunningDaemon; base: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-detail-"));
  tmpDirs.push(dir);
  const daemon = await startDaemon({ port: 0, dbPath: join(dir, "taskboard.sqlite") });
  daemons.push(daemon);
  return { daemon, base: `http://127.0.0.1:${daemon.port}` };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

interface Fixture {
  store: RunningDaemon["store"];
  insertTurn: (threadId: string, ordinal: number, nativeStatus: string) => void;
  insertEvidence: (threadId: string, n: number, summary: string) => void;
}

const makeFixture = (daemon: RunningDaemon): Fixture => {
  const store = daemon.store;
  const now = store.now();
  return {
    store,
    insertTurn: (threadId, ordinal, nativeStatus) => {
      store.db
        .prepare(
          "INSERT INTO thread_turns (id, thread_id, ordinal, native_status, started_at, ended_at, source_ref) VALUES (?, ?, ?, ?, ?, ?, 'src')",
        )
        .run(`turn_${threadId}_${ordinal}`, threadId, ordinal, nativeStatus, now - 100 + ordinal, now - 90 + ordinal);
    },
    insertEvidence: (threadId, n, summary) => {
      store.db
        .prepare(
          "INSERT INTO thread_evidence (id, thread_id, source_id, byte_start, record_hash, turn_ordinal, kind, summary, props, superseded, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)",
        )
        .run(`ev_${threadId}_${n}`, threadId, `src_${threadId}_${n}`, n * 10, `h_${threadId}_${n}`, 0, "message", summary, now + n);
    },
  };
};

const newModel = (base: string): ThreadDetailModel => new ThreadDetailModel(base, { pageSize: 2 });

test("thread detail model: open loads detail, first pages and summaries from the frozen payloads", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_d", harnessId: CODEX_HARNESS_ID, nativeStatus: "running", title: "详情线程", lastActivityAt: fx.store.now() });
  for (let ordinal = 0; ordinal < 3; ordinal += 1) fx.insertTurn("th_d", ordinal, ordinal === 2 ? "running" : "completed");
  fx.insertEvidence("th_d", 1, "第一条证据");
  fx.store.addThreadSummary({ threadId: "th_d", provenance: "compacted", text: "压缩基线摘要" });

  const model = newModel(base);
  await model.open("th_d");
  const state = model.getState();
  assert.equal(state.threadId, "th_d");
  assert.equal(state.detail?.nativeStatus, "running");
  // 语义状态入口：本构建恒 null，但字段必须在（原生/语义分列展示的前提）
  assert.equal(state.detail?.semanticStatus, null);
  // pageSize=2：首页只装 2 条，cursor 指向剩余 1 条
  assert.equal(state.turns.length, 2);
  assert.equal(state.turnsCursor, "2");
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidenceCursor, null);
  assert.equal(state.summaries.length, 1);
  assert.equal(state.summaries[0]?.provenance, "compacted");
  assert.equal(state.error, null);
  model.close();
});

test("thread detail model: load-more appends pages until the cursor is exhausted", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_p", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) fx.insertTurn("th_p", ordinal, "completed");
  for (let n = 0; n < 3; n += 1) fx.insertEvidence("th_p", n, `证据 ${n}`);

  const model = newModel(base);
  await model.open("th_p");
  assert.equal(model.getState().turns.length, 2);
  await model.loadMoreTurns();
  assert.equal(model.getState().turns.length, 4);
  assert.equal(model.getState().turnsCursor, "4");
  await model.loadMoreTurns();
  assert.equal(model.getState().turns.length, 5);
  assert.equal(model.getState().turnsCursor, null);
  // cursor 耗尽后 load-more 是无操作，不再发请求
  await model.loadMoreTurns();
  assert.equal(model.getState().turns.length, 5);

  await model.loadMoreEvidence();
  assert.equal(model.getState().evidence.length, 3);
  assert.equal(model.getState().evidenceCursor, null);
  model.close();
});

test("thread detail model: SSE threads-domain revision triggers reload and converges (A31)", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_s", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  fx.insertTurn("th_s", 0, "completed");

  const board = new BoardModel(base, { retryMs: 50, refetchDelayMs: 10 });
  await board.refresh();
  const model = newModel(base);
  board.onRevision((change) => model.handleRevisionEvent(change));
  board.connectEvents();
  await model.open("th_s");
  assert.equal(model.getState().turns.length, 1);

  // 页面开着，reader 落了新 turn（threads 域 revision 推进）→ 详情自动重拉收敛
  fx.insertTurn("th_s", 1, "completed");
  fx.store.upsertThread({ id: "th_s", harnessId: CODEX_HARNESS_ID, nativeStatus: "running", lastActivityAt: fx.store.now() });
  await waitFor(() => model.getState().turns.length === 2);
  assert.equal(model.getState().detail?.nativeStatus, "running");
  board.close();
  model.close();
});

test("thread detail model: non-threads domains do not refetch an open detail", async () => {
  const { base } = await boot();
  const model = newModel(base);
  let fetches = 0;
  // 经公开注入缝计数：重载发生在 open 的请求之外
  const counting = new ThreadDetailModel(base, {
    pageSize: 2,
    fetchImpl: (input, init) => {
      fetches += 1;
      return fetch(input, init);
    },
  });
  await counting.open("th_absent").catch(() => undefined);
  const afterOpen = fetches;
  assert.ok(afterOpen > 0);
  counting.handleRevisionEvent({ domain: "tasks", revision: 99, ids: ["t_x"] });
  assert.equal(fetches, afterOpen);
  model.close();
  counting.close();
});

test("thread detail model: reload after load-more keeps the expanded window (no shrink back to page one)", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_w", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) fx.insertTurn("th_w", ordinal, "completed");

  const model = newModel(base);
  await model.open("th_w");
  await model.loadMoreTurns();
  await model.loadMoreTurns();
  assert.equal(model.getState().turns.length, 5);
  assert.equal(model.getState().turnsCursor, null);
  // 真机语义：SSE 域事件触发重拉，窗口必须保持用户翻页后的 5 条，不得缩回首页 2 条
  model.handleRevisionEvent({ domain: "threads", revision: 99, ids: ["th_w"] });
  await waitFor(() => model.getState().loading === false);
  assert.equal(model.getState().turns.length, 5);
  assert.equal(model.getState().turnsCursor, null);
  model.close();
});

test("thread detail model: missing thread surfaces an error and keeps the model usable", async () => {
  const { base } = await boot();
  const model = newModel(base);
  await assert.rejects(model.open("th_missing"), /404/);
  assert.equal(model.getState().error !== null, true);
  assert.equal(model.getState().detail, null);
  model.close();
});

const makeGated = (
  base: string,
  gate: (url: string) => boolean,
): { model: ThreadDetailModel; seen: string[]; release: () => void; setGate: (on: boolean) => void } => {
  let active = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const model = new ThreadDetailModel(base, {
    pageSize: 2,
    fetchImpl: (input, init) => {
      const url = String(input);
      seen.push(url);
      if (active && gate(url)) return released.then(() => fetch(input, init));
      return fetch(input, init);
    },
  });
  return { model, seen, release, setGate: (on: boolean) => (active = on) };
};

test("thread detail model: load-more of an abandoned thread is discarded and the in-flight flag resets on open", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_old", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) fx.insertTurn("th_old", ordinal, "completed");
  fx.store.upsertThread({ id: "th_new", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  for (let ordinal = 0; ordinal < 5; ordinal += 1) fx.insertTurn("th_new", ordinal, "completed");

  const { model, release, setGate } = makeGated(base, (url) => url.includes("/api/threads/th_old/turns?"));
  await model.open("th_old");
  assert.equal(model.getState().turns.length, 2);
  setGate(true);
  const pending = model.loadMoreTurns(); // 旧线程第二页停在闸门上（在途）
  model.close(); // ThreadDetailView 切线程 = effect cleanup close + open
  await model.open("th_new");
  assert.equal(model.getState().turns.length, 2);
  // inFlightTurns 已被 open 复位：新线程的 load-more 立即生效，不被旧在途请求吞掉
  await model.loadMoreTurns();
  assert.equal(model.getState().turns.length, 4);
  release();
  await pending;
  // 过期页不得污染新线程时间线，cursor 也不得被旧线程改写
  assert.equal(model.getState().turns.length, 4);
  assert.ok(model.getState().turns.every((turn) => turn.id.includes("th_new")));
  assert.equal(model.getState().turnsCursor, "4");
  model.close();
});

test("thread detail model: load-more evidence of an abandoned thread is discarded on switch", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_eo", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  for (let n = 0; n < 4; n += 1) fx.insertEvidence("th_eo", n, `旧线程证据 ${n}`);
  fx.store.upsertThread({ id: "th_en", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  for (let n = 0; n < 4; n += 1) fx.insertEvidence("th_en", n, `新线程证据 ${n}`);

  const { model, release, setGate } = makeGated(base, (url) => url.includes("/api/threads/th_eo/evidence?"));
  await model.open("th_eo");
  assert.equal(model.getState().evidence.length, 2);
  setGate(true);
  const pending = model.loadMoreEvidence();
  model.close();
  await model.open("th_en");
  release();
  await pending;
  assert.equal(model.getState().evidence.length, 2);
  assert.ok(model.getState().evidence.every((item) => item.id.includes("th_en")));
  model.close();
});

test("thread detail model: reload queued behind an abandoned reload still runs for the new thread", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_ra", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  fx.insertTurn("th_ra", 0, "completed");
  fx.store.upsertThread({ id: "th_rb", harnessId: CODEX_HARNESS_ID, nativeStatus: "running", title: "乙线程", lastActivityAt: fx.store.now() });
  fx.insertTurn("th_rb", 0, "completed");

  const { model, release, setGate } = makeGated(base, (url) => url.endsWith("/api/threads/th_ra"));
  await model.open("th_ra");
  assert.equal(model.getState().detail?.id, "th_ra");
  // SSE 语义：触发一次重载并把它停在对旧线程详情的闸门上
  setGate(true);
  model.handleRevisionEvent({ domain: "threads", revision: 99, ids: ["th_ra"] });
  await waitFor(() => model.getState().loading === true);
  // 切线程：open 内部的 reload 因在飞只能进 latest-only 排队（keep-last）后立即返回
  await model.open("th_rb");
  release();
  // 旧重载早退后，排队的重载必须重新排队执行：新线程详情最终装载，而不是停在「正在加载」
  await waitFor(() => model.getState().detail?.id === "th_rb");
  assert.equal(model.getState().error, null);
  assert.equal(model.getState().turns.length, 1);
  model.close();
});

const makeFailingGated = (
  base: string,
  gate: (url: string) => boolean,
): {
  model: ThreadDetailModel;
  release: () => void;
  setGate: (on: boolean) => void;
  gatedFetches: () => number;
} => {
  let active = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let gated = 0;
  const model = new ThreadDetailModel(base, {
    pageSize: 2,
    fetchImpl: (input, init) => {
      const url = String(input);
      if (active && gate(url)) {
        gated += 1;
        return released.then(() => new Response("boom", { status: 503 }));
      }
      return fetch(input, init);
    },
  });
  return { model, release, setGate: (on: boolean) => (active = on), gatedFetches: () => gated };
};

test("thread detail model: a failing reload with a queued reload still re-runs for the new thread", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_fa", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  fx.insertTurn("th_fa", 0, "completed");
  fx.store.upsertThread({ id: "th_fb", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  fx.insertTurn("th_fb", 0, "completed");

  const { model, release, setGate, gatedFetches } = makeFailingGated(base, (url) =>
    url.endsWith("/api/threads/th_fa"),
  );
  await model.open("th_fa");
  setGate(true);
  model.handleRevisionEvent({ domain: "threads", revision: 99, ids: ["th_fa"] });
  await waitFor(() => model.getState().loading === true);
  // 切线程：open 内部的 reload 因在飞只能排队，随即返回
  await model.open("th_fb");
  release(); // 旧重载失败（503）：错误落地后，排队的重载必须自救补跑新线程
  await waitFor(() => model.getState().detail?.id === "th_fb");
  assert.equal(model.getState().error, null);
  assert.equal(model.getState().turns.length, 1);
  assert.equal(model.getState().loading, false);
  // 失败的旧请求恰好尝试一次；自救补跑的是新线程，不被误伤重试
  assert.equal(gatedFetches(), 1);
  model.close();
});

test("thread detail model: a failing reload without a queued reload does not self-retry (no error storm)", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_fs", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  fx.insertTurn("th_fs", 0, "completed");

  const { model, release, setGate, gatedFetches } = makeFailingGated(base, (url) =>
    url.endsWith("/api/threads/th_fs"),
  );
  await model.open("th_fs");
  assert.equal(model.getState().detail?.id, "th_fs");
  setGate(true);
  model.handleRevisionEvent({ domain: "threads", revision: 99, ids: ["th_fs"] });
  await waitFor(() => model.getState().loading === true);
  release();
  await waitFor(() => model.getState().loading === false && model.getState().error !== null);
  // 失败保留已有数据；无排队意图时不得自救重试（否则 503 会引发失败风暴）
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(gatedFetches(), 1);
  assert.equal(model.getState().detail?.id, "th_fs");
  assert.ok(String(model.getState().error).includes("503"));
  model.close();
});

test("thread detail model: reload issues detail/turns/evidence/summaries in parallel", async () => {
  const { daemon, base } = await boot();
  const fx = makeFixture(daemon);
  fx.store.upsertThread({ id: "th_par", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", lastActivityAt: fx.store.now() });
  fx.insertTurn("th_par", 0, "completed");
  fx.insertEvidence("th_par", 0, "证据");

  const { model, seen, release, setGate } = makeGated(base, (url) => url.endsWith("/api/threads/th_par"));
  await model.open("th_par");
  seen.length = 0;
  setGate(true);
  model.handleRevisionEvent({ domain: "threads", revision: 99, ids: ["th_par"] });
  // 详情请求被闸住期间，turns/evidence/summaries 必须已经并行发出（顺序实现要等 detail 完成才发）
  await waitFor(() => seen.some((url) => url.includes("/turns?")) === true);
  assert.ok(seen.some((url) => url.includes("/evidence?")), seen.join(" | "));
  assert.ok(seen.some((url) => url.endsWith("/summaries")), seen.join(" | "));
  release();
  await waitFor(() => model.getState().loading === false);
  assert.equal(model.getState().detail?.id, "th_par");
  model.close();
});
