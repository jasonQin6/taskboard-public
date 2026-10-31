import { join } from "node:path";
import type { Store } from "../../store/index.js";
import { PARSER_VERSION } from "../../reader/parse.js";
import { RolloutReader, type RolloutReaderOptions } from "../../reader/scanner.js";
import type {
  CapabilityManifest,
  Failure,
  HarnessAdapter,
  HarnessObservation,
  HarnessScanProgress,
  SessionSnapshot,
  SourceLocator,
} from "../contract.js";
import { isThreadNativeStatus } from "../contract.js";
import { CODEX_HARNESS_ID } from "../ids.js";
export const CODEX_PROVENANCE = `codex:rollout-jsonl@${PARSER_VERSION}`;

/** post-stop 复触发的拒绝口径：零摘要内存短路，与 zcode adapter 的 stopped 短路对齐。 */
const ZERO_SCAN_SUMMARY = {
  filesTotal: 0,
  changed: 0,
  skipped: 0,
  failed: 0,
  anomalies: 0,
  expiredEvidence: 0,
};

export interface CodexAdapterOptions
  extends Omit<RolloutReaderOptions, "sessionsDir" | "archivedDir" | "harnessId"> {
  codexHome: string;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Codex adapter 只封装现有 rollout reader：扫描和解析仍由 src/reader/** 负责，
 * 这里补齐跨 Harness identity、provenance、SourceLocator 与未知字段降级。
 */
export class CodexAdapter implements HarnessAdapter {
  private readonly reader: RolloutReader;
  private stopped = false;

  constructor(
    private readonly store: Store,
    options: CodexAdapterOptions,
  ) {
    this.reader = new RolloutReader(store, {
      sessionsDir: join(options.codexHome, "sessions"),
      archivedDir: join(options.codexHome, "archived_sessions"),
      harnessId: CODEX_HARNESS_ID,
      ...(options.scanIntervalMs !== undefined ? { scanIntervalMs: options.scanIntervalMs } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.onInterruptedTurns !== undefined
        ? { onInterruptedTurns: options.onInterruptedTurns }
        : {}),
    });
  }

  capabilityManifest(): CapabilityManifest {
    return {
      harnessId: CODEX_HARNESS_ID,
      displayName: "Codex",
      schemaVersion: `codex-rollout/${PARSER_VERSION}`,
      readOnly: true,
      capabilities: ["session.list", "turn.read", "evidence.read", "summary.read"],
      readPaths: [
        "$CODEX_HOME/sessions/**/*.jsonl",
        "$CODEX_HOME/sessions/**/*.jsonl.zst",
        "$CODEX_HOME/archived_sessions/**/*.jsonl",
        "$CODEX_HOME/archived_sessions/**/*.jsonl.zst",
      ],
      degradations: ["source_unreadable", "source_locator_incomplete", "unknown_native_status"],
    };
  }

  /** 摄取生命周期转发：reader 仍是实际扫描器，对外只暴露 adapter 面。 */
  start(): void {
    // 关停是终态：重武装会让 daemon.close() 已收敛的资源重新落库（ADR-0014 关停顺序）。
    // reader 自身的 stopped 不阻断重扫尾部写入，故守卫必须落在 adapter 层。
    if (this.stopped) return;
    this.reader.start();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return this.reader.stop();
  }

  progress(): HarnessScanProgress {
    const { phase, filesTotal, filesDone, lastCompletedAt } = this.reader.progress();
    return { phase, filesTotal, filesDone, lastCompletedAt };
  }

  scanNow(): Promise<unknown> {
    // stop() 返回后拒绝复触发：内存短路零摘要，不伪造源级失败（fileErrors 只反映真实源失败）
    if (this.stopped) return Promise.resolve(ZERO_SCAN_SUMMARY);
    return this.reader.scanNow();
  }

  observe(): HarnessObservation {
    // 摄取由 reader 负责，observe 只读 store 投影；分组知识下沉 store 窗口查询，免每个新 adapter 抄一遍
    const latestSourceByThread = this.store.latestReaderSourceByThread();

    const sessions: SessionSnapshot[] = [];
    const failures: Failure[] = [];
    for (const record of this.store.listObservedSessions(CODEX_HARNESS_ID)) {
      const nativeSessionId = record.nativeSessionId ?? record.id;
      const nativeStatus = isThreadNativeStatus(record.nativeStatus) ? record.nativeStatus : "unknown";
      if (!isThreadNativeStatus(record.nativeStatus)) {
        failures.push({
          code: "unknown_native_status",
          message: `unknown Codex native status: ${record.nativeStatus}`,
          scope: { kind: "session", harnessId: CODEX_HARNESS_ID, nativeSessionId },
          retryable: false,
        });
      }
      const locator: SourceLocator = {
        harnessId: CODEX_HARNESS_ID,
        nativeSessionId,
        sourcePath: record.sourcePath,
        byteStart: record.sourceByteStart,
        recordHash: record.sourceRecordHash,
      };
      if (locator.sourcePath === null || locator.byteStart === null || locator.recordHash === null) {
        failures.push({
          code: "source_locator_incomplete",
          message: "Codex session locator lacks a source path, byte position, or record hash",
          scope: { kind: "session", harnessId: CODEX_HARNESS_ID, nativeSessionId },
          retryable: true,
        });
      }
      const latestSource = latestSourceByThread.get(record.id);
      const unknownFields = [
        ...(record.title === null ? ["title"] : []),
        ...(record.workspace === null ? ["workspace"] : []),
        ...(record.nativeStatus === "unknown" ? ["nativeStatus"] : []),
        ...(record.nativeGroup === null ? ["nativeGroup"] : []),
      ];
      sessions.push({
        id: record.id,
        harnessId: CODEX_HARNESS_ID,
        nativeSessionId,
        title: record.title,
        workspace: record.workspace,
        nativeStatus,
        lastActivityAt: iso(record.lastActivityAt),
        nativeGroup: record.nativeGroup,
        unknownFields,
        locator,
        cursor:
          latestSource === undefined
            ? null
            : {
                sourceUnitId: latestSource.sourceId,
                contentPosition: latestSource.consumedBytes,
                prefixHash: latestSource.prefixHash,
                tailHash: latestSource.tailHash,
                parserVersion: latestSource.parserVersion,
              },
        provenance: CODEX_PROVENANCE,
      });
    }

    for (const fileError of this.reader.progress().fileErrors) {
      failures.push({
        code: "source_unreadable",
        message: fileError.message,
        scope: { kind: "source", harnessId: CODEX_HARNESS_ID, sourceId: fileError.path },
        retryable: true,
      });
    }
    return { sessions, failures };
  }
}
