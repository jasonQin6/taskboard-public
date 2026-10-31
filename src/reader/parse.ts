/**
 * rollout 记录解析（纯函数，无 IO）：把一行行 JSONL 变成可入库的 turn/证据/anomaly/摘要草案。
 * 终局判定只认 event_msg 原生变体（词汇表「轮」）；模型上下文副本（response_item）永不产生可见消息证据。
 */

import { createHash } from "node:crypto";
import { redactExcerpt } from "../redact.js";
import type { ReaderSourceLocatorKind, ReaderTurnStatus } from "../store/index.js";

export const PARSER_VERSION = 1;

/** 可见消息短摘录与 compacted 摘要的入库长度上限（需求「证据持久化边界」）。 */
export const MESSAGE_EXCERPT_CHARS = 280;
export const COMPACTED_SUMMARY_CHARS = 2000;

export const recordHashOf = (line: string): string =>
  createHash("sha256").update(line, "utf8").digest("hex");

/** source_id 由 inode + prefix hash + session id 稳定派生（需求「增量与恢复」）。 */
export const sourceIdFor = (inode: number, prefixHash: string, sessionId: string): string =>
  createHash("sha256").update(`${inode}:${prefixHash}:${sessionId}`).digest("hex").slice(0, 32);

export interface RawRecord {
  line: string;
  byteStart: number;
}

export interface ParseState {
  /** thread 已入库 turn 的稳定 id → ordinal（跨轮打开的 turn 依此续写），按 thread 分桶。 */
  knownTurns: Map<string, Map<string, number>>;
  nextTurnOrdinal: Map<string, number>;
  /** 跨轮仍处 running 的 turn id（本轮无 task_started 也保持 thread running），按 thread 分桶。 */
  openTurnIds: Map<string, ReadonlySet<string>>;
  /** source 的记录 ordinal 游标（reader_sources.next_ordinal）。 */
  nextOrdinal: number | null;
  /** 同一 thread/source 已持久化的 turn 覆盖下界；仅纯增量窗口使用。 */
  coveredThroughTurnOrdinalByThread: ReadonlyMap<string, number>;
  /**
   * source 尾部 session（reader_sources.thread_id）：session_meta 只写文件首行，增量窗口不含它；
   * 不播种的话窗口内所有记录都无法归属 thread，游标照常前推、记录永久丢失。
   */
  tailSessionId?: string | null;
}

export interface SessionDraft {
  sessionId: string;
  isSubagentThread: boolean;
  title: string | null;
  cwd: string | null;
  nativeGroup: string | null;
  metaByteStart: number | null;
  metaRecordHash: string | null;
  lastActivityAt: number | null;
  nativeStatus: "running" | "idle" | "completed" | "failed" | "interrupted" | null;
  compacted: {
    text: string;
    recordHash: string;
    byteStart: number;
    coveredThroughTurnOrdinal: number | null;
  } | null;
}

export interface ThreadTurnDraft extends TurnDraft {
  threadId: string;
}

export interface ThreadEvidenceDraft extends EvidenceDraft {
  threadId: string;
}

export interface EvidenceDraft {
  byteStart: number;
  recordHash: string;
  turnOrdinal: number | null;
  kind: string;
  summary: string | null;
  props: Record<string, unknown> | null;
}

export interface TurnDraft {
  turnId: string;
  ordinal: number;
  nativeStatus: ReaderTurnStatus;
  startedAt: number | null;
  endedAt: number | null;
  /** 起点记录定位；跨扫描只见到终态时退化为终态记录。 */
  sourceByteStart: number | null;
  sourceRecordHash: string | null;
  sourceLocatorKind: ReaderSourceLocatorKind | null;
}

export interface AnomalyDraft {
  kind: string;
  detail: string;
  byteOffset: number;
}

export interface ParseOutcome {
  /** 文件内最后出现的 session（rollout 追加语义：后续记录归它），无 session_meta 时为 null。 */
  sessionId: string | null;
  /** 文件内按首现顺序排列的全部 session 草稿（一个文件可能包含会话切换）。 */
  sessions: SessionDraft[];
  turns: ThreadTurnDraft[];
  evidence: ThreadEvidenceDraft[];
  anomalies: AnomalyDraft[];
  lineage: Array<{ threadId: string; parentThreadId: string; relation: "fork" | "subagent" }>;
  lastOrdinal: number | null;
}

const timestampOf = (raw: unknown): number | null => {
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
};

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
};

const durationMsOf = (value: unknown): number | null => {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null) {
    const { secs, nanos } = value as { secs?: unknown; nanos?: unknown };
    if (typeof secs === "number") {
      return secs * 1000 + (typeof nanos === "number" ? Math.floor(nanos / 1e6) : 0);
    }
  }
  return null;
};

const parseUsage = (value: unknown): Record<string, number> | null => {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number | null =>
    typeof raw[key] === "number" ? (raw[key] as number) : null;
  const input = num("input_tokens");
  const output = num("output_tokens");
  const total = num("total_tokens") ?? (input !== null && output !== null ? input + output : null);
  if (input === null || output === null || total === null) return null;
  return {
    inputTokens: input,
    cachedInputTokens: num("cached_input_tokens") ?? 0,
    outputTokens: output,
    reasoningOutputTokens: num("reasoning_output_tokens") ?? 0,
    totalTokens: total,
  };
};

const subagentParentOf = (payload: Record<string, unknown>): string | null => {
  const source = payload.source;
  if (typeof source !== "object" || source === null) return null;
  const spawn = (source as Record<string, unknown>).subagent;
  if (typeof spawn !== "object" || spawn === null) return null;
  // 真机形状：source.subagent.thread_spawn.parent_thread_id
  const threadSpawn = (spawn as Record<string, unknown>).thread_spawn;
  const holder =
    typeof threadSpawn === "object" && threadSpawn !== null
      ? (threadSpawn as Record<string, unknown>)
      : (spawn as Record<string, unknown>);
  const parent = holder.parent_thread_id;
  return typeof parent === "string" ? parent : null;
};

interface SegmentTurn {
  turnId: string;
  ownerThreadId: string;
  startOrdinal: number;
  startByte: number;
  nativeStatus: ReaderTurnStatus;
  startedAt: number | null;
  endedAt: number | null;
}

interface ItemResult {
  evidence: ThreadEvidenceDraft;
  title: string | null;
}

/** 解析一段（增量或全量）完整换行记录。嵌入的子代理段内 turn/item 不进入主 thread turn 序列。 */
export const parseRecords = (records: readonly RawRecord[], state: ParseState): ParseOutcome => {
  const out: ParseOutcome = {
    sessionId: null,
    sessions: [],
    turns: [],
    evidence: [],
    anomalies: [],
    lineage: [],
    lastOrdinal: null,
  };
  // 一个 rollout 文件可能在中途切换 session（resume/fork 落进同一文件）：
  // 每条记录归属「最近一次 session_meta」的 thread，turn ordinal 按 thread 独立分配
  interface SessionAcc extends SessionDraft {
    openTurns: Set<string>;
    lastTerminal: ReaderTurnStatus | null;
    sawTurn: boolean;
  }
  const sessions = new Map<string, SessionAcc>();
  const ordinalsByThread = new Map<string, Map<string, number>>();
  for (const [threadId, turns0] of state.knownTurns) ordinalsByThread.set(threadId, new Map(turns0));
  const nextOrdinalByThread = new Map(state.nextTurnOrdinal);
  const openTurnsByThread = new Map<string, Set<string>>();
  for (const [threadId, ids] of state.openTurnIds) openTurnsByThread.set(threadId, new Set(ids));
  const segmentTurns = new Map<string, SegmentTurn>();
  const turnsWithUsage = new Set<string>([]);
  const turns = new Map<string, ThreadTurnDraft>();
  let nextOrdinal = state.nextOrdinal;
  let segmentActive = false;
  let current: SessionAcc | null = null;

  // 增量窗口播种：先以尾部 session 建立归属锚点；窗口内 session_meta 再现时复用同一 accumulator
  // （openTurns 延续 state 的跨轮集合），cwd/title 仍按 meta 与 item 事件填充
  const tailSessionId = state.tailSessionId ?? null;
  if (tailSessionId !== null) {
    current = {
      sessionId: tailSessionId,
      isSubagentThread: false,
      title: null,
      cwd: null,
      nativeGroup: null,
      metaByteStart: null,
      metaRecordHash: null,
      lastActivityAt: null,
      nativeStatus: null,
      compacted: null,
      openTurns: new Set(openTurnsByThread.get(tailSessionId) ?? []),
      lastTerminal: null,
      sawTurn: false,
    };
    sessions.set(tailSessionId, current);
  }

  const ordinalsOf = (threadId: string): Map<string, number> => {
    let map = ordinalsByThread.get(threadId);
    if (map === undefined) {
      map = new Map();
      ordinalsByThread.set(threadId, map);
    }
    return map;
  };

  const openTurnsOf = (threadId: string): Set<string> => {
    let set = openTurnsByThread.get(threadId);
    if (set === undefined) {
      set = new Set();
      openTurnsByThread.set(threadId, set);
    }
    return set;
  };

  const ordinalOf = (threadId: string, turnId: string): number => {
    const map = ordinalsOf(threadId);
    const known = map.get(turnId);
    if (known !== undefined) return known;
    const assigned = nextOrdinalByThread.get(threadId) ?? 0;
    nextOrdinalByThread.set(threadId, assigned + 1);
    map.set(turnId, assigned);
    return assigned;
  };

  const ensureMainTurn = (threadId: string, turnId: string): ThreadTurnDraft => {
    const existing = turns.get(turnId);
    if (existing !== undefined) return existing;
    const draft: ThreadTurnDraft = {
      threadId,
      turnId,
      ordinal: ordinalOf(threadId, turnId),
      nativeStatus: "running",
      startedAt: null,
      endedAt: null,
      sourceByteStart: null,
      sourceRecordHash: null,
      sourceLocatorKind: null,
    };
    turns.set(turnId, draft);
    return draft;
  };

  for (const { line, byteStart } of records) {
    const hash = recordHashOf(line);
    let record: { type?: unknown; ordinal?: unknown; timestamp?: unknown; payload?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      out.anomalies.push({
        kind: "bad_line",
        detail: redactExcerpt(line.trim(), 160),
        byteOffset: byteStart,
      });
      continue;
    }
    const ts = timestampOf(record.timestamp);
    if (ts !== null) {
      if (current === null) {
        for (const session of sessions.values()) {
          if (session.lastActivityAt === null || ts > session.lastActivityAt) session.lastActivityAt = ts;
        }
      } else if (current.lastActivityAt === null || ts > current.lastActivityAt) {
        current.lastActivityAt = ts;
      }
    }
    if (typeof record.ordinal === "number") {
      const ordinal = record.ordinal;
      if (nextOrdinal !== null && ordinal < nextOrdinal) continue; // 已消费区域的回放，防御性跳过
      if (nextOrdinal !== null && ordinal > nextOrdinal) {
        out.anomalies.push({
          kind: "ordinal_gap",
          detail: `expected ordinal ${nextOrdinal}, got ${ordinal}`,
          byteOffset: byteStart,
        });
      }
      nextOrdinal = ordinal + 1;
    }

    const payload = (typeof record.payload === "object" && record.payload !== null
      ? record.payload
      : {}) as Record<string, unknown>;
    const recordType = typeof record.type === "string" ? record.type : "";

    if (recordType === "session_meta") {
      const sessionId =
        typeof payload.session_id === "string"
          ? payload.session_id
          : typeof payload.id === "string"
            ? payload.id
            : null;
      const parentId =
        typeof payload.parent_thread_id === "string" ? payload.parent_thread_id : subagentParentOf(payload);
      const isSubagentThread = payload.thread_source === "subagent" || subagentParentOf(payload) !== null;
      if (sessionId !== null) {
        const existing = sessions.get(sessionId);
        current =
          existing ??
          ({
            sessionId,
            isSubagentThread,
            title: null,
            cwd: typeof payload.cwd === "string" ? payload.cwd : null,
            nativeGroup: typeof payload.thread_source === "string" ? payload.thread_source : null,
            metaByteStart: byteStart,
            metaRecordHash: hash,
            lastActivityAt: ts,
            nativeStatus: null,
            compacted: null,
            openTurns: new Set(openTurnsByThread.get(sessionId) ?? []),
            lastTerminal: null,
            sawTurn: false,
          });
        if (existing !== undefined) {
          // 尾部 session 播种条目先于 meta 到达：meta 才是 cwd/来源的权威，回填（增量窗口复现 meta 时同样适用）
          if (existing.cwd === null && typeof payload.cwd === "string") existing.cwd = payload.cwd;
          if (!existing.isSubagentThread && isSubagentThread) existing.isSubagentThread = true;
          if (existing.nativeGroup === null && typeof payload.thread_source === "string") {
            existing.nativeGroup = payload.thread_source;
          }
          existing.metaByteStart = byteStart;
          existing.metaRecordHash = hash;
        }
        sessions.set(sessionId, current);
        out.sessionId = sessionId;
        if (existing === undefined && parentId !== null) {
          out.lineage.push({
            threadId: sessionId,
            parentThreadId: parentId,
            relation: isSubagentThread ? "subagent" : "fork",
          });
        }
      }
      // 会话切换：此后的记录归新 session，嵌入段作废
      segmentActive = false;
      continue;
    }

    // session_meta 之前的内容无法归属 thread（真机 rollout 的 meta 恒为第一条）；防御性跳过
    if (current === null) continue;
    const threadId = current.sessionId;

    if (recordType === "response_item" || recordType === "world_state" || recordType === "retained_context") {
      // response_item 是模型上下文副本（含 developer/system 指令），可见内容一律以 event_msg 项为准
      continue;
    }

    if (recordType === "compacted") {
      if (typeof payload.message === "string") {
        const currentTurns = [...turns.values()].filter((turn) => turn.threadId === threadId);
        const coverageOrdinals = currentTurns.map((turn) => turn.ordinal);
        const persistedCoverage = state.coveredThroughTurnOrdinalByThread.get(threadId);
        if (persistedCoverage !== undefined) coverageOrdinals.push(persistedCoverage);
        current.compacted = {
          text: redactExcerpt(payload.message, COMPACTED_SUMMARY_CHARS),
          recordHash: hash,
          byteStart,
          coveredThroughTurnOrdinal:
            coverageOrdinals.length === 0 ? null : Math.max(...coverageOrdinals),
        };
      }
      continue;
    }

    if (recordType === "turn_context") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      const collaboration = (payload.collaboration_mode ?? null) as Record<string, unknown> | null;
      const settings = collaboration?.settings as Record<string, unknown> | undefined;
      const effort = (settings?.reasoning_effort ?? payload.effort) as unknown;
      out.evidence.push({
        threadId,
        byteStart,
        recordHash: hash,
        turnOrdinal: turnId === null ? null : (ordinalsOf(threadId).get(turnId) ?? null),
        kind: "turn_context",
        summary: null,
        props: {
          ...(turnId !== null ? { turnId } : {}),
          model: typeof payload.model === "string" ? payload.model : null,
          effort: typeof effort === "string" ? effort : null,
          cwd: typeof payload.cwd === "string" ? payload.cwd : null,
          approvalPolicy: typeof payload.approval_policy === "string" ? payload.approval_policy : null,
        },
      });
      continue;
    }

    if (recordType === "token_usage_record") {
      const usage = parseUsage(payload.usage) ?? parseUsage(payload.turn_token_usage);
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      if (usage !== null) {
        if (turnId !== null) turnsWithUsage.add(turnId);
        out.evidence.push({
          threadId,
          byteStart,
          recordHash: hash,
          turnOrdinal: turnId === null ? null : (ordinalsOf(threadId).get(turnId) ?? null),
          kind: "token_usage",
          summary: null,
          props: { ...(turnId !== null ? { turnId } : {}), ...usage },
        });
      }
      continue;
    }

    if (recordType === "event_msg") {
      const eventType = typeof payload.type === "string" ? payload.type : "";
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;

      if (eventType === "task_started") {
        const attribution = (payload.turn_attribution ?? null) as Record<string, unknown> | null;
        const isSubagentTurn =
          (typeof attribution?.initiating_agent_path === "string" && attribution.initiating_agent_path !== "") ||
          attribution?.turn_trigger === "subagent";
        if (isSubagentTurn && !current.isSubagentThread) {
          // 子代理历史段起点：段内 turn/item 按 start ordinal 隔离归属
          segmentActive = true;
          if (turnId !== null && !segmentTurns.has(turnId)) {
            segmentTurns.set(turnId, {
              turnId,
              ownerThreadId: threadId,
              startOrdinal: typeof record.ordinal === "number" ? record.ordinal : byteStart,
              startByte: byteStart,
              nativeStatus: "running",
              startedAt: ts,
              endedAt: null,
            });
          }
          continue;
        }
        // 主线程 turn 开始：此后记录归主线程，嵌入段结束
        segmentActive = false;
        if (turnId !== null) {
          const draft = ensureMainTurn(threadId, turnId);
          draft.nativeStatus = "running";
          if (draft.startedAt === null) draft.startedAt = ts;
          if (draft.sourceByteStart === null) {
            draft.sourceByteStart = byteStart;
            draft.sourceRecordHash = hash;
            draft.sourceLocatorKind = "start";
          }
          openTurnsOf(threadId).add(turnId);
          current.sawTurn = true;
        }
        continue;
      }

      const isSegmentTurn = turnId !== null && segmentTurns.has(turnId);
      if (eventType === "task_complete" || eventType === "turn_aborted" || eventType === "error") {
        const status: ReaderTurnStatus =
          eventType === "task_complete" ? "completed" : eventType === "turn_aborted" ? "interrupted" : "failed";
        if (isSegmentTurn) {
          const segment = segmentTurns.get(turnId)!;
          segment.nativeStatus = status;
          segment.endedAt = ts;
        } else if (turnId !== null && ordinalsOf(threadId).has(turnId)) {
          // 只认已知主 turn 的终局：跨扫描嵌入段的收口（本窗口没有它的 task_started）不得
          // 臆造成主 thread turn 注入主序列
          const draft = ensureMainTurn(threadId, turnId);
          draft.nativeStatus = status;
          draft.endedAt = ts;
          if (draft.sourceByteStart === null) {
            draft.sourceByteStart = byteStart;
            draft.sourceRecordHash = hash;
            draft.sourceLocatorKind = "terminal";
          }
          // 跨扫描打开的 turn 在本窗口收口也算 turn 事件：否则 sawTurn 保持 false，
          // nativeStatus 判 null 经 COALESCE 永远保住陈旧 running
          if (openTurnsOf(threadId).delete(turnId)) current.sawTurn = true;
          current.lastTerminal = status;
        }
        if (eventType === "error") {
          const message = typeof payload.message === "string" ? payload.message : "unknown error";
          out.evidence.push({
            threadId,
            byteStart,
            recordHash: hash,
            turnOrdinal: turnId === null ? null : (ordinalsOf(threadId).get(turnId) ?? null),
            kind: "turn_error",
            summary: redactExcerpt(message, MESSAGE_EXCERPT_CHARS),
            props: { ...(turnId !== null ? { turnId } : {}) },
          });
        }
        continue;
      }

      if (eventType === "item_completed") {
        const item = (payload.item ?? null) as Record<string, unknown> | null;
        if (item !== null) {
          const itemType = typeof item.type === "string" ? item.type : "unknown";
          const result = itemEvidence(itemType, item, byteStart, hash, {
            threadId,
            turnId,
            turnOrdinal: turnId === null ? null : (ordinalsOf(threadId).get(turnId) ?? null),
            inSegment: isSegmentTurn,
            segment: isSegmentTurn ? segmentTurns.get(turnId)! : null,
          });
          if (result.title !== null && current.title === null) current.title = result.title;
          out.evidence.push(result.evidence);
        }
        continue;
      }

      if (eventType === "token_count") {
        // token_usage_record 缺席时的兜底；已有 usage 的 turn 不重复入库
        const info = (payload.info ?? null) as Record<string, unknown> | null;
        const usage = parseUsage(info?.last_token_usage);
        if (usage !== null && (turnId === null || !turnsWithUsage.has(turnId))) {
          out.evidence.push({
            threadId,
            byteStart,
            recordHash: hash,
            turnOrdinal: turnId === null ? null : (ordinalsOf(threadId).get(turnId) ?? null),
            kind: "token_usage",
            summary: null,
            props: { ...(turnId !== null ? { turnId } : {}), ...usage },
          });
        }
        continue;
      }

      // 真机已知但不产生证据的 event_msg 变体（设置快照/goal 生命周期）：跳过，不算异常
      if (eventType === "thread_settings_applied" || eventType.startsWith("thread_goal_")) {
        continue;
      }
      // 未知 event_msg 变体：记 anomaly 并推进（单条异常不阻塞后续内容）
      out.anomalies.push({
        kind: "unknown_event",
        detail: `event_msg/${eventType}`,
        byteOffset: byteStart,
      });
      continue;
    }

    out.anomalies.push({
      kind: "unknown_type",
      // 类型名是结构标识不是内容，不脱敏（截断即可），方便定位 parser 缺口
      detail: recordType.slice(0, 120),
      byteOffset: byteStart,
    });
  }

  // 嵌入段 turn 不进主 thread turn 序列：以 subagent_turn 证据落库并标注起始 ordinal。
  // 归属按段打开时的 session：文件中途切会话后收口的段不跟随新 current
  for (const segment of segmentTurns.values()) {
    out.evidence.push({
      threadId: segment.ownerThreadId,
      byteStart: segment.startByte,
      recordHash: `subagent-turn:${segment.turnId}`,
      turnOrdinal: null,
      kind: "subagent_turn",
      summary: null,
      props: {
        turnId: segment.turnId,
        nativeStatus: segment.nativeStatus,
        startOrdinal: segment.startOrdinal,
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
      },
    });
  }

  out.turns = [...turns.values()];
  // 同一轮内先于 task_started 落到的上下文/usage/error 证据：turn 此刻已定型则回填 ordinal，
  // 否则永久脱钩 turn（「第 N 轮」徽标与按轮 usage 汇总缺失）
  for (const item of out.evidence) {
    if (item.turnOrdinal !== null || item.kind === "subagent_turn") continue;
    const backfillTurnId = item.props?.turnId;
    if (typeof backfillTurnId !== "string") continue;
    const draft = turns.get(backfillTurnId);
    if (draft !== undefined) item.turnOrdinal = draft.ordinal;
  }
  out.lastOrdinal = nextOrdinal === null ? null : nextOrdinal - 1;
  out.sessions = [...sessions.values()].map((session) => {
    const openTurns = openTurnsByThread.get(session.sessionId) ?? session.openTurns;
    // 本轮没有 turn 事件且无跨轮 open turn 时置 null：scanner 经 COALESCE 保留库内既有原生状态
    let nativeStatus: SessionDraft["nativeStatus"] = null;
    if (openTurns.size > 0) nativeStatus = "running";
    else if (session.sawTurn) nativeStatus = session.lastTerminal ?? "idle";
    return {
      sessionId: session.sessionId,
      isSubagentThread: session.isSubagentThread,
      title: session.title,
      cwd: session.cwd,
      nativeGroup: session.nativeGroup,
      metaByteStart: session.metaByteStart,
      metaRecordHash: session.metaRecordHash,
      lastActivityAt: session.lastActivityAt,
      nativeStatus,
      compacted: session.compacted,
    };
  });
  return out;
};

interface ItemContext {
  threadId: string;
  turnId: string | null;
  turnOrdinal: number | null;
  inSegment: boolean;
  segment: SegmentTurn | null;
}

const itemEvidence = (
  itemType: string,
  item: Record<string, unknown>,
  byteStart: number,
  hash: string,
  ctx: ItemContext,
): ItemResult => {
  const base = {
    threadId: ctx.threadId,
    byteStart,
    recordHash: hash,
    turnOrdinal: ctx.inSegment ? null : ctx.turnOrdinal,
  };
  const subagentProps = ctx.inSegment
    ? { subagent: { turnId: ctx.turnId, startOrdinal: ctx.segment?.startOrdinal ?? null } }
    : {};
  const build = (
    kind: string,
    summary: string | null,
    props: Record<string, unknown> | null,
  ): ItemResult => ({
    evidence: { ...base, kind, summary, props: { ...subagentProps, ...props } },
    title: null,
  });

  switch (itemType) {
    case "UserMessage": {
      const text = redactExcerpt(textOfContent(item.content), MESSAGE_EXCERPT_CHARS);
      return {
        evidence: { ...base, kind: "message", summary: text, props: { ...subagentProps, role: "user" } },
        title: text,
      };
    }
    case "AgentMessage": {
      const phase = typeof item.phase === "string" ? item.phase : null;
      return build("message", redactExcerpt(textOfContent(item.content), MESSAGE_EXCERPT_CHARS), {
        role: "agent",
        ...(phase !== null ? { phase } : {}),
      });
    }
    case "Reasoning": {
      const summaries = Array.isArray(item.summary_text)
        ? item.summary_text.filter((entry): entry is string => typeof entry === "string")
        : [];
      // 只存 summary 或存在性；encrypted/raw content 永不入库（需求「证据持久化边界」）
      return summaries.length > 0
        ? build("reasoning", redactExcerpt(summaries.join(" "), MESSAGE_EXCERPT_CHARS), { present: true })
        : build("reasoning", null, { present: true });
    }
    case "CommandExecution": {
      const command = Array.isArray(item.command)
        ? item.command.filter((entry): entry is string => typeof entry === "string")
        : [];
      return build("tool", redactExcerpt(command.join(" "), MESSAGE_EXCERPT_CHARS), {
        tool: "exec",
        kind: "command",
        status: typeof item.status === "string" ? item.status : null,
        exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
        durationMs: durationMsOf(item.duration),
        cwd: typeof item.cwd === "string" ? redactExcerpt(item.cwd, 200) : null,
      });
    }
    case "McpToolCall": {
      const server = typeof item.server === "string" ? item.server : "?";
      const tool = typeof item.tool === "string" ? item.tool : "?";
      return build("tool", null, {
        tool: `${server}.${tool}`,
        kind: "mcp",
        status: typeof item.status === "string" ? item.status : null,
      });
    }
    case "WebSearch": {
      const action = item.action as Record<string, unknown> | undefined;
      const query =
        typeof item.query === "string" ? item.query : typeof action?.query === "string" ? action.query : "";
      return build("tool", query === "" ? null : redactExcerpt(query, MESSAGE_EXCERPT_CHARS), {
        tool: "web_search",
        kind: "web_search",
      });
    }
    case "FileChange": {
      const changes =
        typeof item.changes === "object" && item.changes !== null
          ? Object.entries(item.changes as Record<string, Record<string, unknown>>).map(([path, change]) => ({
              path: redactExcerpt(path, 200),
              changeType: typeof change.type === "string" ? change.type : "unknown",
            }))
          : [];
      // 只存路径与变更类型 + 统计摘要，不存 patch 全文
      return build("file_change", `${changes.length} file(s) changed`, { changes });
    }
    default:
      // 未知 item：opaque 元数据，永不作 turn 终态
      return build("opaque", null, { itemType, itemId: typeof item.id === "string" ? item.id : null });
  }
};
