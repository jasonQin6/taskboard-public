/**
 * 存量组合账本一次性导入（#67）：~/.retro/combos.jsonl 全部行经 Store 事务层进主库
 * retro_combo（ADR-0024 修订：sink 已收编 taskboard，存量随之迁移），行数对账后原文件
 * 归档改名 .retired、不删除。dry-run 导入临时库，绝不触碰目标库与源文件。
 *
 * 用法：pnpm exec tsx scripts/retro-combo-backfill.ts [--src PATH] [--db PATH] [--dry-run] [--archive]
 * 输出：stdout 一份 JSON 对账报告；exit 0 = 对账一致（或已归档后的重跑），1 = 失败。
 */
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { resolveDaemonConfig } from "../src/daemon.js";
import { openStateDb } from "../src/db.js";
import { parseComboRecordInput, type ComboRecordInput } from "../src/retro-input.js";
import { Store } from "../src/store/index.js";

interface Report {
  ok: boolean;
  dryRun: boolean;
  src: string;
  dbPath: string;
  sourceLines: number;
  parsedRows: number;
  skippedLines: number;
  uniqueSessions: number;
  duplicateLines: number;
  imported: number;
  refreshed: number;
  dbRows: number;
  reconciled: boolean;
  archived: boolean;
  archivedPath?: string;
  alreadyArchived?: boolean;
}

const fail = (message: string): never => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
};

const main = async (): Promise<void> => {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      src: { type: "string" },
      db: { type: "string" },
      "dry-run": { type: "boolean" },
      archive: { type: "boolean" },
    },
  });
  const src = parsed.values.src ?? join(homedir(), ".retro", "combos.jsonl");
  const dbPath = resolveDaemonConfig(
    parsed.values.db !== undefined ? { dbPath: parsed.values.db } : {},
  ).dbPath;
  const retiredPath = `${src}.retired`;

  if (!existsSync(src)) {
    if (existsSync(retiredPath)) {
      const report: Report = {
        ok: true,
        dryRun: parsed.values["dry-run"] === true,
        src,
        dbPath,
        sourceLines: 0,
        parsedRows: 0,
        skippedLines: 0,
        uniqueSessions: 0,
        duplicateLines: 0,
        imported: 0,
        refreshed: 0,
        dbRows: 0,
        reconciled: true,
        archived: true,
        archivedPath: retiredPath,
        alreadyArchived: true,
      };
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }
    fail(`source not found: ${src}`);
  }

  // 行级去重：同 session 多行时后行胜（与 jsonl upsert 语义一致），坏行跳过计数不静默丢弃
  const lines = (await readFile(src, "utf8")).split("\n").filter((line) => line.trim().length > 0);
  const rowsByKey = new Map<string, ComboRecordInput>();
  let skippedLines = 0;
  let duplicateLines = 0;
  for (const [index, line] of lines.entries()) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    try {
      const row = parseComboRecordInput(raw);
      if (rowsByKey.has(row.sessionId)) duplicateLines += 1;
      rowsByKey.set(row.sessionId, row);
    } catch (error) {
      fail(
        `line ${index + 1} fails combo schema v1: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // dry-run 用临时库承载同一导入路径，报告可对账但不落目标库
  const scratchDir = parsed.values["dry-run"] === true ? await mkdtemp(join(tmpdir(), "tb-combo-dry-")) : null;
  const targetPath = scratchDir !== null ? join(scratchDir, "scratch.sqlite") : dbPath;
  let imported = 0;
  let refreshed = 0;
  const { db } = await openStateDb(targetPath);
  try {
    const store = new Store(db);
    for (const row of rowsByKey.values()) {
      if (store.getCombo(row.sessionId) === null) imported += 1;
      else refreshed += 1;
      store.recordCombo(row);
    }
    const dbRows = store.listCombos(Number.MAX_SAFE_INTEGER).length;
    const reconciled = dbRows === rowsByKey.size;
    const report: Report = {
      ok: reconciled,
      dryRun: scratchDir !== null,
      src,
      dbPath,
      sourceLines: lines.length,
      parsedRows: lines.length - skippedLines,
      skippedLines,
      uniqueSessions: rowsByKey.size,
      duplicateLines,
      imported,
      refreshed,
      dbRows,
      reconciled,
      archived: false,
    };
    if (!reconciled) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      fail(`reconcile mismatch: source unique sessions ${rowsByKey.size} != db rows ${dbRows}`);
    }
    if (parsed.values.archive === true && scratchDir === null) {
      if (existsSync(retiredPath)) fail(`${retiredPath} already exists, refusing to overwrite`);
      await rename(src, retiredPath);
      report.archived = true;
      report.archivedPath = retiredPath;
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    db.close();
    if (scratchDir !== null) await rm(scratchDir, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
