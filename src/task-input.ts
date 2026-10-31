/** 任务输入校验：把不可信 JSON 变成类型化输入；语义校验（父子/cron 求解）在 Store 内做。 */

import { isAbsolute } from "node:path";
import { ValidationError } from "./errors.js";
import { normalizeLabels } from "./labels.js";
import {
  ACCEPTANCE_MODES,
  AUTOMATION_MODES,
  TASK_SOURCES,
  WORKSPACE_MODES,
  type AcceptanceMode,
  type AutomationMode,
  type SubtasksPolicy,
  type TaskSource,
  type WorkspaceMode,
} from "./types.js";

export interface CreateTaskInput {
  title: string;
  prompt: string;
  workspace: string | null;
  status: "backlog" | "todo";
  labels: string[];
  source: TaskSource;
  acceptanceCriteria: string;
  acceptanceMode: AcceptanceMode;
  automationMode: AutomationMode;
  /** 用户是否显式给了 automationMode：显式设置永远赢默认策略（需求「默认策略」/故事 49）。 */
  automationModeExplicit: boolean;
  workspaceMode: WorkspaceMode;
  parentId: string | null;
  subtasksPolicy: SubtasksPolicy | null;
  idleThresholdMs: number | null;
  cron: string | null;
  tz: string | null;
  goalEnabled: boolean;
  goalBudgetTokens: number | null;
}

/** 更新：未出现的键保持不变；显式 null 表示清空（可空字段）。 */
export type UpdateTaskInput = Partial<Omit<CreateTaskInput, "source" | "status">>;

type Raw = Record<string, unknown>;

const asRecord = (raw: unknown, label: string): Raw => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`${label} must be an object`);
  }
  return raw as Raw;
};

const optionalString = (raw: Raw, key: string): string | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${key} must be a string`);
  return value;
};

const nullableString = (raw: Raw, key: string): string | null | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${key} must be a string or null`);
  return value;
};

const optionalBoolean = (raw: Raw, key: string): boolean | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new ValidationError(`${key} must be a boolean`);
  return value;
};

const nullablePositiveInt = (raw: Raw, key: string): number | null | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${key} must be a positive integer or null`);
  }
  return value;
};

const optionalEnum = <T extends string>(
  raw: Raw,
  key: string,
  allowed: readonly T[],
): T | undefined => {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
};

export const validateTitle = (value: string | undefined): string => {
  const title = value?.trim() ?? "";
  if (title.length === 0) throw new ValidationError("title is required");
  return title;
};

export const validateWorkspace = (value: string | null | undefined): string | null => {
  if (value === undefined || value === null) return null;
  const workspace = value.trim();
  if (workspace.length === 0) return null;
  if (!isAbsolute(workspace)) throw new ValidationError("workspace must be an absolute path");
  return workspace;
};

const parseSubtasksPolicy = (raw: Raw): SubtasksPolicy | null | undefined => {
  const value = raw.subtasksPolicy;
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value !== "cascade") throw new ValidationError("subtasksPolicy must be 'cascade' or null");
  return "cascade";
};

const parseCronPair = (raw: Raw): { cron: string | null | undefined; tz: string | null | undefined } => {
  const cron = nullableString(raw, "cron");
  const tz = nullableString(raw, "tz");
  const cronValue = cron === undefined ? undefined : cron === null || cron.trim() === "" ? null : cron.trim();
  const tzValue = tz === undefined ? undefined : tz === null || tz.trim() === "" ? null : tz.trim();
  return { cron: cronValue, tz: tzValue };
};

export const parseCreateTaskInput = (rawInput: unknown): CreateTaskInput => {
  const raw = asRecord(rawInput, "task");
  const { cron, tz } = parseCronPair(raw);
  const labels = raw.labels === undefined ? [] : normalizeLabels(raw.labels);
  return {
    title: validateTitle(optionalString(raw, "title")),
    prompt: optionalString(raw, "prompt") ?? "",
    workspace: validateWorkspace(nullableString(raw, "workspace")),
    status: optionalEnum(raw, "status", ["backlog", "todo"] as const) ?? "todo",
    labels,
    source: optionalEnum(raw, "source", TASK_SOURCES) ?? "manual",
    acceptanceCriteria: optionalString(raw, "acceptanceCriteria") ?? "",
    acceptanceMode: optionalEnum(raw, "acceptanceMode", ACCEPTANCE_MODES) ?? "human",
    automationMode: optionalEnum(raw, "automationMode", AUTOMATION_MODES) ?? "suggest",
    automationModeExplicit: raw.automationMode !== undefined,
    workspaceMode: optionalEnum(raw, "workspaceMode", WORKSPACE_MODES) ?? "current",
    parentId: nullableString(raw, "parentId") ?? null,
    subtasksPolicy: parseSubtasksPolicy(raw) ?? null,
    idleThresholdMs: nullablePositiveInt(raw, "idleThresholdMs") ?? null,
    cron: cron ?? null,
    tz: tz ?? null,
    goalEnabled: optionalBoolean(raw, "goalEnabled") ?? false,
    goalBudgetTokens: nullablePositiveInt(raw, "goalBudgetTokens") ?? null,
  };
};

export const parseUpdateTaskInput = (rawInput: unknown): UpdateTaskInput => {
  const raw = asRecord(rawInput, "patch");
  const out: UpdateTaskInput = {};
  const title = optionalString(raw, "title");
  if (title !== undefined) out.title = validateTitle(title);
  const prompt = optionalString(raw, "prompt");
  if (prompt !== undefined) out.prompt = prompt;
  if (raw.workspace !== undefined) out.workspace = validateWorkspace(nullableString(raw, "workspace"));
  if (raw.labels !== undefined) out.labels = normalizeLabels(raw.labels);
  const acceptanceCriteria = optionalString(raw, "acceptanceCriteria");
  if (acceptanceCriteria !== undefined) out.acceptanceCriteria = acceptanceCriteria;
  const acceptanceMode = optionalEnum(raw, "acceptanceMode", ACCEPTANCE_MODES);
  if (acceptanceMode !== undefined) out.acceptanceMode = acceptanceMode;
  const automationMode = optionalEnum(raw, "automationMode", AUTOMATION_MODES);
  if (automationMode !== undefined) out.automationMode = automationMode;
  const workspaceMode = optionalEnum(raw, "workspaceMode", WORKSPACE_MODES);
  if (workspaceMode !== undefined) out.workspaceMode = workspaceMode;
  if (raw.parentId !== undefined) out.parentId = nullableString(raw, "parentId") ?? null;
  const subtasksPolicy = parseSubtasksPolicy(raw);
  if (subtasksPolicy !== undefined) out.subtasksPolicy = subtasksPolicy;
  const idle = nullablePositiveInt(raw, "idleThresholdMs");
  if (idle !== undefined) out.idleThresholdMs = idle;
  const { cron, tz } = parseCronPair(raw);
  if (cron !== undefined) out.cron = cron;
  if (tz !== undefined) out.tz = tz;
  const goalEnabled = optionalBoolean(raw, "goalEnabled");
  if (goalEnabled !== undefined) out.goalEnabled = goalEnabled;
  const goalBudget = nullablePositiveInt(raw, "goalBudgetTokens");
  if (goalBudget !== undefined) out.goalBudgetTokens = goalBudget;
  if (Object.keys(out).length === 0) throw new ValidationError("patch has no recognized fields");
  return out;
};
