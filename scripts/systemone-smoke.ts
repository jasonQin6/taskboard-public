/**
 * 真实 Magpie/SystemOne 网关冒烟（#45 open item 5；.env 机制由 #52 落地）：默认跳过，
 * TASKBOARD_SYSTEMONE_SMOKE=1 时经生产代码路径（MagpieProvider.judge）打一次真实网关，
 * 一次往返同时验证 wire schema（parseVerdict 从严校验）、usage 遥测与 evidence_refs 子集。
 * 凭据只经 .env / 进程环境（与 CLI 同一 loadProjectEnv，TASKBOARD_ENV_FILE 可覆盖路径），
 * 不进参数、不进输出。不进默认测试面：真实网关计费且依赖外部可用性。
 */
import { loadProjectEnv } from "../src/cli.js";
import { DEFAULT_SETTINGS } from "../src/store/index.js";
import { MagpieProvider } from "../src/systemone/magpie.js";
import type { Settings } from "../src/types.js";

const endpointInUse = (): string =>
  process.env.TASKBOARD_SYSTEMONE_URL ?? process.env.MAGPIE_SYSTEMONE_URL ?? "default http://127.0.0.1:3425/v1/systemone";

if (process.env.TASKBOARD_SYSTEMONE_SMOKE !== "1") {
  console.log("skip: set TASKBOARD_SYSTEMONE_SMOKE=1 to probe the real systemone gateway");
  process.exit(0);
}

const envError = loadProjectEnv();
if (envError !== null) {
  console.error(`error: ${envError}`);
  process.exit(1);
}

const settings: Settings = DEFAULT_SETTINGS;
const provider = new MagpieProvider({ env: process.env, settings: () => settings });
const availability = provider.available(settings);
if (!availability.ok) {
  console.error(`unavailable: ${availability.reason}`);
  process.exit(1);
}

// 合成的最小可判输入：只验线上往返，不带任何真实会话数据
const input = {
  subject: {
    threadId: "smoke-thread",
    harnessId: "taskboard-smoke",
    nativeSessionId: "smoke-probe",
    nativeStatus: "idle" as const,
    title: "systemone gated smoke probe",
    workspace: null,
  },
  cursor: null,
  turns: {
    total: 3,
    byStatus: { completed: 2, idle: 1 },
    latest: { ordinal: 3, nativeStatus: "idle" },
  },
  evidence: [
    { id: "ev-1", kind: "note", turnOrdinal: 1, excerpt: "smoke probe evidence line one", recordHash: null },
    { id: "ev-2", kind: "note", turnOrdinal: 2, excerpt: "smoke probe evidence line two", recordHash: null },
  ],
  summary: null,
  overlay: { primaryTaskId: null, taskTitle: null, labels: [], notes: [] },
  allowedEvidenceIds: ["ev-1", "ev-2"],
};

console.log(`probing ${endpointInUse()} model=${provider.resolveModel()}`);
try {
  const verdict = await provider.judge(input, AbortSignal.timeout(30_000));
  const usage =
    verdict.usage === null ? "null" : `${verdict.usage.inputTokens}/${verdict.usage.outputTokens} tokens`;
  console.log(
    `PASS status=${verdict.status} confidence=${verdict.confidence} evidenceRefs=${JSON.stringify(verdict.evidenceRefs)} usage=${usage}`,
  );
} catch (error) {
  const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "unknown";
  // Provider 错误的 message 按线框口径不含令牌与响应体；未知错误只打 name，防意外回显
  const detail = error instanceof Error && !(("code" in error)) ? error.name : error instanceof Error ? error.message : String(error);
  console.error(`FAIL ${code}: ${detail}`);
  process.exit(1);
}
