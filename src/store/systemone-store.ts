import type { Cursor } from "../harness/contract.js";
import type {
  ProgressVerdict,
  ProgressVerdictView,
  SystemOneDegradationCode,
} from "../systemone/contract.js";
import {
  SYSTEMONE_PROMPT_VERSION,
  SYSTEMONE_QUESTION_VERSION,
} from "../systemone/contract.js";
import { newId, StoreCore } from "./core.js";
import { queryAll, queryGet } from "./rows.js";

type AssessmentOutcome =
  | "success"
  | "timeout"
  | "connection"
  | "http_error"
  | "invalid_output"
  | "auth"
  | "manual_reset";

const PRUNE_LIMIT = 100;

interface AssessmentRow {
  rowid: number;
  id: string;
  thread_id: string;
  cache_key: string;
  evidence_fingerprint: string;
  version_key: string;
  provider: string;
  model: string;
  prompt_version: string;
  question_version: string;
  outcome: string;
  status: string | null;
  confidence: number | null;
  reason_short: string | null;
  evidence_refs: string | null;
  covers_through: string | null;
  provenance: string | null;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  failure_message: string | null;
  assessed_at: number;
}

interface StateRow {
  thread_id: string;
  consecutive_failures: number;
  breaker_open: number;
  breaker_opened_at: number | null;
  last_degradation_code: string | null;
  last_degradation_at: number | null;
  last_attempt_at: number | null;
  last_success_at: number | null;
  updated_at: number;
}

export interface SystemOneFactsView {
  threadId: string;
  versionKey: string;
}

const verdictFromRow = (row: AssessmentRow): ProgressVerdict => ({
  status: row.status as ProgressVerdict["status"],
  confidence: row.confidence ?? 0,
  reasonShort: row.reason_short ?? "",
  evidenceRefs: row.evidence_refs === null ? [] : (JSON.parse(row.evidence_refs) as string[]),
  coversThrough: row.covers_through === null ? null : (JSON.parse(row.covers_through) as Cursor),
  provenance: row.provenance ?? "",
  assessedAt: new Date(row.assessed_at).toISOString(),
});

const latestSuccess = (db: StoreCore["db"], threadId: string): AssessmentRow | undefined =>
  queryGet<AssessmentRow>(
    db,
    "SELECT rowid, * FROM systemone_assessments WHERE thread_id = ? AND outcome = 'success' ORDER BY assessed_at DESC, rowid DESC LIMIT 1",
    threadId,
  );

const latestRow = (db: StoreCore["db"], threadId: string): AssessmentRow | undefined =>
  queryGet<AssessmentRow>(
    db,
    "SELECT rowid, * FROM systemone_assessments WHERE thread_id = ? ORDER BY assessed_at DESC, rowid DESC LIMIT 1",
    threadId,
  );

const lastAttemptIso = (
  state: StateRow | undefined,
  lastRow: AssessmentRow | undefined,
): string | null => {
  if (state?.last_attempt_at !== null && state?.last_attempt_at !== undefined) {
    return new Date(state.last_attempt_at).toISOString();
  }
  return lastRow === undefined ? null : new Date(lastRow.assessed_at).toISOString();
};

const messageFor = (code: SystemOneDegradationCode): string => {
  switch (code) {
    case "timeout":
      return "SystemOne 调用超时";
    case "connection":
      return "SystemOne 连接失败";
    case "http_error":
      return "SystemOne 网关错误";
    case "invalid_output":
      return "SystemOne 返回非法";
    case "auth":
      return "SystemOne 鉴权失败";
    case "budget_exhausted":
      return "SystemOne 当日预算已用完";
    case "breaker_open":
      return "SystemOne 断路器已打开";
    case "provider_unavailable":
      return "SystemOne provider 不可用";
    case "no_evidence":
      return "暂无可判断证据";
    case "disabled":
      return "SystemOne 已关闭";
    case "backoff":
      return "SystemOne 退避中";
    case "version_changed":
      return "SystemOne 版本已变化";
  }
};

export class SystemOneStore {
  private readonly core: StoreCore;
  private readonly db: StoreCore["db"];
  private readonly now: () => number;

  constructor(core: StoreCore) {
    this.core = core;
    this.db = core.db;
    this.now = (): number => core.now();
  }

  currentVersionKey(params: { provider: string; model: string }): string {
    return [params.provider, params.model, SYSTEMONE_PROMPT_VERSION, SYSTEMONE_QUESTION_VERSION].join("|");
  }

  recordSuccess(input: {
    threadId: string;
    cacheKey: string;
    fingerprint: string;
    versionKey: string;
    provider: string;
    model: string;
    verdict: ProgressVerdict;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
  }): ProgressVerdictView {
    this.requireThread(input.threadId);
    return this.core.write((touch) => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO systemone_assessments (id, thread_id, cache_key, evidence_fingerprint, version_key,
             provider, model, prompt_version, question_version, outcome, status, confidence, reason_short,
             evidence_refs, covers_through, provenance, latency_ms, input_tokens, output_tokens, assessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId("s1"),
          input.threadId,
          input.cacheKey,
          input.fingerprint,
          input.versionKey,
          input.provider,
          input.model,
          SYSTEMONE_PROMPT_VERSION,
          SYSTEMONE_QUESTION_VERSION,
          input.verdict.status,
          input.verdict.confidence,
          input.verdict.reasonShort,
          JSON.stringify(input.verdict.evidenceRefs),
          input.verdict.coversThrough === null ? null : JSON.stringify(input.verdict.coversThrough),
          input.verdict.provenance,
          input.latencyMs,
          input.inputTokens,
          input.outputTokens,
          now,
        );
      this.prune(input.threadId);
      this.db
        .prepare(
          `INSERT INTO systemone_thread_state
             (thread_id, consecutive_failures, breaker_open, breaker_opened_at, last_degradation_code,
              last_degradation_at, last_attempt_at, last_success_at, updated_at)
           VALUES (?, 0, 0, NULL, NULL, NULL, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             consecutive_failures = 0,
             breaker_open = 0,
             breaker_opened_at = NULL,
             last_degradation_code = NULL,
             last_degradation_at = NULL,
             last_attempt_at = excluded.last_attempt_at,
             last_success_at = excluded.last_success_at,
             updated_at = excluded.updated_at`,
        )
        .run(input.threadId, now, now, now);
      const day = new Date(now).toISOString().slice(0, 10);
      this.db
        .prepare(
          `INSERT INTO systemone_daily_usage (day, input_tokens, output_tokens, calls)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(day) DO UPDATE SET
             input_tokens = systemone_daily_usage.input_tokens + excluded.input_tokens,
             output_tokens = systemone_daily_usage.output_tokens + excluded.output_tokens,
             calls = systemone_daily_usage.calls + 1`,
        )
        .run(day, input.inputTokens, input.outputTokens);
      touch("threads", input.threadId);
      return this.view(input.threadId, input.versionKey)!;
    });
  }

  recordFailure(input: {
    threadId: string;
    cacheKey: string;
    fingerprint: string;
    versionKey: string;
    provider: string;
    model: string;
    outcome: Exclude<AssessmentOutcome, "success" | "manual_reset">;
    failureMessage: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    breakerThreshold?: number;
  }): ProgressVerdictView {
    this.requireThread(input.threadId);
    const threshold = input.breakerThreshold ?? 3;
    return this.core.write((touch) => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO systemone_assessments (id, thread_id, cache_key, evidence_fingerprint, version_key,
             provider, model, prompt_version, question_version, outcome, failure_message,
             latency_ms, input_tokens, output_tokens, assessed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId("s1"),
          input.threadId,
          input.cacheKey,
          input.fingerprint,
          input.versionKey,
          input.provider,
          input.model,
          SYSTEMONE_PROMPT_VERSION,
          SYSTEMONE_QUESTION_VERSION,
          input.outcome,
          input.failureMessage,
          input.latencyMs ?? 0,
          input.inputTokens ?? 0,
          input.outputTokens ?? 0,
          now,
        );
      this.prune(input.threadId);
      const prev = queryGet<StateRow>(
        this.db,
        "SELECT * FROM systemone_thread_state WHERE thread_id = ?",
        input.threadId,
      );
      const failures = (prev?.consecutive_failures ?? 0) + 1;
      const open = failures >= threshold ? 1 : (prev?.breaker_open ?? 0);
      const openedAt = failures >= threshold && (prev?.breaker_open ?? 0) === 0 ? now : (prev?.breaker_opened_at ?? null);
      this.db
        .prepare(
          `INSERT INTO systemone_thread_state
             (thread_id, consecutive_failures, breaker_open, breaker_opened_at, last_degradation_code,
              last_degradation_at, last_attempt_at, last_success_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             consecutive_failures = excluded.consecutive_failures,
             breaker_open = excluded.breaker_open,
             breaker_opened_at = excluded.breaker_opened_at,
             last_degradation_code = excluded.last_degradation_code,
             last_degradation_at = excluded.last_degradation_at,
             last_attempt_at = excluded.last_attempt_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.threadId,
          failures,
          open,
          openedAt,
          input.outcome,
          now,
          now,
          prev?.last_success_at ?? null,
          now,
        );
      touch("threads", input.threadId);
      return this.view(input.threadId, input.versionKey)!;
    });
  }

  resumeBreaker(input: { threadId: string; versionKey: string; provider: string; model: string }): ProgressVerdictView {
    this.requireThread(input.threadId);
    return this.core.write((touch) => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO systemone_assessments (id, thread_id, cache_key, evidence_fingerprint, version_key,
             provider, model, prompt_version, question_version, outcome, latency_ms, input_tokens, output_tokens, assessed_at)
           VALUES (?, ?, '', '', ?, ?, ?, ?, ?, 'manual_reset', 0, 0, 0, ?)`,
        )
        .run(
          newId("s1"),
          input.threadId,
          input.versionKey,
          input.provider,
          input.model,
          SYSTEMONE_PROMPT_VERSION,
          SYSTEMONE_QUESTION_VERSION,
          now,
        );
      this.prune(input.threadId);
      this.db
        .prepare(
          `INSERT INTO systemone_thread_state
             (thread_id, consecutive_failures, breaker_open, breaker_opened_at, last_degradation_code,
              last_degradation_at, last_attempt_at, last_success_at, updated_at)
           VALUES (?, 0, 0, NULL, NULL, NULL, NULL,
             COALESCE((SELECT last_success_at FROM systemone_thread_state WHERE thread_id = ?), NULL), ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             consecutive_failures = 0,
             breaker_open = 0,
             breaker_opened_at = NULL,
             last_degradation_code = NULL,
             last_degradation_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(input.threadId, input.threadId, now);
      touch("threads", input.threadId);
      return this.view(input.threadId, input.versionKey)!;
    });
  }

  cacheHit(input: { threadId: string; cacheKey: string; currentVersionKey?: string }): ProgressVerdictView | null {
    const row = queryGet<AssessmentRow>(
      this.db,
      `SELECT rowid, * FROM systemone_assessments
       WHERE thread_id = ? AND cache_key = ? AND outcome = 'success'
       ORDER BY assessed_at DESC, rowid DESC LIMIT 1`,
      input.threadId,
      input.cacheKey,
    );
    if (row === undefined) return null;
    const laterFailure = queryGet<AssessmentRow>(
      this.db,
      `SELECT rowid, * FROM systemone_assessments
       WHERE thread_id = ? AND outcome != 'success' AND outcome != 'manual_reset' AND rowid > ?
       ORDER BY rowid DESC LIMIT 1`,
      input.threadId,
      row.rowid,
    );
    if (laterFailure !== undefined) return null;
    const state = queryGet<StateRow>(
      this.db,
      "SELECT * FROM systemone_thread_state WHERE thread_id = ?",
      input.threadId,
    );
    return this.viewFromSuccess(
      row,
      state,
      input.currentVersionKey ?? row.version_key,
      lastAttemptIso(state, latestRow(this.db, input.threadId)),
    );
  }

  view(threadId: string, currentVersionKey?: string): ProgressVerdictView | null {
    if (this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId) === undefined) return null;
    const success = latestSuccess(this.db, threadId);
    const state = queryGet<StateRow>(
      this.db,
      "SELECT * FROM systemone_thread_state WHERE thread_id = ?",
      threadId,
    );
    const lastRow = latestRow(this.db, threadId);
    const lastAttemptAt = lastAttemptIso(state, lastRow);
    if (success === undefined) {
      const code = state?.last_degradation_code as SystemOneDegradationCode | null | undefined;
      return {
        threadId,
        state: "unknown",
        verdict: null,
        degradation:
          code === null || code === undefined
            ? null
            : {
                code,
                message: messageFor(code),
                at: state?.last_degradation_at == null ? new Date(0).toISOString() : new Date(state.last_degradation_at).toISOString(),
              },
        breakerOpen: (state?.breaker_open ?? 0) === 1,
        lastAttemptAt,
      };
    }
    const expectedKey =
      currentVersionKey ?? this.currentVersionKey({ provider: success.provider, model: success.model });
    return this.viewFromSuccess(success, state, expectedKey, lastAttemptAt);
  }

  private viewFromSuccess(
    success: AssessmentRow,
    state: StateRow | undefined,
    expectedVersionKey: string,
    lastAttemptAt: string | null,
  ): ProgressVerdictView {
    if (success.version_key !== expectedVersionKey) {
      return {
        threadId: success.thread_id,
        state: "stale",
        verdict: verdictFromRow(success),
        degradation: {
          code: "version_changed",
          message: messageFor("version_changed"),
          at: new Date(success.assessed_at).toISOString(),
        },
        breakerOpen: (state?.breaker_open ?? 0) === 1,
        lastAttemptAt,
      };
    }
    if (
      state?.last_degradation_at != null &&
      state.last_degradation_at >= success.assessed_at
    ) {
      const code = state.last_degradation_code as SystemOneDegradationCode;
      return {
        threadId: success.thread_id,
        state: "stale",
        verdict: verdictFromRow(success),
        degradation: {
          code,
          message: messageFor(code),
          at: new Date(state.last_degradation_at).toISOString(),
        },
        breakerOpen: (state?.breaker_open ?? 0) === 1,
        lastAttemptAt,
      };
    }
    return {
      threadId: success.thread_id,
      state: "current",
      verdict: verdictFromRow(success),
      degradation: null,
      breakerOpen: (state?.breaker_open ?? 0) === 1,
      lastAttemptAt,
    };
  }

  views(threadIds?: readonly string[], currentVersionKey?: string): ProgressVerdictView[] {
    if (threadIds !== undefined && threadIds.length === 0) return [];
    const ids =
      threadIds ??
      queryAll<{ thread_id: string }>(
        this.db,
        "SELECT DISTINCT thread_id AS thread_id FROM systemone_assessments",
      ).map((row) => row.thread_id);
    return ids
      .map((id) => this.view(id, currentVersionKey))
      .filter((view): view is ProgressVerdictView => view !== null);
  }

  usageToday(nowMs?: number): { day: string; inputTokens: number; outputTokens: number; calls: number } {
    const day = new Date(nowMs ?? this.now()).toISOString().slice(0, 10);
    const row = queryGet<{ input_tokens: number; output_tokens: number; calls: number }>(
      this.db,
      "SELECT input_tokens, output_tokens, calls FROM systemone_daily_usage WHERE day = ?",
      day,
    );
    return {
      day,
      inputTokens: row?.input_tokens ?? 0,
      outputTokens: row?.output_tokens ?? 0,
      calls: row?.calls ?? 0,
    };
  }

  facts(threadId: string): SystemOneFactsView | null {
    if (this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId) === undefined) return null;
    const success = latestSuccess(this.db, threadId);
    if (success === undefined) return { threadId, versionKey: "" };
    return { threadId, versionKey: success.version_key };
  }

  state(threadId: string): StateRow | null {
    return queryGet<StateRow>(
      this.db,
      "SELECT * FROM systemone_thread_state WHERE thread_id = ?",
      threadId,
    ) ?? null;
  }

  assessmentsCount(threadId: string): number {
    const row = queryGet<{ n: number }>(
      this.db,
      "SELECT count(*) AS n FROM systemone_assessments WHERE thread_id = ?",
      threadId,
    );
    return row?.n ?? 0;
  }

  private prune(threadId: string): void {
    this.db
      .prepare(
        `DELETE FROM systemone_assessments WHERE thread_id = ? AND id IN (
           SELECT id FROM systemone_assessments WHERE thread_id = ? ORDER BY assessed_at DESC, rowid DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(threadId, threadId, PRUNE_LIMIT);
  }

  private requireThread(threadId: string): void {
    const row = this.db.prepare("SELECT 1 FROM threads WHERE id = ?").get(threadId);
    if (row === undefined) throw new Error(`thread not found: ${threadId}`);
  }
}
