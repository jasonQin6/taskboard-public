/**
 * retro-combo-backfill（#67）：子进程级脚本测试——存量 combos.jsonl 导入 retro_combo 的
 * 对账、幂等与归档语义。不 mock tsx/文件系统，因为脚本本身就是被测物；fixture 用临时
 * jsonl 复刻存量形态（含重复行与坏行，真实文件不保证逐行合法）。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { Store } from "../src/store/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(new URL("../scripts/retro-combo-backfill.ts", import.meta.url));
const tsxLoaderPath = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-combo-backfill-"));
  tmpDirs.push(dir);
  return dir;
};

interface ScriptExit {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runScript = async (args: string[]): Promise<ScriptExit> => {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", pathToFileURL(tsxLoaderPath).href, scriptPath, ...args],
    { cwd: repoRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
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
      reject(new Error(`script did not exit within 30s\nstderr: ${stderr}`));
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

const comboLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  ts: "2026-10-20T10:00:00.000Z",
  session_id: "bf_1",
  cwd: "/tmp/proj",
  source: "backfill",
  task: "存量行任务",
  verdict: { judge: "none" },
  actual: { form_hint: "direct", form: null, skills: ["tdd"] },
  outcome: { label: "delivered", source: "inferred" },
  first_seen: "2026-10-20T10:00:00.000Z",
  last_seen: "2026-10-20T11:00:00.000Z",
  ...overrides,
});

const writeSource = async (dir: string, lines: string[]): Promise<string> => {
  const src = join(dir, "combos.jsonl");
  await writeFile(src, lines.join("\n") + "\n", "utf8");
  return src;
};

const countRows = async (dbPath: string): Promise<number> => {
  const { db } = await openStateDb(dbPath);
  try {
    return new Store(db).listCombos().length;
  } finally {
    db.close();
  }
};

test("dry-run：导入临时库对账（重复行后行胜、坏行跳过计数），不动目标库与源文件", async () => {
  const dir = await makeDir();
  const targetDb = join(dir, "taskboard.sqlite");
  const src = await writeSource(dir, [
    JSON.stringify(comboLine()),
    JSON.stringify(comboLine({ session_id: "bf_2", task: "第二行" })),
    JSON.stringify(comboLine({ session_id: "bf_1", task: "重复行，后行胜" })),
    JSON.stringify(comboLine({ session_id: "bf_2", task: "bf_2 也重复" })),
    "{broken json",
  ]);
  const run = await runScript(["--src", src, "--db", targetDb, "--dry-run"]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(report.dryRun, true);
  assert.equal(report.parsedRows, 4);
  assert.equal(report.skippedLines, 1);
  assert.equal(report.uniqueSessions, 2);
  assert.equal(report.duplicateLines, 2);
  assert.equal(report.dbRows, 2);
  assert.equal(report.reconciled, true);
  assert.equal(report.archived, false);
  assert.equal(existsSync(targetDb), false, "dry-run 不得创建目标库文件");
  assert.equal(existsSync(`${src}.retired`), false, "dry-run 不得归档源文件");
});

test("实导入 + 归档：目标库落 2 行、源文件改名 .retired；重复运行报 alreadyArchived 且 exit 0", async () => {
  const dir = await makeDir();
  const targetDb = join(dir, "taskboard.sqlite");
  const src = await writeSource(dir, [
    JSON.stringify(comboLine()),
    JSON.stringify(comboLine({ session_id: "bf_2" })),
  ]);
  const run = await runScript(["--src", src, "--db", targetDb, "--archive"]);
  assert.equal(run.code, 0, run.stderr);
  const report = JSON.parse(run.stdout) as Record<string, unknown>;
  assert.equal(report.imported, 2);
  assert.equal(report.reconciled, true);
  assert.equal(report.archived, true);
  assert.equal(report.dbRows, 2);
  assert.equal(await countRows(targetDb), 2);
  assert.equal(existsSync(src), false, "源文件已改名，不删除");
  assert.equal(existsSync(`${src}.retired`), true);

  const rerun = await runScript(["--src", src, "--db", targetDb]);
  assert.equal(rerun.code, 0, rerun.stderr);
  const rerunReport = JSON.parse(rerun.stdout) as Record<string, unknown>;
  assert.equal(rerunReport.alreadyArchived, true);
  assert.equal(await countRows(targetDb), 2, "重跑不得新增行");
});

test("实导入幂等：不归档重跑同源文件 → 全部 refresh，行数不变", async () => {
  const dir = await makeDir();
  const targetDb = join(dir, "taskboard.sqlite");
  const src = await writeSource(dir, [
    JSON.stringify(comboLine()),
    JSON.stringify(comboLine({ session_id: "bf_2" })),
  ]);
  const first = await runScript(["--src", src, "--db", targetDb]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal((JSON.parse(first.stdout) as Record<string, unknown>).imported, 2);
  const second = await runScript(["--src", src, "--db", targetDb]);
  assert.equal(second.code, 0, second.stderr);
  const report = JSON.parse(second.stdout) as Record<string, unknown>;
  assert.equal(report.imported, 0);
  assert.equal(report.refreshed, 2);
  assert.equal(report.dbRows, 2);
  assert.equal(await countRows(targetDb), 2);
});

test("源文件缺失且无 .retired：exit 1 报错；--archive 拒绝覆盖已存在的 .retired", async () => {
  const dir = await makeDir();
  const targetDb = join(dir, "taskboard.sqlite");
  const missing = await runScript(["--src", join(dir, "nope.jsonl"), "--db", targetDb]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /source not found/);

  const src = await writeSource(dir, [JSON.stringify(comboLine())]);
  await rename(src, `${src}.retired`);
  await writeFile(src, JSON.stringify(comboLine({ session_id: "bf_new" })) + "\n", "utf8");
  const clash = await runScript(["--src", src, "--db", targetDb, "--archive"]);
  assert.equal(clash.code, 1);
  assert.match(clash.stderr, /\.retired already exists/);
});
