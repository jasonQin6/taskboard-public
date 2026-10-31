import type {
  CapabilityManifest,
  Failure,
  HarnessAdapter,
  HarnessObservation,
  HarnessScanProgress,
  SessionSnapshot,
} from "./contract.js";

const failureForAdapter = (adapter: HarnessAdapter, error: unknown): Failure => {
  let harnessId = "unknown";
  try {
    harnessId = adapter.capabilityManifest().harnessId;
  } catch {
    // manifest 本身失败时仍要返回可展示的 Failure，不能再把 registry.observe 打穿。
  }
  return {
    code: "adapter_failed",
    message: error instanceof Error ? error.message : String(error),
    scope: { kind: "harness", harnessId },
    retryable: true,
  };
};

/** 多 adapter 汇总面：单 adapter 失败只形成结构化 Failure，不阻塞其他 Harness。 */
export class HarnessRegistry {
  constructor(private readonly adapters: readonly HarnessAdapter[]) {
    const ids = new Set<string>();
    for (const adapter of adapters) {
      const id = adapter.capabilityManifest().harnessId;
      if (ids.has(id)) throw new Error(`duplicate harness adapter: ${id}`);
      ids.add(id);
    }
  }

  capabilityManifests(): CapabilityManifest[] {
    return this.adapters.map((adapter) => adapter.capabilityManifest());
  }

  /** 摄取生命周期扇出：daemon 只持 registry，不再直摸各 adapter 的 reader。 */
  start(): void {
    for (const adapter of this.adapters) adapter.start();
  }

  /** 摄取面装配规模：daemon 据此决定是否注入 scan 端点，不再按具体 harness 名分支。 */
  size(): number {
    return this.adapters.length;
  }

  async stop(): Promise<void> {
    // 关停收口必须走完所有 adapter，单个失败不得阻断其余（ADR-0014 关停顺序）
    const failures: string[] = [];
    for (const adapter of this.adapters) {
      try {
        await adapter.stop();
      } catch (error) {
        let harnessId = "unknown";
        try {
          harnessId = adapter.capabilityManifest().harnessId;
        } catch {
          // manifest 本身失败仍要记一条可定位的失败，不吞错。
        }
        failures.push(`${harnessId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) throw new Error(`registry stop failed: ${failures.join("; ")}`);
  }

  /** 全员立即扫描并返回各家摘要（单 harness 时为单元素数组；scan.refresh 经 ViewContext 原样返回）。 */
  scanNow(): Promise<unknown[]> {
    return Promise.all(this.adapters.map((adapter) => adapter.scanNow()));
  }

  /** 进度聚合：任一 running 即 running；非空且全员 done 才 done，否则 idle（done+idle 不得高估为 done）。空 registry 时为全零 idle。 */
  scanProgress(): HarnessScanProgress {
    let phase: HarnessScanProgress["phase"] = "idle";
    let sawAny = false;
    let allDone = true;
    let filesTotal = 0;
    let filesDone = 0;
    let lastCompletedAt: string | null = null;
    for (const adapter of this.adapters) {
      const progress = adapter.progress();
      sawAny = true;
      if (progress.phase === "running") phase = "running";
      else if (progress.phase !== "done") allDone = false;
      filesTotal += progress.filesTotal;
      filesDone += progress.filesDone;
      if (
        progress.lastCompletedAt !== null &&
        (lastCompletedAt === null || progress.lastCompletedAt > lastCompletedAt)
      ) {
        lastCompletedAt = progress.lastCompletedAt;
      }
    }
    if (phase !== "running") phase = sawAny && allDone ? "done" : "idle";
    return { phase, filesTotal, filesDone, lastCompletedAt };
  }

  observe(): HarnessObservation {
    const sessions: SessionSnapshot[] = [];
    const failures: Failure[] = [];
    for (const adapter of this.adapters) {
      try {
        const observation = adapter.observe();
        sessions.push(...observation.sessions);
        failures.push(...observation.failures);
      } catch (error) {
        failures.push(failureForAdapter(adapter, error));
      }
    }
    sessions.sort((a, b) => {
      const am = a.lastActivityAt === null ? 0 : Date.parse(a.lastActivityAt);
      const bm = b.lastActivityAt === null ? 0 : Date.parse(b.lastActivityAt);
      return bm - am || a.harnessId.localeCompare(b.harnessId) || a.nativeSessionId.localeCompare(b.nativeSessionId);
    });
    return { sessions, failures };
  }
}
