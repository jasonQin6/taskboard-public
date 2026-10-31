#!/usr/bin/env node
/**
 * taskboard CLI：daemon HTTP API 的薄客户端，给人和 agent 共用。唯一例外是 retro record 类
 * 直连主库的短命写进程（ADR-0023：经 store 事务层，WAL + busy_timeout 与 daemon 并发写）。
 * 退出码契约：0 成功、1 语义失败/超时/能力未实现、2 用法错误、3 daemon 不可达。
 * 错误走 stderr 一行人话，无栈回溯；`--json` 输出稳定 JSON（成功带 ok）。
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { pathToFileURL } from "node:url";
import { defaultDbPath, resolveDaemonConfig, startDaemon, DEFAULT_PORT } from "./daemon.js";
import { openStateDb } from "./db.js";
import { parseComboRecordInput, parseRetroRecordInput } from "./retro-input.js";
import {
  buildAttemptRetroInput,
  defaultDwfJournalPath,
  openDwfJournalReadOnly,
  readDwfAttempt,
  renderMaterialCard,
  writeMaterialCard,
  type DwfAttemptSnapshot,
} from "./retro-attempt.js";
import { Store, normalizeComboSkill } from "./store/index.js";
import { API_ROUTES, taskDetailRoute, threadDetailRoute, THREAD_SUBRESOURCE_ROUTES } from "./routes.js";
import type { Settings } from "./types.js";
import { WAIT_DEFAULT_TIMEOUT_S, waitForQuiet, type QuietSnapshot } from "./wait.js";
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_UNREACHABLE = 3;
export const HELP = `taskboard — independent task board daemon (V2: SQLite state, Codex thread observation)

Usage:
  taskboard start [--port N] [--db PATH] [--concurrency N] [--max-subtask-depth N] [--prevent-idle-sleep]
                  [--trusted-proxy-host HOST]... [--proxy-token-env NAME] [--allowed-host HOST]...
  taskboard status [--json] [--url URL]
  taskboard list [--archived] [--json] [--url URL]
  taskboard get <taskId> [--json] [--url URL]
  taskboard create --title T [--prompt P] [--workspace W] [--label L]... [--parent TASKID]
                   [--cron EXPR] [--tz NAME] [--status backlog|todo] [--acceptance human|agent]
                   [--automation off|suggest|auto] [--workspace-mode current|isolated_worktree]
                   [--acceptance-criteria TEXT] [--subtasks-policy cascade] [--idle-threshold-ms N]
                   [--goal] [--goal-budget-tokens N] [--request-id ID] [--json] [--url URL]
  taskboard update <taskId> [--title T] [--prompt P] [--workspace W] [--label L]... [--clear-labels]
                   [--parent TASKID | --clear-parent] [--cron EXPR | --clear-cron] [--tz NAME]
                   [--acceptance human|agent] [--automation off|suggest|auto]
                   [--workspace-mode current|isolated_worktree] [--acceptance-criteria TEXT]
                   [--subtasks-policy cascade | --clear-subtasks-policy] [--idle-threshold-ms N]
                   [--goal | --no-goal] [--goal-budget-tokens N] [--request-id ID] [--json] [--url URL]
  taskboard move <taskId> <backlog|todo|running|done|failed> [--request-id ID] [--json] [--url URL]
  taskboard archive <taskId> [--request-id ID] [--json] [--url URL]
  taskboard unarchive <taskId> [--request-id ID] [--json] [--url URL]
  taskboard delete <taskId> [--request-id ID] [--json] [--url URL]
  taskboard run <taskId> [--request-id ID] [--json] [--url URL]
  taskboard cancel <taskId> [--request-id ID] [--json] [--url URL]
  taskboard goal <set|get|status|pause|resume|clear> <taskId> [--request-id ID] [--json] [--url URL]
  taskboard worktree-clean <taskId> [--request-id ID] [--json] [--url URL]
  taskboard bind-thread <taskId> <threadId> [--role primary|derived_from|evidence_for]
                       [--request-id ID] [--json] [--url URL]
  taskboard unbind-thread <taskId> <threadId> [--role primary|derived_from|evidence_for]
                          [--request-id ID] [--json] [--url URL]
  taskboard ignore-thread <threadId> [--request-id ID] [--json] [--url URL]
  taskboard unignore-thread <threadId> [--request-id ID] [--json] [--url URL]
  taskboard inspect-thread <threadId> [--json] [--url URL]
  taskboard summaries <threadId> [--json] [--url URL]
  taskboard proposals [--json] [--url URL]
  taskboard accept-proposal <proposalId> [--request-id ID] [--json] [--url URL]
  taskboard reject-proposal <proposalId> [--request-id ID] [--json] [--url URL]
  taskboard wait <taskId> [--timeout S] [--json] [--url URL]
  taskboard refresh [--request-id ID] [--json] [--url URL]
  taskboard pause-automation [--request-id ID] [--json] [--url URL]
  taskboard resume-automation [--request-id ID] [--json] [--url URL]
  taskboard db path [--db PATH] [--json]
  taskboard retro record --stdin [--db PATH] [--json]
  taskboard retro attempt --run-id DWFRunId --issue N [--journal PATH] [--material-dir DIR] [--db PATH] [--json]
  taskboard retro combo-record --stdin [--db PATH] [--json]
  taskboard retro combo-get --session SID [--db PATH] [--json]
  taskboard retro combo-list [--limit N] [--db PATH] [--json]
  taskboard retro combo-same-type (--session SID | --form F --skills A,B,C) [--db PATH] [--json]
  taskboard help

Environment:
  TASKBOARD_PORT / TASKBOARD_DB_PATH / TASKBOARD_URL / TASKBOARD_ALLOWED_HOSTS (comma-separated)
  TASKBOARD_ENV_FILE (default: .env in the current directory; existing env wins)

Exit codes: 0 ok, 1 semantic failure or timeout, 2 usage error, 3 daemon unreachable.
Default daemon: http://127.0.0.1:${DEFAULT_PORT}
`;
class UsageError extends Error {}
class UnreachableError extends Error {}
class DaemonError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
interface Globals {
  url: string;
  json: boolean;
}
const defaultUrl = (): string => process.env.TASKBOARD_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;
const requestJson = async <T extends Record<string, unknown>>(
  globals: Globals,
  path: string,
  init?: RequestInit,
): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`${globals.url}${path}`, init);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new UnreachableError(
      `cannot reach taskboard daemon at ${globals.url} (is it running? \`taskboard start\`): ${cause}`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || payload.ok !== true) {
    throw new DaemonError(response.status, String(payload.error ?? `request failed (${response.status})`));
  }
  return payload as T;
};
const postAction = <T extends Record<string, unknown>>(
  globals: Globals,
  requestId: string | undefined,
  action: Record<string, unknown>,
): Promise<T> =>
  requestJson<T>(globals, API_ROUTES.actions, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: requestId ?? `cli-${randomUUID()}`, ...action }),
  });
const out = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};
const emitJson = (value: unknown): void => out(JSON.stringify(value));
const positiveInt = (value: string | undefined, label: string, allowZero = false): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || (parsed === 0 && !allowZero)) {
    throw new UsageError(`--${label} must be a positive integer${allowZero ? " (or 0)" : ""}, got: ${value}`);
  }
  return parsed;
};
interface ArgValues {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}
const parseOrUsage = (config: ParseArgsConfig): ArgValues => {
  try {
    const parsed = parseArgs({ ...config, strict: true });
    return parsed as ArgValues;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
};
const str = (value: string | boolean | string[] | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;
const strList = (value: string | boolean | string[] | undefined): string[] =>
  Array.isArray(value) ? value : [];

/** parseArgs option 声明的最窄形状（type 收窄为字面联合，可直接作 ParseArgsConfig.options）。 */
interface FlagSpec {
  type: "string" | "boolean";
  multiple?: boolean;
}

/** --request-id 的唯一 option 声明（issue #35：此前 4 处重复，收敛单处共享）。 */
const REQUEST_ID_OPTIONS: Record<string, FlagSpec> = { "request-id": { type: "string" } };

// 各子命令专属 option 面（task 字段类见 TASK_FIELD_TABLE）；声明处即 HELP flag 对齐测试的命令侧真值。

const START_OPTIONS: Record<string, FlagSpec> = {
  port: { type: "string" },
  db: { type: "string" },
  concurrency: { type: "string" },
  "max-subtask-depth": { type: "string" },
  "prevent-idle-sleep": { type: "boolean" },
  "trusted-proxy-host": { type: "string", multiple: true },
  "proxy-token-env": { type: "string" },
  "allowed-host": { type: "string", multiple: true },
};
const LIST_OPTIONS: Record<string, FlagSpec> = { archived: { type: "boolean" } };
const CREATE_ONLY_OPTIONS: Record<string, FlagSpec> = { status: { type: "string" } };
/**
 * update 专属的置空/反义展开单表：载荷字段与写入值在条目里同源声明，option 面与
 * runUpdate 展开都从本表派生——新增置空生命周期只加一行，漏一侧 HELP 对齐测试或直测即红
 * （此前的手工 if 链漏写是行为静默丢失）。条目顺序 = 载荷写入顺序（JSON 键序稳定）。
 */
interface UpdateClearEntry {
  readonly flag: string;
  readonly field: string;
  readonly value: unknown;
}
const UPDATE_CLEAR_TABLE: readonly UpdateClearEntry[] = [
  { flag: "clear-labels", field: "labels", value: [] },
  { flag: "clear-parent", field: "parentId", value: null },
  { flag: "clear-cron", field: "cron", value: null },
  { flag: "clear-subtasks-policy", field: "subtasksPolicy", value: null },
  { flag: "no-goal", field: "goalEnabled", value: false },
];
const UPDATE_ONLY_OPTIONS: Record<string, FlagSpec> = Object.fromEntries(
  UPDATE_CLEAR_TABLE.map((entry) => [entry.flag, { type: "boolean" } as const]),
);
const BIND_THREAD_OPTIONS: Record<string, FlagSpec> = { role: { type: "string" }, ...REQUEST_ID_OPTIONS };
const WAIT_OPTIONS: Record<string, FlagSpec> = { timeout: { type: "string" } };
const DB_OPTIONS: Record<string, FlagSpec> = { db: { type: "string" } };

// ---- start ----

const runStart = async (argv: string[]): Promise<number> => {
  const parsed = parseOrUsage({
    args: argv,
    allowPositionals: false,
    options: START_OPTIONS,
  });
  const overrides: Partial<Settings> = {};
  const concurrency = positiveInt(str(parsed.values.concurrency), "concurrency");
  if (concurrency !== undefined) overrides.concurrencyLimit = concurrency;
  const depth = positiveInt(str(parsed.values["max-subtask-depth"]), "max-subtask-depth");
  if (depth !== undefined) overrides.maxSubtaskDepth = depth;
  const trustedProxyHosts = strList(parsed.values["trusted-proxy-host"]);
  if (trustedProxyHosts.length > 0) {
    overrides.trustedProxyHosts = trustedProxyHosts.flatMap((entry) =>
      entry.split(",").map((part) => part.trim()).filter((part) => part.length > 0),
    );
  }
  const proxyTokenEnv = str(parsed.values["proxy-token-env"]);
  if (proxyTokenEnv !== undefined) overrides.proxyTokenEnv = proxyTokenEnv;
  const config = resolveDaemonConfig({
    ...(str(parsed.values.port) !== undefined ? { port: positiveInt(str(parsed.values.port), "port", true) } : {}),
    ...(str(parsed.values.db) !== undefined ? { dbPath: str(parsed.values.db) } : {}),
    ...(strList(parsed.values["allowed-host"]).length > 0
      ? { allowedHosts: strList(parsed.values["allowed-host"]).map((host) => host.trim().toLowerCase()) }
      : {}),
    settingsOverrides: overrides,
  });
  const daemon = await startDaemon(config);
  const shutdown = (): void => {
    void daemon
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return EXIT_OK; // server 句柄保活；信号路径负责退出
};

// ---- 读命令 ----

interface StateResponse extends Record<string, unknown> {
  ok: true;
  revisions: Record<string, number>;
  tasks: Array<Record<string, unknown> & { id: string; title: string; status: string; archived: boolean }>;
  inbox: unknown[];
  sessions: unknown[];
  failures: unknown[];
  proposals: unknown[];
  runtime: Record<string, unknown> & { pid: number; activeRuns: number; automationPaused: boolean; powerProtection: string };
}
const runStatus = async (globals: Globals): Promise<number> => {
  const state = await requestJson<StateResponse>(globals, API_ROUTES.state);
  const summary = {
    ok: true as const,
    url: globals.url,
    pid: state.runtime.pid,
    revisions: state.revisions,
    tasks: state.tasks.length,
    inbox: state.inbox.length,
    sessions: state.sessions.length,
    failures: state.failures.length,
    proposals: state.proposals.length,
    runtime: state.runtime,
  };
  if (globals.json) {
    emitJson(summary);
    return EXIT_OK;
  }
  out(`daemon ${globals.url} pid=${state.runtime.pid}`);
  out(
    `tasks=${state.tasks.length} inbox=${state.inbox.length} sessions=${state.sessions.length} ` +
      `failures=${state.failures.length} proposals=${state.proposals.length} activeRuns=${state.runtime.activeRuns}`,
  );
  out(`automationPaused=${state.runtime.automationPaused} powerProtection=${state.runtime.powerProtection}`);
  out(`revisions tasks=${state.revisions.tasks} threads=${state.revisions.threads} config=${state.revisions.config}`);
  return EXIT_OK;
};
const runList = async (globals: Globals, argv: string[]): Promise<number> => {
  const parsed = parseOrUsage({ args: argv, allowPositionals: false, options: LIST_OPTIONS });
  const state = await requestJson<StateResponse>(globals, API_ROUTES.state);
  const tasks = parsed.values.archived === true ? state.tasks : state.tasks.filter((task) => !task.archived);
  if (globals.json) {
    emitJson({ ok: true, revision: state.revisions.tasks, tasks });
    return EXIT_OK;
  }
  if (tasks.length === 0) {
    out("(no tasks)");
    return EXIT_OK;
  }
  for (const task of tasks) {
    out(`${task.id}\t${task.status}${task.archived ? "\t[archived]" : ""}\t${task.title}`);
  }
  return EXIT_OK;
};
const requireId = (value: string | undefined, label: string): string => {
  if (value === undefined || value.trim().length === 0) throw new UsageError(`${label} is required`);
  return value;
};
const runGet = async (globals: Globals, argv: string[]): Promise<number> => {
  const taskId = requireId(argv[0], "taskId");
  const payload = await requestJson<{ ok: true; task: Record<string, unknown> }>(
    globals,
    taskDetailRoute.path({ taskId }),
  );
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  const task = payload.task;
  out(`${task.id as string}\t${task.status as string}${task.archived ? "\t[archived]" : ""}\t${task.title as string}`);
  out(`workspace=${String(task.workspace ?? "-")} labels=${JSON.stringify(task.labels)} parent=${String(task.parentId ?? "-")}`);
  const schedule = task.schedule as { cron: string; tz: string | null; nextRunAt: string | null } | null;
  out(`schedule=${schedule === null ? "-" : `${schedule.cron}${schedule.tz !== null ? ` (${schedule.tz})` : ""} next=${schedule.nextRunAt ?? "-"}`}`);
  out(`runs=${(task.runs as unknown[]).length} threads=${(task.threads as unknown[]).length} children=${(task.children as unknown[]).length}`);
  return EXIT_OK;
};

// ---- 写命令 ----

/**
 * task 字段 flag 元数据单表（issue #35）：parseArgs options 与 collectTaskFields 拼装同源。
 * 四类异质由 { type, field, multiple?, transform? } 覆盖：
 * - 直通 ×11：同名 5（title/prompt/workspace/cron/tz）+ 改名 6（parent→parentId、
 *   acceptance→acceptanceMode、automation→automationMode、workspace-mode→workspaceMode、
 *   subtasks-policy→subtasksPolicy、acceptance-criteria→acceptanceCriteria），field 即载荷字段名；
 * - 数组 ×1：label→labels（multiple，parseArgs 聚合后整体直通）；
 * - positiveInt 数值转换 ×2：idle-threshold-ms→idleThresholdMs、goal-budget-tokens→goalBudgetTokens（transform）；
 * - 布尔 ×1：goal→goalEnabled（update 侧反义 no-goal 与 clear-* 在 UPDATE_CLEAR_TABLE）。
 * 条目顺序 = 载荷字段写入顺序（与单表化前一致，JSON 键序稳定）；HELP flag 对齐测试以本表为真值一半。
 */
interface TaskFieldEntry {
  readonly flag: string;
  readonly type: "string" | "boolean";
  /** 动作载荷字段名（flag→field 改名映射的唯一声明处）。 */
  readonly field: string;
  readonly multiple?: boolean;
  /** 字符串值的转换器（如 positiveInt）；缺省直通。 */
  readonly transform?: (value: string, flag: string) => unknown;
}
export const TASK_FIELD_TABLE: readonly TaskFieldEntry[] = [
  { flag: "title", type: "string", field: "title" },
  { flag: "prompt", type: "string", field: "prompt" },
  { flag: "workspace", type: "string", field: "workspace" },
  { flag: "parent", type: "string", field: "parentId" },
  { flag: "cron", type: "string", field: "cron" },
  { flag: "tz", type: "string", field: "tz" },
  { flag: "acceptance", type: "string", field: "acceptanceMode" },
  { flag: "automation", type: "string", field: "automationMode" },
  { flag: "workspace-mode", type: "string", field: "workspaceMode" },
  { flag: "acceptance-criteria", type: "string", field: "acceptanceCriteria" },
  { flag: "subtasks-policy", type: "string", field: "subtasksPolicy" },
  { flag: "label", type: "string", field: "labels", multiple: true },
  { flag: "idle-threshold-ms", type: "string", field: "idleThresholdMs", transform: positiveInt },
  { flag: "goal", type: "boolean", field: "goalEnabled" },
  { flag: "goal-budget-tokens", type: "string", field: "goalBudgetTokens", transform: positiveInt },
];

/** create/update 共享的 parseArgs options：单表投影（multiple 透传）。 */
const TASK_FIELD_OPTIONS: Record<string, FlagSpec> = Object.fromEntries(
  TASK_FIELD_TABLE.map((entry) => [
    entry.flag,
    entry.multiple === true ? { type: entry.type, multiple: true } : { type: entry.type },
  ]),
);
const collectTaskFields = (values: ArgValues["values"]): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  for (const entry of TASK_FIELD_TABLE) {
    if (entry.type === "boolean") {
      if (values[entry.flag] === true) fields[entry.field] = true;
      continue;
    }
    if (entry.multiple === true) {
      if (Array.isArray(values[entry.flag])) fields[entry.field] = values[entry.flag];
      continue;
    }
    const raw = str(values[entry.flag]);
    if (raw === undefined) continue;
    fields[entry.field] = entry.transform === undefined ? raw : entry.transform(raw, entry.flag);
  }
  return fields;
};
type TaskResponse = { ok: true; task: Record<string, unknown> };
const printTaskLine = (globals: Globals, payload: TaskResponse, verb: string): number => {
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  const task = payload.task;
  out(`${verb} ${task.id as string} (${task.status as string}${task.archived ? ", archived" : ""}): ${task.title as string}`);
  return EXIT_OK;
};
/** create 的完整 option 面：共享 task 字段 ∪ create 专属 ∪ --request-id（幂等键 caller 透传，丢它就是严格解析 exit 2 的回归）。 */
const CREATE_OPTIONS: Record<string, FlagSpec> = {
  ...TASK_FIELD_OPTIONS,
  ...CREATE_ONLY_OPTIONS,
  ...REQUEST_ID_OPTIONS,
};
/** update 的完整 option 面：共享 task 字段 ∪ update 专属 ∪ --request-id。 */
const UPDATE_OPTIONS: Record<string, FlagSpec> = {
  ...TASK_FIELD_OPTIONS,
  ...UPDATE_ONLY_OPTIONS,
  ...REQUEST_ID_OPTIONS,
};
const runCreate = async (globals: Globals, argv: string[]): Promise<number> => {
  const parsed = parseOrUsage({
    args: argv,
    allowPositionals: false,
    options: CREATE_OPTIONS,
  });
  if (parsed.values.title === undefined) throw new UsageError("--title is required");
  const fields = collectTaskFields(parsed.values);
  const status = str(parsed.values.status);
  if (status !== undefined) fields.status = status;
  const payload = await postAction<TaskResponse>(globals, str(parsed.values["request-id"]), { type: "task.create", ...fields });
  return printTaskLine(globals, payload, "created");
};
const runUpdate = async (globals: Globals, argv: string[]): Promise<number> => {
  const taskId = requireId(argv[0], "taskId");
  const parsed = parseOrUsage({
    args: argv.slice(1),
    allowPositionals: false,
    options: UPDATE_OPTIONS,
  });
  const fields = collectTaskFields(parsed.values);
  for (const entry of UPDATE_CLEAR_TABLE) {
    if (parsed.values[entry.flag] === true) fields[entry.field] = entry.value;
  }
  if (Object.keys(fields).length === 0) throw new UsageError("update needs at least one field to change");
  const payload = await postAction<TaskResponse>(globals, str(parsed.values["request-id"]), { type: "task.update", taskId, ...fields });
  return printTaskLine(globals, payload, "updated");
};
const parseRequestId = (argv: string[]): { rest: string[]; requestId: string | undefined } => {
  const parsed = parseOrUsage({ args: argv, allowPositionals: true, options: REQUEST_ID_OPTIONS });
  return { rest: parsed.positionals, requestId: str(parsed.values["request-id"]) };
};
const runMove = async (globals: Globals, argv: string[]): Promise<number> => {
  const { rest, requestId } = parseRequestId(argv);
  const taskId = requireId(rest[0], "taskId");
  const status = rest[1];
  if (status === undefined) throw new UsageError("move needs <taskId> <backlog|todo|running|done|failed>");
  const payload = await postAction<TaskResponse>(globals, requestId, { type: "task.move", taskId, status });
  return printTaskLine(globals, payload, "moved");
};
const runSimpleTaskAction = async (
  globals: Globals,
  argv: string[],
  type: "task.archive" | "task.unarchive",
  verb: string,
): Promise<number> => {
  const { rest, requestId } = parseRequestId(argv);
  const taskId = requireId(rest[0], "taskId");
  const payload = await postAction<TaskResponse>(globals, requestId, { type, taskId });
  return printTaskLine(globals, payload, verb);
};

// ---- run 生命周期 ----

interface RunResponse extends Record<string, unknown> {
  ok: true;
  run: { id: string; taskId: string; status: string; trigger: string };
}
/** run/cancel 共用：动作转 Run，人话行给 run id 与当前状态（queued/running 属正常起跑）。 */
const runRunCommand = async (
  globals: Globals,
  argv: string[],
  type: "run.create" | "run.cancel",
  verb: string,
): Promise<number> => {
  const { rest, requestId } = parseRequestId(argv);
  const taskId = requireId(rest[0], "taskId");
  const payload = await postAction<RunResponse>(globals, requestId, { type, taskId });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  out(`${verb} ${payload.run.id} (task ${payload.run.taskId}, ${payload.run.status})`);
  return EXIT_OK;
};
interface WorktreeCleanResponse extends Record<string, unknown> {
  ok: true;
  cleaned: boolean;
  worktree: { branch: string; path: string; status: string } | null;
}
/** isolated worktree 的显式清理（验收后；幂等重放报 nothing to clean）。 */
const runWorktreeClean = async (globals: Globals, argv: string[]): Promise<number> => {
  const { rest, requestId } = parseRequestId(argv);
  const taskId = requireId(rest[0], "taskId");
  const payload = await postAction<WorktreeCleanResponse>(globals, requestId, {
    type: "worktree.clean",
    taskId,
  });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  if (!payload.cleaned) {
    out(`nothing to clean (task ${taskId})`);
    return EXIT_OK;
  }
  out(
    payload.worktree !== null
      ? `cleaned worktree (task ${taskId}, branch ${payload.worktree.branch} removed)`
      : `cleaned worktree (task ${taskId})`,
  );
  return EXIT_OK;
};

// ---- native goal ----

interface GoalResponse extends Record<string, unknown> {
  ok: true;
  goal: { taskId: string; threadId: string; op: string; goalStatus: string | null; text: string | null };
}
const GOAL_SUBCOMMANDS = ["set", "get", "status", "pause", "resume", "clear"] as const;
/** goal 子命令转正（issue #8）：映射到 goal.* 动作，全部是 Action Execution。 */
const runGoal = async (globals: Globals, argv: string[]): Promise<number> => {
  const parsed = parseOrUsage({
    args: argv,
    allowPositionals: true,
    options: REQUEST_ID_OPTIONS,
  });
  const [op, taskId] = parsed.positionals;
  if (op === undefined || !(GOAL_SUBCOMMANDS as readonly string[]).includes(op) || taskId === undefined) {
    throw new UsageError(`usage: taskboard goal <${GOAL_SUBCOMMANDS.join("|")}> <taskId> [--request-id ID]`);
  }
  const payload = await postAction<GoalResponse>(globals, str(parsed.values["request-id"]), {
    type: `goal.${op}`,
    taskId,
  });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  const goal = payload.goal;
  out(
    `goal ${goal.op} ${goal.taskId} (thread ${goal.threadId}, status ${goal.goalStatus ?? "none"})`,
  );
  return EXIT_OK;
};
const runDelete = async (globals: Globals, argv: string[]): Promise<number> => {
  const { rest, requestId } = parseRequestId(argv);
  const taskId = requireId(rest[0], "taskId");
  const payload = await postAction<{
    ok: true;
    deleted: { id: string; danglingChildren: string[]; unboundThreads: string[] };
  }>(globals, requestId, { type: "task.delete", taskId });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  out(`deleted ${payload.deleted.id}`);
  if (payload.deleted.danglingChildren.length > 0) {
    out(`dangling children kept: ${payload.deleted.danglingChildren.join(", ")}`);
  }
  if (payload.deleted.unboundThreads.length > 0) {
    out(`threads returned to inbox: ${payload.deleted.unboundThreads.join(", ")}`);
  }
  return EXIT_OK;
};

// ---- thread 绑定与观察 ----

interface ThreadBindingResponse extends Record<string, unknown> {
  ok: true;
  binding?: { taskId: string; threadId: string; role: string; boundAt: string };
  thread: { id: string; nativeStatus: string; primaryTaskId: string | null; ignored: boolean };
}
const THREAD_ROLE_USAGE = "[--role primary|derived_from|evidence_for]";
const runBindThread = async (globals: Globals, argv: string[], bind: boolean): Promise<number> => {
  const parsed = parseOrUsage({
    args: argv,
    allowPositionals: true,
    options: BIND_THREAD_OPTIONS,
  });
  const [taskId, threadId] = parsed.positionals;
  if (taskId === undefined || threadId === undefined) {
    throw new UsageError(`usage: taskboard ${bind ? "bind" : "unbind"}-thread <taskId> <threadId> ${THREAD_ROLE_USAGE}`);
  }
  const role = str(parsed.values.role);
  const payload = await postAction<ThreadBindingResponse>(globals, str(parsed.values["request-id"]), {
    type: bind ? "thread.bind" : "thread.unbind",
    taskId,
    threadId,
    ...(role !== undefined ? { role } : {}),
  });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  if (bind && payload.binding !== undefined) {
    out(`bound ${threadId} → ${taskId} (${payload.binding.role})`);
  } else {
    out(`unbound ${threadId} from ${taskId}`);
  }
  return EXIT_OK;
};
const runIgnoreThread = async (globals: Globals, argv: string[], ignore: boolean): Promise<number> => {
  const { rest, requestId } = parseRequestId(argv);
  const threadId = requireId(rest[0], "threadId");
  const payload = await postAction<ThreadBindingResponse>(globals, requestId, {
    type: ignore ? "thread.ignore" : "thread.unignore",
    threadId,
  });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  out(`${ignore ? "ignored" : "unignored"} ${threadId}`);
  return EXIT_OK;
};
/** 详情读命令：与 `get` 同构，JSON 即详情载荷原文（U2 的冻结消费面）。 */
const runInspectThread = async (globals: Globals, argv: string[]): Promise<number> => {
  const threadId = requireId(argv[0], "threadId");
  const payload = await requestJson<{ ok: true; thread: Record<string, unknown> }>(
    globals,
    threadDetailRoute.path({ threadId }),
  );
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  const thread = payload.thread;
  out(
    `${thread.id as string}\t${thread.nativeStatus as string}\tprimary=${String(thread.primaryTaskId ?? "-")}${
      thread.ignored ? "\t[ignored]" : ""
    }`,
  );
  const title = thread.title as string | null;
  out(`title=${title ?? "-"}`);
  out(`lastActivity=${String(thread.lastActivityAt ?? "-")} firstSeen=${String(thread.firstSeenAt ?? "-")}`);
  out(`turns=${String(thread.turnCount ?? 0)} evidence=${String(thread.evidenceCount ?? 0)} semanticStatus=${String(thread.semanticStatus ?? "null")}`);
  const bindings = (thread.bindings ?? []) as Array<{ taskId: string; role: string }>;
  out(`bindings=${bindings.map((binding) => `${binding.taskId}(${binding.role})`).join(",") || "-"}`);
  const lineage = thread.lineage as { parents: unknown[]; children: unknown[] } | undefined;
  if (lineage !== undefined) {
    out(`lineage parents=${lineage.parents.length} children=${lineage.children.length}`);
  }
  const summary = thread.summary as { provenance: string; text: string } | null;
  out(`summary=${summary === null || summary === undefined ? "-" : `${summary.provenance}: ${summary.text.split("\n")[0]}`}`);
  out(`turns feed: ${globals.url}${THREAD_SUBRESOURCE_ROUTES.turns.path({ threadId })}`);
  return EXIT_OK;
};
const runAutomation = async (globals: Globals, argv: string[], pause: boolean): Promise<number> => {
  const { requestId } = parseRequestId(argv);
  const payload = await postAction<{ ok: true; automationPaused: boolean }>(globals, requestId, {
    type: pause ? "automation.pause" : "automation.resume",
  });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  out(`automation ${payload.automationPaused ? "paused" : "resumed"}`);
  return EXIT_OK;
};

// ---- 摘要 / 提案（S1/S2 读面与裁决写面） ----

interface ProposalResponse extends Record<string, unknown> {
  ok: true;
  proposal: { id: string; status: string; taskId: string | null; threadId: string | null };
}
/** accept/reject 共用：动作转 proposal.accept/reject，人话行给提案 id 与裁决终态。 */
const runDecideProposal = async (globals: Globals, argv: string[], accept: boolean): Promise<number> => {
  const { rest, requestId } = parseRequestId(argv);
  const proposalId = requireId(rest[0], "proposalId");
  const payload = await postAction<ProposalResponse>(globals, requestId, {
    type: accept ? "proposal.accept" : "proposal.reject",
    proposalId,
  });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  out(`${accept ? "accepted" : "rejected"} ${payload.proposal.id} (${payload.proposal.status})`);
  return EXIT_OK;
};
interface ProposalsResponse extends Record<string, unknown> {
  ok: true;
  proposals: Array<{
    id: string;
    status: string;
    threadId: string | null;
    taskId: string | null;
    evidenceFingerprint: string;
    payload: { answer?: { recommended?: string; summaryShort?: string }; error?: { kind: string } };
    createdAt: string;
  }>;
}
const runProposals = async (globals: Globals): Promise<number> => {
  const payload = await requestJson<ProposalsResponse>(globals, API_ROUTES.proposals);
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  if (payload.proposals.length === 0) {
    out("(no proposals)");
    return EXIT_OK;
  }
  for (const proposal of payload.proposals) {
    const what = proposal.payload.answer?.recommended ?? proposal.payload.error?.kind ?? "?";
    out(`${proposal.id}\t${proposal.status}\t${what}\t${proposal.threadId ?? "-"}\t${proposal.taskId ?? "-"}`);
  }
  return EXIT_OK;
};
interface SummariesResponse extends Record<string, unknown> {
  ok: true;
  items: Array<{ id: string; threadId: string; provenance: string; text: string; createdAt: string }>;
}
const runSummaries = async (globals: Globals, argv: string[]): Promise<number> => {
  const threadId = requireId(argv[0], "threadId");
  const payload = await requestJson<SummariesResponse>(
    globals,
    THREAD_SUBRESOURCE_ROUTES.summaries.path({ threadId }),
  );
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  if (payload.items.length === 0) {
    out("(no summaries)");
    return EXIT_OK;
  }
  for (const summary of payload.items) {
    out(`${summary.id}\t${summary.provenance}\t${summary.text.split("\n")[0]}`);
  }
  return EXIT_OK;
};

// ---- refresh ----

interface ScanProgress {
  phase: string;
  filesTotal: number;
  filesDone: number;
  lastCompletedAt: string | null;
}
const runRefresh = async (globals: Globals, argv: string[]): Promise<number> => {
  const { requestId } = parseRequestId(argv);
  const payload = await postAction<{ ok: true; scan: ScanProgress }>(globals, requestId, {
    type: "scan.refresh",
  });
  if (globals.json) {
    emitJson(payload);
    return EXIT_OK;
  }
  const scan = payload.scan;
  out(
    `scan ${scan.phase} (${scan.filesDone}/${scan.filesTotal} files, last ${scan.lastCompletedAt ?? "-"})`,
  );
  return EXIT_OK;
};

// ---- wait ----

interface TaskDetailResponse extends Record<string, unknown> {
  ok: true;
  task: Record<string, unknown> & {
    id: string;
    status: string;
    activeRun: QuietSnapshot["activeRun"];
    lastRun: QuietSnapshot["lastRun"];
    primaryThreadStatus: QuietSnapshot["primaryThreadStatus"];
    inFlightWrite: boolean;
  };
}
const runWait = async (globals: Globals, argv: string[]): Promise<number> => {
  const parsed = parseOrUsage({ args: argv, allowPositionals: true, options: WAIT_OPTIONS });
  const taskId = requireId(parsed.positionals[0], "taskId");
  const timeoutS = positiveInt(str(parsed.values.timeout), "timeout") ?? WAIT_DEFAULT_TIMEOUT_S;
  const fetchSnapshot = async (): Promise<QuietSnapshot> => {
    const payload = await requestJson<TaskDetailResponse>(globals, taskDetailRoute.path({ taskId }));
    return {
      taskId: payload.task.id,
      status: payload.task.status,
      activeRun: payload.task.activeRun,
      lastRun: payload.task.lastRun,
      primaryThreadStatus: payload.task.primaryThreadStatus,
      inFlightWrite: payload.task.inFlightWrite,
    };
  };
  const outcome = await waitForQuiet({ fetchSnapshot }, { timeoutMs: timeoutS * 1000 });
  if (outcome.kind === "timeout") {
    if (globals.json) {
      emitJson({ ok: false, error: "timeout", timeoutSeconds: timeoutS, task: outcome.snapshot });
    }
    process.stderr.write(
      `Error: task ${taskId} is still active after ${timeoutS}s (run ${outcome.snapshot.activeRun?.id ?? "-"}, thread ${outcome.snapshot.primaryThreadStatus ?? "-"}); try again or raise --timeout\n`,
    );
    return EXIT_FAILURE;
  }
  const result = {
    ok: true as const,
    quiet: true as const,
    taskId,
    status: outcome.snapshot.status,
    lastRun: outcome.snapshot.lastRun,
  };
  if (globals.json) {
    emitJson(result);
    return EXIT_OK;
  }
  out(`task ${taskId} is quiet (status=${result.status}, lastRun=${result.lastRun?.status ?? "none"})`);
  return EXIT_OK;
};

// ---- db ----

const runDb = (globals: Globals, argv: string[]): number => {
  const parsed = parseOrUsage({ args: argv, allowPositionals: true, options: DB_OPTIONS });
  if (parsed.positionals[0] !== "path") throw new UsageError("usage: taskboard db path [--db PATH]");
  const dbFlag = str(parsed.values.db);
  const path = resolveDaemonConfig(dbFlag !== undefined ? { dbPath: dbFlag } : {}).dbPath;
  if (globals.json) {
    emitJson({ ok: true, path, default: defaultDbPath() });
    return EXIT_OK;
  }
  out(path);
  return EXIT_OK;
};

// ---- retro 账本（直连主库的短命写进程，ADR-0023；不经 daemon）----

const RETRO_OPTIONS: Record<string, FlagSpec> = {
  stdin: { type: "boolean" },
  db: { type: "string" },
  session: { type: "string" },
  form: { type: "string" },
  skills: { type: "string" },
  limit: { type: "string" },
  "run-id": { type: "string" },
  issue: { type: "string" },
  journal: { type: "string" },
  "material-dir": { type: "string" },
};
const RETRO_USAGE =
  "usage: taskboard retro <record|combo-record> --stdin [--db PATH] [--json]\n" +
  "       taskboard retro attempt --run-id DWFRunId --issue N [--journal PATH] [--material-dir DIR] [--db PATH] [--json]\n" +
  "       taskboard retro combo-get --session SID [--db PATH] [--json]\n" +
  "       taskboard retro combo-list [--limit N] [--db PATH] [--json]\n" +
  "       taskboard retro combo-same-type (--session SID | --form F --skills A,B,C) [--db PATH] [--json]";

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const parsePayloadText = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const parsePositiveIntFlag = (raw: string, flag: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${flag} must be a positive integer`);
  return value;
};

/**
 * retro 子命令：record / combo-record 是直连主库的短命写进程（hook 调用时 daemon 可能不在
 * 运行，所以打开主库直写含迁移，靠 WAL + busy_timeout 与 daemon 并发共存；语义失败（坏
 * JSON / 校验不过）是数据问题不是用法问题，走 exit 1）；attempt 是 record 的 journal 消费
 * 变体——只读 ZCode dwf 表（mode=ro）提炼已结算 run 的载荷与素材卡（#69），幂等面同
 * record（attempt 身份键）；combo-get / combo-list / combo-same-type 是同库只读查询面，
 * 同型判据（归一化 skills 集合 + form 缺省 form_hint）的唯一实现在 store 层，消费方不得自算。
 */
const runRetro = async (globals: Globals, argv: string[]): Promise<number> => {
  const [sub, ...rest] = argv;
  const stdinSubs = new Set(["record", "combo-record"]);
  const writeSubs = new Set([...stdinSubs, "attempt"]);
  const readSubs = new Set(["combo-get", "combo-list", "combo-same-type"]);
  if (sub === undefined || (!writeSubs.has(sub) && !readSubs.has(sub))) {
    throw new UsageError(RETRO_USAGE);
  }
  const parsed = parseOrUsage({ args: rest, allowPositionals: false, options: RETRO_OPTIONS });
  if (stdinSubs.has(sub) && parsed.values.stdin !== true) {
    throw new UsageError(`${RETRO_USAGE} (--stdin is required for ${sub})`);
  }
  const dbFlag = str(parsed.values.db);
  const dbPath = resolveDaemonConfig(dbFlag !== undefined ? { dbPath: dbFlag } : {}).dbPath;
  const { db } = await openStateDb(dbPath);
  try {
    const store = new Store(db);
    if (sub === "attempt") {
      // journal 消费只读（mode=ro + busy_timeout，见 run-settled 才读）；快照失败（未结算/未知
      // run/库缺失）是数据问题 → exit 1，且不落任何行。素材卡默认写 run.cwd 的 .zcode/retro/
      const runId = str(parsed.values["run-id"]);
      if (runId === undefined) throw new UsageError(`${RETRO_USAGE} (attempt requires --run-id)`);
      const issueFlag = str(parsed.values.issue);
      if (issueFlag === undefined) throw new UsageError(`${RETRO_USAGE} (attempt requires --issue)`);
      const issueNumber = parsePositiveIntFlag(issueFlag, "--issue");
      const journalPath = str(parsed.values.journal) ?? defaultDwfJournalPath();
      const journal = openDwfJournalReadOnly(journalPath);
      let snapshot: DwfAttemptSnapshot;
      try {
        snapshot = readDwfAttempt(journal, runId);
      } finally {
        journal.close();
      }
      const retro = store.recordRetro(buildAttemptRetroInput(snapshot, { issueNumber }));
      const materialDir = str(parsed.values["material-dir"]);
      const materialCard = writeMaterialCard(
        materialDir ?? snapshot.cwd,
        runId,
        renderMaterialCard(snapshot, { issueNumber }),
      );
      if (globals.json) emitJson({ ok: true, retro, materialCard });
      else out(`recorded attempt retro ${retro.id} → ${materialCard}`);
      return EXIT_OK;
    }
    if (sub === "record") {
      const payload = parsePayloadText(await readStdin());
      const retro = store.recordRetro(parseRetroRecordInput(payload));
      if (globals.json) emitJson({ ok: true, retro });
      else out(`recorded retro ${retro.id} (${retro.source}, ${retro.status})`);
      return EXIT_OK;
    }
    if (sub === "combo-record") {
      const payload = parsePayloadText(await readStdin());
      const combo = store.recordCombo(parseComboRecordInput(payload));
      if (globals.json) emitJson({ ok: true, combo });
      else out(`recorded combo ${combo.sessionId} (${combo.source}, ${combo.task.slice(0, 40)})`);
      return EXIT_OK;
    }
    if (sub === "combo-get") {
      const sessionId = str(parsed.values.session);
      if (sessionId === undefined) throw new UsageError(`${RETRO_USAGE} (combo-get requires --session)`);
      const combo = store.getCombo(sessionId);
      if (combo === null) {
        process.stderr.write(`Error: no combo row for session ${sessionId}\n`);
        return EXIT_FAILURE;
      }
      if (globals.json) emitJson({ ok: true, combo });
      else out(`${combo.sessionId}\t${combo.lastSeen}\t${combo.form ?? combo.formHint ?? "?"}\t${String(combo.outcome.label ?? "?")}\t${combo.task.slice(0, 60)}`);
      return EXIT_OK;
    }
    if (sub === "combo-list") {
      const limitFlag = str(parsed.values.limit);
      const limit = limitFlag === undefined ? undefined : parsePositiveIntFlag(limitFlag, "--limit");
      const combos = store.listCombos(limit);
      if (globals.json) emitJson({ ok: true, combos });
      else for (const c of combos) out(`${c.sessionId}\t${c.lastSeen}\t${c.form ?? c.formHint ?? "?"}\t${String(c.outcome.label ?? "?")}\t${c.task.slice(0, 60)}`);
      return EXIT_OK;
    }
    // combo-same-type：--session 以该行自身为查询键；--form + --skills 显式给键；两者互斥
    const sessionFlag = str(parsed.values.session);
    const formFlag = str(parsed.values.form);
    const skillsFlag = str(parsed.values.skills);
    if (sessionFlag !== undefined && formFlag !== undefined) {
      throw new UsageError(`${RETRO_USAGE} (--session and --form are mutually exclusive)`);
    }
    let query: { form: string; skills: string[] };
    if (sessionFlag !== undefined) {
      const row = store.getCombo(sessionFlag);
      if (row === null) {
        process.stderr.write(`Error: no combo row for session ${sessionFlag}\n`);
        return EXIT_FAILURE;
      }
      query = { form: row.form ?? row.formHint ?? "", skills: row.skills };
    } else if (formFlag !== undefined && skillsFlag !== undefined) {
      query = {
        form: formFlag,
        skills: skillsFlag.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
      };
    } else {
      throw new UsageError(`${RETRO_USAGE} (requires --session, or --form with --skills)`);
    }
    const matches = store.findSameTypeCombos(query);
    const delivered = matches.filter((m) => m.outcome.label === "delivered");
    const result = {
      ok: true as const,
      form: query.form,
      skills: [...new Set(query.skills.map(normalizeComboSkill))].sort(),
      total: matches.length,
      delivered: delivered.length,
      thresholdMet: delivered.length >= 2,
      matches: matches.map((m) => ({
        sessionId: m.sessionId,
        ts: m.ts,
        lastSeen: m.lastSeen,
        source: m.source,
        outcome: String(m.outcome.label ?? "unknown"),
        task: m.task,
      })),
    };
    if (globals.json) emitJson(result);
    else {
      out(`same-type form=${result.form} skills=${result.skills.join("+")}: total=${result.total} delivered=${result.delivered} thresholdMet=${result.thresholdMet}`);
      for (const m of result.matches) out(`${m.sessionId}\t${m.lastSeen}\t${m.outcome}\t${m.task.slice(0, 60)}`);
    }
    return EXIT_OK;
  } finally {
    db.close();
  }
};

// ---- main ----

type CommandHandler = (globals: Globals, argv: string[]) => Promise<number> | number;
const NO_OPTIONS: Record<string, FlagSpec> = {};

/**
 * 命令分发的唯一声明处（晨析条目7 + 10-25 合表）：命令名 → handler + option 面单表，main 只查表，
 * 加命令 = 加一个条目 + 一行 HELP。COMMANDS 与 COMMAND_FLAG_OPTIONS（HELP flag 对齐测试的
 * per-command 真值）都从本表派生投影、键集同源——此前两张平行手工表 28 键逐一对应全靠测试钉住。
 * 走 parseRequestId 的 ~13 个命令 options 同为 REQUEST_ID_OPTIONS；task 字段类 flag 的真值另一半在
 * TASK_FIELD_TABLE（仅 create/update 叠加）；--url/--json 由 main 手工处理、无 option 声明——
 * union 级对齐抓不住单命令漏 flag（create/update 丢 --request-id 的教训），对齐测试按 per-command 做。
 * help 走 main 前置分支不进表；冻结防运行时改写；查表必须 Object.hasOwn——`constructor`/`__proto__`
 * 等原型键不得被当命令分发。
 */
interface CommandSpec {
  readonly handler: CommandHandler;
  readonly options: Record<string, FlagSpec>;
}
const COMMAND_TABLE: Readonly<Record<string, CommandSpec>> = Object.freeze({
  start: { handler: (_globals, argv) => runStart(argv), options: START_OPTIONS },
  status: { handler: (globals) => runStatus(globals), options: NO_OPTIONS },
  list: { handler: runList, options: LIST_OPTIONS },
  get: { handler: runGet, options: NO_OPTIONS },
  create: { handler: runCreate, options: CREATE_OPTIONS },
  update: { handler: runUpdate, options: UPDATE_OPTIONS },
  move: { handler: runMove, options: REQUEST_ID_OPTIONS },
  archive: { handler: (globals, argv) => runSimpleTaskAction(globals, argv, "task.archive", "archived"), options: REQUEST_ID_OPTIONS },
  unarchive: { handler: (globals, argv) => runSimpleTaskAction(globals, argv, "task.unarchive", "unarchived"), options: REQUEST_ID_OPTIONS },
  delete: { handler: runDelete, options: REQUEST_ID_OPTIONS },
  run: { handler: (globals, argv) => runRunCommand(globals, argv, "run.create", "started"), options: REQUEST_ID_OPTIONS },
  cancel: { handler: (globals, argv) => runRunCommand(globals, argv, "run.cancel", "cancelled"), options: REQUEST_ID_OPTIONS },
  goal: { handler: runGoal, options: REQUEST_ID_OPTIONS },
  "worktree-clean": { handler: runWorktreeClean, options: REQUEST_ID_OPTIONS },
  "bind-thread": { handler: (globals, argv) => runBindThread(globals, argv, true), options: BIND_THREAD_OPTIONS },
  "unbind-thread": { handler: (globals, argv) => runBindThread(globals, argv, false), options: BIND_THREAD_OPTIONS },
  "ignore-thread": { handler: (globals, argv) => runIgnoreThread(globals, argv, true), options: REQUEST_ID_OPTIONS },
  "unignore-thread": { handler: (globals, argv) => runIgnoreThread(globals, argv, false), options: REQUEST_ID_OPTIONS },
  "inspect-thread": { handler: runInspectThread, options: NO_OPTIONS },
  summaries: { handler: runSummaries, options: NO_OPTIONS },
  proposals: { handler: (globals) => runProposals(globals), options: NO_OPTIONS },
  "accept-proposal": { handler: (globals, argv) => runDecideProposal(globals, argv, true), options: REQUEST_ID_OPTIONS },
  "reject-proposal": { handler: (globals, argv) => runDecideProposal(globals, argv, false), options: REQUEST_ID_OPTIONS },
  wait: { handler: runWait, options: WAIT_OPTIONS },
  refresh: { handler: runRefresh, options: REQUEST_ID_OPTIONS },
  "pause-automation": { handler: (globals, argv) => runAutomation(globals, argv, true), options: REQUEST_ID_OPTIONS },
  "resume-automation": { handler: (globals, argv) => runAutomation(globals, argv, false), options: REQUEST_ID_OPTIONS },
  db: { handler: runDb, options: DB_OPTIONS },
  retro: { handler: runRetro, options: RETRO_OPTIONS },
});
/** 投影：main 的分发表。 */
const COMMANDS: Readonly<Record<string, CommandHandler>> = Object.freeze(
  Object.fromEntries(Object.entries(COMMAND_TABLE).map(([name, spec]) => [name, spec.handler])),
);
export { COMMANDS };
/** 投影：HELP flag 对齐测试的 per-command 真值（issue #35）。 */
export const COMMAND_FLAG_OPTIONS: Readonly<Record<string, Record<string, FlagSpec>>> = Object.freeze(
  Object.fromEntries(Object.entries(COMMAND_TABLE).map(([name, spec]) => [name, spec.options])),
);

export const main = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    out(HELP);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  const globals: Globals = { url: defaultUrl(), json: false };
  const subArgs: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--url") {
      const value = rest[i + 1];
      if (value === undefined) {
        process.stderr.write("Error: --url needs a value\n");
        return EXIT_USAGE;
      }
      globals.url = value;
      i += 1;
      continue;
    }
    if (arg === "--json") {
      globals.json = true;
      continue;
    }
    subArgs.push(arg);
  }
  try {
    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
    if (handler === undefined) {
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return EXIT_USAGE;
    }
    return await handler(globals, subArgs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      process.stderr.write(`Error: ${message}\n`);
      return EXIT_USAGE;
    }
    if (error instanceof UnreachableError) {
      process.stderr.write(`Error: ${message}\n`);
      return EXIT_UNREACHABLE;
    }
    process.stderr.write(`Error: ${message}\n`);
    return EXIT_FAILURE;
  }
};
const invokedDirectly = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
};
/** 导出供 scripts/systemone-smoke.ts 复用：冒烟与 CLI 走同一 .env 加载口径（TASKBOARD_ENV_FILE 覆盖、进程环境优先）。 */
export const loadProjectEnv = (): string | null => {
  const path = process.env.TASKBOARD_ENV_FILE ?? resolve(process.cwd(), ".env");
  try {
    process.loadEnvFile(path);
    return null;
  } catch (error) {
    // 不把解析错误原文写进日志：.env 可能含令牌，错误行也可能回显它
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : `cannot load ${path}`;
  }
};
if (invokedDirectly()) {
  const envError = loadProjectEnv();
  if (envError !== null) {
    process.stderr.write(`Error: ${envError}\n`);
    process.exitCode = EXIT_FAILURE;
  } else {
    void main(process.argv.slice(2)).then((code) => {
      process.exitCode = code;
    });
  }
}
