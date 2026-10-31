import type { Cursor } from "../harness/contract.js";

export const SYSTEMONE_CONTRACT_VERSION = 1;
export const SYSTEMONE_PROMPT_VERSION = "progress-p1.0";
export const SYSTEMONE_QUESTION_VERSION = "progress-q1.0";

export const SEMANTIC_STATUSES = [
  "progressing",
  "waiting_user",
  "blocked",
  "complete",
  "needs_attention",
  "unknown",
] as const;
export type SemanticStatus = (typeof SEMANTIC_STATUSES)[number];

export interface ProgressVerdict {
  status: SemanticStatus;
  confidence: number;
  reasonShort: string;
  evidenceRefs: string[];
  coversThrough: Cursor | null;
  provenance: string;
  assessedAt: string;
}

export type SystemOneFailureCode = "timeout" | "connection" | "http_error" | "invalid_output" | "auth";
export type SystemOneDegradationCode =
  | SystemOneFailureCode
  | "budget_exhausted"
  | "breaker_open"
  | "provider_unavailable"
  | "no_evidence"
  | "disabled"
  | "backoff"
  | "version_changed";
export type SystemOneViewState = "current" | "stale" | "unknown";

export interface ProgressVerdictView {
  threadId: string;
  state: SystemOneViewState;
  verdict: ProgressVerdict | null;
  degradation: { code: SystemOneDegradationCode; message: string; at: string } | null;
  breakerOpen: boolean;
  lastAttemptAt: string | null;
}

export interface SystemOneRuntimeView {
  enabled: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  questionVersion: string;
  available: boolean;
  unavailableReason: string | null;
  externalData: readonly string[];
  budget: { day: string; usedTokens: number; limitTokens: number; exhausted: boolean };
  concurrency: { limit: number; inFlight: number };
  breaker: { threshold: number; backoffMs: number };
}

export const isSemanticStatus = (value: unknown): value is SemanticStatus =>
  typeof value === "string" && (SEMANTIC_STATUSES as readonly string[]).includes(value);

export const isValidConfidence = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export const isEvidenceRefsSubset = (
  refs: readonly unknown[],
  allowed: readonly string[],
): refs is string[] => {
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) return false;
  const allow = new Set(allowed);
  return (refs as string[]).every((ref) => allow.has(ref));
};

export const isValidProvenance = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  if (!value.startsWith("systemone:")) return false;
  const rest = value.slice("systemone:".length);
  const slash = rest.indexOf("/");
  const at = rest.lastIndexOf("@");
  if (slash <= 0 || at <= slash + 1 || at === rest.length - 1) return false;
  return true;
};

export const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
