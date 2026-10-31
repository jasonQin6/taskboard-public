/**
 * retro 载荷校验（retro record 用 camelCase 新面；combo-record 用 ~/.retro/combos.jsonl 的
 * schema v1 原snake_case 面，存量生产者零改动）。缺省值只补「可从当下推导」的字段（时间/空集），
 * 不猜内容性字段。
 */

import { ValidationError } from "./errors.js";

export const RETRO_SOURCES = ["interactive", "headless", "attempt"] as const;
export type RetroSource = (typeof RETRO_SOURCES)[number];

/** 承接原 retro-ledger 状态机：continuation_open→open，done/skipped/failed 原名（ADR-0024）。 */
export const RETRO_STATUSES = ["open", "done", "failed", "skipped"] as const;
export type RetroStatus = (typeof RETRO_STATUSES)[number];

export const RETRO_MAX_ATTEMPTS = 3;

export interface RetroRecordInput {
  source: RetroSource;
  sessionId: string | null;
  attemptId: string | null;
  issueNumber: number | null;
  cwd: string;
  sessionDate: string;
  generatedAt: number;
  promptVersion: string;
  hookVersion: string;
  conclusion: string | null;
  findings: unknown[];
  notCovered: unknown[];
  status: RetroStatus;
  attempts: number;
  lastError: string | null;
}

interface ParseDefaults {
  now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (payload: Record<string, unknown>, key: string, label: string): string => {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${label} is required (non-empty string)`);
  }
  return value;
};

const optionalString = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${key} must be a non-empty string or null`);
  }
  return value;
};

const optionalJsonArray = (payload: Record<string, unknown>, key: string): unknown[] => {
  const value = payload[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError(`${key} must be an array when present`);
  return value;
};

const parseEpochMs = (value: unknown, key: string, nowMs: number): number => {
  if (value === undefined || value === null) return nowMs;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) throw new ValidationError(`${key} must be an ISO 8601 string or epoch ms`);
    return parsed;
  }
  throw new ValidationError(`${key} must be an ISO 8601 string or epoch ms`);
};

const parsePositiveInt = (value: unknown, key: string, fallback: number): number => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${key} must be a positive integer`);
  }
  return value;
};

const parseIssueNumber = (value: unknown): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  throw new ValidationError("issueNumber must be a non-negative integer or null");
};

export const parseRetroRecordInput = (
  payload: unknown,
  defaults: ParseDefaults = {},
): RetroRecordInput => {
  if (!isRecord(payload)) throw new ValidationError("retro record payload must be a JSON object");
  const nowMs = defaults.now?.() ?? Date.now();
  const source = payload.source;
  if (typeof source !== "string" || !(RETRO_SOURCES as readonly string[]).includes(source)) {
    throw new ValidationError(`source must be one of ${RETRO_SOURCES.join("|")}`);
  }
  const typedSource = source as RetroSource;
  const sessionId = optionalString(payload, "sessionId");
  const attemptId = optionalString(payload, "attemptId");
  if (sessionId === null && attemptId === null) {
    throw new ValidationError("retro record requires sessionId or attemptId (at least one identity key)");
  }
  const issueNumber = parseIssueNumber(payload.issueNumber);
  const status = payload.status;
  if (status !== undefined && !(RETRO_STATUSES as readonly string[]).includes(status as string)) {
    throw new ValidationError(`status must be one of ${RETRO_STATUSES.join("|")}`);
  }
  return {
    source: typedSource,
    sessionId,
    attemptId,
    issueNumber,
    cwd: requireString(payload, "cwd", "cwd"),
    sessionDate:
      payload.sessionDate === undefined
        ? new Date(nowMs).toISOString().slice(0, 10)
        : requireString(payload, "sessionDate", "sessionDate"),
    generatedAt: parseEpochMs(payload.generatedAt, "generatedAt", nowMs),
    promptVersion: typeof payload.promptVersion === "string" ? payload.promptVersion : "unknown",
    hookVersion: typeof payload.hookVersion === "string" ? payload.hookVersion : "unknown",
    conclusion: optionalString(payload, "conclusion"),
    findings: optionalJsonArray(payload, "findings"),
    notCovered: optionalJsonArray(payload, "notCovered"),
    status: (status ?? "done") as RetroStatus,
    attempts: parsePositiveInt(payload.attempts, "attempts", 1),
    lastError: optionalString(payload, "lastError"),
  };
};

export interface ComboRecordInput {
  sessionId: string;
  version: number;
  ts: string;
  cwd: string;
  source: string;
  task: string;
  form: string | null;
  formHint: string | null;
  skills: string[];
  verdict: Record<string, unknown>;
  actual: Record<string, unknown>;
  outcome: Record<string, unknown>;
  issue: unknown;
  artifact: unknown;
  verify: unknown;
  blocker: unknown;
  retroPath: string | null;
  gap: string | null;
  firstSeen: string;
  lastSeen: string;
}

const optionalObject = (payload: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = payload[key];
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new ValidationError(`${key} must be an object when present`);
  return value;
};

const optionalIso = (payload: Record<string, unknown>, key: string, nowMs: number): string => {
  const value = payload[key];
  if (value === undefined || value === null) return new Date(nowMs).toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${key} must be an ISO 8601 string`);
  }
  return value;
};

/** combo 载荷 = combos.jsonl v1 记录原文（snake_case）；form/form_hint/skills 自 actual 提升。 */
export const parseComboRecordInput = (
  payload: unknown,
  defaults: ParseDefaults = {},
): ComboRecordInput => {
  if (!isRecord(payload)) throw new ValidationError("combo record payload must be a JSON object");
  const nowMs = defaults.now?.() ?? Date.now();
  const actual = optionalObject(payload, "actual");
  const skills = actual.skills === undefined || actual.skills === null ? [] : actual.skills;
  if (!Array.isArray(skills) || skills.some((skill) => typeof skill !== "string")) {
    throw new ValidationError("actual.skills must be an array of strings when present");
  }
  const firstSeen = optionalIso(payload, "first_seen", nowMs);
  return {
    sessionId: requireString(payload, "session_id", "session_id"),
    version: parsePositiveInt(payload.version, "version", 1),
    ts: optionalIso(payload, "ts", nowMs),
    cwd: requireString(payload, "cwd", "cwd"),
    source: requireString(payload, "source", "source"),
    task: requireString(payload, "task", "task"),
    form: optionalString(actual, "form"),
    formHint: optionalString(actual, "form_hint"),
    skills,
    verdict: optionalObject(payload, "verdict"),
    actual,
    outcome: optionalObject(payload, "outcome"),
    issue: payload.issue ?? null,
    artifact: payload.artifact ?? null,
    verify: payload.verify ?? null,
    blocker: payload.blocker ?? null,
    retroPath: optionalString(payload, "retro_path"),
    gap: optionalString(payload, "gap"),
    firstSeen,
    lastSeen: optionalIso(payload, "last_seen", nowMs),
  };
};
