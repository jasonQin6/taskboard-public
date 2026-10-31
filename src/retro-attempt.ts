/**
 * attempt 复盘的 journal 消费面（#69）：只读 ~/.zcode/cli/db/db.sqlite 的 dwf_run/dwf_event/
 * dwf_node，把一个已结算的 dwf run 提炼成 retro 行载荷 + 素材卡。只读纪律（mode=ro +
 * busy_timeout、见 run-settled 才读）来自 issue #69 依赖事实；物理/逻辑状态映射（cancelled 解
 * {stopReason,error?} envelope、failed 且 error.code=Interrupted 读作 stopped(interrupted)）
 * 按 2026-10-31 真库抽样核对：run-settled 载荷的逻辑状态就是 completed|stopped 两值。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { RetroRecordInput } from "./retro-input.js";
import { queryAll, queryGet, safeParseJsonObject } from "./store/rows.js";

export const defaultDwfJournalPath = (): string =>
  join(homedir(), ".zcode", "cli", "db", "db.sqlite");

/** 素材卡目录约定（#66 Stop 注入文按 attempt 票约定的路径读卡）：<repoRoot>/.zcode/retro/ */
export const MATERIAL_DIR_SEGMENTS = [".zcode", "retro"] as const;

export const materialCardPath = (baseDir: string, runId: string): string =>
  join(baseDir, ...MATERIAL_DIR_SEGMENTS, `material-${runId}.md`);

/**
 * 只读打开 ZCode journal：URI mode=ro（不创建、不写、不建 sidecar）+ busy_timeout 吸收
 * ZCode 自身写锁的瞬时 BUSY。readOnly 选项再兜一层，双保险防任何写路径误入。
 */
export const openDwfJournalReadOnly = (dbPath: string): DatabaseSync => {
  if (!existsSync(dbPath)) {
    throw new Error(`dwf journal not found: ${dbPath}`);
  }
  return new DatabaseSync(`${pathToFileURL(dbPath).href}?mode=ro&busy_timeout=5000`, {
    readOnly: true,
  });
};

export class DwfRunMissingError extends Error {
  constructor(runId: string) {
    super(`no dwf_run row for ${runId}`);
    this.name = "DwfRunMissingError";
  }
}

export class DwfRunUnsettledError extends Error {
  constructor(runId: string) {
    super(`dwf run ${runId} has no run-settled event yet (only read after run-settled)`);
    this.name = "DwfRunUnsettledError";
  }
}

export interface DwfFailureEnvelope {
  stopReason: string | null;
  code: string | null;
  message: string | null;
  supersededBy: string | null;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** cancelled/failed 的 failure_json 是 {stopReason, error?{code,message}, supersededBy?} envelope；坏 JSON 视同缺失。 */
export const parseDwfFailureEnvelope = (raw: string | null): DwfFailureEnvelope | null => {
  if (raw === null || raw.length === 0) return null;
  const parsed = safeParseJsonObject(raw);
  if (parsed === null) return null;
  const error = parsed.error;
  const errorRecord = error !== null && typeof error === "object" ? (error as Record<string, unknown>) : {};
  return {
    stopReason: asString(parsed.stopReason),
    // 真库 code 嵌在 error.code；顶层 code 仅防御性兼容，不作为形状承诺
    code: asString(errorRecord.code) ?? asString(parsed.code),
    message: asString(errorRecord.message),
    supersededBy: asString(parsed.supersededBy),
  };
};

export type AttemptOutcome =
  | { kind: "completed" }
  | {
      kind: "stopped";
      reason: string;
      code: string | null;
      message: string | null;
      supersededBy: string | null;
    }
  | { kind: "failed"; code: string | null; message: string | null };

export const outcomeLabel = (outcome: AttemptOutcome): string => {
  if (outcome.kind === "completed") return "completed";
  if (outcome.kind === "failed") return "failed";
  return `stopped(${outcome.reason})`;
};

/**
 * 物理五值 → 逻辑三值。failed 且 code=Interrupted 是可恢复中断（daemon 研究文档 5.3.6），
 * 读作 stopped(interrupted)；cancelled 一律解 envelope，stopReason 缺失按 unknown 兜底。
 */
export const interpretDwfOutcome = (
  status: string,
  failure: DwfFailureEnvelope | null,
): AttemptOutcome => {
  if (status === "completed") return { kind: "completed" };
  if (status === "failed") {
    if (failure?.code === "Interrupted") {
      return {
        kind: "stopped",
        reason: failure.stopReason ?? "interrupted",
        code: failure.code,
        message: failure.message,
        supersededBy: failure.supersededBy,
      };
    }
    return { kind: "failed", code: failure?.code ?? null, message: failure?.message ?? null };
  }
  if (status === "cancelled") {
    return {
      kind: "stopped",
      reason: failure?.stopReason ?? "unknown",
      code: failure?.code ?? null,
      message: failure?.message ?? null,
      supersededBy: failure?.supersededBy ?? null,
    };
  }
  throw new Error(`dwf run settled with non-terminal physical status: ${status}`);
};

export interface DwfWorldRun {
  siteId: string;
  command: string;
  exitCode: number | null;
  failed: boolean;
  /** stdout/stderr 合并的输出尾部（失败节点并入 error 尾部）；截断保结尾。 */
  outputTail: string | null;
}

export interface DwfResumedLink {
  runId: string;
  name: string | null;
  status: string;
}

export interface DwfAttemptSnapshot {
  runId: string;
  name: string | null;
  cwd: string;
  status: string;
  settledStatus: string;
  settledAt: number;
  outcome: AttemptOutcome;
  spentTokens: number;
  resumedFrom: string | null;
  resumedChain: DwfResumedLink[];
  result: Record<string, unknown> | null;
  gates: { command: string; exit: number }[];
  worldRuns: DwfWorldRun[];
  failure: DwfFailureEnvelope | null;
  failureRawTail: string | null;
  timeCreated: number;
  timeUpdated: number;
}

interface RunRow {
  id: string;
  name: string | null;
  cwd: string | null;
  status: string;
  resumed_from: string | null;
  spent_tokens: number;
  result_json: string | null;
  failure_json: string | null;
  time_created: number;
  time_updated: number;
}

interface EventRow {
  sequence: number;
  payload_json: string;
  time_created: number;
}

interface NodeRow {
  site_id: string;
  status: string;
  input_json: string | null;
  result_json: string | null;
  error_json: string | null;
}

const TAIL_LIMIT = 800;

const tail = (text: string, limit = TAIL_LIMIT): string => {
  if (text.length <= limit) return text;
  return `…${text.slice(text.length - limit)}`;
};

const parseJsonObjectColumn = (raw: string | null): Record<string, unknown> | null =>
  raw === null || raw.length === 0 ? null : safeParseJsonObject(raw);

const asFiniteInt = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** world-run 输入 {op:"run",args:[cmd,argv,opts]} → 单行命令串（真库 26/26 全是此形状）。 */
const worldRunCommand = (input: Record<string, unknown> | null): string => {
  const args = input?.args;
  if (!Array.isArray(args) || args.length === 0) return "?";
  const parts = [asString(args[0]) ?? "?"];
  const argv = args[1];
  if (Array.isArray(argv)) {
    for (const arg of argv) {
      if (typeof arg === "string") parts.push(arg);
    }
  }
  return parts.join(" ");
};

const worldRunOutputTail = (
  result: Record<string, unknown> | null,
  error: Record<string, unknown> | null,
): string | null => {
  const chunks: string[] = [];
  for (const key of ["stdout", "stderr"]) {
    const value = result?.[key];
    if (typeof value === "string" && value.length > 0) chunks.push(value);
  }
  const errorMessage = error?.message;
  if (typeof errorMessage === "string" && errorMessage.length > 0) chunks.push(`error: ${errorMessage}`);
  return chunks.length === 0 ? null : tail(chunks.join("\n"));
};

const extractGates = (result: Record<string, unknown> | null): { command: string; exit: number }[] => {
  const gates = result?.gates;
  if (!Array.isArray(gates)) return [];
  const parsed: { command: string; exit: number }[] = [];
  for (const gate of gates) {
    if (gate === null || typeof gate !== "object") continue;
    const record = gate as Record<string, unknown>;
    const command = asString(record.command);
    const exit = asFiniteInt(record.exit);
    if (command !== null && exit !== null) parsed.push({ command, exit });
  }
  return parsed;
};

/** resumed_from 回溯链：只取祖先元数据，不再下钻其事件/节点；环与超深（>16）截断。 */
const readResumedChain = (db: DatabaseSync, firstAncestor: string | null): DwfResumedLink[] => {
  const chain: DwfResumedLink[] = [];
  const seen = new Set<string>();
  let current = firstAncestor;
  while (current !== null && current.length > 0 && !seen.has(current) && chain.length < 16) {
    seen.add(current);
    const row = queryGet<{ id: string; name: string | null; status: string; resumed_from: string | null }>(
      db,
      "SELECT id, name, status, resumed_from FROM dwf_run WHERE id = ?",
      current,
    );
    if (row === undefined) break;
    chain.push({ runId: row.id, name: row.name, status: row.status });
    current = row.resumed_from;
  }
  return chain;
};

/** 只在见 run-settled 后读：先查事件（取 sequence 最大的一条——真库存在同 run 双 settled），再取 run 行与节点。 */
export const readDwfAttempt = (db: DatabaseSync, runId: string): DwfAttemptSnapshot => {
  const settled = queryGet<EventRow>(
    db,
    `SELECT sequence, payload_json, time_created FROM dwf_event
     WHERE run_id = ? AND type = 'run-settled' ORDER BY sequence DESC LIMIT 1`,
    runId,
  );
  if (settled === undefined) throw new DwfRunUnsettledError(runId);
  const run = queryGet<RunRow>(db, "SELECT * FROM dwf_run WHERE id = ?", runId);
  if (run === undefined) throw new DwfRunMissingError(runId);

  const settledPayload = parseJsonObjectColumn(settled.payload_json) ?? {};
  const failure = parseDwfFailureEnvelope(run.failure_json);
  const result = run.status === "completed" ? parseJsonObjectColumn(run.result_json) : null;
  const nodes = queryAll<NodeRow>(
    db,
    "SELECT site_id, status, input_json, result_json, error_json FROM dwf_node WHERE run_id = ? AND kind = 'world-run' ORDER BY rowid",
    runId,
  );
  const worldRuns: DwfWorldRun[] = nodes.map((node) => {
    const resultJson = parseJsonObjectColumn(node.result_json);
    return {
      siteId: node.site_id,
      command: worldRunCommand(parseJsonObjectColumn(node.input_json)),
      exitCode: asFiniteInt(resultJson?.exitCode),
      failed: node.status === "failed",
      outputTail: worldRunOutputTail(resultJson, parseJsonObjectColumn(node.error_json)),
    };
  });

  return {
    runId: run.id,
    name: run.name,
    cwd: run.cwd ?? "",
    status: run.status,
    settledStatus: asString(settledPayload.status) ?? "unknown",
    settledAt: settled.time_created,
    outcome: interpretDwfOutcome(run.status, failure),
    spentTokens: asFiniteInt(run.spent_tokens) ?? 0,
    resumedFrom: run.resumed_from,
    resumedChain: readResumedChain(db, run.resumed_from),
    result,
    gates: extractGates(result),
    worldRuns,
    failure,
    failureRawTail: run.failure_json === null ? null : tail(run.failure_json),
    timeCreated: run.time_created,
    timeUpdated: run.time_updated,
  };
};

// journal 消费不经过任何 retro prompt；版本字段钉住提取器自身口径，与 stop-retro 的 prompt/hook 版本无关
const ATTEMPT_READER_VERSION = "1";

const fmtTokens = (tokens: number): string => tokens.toLocaleString("en-US");

// issue-to-pr 的 result 摘要在 summary；auditor 形状在 conclusion（真库两种都在案），取其一
const resultSummary = (result: Record<string, unknown> | null): string | null =>
  asString(result?.summary) ?? asString(result?.conclusion);

const attemptConclusion = (snapshot: DwfAttemptSnapshot): string => {
  const head = `dwf attempt ${snapshot.runId}${snapshot.name === null ? "" : ` (${snapshot.name})`} ${outcomeLabel(snapshot.outcome)}`;
  if (snapshot.outcome.kind === "completed") {
    const summary = resultSummary(snapshot.result);
    const gates = snapshot.gates.length === 0 ? "" : `; gates ${snapshot.gates.map((g) => `${g.command}=${g.exit}`).join(", ")}`;
    return `${head}; ${summary ?? "no result summary"}${gates}`;
  }
  const failure = snapshot.outcome.kind === "stopped" || snapshot.outcome.kind === "failed" ? snapshot.outcome : null;
  const code = failure && "code" in failure && failure.code !== null ? ` code=${failure.code}` : "";
  const message = failure && "message" in failure && failure.message !== null ? `: ${tail(failure.message, 300)}` : "";
  const superseded =
    snapshot.outcome.kind === "stopped" && snapshot.outcome.supersededBy !== null
      ? `; superseded by ${snapshot.outcome.supersededBy}`
      : "";
  const failedRuns = snapshot.worldRuns.filter((run) => run.failed || (run.exitCode !== null && run.exitCode !== 0));
  const worldLine = failedRuns.length === 0 ? "" : `; failed world.run: ${failedRuns.map((run) => `${run.command}(${run.exitCode ?? "?"})`).join(", ")}`;
  return `${head}${code}${message}${superseded}${worldLine}`;
};

export interface AttemptRetroOptions {
  issueNumber: number;
}

/** 快照 → RetroRecordInput（落库走 RetroStore.recordRetro，身份 = source=attempt + attemptId）。 */
export const buildAttemptRetroInput = (
  snapshot: DwfAttemptSnapshot,
  options: AttemptRetroOptions,
): RetroRecordInput => ({
  source: "attempt",
  sessionId: null,
  attemptId: snapshot.runId,
  issueNumber: options.issueNumber,
  cwd: snapshot.cwd,
  sessionDate: new Date(snapshot.settledAt).toISOString().slice(0, 10),
  generatedAt: snapshot.settledAt,
  promptVersion: "none",
  hookVersion: ATTEMPT_READER_VERSION,
  conclusion: attemptConclusion(snapshot),
  findings: [
    {
      kind: "outcome",
      label: outcomeLabel(snapshot.outcome),
      physicalStatus: snapshot.status,
      settledStatus: snapshot.settledStatus,
    },
    { kind: "gates", gates: snapshot.gates, allPassed: snapshot.gates.every((g) => g.exit === 0) },
    {
      kind: "world-runs",
      runs: snapshot.worldRuns.map((run) => ({ command: run.command, exitCode: run.exitCode, siteId: run.siteId })),
      failed: snapshot.worldRuns.filter((run) => run.failed || (run.exitCode !== null && run.exitCode !== 0)).length,
    },
    { kind: "tokens", spentTokens: snapshot.spentTokens },
    ...(snapshot.resumedChain.length === 0
      ? []
      : [{ kind: "resumed-chain", chain: snapshot.resumedChain.map((link) => `${link.runId}:${link.status}`) }]),
    ...(snapshot.result === null ? [] : [{ kind: "result", result: snapshot.result }]),
  ],
  notCovered: Array.isArray(snapshot.result?.notCovered)
    ? (snapshot.result!.notCovered as unknown[])
    : [],
  // status 描述的是 retro 载荷本身的生成态（原子一次成型 → done）；attempt 的失败体现在
  // conclusion/findings，不把 retro 行打成 failed（那是 stop-retro 重试预算的语义）
  status: "done",
  attempts: 1,
  lastError: null,
});

export interface MaterialCardOptions {
  issueNumber: number;
}

const materialCardLines = (snapshot: DwfAttemptSnapshot, options: MaterialCardOptions): string[] => {
  const lines: string[] = [
    `# attempt 素材卡 ${snapshot.runId}`,
    "",
    `- issue: #${options.issueNumber}`,
    `- workflow: ${snapshot.name ?? "?"}`,
    `- cwd: ${snapshot.cwd || "?"}`,
    `- outcome: ${outcomeLabel(snapshot.outcome)}（物理 status=${snapshot.status}，settled=${snapshot.settledStatus}）`,
    `- settledAt: ${new Date(snapshot.settledAt).toISOString()}`,
    `- spentTokens: ${fmtTokens(snapshot.spentTokens)}`,
  ];
  if (snapshot.resumedChain.length > 0) {
    lines.push(`- resumedFrom: ${snapshot.resumedChain.map((link) => `${link.runId} (${link.status})`).join(" ← ")}`);
  }
  if (snapshot.gates.length > 0) {
    lines.push("", "## 门检（result.gates）", "");
    for (const gate of snapshot.gates) lines.push(`- \`${gate.command}\` → exit ${gate.exit}`);
  }
  if (snapshot.worldRuns.length > 0) {
    lines.push("", "## world.run 清单与输出尾部", "");
    for (const run of snapshot.worldRuns) {
      lines.push(`### \`${run.command}\`（exit ${run.exitCode ?? "?"}${run.failed ? ", node failed" : ""}）`, "");
      if (run.outputTail !== null) lines.push("```text", run.outputTail, "```");
      lines.push("");
    }
  }
  if (snapshot.outcome.kind !== "completed") {
    lines.push("## 失败尾部（failure envelope）", "");
    if (snapshot.failure !== null) {
      lines.push(
        "```json",
        JSON.stringify(snapshot.failure, null, 2),
        "```",
        "",
      );
    } else if (snapshot.failureRawTail !== null) {
      lines.push("```text", snapshot.failureRawTail, "```", "");
    } else {
      lines.push("（无 failure_json）", "");
    }
  }
  if (snapshot.result !== null) {
    const summary = resultSummary(snapshot.result);
    const outcome = asString(snapshot.result.outcome);
    const headSha = asString(snapshot.result.headSha);
    const blockers = snapshot.result.blockers;
    const changedFiles = snapshot.result.changedFiles;
    lines.push("## result 摘要", "");
    if (outcome !== null) lines.push(`- outcome: ${outcome}`);
    if (headSha !== null) lines.push(`- headSha: \`${headSha}\``);
    if (summary !== null) lines.push(`- summary: ${summary}`);
    if (Array.isArray(changedFiles)) {
      lines.push(`- changedFiles (${changedFiles.length}):`);
      for (const file of changedFiles) if (typeof file === "string") lines.push(`  - ${file}`);
    }
    if (Array.isArray(blockers) && blockers.length > 0) {
      lines.push(`- blockers (${blockers.length}):`);
      for (const blocker of blockers) if (typeof blocker === "string") lines.push(`  - ${blocker}`);
    }
    const notCovered = snapshot.result.notCovered;
    if (Array.isArray(notCovered) && notCovered.length > 0) {
      lines.push(`- notCovered (${notCovered.length}):`);
      for (const item of notCovered) if (typeof item === "string") lines.push(`  - ${item}`);
    }
  }
  lines.push("", "---", "由 `taskboard retro attempt` 从 ZCode journal（只读）生成；主会话 retro 先读本卡再总结。");
  return lines;
};

export const renderMaterialCard = (snapshot: DwfAttemptSnapshot, options: MaterialCardOptions): string =>
  `${materialCardLines(snapshot, options).join("\n")}\n`;

/**
 * 素材卡落盘（幂等：整卡重写）。目录自带 .gitignore（`*` + 自身白名单）——.zcode 本体在
 * 多数仓是被跟踪的（含本仓），素材卡不得泄漏进 git status；已存在的 .gitignore 不覆盖。
 */
export const writeMaterialCard = (baseDir: string, runId: string, markdown: string): string => {
  const dir = join(baseDir, ...MATERIAL_DIR_SEGMENTS);
  mkdirSync(dir, { recursive: true });
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf8");
  }
  const cardPath = materialCardPath(baseDir, runId);
  writeFileSync(cardPath, markdown, "utf8");
  return cardPath;
};
