import type { ThreadNativeStatus } from "../types.js";
import type { SemanticStatus } from "./contract.js";
import { SystemOneProviderError } from "./errors.js";

export type { SystemOneProviderError };

export interface JudgeSubject {
  threadId: string;
  harnessId: string;
  nativeSessionId: string;
  nativeStatus: ThreadNativeStatus;
  title: string | null;
  workspace: string | null;
}

export interface JudgeInput {
  subject: JudgeSubject;
  cursor: import("../harness/contract.js").Cursor | null;
  turns: {
    total: number;
    byStatus: Readonly<Record<string, number>>;
    latest: { ordinal: number; nativeStatus: string } | null;
  };
  evidence: ReadonlyArray<{
    id: string;
    kind: string;
    turnOrdinal: number | null;
    excerpt: string;
    recordHash: string | null;
  }>;
  summary: {
    provenance: "compacted" | "sample";
    text: string;
    coveredThroughTurnOrdinal: number | null;
  } | null;
  overlay: {
    primaryTaskId: string | null;
    taskTitle: string | null;
    labels: readonly string[];
    notes: ReadonlyArray<{ id: string; kind: string; body: string }>;
  };
  allowedEvidenceIds: readonly string[];
}

export interface JudgeResult {
  status: SemanticStatus;
  confidence: number;
  evidenceRefs: readonly string[];
  provider: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface ProviderAvailability {
  ok: true;
}

export interface ProviderUnavailable {
  ok: false;
  reason: string;
}

export interface SystemOneProvider {
  readonly id: string;
  /** 必须与 judge 实际发给网关的模型一致：service 用它算 cacheKey/versionKey，不一致会让不同模型的判定共用缓存。 */
  resolveModel(): string;
  available(settings: import("../types.js").Settings): ProviderAvailability | ProviderUnavailable;
  judge(input: JudgeInput, signal: AbortSignal): Promise<JudgeResult>;
}

export { SystemOneProviderError as ProviderError };
