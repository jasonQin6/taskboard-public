/**
 * Rollout 扫描器：递归发现 sessions/archived_sessions 下的 .jsonl/.jsonl.zst，
 * 增量读取（inode 主键、prefix/tail hash、截断与重写检测）并经 Store 事务入库。
 * 扫描对 Codex 存储只读；文件串行处理保证同 thread 多 source 的 turn ordinal 确定收敛。
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Store } from "../store/index.js";
import { CODEX_HARNESS_ID } from "../harness/ids.js";
import { PARSER_VERSION, parseRecords, recordHashOf, sourceIdFor, type ParseState, type RawRecord } from "./parse.js";
import { PREFIX_WINDOW, TAIL_WINDOW, openUnit, sha256Hex, splitCompleteLines } from "./read.js";

export type ReaderPhase = "idle" | "running" | "done";

export interface ReaderProgress {
  phase: ReaderPhase;
  filesTotal: number;
  filesDone: number;
  lastCompletedAt: string | null;
  /**
   * 逐文件最后失败的路径与原因（进度面对外诊断用；fileErrors 条目数有上界）。
   * 此前单文件失败只有 failed 计数，哪个文件/什么原因无处可查，坏文件每轮静默重试。
   */
  fileErrors: Array<{ path: string; message: string; at: string }>;
}

export interface ScanSummary {
  filesTotal: number;
  changed: number;
  skipped: number;
  failed: number;
  anomalies: number;
  expiredEvidence: number;
}

export interface RolloutReaderOptions {
  sessionsDir: string;
  archivedDir: string;
  /** adapter 提供的跨 Harness identity；缺省保留 Codex-first 兼容路径。 */
  harnessId?: string;
  /** 0 表示不启动周期扫描（测试直接调 scanNow）；daemon 缺省 30 秒。 */
  scanIntervalMs?: number;
  now?: () => number;
  /**
   * 本轮实际落库了 interrupted turn 的线程（去重，文件有变化才上报）。
   * A20 触发面：daemon 借此对已绑定线程自动触发一次 Jev 评估（消费评估状态里的待评估标记）。
   */
  onInterruptedTurns?: (threadIds: readonly string[]) => void;
}

interface DiscoveredFile {
  path: string;
  zst: boolean;
  inode: number;
  size: number;
  mtimeMs: number;
}

const SCAN_ROOTS = ["sessions", "archived_sessions"] as const;

/** fileErrors 的路径数上界：诊断用途，防止长期坏目录把进度对象撑爆。 */
const MAX_FILE_ERRORS = 20;

/** 集合等价签名只看 路径→原因：at 时间戳每轮失败都会刷新，进签名会造成永久假变化。 */
const fileErrorSignature = (errors: Map<string, { message: string; at: string }>): string =>
  [...errors].map(([path, entry]) => `${path}\u0000${entry.message}`).sort().join("\u0001");

interface Sliced {
  logicalSize: number;
  readSlice: (start: number, end: number) => Buffer;
}

export class RolloutReader {
  private phase: ReaderPhase = "idle";
  private filesTotal = 0;
  private filesDone = 0;
  private lastCompletedAt: string | null = null;
  private inFlight: Promise<ScanSummary> | null = null;
  private queued: Promise<ScanSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly intervalMs: number;
  private readonly harnessId: string;
  private readonly now: () => number;
  /** 路径 → 最后一次失败（插入序 = 最近失败序）；成功即删除，只留未自愈的。 */
  private readonly fileErrors = new Map<string, { message: string; at: string }>();

  constructor(
    private readonly store: Store,
    private readonly options: RolloutReaderOptions,
  ) {
    this.intervalMs = options.scanIntervalMs ?? 30_000;
    this.harnessId = options.harnessId ?? CODEX_HARNESS_ID;
    this.now = options.now ?? (() => Date.now());
  }

  /** 启动异步全量对账：daemon 就绪不等待扫描完成；之后按周期增量。 */
  start(): void {
    if (this.timer !== null) return;
    void this.scanNow().catch(() => undefined);
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.scanNow().catch(() => undefined);
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const pending = [this.inFlight, this.queued].filter((entry) => entry !== null);
    await Promise.all(pending.map((entry) => entry!.catch(() => undefined)));
  }

  progress(): ReaderProgress {
    // 最新的失败排最后；超出上界时丢最旧的（Map 迭代序 = 插入序，重新写入即挪到末尾）
    return {
      phase: this.phase,
      filesTotal: this.filesTotal,
      filesDone: this.filesDone,
      lastCompletedAt: this.lastCompletedAt,
      fileErrors: [...this.fileErrors.entries()]
        .slice(-MAX_FILE_ERRORS)
        .map(([path, entry]) => ({ path, message: entry.message, at: entry.at })),
    };
  }

  /**
   * 手动立即扫描（CLI refresh）。单飞：绝不并行扫同一目录；但扫描中途落盘的新文件
   * 在飞一轮看不到，因此 refresh 到达时若已有在飞扫描，紧随其后补扫一轮并等它完成。
   */
  async scanNow(): Promise<ScanSummary> {
    if (this.inFlight === null) {
      this.phase = "running";
      const pass = this.runPass()
        .then((summary) => {
          this.phase = "done";
          return summary;
        })
        .catch((error) => {
          this.phase = "idle";
          throw error;
        })
        .finally(() => {
          this.inFlight = null;
        });
      this.inFlight = pass;
      return pass;
    }
    if (this.queued === null) {
      this.queued = this.inFlight
        .then(
          () => {
            this.queued = null;
            return this.scanNow();
          },
          (error) => {
            this.queued = null;
            throw error;
          },
        );
    }
    return this.queued;
  }

  private async runPass(): Promise<ScanSummary> {
    const previousFileErrors = fileErrorSignature(this.fileErrors);
    const files = await this.discover();
    this.filesTotal = files.length;
    this.filesDone = 0;
    let changed = 0;
    let skipped = 0;
    let failed = 0;
    let anomalies = 0;
    const interruptedThreads = new Set<string>();
    for (const file of files) {
      if (this.stopped) break;
      try {
        const result = await this.processFile(file);
        if (result.changed) changed += 1;
        else skipped += 1;
        anomalies += result.anomalies;
        for (const threadId of result.interruptedThreadIds) interruptedThreads.add(threadId);
        // 成功即清除该路径的失败记录：fileErrors 只留当前仍未自愈的文件
        this.fileErrors.delete(file.path);
      } catch (error) {
        // 单文件失败不阻塞整轮；下一轮重试（游标未提交，重跑收敛）。
        // 路径与原因留痕 progress()——坏文件此前只有 failed 计数，无法诊断
        this.fileErrors.delete(file.path);
        this.fileErrors.set(file.path, {
          message: error instanceof Error ? error.message : String(error),
          at: new Date(this.now()).toISOString(),
        });
        failed += 1;
      }
      this.filesDone += 1;
    }
    if (interruptedThreads.size > 0) this.options.onInterruptedTurns?.([...interruptedThreads]);
    const settings = this.store.getSettings();
    const expiredEvidence = this.store.expireUnboundEvidence(
      this.now() - settings.retention.unboundEvidenceDays * 86_400_000,
    );
    // A32：已绑定 thread 的证据保留到 primary 任务归档后 boundEvidenceDays
    const expiredBoundEvidence = this.store.expireBoundEvidence(
      this.now() - settings.retention.boundEvidenceDays * 86_400_000,
    );
    // fileErrors 只活在 reader 内存：error-only 扫描不落库，集合变化时主动推 threads revision，
    // SSE 与 stateView 的记忆化缓存才看得到这份失败；无变化不推，避免每轮空转 revision
    if (fileErrorSignature(this.fileErrors) !== previousFileErrors) {
      this.store.write((touch) => touch("threads"));
    }
    this.lastCompletedAt = new Date(this.now()).toISOString();
    return {
      filesTotal: files.length,
      changed,
      skipped,
      failed,
      anomalies,
      expiredEvidence: expiredEvidence + expiredBoundEvidence,
    };
  }

  private async discover(): Promise<DiscoveredFile[]> {
    const roots = [this.options.sessionsDir, this.options.archivedDir];
    const found: DiscoveredFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在（如从未归档）按空处理
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const zst = entry.name.endsWith(".jsonl.zst");
        if (!zst && !entry.name.endsWith(".jsonl")) continue;
        try {
          const info = await stat(full);
          found.push({ path: full, zst, inode: info.ino, size: info.size, mtimeMs: info.mtimeMs });
        } catch {
          // stat 失败（竞态删除）跳过本轮
        }
      }
    };
    for (const root of roots) await walk(root);
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return found;
  }

  private async processFile(file: DiscoveredFile): Promise<{
    changed: boolean;
    anomalies: number;
    interruptedThreadIds: string[];
  }> {
    const known = this.store.readerSourceByInode(file.inode);
    const mtime = Math.round(file.mtimeMs);

    if (file.zst) {
      // 压缩件仅在 size 或 mtime 变化时重新解压读取（需求「增量与恢复」）
      if (
        known !== null &&
        known.parserVersion === PARSER_VERSION &&
        known.size === file.size &&
        known.mtime === mtime
      ) {
        if (known.path !== file.path) this.store.patchReaderSourcePath(known.sourceId, file.path);
        return { changed: false, anomalies: 0, interruptedThreadIds: [] };
      }
    }

    const unit = await openUnit(file.path, file.zst);
    try {
      const knownState = known ?? null;
      if (
        knownState !== null &&
        knownState.parserVersion === PARSER_VERSION &&
        unit.logicalSize === knownState.consumedBytes &&
        this.prefixMatches(unit, knownState.consumedBytes, knownState.prefixHash) &&
        this.tailMatches(unit, knownState.consumedBytes, knownState.tailHash)
      ) {
        // 无新增完整记录：只同步 path 属性（跨目录移动）
        if (knownState.path !== file.path) this.store.patchReaderSourcePath(knownState.sourceId, file.path);
        return { changed: false, anomalies: 0, interruptedThreadIds: [] };
      }

      const rewritten =
        knownState !== null &&
        (knownState.parserVersion !== PARSER_VERSION ||
          unit.logicalSize < knownState.consumedBytes ||
          !this.prefixMatches(unit, knownState.consumedBytes, knownState.prefixHash) ||
          !this.tailMatches(unit, knownState.consumedBytes, knownState.tailHash));

      const consumedFrom = rewritten || knownState === null ? 0 : knownState.consumedBytes;
      if (unit.logicalSize === consumedFrom) {
        if (knownState !== null && knownState.path !== file.path) {
          this.store.patchReaderSourcePath(knownState.sourceId, file.path);
        }
        return { changed: false, anomalies: 0, interruptedThreadIds: [] };
      }

      const region = unit.readSlice(consumedFrom, unit.logicalSize);
      const { records, completeBytes } = splitCompleteLines(region, consumedFrom);
      const consumedBytes = consumedFrom + completeBytes;

      const prefixHash = this.prefixHashOf(unit);
      let state = await this.parseStateFor(knownState, rewritten);
      let outcome = parseRecords(records, state);
      // 首轮 parse 拿到窗口内全部 session 后，把库内已有 turn 序列的 session（resume 链/中途切会话）
      // 的序状态合并进来重放：否则重放 turn 从 0 重编，撞 (thread_id, ordinal) UNIQUE 会让
      // 整个 source 提交失败且每轮重试永久卡死
      if (this.mergeKnownTurnState(state, outcome, rewritten ? null : knownState?.sourceId ?? null)) {
        outcome = parseRecords(records, state);
      }
      const sourceId =
        knownState?.sourceId ?? sourceIdFor(file.inode, prefixHash, outcome.sessionId ?? "");
      const tailHash = consumedBytes === 0 ? null : this.tailHashOf(unit, consumedBytes);

      const fallbackThread = outcome.sessionId ?? knownState?.threadId ?? "";
      this.store.commitSourceScan({
        source: {
          sourceId,
          path: file.path,
          // 追加语义：文件尾部的 session 拥有后续追加，游标行跟随它
          threadId: fallbackThread,
          inode: file.inode,
          size: file.size,
          mtime,
          consumedBytes,
          prefixHash,
          tailHash,
          nextOrdinal: outcome.lastOrdinal === null ? null : outcome.lastOrdinal + 1,
          parserVersion: PARSER_VERSION,
          rewritten,
        },
        threads: outcome.sessions.map((session) => ({
          id: session.sessionId,
          harnessId: this.harnessId,
          nativeSessionId: session.sessionId,
          nativeStatus: session.nativeStatus,
          title: session.title,
          workspace: session.cwd,
          nativeGroup: session.nativeGroup,
          sourcePath: file.path,
          sourceByteStart: session.metaByteStart,
          sourceRecordHash: session.metaRecordHash,
          lastActivityAt: session.lastActivityAt ?? this.now(),
        })),
        turns: outcome.turns.map((turn) => ({
          id: turn.turnId,
          threadId: turn.threadId,
          ordinal: turn.ordinal,
          nativeStatus: turn.nativeStatus,
          startedAt: turn.startedAt,
          endedAt: turn.endedAt,
          sourceRef: sourceId,
          sourceByteStart: turn.sourceByteStart,
          sourceRecordHash: turn.sourceRecordHash,
          sourceLocatorKind: turn.sourceLocatorKind,
        })),
        evidence: outcome.evidence.map((item) => ({
          threadId: item.threadId,
          sourceId,
          byteStart: item.byteStart,
          recordHash: item.recordHash,
          turnOrdinal: item.turnOrdinal,
          kind: item.kind,
          summary: item.summary,
          props: item.props,
        })),
        supersedeEvidence: rewritten,
        rebuildTurns: rewritten,
        anomalies: outcome.anomalies.map((anomaly) => ({ sourceId, ...anomaly })),
        resolveAnomalies: rewritten,
        summaries: outcome.sessions
          .filter((session) => session.compacted !== null)
          .map((session) => ({
            threadId: session.sessionId,
            text: session.compacted!.text,
            sourceRef: session.compacted!.recordHash,
            byteStart: session.compacted!.byteStart,
            recordHash: session.compacted!.recordHash,
            coveredThroughTurnOrdinal: session.compacted!.coveredThroughTurnOrdinal,
          })),
        lineage: outcome.lineage,
      });
      return {
      changed: true,
      anomalies: outcome.anomalies.length,
      interruptedThreadIds: outcome.turns
        .filter((turn) => turn.nativeStatus === "interrupted")
        .map((turn) => turn.threadId),
    };
    } finally {
      await unit.close();
    }
  }

  private prefixMatches(unit: Sliced, consumed: number, prefixHash: string): boolean {
    if (consumed === 0) return true;
    return this.prefixHashOf(unit) === prefixHash;
  }

  private prefixHashOf(unit: Sliced): string {
    const end = Math.min(PREFIX_WINDOW, unit.logicalSize);
    return sha256Hex(unit.readSlice(0, end));
  }

  private tailMatches(unit: Sliced, consumed: number, tailHash: string | null): boolean {
    if (tailHash === null) return true;
    return this.tailHashOf(unit, consumed) === tailHash;
  }

  private tailHashOf(unit: Sliced, consumed: number): string {
    const start = Math.max(0, consumed - TAIL_WINDOW);
    return sha256Hex(unit.readSlice(start, consumed));
  }

  private async parseStateFor(
    known: { sourceId: string; threadId: string; nextOrdinal: number | null } | null,
    rewritten: boolean,
  ): Promise<ParseState> {
    if (known === null || known.threadId === "") {
      return {
        knownTurns: new Map(),
        nextTurnOrdinal: new Map(),
        openTurnIds: new Map(),
        nextOrdinal: null,
        coveredThroughTurnOrdinalByThread: new Map(),
        tailSessionId: null,
      };
    }
    // knownTurns 取整条 thread（含其他 source 的 turn）：重写重放的历史 turn 依此映射回原 ordinal，
    // 避免与并发 source 的 turn 序列冲突；本轮新增 turn 从 max+1 继续
    const persistedCoverage = rewritten ? null : this.maxTurnOrdinalForSource(known.threadId, known.sourceId);
    return {
      ...this.threadTurnState(known.threadId),
      nextOrdinal: rewritten ? null : known.nextOrdinal,
      coveredThroughTurnOrdinalByThread:
        persistedCoverage === null ? new Map() : new Map([[known.threadId, persistedCoverage]]),
      tailSessionId: known.threadId,
    };
  }

  private maxTurnOrdinalForSource(threadId: string, sourceId: string): number | null {
    let max = -1;
    for (const turn of this.store.listThreadTurns(threadId)) {
      if (turn.sourceRef === sourceId && turn.ordinal > max) max = turn.ordinal;
    }
    return max < 0 ? null : max;
  }

  private threadTurnState(threadId: string): Pick<ParseState, "knownTurns" | "nextTurnOrdinal" | "openTurnIds"> {
    const knownTurns = new Map<string, number>();
    let maxOrdinal = -1;
    const openTurnIds = new Set<string>();
    for (const turn of this.store.listThreadTurns(threadId)) {
      knownTurns.set(turn.id, turn.ordinal);
      if (turn.ordinal > maxOrdinal) maxOrdinal = turn.ordinal;
      if (turn.nativeStatus === "running") openTurnIds.add(turn.id);
    }
    return {
      knownTurns: new Map([[threadId, knownTurns]]),
      nextTurnOrdinal: new Map([[threadId, maxOrdinal + 1]]),
      openTurnIds: new Map([[threadId, openTurnIds]]),
    };
  }

  /** 把 outcome 内库中已有 turn 的 session 的序状态合并进 state；有合并则需重放。 */
  private mergeKnownTurnState(
    state: ParseState,
    outcome: { sessions: Array<{ sessionId: string }> },
    sourceId: string | null,
  ): boolean {
    let merged = false;
    for (const session of outcome.sessions) {
      const threadId = session.sessionId;
      if (threadId === "" || state.knownTurns.has(threadId)) continue;
      if (this.store.listThreadTurns(threadId).length === 0) continue;
      const one = this.threadTurnState(threadId);
      for (const [id, turns0] of one.knownTurns) state.knownTurns.set(id, turns0);
      for (const [id, next] of one.nextTurnOrdinal) state.nextTurnOrdinal.set(id, next);
      for (const [id, ids] of one.openTurnIds) state.openTurnIds.set(id, ids);
      if (sourceId !== null) {
        const coverage = this.maxTurnOrdinalForSource(threadId, sourceId);
        if (coverage !== null) {
          const existing = state.coveredThroughTurnOrdinalByThread.get(threadId);
          state.coveredThroughTurnOrdinalByThread = new Map(state.coveredThroughTurnOrdinalByThread).set(
            threadId,
            existing === undefined ? coverage : Math.max(existing, coverage),
          );
        }
      }
      merged = true;
    }
    return merged;
  }
}

/** 便于测试与调试：逐行构造原始记录（不落盘）。 */
export const rawRecordsOf = (lines: readonly string[]): RawRecord[] =>
  lines.map((line, index) => ({ line, byteStart: index * (line.length + 1) }));

/** 记录 hash 的公开别名（测试断言 evidence.recordHash 用）。 */
export const hashLine = recordHashOf;
