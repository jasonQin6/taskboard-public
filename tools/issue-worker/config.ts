/** issue-worker 配置：加载与 fail-closed 校验。不存在的路径、非法值直接抛错，daemon 拒绝启动。 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface IssueWorkerLabels {
  ready: string;
  inProgress: string;
  human: string;
  needsInfo: string;
}

export interface IssueWorkerTimeouts {
  implementMs: number;
  auditMs: number;
  ocrMs: number;
  mergeMs: number;
  pollMs: number;
  leaseMs: number;
  infraBackoffMs: number[];
  commandMs: number;
}

export type AutoMergeScope = "docs" | "test" | "src";

export interface FindingDismissalRule {
  id?: string;
  file?: string;
  pattern?: string;
  reason: string;
}

export interface IssueWorkerAutoMerge {
  enabled: boolean;
  allowedScopes: AutoMergeScope[];
  dismissals: FindingDismissalRule[];
}

export interface IssueWorkerConfig {
  repo: string;
  repoName: string;
  baseBranch: string;
  labels: IssueWorkerLabels;
  branchPrefix: string;
  zcodeHelper: string;
  zcodeCli: string;
  zcodeDb: string;
  gates: string[][];
  timeouts: IssueWorkerTimeouts;
  autoMerge: IssueWorkerAutoMerge;
  stateDir: string;
  maxImplementAttempts: number;
  maxDeliveryAttempts: number;
}

export const ZCODE_HELPER_DEFAULT =
  "/Applications/ZCode.app/Contents/Frameworks/ZCode Helper.app/Contents/MacOS/ZCode Helper";
export const ZCODE_CLI_DEFAULT = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";
export const zcodeDbDefault = (): string => join(homedir(), ".zcode", "cli", "db", "db.sqlite");
export const stateDirDefault = (): string =>
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "zcode-issue-worker")
    : join(homedir(), ".local", "state", "zcode-issue-worker");

const DEFAULT_LABELS: IssueWorkerLabels = {
  ready: "ready-for-agent",
  inProgress: "in-progress",
  human: "ready-for-human",
  needsInfo: "needs-info",
};

const DEFAULT_TIMEOUTS: IssueWorkerTimeouts = {
  implementMs: 6 * 3600_000,
  auditMs: 2 * 3600_000,
  ocrMs: 30 * 60_000,
  mergeMs: 30 * 60_000,
  pollMs: 5 * 60_000,
  leaseMs: 15 * 60_000,
  infraBackoffMs: [60_000, 5 * 60_000, 15 * 60_000],
  commandMs: 120_000,
};

const DEFAULT_AUTO_MERGE: IssueWorkerAutoMerge = {
  enabled: false,
  allowedScopes: ["docs", "test"],
  dismissals: [],
};

const DEFAULT_GATES: string[][] = [
  ["pnpm", "typecheck"],
  ["pnpm", "test"],
];

/** 配置顶层允许的键：未知键直接拒绝，避免拼写错误静默生效。 */
const KNOWN_KEYS = new Set([
  "repo",
  "repoName",
  "baseBranch",
  "labels",
  "branchPrefix",
  "zcodeHelper",
  "zcodeCli",
  "zcodeDb",
  "gates",
  "timeouts",
  "autoMerge",
  "stateDir",
  "maxImplementAttempts",
  "maxDeliveryAttempts",
]);

const KNOWN_TIMEOUT_KEYS = new Set([
  "implementMs",
  "auditMs",
  "ocrMs",
  "mergeMs",
  "pollMs",
  "leaseMs",
  "infraBackoffMs",
  "commandMs",
]);

const KNOWN_AUTO_MERGE_KEYS = new Set(["enabled", "allowedScopes", "dismissals"]);
const KNOWN_DISMISSAL_KEYS = new Set(["id", "file", "pattern", "reason"]);
const AUTO_MERGE_SCOPES = new Set<AutoMergeScope>(["docs", "test", "src"]);

function fail(message: string): never {
  throw new Error(`invalid issue-worker config: ${message}`);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asNonEmptyString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value as string;
};

const asPositiveInt = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    fail(`${field} must be a positive integer`);
  return value as number;
};

const asAbsolutePath = (value: unknown, field: string): string => {
  const path = asNonEmptyString(value, field);
  if (!isAbsolute(path)) fail(`${field} must be an absolute path, got ${path}`);
  return path;
};

export const defaultConfig = (repo: string): IssueWorkerConfig => ({
  repo,
  repoName: "",
  baseBranch: "main",
  labels: { ...DEFAULT_LABELS },
  branchPrefix: "issue-",
  zcodeHelper: ZCODE_HELPER_DEFAULT,
  zcodeCli: ZCODE_CLI_DEFAULT,
  zcodeDb: zcodeDbDefault(),
  gates: DEFAULT_GATES.map((gate) => [...gate]),
  timeouts: { ...DEFAULT_TIMEOUTS, infraBackoffMs: [...DEFAULT_TIMEOUTS.infraBackoffMs] },
  autoMerge: {
    enabled: DEFAULT_AUTO_MERGE.enabled,
    allowedScopes: [...DEFAULT_AUTO_MERGE.allowedScopes],
    dismissals: [],
  },
  stateDir: stateDirDefault(),
  maxImplementAttempts: 3,
  maxDeliveryAttempts: 3,
});

const parseLabels = (value: unknown): IssueWorkerLabels => {
  if (value === undefined) return { ...DEFAULT_LABELS };
  if (!isRecord(value)) fail("labels must be an object");
  const labels = { ...DEFAULT_LABELS };
  for (const key of ["ready", "inProgress", "human", "needsInfo"] as const) {
    if (value[key] !== undefined) labels[key] = asNonEmptyString(value[key], `labels.${key}`);
  }
  return labels;
};

const parseTimeouts = (value: unknown): IssueWorkerTimeouts => {
  if (value === undefined)
    return { ...DEFAULT_TIMEOUTS, infraBackoffMs: [...DEFAULT_TIMEOUTS.infraBackoffMs] };
  if (!isRecord(value)) fail("timeouts must be an object");
  for (const key of Object.keys(value)) {
    if (!KNOWN_TIMEOUT_KEYS.has(key)) fail(`unknown key timeouts.${key}`);
  }
  const base = { ...DEFAULT_TIMEOUTS, infraBackoffMs: [...DEFAULT_TIMEOUTS.infraBackoffMs] };
  if (value["implementMs"] !== undefined)
    base.implementMs = asPositiveInt(value["implementMs"], "timeouts.implementMs");
  if (value["auditMs"] !== undefined)
    base.auditMs = asPositiveInt(value["auditMs"], "timeouts.auditMs");
  if (value["ocrMs"] !== undefined)
    base.ocrMs = asPositiveInt(value["ocrMs"], "timeouts.ocrMs");
  if (value["mergeMs"] !== undefined)
    base.mergeMs = asPositiveInt(value["mergeMs"], "timeouts.mergeMs");
  if (value["pollMs"] !== undefined) base.pollMs = asPositiveInt(value["pollMs"], "timeouts.pollMs");
  if (value["leaseMs"] !== undefined)
    base.leaseMs = asPositiveInt(value["leaseMs"], "timeouts.leaseMs");
  if (value["commandMs"] !== undefined)
    base.commandMs = asPositiveInt(value["commandMs"], "timeouts.commandMs");
  if (value["infraBackoffMs"] !== undefined) {
    const list = value["infraBackoffMs"];
    if (!Array.isArray(list) || list.length === 0)
      fail("timeouts.infraBackoffMs must be a non-empty array");
    base.infraBackoffMs = list.map((entry, index) =>
      asPositiveInt(entry, `timeouts.infraBackoffMs[${index}]`),
    );
  }
  return base;
};

const parseAutoMerge = (value: unknown): IssueWorkerAutoMerge => {
  if (value === undefined) {
    return {
      enabled: DEFAULT_AUTO_MERGE.enabled,
      allowedScopes: [...DEFAULT_AUTO_MERGE.allowedScopes],
      dismissals: [],
    };
  }
  if (!isRecord(value)) fail("autoMerge must be an object");
  for (const key of Object.keys(value)) {
    if (!KNOWN_AUTO_MERGE_KEYS.has(key)) fail(`unknown key autoMerge.${key}`);
  }
  const autoMerge: IssueWorkerAutoMerge = {
    enabled: DEFAULT_AUTO_MERGE.enabled,
    allowedScopes: [...DEFAULT_AUTO_MERGE.allowedScopes],
    dismissals: [],
  };
  if (value["enabled"] !== undefined) {
    if (typeof value["enabled"] !== "boolean") fail("autoMerge.enabled must be a boolean");
    autoMerge.enabled = value["enabled"];
  }
  if (value["allowedScopes"] !== undefined) {
    if (!Array.isArray(value["allowedScopes"]))
      fail("autoMerge.allowedScopes must be an array");
    const scopes: AutoMergeScope[] = [];
    for (const [index, rawScope] of value["allowedScopes"].entries()) {
      if (typeof rawScope !== "string" || !AUTO_MERGE_SCOPES.has(rawScope as AutoMergeScope)) {
        fail(
          `autoMerge.allowedScopes[${index}] must be one of docs,test,src, got ${JSON.stringify(rawScope)}`,
        );
      }
      const scope = rawScope as AutoMergeScope;
      if (scopes.includes(scope)) fail(`autoMerge.allowedScopes contains duplicate ${scope}`);
      scopes.push(scope);
    }
    autoMerge.allowedScopes = scopes;
  }
  if (autoMerge.enabled && autoMerge.allowedScopes.length === 0) {
    fail("autoMerge.allowedScopes must be non-empty when autoMerge is enabled");
  }
  if (value["dismissals"] !== undefined) {
    if (!Array.isArray(value["dismissals"])) fail("autoMerge.dismissals must be an array");
    autoMerge.dismissals = value["dismissals"].map((entry, index) => {
      const field = `autoMerge.dismissals[${index}]`;
      if (!isRecord(entry)) fail(`${field} must be an object`);
      for (const key of Object.keys(entry)) {
        if (!KNOWN_DISMISSAL_KEYS.has(key)) fail(`unknown key ${field}.${key}`);
      }
      const id =
        entry["id"] === undefined ? undefined : asNonEmptyString(entry["id"], `${field}.id`);
      const file =
        entry["file"] === undefined ? undefined : asNonEmptyString(entry["file"], `${field}.file`);
      const pattern =
        entry["pattern"] === undefined
          ? undefined
          : asNonEmptyString(entry["pattern"], `${field}.pattern`);
      const reason = asNonEmptyString(entry["reason"], `${field}.reason`);
      const byId = id !== undefined;
      const byFilePattern = file !== undefined && pattern !== undefined;
      const hasFileOrPattern = file !== undefined || pattern !== undefined;
      if (byId === byFilePattern || (byId && hasFileOrPattern)) {
        fail(`${field} must match by id or by file plus pattern, exclusively`);
      }
      if (pattern !== undefined) {
        try {
          new RegExp(pattern);
        } catch {
          fail(`${field}.pattern must be a valid regular expression`);
        }
      }
      return {
        ...(id === undefined ? {} : { id }),
        ...(file === undefined ? {} : { file }),
        ...(pattern === undefined ? {} : { pattern }),
        reason,
      };
    });
  }
  return autoMerge;
};

const parseGates = (value: unknown): string[][] => {
  if (value === undefined) return DEFAULT_GATES.map((gate) => [...gate]);
  if (!Array.isArray(value) || value.length === 0) fail("gates must be a non-empty array");
  return value.map((gate, index) => {
    if (!Array.isArray(gate) || gate.length === 0 || gate.some((part) => typeof part !== "string"))
      fail(`gates[${index}] must be a non-empty string array`);
    return [...(gate as string[])];
  });
};

export const buildConfig = (raw: unknown, cwd: string): IssueWorkerConfig => {
  const obj: Record<string, unknown> =
    raw === undefined ? {} : isRecord(raw) ? raw : fail("root must be an object");
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) fail(`unknown key ${JSON.stringify(key)}`);
  }
  const repo = obj["repo"] === undefined ? cwd : asAbsolutePath(obj["repo"], "repo");
  const config = defaultConfig(repo);
  if (obj["repoName"] !== undefined)
    config.repoName = asNonEmptyString(obj["repoName"], "repoName");
  if (obj["baseBranch"] !== undefined)
    config.baseBranch = asNonEmptyString(obj["baseBranch"], "baseBranch");
  if (obj["branchPrefix"] !== undefined)
    config.branchPrefix = asNonEmptyString(obj["branchPrefix"], "branchPrefix");
  if (!/^[A-Za-z0-9_-]+$/.test(config.branchPrefix))
    fail("branchPrefix must match [A-Za-z0-9_-]+");
  if (obj["zcodeHelper"] !== undefined)
    config.zcodeHelper = asAbsolutePath(obj["zcodeHelper"], "zcodeHelper");
  if (obj["zcodeCli"] !== undefined)
    config.zcodeCli = asAbsolutePath(obj["zcodeCli"], "zcodeCli");
  if (obj["zcodeDb"] !== undefined) config.zcodeDb = asAbsolutePath(obj["zcodeDb"], "zcodeDb");
  if (obj["stateDir"] !== undefined)
    config.stateDir = asAbsolutePath(obj["stateDir"], "stateDir");
  config.labels = parseLabels(obj["labels"]);
  config.timeouts = parseTimeouts(obj["timeouts"]);
  config.autoMerge = parseAutoMerge(obj["autoMerge"]);
  config.gates = parseGates(obj["gates"]);
  if (obj["maxImplementAttempts"] !== undefined)
    config.maxImplementAttempts = asPositiveInt(
      obj["maxImplementAttempts"],
      "maxImplementAttempts",
    );
  if (obj["maxDeliveryAttempts"] !== undefined)
    config.maxDeliveryAttempts = asPositiveInt(obj["maxDeliveryAttempts"], "maxDeliveryAttempts");
  return config;
};

export interface LoadedConfig {
  config: IssueWorkerConfig;
  configPath: string | null;
}

export const loadConfig = (explicitPath: string | null, cwd: string): LoadedConfig => {
  const fallback = join(stateDirDefault(), "config.json");
  const configPath = explicitPath ?? (existsSync(fallback) ? fallback : null);
  const raw = configPath === null ? {} : JSON.parse(readFileSync(configPath, "utf8"));
  const config = buildConfig(raw, cwd);
  const repoStat = existsSync(config.repo) ? statSync(config.repo) : null;
  if (repoStat === null || !repoStat.isDirectory()) fail(`repo is not a directory: ${config.repo}`);
  for (const [field, path] of [
    ["zcodeHelper", config.zcodeHelper],
    ["zcodeCli", config.zcodeCli],
    ["zcodeDb", config.zcodeDb],
  ] as const) {
    const stat = existsSync(path) ? statSync(path) : null;
    if (stat === null || !stat.isFile()) fail(`${field} is not a file: ${path}`);
  }
  return { config, configPath };
};
