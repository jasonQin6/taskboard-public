/** Retro 仓库契约：retro / retro_combo 两表的幂等身份、刷新语义、校验与 revision 中立（#65）。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { ConflictError, ValidationError } from "../src/errors.js";
import { parseComboRecordInput, parseRetroRecordInput } from "../src/retro-input.js";
import { Store } from "../src/store/index.js";
import { RETRO_SOURCES, RETRO_STATUSES } from "../src/store/retro-store.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const NOW_MS = Date.parse("2026-10-31T10:00:00.000Z");

const makeStore = async (): Promise<{ store: Store; dir: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-retro-"));
  tmpDirs.push(dir);
  const { db } = await openStateDb(join(dir, "taskboard.sqlite"));
  return { store: new Store(db, { now: () => NOW_MS }), dir };
};

const retroPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "headless",
  sessionId: "sess_abc",
  cwd: "/tmp/proj",
  sessionDate: "2026-10-31",
  generatedAt: "2026-10-31T09:00:00.000Z",
  promptVersion: "4",
  hookVersion: "2",
  conclusion: "切片完成",
  findings: [{ kind: "navigation", body: "docs 地图缺 retro 入口" }],
  notCovered: [],
  ...overrides,
});

const comboPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  ts: "2026-10-29T10:48:04.105Z",
  session_id: "session_combo1",
  cwd: "/tmp/proj",
  source: "backfill",
  task: "$find-skills 分析开源项目用的 skill",
  verdict: { needs: { yes: true, p_yes: 0.82 }, form: "scout", judge: "jev" },
  actual: { form_hint: "direct", form: null, skills: ["find-skills"] },
  outcome: { label: "delivered", evidence: ["write:3"], source: "inferred" },
  issue: null,
  artifact: null,
  verify: null,
  blocker: null,
  retro_path: null,
  gap: "missed",
  first_seen: "2026-10-29T10:48:04.105Z",
  last_seen: "2026-10-30T03:39:43.697Z",
  ...overrides,
});

// ---- retro 表：身份与幂等 ----

test("record 插入默认值：status=done、attempts=1、id 带 retro 前缀，且不动任何域 revision", async () => {
  const { store } = await makeStore();
  const view = store.recordRetro(parseRetroRecordInput(retroPayload()));
  assert.equal(view.status, "done");
  assert.equal(view.attempts, 1);
  assert.match(view.id, /^retro_/);
  assert.equal(view.sessionId, "sess_abc");
  assert.equal(view.attemptId, null);
  assert.equal(view.generatedAt, "2026-10-31T09:00:00.000Z");
  assert.deepEqual(view.findings, [{ kind: "navigation", body: "docs 地图缺 retro 入口" }]);
  // retro 是账本不是看板状态：写入不得推动 tasks/threads/config 任何域 revision
  assert.deepEqual(store.revisions(), { tasks: 0, threads: 0, config: 0 });
});

test("按 (source, sessionId) 幂等：重放同载荷只留一行，payload 刷新、attempts 不变", async () => {
  const { store } = await makeStore();
  const first = store.recordRetro(parseRetroRecordInput(retroPayload()));
  const second = store.recordRetro(
    parseRetroRecordInput(retroPayload({ conclusion: "复盘更新" })),
  );
  assert.equal(second.id, first.id);
  assert.equal(second.conclusion, "复盘更新");
  assert.equal(second.attempts, 1, "重放不得消耗重试预算");
  assert.equal(store.listRetros().length, 1);
  assert.equal(second.createdAt, first.createdAt);
});

test("按 (source, attemptId) 幂等：无 sessionId 的 attempt 载荷同样单行刷新", async () => {
  const { store } = await makeStore();
  const first = store.recordRetro(
    parseRetroRecordInput(retroPayload({ sessionId: null, attemptId: "dwfrun_1" })),
  );
  const second = store.recordRetro(
    parseRetroRecordInput(retroPayload({ sessionId: null, attemptId: "dwfrun_1", status: "failed" })),
  );
  assert.equal(second.id, first.id);
  assert.equal(second.status, "failed");
  assert.equal(store.listRetros().length, 1);
});

test("同 source 不同 sessionId 是两行；同 sessionId 不同 source 也是两行", async () => {
  const { store } = await makeStore();
  store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s1" })));
  store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s2" })));
  store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s1", source: "interactive" })));
  assert.equal(store.listRetros().length, 3);
});

test("attempt 键命中后回填 sessionId：身份键只补空位", async () => {
  const { store } = await makeStore();
  const first = store.recordRetro(
    parseRetroRecordInput(retroPayload({ sessionId: null, attemptId: "dwfrun_2" })),
  );
  const second = store.recordRetro(
    parseRetroRecordInput(retroPayload({ sessionId: "sess_x", attemptId: "dwfrun_2" })),
  );
  assert.equal(second.id, first.id);
  assert.equal(second.sessionId, "sess_x");
  assert.equal(store.listRetros().length, 1);
});

test("身份冲突显式报错：session 键与 attempt 键命中不同行", async () => {
  const { store } = await makeStore();
  store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s1", attemptId: "a1" })));
  store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s2", attemptId: "a2" })));
  assert.throws(
    () => store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s1", attemptId: "a2" }))),
    ConflictError,
  );
  // 同键命中但身份列与既有行矛盾同样拒绝，不静默改写身份
  assert.throws(
    () => store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s9", attemptId: "a1" }))),
    ConflictError,
  );
  assert.equal(store.listRetros().length, 2);
});

test("attempts 取 max：载荷显式抬高才抬高，重试语义由调用方声明", async () => {
  const { store } = await makeStore();
  store.recordRetro(parseRetroRecordInput(retroPayload({ status: "failed", attempts: 2 })));
  const bumped = store.recordRetro(
    parseRetroRecordInput(retroPayload({ status: "failed", attempts: 3 })),
  );
  assert.equal(bumped.attempts, 3);
  const lowered = store.recordRetro(
    parseRetroRecordInput(retroPayload({ status: "open", attempts: 1 })),
  );
  assert.equal(lowered.attempts, 3, "attempts 只增不减");
  assert.equal(lowered.status, "open");
});

test("getRetro 按 session 或 attempt 任一键取行；listRetros 按更新时间倒序", async () => {
  const { store } = await makeStore();
  store.recordRetro(parseRetroRecordInput(retroPayload({ sessionId: "s1", attemptId: "a1" })));
  store.recordRetro(
    parseRetroRecordInput(retroPayload({ source: "attempt", sessionId: null, attemptId: "a9" })),
  );
  assert.equal(store.getRetro({ source: "headless", sessionId: "s1" })?.attemptId, "a1");
  assert.equal(store.getRetro({ source: "headless", attemptId: "a1" })?.sessionId, "s1");
  assert.equal(store.getRetro({ source: "headless", attemptId: "nope" }), null);
  assert.throws(() => store.getRetro({ source: "headless" }), ValidationError);
  const listed = store.listRetros();
  assert.equal(listed.length, 2);
  assert.equal(listed[0]!.source, "attempt", "后更新者在前");
});

// ---- retro 表：载荷校验 ----

test("载荷校验：source/status 词表、身份必含其一、结构字段类型", () => {
  assert.throws(() => parseRetroRecordInput(retroPayload({ sessionId: null })), ValidationError);
  assert.throws(() => parseRetroRecordInput(retroPayload({ source: "web" })), ValidationError);
  assert.throws(() => parseRetroRecordInput(retroPayload({ status: "paused" })), ValidationError);
  assert.throws(() => parseRetroRecordInput(retroPayload({ findings: "x" })), ValidationError);
  assert.throws(() => parseRetroRecordInput(retroPayload({ generatedAt: "yesterday" })), ValidationError);
  assert.throws(() => parseRetroRecordInput(retroPayload({ cwd: "" })), ValidationError);
  // 词表面自身与表 CHECK 约束一致
  assert.deepEqual([...RETRO_SOURCES].sort(), ["attempt", "headless", "interactive"]);
  assert.deepEqual([...RETRO_STATUSES].sort(), ["done", "failed", "open", "skipped"]);
  // 缺省字段有确定默认值，不猜内容
  const minimal = parseRetroRecordInput(
    { source: "interactive", sessionId: "s", cwd: "/w" },
    { now: () => NOW_MS },
  );
  assert.equal(minimal.status, "done");
  assert.equal(minimal.attempts, 1);
  assert.equal(minimal.sessionDate, "2026-10-31");
  assert.equal(minimal.generatedAt, NOW_MS);
  assert.deepEqual(minimal.findings, []);
});

// ---- retro_combo 表：同 session 幂等刷新 ----

test("combo 插入 v1 载荷：提升列 form/form_hint/skills 与 verdict/actual/outcome 全量 JSON", async () => {
  const { store } = await makeStore();
  const view = store.recordCombo(parseComboRecordInput(comboPayload()));
  assert.equal(view.sessionId, "session_combo1");
  assert.equal(view.formHint, "direct");
  assert.equal(view.form, null);
  assert.deepEqual(view.skills, ["find-skills"]);
  assert.deepEqual(view.verdict, { needs: { yes: true, p_yes: 0.82 }, form: "scout", judge: "jev" });
  assert.deepEqual(view.outcome.label, "delivered");
  assert.equal(view.gap, "missed");
  assert.equal(view.version, 1);
});

test("combo 同 session 刷新：first_seen 冻结、last_seen 与载荷刷新、仍是一行", async () => {
  const { store } = await makeStore();
  const first = store.recordCombo(parseComboRecordInput(comboPayload()));
  const second = store.recordCombo(
    parseComboRecordInput(
      comboPayload({ task: "任务变了", last_seen: "2026-10-31T08:00:00.000Z", gap: null }),
    ),
  );
  assert.equal(second.task, "任务变了");
  assert.equal(second.firstSeen, first.firstSeen, "first_seen 首见冻结");
  assert.equal(second.lastSeen, "2026-10-31T08:00:00.000Z");
  assert.equal(second.gap, null);
  assert.equal(store.listCombos().length, 1);
});

test("combo 不同 session 各自成行；getCombo/listCombos 按 last_seen 倒序", async () => {
  const { store } = await makeStore();
  store.recordCombo(parseComboRecordInput(comboPayload({ session_id: "c1", last_seen: "2026-10-01T00:00:00.000Z" })));
  store.recordCombo(parseComboRecordInput(comboPayload({ session_id: "c2", last_seen: "2026-10-02T00:00:00.000Z" })));
  assert.equal(store.listCombos().length, 2);
  assert.equal(store.listCombos()[0]!.sessionId, "c2");
  assert.equal(store.getCombo("c1")?.sessionId, "c1");
  assert.equal(store.getCombo("nope"), null);
});

// ---- retro_combo 表：同型查询（#67；归组键唯一事实源 = retro-enhance SKILL.md P3）----

const putCombo = (store: Store, overrides: Record<string, unknown>): void => {
  store.recordCombo(parseComboRecordInput(comboPayload(overrides)));
};

test("同型匹配：form 取 actual.form 缺省 form_hint；skills 归一化（小写、去 pstack: 前缀、去重）后集合相等", async () => {
  const { store } = await makeStore();
  putCombo(store, {
    session_id: "st_a",
    actual: { form_hint: "goal", form: null, skills: ["pstack:TDD", "Code-Review", "tdd"] },
  });
  putCombo(store, {
    session_id: "st_b",
    actual: { form_hint: "goal", form: null, skills: ["code-review", "tdd"] },
    outcome: { label: "rework", source: "inferred" },
  });
  // form 终判非空时优先于 form_hint：form=lane_queue，不与 goal 组同型
  putCombo(store, {
    session_id: "st_c",
    actual: { form_hint: "goal", form: "lane_queue", skills: ["tdd", "code-review"] },
  });
  // 同 form 但 skills 集合不同
  putCombo(store, {
    session_id: "st_d",
    actual: { form_hint: "goal", form: null, skills: ["tdd"] },
  });
  const matches = store.findSameTypeCombos({ form: "goal", skills: ["code-review", "pstack:tdd"] });
  assert.deepEqual(
    matches.map((m) => m.sessionId).sort(),
    ["st_a", "st_b"],
    "归一化后集合相等即同型；form 终判与集合差异都排除 st_c/st_d",
  );
});

test("同型匹配按行内数据取 form 缺省链：查询侧 form 用原值，空 skills 只匹配空集合行", async () => {
  const { store } = await makeStore();
  putCombo(store, {
    session_id: "st_empty",
    actual: { form_hint: "direct", form: null, skills: [] },
    outcome: { label: "delivered", source: "inferred" },
  });
  putCombo(store, {
    session_id: "st_one",
    actual: { form_hint: "direct", form: null, skills: ["find-skills"] },
  });
  const empty = store.findSameTypeCombos({ form: "direct", skills: [] });
  assert.deepEqual(empty.map((m) => m.sessionId), ["st_empty"]);
  const one = store.findSameTypeCombos({ form: "direct", skills: ["find-skills"] });
  assert.deepEqual(one.map((m) => m.sessionId), ["st_one"]);
});

test("combo 载荷校验：session_id/cwd/task/source 必填，缺省字段有默认", () => {
  assert.throws(() => parseComboRecordInput(comboPayload({ session_id: "" })), ValidationError);
  assert.throws(() => parseComboRecordInput(comboPayload({ cwd: undefined })), ValidationError);
  assert.throws(() => parseComboRecordInput(comboPayload({ task: undefined })), ValidationError);
  assert.throws(() => parseComboRecordInput(comboPayload({ source: undefined })), ValidationError);
  assert.throws(
    () =>
      parseComboRecordInput(
        comboPayload({ actual: { form_hint: "direct", form: null, skills: "find-skills" } }),
      ),
    ValidationError,
  );
  const minimal = parseComboRecordInput(
    { session_id: "s", cwd: "/w", task: "t", source: "stop_hook" },
    { now: () => NOW_MS },
  );
  assert.equal(minimal.version, 1);
  assert.deepEqual(minimal.skills, []);
  assert.deepEqual(minimal.verdict, {});
  assert.equal(minimal.firstSeen, new Date(NOW_MS).toISOString());
  assert.equal(minimal.lastSeen, new Date(NOW_MS).toISOString());
});
