/**
 * RetroStore：retro / retro_combo 两表的 repository 层（#65）。retro 是会话/attempt 复盘的
 * 账本，combo 是组合观察记录的 upsert 面；两者都不是看板状态——写入不 touch 任何域 revision
 * （Phase 1 UI 不消费），但仍走 StoreCore.write() 事务缝：ADR-0023 的「唯一写路径」指事务层，
 * 不指 revision。身份冲突（session 键与 attempt 键命中不同行、身份列与既有行矛盾）显式
 * ConflictError，绝不静默改写身份。
 */

import { ConflictError, ValidationError } from "../errors.js";
import type { ComboRecordInput, RetroRecordInput, RetroSource, RetroStatus } from "../retro-input.js";
import { newId, StoreCore } from "./core.js";
import { queryAll, queryGet, queryReread } from "./rows.js";

export { RETRO_MAX_ATTEMPTS, RETRO_SOURCES, RETRO_STATUSES } from "../retro-input.js";
export type { ComboRecordInput, RetroRecordInput, RetroSource, RetroStatus } from "../retro-input.js";

interface RetroRow {
  id: string;
  source: RetroSource;
  session_id: string | null;
  attempt_id: string | null;
  issue_number: number | null;
  cwd: string;
  session_date: string;
  generated_at: number;
  prompt_version: string;
  hook_version: string;
  conclusion: string | null;
  findings_json: string;
  not_covered_json: string;
  status: RetroStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface RetroRecordView {
  id: string;
  source: RetroSource;
  sessionId: string | null;
  attemptId: string | null;
  issueNumber: number | null;
  cwd: string;
  sessionDate: string;
  generatedAt: string;
  promptVersion: string;
  hookVersion: string;
  conclusion: string | null;
  findings: unknown[];
  notCovered: unknown[];
  status: RetroStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ComboRow {
  session_id: string;
  version: number;
  ts: string;
  cwd: string;
  source: string;
  task: string;
  form: string | null;
  form_hint: string | null;
  skills_json: string;
  verdict_json: string;
  actual_json: string;
  outcome_json: string;
  issue_json: string | null;
  artifact_json: string | null;
  verify_json: string | null;
  blocker_json: string | null;
  retro_path: string | null;
  gap: string | null;
  first_seen: string;
  last_seen: string;
}

export interface ComboRecordView {
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

export interface RetroIdentity {
  source: RetroSource;
  sessionId?: string | null;
  attemptId?: string | null;
}

export interface SameTypeQuery {
  form: string;
  skills: string[];
}

/**
 * skill 名归一化（口径见 GLOSSARY.md「同型」词条）：小写 + 去 `pstack:` 前缀。归组判据的
 * 一部分，随同型查询下沉到本层，消费方（stop-retro 注入文、retro-enhance）不得另立口径。
 */
export const normalizeComboSkill = (name: string): string => {
  const lowered = name.trim().toLowerCase();
  return lowered.startsWith("pstack:") ? lowered.slice("pstack:".length) : lowered;
};

const comboSkillsKey = (skills: string[]): string =>
  JSON.stringify([...new Set(skills.map(normalizeComboSkill))].sort());

const comboEffectiveForm = (row: ComboRecordView): string => row.form ?? row.formHint ?? "";

const retroView = (row: RetroRow): RetroRecordView => ({
  id: row.id,
  source: row.source,
  sessionId: row.session_id,
  attemptId: row.attempt_id,
  issueNumber: row.issue_number,
  cwd: row.cwd,
  sessionDate: row.session_date,
  generatedAt: new Date(row.generated_at).toISOString(),
  promptVersion: row.prompt_version,
  hookVersion: row.hook_version,
  conclusion: row.conclusion,
  findings: JSON.parse(row.findings_json) as unknown[],
  notCovered: JSON.parse(row.not_covered_json) as unknown[],
  status: row.status,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});

const comboView = (row: ComboRow): ComboRecordView => ({
  sessionId: row.session_id,
  version: row.version,
  ts: row.ts,
  cwd: row.cwd,
  source: row.source,
  task: row.task,
  form: row.form,
  formHint: row.form_hint,
  skills: JSON.parse(row.skills_json) as string[],
  verdict: JSON.parse(row.verdict_json) as Record<string, unknown>,
  actual: JSON.parse(row.actual_json) as Record<string, unknown>,
  outcome: JSON.parse(row.outcome_json) as Record<string, unknown>,
  issue: row.issue_json === null ? null : (JSON.parse(row.issue_json) as unknown),
  artifact: row.artifact_json === null ? null : (JSON.parse(row.artifact_json) as unknown),
  verify: row.verify_json === null ? null : (JSON.parse(row.verify_json) as unknown),
  blocker: row.blocker_json === null ? null : (JSON.parse(row.blocker_json) as unknown),
  retroPath: row.retro_path,
  gap: row.gap,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
});

const encodeJsonColumn = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

export class RetroStore {
  private readonly db: StoreCore["db"];
  private readonly now: () => number;

  constructor(private readonly core: StoreCore) {
    this.db = core.db;
    this.now = (): number => core.now();
  }

  /**
   * 幂等落一条 retro 记录：身份 = (source, session_id) 或 (source, attempt_id)，两个键命中
   * 同一行（或单键命中）即原地刷新载荷；attempts 只增不减（重试预算由调用方声明，重放同载荷
   * 不消耗）。身份列只补空位——非空且不同即 ConflictError。
   */
  recordRetro(input: RetroRecordInput): RetroRecordView {
    return this.core.write(() => {
      const bySession =
        input.sessionId === null
          ? undefined
          : queryGet<RetroRow>(
              this.db,
              "SELECT * FROM retro WHERE source = ? AND session_id = ?",
              input.source,
              input.sessionId,
            );
      const byAttempt =
        input.attemptId === null
          ? undefined
          : queryGet<RetroRow>(
              this.db,
              "SELECT * FROM retro WHERE source = ? AND attempt_id = ?",
              input.source,
              input.attemptId,
            );
      if (bySession !== undefined && byAttempt !== undefined && bySession.id !== byAttempt.id) {
        throw new ConflictError(
          `retro identity conflict: session ${input.sessionId} and attempt ${input.attemptId} ` +
            `match different rows (${bySession.id} vs ${byAttempt.id})`,
        );
      }
      const existing = bySession ?? byAttempt;
      const now = this.now();
      const id = existing?.id ?? newId("retro");
      if (existing === undefined) {
        this.db
          .prepare(
            `INSERT INTO retro (id, source, session_id, attempt_id, issue_number, cwd, session_date,
               generated_at, prompt_version, hook_version, conclusion, findings_json, not_covered_json,
               status, attempts, last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.source,
            input.sessionId,
            input.attemptId,
            input.issueNumber,
            input.cwd,
            input.sessionDate,
            input.generatedAt,
            input.promptVersion,
            input.hookVersion,
            input.conclusion,
            JSON.stringify(input.findings),
            JSON.stringify(input.notCovered),
            input.status,
            input.attempts,
            input.lastError,
            now,
            now,
          );
      } else {
        if (
          existing.session_id !== null &&
          input.sessionId !== null &&
          existing.session_id !== input.sessionId
        ) {
          throw new ConflictError(
            `retro session_id mismatch: row ${existing.id} has ${existing.session_id}, payload has ${input.sessionId}`,
          );
        }
        if (
          existing.attempt_id !== null &&
          input.attemptId !== null &&
          existing.attempt_id !== input.attemptId
        ) {
          throw new ConflictError(
            `retro attempt_id mismatch: row ${existing.id} has ${existing.attempt_id}, payload has ${input.attemptId}`,
          );
        }
        this.db
          .prepare(
            `UPDATE retro SET
               session_id = COALESCE(session_id, ?), attempt_id = COALESCE(attempt_id, ?),
               issue_number = ?, cwd = ?, session_date = ?, generated_at = ?, prompt_version = ?,
               hook_version = ?, conclusion = ?, findings_json = ?, not_covered_json = ?,
               status = ?, attempts = MAX(attempts, ?), last_error = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            input.sessionId,
            input.attemptId,
            input.issueNumber,
            input.cwd,
            input.sessionDate,
            input.generatedAt,
            input.promptVersion,
            input.hookVersion,
            input.conclusion,
            JSON.stringify(input.findings),
            JSON.stringify(input.notCovered),
            input.status,
            input.attempts,
            input.lastError,
            now,
            existing.id,
          );
      }
      return retroView(queryReread<RetroRow>(this.db, "SELECT * FROM retro WHERE id = ?", id));
    });
  }

  /** 按身份键取行；两个键都缺是调用方 bug， ValidationError。 */
  getRetro(identity: RetroIdentity): RetroRecordView | null {
    if ((identity.sessionId ?? null) === null && (identity.attemptId ?? null) === null) {
      throw new ValidationError("getRetro requires sessionId or attemptId");
    }
    const rows = queryAll<RetroRow>(
      this.db,
      `SELECT * FROM retro WHERE source = ?
         AND ((? IS NOT NULL AND session_id = ?) OR (? IS NOT NULL AND attempt_id = ?))
       ORDER BY updated_at DESC LIMIT 1`,
      identity.source,
      identity.sessionId ?? null,
      identity.sessionId ?? null,
      identity.attemptId ?? null,
      identity.attemptId ?? null,
    );
    return rows[0] === undefined ? null : retroView(rows[0]);
  }

  listRetros(limit = 200): RetroRecordView[] {
    return queryAll<RetroRow>(
      this.db,
      "SELECT * FROM retro ORDER BY updated_at DESC, rowid DESC LIMIT ?",
      limit,
    ).map(retroView);
  }

  /** 同 session 幂等刷新：first_seen 首见冻结，其余载荷整体以最新一份为准。 */
  recordCombo(input: ComboRecordInput): ComboRecordView {
    return this.core.write(() => {
      this.db
        .prepare(
          `INSERT INTO retro_combo (session_id, version, ts, cwd, source, task, form, form_hint,
             skills_json, verdict_json, actual_json, outcome_json, issue_json, artifact_json,
             verify_json, blocker_json, retro_path, gap, first_seen, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             version = excluded.version, ts = excluded.ts, cwd = excluded.cwd,
             source = excluded.source, task = excluded.task, form = excluded.form,
             form_hint = excluded.form_hint, skills_json = excluded.skills_json,
             verdict_json = excluded.verdict_json, actual_json = excluded.actual_json,
             outcome_json = excluded.outcome_json, issue_json = excluded.issue_json,
             artifact_json = excluded.artifact_json, verify_json = excluded.verify_json,
             blocker_json = excluded.blocker_json, retro_path = excluded.retro_path,
             gap = excluded.gap, last_seen = excluded.last_seen`,
        )
        .run(
          input.sessionId,
          input.version,
          input.ts,
          input.cwd,
          input.source,
          input.task,
          input.form,
          input.formHint,
          JSON.stringify(input.skills),
          JSON.stringify(input.verdict),
          JSON.stringify(input.actual),
          JSON.stringify(input.outcome),
          encodeJsonColumn(input.issue),
          encodeJsonColumn(input.artifact),
          encodeJsonColumn(input.verify),
          encodeJsonColumn(input.blocker),
          input.retroPath,
          input.gap,
          input.firstSeen,
          input.lastSeen,
        );
      return comboView(
        queryReread<ComboRow>(this.db, "SELECT * FROM retro_combo WHERE session_id = ?", input.sessionId),
      );
    });
  }

  getCombo(sessionId: string): ComboRecordView | null {
    const row = queryGet<ComboRow>(
      this.db,
      "SELECT * FROM retro_combo WHERE session_id = ?",
      sessionId,
    );
    return row === undefined ? null : comboView(row);
  }

  listCombos(limit = 200): ComboRecordView[] {
    return queryAll<ComboRow>(
      this.db,
      "SELECT * FROM retro_combo ORDER BY last_seen DESC LIMIT ?",
      limit,
    ).map(comboView);
  }

  /**
   * 同型匹配（归组键见 GLOSSARY.md「同型」词条）：行 form 取 actual.form 缺省 form_hint，与查询 form 相等；
   * 双方 skills 归一化（小写、去 pstack: 前缀）、去重排序后集合相等。返回按 last_seen 倒序的
   * 全部同型行——delivered 计数与 ≥2 门槛是消费方判断，不在匹配层做。
   */
  findSameTypeCombos(query: SameTypeQuery): ComboRecordView[] {
    const wantedKey = comboSkillsKey(query.skills);
    return this.listCombos(Number.MAX_SAFE_INTEGER).filter(
      (row) => comboEffectiveForm(row) === query.form && comboSkillsKey(row.skills) === wantedKey,
    );
  }
}
