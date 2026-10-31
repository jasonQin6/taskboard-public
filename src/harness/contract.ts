/**
 * Phase 1 跨 Harness 只读契约。Harness 私有 schema 只能出现在各自 adapter 内；
 * 共享层只消费这些稳定字段，字段集合由 test/harness-contract.test.ts 钉住。
 */

import { THREAD_NATIVE_STATUSES, type ThreadNativeStatus } from "../types.js";

export const HARNESS_READ_CAPABILITIES = [
  "session.list",
  "turn.read",
  "evidence.read",
  "summary.read",
] as const;
export type HarnessReadCapability = (typeof HARNESS_READ_CAPABILITIES)[number];

export const FAILURE_CODES = [
  "adapter_failed",
  "source_unreadable",
  "source_locator_incomplete",
  "unknown_native_status",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export type FailureScope =
  | { kind: "harness"; harnessId: string }
  | { kind: "source"; harnessId: string; sourceId: string }
  | { kind: "session"; harnessId: string; nativeSessionId: string }
  | { kind: "field"; harnessId: string; nativeSessionId: string; field: string };

export interface Failure {
  code: FailureCode;
  message: string;
  scope: FailureScope;
  retryable: boolean;
}

export interface SourceLocator {
  harnessId: string;
  nativeSessionId: string;
  sourcePath: string | null;
  byteStart: number | null;
  recordHash: string | null;
}

export interface Cursor {
  sourceUnitId: string;
  contentPosition: number;
  prefixHash: string;
  tailHash: string | null;
  parserVersion: number;
}

export interface CapabilityManifest {
  harnessId: string;
  displayName: string;
  schemaVersion: string;
  readOnly: true;
  capabilities: readonly HarnessReadCapability[];
  readPaths: readonly string[];
  degradations: readonly FailureCode[];
}

/**
 * SessionSnapshot 是可由源数据重建的投影。未知字段保留 null 并列入 unknownFields，
 * 不在这里猜测；内部 id 与跨 Harness 身份分开，避免把某个 Harness 的 native id 当主键。
 */
export interface SessionSnapshot {
  id: string;
  harnessId: string;
  nativeSessionId: string;
  title: string | null;
  workspace: string | null;
  nativeStatus: ThreadNativeStatus;
  lastActivityAt: string | null;
  nativeGroup: string | null;
  unknownFields: readonly string[];
  locator: SourceLocator;
  cursor: Cursor | null;
  provenance: string;
}

export interface HarnessObservation {
  sessions: readonly SessionSnapshot[];
  failures: readonly Failure[];
}

export interface HarnessAdapter {
  capabilityManifest(): CapabilityManifest;
  observe(): HarnessObservation;
  /**
   * 摄取生命周期：daemon 经此面启停与触发扫描，observe 只读 store 投影。
   * 摄取由 reader 负责的事实不变，只是不再由调用方直摸 reader 私有细节。
   */
  start(): void;
  stop(): Promise<void>;
  progress(): HarnessScanProgress;
  scanNow(): Promise<unknown>;
}

/** adapter 摄取进度（views scan 面所需的最小交集；fileErrors 仍只在 adapter.observe 内部消费）。 */
export interface HarnessScanProgress {
  phase: "idle" | "running" | "done";
  filesTotal: number;
  filesDone: number;
  lastCompletedAt: string | null;
}

// held 经 V2 执行面写锁冲突写入（Phase 1 观察路径不产生）；词表以 types.ts 为单源，此处只派生不断言
export const isThreadNativeStatus = (value: unknown): value is ThreadNativeStatus =>
  (THREAD_NATIVE_STATUSES as readonly unknown[]).includes(value);
