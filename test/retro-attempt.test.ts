/**
 * attempt 复盘（#69）：ZCode journal 只读消费的单元面——envelope 解读（物理五值 → 逻辑
 * completed/stopped/failed）、run-settled 门、快照提取、只读性（字节不变、不建 sidecar、
 * 缺库不创建）、素材卡渲染与落盘（目录自带 gitignore）。CLI 子进程幂等在 retro-cli.test.ts。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { DWF_T0 as T0, fixtureRun, writeDwfFixture as writeFixture } from "./helpers/dwf-journal.js";
import {
  buildAttemptRetroInput,
  interpretDwfOutcome,
  materialCardPath,
  openDwfJournalReadOnly,
  parseDwfFailureEnvelope,
  readDwfAttempt,
  renderMaterialCard,
  writeMaterialCard,
} from "../src/retro-attempt.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const syncDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tb-retro-attempt-"));
  tmpDirs.push(dir);
  return dir;
};

const COMPLETED_RESULT = JSON.stringify({
  outcome: "implemented",
  headSha: "d4381910d140f5773a972031f04268e61b78b990",
  commits: ["d4381910"],
  changedFiles: ["src/a.ts", "test/a.test.ts"],
  gates: [
    { command: "pnpm typecheck", exit: 0 },
    { command: "pnpm test", exit: 0 },
  ],
  summary: "issue #49 实现完成：新增 1 个 commit、改动 7 个文件。自测门全绿。",
  notCovered: ["最终门由 daemon 在同一 SHA 重跑"],
});

// ---- envelope 解读 ----

test("parseDwfFailureEnvelope：provider/superseded/interrupted 三态与坏输入", () => {
  assert.deepEqual(
    parseDwfFailureEnvelope(
      JSON.stringify({
        stopReason: "provider",
        error: { code: "ProviderStop", message: "rate_limited [1308]" },
      }),
    ),
    { stopReason: "provider", code: "ProviderStop", message: "rate_limited [1308]", supersededBy: null },
  );
  assert.deepEqual(
    parseDwfFailureEnvelope(JSON.stringify({ stopReason: "superseded", supersededBy: "dwfrun-next" })),
    { stopReason: "superseded", code: null, message: null, supersededBy: "dwfrun-next" },
  );
  assert.deepEqual(
    parseDwfFailureEnvelope(
      JSON.stringify({
        stopReason: "interrupted",
        error: { code: "Interrupted", message: "owning session closed before the run settled" },
      }),
    ),
    { stopReason: "interrupted", code: "Interrupted", message: "owning session closed before the run settled", supersededBy: null },
  );
  assert.equal(parseDwfFailureEnvelope(null), null);
  assert.equal(parseDwfFailureEnvelope(""), null);
  assert.equal(parseDwfFailureEnvelope("not-json{"), null);
});

test("interpretDwfOutcome：物理五值 → 逻辑三值；failed+Interrupted 读作 stopped(interrupted)", () => {
  const provider = parseDwfFailureEnvelope(
    JSON.stringify({ stopReason: "provider", error: { code: "ProviderStop", message: "quota" } }),
  )!;
  assert.deepEqual(interpretDwfOutcome("completed", null), { kind: "completed" });
  assert.deepEqual(interpretDwfOutcome("cancelled", provider), {
    kind: "stopped",
    reason: "provider",
    code: "ProviderStop",
    message: "quota",
    supersededBy: null,
  });
  // 真库 2026-10-31 抽样：cancelled 物理值结算为逻辑 stopped，stopReason=interrupted + error.code=Interrupted
  const interrupted = parseDwfFailureEnvelope(
    JSON.stringify({ stopReason: "interrupted", error: { code: "Interrupted", message: "session closed" } }),
  )!;
  assert.deepEqual(interpretDwfOutcome("failed", interrupted), {
    kind: "stopped",
    reason: "interrupted",
    code: "Interrupted",
    message: "session closed",
    supersededBy: null,
  });
  const hardFail = parseDwfFailureEnvelope(
    JSON.stringify({ stopReason: "crash", error: { code: "WorkflowCompileError", message: "bad script" } }),
  )!;
  assert.deepEqual(interpretDwfOutcome("failed", hardFail), {
    kind: "failed",
    code: "WorkflowCompileError",
    message: "bad script",
  });
  assert.equal(interpretDwfOutcome("cancelled", null).kind, "stopped");
});

// ---- 快照提取 ----

test("readDwfAttempt：completed run 提取 gates/world-run/resumed 链/spent_tokens", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [
    fixtureRun({
      id: "dwfrun-origin",
      status: "cancelled",
      cwd: "/tmp/proj",
      settled: { status: "stopped", payload: { stopReason: "user" } },
      failureJson: JSON.stringify({ stopReason: "user" }),
    }),
    fixtureRun({
      id: "dwfrun-target",
      status: "completed",
      cwd: "/tmp/proj",
      resultJson: COMPLETED_RESULT,
      resumedFrom: "dwfrun-origin",
      spentTokens: 1_234_567,
      worldRuns: [
        {
          siteId: "world-read#3",
          input: { op: "run", args: ["pnpm", ["typecheck"], { timeoutMs: 60000 }] },
          result: { exitCode: 0, stdout: "typecheck ok" },
        },
        {
          siteId: "world-read#8",
          status: "failed",
          input: { op: "run", args: ["pnpm", ["test"], { timeoutMs: 600000 }] },
          result: { exitCode: 1, stdout: "fail " + "x".repeat(2000) },
          error: { message: "exit 1" },
        },
      ],
    }),
  ]);
  const db = openDwfJournalReadOnly(journalPath);
  const snapshot = readDwfAttempt(db, "dwfrun-target");
  db.close();
  assert.equal(snapshot.runId, "dwfrun-target");
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.settledStatus, "completed");
  assert.equal(snapshot.outcome.kind, "completed");
  assert.equal(snapshot.spentTokens, 1_234_567);
  assert.equal(snapshot.cwd, "/tmp/proj");
  assert.deepEqual(snapshot.gates, [
    { command: "pnpm typecheck", exit: 0 },
    { command: "pnpm test", exit: 0 },
  ]);
  assert.equal(snapshot.worldRuns.length, 2);
  assert.equal(snapshot.worldRuns[0]!.command, "pnpm typecheck");
  assert.equal(snapshot.worldRuns[0]!.exitCode, 0);
  assert.equal(snapshot.worldRuns[1]!.command, "pnpm test");
  assert.equal(snapshot.worldRuns[1]!.exitCode, 1);
  assert.equal(snapshot.worldRuns[1]!.failed, true);
  // 输出尾部：截断保结尾，失败注记（error:）拼在末尾
  assert.ok(snapshot.worldRuns[1]!.outputTail!.length < 900);
  assert.ok(snapshot.worldRuns[1]!.outputTail!.includes("…"));
  assert.ok(snapshot.worldRuns[1]!.outputTail!.endsWith("error: exit 1"));
  assert.deepEqual(snapshot.resumedChain, [
    { runId: "dwfrun-origin", name: "issue-to-pr", status: "cancelled" },
  ]);
});

test("readDwfAttempt：cancelled run 解 envelope 为 stopped；failed+Interrupted 读作 stopped(interrupted)", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [
    fixtureRun({
      id: "dwfrun-cancelled",
      status: "cancelled",
      cwd: "/tmp/proj",
      settled: {
        status: "stopped",
        payload: { stopReason: "provider", error: { code: "ProviderStop", message: "rate_limited [1308]" } },
      },
      failureJson: JSON.stringify({ stopReason: "provider", error: { code: "ProviderStop", message: "rate_limited [1308]" } }),
    }),
    fixtureRun({
      id: "dwfrun-interrupted",
      status: "failed",
      cwd: "/tmp/proj",
      settled: { status: "stopped", payload: { stopReason: "interrupted" } },
      failureJson: JSON.stringify({ stopReason: "interrupted", error: { code: "Interrupted", message: "session closed" } }),
    }),
  ]);
  const db = openDwfJournalReadOnly(journalPath);
  const cancelled = readDwfAttempt(db, "dwfrun-cancelled");
  const interrupted = readDwfAttempt(db, "dwfrun-interrupted");
  db.close();
  assert.equal(cancelled.outcome.kind, "stopped");
  assert.equal(cancelled.outcome.reason, "provider");
  assert.equal(cancelled.outcome.code, "ProviderStop");
  assert.equal(interrupted.outcome.kind, "stopped");
  assert.equal(interrupted.outcome.reason, "interrupted");
});

test("readDwfAttempt：无 run-settled 拒读（只在见 run-settled 后读）；未知 run 拒读", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [
    fixtureRun({ id: "dwfrun-running", status: "running", cwd: "/tmp/proj", settled: null }),
  ]);
  const db = openDwfJournalReadOnly(journalPath);
  assert.throws(() => readDwfAttempt(db, "dwfrun-running"), /run-settled/i);
  // 事件门在前：run 行不存在的幽灵 run 同样落在「无 run-settled」上（行缺失是防御分支，行随事件级联删除）
  assert.throws(() => readDwfAttempt(db, "dwfrun-ghost"), /run-settled/i);
  db.close();
});

test("readDwfAttempt：同一 run 多条 run-settled 取 sequence 最大", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [fixtureRun({ id: "dwfrun-multi", status: "cancelled", cwd: "/tmp/proj" })]);
  const db = new DatabaseSync(journalPath);
  db.prepare("INSERT INTO dwf_event (run_id, sequence, type, payload_json, time_created) VALUES (?, 99, 'run-settled', ?, ?)")
    .run("dwfrun-multi", JSON.stringify({ type: "run-settled", status: "stopped", stopReason: "user" }), T0 + 900);
  db.close();
  const ro = openDwfJournalReadOnly(journalPath);
  const snapshot = readDwfAttempt(ro, "dwfrun-multi");
  ro.close();
  assert.equal(snapshot.settledStatus, "stopped");
});

// ---- 只读性 ----

test("journal 只读：读后字节不变、不建 wal/shm sidecar、缺库报错不创建", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [fixtureRun({ id: "dwfrun-1", status: "completed", cwd: "/tmp/proj", resultJson: COMPLETED_RESULT })]);
  const before = readFileSync(journalPath);
  const db = openDwfJournalReadOnly(journalPath);
  readDwfAttempt(db, "dwfrun-1");
  db.close();
  assert.deepEqual(readFileSync(journalPath), before);
  const sidecars = readdirSync(dir).filter((f) => f !== "journal.sqlite");
  assert.deepEqual(sidecars, []);
  const missingPath = join(dir, "missing.sqlite");
  assert.throws(() => openDwfJournalReadOnly(missingPath), /not found|unable to open/i);
  assert.equal(existsSync(missingPath), false);
});

// ---- retro 行构建与素材卡 ----

test("buildAttemptRetroInput：source=attempt、attemptId=runId、issueNumber、status=done、findings 结构化", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [
    fixtureRun({
      id: "dwfrun-target",
      status: "completed",
      cwd: "/tmp/proj",
      resultJson: COMPLETED_RESULT,
      spentTokens: 42,
      worldRuns: [
        { siteId: "world-read#3", input: { op: "run", args: ["pnpm", ["typecheck"]] }, result: { exitCode: 0, stdout: "ok" } },
      ],
    }),
  ]);
  const db = openDwfJournalReadOnly(journalPath);
  const snapshot = readDwfAttempt(db, "dwfrun-target");
  db.close();
  const input = buildAttemptRetroInput(snapshot, { issueNumber: 49 });
  assert.equal(input.source, "attempt");
  assert.equal(input.sessionId, null);
  assert.equal(input.attemptId, "dwfrun-target");
  assert.equal(input.issueNumber, 49);
  assert.equal(input.cwd, "/tmp/proj");
  assert.equal(input.status, "done");
  assert.equal(input.attempts, 1);
  assert.ok(input.conclusion!.includes("dwfrun-target"));
  assert.ok(input.conclusion!.includes("自测门全绿"));
  const kinds = input.findings.map((f) => (f as { kind: string }).kind);
  assert.ok(kinds.includes("gates"));
  assert.ok(kinds.includes("world-runs"));
  assert.ok(kinds.includes("tokens"));
  assert.ok(kinds.includes("result"));
  assert.deepEqual(input.notCovered, ["最终门由 daemon 在同一 SHA 重跑"]);
});

test("素材卡：渲染含 run/outcome/gates/world.run 清单；落盘目录自带 gitignore 且幂等", async () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [
    fixtureRun({
      id: "dwfrun-target",
      status: "completed",
      cwd: dir,
      resultJson: COMPLETED_RESULT,
      spentTokens: 99,
      worldRuns: [
        { siteId: "world-read#3", input: { op: "run", args: ["pnpm", ["test"]] }, result: { exitCode: 0, stdout: "all pass" } },
      ],
    }),
  ]);
  const db = openDwfJournalReadOnly(journalPath);
  const snapshot = readDwfAttempt(db, "dwfrun-target");
  db.close();
  const markdown = renderMaterialCard(snapshot, { issueNumber: 49 });
  assert.ok(markdown.includes("dwfrun-target"));
  assert.ok(markdown.includes("completed"));
  assert.ok(markdown.includes("pnpm test"));
  assert.ok(markdown.includes("all pass"));
  assert.ok(markdown.includes("#49"));
  assert.ok(markdown.includes("99"));

  const cardPath = writeMaterialCard(dir, snapshot.runId, markdown);
  assert.equal(cardPath, materialCardPath(dir, snapshot.runId));
  assert.ok(existsSync(cardPath));
  const gitignore = readFileSync(join(dir, ".zcode", "retro", ".gitignore"), "utf8");
  assert.ok(gitignore.includes("*"));
  const first = readFileSync(cardPath, "utf8");
  writeMaterialCard(dir, snapshot.runId, markdown);
  assert.equal(readFileSync(cardPath, "utf8"), first);
});

test("auditor 形状 result（conclusion 无 summary）：摘要回退取 conclusion", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [
    fixtureRun({
      id: "dwfrun-auditor",
      status: "completed",
      cwd: "/tmp/proj",
      resultJson: JSON.stringify({ conclusion: "P4 受阻，工作流停止。", notCovered: ["P5–P6（未开工）"] }),
    }),
  ]);
  const db = openDwfJournalReadOnly(journalPath);
  const snapshot = readDwfAttempt(db, "dwfrun-auditor");
  db.close();
  const input = buildAttemptRetroInput(snapshot, { issueNumber: 44 });
  assert.ok(input.conclusion!.includes("P4 受阻"));
  assert.ok(renderMaterialCard(snapshot, { issueNumber: 44 }).includes("P4 受阻"));
});

test("素材卡：stopped run 渲染失败尾部与 resumed 链", () => {
  const dir = syncDir();
  const journalPath = join(dir, "journal.sqlite");
  writeFixture(journalPath, [
    fixtureRun({
      id: "dwfrun-origin",
      status: "cancelled",
      cwd: "/tmp/proj",
      settled: { status: "stopped", payload: { stopReason: "user" } },
    }),
    fixtureRun({
      id: "dwfrun-stopped",
      status: "cancelled",
      cwd: "/tmp/proj",
      resumedFrom: "dwfrun-origin",
      settled: {
        status: "stopped",
        payload: { stopReason: "provider", error: { code: "ProviderStop", message: "rate_limited [1308]" } },
      },
      failureJson: JSON.stringify({ stopReason: "provider", error: { code: "ProviderStop", message: "rate_limited [1308]" } }),
    }),
  ]);
  const db = openDwfJournalReadOnly(journalPath);
  const snapshot = readDwfAttempt(db, "dwfrun-stopped");
  db.close();
  const markdown = renderMaterialCard(snapshot, { issueNumber: 7 });
  assert.ok(markdown.includes("stopped(provider)"));
  assert.ok(markdown.includes("rate_limited [1308]"));
  assert.ok(markdown.includes("dwfrun-origin"));
  const input = buildAttemptRetroInput(snapshot, { issueNumber: 7 });
  assert.ok(input.conclusion!.includes("stopped"));
  assert.ok(input.conclusion!.includes("rate_limited"));
});
