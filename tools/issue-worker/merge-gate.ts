/**
 * 受控自动合并门：把两路审计、精确 SHA、GitHub 强制规则和路径策略折叠成一个决策。
 * 外部读取失败一律进入 blocked/manual 路径，绝不把缺失证据补成默认成功。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  AutoMergeScope,
  FindingDismissalRule,
  IssueWorkerAutoMerge,
} from "./config.ts";
import { scrubEnv } from "./zcode.ts";

export type AuditSource = "zcode" | "ocr";
export type AuditStatus = "passed" | "failed";
export type AuditVerdict = "approved" | "changes-requested" | "blocked" | "error";

export interface FindingInput {
  severity: string;
  location: string;
  what: string;
  evidence: string;
  recommendation: string;
}

export interface GateFinding extends FindingInput {
  id: string;
  source: AuditSource;
}

export interface FindingDisposition {
  finding: GateFinding;
  disposition: "allowed" | "blocking" | "dismissed";
  reason: string;
  matchedRule?: FindingDismissalRule;
}

export interface AuditSourceEvidence {
  source: AuditSource;
  status: AuditStatus;
  verdict: AuditVerdict;
  reviewedSha: string;
  baseSha: string;
  summary: string;
  findings: FindingDisposition[];
  command?: {
    argv: string[];
    exit: number;
  };
  outputPath?: string;
  sessionId?: string;
  resolvedBaseSha?: string;
  resolvedHeadSha?: string;
  exactRange?: string;
}

export interface PathPolicyDecision {
  allowed: boolean;
  reasons: string[];
  scopes: AutoMergeScope[];
  protectedFiles: string[];
  disallowedFiles: string[];
}

export interface OcrReviewDocument {
  status: string;
  message: string;
  sessionId: string;
  findings: FindingInput[];
  resolvedBaseSha: string | null;
  resolvedHeadSha: string | null;
  exactRange: string | null;
}

export type OcrParseResult =
  | { ok: true; document: OcrReviewDocument }
  | { ok: false; reason: string };

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

export type OcrCommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
) => CommandResult;

export interface OcrRunInput {
  repo: string;
  baseSha: string;
  headSha: string;
  title: string;
  body: string;
  outputPath: string;
  timeoutMs: number;
  dismissals: FindingDismissalRule[];
  requiredPaths?: string[];
  runCommand?: OcrCommandRunner;
}

export interface PullRequestSnapshot {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  draft: boolean;
  headSha: string;
  baseSha: string;
  baseRef: string;
}

export interface RequiredCheck {
  context: string;
  appId: number | null;
}

export interface BranchProtectionRule {
  requiredChecks: RequiredCheck[];
  strict: boolean;
  enforceAdmins: boolean;
}

export interface RepositoryRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  includeRefs: string[];
  excludeRefs: string[];
  requiredChecks: RequiredCheck[];
  strict: boolean;
  bypassActorCount: number;
}

export interface RepositoryMetadata {
  defaultBranch: string;
}

export interface CheckRunSnapshot {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  appId: number | null;
  appSlug: string | null;
}

export interface CommitStatusSnapshot {
  context: string;
  state: string;
}

export interface GateRead<T> {
  status: number | null;
  data: T | null;
  error: string | null;
}

export interface MergeApiResult {
  status: number | null;
  merged: boolean;
  mergeCommitSha: string | null;
  message: string;
  error: string | null;
}

export interface MergeGatePort {
  getPullRequest: (repo: string, prNumber: number) => GateRead<PullRequestSnapshot>;
  getRepository: (repo: string) => GateRead<RepositoryMetadata>;
  getBranchProtection: (repo: string, baseRef: string) => GateRead<BranchProtectionRule>;
  listRulesets: (repo: string) => GateRead<RepositoryRuleset[]>;
  listCheckRuns: (repo: string, headSha: string) => GateRead<CheckRunSnapshot[]>;
  getCombinedStatus: (repo: string, headSha: string) => GateRead<CommitStatusSnapshot[]>;
  mergePullRequest: (input: {
    repo: string;
    prNumber: number;
    headSha: string;
  }) => MergeApiResult;
}

export interface GithubEvaluation {
  conclusion: "success" | "waiting" | "failure";
  reasons: string[];
  pendingReasons: string[];
  requiredChecks: string[];
  pullRequest: PullRequestSnapshot;
  repository: GateRead<RepositoryMetadata>;
  branchProtection: GateRead<BranchProtectionRule>;
  rulesets: GateRead<RepositoryRuleset[]>;
  checkRuns: GateRead<CheckRunSnapshot[]>;
  statuses: GateRead<CommitStatusSnapshot[]>;
}

export interface MergeEvidence {
  version: 1;
  stage: "audit_only" | "merge_ready" | "waiting" | "manual_only" | "blocked" | "merged";
  repo: string;
  issue: number;
  prNumber: number | null;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  issueSnapshotHash: string;
  changedFiles: string[];
  pathPolicy: PathPolicyDecision;
  zcode: AuditSourceEvidence;
  ocr: AuditSourceEvidence | null;
  controllerGates: { command: string; exit: number }[];
  github: GithubEvaluation | null;
  reasons: string[];
  mergeWaitStartedAt?: number | null;
  finalizationStartedAt?: number | null;
  mergeOutcome?: {
    merged: boolean;
    mergeCommitSha: string | null;
    outboxKey: string;
    status: number | null;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

interface CoverageItem {
  itemId: string;
  path: string;
  fingerprint: string;
}

const normalizeCoveragePath = (path: string): string | null => {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").trim().split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.join("/");
};

const parseCoverageItems = (value: unknown): Map<string, CoverageItem> | null => {
  if (!Array.isArray(value)) return null;
  const items = new Map<string, CoverageItem>();
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw["item_id"] !== "string" ||
      raw["item_id"] === "" ||
      typeof raw["path"] !== "string" ||
      raw["path"] === "" ||
      typeof raw["fingerprint"] !== "string" ||
      raw["fingerprint"] === ""
    ) {
      return null;
    }
    const itemId = raw["item_id"];
    const path = normalizeCoveragePath(raw["path"]);
    if (path === null || path === "") return null;
    if (items.has(itemId)) return null;
    items.set(itemId, {
      itemId,
      path,
      fingerprint: raw["fingerprint"],
    });
  }
  return items;
};

const ocrCoverageFailure = (
  manifest: Record<string, unknown>,
  requiredPaths: string[],
): string | null => {
  const coverage = manifest["coverage"];
  if (!isRecord(coverage)) return "OCR manifest.coverage is missing";
  const selected = parseCoverageItems(coverage["selected"]);
  const completed = parseCoverageItems(coverage["completed"]);
  const reused = parseCoverageItems(coverage["reused"]);
  const failed = coverage["failed"];
  const waived = coverage["waived"];
  if (selected === null || completed === null || reused === null) {
    return "OCR manifest.coverage items are malformed";
  }
  if (!Array.isArray(failed) || !Array.isArray(waived)) {
    return "OCR manifest.coverage failed/waived must be arrays";
  }
  if (failed.length > 0) return "OCR review has failed coverage items";
  if (waived.length > 0) return "OCR review has waived coverage items";
  const reviewed = new Map(completed);
  for (const [itemId, item] of reused) {
    const existing = reviewed.get(itemId);
    if (
      existing !== undefined &&
      (existing.path !== item.path || existing.fingerprint !== item.fingerprint)
    ) {
      return `OCR coverage conflicts for reused item ${itemId}`;
    }
    reviewed.set(itemId, item);
  }
  for (const [itemId, item] of selected) {
    const done = reviewed.get(itemId);
    if (done?.path !== item.path || done?.fingerprint !== item.fingerprint) {
      return `OCR did not review selected item ${itemId}`;
    }
  }
  const selectedByPath = new Map<string, number>();
  for (const item of selected.values()) {
    selectedByPath.set(item.path, (selectedByPath.get(item.path) ?? 0) + 1);
  }
  for (const path of requiredPaths) {
    const normalizedPath = normalizeCoveragePath(path);
    if (
      normalizedPath === null ||
      normalizedPath === "" ||
      (selectedByPath.get(normalizedPath) ?? 0) < 1
    ) {
      return `OCR coverage omitted required path ${path}`;
    }
  }
  return null;
};

const findingId = (source: AuditSource, finding: FindingInput): string =>
  sha256(
    JSON.stringify([
      source,
      finding.severity.toLowerCase(),
      finding.location,
      finding.what,
      finding.evidence,
      finding.recommendation,
    ]),
  ).slice(0, 20);

const normalizeLocation = (
  path: string,
  startLine: number,
  endLine: number,
): string => {
  if (startLine <= 0 && endLine <= 0) return path;
  if (endLine <= 0 || endLine === startLine) return `${path}:${startLine}`;
  return `${path}:${startLine}-${endLine}`;
};

const globToRegExp = (glob: string): RegExp => {
  let pattern = "^";
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 2;
        } else {
          pattern += ".*";
          index++;
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
};

const locationPath = (location: string): string => location.split(":", 1)[0] ?? location;

const dismissalMatches = (
  rule: FindingDismissalRule,
  finding: GateFinding,
): boolean => {
  if (rule.id !== undefined) return rule.id === finding.id;
  if (rule.file === undefined || rule.pattern === undefined) return false;
  if (!globToRegExp(rule.file).test(locationPath(finding.location))) return false;
  return new RegExp(rule.pattern, "i").test(
    `${finding.what}\n${finding.evidence}\n${finding.recommendation}`,
  );
};

export const evaluateFindings = (
  source: AuditSource,
  findings: FindingInput[],
  dismissals: FindingDismissalRule[],
): FindingDisposition[] =>
  findings.map((input) => {
    const finding: GateFinding = { ...input, id: findingId(source, input), source };
    const matchedRule = dismissals.find((rule) => dismissalMatches(rule, finding));
    if (matchedRule !== undefined) {
      return {
        finding,
        disposition: "dismissed",
        reason: matchedRule.reason,
        matchedRule,
      };
    }
    const severity = finding.severity.toLowerCase();
    if (severity === "low") {
      return {
        finding,
        disposition: "allowed",
        reason: "low severity is recorded but does not block",
      };
    }
    return {
      finding,
      disposition: "blocking",
      reason: ["critical", "high", "medium"].includes(severity)
        ? `${severity} severity blocks auto-merge`
        : `unknown severity ${JSON.stringify(finding.severity)} fails closed`,
    };
  });

export const hasBlockingFindings = (dispositions: FindingDisposition[]): boolean =>
  dispositions.some((item) => item.disposition === "blocking");

export const parseOcrReview = (
  raw: string,
  expected: { baseSha: string; headSha: string; requiredPaths?: string[] },
): OcrParseResult => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `OCR JSON is invalid: ${String(error).slice(0, 200)}` };
  }
  if (!isRecord(value)) return { ok: false, reason: "OCR JSON root must be an object" };
  if (value["status"] !== "complete") {
    return {
      ok: false,
      reason: `OCR session status is ${JSON.stringify(value["status"])}, expected complete`,
    };
  }
  const manifest = value["manifest"];
  if (!isRecord(manifest)) {
    return { ok: false, reason: "OCR manifest is missing" };
  }
  if (manifest["terminal_state"] !== "complete") {
    return {
      ok: false,
      reason: `OCR manifest terminal_state is ${JSON.stringify(manifest["terminal_state"])}, expected complete`,
    };
  }
  const manifestInput = manifest["input"];
  if (!isRecord(manifestInput)) {
    return { ok: false, reason: "OCR manifest.input is missing" };
  }
  const resolvedBase = manifestInput["resolved_base"];
  const resolvedHead = manifestInput["resolved_head"];
  const exactRange = manifestInput["exact_range"];
  if (typeof resolvedBase !== "string" || typeof resolvedHead !== "string") {
    return {
      ok: false,
      reason: "OCR manifest.input.resolved_base and resolved_head are required strings",
    };
  }
  if (exactRange !== undefined && typeof exactRange !== "string") {
    return { ok: false, reason: "OCR manifest.input.exact_range must be a string" };
  }
  if (resolvedBase !== expected.baseSha || resolvedHead !== expected.headSha) {
    return {
      ok: false,
      reason:
        `OCR reviewed ${JSON.stringify(resolvedBase)}..${JSON.stringify(resolvedHead)}` +
        `; resolved base/head do not match expected ${expected.baseSha}..${expected.headSha}`,
    };
  }
  if (exactRange !== undefined && exactRange !== `${expected.baseSha}..${expected.headSha}`) {
    return { ok: false, reason: "OCR manifest contains inconsistent reviewed SHAs" };
  }
  const coverageFailure = ocrCoverageFailure(manifest, expected.requiredPaths ?? []);
  if (coverageFailure !== null) return { ok: false, reason: coverageFailure };
  const rawComments = value["comments"];
  if (rawComments === undefined) return { ok: false, reason: "OCR comments are missing" };
  if (rawComments !== null && !Array.isArray(rawComments)) {
    return { ok: false, reason: "OCR comments must be an array or null" };
  }
  const comments = rawComments ?? [];
  const findings: FindingInput[] = [];
  for (const [index, rawComment] of comments.entries()) {
    if (!isRecord(rawComment)) {
      return { ok: false, reason: `OCR comments[${index}] must be an object` };
    }
    const path = rawComment["path"];
    const content = rawComment["content"];
    const startLine = rawComment["start_line"];
    const endLine = rawComment["end_line"];
    const severity = rawComment["severity"];
    if (typeof path !== "string" || path === "") {
      return { ok: false, reason: `OCR comments[${index}].path must be a non-empty string` };
    }
    if (typeof content !== "string" || content === "") {
      return { ok: false, reason: `OCR comments[${index}].content must be a non-empty string` };
    }
    if (startLine !== undefined && (typeof startLine !== "number" || !Number.isInteger(startLine))) {
      return { ok: false, reason: `OCR comments[${index}].start_line must be an integer` };
    }
    if (endLine !== undefined && (typeof endLine !== "number" || !Number.isInteger(endLine))) {
      return { ok: false, reason: `OCR comments[${index}].end_line must be an integer` };
    }
    if (severity !== undefined && typeof severity !== "string") {
      return { ok: false, reason: `OCR comments[${index}].severity must be a string` };
    }
    const existingCode =
      typeof rawComment["existing_code"] === "string" ? rawComment["existing_code"] : "";
    const suggestionCode =
      typeof rawComment["suggestion_code"] === "string" ? rawComment["suggestion_code"] : "";
    const category =
      typeof rawComment["category"] === "string" ? rawComment["category"] : "unknown";
    findings.push({
      severity: typeof severity === "string" && severity !== "" ? severity : "unknown",
      location: normalizeLocation(
        path,
        typeof startLine === "number" ? startLine : 0,
        typeof endLine === "number" ? endLine : 0,
      ),
      what: content,
      evidence: existingCode === "" ? `OCR category: ${category}` : existingCode,
      recommendation:
        suggestionCode === "" ? "Review and resolve the OCR finding." : suggestionCode,
    });
  }
  return {
    ok: true,
    document: {
      status: "complete",
      message: typeof value["message"] === "string" ? value["message"] : "",
      sessionId: typeof value["session_id"] === "string" ? value["session_id"] : "",
      findings,
      resolvedBaseSha: typeof resolvedBase === "string" ? resolvedBase : null,
      resolvedHeadSha: typeof resolvedHead === "string" ? resolvedHead : null,
      exactRange: typeof exactRange === "string" ? exactRange : null,
    },
  };
};

const defaultOcrRunner: OcrCommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    env: scrubEnv(),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error === undefined ? null : String(result.error),
  };
};

const ocrBackground = (title: string, body: string): string => {
  const compactBody = body.replace(/\s+/g, " ").trim();
  return `${title.trim()}\n\n${compactBody.slice(0, 1500)}${compactBody.length > 1500 ? " [truncated]" : ""}`;
};

const failedAudit = (
  source: AuditSource,
  input: { baseSha: string; headSha: string; summary: string; command?: { argv: string[]; exit: number }; outputPath?: string },
): AuditSourceEvidence => ({
  source,
  status: "failed",
  verdict: "error",
  reviewedSha: input.headSha,
  baseSha: input.baseSha,
  summary: input.summary,
  findings: [],
  ...(input.command === undefined ? {} : { command: input.command }),
  ...(input.outputPath === undefined ? {} : { outputPath: input.outputPath }),
});

export const runOcrAudit = (input: OcrRunInput): AuditSourceEvidence => {
  try {
    mkdirSync(dirname(input.outputPath), { recursive: true });
    rmSync(input.outputPath, { force: true });
  } catch (error) {
    return failedAudit("ocr", {
      baseSha: input.baseSha,
      headSha: input.headSha,
      summary: `OCR output path is unavailable: ${String(error).slice(0, 300)}`,
      outputPath: input.outputPath,
    });
  }
  const args = [
    "review",
    "--from",
    input.baseSha,
    "--to",
    input.headSha,
    "--audience",
    "agent",
    "--format",
    "json",
    "--output",
    input.outputPath,
    "-b",
    ocrBackground(input.title, input.body),
  ];
  const command = ["ocr", ...args];
  const runner = input.runCommand ?? defaultOcrRunner;
  let result: CommandResult;
  try {
    result = runner("ocr", args, { cwd: input.repo, timeoutMs: input.timeoutMs });
  } catch (error) {
    return failedAudit("ocr", {
      baseSha: input.baseSha,
      headSha: input.headSha,
      summary: `OCR command failed to start: ${String(error).slice(0, 300)}`,
      command: { argv: command, exit: 1 },
      outputPath: input.outputPath,
    });
  }
  const exit = result.status ?? 1;
  if (result.error !== null) {
    return failedAudit("ocr", {
      baseSha: input.baseSha,
      headSha: input.headSha,
      summary: `OCR command failed: ${result.error.slice(0, 300)}`,
      command: { argv: command, exit },
      outputPath: input.outputPath,
    });
  }
  if (exit !== 0) {
    return failedAudit("ocr", {
      baseSha: input.baseSha,
      headSha: input.headSha,
      summary: `OCR exited ${exit}: ${result.stderr.slice(0, 500)}`,
      command: { argv: command, exit },
      outputPath: input.outputPath,
    });
  }
  if (!existsSync(input.outputPath)) {
    return failedAudit("ocr", {
      baseSha: input.baseSha,
      headSha: input.headSha,
      summary: "OCR exited 0 but did not write its output file",
      command: { argv: command, exit },
      outputPath: input.outputPath,
    });
  }
  let raw: string;
  try {
    raw = readFileSync(input.outputPath, "utf8");
  } catch (error) {
    return failedAudit("ocr", {
      baseSha: input.baseSha,
      headSha: input.headSha,
      summary: `OCR output is unreadable: ${String(error).slice(0, 300)}`,
      command: { argv: command, exit },
      outputPath: input.outputPath,
    });
  }
  const parsed = parseOcrReview(raw, {
    baseSha: input.baseSha,
    headSha: input.headSha,
    requiredPaths: input.requiredPaths ?? [],
  });
  if (!parsed.ok) {
    return failedAudit("ocr", {
      baseSha: input.baseSha,
      headSha: input.headSha,
      summary: parsed.reason,
      command: { argv: command, exit },
      outputPath: input.outputPath,
    });
  }
  const findings = evaluateFindings("ocr", parsed.document.findings, input.dismissals);
  const blocking = hasBlockingFindings(findings);
  return {
    source: "ocr",
    status: blocking ? "failed" : "passed",
    verdict: blocking ? "changes-requested" : "approved",
    reviewedSha: input.headSha,
    baseSha: input.baseSha,
    summary:
      parsed.document.message === ""
        ? blocking
          ? `OCR found ${findings.filter((item) => item.disposition === "blocking").length} blocking finding(s).`
          : `OCR approved after ${findings.filter((item) => item.disposition === "dismissed").length} dismissal(s).`
        : parsed.document.message,
    findings,
    command: { argv: command, exit },
    outputPath: input.outputPath,
    ...(parsed.document.resolvedBaseSha === null
      ? {}
      : { resolvedBaseSha: parsed.document.resolvedBaseSha }),
    ...(parsed.document.resolvedHeadSha === null
      ? {}
      : { resolvedHeadSha: parsed.document.resolvedHeadSha }),
    ...(parsed.document.exactRange === null
      ? {}
      : { exactRange: parsed.document.exactRange }),
    ...(parsed.document.sessionId === "" ? {} : { sessionId: parsed.document.sessionId }),
  };
};

export const zcodeAuditEvidence = (input: {
  baseSha: string;
  headSha: string;
  summary: string;
  findings: FindingInput[];
  dismissals: FindingDismissalRule[];
}): AuditSourceEvidence => {
  const findings = evaluateFindings("zcode", input.findings, input.dismissals);
  const blocking = hasBlockingFindings(findings);
  return {
    source: "zcode",
    status: blocking ? "failed" : "passed",
    verdict: blocking ? "changes-requested" : "approved",
    reviewedSha: input.headSha,
    baseSha: input.baseSha,
    summary: input.summary,
    findings,
  };
};

const isMigrationPath = (file: string): boolean => {
  const segments = file.split("/");
  return (
    file.endsWith(".sql") ||
    segments.includes("migration") ||
    segments.includes("migrations") ||
    segments.includes("drizzle")
  );
};

const isSecretOrPermissionPath = (file: string): boolean => {
  const base = file.split("/").at(-1) ?? file;
  return (
    base.startsWith(".env") ||
    /(^|[._-])(secret|secrets|credential|credentials|permission|permissions|token|auth|key)([._-]|$)/i.test(
      base,
    )
  );
};

export const isProtectedAutoMergePath = (file: string): boolean => {
  const normalized = file.replaceAll("\\", "/");
  return (
    normalized.startsWith(".github/") ||
    normalized.startsWith(".zcode/") ||
    normalized.startsWith("tools/issue-worker/") ||
    normalized.startsWith("src/store/") ||
    normalized.startsWith("docs/adr/") ||
    normalized === "package.json" ||
    normalized === "pnpm-lock.yaml" ||
    normalized === "package-lock.json" ||
    normalized === "yarn.lock" ||
    isMigrationPath(normalized) ||
    isSecretOrPermissionPath(normalized)
  );
};

const scopeForPath = (file: string): AutoMergeScope | null => {
  if (file.startsWith("docs/")) return "docs";
  if (file.startsWith("test/") || file.startsWith("tests/")) return "test";
  if (file.startsWith("src/")) return "src";
  return null;
};

export const evaluatePathPolicy = (
  changedFiles: string[],
  autoMerge: IssueWorkerAutoMerge,
): PathPolicyDecision => {
  const reasons: string[] = [];
  if (!autoMerge.enabled) reasons.push("auto-merge is disabled by config");
  if (changedFiles.length === 0) reasons.push("change set is empty");
  const protectedFiles = changedFiles.filter(isProtectedAutoMergePath).sort();
  const disallowedFiles: string[] = [];
  const scopes = new Set<AutoMergeScope>();
  for (const file of changedFiles) {
    if (isProtectedAutoMergePath(file)) continue;
    const scope = scopeForPath(file);
    if (scope === null || !autoMerge.allowedScopes.includes(scope)) {
      disallowedFiles.push(file);
    } else {
      scopes.add(scope);
    }
  }
  if (protectedFiles.length > 0) {
    reasons.push(`protected paths detected: ${protectedFiles.join(",")}`);
  }
  if (disallowedFiles.length > 0) {
    reasons.push(`paths outside allowed scopes: ${disallowedFiles.sort().join(",")}`);
  }
  return {
    allowed:
      autoMerge.enabled &&
      changedFiles.length > 0 &&
      protectedFiles.length === 0 &&
      disallowedFiles.length === 0,
    reasons,
    scopes: [...scopes].sort(),
    protectedFiles,
    disallowedFiles: disallowedFiles.sort(),
  };
};

const apiStatusFromError = (stderr: string): number | null => {
  const match = stderr.match(/\bHTTP\s+(\d{3})\b/i);
  return match === null ? null : Number(match[1]);
};

const runGhApi = (
  args: string[],
): { status: number | null; stdout: string; stderr: string; error: string | null } => {
  const result = spawnSync("gh", ["api", ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });
  const stderr = result.stderr ?? "";
  return {
    status: result.error === undefined ? (result.status === 0 ? 200 : apiStatusFromError(stderr)) : null,
    stdout: result.stdout ?? "",
    stderr,
    error: result.error === undefined ? (result.status === 0 ? null : stderr.slice(0, 500)) : String(result.error),
  };
};

const parseJson = <T>(raw: string): T | null => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const repoPath = (repo: string): string => repo.split("/").map(encodeURIComponent).join("/");

const parseRequiredChecks = (value: unknown): RequiredCheck[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry["context"] !== "string" || entry["context"] === "") return [];
    return [{
      context: entry["context"],
      appId: typeof entry["app_id"] === "number" ? entry["app_id"] : null,
    }];
  });
};

const parsePullRequest = (value: unknown): PullRequestSnapshot | null => {
  if (!isRecord(value) || !isRecord(value["head"]) || !isRecord(value["base"])) return null;
  const head = value["head"];
  const base = value["base"];
  if (
    typeof value["number"] !== "number" ||
    typeof value["url"] !== "string" ||
    typeof value["state"] !== "string" ||
    typeof value["merged"] !== "boolean" ||
    typeof head["sha"] !== "string" ||
    typeof base["sha"] !== "string" ||
    typeof base["ref"] !== "string"
  ) {
    return null;
  }
  return {
    number: value["number"],
    url: value["url"],
    state: value["state"].toLowerCase() === "open" ? "open" : "closed",
    merged: value["merged"],
    mergeable: typeof value["mergeable"] === "boolean" ? value["mergeable"] : null,
    draft: value["draft"] === true,
    headSha: head["sha"],
    baseSha: base["sha"],
    baseRef: base["ref"],
  };
};

const parseRepositoryMetadata = (value: unknown): RepositoryMetadata | null => {
  if (!isRecord(value) || typeof value["default_branch"] !== "string") return null;
  return { defaultBranch: value["default_branch"] };
};

const parseProtection = (value: unknown): BranchProtectionRule | null => {
  if (!isRecord(value)) return null;
  const required = value["required_status_checks"];
  if (!isRecord(required)) return { requiredChecks: [], strict: false, enforceAdmins: false };
  const checks = parseRequiredChecks(
    required["checks"] === undefined ? required["contexts"] : required["checks"],
  );
  if (required["checks"] === undefined && Array.isArray(required["contexts"])) {
    for (const context of required["contexts"]) {
      if (typeof context === "string" && !checks.some((item) => item.context === context)) {
        checks.push({ context, appId: null });
      }
    }
  }
  const enforceAdmins = isRecord(value["enforce_admins"]) && value["enforce_admins"]["enabled"] === true;
  return {
    requiredChecks: checks,
    strict: required["strict"] === true,
    enforceAdmins,
  };
};

const parseRulesets = (value: unknown): RepositoryRuleset[] | null => {
  if (!Array.isArray(value)) return null;
  const rulesets: RepositoryRuleset[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const conditions = isRecord(raw["conditions"]) ? raw["conditions"] : null;
    const refName = conditions !== null && isRecord(conditions["ref_name"])
      ? conditions["ref_name"]
      : null;
    const includeRefs =
      refName !== null && Array.isArray(refName["include"])
        ? refName["include"].filter((item): item is string => typeof item === "string")
        : [];
    const excludeRefs =
      refName !== null && Array.isArray(refName["exclude"])
        ? refName["exclude"].filter((item): item is string => typeof item === "string")
        : [];
    const requiredChecks: RequiredCheck[] = [];
    let strict = true;
    let hasRequiredRule = false;
    const rules = Array.isArray(raw["rules"]) ? raw["rules"] : [];
    for (const rawRule of rules) {
      if (!isRecord(rawRule) || rawRule["type"] !== "required_status_checks") continue;
      hasRequiredRule = true;
      const parameters = isRecord(rawRule["parameters"]) ? rawRule["parameters"] : null;
      if (parameters === null || parameters["strict_required_status_checks_policy"] !== true) {
        strict = false;
      }
      const rawChecks = parameters === null ? undefined : parameters["required_status_checks"];
      if (!Array.isArray(rawChecks)) continue;
      for (const rawCheck of rawChecks) {
        if (!isRecord(rawCheck) || typeof rawCheck["context"] !== "string") continue;
        requiredChecks.push({
          context: rawCheck["context"],
          appId: typeof rawCheck["integration_id"] === "number" ? rawCheck["integration_id"] : null,
        });
      }
    }
    rulesets.push({
      id: typeof raw["id"] === "number" ? raw["id"] : -1,
      name: typeof raw["name"] === "string" ? raw["name"] : "",
      target: typeof raw["target"] === "string" ? raw["target"] : "",
      enforcement: typeof raw["enforcement"] === "string" ? raw["enforcement"] : "",
      includeRefs,
      excludeRefs,
      requiredChecks: hasRequiredRule ? requiredChecks : [],
      strict: hasRequiredRule && strict && requiredChecks.length > 0,
      bypassActorCount: Array.isArray(raw["bypass_actors"]) ? raw["bypass_actors"].length : 1,
    });
  }
  return rulesets;
};

const parseRulesetIds = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) return null;
  const pages = value.every((item) => Array.isArray(item)) ? value : [value];
  const ids: number[] = [];
  for (const page of pages) {
    if (!Array.isArray(page)) return null;
    for (const raw of page) {
      if (!isRecord(raw) || typeof raw["id"] !== "number") return null;
      ids.push(raw["id"]);
    }
  }
  return ids;
};

const parseRulesetDetail = (value: unknown): RepositoryRuleset | null => {
  const rulesets = parseRulesets([value]);
  return rulesets?.[0] ?? null;
};

const parseCheckRuns = (value: unknown): CheckRunSnapshot[] | null => {
  if (!isRecord(value) || !Array.isArray(value["check_runs"])) return null;
  const runs: CheckRunSnapshot[] = [];
  for (const raw of value["check_runs"]) {
    if (!isRecord(raw) || typeof raw["name"] !== "string" || typeof raw["status"] !== "string") {
      return null;
    }
    const app = isRecord(raw["app"]) ? raw["app"] : null;
    runs.push({
      name: raw["name"],
      status: raw["status"],
      conclusion: typeof raw["conclusion"] === "string" ? raw["conclusion"] : null,
      headSha: typeof raw["head_sha"] === "string" ? raw["head_sha"] : "",
      appId: app !== null && typeof app["id"] === "number" ? app["id"] : null,
      appSlug: app !== null && typeof app["slug"] === "string" ? app["slug"] : null,
    });
  }
  return runs;
};

const parseStatuses = (value: unknown): CommitStatusSnapshot[] | null => {
  if (!isRecord(value) || !Array.isArray(value["statuses"])) return null;
  const statuses: CommitStatusSnapshot[] = [];
  for (const raw of value["statuses"]) {
    if (!isRecord(raw) || typeof raw["context"] !== "string" || typeof raw["state"] !== "string") {
      return null;
    }
    statuses.push({ context: raw["context"], state: raw["state"] });
  }
  return statuses;
};

const readJson = <T>(
  endpoint: string,
  parser: (value: unknown) => T | null,
  extraArgs: string[] = [],
): GateRead<T> => {
  const result = runGhApi([...extraArgs, endpoint]);
  if (result.status === null || result.status < 200 || result.status >= 300) {
    return { status: result.status, data: null, error: result.error ?? `HTTP ${result.status ?? "unknown"}` };
  }
  const parsed = parseJson<unknown>(result.stdout);
  if (parsed === null) return { status: result.status, data: null, error: "gh api returned invalid JSON" };
  const data = parser(parsed);
  if (data === null) return { status: result.status, data: null, error: "gh api response shape is invalid" };
  return { status: result.status, data, error: null };
};

export const realMergeGatePort: MergeGatePort = {
  getPullRequest: (repo, prNumber) =>
    readJson(`repos/${repoPath(repo)}/pulls/${prNumber}`, parsePullRequest),
  getRepository: (repo) =>
    readJson(`repos/${repoPath(repo)}`, parseRepositoryMetadata),
  getBranchProtection: (repo, baseRef) =>
    readJson(
      `repos/${repoPath(repo)}/branches/${encodeURIComponent(baseRef)}/protection`,
      parseProtection,
    ),
  listRulesets: (repo) => {
    const list = readJson(
      `repos/${repoPath(repo)}/rulesets?per_page=100`,
      parseRulesetIds,
      ["--paginate", "--slurp"],
    );
    if (list.data === null) return { status: list.status, data: null, error: list.error };
    const detailed: RepositoryRuleset[] = [];
    for (const id of list.data) {
      const detail = readJson(
        `repos/${repoPath(repo)}/rulesets/${id}`,
        parseRulesetDetail,
      );
      if (detail.data === null) {
        return {
          status: detail.status ?? list.status,
          data: null,
          error: detail.error ?? `ruleset ${id} detail is unavailable`,
        };
      }
      detailed.push(detail.data);
    }
    return { status: list.status, data: detailed, error: null };
  },
  listCheckRuns: (repo, headSha) =>
    readJson(
      `repos/${repoPath(repo)}/commits/${headSha}/check-runs?filter=latest&per_page=100`,
      parseCheckRuns,
    ),
  getCombinedStatus: (repo, headSha) =>
    readJson(
      `repos/${repoPath(repo)}/commits/${headSha}/status`,
      parseStatuses,
    ),
  mergePullRequest: (input) => {
    const result = runGhApi([
      "--method",
      "PUT",
      `repos/${repoPath(input.repo)}/pulls/${input.prNumber}/merge`,
      "-f",
      `sha=${input.headSha}`,
      "-f",
      "merge_method=merge",
    ]);
    const parsed = parseJson<Record<string, unknown>>(result.stdout);
    const merged = parsed?.["merged"] === true;
    return {
      status: result.status,
      merged,
      mergeCommitSha:
        typeof parsed?.["sha"] === "string" ? parsed["sha"] : null,
      message: typeof parsed?.["message"] === "string" ? parsed["message"] : "",
      error: result.error,
    };
  },
};

const refMatches = (
  pattern: string,
  ref: string,
  defaultBranchRef: string | null,
): boolean => {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") {
    return defaultBranchRef !== null && ref === defaultBranchRef;
  }
  const normalized = pattern.startsWith("refs/") ? pattern : `refs/heads/${pattern}`;
  return globToRegExp(normalized).test(ref);
};

const readable = (status: number | null): boolean =>
  status !== null && status >= 200 && status < 300;

export const isTransientGateRead = (read: GateRead<unknown>): boolean =>
  read.status === null ||
  read.status === 408 ||
  read.status === 425 ||
  read.status === 429 ||
  read.status >= 500;

const describeReadFailure = (name: string, read: GateRead<unknown>): string =>
  `${name} unavailable: status=${read.status ?? "unknown"} ${read.error ?? ""}`.trim();

export const evaluateGithubGate = (input: {
  baseRef: string;
  baseSha: string;
  headSha: string;
  pullRequest: GateRead<PullRequestSnapshot>;
  repository: GateRead<RepositoryMetadata>;
  branchProtection: GateRead<BranchProtectionRule>;
  rulesets: GateRead<RepositoryRuleset[]>;
  checkRuns: GateRead<CheckRunSnapshot[]>;
  statuses: GateRead<CommitStatusSnapshot[]>;
}): GithubEvaluation => {
  const reasons: string[] = [];
  const pendingReasons: string[] = [];
  const readFailure = (
    name: string,
    read: GateRead<unknown>,
  ): void => {
    const reason = describeReadFailure(name, read);
    if (isTransientGateRead(read)) pendingReasons.push(reason);
    else reasons.push(reason);
  };
  const pr = input.pullRequest.data;
  if (!readable(input.pullRequest.status) || pr === null) {
    readFailure("pull request", input.pullRequest);
  } else {
    if (pr.state !== "open") reasons.push(`pull request is ${pr.state}`);
    if (pr.merged) reasons.push("pull request is already merged");
    if (pr.draft) reasons.push("pull request is still a draft");
    if (pr.headSha !== input.headSha) {
      reasons.push(`PR head changed: ${pr.headSha} != audited ${input.headSha}`);
    }
    if (pr.baseSha !== input.baseSha) {
      reasons.push(`PR base changed: ${pr.baseSha} != audited ${input.baseSha}`);
    }
    if (pr.baseRef !== input.baseRef) {
      reasons.push(`PR base ref changed: ${pr.baseRef} != ${input.baseRef}`);
    }
    if (pr.mergeable === null) pendingReasons.push("PR mergeable is still being computed");
    else if (!pr.mergeable) reasons.push("PR mergeable is false");
  }

  const targetRef = `refs/heads/${input.baseRef}`;
  const repository = input.repository.data;
  const repositoryKnown =
    readable(input.repository.status) &&
    repository !== null &&
    repository.defaultBranch !== "";
  const defaultBranchRef =
    repositoryKnown && repository !== null
      ? `refs/heads/${repository.defaultBranch}`
      : null;
  const protection = input.branchProtection.data;
  const protectionValid =
    readable(input.branchProtection.status) &&
    protection !== null &&
    protection.requiredChecks.length > 0 &&
    protection.strict &&
    protection.enforceAdmins;

  const rulesets = input.rulesets.data ?? [];
  const applicableRulesets = rulesets.filter(
    (ruleset) =>
      ruleset.target === "branch" &&
      ruleset.enforcement === "active" &&
      ruleset.includeRefs.some((pattern) => refMatches(pattern, targetRef, defaultBranchRef)) &&
      !ruleset.excludeRefs.some((pattern) => refMatches(pattern, targetRef, defaultBranchRef)),
  );
  const rulesetValid =
    readable(input.rulesets.status) &&
    repositoryKnown &&
    applicableRulesets.some(
      (ruleset) =>
        ruleset.requiredChecks.length > 0 &&
        ruleset.strict &&
        ruleset.bypassActorCount === 0,
    );
  if (!protectionValid && !rulesetValid) {
    const repositoryUnavailable = !repositoryKnown;
    const rulesetsUnavailable =
      !readable(input.rulesets.status) || input.rulesets.data === null;
    const protectionUnavailable =
      input.branchProtection.status !== 404 &&
      (!readable(input.branchProtection.status) || protection === null);
    if (
      (repositoryUnavailable && isTransientGateRead(input.repository)) ||
      (protectionUnavailable && isTransientGateRead(input.branchProtection)) ||
      (rulesetsUnavailable && isTransientGateRead(input.rulesets))
    ) {
      if (repositoryUnavailable) readFailure("repository metadata", input.repository);
      if (protectionUnavailable) readFailure("branch protection", input.branchProtection);
      if (rulesetsUnavailable) readFailure("rulesets", input.rulesets);
    } else if (repositoryUnavailable) {
      reasons.push("repository default branch is unavailable; ruleset coverage is unknown");
    } else {
      reasons.push("no valid GitHub rule provides required checks, strict freshness, and no bypass");
    }
  }

  const requiredCheckBindings = [
    ...(protectionValid ? (protection?.requiredChecks ?? []) : []),
    ...(rulesetValid
      ? applicableRulesets.flatMap((ruleset) => ruleset.requiredChecks)
      : []),
  ];
  const requiredChecks = [...new Set(requiredCheckBindings.map((check) => check.context))].sort();

  const checkRuns = input.checkRuns.data;
  let checksUnavailable = false;
  if (!readable(input.checkRuns.status) || checkRuns === null) {
    checksUnavailable = true;
    readFailure("check runs", input.checkRuns);
  }

  const statuses = input.statuses.data;
  let statusesUnavailable = false;
  if (!readable(input.statuses.status) || statuses === null) {
    statusesUnavailable = true;
    readFailure("commit statuses", input.statuses);
  }

  // 这些 check/status 结果是控制器的合并输入，不是 GitHub 的强制层；
  // required-check 的阻止能力只来自上面的 branch protection/ruleset。
  for (const context of requiredChecks) {
    const bindings = requiredCheckBindings.filter((check) => check.context === context);
    for (const required of bindings) {
      const runs = checksUnavailable
        ? []
        : (checkRuns ?? []).filter(
            (run) =>
              run.name === context &&
              (required.appId === null || run.appId === required.appId),
          );
      const statusMatches =
        !statusesUnavailable && required.appId === null
          ? (statuses ?? []).filter((status) => status.context === context)
          : [];
      if (checksUnavailable && statusesUnavailable) continue;
      if (runs.length === 0 && statusMatches.length === 0) {
        pendingReasons.push(
          `required check ${context} has not registered on ${input.headSha}`,
        );
        continue;
      }
      let succeeded = false;
      let failed = false;
      let pending = false;
      for (const run of runs) {
        if (run.headSha !== "" && run.headSha !== input.headSha) {
          reasons.push(`required check ${context} belongs to ${run.headSha}`);
          failed = true;
          continue;
        }
        if (run.status !== "completed" || run.conclusion === null) {
          pending = true;
          continue;
        }
        if (run.conclusion === "success") succeeded = true;
        else {
          reasons.push(`required check ${context} concluded ${run.conclusion}`);
          failed = true;
        }
      }
      for (const status of statusMatches) {
        if (status.state === "success") succeeded = true;
        else if (status.state === "pending") pending = true;
        else {
          reasons.push(`required status ${context} is ${status.state}`);
          failed = true;
        }
      }
      if (!failed && (!succeeded || pending)) {
        pendingReasons.push(`required check ${context} is not green yet`);
      }
    }
  }

  const uniqueReasons = [...new Set(reasons)];
  const uniquePendingReasons = [...new Set(pendingReasons)];
  return {
    conclusion:
      uniqueReasons.length > 0
        ? "failure"
        : uniquePendingReasons.length > 0
          ? "waiting"
          : "success",
    reasons: uniqueReasons,
    pendingReasons: uniquePendingReasons,
    requiredChecks,
    pullRequest: pr ?? {
      number: 0,
      url: "",
      state: "closed",
      merged: false,
      mergeable: null,
      draft: false,
      headSha: "",
      baseSha: "",
      baseRef: "",
    },
    repository: input.repository,
    branchProtection: input.branchProtection,
    rulesets: input.rulesets,
    checkRuns: input.checkRuns,
    statuses: input.statuses,
  };
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || typeof value === "number";

const isRequiredCheck = (value: unknown): value is RequiredCheck =>
  isRecord(value) &&
  typeof value["context"] === "string" &&
  isNullableNumber(value["appId"]);

const isFindingInput = (value: unknown): value is FindingInput =>
  isRecord(value) &&
  typeof value["severity"] === "string" &&
  typeof value["location"] === "string" &&
  typeof value["what"] === "string" &&
  typeof value["evidence"] === "string" &&
  typeof value["recommendation"] === "string";

const isFindingDisposition = (value: unknown): value is FindingDisposition => {
  if (
    !isRecord(value) ||
    !isRecord(value["finding"]) ||
    typeof value["finding"]["id"] !== "string" ||
    !["zcode", "ocr"].includes(String(value["finding"]["source"])) ||
    !isFindingInput(value["finding"]) ||
    !["allowed", "blocking", "dismissed"].includes(String(value["disposition"])) ||
    typeof value["reason"] !== "string"
  ) {
    return false;
  }
  if (value["matchedRule"] === undefined) return true;
  if (!isRecord(value["matchedRule"]) || typeof value["matchedRule"]["reason"] !== "string") {
    return false;
  }
  const rule = value["matchedRule"];
  return (
    (typeof rule["id"] === "string" && rule["file"] === undefined && rule["pattern"] === undefined) ||
    (rule["id"] === undefined &&
      typeof rule["file"] === "string" &&
      typeof rule["pattern"] === "string")
  );
};

const isAuditEvidence = (value: unknown): value is AuditSourceEvidence => {
  if (
    !isRecord(value) ||
    !["zcode", "ocr"].includes(String(value["source"])) ||
    !["passed", "failed"].includes(String(value["status"])) ||
    !["approved", "changes-requested", "blocked", "error"].includes(String(value["verdict"])) ||
    typeof value["reviewedSha"] !== "string" ||
    typeof value["baseSha"] !== "string" ||
    typeof value["summary"] !== "string" ||
    !Array.isArray(value["findings"]) ||
    !value["findings"].every(isFindingDisposition)
  ) {
    return false;
  }
  if (value["command"] !== undefined) {
    if (
      !isRecord(value["command"]) ||
      !isStringArray(value["command"]["argv"]) ||
      typeof value["command"]["exit"] !== "number"
    ) {
      return false;
    }
  }
  for (const key of [
    "outputPath",
    "sessionId",
    "resolvedBaseSha",
    "resolvedHeadSha",
    "exactRange",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  return true;
};

const isPathPolicyDecision = (value: unknown): value is PathPolicyDecision =>
  isRecord(value) &&
  typeof value["allowed"] === "boolean" &&
  isStringArray(value["reasons"]) &&
  isStringArray(value["scopes"]) &&
  value["scopes"].every((scope) => ["docs", "test", "src"].includes(scope)) &&
  isStringArray(value["protectedFiles"]) &&
  isStringArray(value["disallowedFiles"]);

const isControllerGate = (value: unknown): value is { command: string; exit: number } =>
  isRecord(value) && typeof value["command"] === "string" && typeof value["exit"] === "number";

const isPullRequestSnapshot = (value: unknown): value is PullRequestSnapshot =>
  isRecord(value) &&
  typeof value["number"] === "number" &&
  typeof value["url"] === "string" &&
  ["open", "closed"].includes(String(value["state"])) &&
  typeof value["merged"] === "boolean" &&
  (value["mergeable"] === null || typeof value["mergeable"] === "boolean") &&
  typeof value["draft"] === "boolean" &&
  typeof value["headSha"] === "string" &&
  typeof value["baseSha"] === "string" &&
  typeof value["baseRef"] === "string";

const isRepositoryMetadata = (value: unknown): value is RepositoryMetadata =>
  isRecord(value) &&
  typeof value["defaultBranch"] === "string" &&
  value["defaultBranch"] !== "";

const isBranchProtectionRule = (value: unknown): value is BranchProtectionRule =>
  isRecord(value) &&
  Array.isArray(value["requiredChecks"]) &&
  value["requiredChecks"].every(isRequiredCheck) &&
  typeof value["strict"] === "boolean" &&
  typeof value["enforceAdmins"] === "boolean";

const isRepositoryRuleset = (value: unknown): value is RepositoryRuleset =>
  isRecord(value) &&
  typeof value["id"] === "number" &&
  typeof value["name"] === "string" &&
  typeof value["target"] === "string" &&
  typeof value["enforcement"] === "string" &&
  isStringArray(value["includeRefs"]) &&
  isStringArray(value["excludeRefs"]) &&
  Array.isArray(value["requiredChecks"]) &&
  value["requiredChecks"].every(isRequiredCheck) &&
  typeof value["strict"] === "boolean" &&
  typeof value["bypassActorCount"] === "number";

const isCheckRunSnapshot = (value: unknown): value is CheckRunSnapshot =>
  isRecord(value) &&
  typeof value["name"] === "string" &&
  typeof value["status"] === "string" &&
  isNullableString(value["conclusion"]) &&
  typeof value["headSha"] === "string" &&
  isNullableNumber(value["appId"]) &&
  isNullableString(value["appSlug"]);

const isCommitStatusSnapshot = (value: unknown): value is CommitStatusSnapshot =>
  isRecord(value) && typeof value["context"] === "string" && typeof value["state"] === "string";

const isGateRead = <T>(
  value: unknown,
  isData: (data: unknown) => data is T,
): value is GateRead<T> =>
  isRecord(value) &&
  isNullableNumber(value["status"]) &&
  (value["data"] === null || isData(value["data"])) &&
  isNullableString(value["error"]);

const isGithubEvaluation = (value: unknown): value is GithubEvaluation =>
  isRecord(value) &&
  ["success", "waiting", "failure"].includes(String(value["conclusion"])) &&
  isStringArray(value["reasons"]) &&
  isStringArray(value["pendingReasons"]) &&
  isStringArray(value["requiredChecks"]) &&
  isPullRequestSnapshot(value["pullRequest"]) &&
  isGateRead(value["repository"], isRepositoryMetadata) &&
  isGateRead(value["branchProtection"], isBranchProtectionRule) &&
  isGateRead(
    value["rulesets"],
    (data): data is RepositoryRuleset[] =>
      Array.isArray(data) && data.every(isRepositoryRuleset),
  ) &&
  isGateRead(
    value["checkRuns"],
    (data): data is CheckRunSnapshot[] =>
      Array.isArray(data) && data.every(isCheckRunSnapshot),
  ) &&
  isGateRead(
    value["statuses"],
    (data): data is CommitStatusSnapshot[] =>
      Array.isArray(data) && data.every(isCommitStatusSnapshot),
  );

const isMergeOutcome = (value: unknown): value is NonNullable<MergeEvidence["mergeOutcome"]> =>
  isRecord(value) &&
  typeof value["merged"] === "boolean" &&
  isNullableString(value["mergeCommitSha"]) &&
  typeof value["outboxKey"] === "string" &&
  isNullableNumber(value["status"]);

export const parseMergeEvidence = (raw: string | null): MergeEvidence | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      value["version"] !== 1 ||
      !["audit_only", "merge_ready", "waiting", "manual_only", "blocked", "merged"].includes(
        String(value["stage"]),
      ) ||
      typeof value["repo"] !== "string" ||
      typeof value["issue"] !== "number" ||
      !isNullableNumber(value["prNumber"]) ||
      typeof value["branch"] !== "string" ||
      typeof value["baseRef"] !== "string" ||
      typeof value["baseSha"] !== "string" ||
      typeof value["headSha"] !== "string" ||
      typeof value["issueSnapshotHash"] !== "string" ||
      !isStringArray(value["changedFiles"]) ||
      !isPathPolicyDecision(value["pathPolicy"]) ||
      !isAuditEvidence(value["zcode"]) ||
      !(value["ocr"] === null || isAuditEvidence(value["ocr"])) ||
      !Array.isArray(value["controllerGates"]) ||
      !value["controllerGates"].every(isControllerGate) ||
      !(value["github"] === null || isGithubEvaluation(value["github"])) ||
      !isStringArray(value["reasons"])
    ) {
      return null;
    }
    if (
      value["mergeWaitStartedAt"] !== undefined &&
      !isNullableNumber(value["mergeWaitStartedAt"])
    ) {
      return null;
    }
    if (
      value["finalizationStartedAt"] !== undefined &&
      !isNullableNumber(value["finalizationStartedAt"])
    ) {
      return null;
    }
    if (
      value["mergeOutcome"] !== undefined &&
      !isMergeOutcome(value["mergeOutcome"])
    ) {
      return null;
    }
    return value as unknown as MergeEvidence;
  } catch {
    return null;
  }
};

export const renderMergeEvidence = (evidence: MergeEvidence): string => {
  const findings = [...evidence.zcode.findings, ...(evidence.ocr?.findings ?? [])];
  const lines = [
    `merge stage: ${evidence.stage}`,
    `repo: ${evidence.repo}`,
    `issue: #${evidence.issue}`,
    `pr: ${evidence.prNumber ?? "-"}`,
    `branch: ${evidence.branch}`,
    `base: ${evidence.baseSha} (${evidence.baseRef})`,
    `head: ${evidence.headSha}`,
    `zcode: ${evidence.zcode.verdict} (${evidence.zcode.status})`,
    `ocr: ${evidence.ocr?.verdict ?? "not-run"} (${evidence.ocr?.status ?? "not-run"})`,
    `github conclusion: ${evidence.github?.conclusion ?? "not-evaluated"}`,
    `repository default branch: ${evidence.github?.repository.data?.defaultBranch ?? "unavailable"}`,
    `required checks: ${evidence.github?.requiredChecks.join(", ") || "-"}`,
    `pending reasons: ${evidence.github?.pendingReasons.join("; ") || "-"}`,
    `controller gates: ${evidence.controllerGates.map((gate) => `${gate.command}=${gate.exit}`).join(", ")}`,
    `reasons: ${evidence.reasons.join("; ") || "-"}`,
  ];
  if (findings.length > 0) {
    lines.push("findings:");
    for (const item of findings) {
      lines.push(
        `- [${item.disposition}] ${item.finding.source}/${item.finding.severity} ${item.finding.location}: ${item.finding.what} (${item.reason})`,
      );
    }
  }
  if (evidence.mergeOutcome !== undefined) {
    lines.push(
      `merge outcome: merged=${evidence.mergeOutcome.merged} commit=${evidence.mergeOutcome.mergeCommitSha ?? "-"} status=${evidence.mergeOutcome.status ?? "-"}`,
    );
  }
  return lines.join("\n");
};
