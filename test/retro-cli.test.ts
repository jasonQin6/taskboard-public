/**
 * retro CLI：子进程覆盖 `taskboard retro record|combo-record --stdin` 的直连落库（ADR-0023 短命
 * CLI 写进程）、幂等与退出码；两进程同时写的并发冒烟（不丢行、不锁死）也必须真进程才有意义。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { Store } from "../src/store/index.js";
import { fixtureRun, writeDwfFixture, type FixtureRun } from "./helpers/dwf-journal.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxLoaderPath = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-retro-cli-"));
  tmpDirs.push(dir);
  return dir;
};

interface SubprocessExit {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runCli = async (
  args: string[],
  init: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<SubprocessExit> => {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", pathToFileURL(tsxLoaderPath).href, cliPath, ...args],
    { cwd: repoRoot, env: { ...process.env, ...init.env }, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin?.end(init.stdin ?? "");
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`subprocess did not exit within 30s\nstderr: ${stderr}`));
    }, 30_000);
    child.once("error", (error) => {
      clearTimeout(guard);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
  });
};

const retroPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  source: "headless",
  sessionId: "sess_cli_1",
  cwd: "/tmp/proj",
  conclusion: "CLI 冒烟",
  ...overrides,
});

const comboPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  session_id: "session_cli_1",
  cwd: "/tmp/proj",
  source: "backfill",
  task: "$find-skills 分析 skill",
  verdict: { form: "scout", judge: "jev" },
  actual: { form_hint: "direct", form: null, skills: ["find-skills"] },
  outcome: { label: "delivered", source: "inferred" },
  first_seen: "2026-10-29T10:48:04.105Z",
  last_seen: "2026-10-30T03:39:43.697Z",
  ...overrides,
});

const openStore = async (dbPath: string): Promise<Store> => {
  const { db } = await openStateDb(dbPath);
  return new Store(db);
};

test("retro record --stdin 落库并输出 JSON；同载荷重放幂等（单行、同 id、双 exit 0）", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const payload = JSON.stringify(retroPayload());
  const first = await runCli(["retro", "record", "--stdin", "--db", dbPath, "--json"], { stdin: payload });
  assert.equal(first.code, 0, first.stderr);
  const parsed = JSON.parse(first.stdout) as { ok: boolean; retro: { id: string; status: string } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.retro.status, "done");

  const second = await runCli(["retro", "record", "--stdin", "--db", dbPath, "--json"], { stdin: payload });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).retro.id, parsed.retro.id, "同身份重放返回同一行");

  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 1);
});

test("retro record 按 (source, attemptId) 幂等，TASKBOARD_DB_PATH 亦被尊重", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "env.sqlite");
  const payload = JSON.stringify(retroPayload({ sessionId: null, attemptId: "dwfrun_cli" }));
  const env = { TASKBOARD_DB_PATH: dbPath };
  await runCli(["retro", "record", "--stdin", "--json"], { stdin: payload, env });
  await runCli(["retro", "record", "--stdin", "--json"], { stdin: payload, env });
  const store = await openStore(dbPath);
  assert.equal(store.getRetro({ source: "headless", attemptId: "dwfrun_cli" })?.attempts, 1);
});

test("retro combo-record --stdin 同 session 刷新：仍一行、first_seen 冻结", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const first = await runCli(
    ["retro", "combo-record", "--stdin", "--db", dbPath, "--json"],
    { stdin: JSON.stringify(comboPayload()) },
  );
  assert.equal(first.code, 0, first.stderr);
  const refreshed = await runCli(
    ["retro", "combo-record", "--stdin", "--db", dbPath, "--json"],
    {
      stdin: JSON.stringify(
        comboPayload({ task: "刷新后的任务", last_seen: "2026-10-31T08:00:00.000Z" }),
      ),
    },
  );
  assert.equal(refreshed.code, 0, refreshed.stderr);
  const store = await openStore(dbPath);
  const combos = store.listCombos();
  assert.equal(combos.length, 1);
  assert.equal(combos[0]!.task, "刷新后的任务");
  assert.equal(combos[0]!.firstSeen, "2026-10-29T10:48:04.105Z");
  assert.equal(combos[0]!.lastSeen, "2026-10-31T08:00:00.000Z");
});

test("用法与语义失败退出码：缺 --stdin/未知子命令=2，坏 JSON/校验失败=1", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  assert.equal((await runCli(["retro", "record", "--db", dbPath])).code, 2);
  assert.equal((await runCli(["retro", "bogus", "--stdin", "--db", dbPath])).code, 2);
  assert.equal((await runCli(["retro"])).code, 2);
  const badJson = await runCli(["retro", "record", "--stdin", "--db", dbPath], { stdin: "{nope" });
  assert.equal(badJson.code, 1);
  assert.match(badJson.stderr, /invalid JSON/);
  const badPayload = await runCli(
    ["retro", "record", "--stdin", "--db", dbPath],
    { stdin: JSON.stringify({ source: "headless", cwd: "/w" }) },
  );
  assert.equal(badPayload.code, 1);
  assert.match(badPayload.stderr, /sessionId or attemptId/);
});

// ---- retro combo 查询面（#67：同型判据消费方 = stop-retro 注入文与 retro-enhance）----

const seedCombos = async (dbPath: string): Promise<void> => {
  const rows = [
    comboPayload({
      session_id: "q_a",
      actual: { form_hint: "goal", form: null, skills: ["pstack:TDD", "Code-Review"] },
      last_seen: "2026-10-28T00:00:00.000Z",
    }),
    comboPayload({
      session_id: "q_b",
      actual: { form_hint: "goal", form: null, skills: ["code-review", "tdd"] },
      outcome: { label: "delivered", source: "inferred" },
      last_seen: "2026-10-30T00:00:00.000Z",
    }),
    comboPayload({
      session_id: "q_c",
      actual: { form_hint: "goal", form: null, skills: ["tdd", "code-review"] },
      outcome: { label: "rework", source: "inferred" },
      last_seen: "2026-10-29T00:00:00.000Z",
    }),
    comboPayload({
      session_id: "q_d",
      actual: { form_hint: "direct", form: null, skills: ["find-skills"] },
      last_seen: "2026-10-27T00:00:00.000Z",
    }),
  ];
  for (const row of rows) {
    const run = await runCli(["retro", "combo-record", "--stdin", "--db", dbPath], {
      stdin: JSON.stringify(row),
    });
    assert.equal(run.code, 0, run.stderr);
  }
};

test("combo-get：按 session 取行；无行 exit 1；缺 --session exit 2", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  await seedCombos(dbPath);
  const got = await runCli(["retro", "combo-get", "--session", "q_b", "--db", dbPath, "--json"]);
  assert.equal(got.code, 0, got.stderr);
  const parsed = JSON.parse(got.stdout) as { ok: boolean; combo: { sessionId: string; formHint: string } };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.combo.sessionId, "q_b");
  assert.equal(parsed.combo.formHint, "goal");
  const missing = await runCli(["retro", "combo-get", "--session", "nope", "--db", dbPath]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no combo row/);
  assert.equal((await runCli(["retro", "combo-get", "--db", dbPath])).code, 2);
});

test("combo-list：按 last_seen 倒序，--limit 截断，文本面一行一条", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  await seedCombos(dbPath);
  const listed = await runCli(["retro", "combo-list", "--db", dbPath, "--json"]);
  assert.equal(listed.code, 0, listed.stderr);
  const parsed = JSON.parse(listed.stdout) as { ok: boolean; combos: { sessionId: string }[] };
  assert.deepEqual(parsed.combos.map((c) => c.sessionId), ["q_b", "q_c", "q_a", "q_d"]);
  const limited = await runCli(["retro", "combo-list", "--limit", "2", "--db", dbPath]);
  assert.equal(limited.code, 0, limited.stderr);
  assert.equal(limited.stdout.trim().split("\n").length, 2);
});

test("combo-same-type --form/--skills：归一化同型、delivered 计数与 ≥2 门槛", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  await seedCombos(dbPath);
  const run = await runCli(
    [
      "retro", "combo-same-type", "--form", "goal", "--skills", "pstack:tdd,code-review",
      "--db", dbPath, "--json",
    ],
  );
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as {
    ok: boolean;
    total: number;
    delivered: number;
    thresholdMet: boolean;
    matches: { sessionId: string; outcome: string }[];
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.total, 3, "q_a/q_b/q_c 同型（q_d form 与 skills 都不同）");
  assert.equal(parsed.delivered, 2);
  assert.equal(parsed.thresholdMet, true);
  assert.deepEqual(
    parsed.matches.map((m) => `${m.sessionId}:${m.outcome}`).sort(),
    ["q_a:delivered", "q_b:delivered", "q_c:rework"],
  );
  const below = await runCli(
    ["retro", "combo-same-type", "--form", "direct", "--skills", "find-skills", "--db", dbPath, "--json"],
  );
  const belowParsed = JSON.parse(below.stdout) as { delivered: number; thresholdMet: boolean };
  assert.equal(belowParsed.delivered, 1);
  assert.equal(belowParsed.thresholdMet, false, "delivered 1 < 2 不满足门槛");
});

test("combo-same-type --session：以该行自身为查询键；无行 exit 1；与 --form 同给/都不给 exit 2", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  await seedCombos(dbPath);
  const run = await runCli(["retro", "combo-same-type", "--session", "q_b", "--db", dbPath, "--json"]);
  assert.equal(run.code, 0, run.stderr);
  const parsed = JSON.parse(run.stdout) as { form: string; skills: string[]; total: number };
  assert.equal(parsed.form, "goal");
  assert.deepEqual(parsed.skills, ["code-review", "tdd"], "skills 输出归一化去重排序");
  assert.equal(parsed.total, 3);
  const missing = await runCli(["retro", "combo-same-type", "--session", "nope", "--db", dbPath]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no combo row/);
  assert.equal(
    (await runCli(["retro", "combo-same-type", "--session", "q_b", "--form", "goal", "--db", dbPath])).code,
    2,
  );
  assert.equal((await runCli(["retro", "combo-same-type", "--db", dbPath])).code, 2);
  assert.equal((await runCli(["retro", "combo-same-type", "--form", "goal", "--db", dbPath])).code, 2);
});

test("并发冒烟：空库上两进程同时 record——迁移竞争+写竞争下不丢行、不锁死", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const runs = await Promise.all([
    runCli(
      ["retro", "record", "--stdin", "--db", dbPath, "--json"],
      { stdin: JSON.stringify(retroPayload({ sessionId: "sess_concurrent_a" })) },
    ),
    runCli(
      ["retro", "record", "--stdin", "--db", dbPath, "--json"],
      { stdin: JSON.stringify(retroPayload({ sessionId: "sess_concurrent_b" })) },
    ),
  ]);
  for (const run of runs) {
    assert.equal(run.code, 0, run.stderr);
  }
  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 2, "两进程各自行都在，无一被丢");
});

test("并发冒烟：已迁移库上两进程同时 combo-record 同样收敛", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const store = await openStore(dbPath); // 预迁移，隔离纯写竞争
  store.db.close();
  const runs = await Promise.all([
    runCli(
      ["retro", "combo-record", "--stdin", "--db", dbPath, "--json"],
      { stdin: JSON.stringify(comboPayload({ session_id: "session_cc_a" })) },
    ),
    runCli(
      ["retro", "combo-record", "--stdin", "--db", dbPath, "--json"],
      { stdin: JSON.stringify(comboPayload({ session_id: "session_cc_b" })) },
    ),
  ]);
  for (const run of runs) {
    assert.equal(run.code, 0, run.stderr);
  }
  const after = await openStore(dbPath);
  assert.equal(after.listCombos().length, 2);
});

// ---- retro attempt：journal 只读消费 → source=attempt 落库 + 素材卡（#69）----

const ATTEMPT_RESULT = JSON.stringify({
  outcome: "implemented",
  headSha: "d4381910d140f5773a972031f04268e61b78b990",
  gates: [
    { command: "pnpm typecheck", exit: 0 },
    { command: "pnpm test", exit: 0 },
  ],
  summary: "issue #49 实现完成，自测门全绿。",
  notCovered: ["最终门由 daemon 在同一 SHA 重跑"],
});

const ATTEMPT_RUN: FixtureRun = {
  id: "dwfrun_attempt_1",
  status: "completed",
  cwd: "REPLACED_WITH_DIR",
  resultJson: ATTEMPT_RESULT,
  spentTokens: 1234,
  worldRuns: [
    {
      siteId: "world-read#3",
      input: { op: "run", args: ["pnpm", ["test"], { timeoutMs: 600000 }] },
      result: { exitCode: 0, stdout: "✔ all pass" },
    },
  ],
};

test("retro attempt：已结算 run 落 source=attempt 行 + 素材卡；二次执行幂等；journal 字节不变", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const journalPath = join(dir, "zcode-db.sqlite");
  writeDwfFixture(journalPath, [
    fixtureRun({ ...ATTEMPT_RUN, cwd: dir }),
  ]);
  const journalBefore = await readFile(journalPath);
  const args = ["retro", "attempt", "--run-id", ATTEMPT_RUN.id, "--issue", "49", "--journal", journalPath, "--db", dbPath, "--json"];
  const first = await runCli(args);
  assert.equal(first.code, 0, first.stderr);
  const parsed = JSON.parse(first.stdout) as {
    ok: boolean;
    retro: { id: string; source: string; attemptId: string | null; issueNumber: number | null };
    materialCard: string;
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.retro.source, "attempt");
  assert.equal(parsed.retro.attemptId, ATTEMPT_RUN.id);
  assert.equal(parsed.retro.issueNumber, 49);
  assert.equal(parsed.materialCard, join(dir, ".zcode", "retro", `material-${ATTEMPT_RUN.id}.md`));
  const card = await readFile(parsed.materialCard, "utf8");
  assert.match(card, /dwfrun_attempt_1/);
  assert.match(card, /pnpm typecheck/);
  assert.match(card, /#49/);
  const gitignore = await readFile(join(dir, ".zcode", "retro", ".gitignore"), "utf8");
  assert.match(gitignore, /\*/);

  const second = await runCli(args);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).retro.id, parsed.retro.id, "同 attempt 身份重放返回同一行");
  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 1, "二次执行不重复落行");
  const row = store.getRetro({ source: "attempt", attemptId: ATTEMPT_RUN.id });
  assert.notEqual(row, null);
  assert.equal(row!.conclusion!.includes("自测门全绿"), true);
  assert.deepEqual(row!.notCovered, ["最终门由 daemon 在同一 SHA 重跑"]);
  store.db.close();
  // 只读纪律在 CLI 面同样成立：两次消费后 journal 字节级不变
  assert.deepEqual(await readFile(journalPath), journalBefore);
});

test("retro attempt：未结算 run exit 1 不落行；缺 flag exit 2；--material-dir 覆盖素材卡目录", async () => {
  const dir = await makeDir();
  const dbPath = join(dir, "taskboard.sqlite");
  const journalPath = join(dir, "zcode-db.sqlite");
  writeDwfFixture(journalPath, [
    fixtureRun({ id: "dwfrun_attempt_live", status: "running", cwd: dir, settled: null }),
    fixtureRun({ id: "dwfrun_attempt_ok", status: "completed", cwd: dir, resultJson: ATTEMPT_RESULT }),
  ]);
  const unsettled = await runCli([
    "retro", "attempt", "--run-id", "dwfrun_attempt_live", "--issue", "7", "--journal", journalPath, "--db", dbPath,
  ]);
  assert.equal(unsettled.code, 1);
  assert.match(unsettled.stderr, /run-settled/);
  assert.equal((await runCli(["retro", "attempt", "--issue", "7", "--journal", journalPath, "--db", dbPath])).code, 2);
  assert.equal((await runCli(["retro", "attempt", "--run-id", "dwfrun_attempt_ok", "--journal", journalPath, "--db", dbPath])).code, 2);
  const materialDir = join(dir, "cards");
  const ok = await runCli([
    "retro", "attempt", "--run-id", "dwfrun_attempt_ok", "--issue", "7",
    "--journal", journalPath, "--db", dbPath, "--material-dir", materialDir, "--json",
  ]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).materialCard, join(materialDir, ".zcode", "retro", "material-dwfrun_attempt_ok.md"));
  const store = await openStore(dbPath);
  assert.equal(store.listRetros().length, 1, "未结算 run 不落行，仅成功的 attempt 落行");
  store.db.close();
});
