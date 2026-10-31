/**
 * GitHub 面：gh CLI 只做确定性操作 + 可单测的纯函数。
 * 远端是业务真相之一，DB 只存投影；写操作全部经 outbox 发起，执行前先探测远端。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { IssueWorkerLabels } from "./config.ts";

/** PR/评论里的 daemon 身份标记：DB 丢失后靠它判断 open PR 是否可复用。 */
export const WORKER_MARKER = "<!-- zcode-issue-worker -->";

export interface IssueLabel {
  name: string;
}

export interface IssueRow {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  labels: IssueLabel[];
  blockedBy: number[];
}

export interface IssueDetail extends IssueRow {
  comments: string[];
}

export interface PullRequestRow {
  number: number;
  url: string;
  body: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
}

export interface DeliveryFinding {
  severity: string;
  location: string;
  what: string;
  evidence: string;
  recommendation: string;
}

export interface DeliveryEvidence {
  implementSummary: string;
  commits: string[];
  changedFiles: string[];
  notCovered: string[];
  audit: {
    verdict: string;
    reviewedSha: string;
    summary: string;
    findings: DeliveryFinding[];
  };
}

const ghArgs = (repoName: string): string[] =>
  repoName === "" ? [] : ["--repo", repoName];

/** 同步执行 gh，失败抛错（stderr 前 500 字）。只传 argv，不拼 shell。 */
export const runGh = (args: string[], options: { timeoutMs: number; cwd?: string }): string => {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    cwd: options.cwd,
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${(result.stderr ?? "").slice(0, 500)}`);
  }
  return result.stdout ?? "";
};

export const ghJson = <T>(args: string[], timeoutMs: number, cwd?: string): T =>
  JSON.parse(runGh(args, { timeoutMs, cwd })) as T;

const labelNames = (issue: { labels: IssueLabel[] }): string[] =>
  issue.labels.map((label) => label.name);

/** 正文显式依赖：只认行首 `Depends on: #N`（OpenHands 同语义），大小写不敏感。 */
export const parseDependsOn = (body: string): number[] => {
  const found: number[] = [];
  for (const match of body.matchAll(/^[ \t]*Depends on:[ \t]*#(\d+)/gim)) {
    const n = Number(match[1]);
    if (!found.includes(n)) found.push(n);
  }
  return found;
};

export interface EligibilityInput {
  issue: IssueRow;
  openBlockers: number[];
  jobBranch: string | null;
  jobPrNumber: number | null;
  openPrs: { number: number; url: string; body: string }[];
  closedUnmergedPrNumber: number | null;
  digestDelivered: boolean;
  readyLabeled: boolean;
  hasActiveJob: boolean;
  worktreeClean: boolean;
}

export type Eligibility =
  | { ok: true; mode: "implement" | "rework" }
  | { ok: false; reason: string };

/**
 * 选票（纯函数）：依赖 → open PR 去重/返工 → digest 去重 → active job → 工作区干净。
 * 顺序即 fail-closed 优先级，reason 供 event 记录。
 */
export const checkEligibility = (input: EligibilityInput): Eligibility => {
  const { issue } = input;
  if (input.openBlockers.length > 0) {
    return { ok: false, reason: `blocked-by:${input.openBlockers.join(",")}` };
  }
  if (input.closedUnmergedPrNumber !== null && input.closedUnmergedPrNumber !== undefined) {
    return { ok: false, reason: `closed-unmerged-pr:${input.closedUnmergedPrNumber}` };
  }
  if (input.openPrs.length > 0) {
    const reusable = input.openPrs.find(
      (pr) =>
        (input.jobPrNumber !== null && pr.number === input.jobPrNumber) ||
        pr.body.includes(WORKER_MARKER),
    );
    if (reusable !== undefined && input.readyLabeled && input.jobBranch !== null) {
      return { ok: true, mode: "rework" };
    }
    return { ok: false, reason: `open-pr:${input.openPrs.map((pr) => pr.number).join(",")}` };
  }
  if (input.digestDelivered && !input.readyLabeled) {
    return { ok: false, reason: `digest-delivered:${issue.number}` };
  }
  if (input.hasActiveJob) return { ok: false, reason: "another-active-job" };
  if (!input.worktreeClean) return { ok: false, reason: "dirty-worktree" };
  return { ok: true, mode: "implement" };
};

export const inputDigest = (input: {
  title: string;
  body: string;
  comments: string[];
  updatedAt: string;
}): string =>
  createHash("sha256")
    .update(JSON.stringify([input.title, input.body, input.comments, input.updatedAt]))
    .digest("hex");

export const projectLabels = (current: string[], from: string, to: string): string[] => {
  if (from === to) return [...new Set(current)].sort();
  const next = current.filter((name) => name !== from);
  if (next.includes(to)) return [...new Set(next)].sort();
  return [...new Set([...next, to])].sort();
};

export const hasLabel = (issue: { labels: IssueLabel[] }, name: string): boolean =>
  labelNames(issue).includes(name);

export const outboxKeyFor = (
  action: "push_branch" | "open_pr" | "edit_pr" | "comment_issue" | "set_labels" | "merge_pr",
  parts: { branch?: string; headSha?: string; issue?: number; phase?: string; content?: string; labelSet?: string[] },
): string => {
  switch (action) {
    case "push_branch":
      return `${parts.branch}:${parts.headSha}`;
    case "open_pr":
      return `${parts.branch}:${parts.headSha}`;
    case "merge_pr":
      return `${parts.branch}:${parts.headSha}`;
    case "edit_pr": {
      const digest = createHash("sha256").update(parts.content ?? "").digest("hex").slice(0, 16);
      return `${parts.branch}:${parts.headSha}:${digest}`;
    }
    case "comment_issue": {
      const digest = createHash("sha256").update(parts.content ?? "").digest("hex").slice(0, 16);
      return `${parts.issue}:${parts.phase}:${parts.headSha}:${digest}`;
    }
    case "set_labels": {
      const digest = createHash("sha256")
        .update(JSON.stringify([...(parts.labelSet ?? [])].sort()))
        .digest("hex")
        .slice(0, 16);
      return `${parts.issue}:${digest}`;
    }
  }
};

export const GITHUB_BODY_LIMIT = 60_000;
const EVIDENCE_BODY_LIMIT = 48_000;

const fitGitHubText = (text: string, limit: number, noun: string): string => {
  if (text.length <= limit) return text;
  const notice = `\n\n[${noun} truncated to ${limit} characters. Full data remains in the daemon state database.]`;
  return text.slice(0, Math.max(0, limit - notice.length)).concat(notice);
};

const safeEvidenceText = (text: string): string =>
  text.replace(
    /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b(\s*:?\s*)((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)?\s*(#|GH-)(?=\d+)/gi,
    (
      _match,
      keyword: string,
      separator: string,
      repository: string | undefined,
      token: string,
    ) =>
      `${keyword}${separator}${repository ?? ""}${token === "#" ? "\\#" : "GH\\-"}`,
  );

const omittedLine = (shown: number, total: number, noun: string): string[] =>
  total > shown ? [`- ${total - shown} more ${noun} not shown`] : [];

export const renderDeliveryEvidence = (
  evidence: DeliveryEvidence,
  limit = EVIDENCE_BODY_LIMIT,
): string => {
  const findings = evidence.audit.findings.slice(0, 20).flatMap((finding) => [
    `- ${safeEvidenceText(finding.severity)}: ${safeEvidenceText(finding.location)}`,
    `  What: ${safeEvidenceText(finding.what)}`,
    `  Evidence: ${safeEvidenceText(finding.evidence)}`,
    `  Recommendation: ${safeEvidenceText(finding.recommendation)}`,
  ]);
  findings.push(...omittedLine(20, evidence.audit.findings.length, "findings"));
  const changedFiles = evidence.changedFiles
    .slice(0, 50)
    .map((path) => `- ${safeEvidenceText(path)}`);
  changedFiles.push(...omittedLine(50, evidence.changedFiles.length, "changed files"));
  const notCovered = evidence.notCovered
    .slice(0, 20)
    .map((item) => `- ${safeEvidenceText(item)}`);
  notCovered.push(...omittedLine(20, evidence.notCovered.length, "not-covered items"));
  const rendered = [
    `## Implementation\n\n${safeEvidenceText(evidence.implementSummary)}`,
    evidence.commits.length === 0
      ? ""
      : `Commits:\n${evidence.commits.map((sha) => `- ${safeEvidenceText(sha)}`).join("\n")}`,
    changedFiles.length === 0 ? "" : `Changed files:\n${changedFiles.join("\n")}`,
    `## Audit\n\n${safeEvidenceText(evidence.audit.verdict)} at ${safeEvidenceText(evidence.audit.reviewedSha)}\n${safeEvidenceText(evidence.audit.summary)}`,
    findings.length === 0 ? "" : `### Findings\n\n${findings.join("\n")}`,
    notCovered.length === 0 ? "" : `## Not covered\n\n${notCovered.join("\n")}`,
  ]
    .filter((section) => section !== "")
    .join("\n\n");
  return fitGitHubText(rendered, limit, "Delivery evidence");
};

export const prBodyFor = (input: {
  issue: number;
  summary: string;
  branch: string;
  baseSha: string;
  headSha: string;
  gates: { command: string; exit: number }[];
  evidence?: DeliveryEvidence;
}): string => {
  const gates = input.gates.map((gate) => `- ${gate.command}: exit ${gate.exit}`).join("\n");
  return [
    input.evidence === undefined
      ? safeEvidenceText(input.summary)
      : renderDeliveryEvidence(input.evidence),
    `Closes #${input.issue}`,
    WORKER_MARKER,
    `issue: ${input.issue}\nbranch: ${input.branch}\nbase: ${input.baseSha}\nhead: ${input.headSha}\ngates:\n${gates}`,
  ]
    .filter((section) => section !== "")
    .join("\n\n")
    .concat("\n");
};

export const commentBodyFor = (input: {
  issue: number;
  phase: string;
  headSha: string;
  detail: string;
}): string => {
  const header = `${WORKER_MARKER}\nissue-worker ${input.phase}: #${input.issue} @ ${input.headSha}`;
  const detailLimit = GITHUB_BODY_LIMIT - header.length - 3;
  return `${header}\n\n${fitGitHubText(input.detail, detailLimit, "Delivery detail")}\n`;
};

/* ---------------- 远端读写（确定性 gh 调用） ---------------- */

export const listReadyIssues = (
  repoName: string,
  readyLabel: string,
  timeoutMs: number,
): IssueRow[] => {
  const fields = "number,title,body,updatedAt,labels,blockedBy";
  let raw: unknown[];
  try {
    raw = ghJson<unknown[]>(
      [...ghArgs(repoName), "issue", "list", "--state", "open", "--label", readyLabel,
        "--limit", "200", "--json", fields],
      timeoutMs,
    );
  } catch {
    // 旧版 gh 不认 blockedBy 时降级：原生依赖检查跳过，正文 Depends on 仍生效
    raw = ghJson<unknown[]>(
      [...ghArgs(repoName), "issue", "list", "--state", "open", "--label", readyLabel,
        "--limit", "200", "--json", "number,title,body,updatedAt,labels"],
      timeoutMs,
    );
  }
  return (raw as Record<string, unknown>[]).map((row) => ({
    number: row["number"] as number,
    title: (row["title"] as string) ?? "",
    body: (row["body"] as string) ?? "",
    updatedAt: (row["updatedAt"] as string) ?? "",
    labels: ((row["labels"] as IssueLabel[]) ?? []).map((label) => ({ name: label.name })),
    blockedBy: ((): number[] => {
      const blocked = row["blockedBy"] as { nodes?: { number?: number }[] } | undefined;
      if (blocked === undefined || !Array.isArray(blocked.nodes)) return [];
      return blocked.nodes
        .map((node) => node.number)
        .filter((n): n is number => typeof n === "number");
    })(),
  }));
};

export const getIssueDetail = (
  repoName: string,
  issue: number,
  timeoutMs: number,
): IssueDetail => {
  const row = ghJson<Record<string, unknown>>(
    [...ghArgs(repoName), "issue", "view", String(issue), "--json",
      "number,title,body,updatedAt,labels,comments,blockedBy"],
    timeoutMs,
  );
  const comments = ((row["comments"] as { body?: string }[]) ?? []).map((c) => c.body ?? "");
  const blocked = row["blockedBy"] as { nodes?: { number?: number }[] } | undefined;
  return {
    number: row["number"] as number,
    title: (row["title"] as string) ?? "",
    body: (row["body"] as string) ?? "",
    updatedAt: (row["updatedAt"] as string) ?? "",
    labels: ((row["labels"] as IssueLabel[]) ?? []).map((label) => ({ name: label.name })),
    blockedBy:
      blocked !== undefined && Array.isArray(blocked.nodes)
        ? blocked.nodes
            .map((node) => node.number)
            .filter((n): n is number => typeof n === "number")
        : [],
    comments,
  };
};

export const isIssueClosed = (repoName: string, issue: number, timeoutMs: number): boolean => {
  const row = ghJson<{ state?: string }>(
    [...ghArgs(repoName), "issue", "view", String(issue), "--json", "state"],
    timeoutMs,
  );
  return row.state === "CLOSED";
};

export const listPullRequestsForBranch = (
  repoName: string,
  branch: string,
  timeoutMs: number,
): PullRequestRow[] => {
  const rows = ghJson<
    Array<Omit<PullRequestRow, "state"> & { state: string; mergedAt: string | null }>
  >(
    [...ghArgs(repoName), "pr", "list", "--head", branch, "--state", "all", "--limit", "100",
      "--json", "number,url,body,state,mergedAt"],
    timeoutMs,
  );
  return rows.map((row) => ({
    ...row,
    state:
      row.state === "OPEN"
        ? "OPEN"
        : row.state === "MERGED" || row.mergedAt !== null
          ? "MERGED"
          : "CLOSED",
  }));
};

export const createPr = (
  repoName: string,
  input: { base: string; head: string; title: string; body: string; timeoutMs: number },
): string =>
  runGh(
    [...ghArgs(repoName), "pr", "create", "--base", input.base, "--head", input.head,
      "--title", input.title, "--body", input.body],
    { timeoutMs: input.timeoutMs },
  ).trim();

export const editPrBody = (
  repoName: string,
  prNumber: number,
  body: string,
  timeoutMs: number,
): void => {
  runGh([...ghArgs(repoName), "pr", "edit", String(prNumber), "--body", body], { timeoutMs });
};

export const commentIssue = (
  repoName: string,
  issue: number,
  body: string,
  timeoutMs: number,
): void => {
  runGh([...ghArgs(repoName), "issue", "comment", String(issue), "--body", body], {
    timeoutMs,
  });
};

export const setIssueLabels = (
  repoName: string,
  issue: number,
  current: string[],
  target: string[],
  timeoutMs: number,
): void => {
  const currentSet = new Set(current);
  const targetSet = new Set(target);
  const add = [...targetSet].filter((name) => !currentSet.has(name));
  const remove = [...currentSet].filter((name) => !targetSet.has(name));
  if (add.length === 0 && remove.length === 0) return;
  const args = [...ghArgs(repoName), "issue", "edit", String(issue)];
  for (const name of add) args.push("--add-label", name);
  for (const name of remove) args.push("--remove-label", name);
  runGh(args, { timeoutMs });
};

export const moveIssueLabel = (
  repoName: string,
  issue: number,
  current: string[],
  labels: IssueWorkerLabels,
  from: string,
  to: string,
  timeoutMs: number,
): void => {
  const target = projectLabels(current, from, to);
  setIssueLabels(repoName, issue, current, target, timeoutMs);
};

export const resolveRepoName = (cwd: string, timeoutMs: number): string => {
  const row = ghJson<{ nameWithOwner?: string }>(
    ["repo", "view", "--json", "nameWithOwner"],
    timeoutMs,
    cwd,
  );
  if (row.nameWithOwner === undefined || row.nameWithOwner === "") {
    throw new Error(`cannot resolve repo name in ${cwd}`);
  }
  return row.nameWithOwner;
};
