/**
 * ZCode 只读 adapter：源是 ~/.zcode/cli/db/db.sqlite（权威 SQLite，WAL 模式），
 * 与 Codex rollout JSONL 不同，源单位是「整个库」而非文件流。因此游标语义挪用为
 * 逻辑水位（max(time_updated) + 行数指纹）：水位一致即跳过重扫，不一致全量幂等
 * upsert——SQLite 源没有「只读新增尾部」的增量窗口，全量重放是最诚实的读法。
 *
 * 会话状态口径与 Codex reader 对齐（parse.ts 终局判定）：
 * 最新 assistant 消息缺 time.completed → running（等价 open turn）；
 * 否则最近 turn 终态原样保留（completed/error→failed/cancelled→interrupted）；
 * 无 turn → null（经 applyScan COALESCE 保留库内既有，新会话落 unknown）。
 */

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store, SourceScanPatch } from "../../store/index.js";
import type { ReaderSourceView } from "../../store/index.js";
import type {
  CapabilityManifest,
  Failure,
  HarnessAdapter,
  HarnessObservation,
  HarnessScanProgress,
  SessionSnapshot,
} from "../contract.js";
import {
  openZcodeDbReadOnly,
  probeZcodeSchema,
  zcodeSchemaVersion,
  type ZcodeSchemaProbe,
} from "./probe.js";

export const ZCODE_HARNESS_ID = "zcode";
/** 映射逻辑版本：状态推导或 ordinal 规则变化时 +1，触发全量重扫收敛。 */
export const ZCODE_MAPPER_VERSION = 1;
export const ZCODE_DEFAULT_DB_PATH = join(homedir(), ".zcode", "cli", "db", "db.sqlite");

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

export interface ZcodeAdapterOptions {
  dbPath?: string;
  /** 周期扫描间隔;0 表示不周期自驱动(start 仍立即扫一轮,测试直接调 scanNow)。 */
  scanIntervalMs?: number;
  now?: () => number;
}

/** scanNow 的轮次摘要(契约返回 unknown;HTTP scan.refresh 会把它 JSON 直出,保持可序列化)。 */
export interface ZcodeScanSummary {
  sessions: number;
  turns: number;
  anomalies: number;
  /** true = 水位指纹一致,本轮幂等跳过,未重放。 */
  skipped: boolean;
}

interface SessionRow {
  id: string;
  directory: string;
  title: string;
  task_type: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
  time_compacting: number | null;
  time_archived: number | null;
}

interface TurnRow {
  session_id: string;
  turn_id: string;
  status: string;
  started_at: number;
  completed_at: number | null;
}

interface LatestMessageRow {
  session_id: string;
  /** json_valid(data)：非法 JSON 行只废 running 判定并落 anomaly，不让整轮查询抛错 */
  valid: number;
  role: string | null;
  completed: number | null;
}

const TURN_STATUS_MAP: Readonly<Record<string, "completed" | "failed" | "interrupted">> = Object.freeze({
  completed: "completed",
  error: "failed",
  cancelled: "interrupted",
});

const sessionStatusOf = (
  latestMessage: LatestMessageRow | undefined,
  lastTerminal: "completed" | "failed" | "interrupted" | null,
): "running" | "completed" | "failed" | "interrupted" | null => {
  if (latestMessage !== undefined && latestMessage.role === "assistant" && latestMessage.completed === 0) {
    return "running";
  }
  return lastTerminal;
};

export class ZcodeAdapter implements HarnessAdapter {
  private readonly dbPath: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private probe: ZcodeSchemaProbe | null = null;
  private scanFailure: Failure | null = null;
  // 生命周期进度与 reader 同构(idle→running→done,意外异常回 idle);整库是单源单位,故 total 恒 1
  private phase: HarnessScanProgress["phase"] = "idle";
  private filesTotal = 0;
  private filesDone = 0;
  private lastCompletedAt: string | null = null;
  private inFlight: Promise<ZcodeScanSummary> | null = null;

  constructor(
    private readonly store: Store,
    options: ZcodeAdapterOptions = {},
  ) {
    this.dbPath = options.dbPath ?? ZCODE_DEFAULT_DB_PATH;
    this.intervalMs = options.scanIntervalMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  capabilityManifest(): CapabilityManifest {
    // summary.read/evidence.read 不列：本机实测库中无可识别的原生 compaction 摘要记录
    // （time_compacting 全空、message 无 summary 形态），列出即是谎报能力
    return {
      harnessId: ZCODE_HARNESS_ID,
      displayName: "ZCode",
      schemaVersion: this.probe === null ? "zcode-sqlite/unprobed" : zcodeSchemaVersion(this.probe),
      readOnly: true,
      capabilities: ["session.list", "turn.read"],
      readPaths: ["$ZCODE_HOME/cli/db/db.sqlite"],
      degradations: ["source_unreadable", "unknown_native_status"],
    };
  }

  /** 摄取生命周期与 reader.start 同构:先立即扫一轮(daemon 可用不等待扫描完成),再按周期自驱动。 */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    void this.scanNow().catch(() => undefined);
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => void this.scanNow().catch(() => undefined), this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** 停轮并等在飞 pass 收敛:daemon 关停返回后,不允许再有本 adapter 的落库写入在途。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) await this.inFlight.catch(() => undefined);
  }

  progress(): HarnessScanProgress {
    return {
      phase: this.phase,
      filesTotal: this.filesTotal,
      filesDone: this.filesDone,
      lastCompletedAt: this.lastCompletedAt,
    };
  }

  /** 手动立即扫描。单飞:整库是一次快照读,没有「扫到一半新增文件」要补扫,并发调用共享在飞 pass。 */
  async scanNow(): Promise<ZcodeScanSummary> {
    // 与 start() 对称的 stopped 短路:stop() 返回后不允许再开新 pass 经 commitSourceScan 落库
    if (this.stopped) return { sessions: 0, turns: 0, anomalies: 0, skipped: false };
    if (this.inFlight !== null) return this.inFlight;
    this.phase = "running";
    const pass = this.runPass()
      .then((summary) => {
        this.phase = "done";
        return summary;
      })
      .catch((error) => {
        this.phase = "idle";
        // pass 级意外异常先落可观察失败再重抛:否则 start/周期轮吞掉 reject,
        // failures 恒空,轮轮白跑(scanSource 的 handled 路径要么 return 要么 scanFailure 仍为 null)
        this.scanFailure = {
          code: "adapter_failed",
          message: `zcode scan pass crashed: ${error instanceof Error ? error.message : String(error)}`,
          scope: { kind: "source", harnessId: ZCODE_HARNESS_ID, sourceId: this.dbPath },
          retryable: true,
        };
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = pass;
    return pass;
  }

  /**
   * 一轮 = 一个源单位(整库):源级失败(stat/open/probe)也计 done 并前移 lastCompletedAt,
   * 失败细节走 observe().failures(与 reader 逐文件口径同构);意外异常不前移进度,
   * 由 scanNow 回 idle 并重抛(时间戳只属于完整轮次)。
   */
  private async runPass(): Promise<ZcodeScanSummary> {
    this.filesTotal = 1;
    this.filesDone = 0;
    const summary = await this.scanSource();
    this.filesDone = 1;
    this.lastCompletedAt = new Date(this.now()).toISOString();
    return summary;
  }

  private async scanSource(): Promise<ZcodeScanSummary> {
    this.scanFailure = null;
    const sourceId = this.sourceId();
    let fileStat;
    try {
      fileStat = await stat(this.dbPath);
    } catch (error) {
      this.scanFailure = {
        code: "source_unreadable",
        message: `zcode db not readable: ${error instanceof Error ? error.message : String(error)}`,
        scope: { kind: "source", harnessId: ZCODE_HARNESS_ID, sourceId: this.dbPath },
        retryable: true,
      };
      return { sessions: 0, turns: 0, anomalies: 0, skipped: false };
    }
    let db;
    try {
      db = openZcodeDbReadOnly(this.dbPath);
    } catch (error) {
      this.scanFailure = {
        code: "source_unreadable",
        message: `zcode db open failed (readOnly): ${error instanceof Error ? error.message : String(error)}`,
        scope: { kind: "source", harnessId: ZCODE_HARNESS_ID, sourceId: this.dbPath },
        retryable: true,
      };
      return { sessions: 0, turns: 0, anomalies: 0, skipped: false };
    }
    try {
      const probe = probeZcodeSchema(db);
      this.probe = probe;
      if (!probe.ok) {
        // schema 漂移对本版本 adapter 是确定性失败:重试无意义,等 adapter 升级
        this.scanFailure = {
          code: "source_unreadable",
          message: `zcode schema mismatch, missing: ${probe.missing.join(", ")}`,
          scope: { kind: "source", harnessId: ZCODE_HARNESS_ID, sourceId: this.dbPath },
          retryable: false,
        };
        return { sessions: 0, turns: 0, anomalies: 0, skipped: false };
      }

      const sessions = db
        .prepare(
          "SELECT id, directory, title, task_type, parent_id, time_created, time_updated, " +
            "time_compacting, time_archived FROM session ORDER BY time_updated DESC, id",
        )
        .all() as unknown as SessionRow[];
      const turns = db
        .prepare("SELECT session_id, turn_id, status, started_at, completed_at FROM turn_usage")
        .all() as unknown as TurnRow[];
      // 最新消息只用于 running 判定（assistant 未收尾 = 正在产出）；窗口函数取每股一条。
      // json_valid 先行守卫：上游写坏的 data 不能让 json_extract 抛错拖死整轮扫描
      const latestMessages = db
        .prepare(
          "SELECT session_id, valid, " +
            "CASE WHEN valid = 1 THEN json_extract(data, '$.role') END AS role, " +
            "CASE WHEN valid = 1 THEN json_extract(data, '$.time.completed') IS NOT NULL ELSE 0 END AS completed " +
            "FROM (SELECT session_id, data, json_valid(data) AS valid, " +
            "ROW_NUMBER() OVER (PARTITION BY session_id " +
            "ORDER BY time_created DESC, id DESC) AS rn FROM message) WHERE rn = 1",
        )
        .all() as unknown as LatestMessageRow[];

      const watermark = sessions.reduce(
        (max, row) => (row.time_updated > max ? row.time_updated : max),
        0,
      );
      const fingerprint = `${sessions.length}|${turns.length}|${watermark}`;
      const known = this.knownSource(fileStat.ino);
      if (
        known !== null &&
        known.parserVersion === ZCODE_MAPPER_VERSION &&
        known.consumedBytes === watermark &&
        known.prefixHash === sha256(fingerprint)
      ) {
        return { sessions: 0, turns: 0, anomalies: 0, skipped: true };
      }

      const patch = this.buildPatch({
        sourceId,
        sessions,
        turns,
        latestMessages: new Map(latestMessages.map((row) => [row.session_id, row])),
        watermark,
        fingerprint,
        inode: fileStat.ino,
        size: fileStat.size,
        mtime: Math.round(fileStat.mtimeMs),
      });
      this.store.commitSourceScan(patch);
      return {
        sessions: patch.threads.length,
        turns: patch.turns.length,
        anomalies: patch.anomalies.length,
        skipped: false,
      };
    } finally {
      db.close();
    }
  }

  observe(): HarnessObservation {
    const failures: Failure[] = [];
    if (this.scanFailure !== null) failures.push(this.scanFailure);
    // 库源是「整库一个游标」：所有 zcode 会话共享该水位，不做 Codex 那种文件→会话归属
    const zcodeSource = this.store
      .listReaderSources()
      .find((source) => source.sourceId === this.sourceId());
    const sharedCursor =
      zcodeSource === undefined
        ? null
        : {
            sourceUnitId: zcodeSource.sourceId,
            contentPosition: zcodeSource.consumedBytes,
            prefixHash: zcodeSource.prefixHash,
            tailHash: zcodeSource.tailHash,
            parserVersion: zcodeSource.parserVersion,
          };
    const sessions: SessionSnapshot[] = [];
    for (const record of this.store.listObservedSessions(ZCODE_HARNESS_ID)) {
      const nativeSessionId = record.nativeSessionId ?? record.id;
      const unknownFields = [
        ...(record.title === null ? ["title"] : []),
        ...(record.workspace === null ? ["workspace"] : []),
        ...(record.nativeStatus === "unknown" ? ["nativeStatus"] : []),
        ...(record.nativeGroup === null ? ["nativeGroup"] : []),
      ];
      sessions.push({
        id: record.id,
        harnessId: ZCODE_HARNESS_ID,
        nativeSessionId,
        title: record.title,
        workspace: record.workspace,
        nativeStatus: record.nativeStatus === "running" ||
          record.nativeStatus === "idle" ||
          record.nativeStatus === "completed" ||
          record.nativeStatus === "failed" ||
          record.nativeStatus === "interrupted" ||
          record.nativeStatus === "held"
          ? record.nativeStatus
          : "unknown",
        lastActivityAt: iso(record.lastActivityAt),
        nativeGroup: record.nativeGroup,
        unknownFields,
        locator: {
          harnessId: ZCODE_HARNESS_ID,
          nativeSessionId,
          // SQLite 源没有「文件内字节位置」：定位到库文件与库内行的水位指纹
          sourcePath: record.sourcePath,
          byteStart: null,
          recordHash: record.sourceRecordHash,
        },
        cursor: sharedCursor,
        provenance: `zcode:sqlite@${ZCODE_MAPPER_VERSION}`,
      });
    }
    return { sessions, failures };
  }

  private sourceId(): string {
    // 路径派生而非 inode：ZCode 库文件重建会换 inode，路径才是稳定身份
    return `zcode-db:${sha256(this.dbPath).slice(0, 16)}`;
  }

  private knownSource(inode: number): ReaderSourceView | null {
    const known = this.store.readerSourceByInode(inode);
    if (known === null || known.sourceId !== this.sourceId()) {
      // inode 复用（他源文件顶替）时 known 指向他源：视为未知，全量扫
      return null;
    }
    return known;
  }

  private buildPatch(input: {
    sourceId: string;
    sessions: SessionRow[];
    turns: TurnRow[];
    latestMessages: Map<string, LatestMessageRow>;
    watermark: number;
    fingerprint: string;
    inode: number;
    size: number;
    mtime: number;
  }): SourceScanPatch {
    const threadIdOf = (sessionId: string): string => `zcode:${sessionId}`;
    const turnsBySession = new Map<string, TurnRow[]>();
    const anomalies: SourceScanPatch["anomalies"] = [];
    for (const turn of input.turns) {
      if (!(turn.status in TURN_STATUS_MAP)) {
        // 新状态值（上游新增）不猜测映射：降级为 anomaly，等 adapter 升级
        anomalies.push({
          sourceId: input.sourceId,
          kind: "unknown_turn_status",
          detail: `turn ${turn.turn_id} of ${turn.session_id} has unmapped status ${turn.status}`,
          byteOffset: 0,
        });
        continue;
      }
      const list = turnsBySession.get(turn.session_id);
      if (list === undefined) turnsBySession.set(turn.session_id, [turn]);
      else list.push(turn);
    }
    for (const list of turnsBySession.values()) {
      list.sort((a, b) => a.started_at - b.started_at || (a.turn_id < b.turn_id ? -1 : 1));
    }

    for (const [sessionId, message] of input.latestMessages) {
      if (message.valid === 0) {
        // 上游 message.data 非法 JSON：降级 anomaly 展示（宁保守不判 running），不阻塞其它会话
        anomalies.push({
          sourceId: input.sourceId,
          kind: "malformed_message_data",
          detail: `session ${sessionId} latest message data is not valid JSON; running detection degraded`,
          byteOffset: 0,
        });
      }
    }

    const sessionIds = new Set(input.sessions.map((row) => row.id));
    const patch: SourceScanPatch = {
      source: {
        sourceId: input.sourceId,
        path: this.dbPath,
        // 库源不属于单一会话；threadId 仅在 rebuild/supersede 分支使用，本源恒 false
        threadId: "",
        inode: input.inode,
        size: input.size,
        mtime: input.mtime,
        // 语义挪用：字节游标 → 逻辑水位（max time_updated），指纹一致即免重扫
        consumedBytes: input.watermark,
        prefixHash: sha256(input.fingerprint),
        tailHash: null,
        nextOrdinal: null,
        parserVersion: ZCODE_MAPPER_VERSION,
        rewritten: false,
      },
      threads: input.sessions.map((row) => {
        const turnsOfSession = turnsBySession.get(row.id);
        const lastTerminal =
          turnsOfSession === undefined || turnsOfSession.length === 0
            ? null
            : TURN_STATUS_MAP[turnsOfSession[turnsOfSession.length - 1]!.status]!;
        return {
          // ADR-0018：内部 id 带 harness 前缀，不假设 ZCode session id 与 Codex 天然不冲突
          id: threadIdOf(row.id),
          harnessId: ZCODE_HARNESS_ID,
          nativeSessionId: row.id,
          nativeStatus: sessionStatusOf(input.latestMessages.get(row.id), lastTerminal),
          // ZCode 的 title 列 NOT NULL：空串即「未设置标题」，投影回 null 走 unknown 降级
          title: row.title === "" ? null : row.title,
          workspace: row.directory,
          nativeGroup: row.task_type,
          sourcePath: this.dbPath,
          sourceByteStart: null,
          // 库内行的定位指纹：会话 id + 水位（源文件被重建后仍可对上库内身份）
          sourceRecordHash: sha256(`zcode-session:${row.id}:${input.watermark}`),
          lastActivityAt: row.time_updated,
        };
      }),
      turns: [...turnsBySession.entries()].flatMap(([sessionId, list]) =>
        list.map((turn, index) => ({
          id: `zcode-turn:${sessionId}:${turn.turn_id}`,
          threadId: threadIdOf(sessionId),
          ordinal: index,
          nativeStatus: TURN_STATUS_MAP[turn.status]!,
          startedAt: turn.started_at,
          endedAt: turn.completed_at,
          sourceRef: input.sourceId,
        })),
      ),
      evidence: [],
      supersedeEvidence: false,
      rebuildTurns: false,
      anomalies,
      resolveAnomalies: true,
      summaries: [],
      // fork 关系只在父子都被本次扫描看到时报：父会话不在库内（已清理）时避免挂悬空引用
      lineage: input.sessions
        .filter((row) => row.task_type === "fork" && row.parent_id !== null && sessionIds.has(row.parent_id))
        .map((row) => ({
          threadId: threadIdOf(row.id),
          parentThreadId: threadIdOf(row.parent_id!),
          relation: "fork",
        })),
    };
    return patch;
  }
}
