/**
 * issue-worker daemon：reconcile → 选票 → claim → 分支 → run → 门 → 审计 → 交付。
 * 控制面 0 模型调用；模型只在两个 DWF 的 subagent 里。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { IssueWorkerConfig } from "./config.ts";
import { Store, type JobRow } from "./store.ts";
import {
  WORKER_MARKER,
  checkEligibility,
  commentBodyFor,
  getIssueDetail,
  inputDigest,
  isIssueClosed,
  listPullRequestsForBranch,
  listReadyIssues,
  moveIssueLabel,
  outboxKeyFor,
  parseDependsOn,
  prBodyFor,
  projectLabels,
  renderDeliveryEvidence,
  commentIssue as ghCommentIssue,
  createPr as ghCreatePr,
  editPrBody as ghEditPrBody,
  type DeliveryEvidence,
  type DeliveryFinding,
  type IssueDetail,
  type IssueRow,
  type PullRequestRow,
} from "./github.ts";
import {
  assertSha,
  branchFor,
  changedFilesVs,
  checkoutBranch,
  createBranchFrom,
  fetchOrigin,
  gatesForDiff,
  headSha,
  localBranchExists,
  lsRemoteHead,
  mergeOnto,
  originBranchSha,
  parentOfHead,
  protectedDirsChanged,
  pushBranch,
  rebaseOnto,
  runGate,
  worktreeClean,
} from "./git.ts";
import {
  AppServer,
  buildIssueToPrArgs,
  canonicalize,
  classifyAckFailure,
  conversationTopic,
  extractRunIdFromProgress,
  headlessLauncherPrompt,
  isRetryableInfraError,
  loadCommandIds,
  newCommandId,
  persistCommandId,
  providerEnvironment,
  readDwfRun,
  truncateDwfText,
  waitRunSettled,
  WORKFLOW_AUDIT,
  WORKFLOW_IMPLEMENT,
  type AuditorArgs,
  type DwfRunResult,
} from "./zcode.ts";
import {
  evaluateGithubGate,
  evaluatePathPolicy,
  isTransientGateRead,
  parseMergeEvidence,
  renderMergeEvidence,
  runOcrAudit,
  zcodeAuditEvidence,
  type FindingInput as GateFindingInput,
  type MergeEvidence,
  type MergeGatePort,
} from "./merge-gate.ts";

/* ---------------- 端口（单测可注入假实现） ---------------- */

export interface GhPort {
  listReadyIssues: typeof listReadyIssues;
  getIssueDetail: typeof getIssueDetail;
  isIssueClosed: typeof isIssueClosed;
  listPullRequestsForBranch: typeof listPullRequestsForBranch;
  createPr: typeof ghCreatePr;
  editPrBody: typeof ghEditPrBody;
  commentIssue: typeof ghCommentIssue;
  moveIssueLabel: typeof moveIssueLabel;
}

export interface GitPort {
  worktreeClean: typeof worktreeClean;
  headSha: typeof headSha;
  parentOfHead: typeof parentOfHead;
  fetchOrigin: typeof fetchOrigin;
  originBranchSha: typeof originBranchSha;
  localBranchExists: typeof localBranchExists;
  createBranchFrom: typeof createBranchFrom;
  checkoutBranch: typeof checkoutBranch;
  changedFilesVs: typeof changedFilesVs;
  protectedDirsChanged: typeof protectedDirsChanged;
  pushBranch: typeof pushBranch;
  lsRemoteHead: typeof lsRemoteHead;
  rebaseOnto: typeof rebaseOnto;
  mergeOnto: typeof mergeOnto;
  runGate: typeof runGate;
}

export const realGh: GhPort = {
  listReadyIssues,
  getIssueDetail,
  isIssueClosed,
  listPullRequestsForBranch,
  createPr: ghCreatePr,
  editPrBody: ghEditPrBody,
  commentIssue: ghCommentIssue,
  moveIssueLabel,
};

export const realGit: GitPort = {
  worktreeClean,
  headSha,
  parentOfHead,
  fetchOrigin,
  originBranchSha,
  localBranchExists,
  createBranchFrom,
  checkoutBranch,
  changedFilesVs,
  protectedDirsChanged,
  pushBranch,
  lsRemoteHead,
  rebaseOnto,
  mergeOnto,
  runGate,
};

export interface Ctx {
  config: IssueWorkerConfig;
  store: Store;
  gh: GhPort;
  git: GitPort;
  mergeGate: MergeGatePort;
  repoName: string;
}

export const logDirFor = (
  config: IssueWorkerConfig,
  issue: number,
  attempt: number | string,
): string => join(config.stateDir, "runs", String(issue), `attempt-${attempt}`);

const event = (ctx: Ctx, issue: number, kind: string, detail: Record<string, unknown>): void => {
  ctx.store.appendEvent(ctx.repoName, issue, kind, detail);
};

const timeoutOf = (ctx: Ctx): number => ctx.config.timeouts.commandMs;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const parseStringArray = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;

const parseDeliveryFinding = (value: unknown): DeliveryFinding | null => {
  if (!isRecord(value)) return null;
  const { severity, location, what, evidence, recommendation } = value;
  return typeof severity === "string" &&
    typeof location === "string" &&
    typeof what === "string" &&
    typeof evidence === "string" &&
    typeof recommendation === "string"
    ? { severity, location, what, evidence, recommendation }
    : null;
};

const parseDeliveryFindings = (value: unknown): DeliveryFinding[] | null => {
  if (!Array.isArray(value)) return null;
  const findings = value.map(parseDeliveryFinding);
  return findings.every((finding): finding is DeliveryFinding => finding !== null)
    ? findings
    : null;
};

const parseDeliveryEvidence = (raw: string | null): DeliveryEvidence | null => {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || !isRecord(value.audit)) return null;
    const audit = value.audit;
    const commits = parseStringArray(value.commits);
    const changedFiles = parseStringArray(value.changedFiles);
    const notCovered = parseStringArray(value.notCovered);
    const findings = parseDeliveryFindings(audit.findings);
    if (
      typeof value.implementSummary !== "string" ||
      commits === null ||
      changedFiles === null ||
      notCovered === null ||
      audit.verdict !== "approved" ||
      typeof audit.reviewedSha !== "string" ||
      typeof audit.summary !== "string" ||
      findings === null
    ) {
      return null;
    }
    return {
      implementSummary: value.implementSummary,
      commits,
      changedFiles,
      notCovered: [...new Set(notCovered)],
      audit: {
        verdict: audit.verdict,
        reviewedSha: audit.reviewedSha,
        summary: audit.summary,
        findings,
      },
    };
  } catch {
    return null;
  }
};

const pidAlive = (pid: number | null): boolean => {
  if (pid === null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/* ---------------- reconcile ---------------- */

export interface ReconcileOutcome {
  action: string;
  job: JobRow | null;
}

/**
 * 启动时 reconcile（§3.3）+ §7.4 崩溃恢复表的前半段（远端 label 投影）。
 * 返回 continue/blocked/none 语义，调用方据此决定是否领新票。
 */
export const reconcile = (ctx: Ctx): ReconcileOutcome => {
  const { config, store } = ctx;
  const active = store.getActiveJob(ctx.repoName);
  if (active === null) {
    for (const job of store.listJobs(ctx.repoName)) {
      if (!["delivered", "merged", "ready-human", "needs-info", "blocked"].includes(job.stage)) continue;
      let detail: IssueDetail | null = null;
      try {
        detail = ctx.gh.getIssueDetail(ctx.repoName, job.issue, timeoutOf(ctx));
      } catch {
        continue;
      }
      const names = detail.labels.map((label) => label.name);
      if (names.includes(config.labels.inProgress)) {
        const target =
          job.stage === "needs-info" ? config.labels.needsInfo : config.labels.human;
        executeSetLabels(ctx, job.issue, names, config.labels.inProgress, target);
        event(ctx, job.issue, "reconcile-reprojected", { labels: names });
        return { action: "reprojected-to-human", job };
      }
    }
    return { action: "no-active-job", job: null };
  }
  let detail: IssueDetail | null = null;
  try {
    detail = ctx.gh.getIssueDetail(ctx.repoName, active.issue, timeoutOf(ctx));
  } catch (error) {
    event(ctx, active.issue, "reconcile-gh-unreachable", { error: String(error) });
    return { action: "gh-unreachable", job: active };
  }
  if ((detail as IssueDetail).body === undefined) return { action: "gh-unreachable", job: active };
  const names = detail.labels.map((label) => label.name);
  if (
    active.stage === "accepting" &&
    parseMergeEvidence(active.merge_evidence_json)?.stage === "merged"
  ) {
    return { action: "continue", job: active };
  }
  if (active.stage === "delivered" || names.includes(config.labels.inProgress)) {
    if (active.stage === "delivered" && names.includes(config.labels.inProgress)) {
      executeSetLabels(ctx, active.issue, names, config.labels.inProgress, config.labels.human);
      return { action: "reprojected-to-human", job: active };
    }
    return { action: "continue", job: active };
  }
  if (!names.includes(config.labels.inProgress)) {
    // 人工改了 label：尊重人工，停 job
    store.setStage(ctx.repoName, active.issue, "blocked", {
      last_error: `human changed labels to [${names.join(",")}]; job stopped`,
      lease_until: Date.now(),
    });
    event(ctx, active.issue, "reconcile-human-override", { labels: names });
    return { action: "human-override-stopped", job: null };
  }
  return { action: "continue", job: active };
};

/* ---------------- outbox 执行 ---------------- */

const executeSetLabels = (
  ctx: Ctx,
  issue: number,
  current: string[],
  from: string,
  to: string,
): void => {
  const target = projectLabels(current, from, to);
  const key = outboxKeyFor("set_labels", { issue, labelSet: target });
  ctx.store.enqueueOutbox({
    repo: ctx.repoName,
    issue,
    action: "set_labels",
    idempotencyKey: key,
    payload: { from, to, target },
  });
  if (JSON.stringify([...current].sort()) === JSON.stringify([...target].sort())) {
    ctx.store.markOutbox("set_labels", key, "done");
    return;
  }
  try {
    ctx.gh.moveIssueLabel(
      ctx.repoName,
      issue,
      current,
      ctx.config.labels,
      from,
      to,
      timeoutOf(ctx),
    );
    ctx.store.markOutbox("set_labels", key, "done");
  } catch (error) {
    ctx.store.markOutbox("set_labels", key, "failed", String(error));
    throw error;
  }
};

/* ---------------- 选票 ---------------- */

export interface Candidate {
  row: IssueRow;
  detail: IssueDetail;
  mode: "implement" | "rework";
  digest: string;
  jobBranch: string | null;
  jobPrNumber: number | null;
}

export const pickCandidate = (ctx: Ctx, onlyIssue?: number): Candidate | null => {
  const { config, store } = ctx;
  const rows = ctx.gh.listReadyIssues(ctx.repoName, config.labels.ready, timeoutOf(ctx));
  const ordered = [...rows]
    .filter((row) => (onlyIssue === undefined ? true : row.number === onlyIssue))
    .sort((a, b) => a.number - b.number);
  const active = store.getActiveJob(ctx.repoName);
  for (const row of ordered) {
    const detail = ctx.gh.getIssueDetail(ctx.repoName, row.number, timeoutOf(ctx));
    const dependsOn = parseDependsOn(detail.body);
    const openBlockers: number[] = [];
    for (const blocker of [...detail.blockedBy, ...dependsOn]) {
      try {
        if (!ctx.gh.isIssueClosed(ctx.repoName, blocker, timeoutOf(ctx))) {
          if (!openBlockers.includes(blocker)) openBlockers.push(blocker);
        }
      } catch {
        // 依赖状态读不到时按 open 处理，fail closed
        if (!openBlockers.includes(blocker)) openBlockers.push(blocker);
      }
    }
    const existing = store.getJob(ctx.repoName, row.number);
    const branchGuess =
      existing?.branch ?? branchFor(config.branchPrefix, row.number, row.title);
    const pullRequests = ctx.gh.listPullRequestsForBranch(
      ctx.repoName,
      branchGuess,
      timeoutOf(ctx),
    );
    const openPrs = pullRequests.filter((pr) => pr.state === "OPEN");
    const ownClosedUnmerged = pullRequests.find(
      (pr) =>
        pr.state === "CLOSED" &&
        ((existing?.pr_number !== null &&
          existing?.pr_number !== undefined &&
          pr.number === existing.pr_number) ||
          pr.body.includes(WORKER_MARKER)),
    );
    const digest = inputDigest({
      title: detail.title,
      body: detail.body,
      comments: detail.comments,
      updatedAt: detail.updatedAt,
    });
    const digestDelivered =
      existing !== null &&
      (existing.stage === "delivered" || existing.stage === "merged") &&
      existing.input_digest === digest;
    if (existing?.stage === "merged") {
      event(ctx, row.number, "candidate-skipped", { reason: "already-merged" });
      continue;
    }
    const eligibility = checkEligibility({
      issue: row,
      openBlockers,
      jobBranch: existing?.branch ?? null,
      jobPrNumber: existing?.pr_number ?? null,
      openPrs,
      closedUnmergedPrNumber: ownClosedUnmerged?.number ?? null,
      digestDelivered,
      readyLabeled: true,
      hasActiveJob: active !== null && active.issue !== row.number,
      worktreeClean: ctx.git.worktreeClean(config.repo, timeoutOf(ctx)),
    });
    if (!eligibility.ok) {
      event(ctx, row.number, "candidate-skipped", { reason: eligibility.reason });
      continue;
    }
    return {
      row,
      detail,
      mode:
        existing !== null &&
        existing.stage !== "delivered" &&
        existing.branch !== null &&
        existing.head_sha !== null &&
        pullRequests.length === 0
          ? "rework"
          : eligibility.mode,
      digest,
      jobBranch: existing?.branch ?? null,
      jobPrNumber: existing?.pr_number ?? null,
    };
  }
  return null;
};

/* ---------------- run 启动 ---------------- */

export interface RunHandle {
  runId: string;
  sessionId: string | null;
  launchPath: "app-server" | "headless";
  child: ChildProcess | null;
  app: AppServer | null;
}

export interface Launcher {
  startImplement: (
    args: Record<string, unknown>,
    logDir: string,
    runKey: string,
  ) => Promise<RunHandle>;
  startAudit: (
    args: AuditorArgs,
    logDir: string,
    runKey: string,
  ) => Promise<RunHandle>;
  waitSettled: (
    handle: RunHandle,
    input: { timeoutMs: number; runKey: string; names: string[]; argsDigest: string },
  ) => Promise<DwfRunResult>;
  stop: (handle: RunHandle) => void;
}

/** 同一逻辑命令的重试身份：先查落盘，没有才生成，保证重试不产生第二个 run。 */
export const nextCommandId = (logDir: string, key: string): string => {
  const existing = loadCommandIds(logDir)[key];
  if (existing !== undefined) return existing;
  const id = newCommandId();
  persistCommandId(logDir, key, id);
  return id;
};

export class AppServerLauncher implements Launcher {
  private app: AppServer | null = null;
  private launchFailed = false;
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  private ensureApp(): AppServer {
    if (this.app !== null && this.app.running) return this.app;
    const app = new AppServer({
      helperPath: this.ctx.config.zcodeHelper,
      cliPath: this.ctx.config.zcodeCli,
      repo: this.ctx.config.repo,
    });
    app.start();
    this.app = app;
    return app;
  }

  private async startViaAppServer(
    workflow: string,
    args: Record<string, unknown>,
    logDir: string,
    runKey: string,
  ): Promise<RunHandle> {
    const app = this.ensureApp();
    const timeoutMs = this.ctx.config.timeouts.commandMs;
    const log = (line: string): void => {
      try {
        writeFileSync(join(logDir, "v4.log"), `${line}\n`, { flag: "a" });
      } catch {
        // 日志写失败不阻断 run
      }
    };
    const sessionId = await app.createSession(
      timeoutMs,
      nextCommandId(logDir, `${runKey}:createSession`),
    );
    log(`session ${sessionId}`);
    await app.subscribeConversation(
      sessionId,
      nextCommandId(logDir, `${runKey}:subscribe`),
      timeoutMs,
    );
    const started = await app.startSavedWorkflow(
      sessionId,
      nextCommandId(logDir, `${runKey}:start:${workflow}`),
      workflow,
      args,
      timeoutMs,
    );
    log(`run ${started.runId}`);
    return { runId: started.runId, sessionId, launchPath: "app-server", child: null, app };
  }

  private async startViaHeadless(
    workflow: string,
    args: Record<string, unknown>,
    logDir: string,
  ): Promise<RunHandle> {
    const prompt = headlessLauncherPrompt(workflow, JSON.stringify(args));
    const outPath = join(logDir, "headless-stdout.ndjson");
    const errPath = join(logDir, "headless-stderr.log");
    const { createWriteStream } = await import("node:fs");
    const out = createWriteStream(outPath, { flags: "a" });
    const err = createWriteStream(errPath, { flags: "a" });
    const env = providerEnvironment(this.ctx.config.zcodeCli);
    const child = spawn(
      this.ctx.config.zcodeHelper,
      [
        this.ctx.config.zcodeCli,
        "-p",
        prompt,
        "--cwd",
        this.ctx.config.repo,
        "--mode",
        "yolo",
        "--workflow-mode",
        "alwaysOn",
        "--output-format",
        "stream-json",
        "--no-color",
      ],
      { env, detached: true },
    );
    child.stdout?.pipe(out);
    child.stderr?.pipe(err);
    return await new Promise<RunHandle>((resolve, reject) => {
      const rl = createInterface({ input: child.stdout! });
      const stopChild = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGINT");
        } catch {
          child.kill("SIGKILL");
        }
      };
      let launched = false;
      const timer = setTimeout(() => {
        stopChild();
        rl.close();
        reject(new Error("headless launcher produced no runId in time"));
      }, this.ctx.config.timeouts.commandMs);
      timer.unref?.();
      rl.on("line", (line) => {
        const runId = extractRunIdFromProgress(line);
        if (runId !== null) {
          launched = true;
          clearTimeout(timer);
          rl.close();
          resolve({ runId, sessionId: null, launchPath: "headless", child, app: null });
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (!launched) reject(new Error(`headless launcher exited before run-started: ${code}`));
      });
    });
  }

  async startImplement(
    args: Record<string, unknown>,
    logDir: string,
    runKey: string,
  ): Promise<RunHandle> {
    mkdirSync(logDir, { recursive: true });
    if (!this.launchFailed) {
      try {
        return await this.startViaAppServer(WORKFLOW_IMPLEMENT, args, logDir, runKey);
      } catch (error) {
        const failure = (error as { ackFailure?: string }).ackFailure;
        if (failure === "fallback" || isRetryableInfraError(String(error))) {
          if (failure === "fallback") {
            this.launchFailed = true;
            this.app?.stop();
            this.app = null;
          } else throw error;
        } else if (failure === "retryable_launch") {
          throw error;
        } else {
          throw error;
        }
      }
    }
    return this.startViaHeadless(WORKFLOW_IMPLEMENT, args, logDir);
  }

  async startAudit(args: AuditorArgs, logDir: string, runKey: string): Promise<RunHandle> {
    mkdirSync(logDir, { recursive: true });
    const plain = args as unknown as Record<string, unknown>;
    if (!this.launchFailed) {
      try {
        return await this.startViaAppServer(WORKFLOW_AUDIT, plain, logDir, runKey);
      } catch (error) {
        const failure = (error as { ackFailure?: string }).ackFailure;
        if (failure === "fallback") {
          this.launchFailed = true;
          this.app?.stop();
          this.app = null;
        } else throw error;
      }
    }
    return this.startViaHeadless(WORKFLOW_AUDIT, plain, logDir);
  }

  async waitSettled(
    handle: RunHandle,
    input: { timeoutMs: number; runKey: string; names: string[]; argsDigest: string },
  ): Promise<DwfRunResult> {
    const expected = {
      runId: handle.runId,
      cwd: this.ctx.config.repo,
      names: input.names,
      argsDigest: input.argsDigest,
    };
    if (handle.app !== null) {
      return waitRunSettled({
        app: handle.app,
        runId: handle.runId,
        dbPath: this.ctx.config.zcodeDb,
        expected,
        timeoutMs: input.timeoutMs,
      });
    }
    // -p fallback：无订阅，DB 短轮询 + 墙钟裁决
    const deadline = Date.now() + input.timeoutMs;
    let pollMs = 1000;
    while (Date.now() < deadline) {
      let row: DwfRunResult | null = null;
      try {
        row = readDwfRun(this.ctx.config.zcodeDb, expected);
      } catch (error) {
        throw error;
      }
      if (row !== null && row.status !== "running" && row.status !== "pending") return row;
      if (handle.child?.exitCode !== null && handle.child?.exitCode !== undefined && row === null) {
        throw new Error("headless launcher exited without producing a dwf_run");
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
      pollMs = Math.min(5000, pollMs * 2);
    }
    throw new Error(`run ${handle.runId} did not settle within ${input.timeoutMs}ms`);
  }

  stop(handle: RunHandle): void {
    if (handle.launchPath === "app-server" && handle.app !== null) {
      handle.app.stop();
      if (this.app === handle.app) this.app = null;
      return;
    }
    if (handle.launchPath === "headless" && handle.child !== null) {
      try {
        if (handle.child.pid !== undefined) process.kill(-handle.child.pid, "SIGINT");
      } catch {
        try {
          handle.child.kill("SIGKILL");
        } catch {
          // 杀进程失败则由墙钟超时裁决
        }
      }
    }
  }

  shutdown(): void {
    this.app?.stop();
    this.app = null;
  }
}

/* ---------------- 单张 issue 的完整生命周期 ---------------- */

export interface IssueOutcome {
  issue: number;
  final: string;
  detail: string;
}

const failJob = (ctx: Ctx, issue: number, stage: "blocked" | "needs-info" | "ready-human", error: string): IssueOutcome => {
  ctx.store.setStage(ctx.repoName, issue, stage, { last_error: error, lease_until: Date.now() });
  const target =
    stage === "needs-info" ? ctx.config.labels.needsInfo : ctx.config.labels.human;
  try {
    const detail = ctx.gh.getIssueDetail(ctx.repoName, issue, timeoutOf(ctx));
    executeSetLabels(
      ctx,
      issue,
      detail.labels.map((label) => label.name),
      ctx.config.labels.inProgress,
      target,
    );
  } catch (projectionError) {
    event(ctx, issue, "terminal-label-projection-failed", {
      target,
      error: String(projectionError).slice(0, 300),
    });
  }
  event(ctx, issue, "job-terminal", { stage, error });
  return { issue, final: stage, detail: error };
};

const withInfraBackoff = async <T>(
  ctx: Ctx,
  issue: number,
  label: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const backoffs = ctx.config.timeouts.infraBackoffMs;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryableInfraError(String(error))) throw error;
      lastError = error;
      if (attempt >= backoffs.length) break;
      const waitMs = backoffs[attempt]!;
      event(ctx, issue, "infra-backoff", { label, attempt: attempt + 1, waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
};

const gateFindingInputs = (findings: DeliveryFinding[]): GateFindingInput[] =>
  findings.map((finding) => ({
    severity: finding.severity,
    location: finding.location,
    what: finding.what,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
  }));

type ControlledMergeResult =
  | { kind: "merged"; evidence: MergeEvidence }
  | { kind: "waiting"; evidence: MergeEvidence; reason: string }
  | { kind: "blocked"; evidence: MergeEvidence; reason: string };

const controlledMerge = (input: {
  ctx: Ctx;
  candidate: Candidate;
  branch: string;
  baseSha: string;
  head: string;
  prNumber: number;
  changedFiles: string[];
  controllerGates: { command: string; exit: number }[];
  auditEvidence: MergeEvidence;
}): ControlledMergeResult => {
  const { ctx, candidate, branch, baseSha, head, prNumber } = input;
  const { config, store, gh, mergeGate } = ctx;
  const issue = candidate.row.number;
  const timeoutMs = timeoutOf(ctx);
  const outboxKey = outboxKeyFor("merge_pr", { branch, headSha: head });
  const existing = store.getOutbox("merge_pr", outboxKey);
  const pullRequest = mergeGate.getPullRequest(ctx.repoName, prNumber);
  const mergeWaitStartedAt =
    typeof input.auditEvidence.mergeWaitStartedAt === "number"
      ? input.auditEvidence.mergeWaitStartedAt
      : Date.now();
  const waitDeadline = mergeWaitStartedAt + config.timeouts.mergeMs;
  const waiting = (
    pendingReasons: string[],
    github: MergeEvidence["github"],
    mergeOutcome?: NonNullable<MergeEvidence["mergeOutcome"]>,
    baseEvidence: MergeEvidence = input.auditEvidence,
  ): ControlledMergeResult => {
    const uniquePending = [...new Set(pendingReasons)];
    const timeoutReason =
      Date.now() >= waitDeadline
        ? `merge wait timed out after ${config.timeouts.mergeMs}ms`
        : null;
    const evidence: MergeEvidence = {
      ...baseEvidence,
      prNumber,
      stage: timeoutReason === null ? "waiting" : "blocked",
      controllerGates: input.controllerGates,
      github,
      reasons: timeoutReason === null ? uniquePending : [timeoutReason, ...uniquePending],
      mergeWaitStartedAt,
      ...(mergeOutcome === undefined ? {} : { mergeOutcome }),
    };
    store.setStage(ctx.repoName, issue, "accepting", {
      pr_number: prNumber,
      merge_evidence_json: JSON.stringify(evidence),
      lease_until: Date.now() + config.timeouts.leaseMs,
      last_error: timeoutReason,
    });
    const reason = timeoutReason ?? uniquePending.join("; ");
    event(ctx, issue, timeoutReason === null ? "merge-waiting" : "merge-wait-timeout", {
      prNumber,
      headSha: head,
      pendingReasons: uniquePending,
      waitStartedAt: mergeWaitStartedAt,
      waitDeadline,
    });
    return timeoutReason === null
      ? { kind: "waiting", evidence, reason }
      : { kind: "blocked", evidence, reason };
  };
  if (
    existing !== null &&
    pullRequest.data !== null &&
    pullRequest.data.merged &&
    pullRequest.data.headSha === head
  ) {
    store.markOutbox("merge_pr", outboxKey, "done");
    const evidence: MergeEvidence = {
      ...input.auditEvidence,
      prNumber,
      stage: "merged",
      controllerGates: input.controllerGates,
      reasons: [],
      mergeOutcome: {
        merged: true,
        mergeCommitSha: null,
        outboxKey,
        status: pullRequest.status,
      },
    };
    event(ctx, issue, "merge-recovered", {
      prNumber,
      headSha: head,
      outboxKey,
      prStatus: pullRequest.status,
    });
    return { kind: "merged", evidence };
  }
  if (existing?.state === "failed") {
    const evidence: MergeEvidence = {
      ...input.auditEvidence,
      prNumber,
      stage: "blocked",
      reasons: [`previous merge_pr attempt failed: ${existing.last_error ?? "unknown error"}`],
    };
    return { kind: "blocked", evidence, reason: evidence.reasons.join("; ") };
  }
  if (existing?.state === "done") {
    if (pullRequest.data === null) {
      const reason = `pull request unavailable after merge_pr completed: status=${pullRequest.status ?? "unknown"} ${pullRequest.error ?? ""}`.trim();
      if (isTransientGateRead(pullRequest)) {
        return waiting([reason], input.auditEvidence.github);
      }
      const evidence: MergeEvidence = {
        ...input.auditEvidence,
        prNumber,
        stage: "blocked",
        controllerGates: input.controllerGates,
        reasons: [reason],
      };
      return { kind: "blocked", evidence, reason };
    }
    const evidence: MergeEvidence = {
      ...input.auditEvidence,
      prNumber,
      stage: "blocked",
      controllerGates: input.controllerGates,
      reasons: ["merge_pr outbox is done but GitHub does not show the PR as merged"],
    };
    return { kind: "blocked", evidence, reason: evidence.reasons.join("; ") };
  }

  const currentIssue = gh.getIssueDetail(ctx.repoName, issue, timeoutMs);
  const currentIssueHash = inputDigest({
    title: currentIssue.title,
    body: currentIssue.body,
    comments: currentIssue.comments,
    updatedAt: "",
  });
  const repository = mergeGate.getRepository(ctx.repoName);
  const branchProtection = mergeGate.getBranchProtection(ctx.repoName, config.baseBranch);
  const rulesets = mergeGate.listRulesets(ctx.repoName);
  const checkRuns = mergeGate.listCheckRuns(ctx.repoName, head);
  const statuses = mergeGate.getCombinedStatus(ctx.repoName, head);
  const github = evaluateGithubGate({
    baseRef: config.baseBranch,
    baseSha,
    headSha: head,
    pullRequest,
    repository,
    branchProtection,
    rulesets,
    checkRuns,
    statuses,
  });
  const reasons = [...github.reasons];
  const pendingReasons = [...github.pendingReasons];
  try {
    ctx.git.fetchOrigin(config.repo, timeoutMs);
    const latestBase = ctx.git.originBranchSha(config.repo, config.baseBranch, timeoutMs);
    if (latestBase !== baseSha) {
      reasons.push(`base branch changed: ${latestBase} != audited ${baseSha}`);
    }
  } catch (error) {
    pendingReasons.push(`base branch revalidation failed: ${String(error).slice(0, 300)}`);
  }
  try {
    if (!ctx.git.worktreeClean(config.repo, timeoutMs)) {
      reasons.push("worktree is dirty before merge");
    }
    if (ctx.git.headSha(config.repo, timeoutMs) !== head) {
      reasons.push("local HEAD changed before merge");
    }
  } catch (error) {
    reasons.push(`local exact-SHA revalidation failed: ${String(error).slice(0, 300)}`);
  }
  if (input.auditEvidence.zcode.status !== "passed" ||
      input.auditEvidence.zcode.reviewedSha !== head) {
    reasons.push("ZCode audit did not pass the exact head SHA");
  }
  const ocr = input.auditEvidence.ocr;
  if (ocr?.status !== "passed" || ocr?.reviewedSha !== head) {
    reasons.push("OCR audit did not pass the exact head SHA");
  }
  if (!input.auditEvidence.pathPolicy.allowed) {
    reasons.push(...input.auditEvidence.pathPolicy.reasons);
  }
  if (currentIssueHash !== input.auditEvidence.issueSnapshotHash) {
    reasons.push("issue title/body/comments changed after audit");
  }
  if (input.controllerGates.some((gate) => gate.exit !== 0)) {
    reasons.push("controller gate is not green on the audited head SHA");
  }
  const evaluated: MergeEvidence = {
    ...input.auditEvidence,
    prNumber,
    changedFiles: input.changedFiles,
    controllerGates: input.controllerGates,
    github,
    stage:
      reasons.length === 0
        ? pendingReasons.length === 0
          ? "merge_ready"
          : "waiting"
        : "blocked",
    reasons: [...new Set(reasons)],
  };
  store.setStage(ctx.repoName, issue, "accepting", {
    pr_number: prNumber,
    merge_evidence_json: JSON.stringify(evaluated),
  });
  event(ctx, issue, "merge-gate-evaluated", {
    prNumber,
    headSha: head,
    conclusion:
      evaluated.stage === "merge_ready"
        ? "success"
        : evaluated.stage === "waiting"
          ? "waiting"
          : "failure",
    requiredChecks: github.requiredChecks,
    reasons: evaluated.reasons,
    pendingReasons,
  });
  if (evaluated.stage === "waiting") {
    return waiting(pendingReasons, github, undefined, evaluated);
  }
  if (evaluated.stage !== "merge_ready") {
    return { kind: "blocked", evidence: evaluated, reason: evaluated.reasons.join("; ") };
  }

  if (existing === null) {
    store.enqueueOutbox({
      repo: ctx.repoName,
      issue,
      action: "merge_pr",
      idempotencyKey: outboxKey,
      payload: { branch, baseSha, headSha: head, prNumber },
    });
  }
  event(ctx, issue, "merge-started", {
    prNumber,
    baseSha,
    headSha: head,
    outboxKey,
    requiredChecks: github.requiredChecks,
  });
  const merged = mergeGate.mergePullRequest({
    repo: ctx.repoName,
    prNumber,
    headSha: head,
  });
  const reread = mergeGate.getPullRequest(ctx.repoName, prNumber);
  const mergedByRemote =
    reread.data !== null &&
    reread.data.merged &&
    reread.data.headSha === head;
  if ((merged.merged && merged.status !== null && merged.status >= 200 && merged.status < 300) ||
      mergedByRemote) {
    store.markOutbox("merge_pr", outboxKey, "done");
    const finalEvidence: MergeEvidence = {
      ...evaluated,
      stage: "merged",
      reasons: [],
      mergeOutcome: {
        merged: true,
        mergeCommitSha: merged.mergeCommitSha,
        outboxKey,
        status: merged.status,
      },
    };
    event(ctx, issue, "merged", {
      prNumber,
      headSha: head,
      mergeCommitSha: merged.mergeCommitSha,
      outboxKey,
      recoveredFromRemote: mergedByRemote && !merged.merged,
    });
    return { kind: "merged", evidence: finalEvidence };
  }
  const transientMergeFailure =
    merged.status === null ||
    merged.status === 408 ||
    merged.status === 425 ||
    merged.status === 429 ||
    (merged.status !== null && merged.status >= 500);
  if (transientMergeFailure) {
    const reason =
      `merge API outcome is unknown: status=${merged.status ?? "unknown"} ` +
      `${merged.error ?? merged.message}`.trim();
    return waiting([reason], evaluated.github, {
      merged: false,
      mergeCommitSha: null,
      outboxKey,
      status: merged.status,
    }, evaluated);
  }
  store.markOutbox("merge_pr", outboxKey, "failed", merged.error ?? merged.message);
  const reason =
    merged.status === 409 || merged.status === 422
      ? `head SHA changed or PR is no longer mergeable (HTTP ${merged.status}); re-audit required`
      : `merge API failed: status=${merged.status ?? "unknown"} ${merged.error ?? merged.message}`;
  const blocked: MergeEvidence = {
    ...evaluated,
    stage: "blocked",
    reasons: [...evaluated.reasons, reason],
    mergeOutcome: {
      merged: false,
      mergeCommitSha: null,
      outboxKey,
      status: merged.status,
    },
  };
  store.setStage(ctx.repoName, issue, "accepting", {
    merge_evidence_json: JSON.stringify(blocked),
  });
  event(ctx, issue, "merge-refused", {
    prNumber,
    headSha: head,
    status: merged.status,
    reason,
  });
  return { kind: "blocked", evidence: blocked, reason };
};

const finalizeMergedDelivery = (input: {
  ctx: Ctx;
  issue: number;
  branch: string;
  head: string;
  prNumber: number;
  prUrl: string | null;
  deliveryEvidence: DeliveryEvidence;
  mergeEvidence: MergeEvidence;
}): IssueOutcome => {
  const { ctx, issue, branch, head, prNumber, prUrl } = input;
  const timeoutMs = timeoutOf(ctx);
  const finalizationStartedAt =
    typeof input.mergeEvidence.finalizationStartedAt === "number"
      ? input.mergeEvidence.finalizationStartedAt
      : Date.now();
  const deadline = finalizationStartedAt + ctx.config.timeouts.mergeMs;
  const finalizationEvidence: MergeEvidence = {
    ...input.mergeEvidence,
    finalizationStartedAt,
  };
  const timeoutFinalization = (label: string | null): IssueOutcome => {
    const detail = label === null ? "" : ` (${label})`;
    const reason =
      `merged finalization timed out after ${ctx.config.timeouts.mergeMs}ms${detail}`;
    ctx.store.setStage(ctx.repoName, issue, "ready-human", {
      pr_number: prNumber,
      pr_url: prUrl,
      merge_evidence_json: JSON.stringify(finalizationEvidence),
      lease_until: Date.now(),
      last_error: reason,
    });
    event(ctx, issue, "merge-finalization-timeout", {
      label,
      startedAt: finalizationStartedAt,
      deadline,
    });
    return failJob(ctx, issue, "ready-human", reason);
  };
  const retryFinalization = (label: string, error: unknown): IssueOutcome => {
    const detail = String(error).slice(0, 500);
    if (Date.now() >= deadline) return timeoutFinalization(label);
    ctx.store.setStage(ctx.repoName, issue, "accepting", {
      pr_number: prNumber,
      pr_url: prUrl,
      merge_evidence_json: JSON.stringify(finalizationEvidence),
      lease_until: Date.now() + ctx.config.timeouts.leaseMs,
      last_error: `merged finalization pending (${label}): ${detail}`,
    });
    event(ctx, issue, `merge-${label}-failed`, { error: detail });
    return { issue, final: "accepting", detail: `${label}: ${detail}` };
  };
  if (Date.now() >= deadline) return timeoutFinalization(null);
  let currentIssue: IssueDetail;
  try {
    currentIssue = ctx.gh.getIssueDetail(ctx.repoName, issue, timeoutMs);
  } catch (error) {
    return retryFinalization("lookup", error);
  }
  const mergeComment = commentBodyFor({
    issue,
    phase: "merged",
    headSha: head,
    detail: [
      `branch ${branch}`,
      renderDeliveryEvidence(input.deliveryEvidence),
      renderMergeEvidence(input.mergeEvidence),
      `pr ${prUrl ?? ""}`,
    ]
      .filter((section) => section !== "")
      .join("\n\n"),
  });
  const mergeCommentKey = outboxKeyFor("comment_issue", {
    issue,
    phase: "merged",
    headSha: head,
    content: mergeComment,
  });
  try {
    ctx.store.enqueueOutbox({
      repo: ctx.repoName,
      issue,
      action: "comment_issue",
      idempotencyKey: mergeCommentKey,
      payload: { phase: "merged", headSha: head },
    });
    const alreadyCommented = currentIssue.comments.some(
      (comment) => comment.trim() === mergeComment.trim(),
    );
    if (!alreadyCommented) {
      ctx.gh.commentIssue(ctx.repoName, issue, mergeComment, timeoutMs);
    }
    ctx.store.markOutbox("comment_issue", mergeCommentKey, "done");
  } catch (error) {
    return retryFinalization("comment", error);
  }
  try {
    executeSetLabels(
      ctx,
      issue,
      currentIssue.labels.map((label) => label.name),
      ctx.config.labels.inProgress,
      ctx.config.labels.human,
    );
  } catch (error) {
    return retryFinalization("label", error);
  }
  ctx.store.setStage(ctx.repoName, issue, "merged", {
    pr_number: prNumber,
    pr_url: prUrl,
    merge_evidence_json: JSON.stringify(input.mergeEvidence),
    lease_until: Date.now(),
    last_error: null,
  });
  return { issue, final: "merged", detail: prUrl ?? `pr #${prNumber}` };
};

/**
 * 已审计通过的精确 SHA 进入交付。每一步在执行前探测远端，所以进程在
 * push/PR/comment/label 之间退出后，可以从 accepting 阶段安全重放。
 */
export const deliverAcceptedJob = async (
  ctx: Ctx,
  candidate: Candidate,
  branch: string,
  baseSha: string,
  head: string,
): Promise<IssueOutcome> => {
  const { config, store, git } = ctx;
  const issue = candidate.row.number;
  const timeoutMs = timeoutOf(ctx);
  assertSha(head);
  store.setStage(ctx.repoName, issue, "accepting", {
    lease_until: Date.now() + config.timeouts.leaseMs,
  });
  let delivery = 0;
  let deliveryInfraFailures = 0;
  while (delivery < config.maxDeliveryAttempts) {
    delivery += 1;
    const job = store.getJob(ctx.repoName, issue);
    if (job === null) return failJob(ctx, issue, "blocked", "delivery lost job row");
    const evidence = parseDeliveryEvidence(job.evidence_json);
    if (evidence === null || evidence.audit.reviewedSha !== head) {
      return failJob(ctx, issue, "ready-human", "delivery evidence missing or invalid");
    }
    const mergeAudit = parseMergeEvidence(job.merge_evidence_json);
    try {
      git.fetchOrigin(config.repo, timeoutMs);
      const latestMain = git.originBranchSha(config.repo, config.baseBranch, timeoutMs);
      if (latestMain !== baseSha) {
        const alreadyPushed = git.lsRemoteHead(config.repo, branch, timeoutMs) !== null;
        const ok = alreadyPushed
          ? git.mergeOnto(config.repo, `origin/${config.baseBranch}`, timeoutMs)
          : git.rebaseOnto(config.repo, `origin/${config.baseBranch}`, timeoutMs);
        if (!ok) return failJob(ctx, issue, "ready-human", "delivery main integration conflicted");
        const newHead = git.headSha(config.repo, timeoutMs);
        if (newHead !== head) {
          const changed = git.changedFilesVs(config.repo, latestMain, timeoutMs);
          const gates = gatesForDiff(config.gates, changed);
          const rerun = gates.map((gate) =>
            git.runGate(gate, config.repo, config.timeouts.commandMs * 5),
          );
          const red = rerun.filter((gate) => gate.exit !== 0);
          if (red.length > 0) {
            return failJob(
              ctx,
              issue,
              "ready-human",
              `gates red after main integration: ${red.map((gate) => gate.command).join(",")}`,
            );
          }
          return failJob(ctx, issue, "ready-human", "main integration changed sha: needs re-audit");
        }
      }
      const pullRequests = ctx.gh.listPullRequestsForBranch(ctx.repoName, branch, timeoutMs);
      const ownPullRequests = pullRequests.filter(
        (pr) => pr.body.includes(WORKER_MARKER) || pr.number === job.pr_number,
      );
      const closedUnmerged = ownPullRequests.find((pr) => pr.state === "CLOSED");
      if (closedUnmerged !== undefined) {
        return failJob(
          ctx,
          issue,
          "ready-human",
          `previous PR #${closedUnmerged.number} was closed without merge`,
        );
      }
      const merged = ownPullRequests.find((pr) => pr.state === "MERGED");
      if (merged !== undefined) {
        const mergeOutboxKey = outboxKeyFor("merge_pr", { branch, headSha: head });
        const mergeOutbox = store.getOutbox("merge_pr", mergeOutboxKey);
        const exactAudit =
          mergeAudit !== null &&
          mergeAudit.repo === ctx.repoName &&
          mergeAudit.issue === issue &&
          mergeAudit.branch === branch &&
          mergeAudit.baseRef === config.baseBranch &&
          mergeAudit.baseSha === baseSha &&
          mergeAudit.headSha === head &&
          mergeAudit.pathPolicy.allowed &&
          mergeAudit.zcode.status === "passed" &&
          mergeAudit.zcode.reviewedSha === head &&
          mergeAudit.ocr?.status === "passed" &&
          mergeAudit.ocr?.reviewedSha === head;
        if (
          config.autoMerge.enabled &&
          exactAudit &&
          mergeOutbox !== null &&
          mergeAudit !== null
        ) {
          store.markOutbox("merge_pr", mergeOutboxKey, "done");
          const recovered: MergeEvidence =
            mergeAudit.stage === "merged"
              ? { ...mergeAudit, prNumber: merged.number }
              : {
                  ...mergeAudit,
                  prNumber: merged.number,
                  stage: "merged",
                  reasons: [],
                  mergeOutcome: {
                    merged: true,
                    mergeCommitSha: null,
                    outboxKey: mergeOutboxKey,
                    status: null,
                  },
                };
          event(ctx, issue, "merge-recovered", {
            prNumber: merged.number,
            headSha: head,
            outboxKey: mergeOutboxKey,
            source: "list-pull-requests",
          });
          return finalizeMergedDelivery({
            ctx,
            issue,
            branch,
            head,
            prNumber: merged.number,
            prUrl: merged.url,
            deliveryEvidence: evidence,
            mergeEvidence: recovered,
          });
        }
        return failJob(
          ctx,
          issue,
          "ready-human",
          `branch already belongs to merged PR #${merged.number}`,
        );
      }
      if (!git.worktreeClean(config.repo, timeoutMs)) {
        return failJob(ctx, issue, "ready-human", "worktree is dirty before final delivery gates");
      }
      if (git.headSha(config.repo, timeoutMs) !== head) {
        return failJob(ctx, issue, "ready-human", "local HEAD changed before final delivery gates");
      }
      const finalChangedFiles = git.changedFilesVs(config.repo, baseSha, timeoutMs);
      const controllerGates = gatesForDiff(config.gates, finalChangedFiles).map((gate) =>
        git.runGate(gate, config.repo, config.timeouts.commandMs * 5),
      );
      const redControllerGates = controllerGates.filter((gate) => gate.exit !== 0);
      if (redControllerGates.length > 0) {
        return failJob(
          ctx,
          issue,
          "ready-human",
          `final controller gates red on audited head: ${redControllerGates
            .map((gate) => gate.command)
            .join(",")}`,
        );
      }
      store.setStage(ctx.repoName, issue, "accepting", {
        delivery_attempt: Math.max(job.delivery_attempt, delivery),
      });
      const remoteHead = git.lsRemoteHead(config.repo, branch, timeoutMs);
      if (remoteHead !== head) {
        const pushKey = outboxKeyFor("push_branch", { branch, headSha: head });
        store.enqueueOutbox({
          repo: ctx.repoName,
          issue,
          action: "push_branch",
          idempotencyKey: pushKey,
          payload: { branch, headSha: head },
        });
        git.pushBranch(config.repo, branch, timeoutMs);
        store.markOutbox("push_branch", pushKey, "done");
      }
      const readBack = git.lsRemoteHead(config.repo, branch, timeoutMs);
      if (readBack !== head) {
        throw new Error(`ls-remote mismatch: remote=${readBack} local=${head}`);
      }
      const existingPrs = ownPullRequests.filter((pr) => pr.state === "OPEN");
      const body = prBodyFor({
        issue,
        summary: evidence.implementSummary,
        branch,
        baseSha,
        headSha: head,
        gates: controllerGates,
        evidence,
      });
      let prNumber = job.pr_number;
      let prUrl = job.pr_url;
      if (existingPrs.length > 0) {
        const existingPr = existingPrs[0]!;
        prNumber = existingPr.number;
        prUrl = existingPr.url;
        const editKey = outboxKeyFor("edit_pr", { branch, headSha: head, content: body });
        const editOutbox = store.getOutbox("edit_pr", editKey);
        if (existingPr.body === body && editOutbox?.state === "pending") {
          store.markOutbox("edit_pr", editKey, "done");
        } else if (existingPr.body !== body && editOutbox?.state !== "done") {
          store.enqueueOutbox({
            repo: ctx.repoName,
            issue,
            action: "edit_pr",
            idempotencyKey: editKey,
            payload: { prNumber, headSha: head },
          });
          ctx.gh.editPrBody(ctx.repoName, prNumber, body, timeoutMs);
          store.markOutbox("edit_pr", editKey, "done");
        }
      } else {
        const openKey = outboxKeyFor("open_pr", { branch, headSha: head });
        store.enqueueOutbox({
          repo: ctx.repoName,
          issue,
          action: "open_pr",
          idempotencyKey: openKey,
          payload: { branch, headSha: head },
        });
        prUrl = ctx.gh.createPr(ctx.repoName, {
          base: config.baseBranch,
          head: branch,
          title: candidate.row.title,
          body,
          timeoutMs,
        });
        const created = ctx.gh
          .listPullRequestsForBranch(ctx.repoName, branch, timeoutMs)
          .filter((pr) => pr.state === "OPEN");
        prNumber = created[0]?.number ?? prNumber;
        store.markOutbox("open_pr", openKey, "done");
      }
      if (prNumber === null) {
        return failJob(
          ctx,
          issue,
          "ready-human",
          "PR number is unavailable after create/list; refusing remote delivery",
        );
      }
      store.setStage(ctx.repoName, issue, "accepting", { pr_number: prNumber, pr_url: prUrl });
      const currentPathPolicy = evaluatePathPolicy(finalChangedFiles, config.autoMerge);
      if (config.autoMerge.enabled && currentPathPolicy.allowed) {
        if (
          mergeAudit === null ||
          mergeAudit.baseSha !== baseSha ||
          mergeAudit.headSha !== head ||
          mergeAudit.ocr?.status !== "passed"
        ) {
          return failJob(
            ctx,
            issue,
            "ready-human",
            "auto-merge requested but exact-SHA dual-audit evidence is missing",
          );
        }
        const mergeResult = controlledMerge({
          ctx,
          candidate,
          branch,
          baseSha,
          head,
          prNumber,
          changedFiles: finalChangedFiles,
          controllerGates,
          auditEvidence: mergeAudit,
        });
        if (mergeResult.kind === "waiting") {
          return { issue, final: "accepting", detail: mergeResult.reason };
        }
        if (mergeResult.kind === "blocked") {
          return failJob(ctx, issue, "ready-human", mergeResult.reason);
        }
        return finalizeMergedDelivery({
          ctx,
          issue,
          branch,
          head,
          prNumber,
          prUrl,
          deliveryEvidence: evidence,
          mergeEvidence: mergeResult.evidence,
        });
      }
      if (mergeAudit !== null && mergeAudit.stage === "blocked" && currentPathPolicy.allowed) {
        return failJob(
          ctx,
          issue,
          "ready-human",
          mergeAudit.reasons.join("; ") || "auto-merge gate blocked",
        );
      }
      const commentBody = commentBodyFor({
        issue,
        phase: "delivered",
        headSha: head,
        detail: [
          `branch ${branch}`,
          renderDeliveryEvidence(evidence),
          `gates:\n${controllerGates.map((gate) => `- ${gate.command}: exit ${gate.exit}`).join("\n")}`,
          `pr ${prUrl ?? ""}`,
        ]
          .filter((section) => section !== "")
          .join("\n\n"),
      });
      const commentKey = outboxKeyFor("comment_issue", {
        issue,
        phase: "delivered",
        headSha: head,
        content: commentBody,
      });
      store.enqueueOutbox({
        repo: ctx.repoName,
        issue,
        action: "comment_issue",
        idempotencyKey: commentKey,
        payload: { phase: "delivered", headSha: head },
      });
      const outbox = store.getOutbox("comment_issue", commentKey);
      const currentIssue = ctx.gh.getIssueDetail(ctx.repoName, issue, timeoutMs);
      const alreadyCommented = currentIssue.comments.some(
        (comment) => comment.trim() === commentBody.trim(),
      );
      if (outbox?.state !== "done" && !alreadyCommented) {
        ctx.gh.commentIssue(ctx.repoName, issue, commentBody, timeoutMs);
      }
      store.markOutbox("comment_issue", commentKey, "done");
      executeSetLabels(
        ctx,
        issue,
        currentIssue.labels.map((label) => label.name),
        config.labels.inProgress,
        config.labels.human,
      );
      store.setStage(ctx.repoName, issue, "delivered", {
        lease_until: Date.now(),
        last_error: null,
      });
      event(ctx, issue, "delivered", { prNumber, prUrl, head: head.slice(0, 8) });
      return { issue, final: "delivered", detail: prUrl ?? `pr #${prNumber}` };
    } catch (error) {
      event(ctx, issue, "delivery-attempt-failed", {
        delivery,
        error: String(error).slice(0, 300),
      });
      if (isRetryableInfraError(String(error))) {
        deliveryInfraFailures += 1;
        const backoffs = config.timeouts.infraBackoffMs;
        if (deliveryInfraFailures > backoffs.length) {
          return failJob(
            ctx,
            issue,
            "needs-info",
            `delivery infrastructure retries exhausted: ${String(error).slice(0, 300)}`,
          );
        }
        const waitMs = backoffs[deliveryInfraFailures - 1]!;
        event(ctx, issue, "infra-backoff", {
          label: "delivery",
          attempt: deliveryInfraFailures,
          waitMs,
        });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        delivery -= 1;
        continue;
      }
      if (delivery >= config.maxDeliveryAttempts) {
        return failJob(
          ctx,
          issue,
          "ready-human",
          `delivery failed x${delivery}: ${String(error).slice(0, 300)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 30_000));
    }
  }
  return failJob(ctx, issue, "ready-human", "delivery loop fell through");
};

export const runIssueToDelivery = async (
  ctx: Ctx,
  launcher: Launcher,
  candidate: Candidate,
): Promise<IssueOutcome> => {
  const { config, store, git } = ctx;
  const issue = candidate.row.number;
  const timeoutMs = timeoutOf(ctx);

  store.upsertClaim({
    repo: ctx.repoName,
    issue,
    branch: candidate.jobBranch ?? branchFor(config.branchPrefix, issue, candidate.row.title),
    baseSha: "",
    digest: candidate.digest,
    owner: `pid:${process.pid}`,
    leaseUntil: Date.now() + config.timeouts.leaseMs,
    mode: candidate.mode,
  });
  event(ctx, issue, "claimed", { mode: candidate.mode, digest: candidate.digest.slice(0, 16) });
  const fresh = ctx.gh.getIssueDetail(ctx.repoName, issue, timeoutMs);
  executeSetLabels(
    ctx,
    issue,
    fresh.labels.map((label) => label.name),
    config.labels.ready,
    config.labels.inProgress,
  );
  store.setStage(ctx.repoName, issue, "implementing", {
    lease_until: Date.now() + config.timeouts.leaseMs,
  });

  git.fetchOrigin(config.repo, timeoutMs);
  const originMain = git.originBranchSha(config.repo, config.baseBranch, timeoutMs);
  let job = store.getJob(ctx.repoName, issue)!;
  let branch = job.branch!;
  let baseSha = job.base_sha ?? "";
  let previousHeadSha: string | null = job.head_sha ?? null;
  if (candidate.mode === "implement" || branch === "") {
    branch = branchFor(config.branchPrefix, issue, candidate.row.title);
    if (git.localBranchExists(config.repo, branch, timeoutMs)) {
      if (job.head_sha === null) {
        return failJob(
          ctx,
          issue,
          "ready-human",
          `branch exists without daemon commit state: ${branch}`,
        );
      }
      git.checkoutBranch(config.repo, branch, timeoutMs);
      baseSha = originMain;
    } else {
      git.createBranchFrom(config.repo, branch, originMain, timeoutMs);
      baseSha = originMain;
    }
    store.setStage(ctx.repoName, issue, "implementing", { branch, base_sha: baseSha });
  } else {
    git.checkoutBranch(config.repo, branch, timeoutMs);
    baseSha = job.base_sha ?? originMain;
    const touched = git.protectedDirsChanged(config.repo, baseSha, timeoutMs);
    if (touched.length > 0) {
      return failJob(ctx, issue, "ready-human", `protected dirs changed since base: ${touched.join(",")}`);
    }
    if (originMain !== baseSha) {
      const alreadyPushed = git.lsRemoteHead(config.repo, branch, timeoutMs) !== null;
      const ok = alreadyPushed
        ? git.mergeOnto(config.repo, `origin/${config.baseBranch}`, timeoutMs)
        : git.rebaseOnto(config.repo, `origin/${config.baseBranch}`, timeoutMs);
      if (!ok) {
        return failJob(ctx, issue, "ready-human", "integrating latest main conflicted");
      }
      baseSha = originMain;
      previousHeadSha = git.headSha(config.repo, timeoutMs);
      store.setStage(ctx.repoName, issue, "implementing", { base_sha: baseSha });
    }
  }

  const implementArgs = (
    attempt: number,
    feedback?: string,
  ): { args: Record<string, unknown>; digest: string } => {
    const { args, truncated } = buildIssueToPrArgs({
      issue,
      title: candidate.detail.title,
      brief: candidate.detail.body,
      comments: candidate.detail.comments,
      branch,
      baseSha,
      mode: attempt === 1 ? candidate.mode : "rework",
      previousHeadSha: previousHeadSha ?? undefined,
      reviewFeedback: feedback,
    });
    if (truncated) event(ctx, issue, "args-truncated", { attempt });
    return { args: args as unknown as Record<string, unknown>, digest: canonicalize(args) };
  };

  // 实现 attempt 上限跨轮共享（首次 + 返工 ≤ maxImplementAttempts）；infra 退避不消耗轮次。
  let head = "";
  let implementGates: { command: string; exit: number }[] = [];
  let attempt = 0;
  let execution = 0;
  let reviewFeedback: string | undefined = undefined;
  let auditRounds = 0;
  let infraFailures = 0;
  const workspaceStillAt = (sha: string): boolean => {
    try {
      return git.worktreeClean(config.repo, timeoutMs) && git.headSha(config.repo, timeoutMs) === sha;
    } catch {
      return false;
    }
  };
  const beginAttempt = (): IssueOutcome | null => {
    attempt += 1;
    if (attempt > config.maxImplementAttempts) {
      return failJob(ctx, issue, "ready-human", "implement attempts exhausted");
    }
    store.setStage(ctx.repoName, issue, "implementing", {
      implementation_attempt: attempt,
      lease_until: Date.now() + config.timeouts.leaseMs,
    });
    return null;
  };
  const waitAfterInfra = async (label: string): Promise<boolean> => {
    infraFailures += 1;
    const backoffs = config.timeouts.infraBackoffMs;
    if (infraFailures > backoffs.length) return false;
    const waitMs = backoffs[infraFailures - 1]!;
    event(ctx, issue, "infra-backoff", { label, attempt: infraFailures, waitMs });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return true;
  };

  const initialAttempt = beginAttempt();
  if (initialAttempt !== null) return initialAttempt;

  for (;;) {
    execution += 1;
    const built = implementArgs(attempt, reviewFeedback);
    const runKey = `${ctx.repoName}:${issue}:implement:${attempt}:exec:${execution}`;
    const logDir = logDirFor(config, issue, `implement-${attempt}-exec-${execution}`);
    let handle: RunHandle;
    try {
      handle = await withInfraBackoff(ctx, issue, "start-implement", () =>
        launcher.startImplement(built.args, logDir, runKey),
      );
    } catch (error) {
      return failJob(ctx, issue, "needs-info", `launch failed: ${String(error).slice(0, 300)}`);
    }
    store.recordRun({
      run_key: runKey,
      run_id: handle.runId,
      job_repo: ctx.repoName,
      job_issue: issue,
      kind: WORKFLOW_IMPLEMENT,
      session_id: handle.sessionId,
      pid: handle.child?.pid ?? process.pid,
      log_dir: logDir,
      args_json: JSON.stringify(built.args),
      status: "running",
      started_at: Date.now(),
    });
    store.setStage(ctx.repoName, issue, "implementing", {
      run_id: handle.runId,
      run_session_id: handle.sessionId,
      log_dir: logDir,
      lease_until: Date.now() + config.timeouts.implementMs,
    });
    event(ctx, issue, "implement-started", {
      attempt,
      execution,
      runId: handle.runId,
      via: handle.launchPath,
    });
    let settled: DwfRunResult;
    try {
      settled = await launcher.waitSettled(handle, {
        timeoutMs: config.timeouts.implementMs,
        runKey,
        names: [WORKFLOW_IMPLEMENT],
        argsDigest: built.digest,
      });
    } catch (error) {
      launcher.stop(handle);
      return failJob(ctx, issue, "ready-human", `implement run orphan/timeout: ${String(error).slice(0, 300)}`);
    }
    store.recordRun({
      run_key: runKey,
      run_id: handle.runId,
      job_repo: ctx.repoName,
      job_issue: issue,
      kind: WORKFLOW_IMPLEMENT,
      session_id: handle.sessionId,
      pid: handle.child?.pid ?? process.pid,
      log_dir: logDir,
      args_json: JSON.stringify(built.args),
      status: settled.status,
      started_at: Date.now(),
      ended_at: Date.now(),
    });
    event(ctx, issue, "implement-settled", { attempt, execution, status: settled.status });
    const expectedStart = previousHeadSha ?? baseSha;
    const failureText = JSON.stringify(settled.failureJson ?? {});
    const recoverableFailure =
      settled.failureJson?.["code"] === "Interrupted" || isRetryableInfraError(failureText);
    if (settled.status !== "completed" && recoverableFailure) {
      if (!workspaceStillAt(expectedStart)) {
        return failJob(ctx, issue, "ready-human", "retryable implement failure left workspace drift");
      }
      if (!(await waitAfterInfra("implement-run"))) {
        return failJob(ctx, issue, "needs-info", "implement infrastructure retries exhausted");
      }
      continue;
    }
    if (settled.status === "failed") {
      return failJob(ctx, issue, "blocked", `implement failed: ${failureText.slice(0, 500)}`);
    }
    if (settled.status !== "completed" || settled.resultJson === null) {
      return failJob(ctx, issue, "blocked", `implement no result: status=${settled.status}`);
    }
    infraFailures = 0;
    const outcome = settled.resultJson["outcome"];
    if (outcome === "blocked") {
      const blockers = JSON.stringify(settled.resultJson["blockers"] ?? []).slice(0, 500);
      event(ctx, issue, "implement-blocked-retry", { attempt, blockers });
      const next = beginAttempt();
      if (next !== null) return next;
      reviewFeedback = undefined;
      continue;
    }
    const actualHead = git.headSha(config.repo, timeoutMs);
    const parent = git.parentOfHead(config.repo, timeoutMs);
    if (parent !== (previousHeadSha ?? baseSha)) {
      return failJob(
        ctx,
        issue,
        "ready-human",
        `wrong baseline: HEAD^=${parent.slice(0, 8)}`,
      );
    }
    if (!git.worktreeClean(config.repo, timeoutMs)) {
      return failJob(ctx, issue, "ready-human", "implementation left uncommitted changes");
    }
    const protectedChanges = git.protectedDirsChanged(config.repo, baseSha, timeoutMs);
    if (protectedChanges.length > 0) {
      return failJob(
        ctx,
        issue,
        "ready-human",
        `implementation changed protected paths: ${protectedChanges.join(",")}`,
      );
    }
    head = actualHead;
    previousHeadSha = head;
    store.setStage(ctx.repoName, issue, "gating", { head_sha: head });

    // daemon 在精确 SHA 上重跑门
    const changed = git.changedFilesVs(config.repo, baseSha, timeoutMs);
    const gates = gatesForDiff(config.gates, changed);
    implementGates = [];
    let green = true;
    for (const gate of gates) {
      const result = git.runGate(gate, config.repo, config.timeouts.commandMs * 5);
      implementGates.push(result);
      event(ctx, issue, "gate-result", {
        command: result.command,
        exit: result.exit,
        head: head.slice(0, 8),
      });
      if (result.exit !== 0) green = false;
    }
    if (!green) {
      event(ctx, issue, "gates-red-retry", { attempt });
      const next = beginAttempt();
      if (next !== null) return next;
      reviewFeedback = undefined;
      continue;
    }

    // 审计前先对齐最新 main；main 在实现期间前进时，门的结论属于旧 SHA，必须重跑。
    git.fetchOrigin(config.repo, timeoutMs);
    const latestBeforeAudit = git.originBranchSha(config.repo, config.baseBranch, timeoutMs);
    if (latestBeforeAudit !== baseSha) {
      const alreadyPushed = git.lsRemoteHead(config.repo, branch, timeoutMs) !== null;
      const integrated = alreadyPushed
        ? git.mergeOnto(config.repo, `origin/${config.baseBranch}`, timeoutMs)
        : git.rebaseOnto(config.repo, `origin/${config.baseBranch}`, timeoutMs);
      if (!integrated) {
        return failJob(ctx, issue, "ready-human", "pre-audit main integration conflicted");
      }
      const integratedHead = git.headSha(config.repo, timeoutMs);
      if (integratedHead !== head) {
        baseSha = latestBeforeAudit;
        head = integratedHead;
        previousHeadSha = head;
        const changedAfterRebase = git.changedFilesVs(config.repo, baseSha, timeoutMs);
        const gatesAfterIntegration = gatesForDiff(config.gates, changedAfterRebase);
        implementGates = gatesAfterIntegration.map((gate) =>
          git.runGate(gate, config.repo, config.timeouts.commandMs * 5),
        );
        const redAfterIntegration = implementGates.filter((gate) => gate.exit !== 0);
        event(ctx, issue, "pre-audit-main-integration", {
          head: head.slice(0, 8),
          base: baseSha.slice(0, 8),
          gatesRed: redAfterIntegration.length,
        });
        if (redAfterIntegration.length > 0) {
          const next = beginAttempt();
          if (next !== null) return next;
          reviewFeedback = undefined;
          continue;
        }
        store.setStage(ctx.repoName, issue, "gating", {
          base_sha: baseSha,
          head_sha: head,
        });
      }
    }

    auditRounds += 1;
    store.setStage(ctx.repoName, issue, "auditing", {
      rework_round: auditRounds - 1,
      lease_until: Date.now() + config.timeouts.auditMs,
    });
    const auditText = truncateDwfText({
      title: candidate.detail.title,
      brief: candidate.detail.body,
      comments: candidate.detail.comments,
    });
    if (auditText.truncated) event(ctx, issue, "audit-args-truncated", { attempt });
    const auditArgs: AuditorArgs = {
      issue,
      title: auditText.title,
      brief: auditText.brief,
      comments: auditText.comments.join("\n\n---\n\n"),
      baseSha,
      headSha: head,
      gates: implementGates,
    };
    let auditExecution = 0;
    let auditFailures = 0;
    let auditSettled: DwfRunResult;
    for (;;) {
      auditExecution += 1;
      const auditKey = `${ctx.repoName}:${issue}:audit:${attempt}:${auditRounds}:exec:${auditExecution}`;
      const auditLogDir = logDirFor(
        config,
        issue,
        `audit-${attempt}-${auditRounds}-exec-${auditExecution}`,
      );
      let auditHandle: RunHandle;
      try {
        auditHandle = await withInfraBackoff(ctx, issue, "start-audit", () =>
          launcher.startAudit(auditArgs, auditLogDir, auditKey),
        );
      } catch (error) {
        return failJob(ctx, issue, "needs-info", `audit launch failed: ${String(error).slice(0, 300)}`);
      }
      store.recordRun({
        run_key: auditKey,
        run_id: auditHandle.runId,
        job_repo: ctx.repoName,
        job_issue: issue,
        kind: WORKFLOW_AUDIT,
        session_id: auditHandle.sessionId,
        pid: auditHandle.child?.pid ?? process.pid,
        log_dir: auditLogDir,
        args_json: JSON.stringify(auditArgs),
        status: "running",
        started_at: Date.now(),
      });
      try {
        auditSettled = await launcher.waitSettled(auditHandle, {
          timeoutMs: config.timeouts.auditMs,
          runKey: auditKey,
          names: [WORKFLOW_AUDIT],
          argsDigest: canonicalize(auditArgs),
        });
      } catch (error) {
        launcher.stop(auditHandle);
        return failJob(ctx, issue, "ready-human", `audit run orphan/timeout: ${String(error).slice(0, 300)}`);
      }
      store.recordRun({
        run_key: auditKey,
        run_id: auditHandle.runId,
        job_repo: ctx.repoName,
        job_issue: issue,
        kind: WORKFLOW_AUDIT,
        session_id: auditHandle.sessionId,
        pid: auditHandle.child?.pid ?? process.pid,
        log_dir: auditLogDir,
        args_json: JSON.stringify(auditArgs),
        status: auditSettled.status,
        started_at: Date.now(),
        ended_at: Date.now(),
      });
      const auditFailure = JSON.stringify(auditSettled.failureJson ?? {});
      const retryAudit =
        auditSettled.status !== "completed" &&
        (auditSettled.failureJson?.["code"] === "Interrupted" ||
          isRetryableInfraError(auditFailure));
      if (!retryAudit) break;
      if (!workspaceStillAt(head)) {
        return failJob(ctx, issue, "ready-human", "retryable audit failure left workspace drift");
      }
      auditFailures += 1;
      const backoffs = config.timeouts.infraBackoffMs;
      if (auditFailures > backoffs.length) {
        return failJob(ctx, issue, "needs-info", "audit infrastructure retries exhausted");
      }
      const waitMs = backoffs[auditFailures - 1]!;
      event(ctx, issue, "infra-backoff", {
        label: "audit-run",
        attempt: auditFailures,
        waitMs,
      });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    if (auditSettled.status !== "completed" || auditSettled.resultJson === null) {
      return failJob(ctx, issue, "blocked", `audit no result: status=${auditSettled.status}`);
    }
    const verdict = auditSettled.resultJson["verdict"];
    const reviewedSha = (auditSettled.resultJson["reviewedSha"] as string) ?? "";
    event(ctx, issue, "audit-verdict", {
      round: auditRounds,
      verdict,
      reviewedSha: reviewedSha.slice(0, 8),
    });
    if (reviewedSha !== head) {
      return failJob(ctx, issue, "blocked", "auditor reviewed stale sha");
    }
    if (verdict === "approved") {
      const implementSummary = settled.resultJson["summary"];
      const auditSummary = auditSettled.resultJson["summary"];
      const commits = parseStringArray(settled.resultJson["commits"]);
      const changedFiles = parseStringArray(settled.resultJson["changedFiles"]);
      const implementNotCovered = parseStringArray(settled.resultJson["notCovered"]);
      const auditNotCovered = parseStringArray(auditSettled.resultJson["notCovered"]);
      const findings = parseDeliveryFindings(auditSettled.resultJson["findings"]);
      if (
        typeof implementSummary !== "string" ||
        implementSummary.trim() === "" ||
        typeof auditSummary !== "string" ||
        auditSummary.trim() === "" ||
        commits === null ||
        changedFiles === null ||
        implementNotCovered === null ||
        auditNotCovered === null ||
        findings === null
      ) {
        return failJob(
          ctx,
          issue,
          "ready-human",
          "approved workflow returned malformed delivery evidence",
        );
      }
      const evidence: DeliveryEvidence = {
        implementSummary,
        commits,
        changedFiles,
        notCovered: [...new Set([...implementNotCovered, ...auditNotCovered])],
        audit: {
          verdict,
          reviewedSha,
          summary: auditSummary,
          findings,
        },
      };
      const actualChangedFiles = git.changedFilesVs(config.repo, baseSha, timeoutMs);
      const pathPolicy = evaluatePathPolicy(actualChangedFiles, config.autoMerge);
      const zcodeAudit = zcodeAuditEvidence({
        baseSha,
        headSha: head,
        summary: auditSummary,
        findings: gateFindingInputs(findings),
        dismissals: config.autoMerge.dismissals,
      });
      let ocrAudit: MergeEvidence["ocr"] = null;
      let mergeStage: MergeEvidence["stage"] = pathPolicy.allowed
        ? "audit_only"
        : "manual_only";
      const mergeReasons = [...pathPolicy.reasons];
      if (pathPolicy.allowed && zcodeAudit.status !== "passed") {
        mergeStage = "blocked";
        mergeReasons.push("ZCode audit contains blocking findings");
      } else if (pathPolicy.allowed) {
        const ocrLogDir = logDirFor(config, issue, `ocr-${attempt}-${auditRounds}`);
        let ocrFailures = 0;
        for (;;) {
          ocrAudit = runOcrAudit({
            repo: config.repo,
            baseSha,
            headSha: head,
            title: candidate.detail.title,
            body: candidate.detail.body,
            outputPath: join(ocrLogDir, `review-attempt-${ocrFailures + 1}.json`),
            timeoutMs: config.timeouts.ocrMs,
            dismissals: config.autoMerge.dismissals,
            requiredPaths: actualChangedFiles.filter((file) => file.startsWith("src/")),
          });
          event(ctx, issue, "ocr-audit", {
            round: auditRounds,
            attempt: ocrFailures + 1,
            status: ocrAudit.status,
            verdict: ocrAudit.verdict,
            reviewedSha: ocrAudit.reviewedSha.slice(0, 8),
            findings: ocrAudit.findings.length,
            outputPath: ocrAudit.outputPath,
          });
          if (ocrAudit.status === "passed" || !isRetryableInfraError(ocrAudit.summary)) break;
          const backoffs = config.timeouts.infraBackoffMs;
          if (ocrFailures >= backoffs.length) {
            return failJob(
              ctx,
              issue,
              "needs-info",
              `OCR infrastructure retries exhausted: ${ocrAudit.summary}`,
            );
          }
          const waitMs = backoffs[ocrFailures]!;
          ocrFailures += 1;
          event(ctx, issue, "infra-backoff", {
            label: "ocr-audit",
            attempt: ocrFailures,
            waitMs,
          });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        if (ocrAudit.status !== "passed") {
          mergeStage = "blocked";
          mergeReasons.push(`OCR audit failed: ${ocrAudit.summary}`);
        }
      }
      const mergeEvidence: MergeEvidence = {
        version: 1,
        stage: mergeStage,
        repo: ctx.repoName,
        issue,
        prNumber: store.getJob(ctx.repoName, issue)?.pr_number ?? null,
        branch,
        baseRef: config.baseBranch,
        baseSha,
        headSha: head,
        issueSnapshotHash: inputDigest({
          title: candidate.detail.title,
          body: candidate.detail.body,
          comments: candidate.detail.comments,
          updatedAt: "",
        }),
        changedFiles: actualChangedFiles,
        pathPolicy,
        zcode: zcodeAudit,
        ocr: ocrAudit,
        controllerGates: implementGates,
        github: null,
        reasons: mergeReasons,
      };
      store.setStage(ctx.repoName, issue, "auditing", {
        evidence_json: JSON.stringify(evidence),
        merge_evidence_json: JSON.stringify(mergeEvidence),
      });
      if (mergeStage === "blocked") {
        return failJob(ctx, issue, "ready-human", mergeReasons.join("; "));
      }
      break;
    }
    if (verdict === "blocked") {
      return failJob(
        ctx,
        issue,
        "ready-human",
        `audit blocked: ${JSON.stringify(auditSettled.resultJson["findings"] ?? []).slice(0, 500)}`,
      );
    }
    if (auditRounds > 2) return failJob(ctx, issue, "ready-human", "audit changes-requested exhausted");
    reviewFeedback = JSON.stringify(auditSettled.resultJson["findings"] ?? []).slice(0, 8000);
    event(ctx, issue, "audit-changes-requested", { round: auditRounds });
    const next = beginAttempt();
    if (next !== null) return next;
  }
  assertSha(head);
  return deliverAcceptedJob(ctx, candidate, branch, baseSha, head);
};

/* ---------------- 扫描与常驻 ---------------- */

export const scanOnce = async (
  ctx: Ctx,
  launcher: Launcher,
  options: { onlyIssue?: number } = {},
): Promise<string> => {
  const rec = reconcile(ctx);
  if (rec.action === "continue" && rec.job !== null) {
    if (options.onlyIssue !== undefined && options.onlyIssue !== rec.job.issue) {
      return `active job #${rec.job.issue} blocks issue #${options.onlyIssue}`;
    }
    const detail = ctx.gh.getIssueDetail(ctx.repoName, rec.job.issue, timeoutOf(ctx));
    if (rec.job.stage === "accepting") {
      const branch = rec.job.branch;
      const head = rec.job.head_sha;
      const baseSha = rec.job.base_sha;
      if (branch === null || head === null || baseSha === null) {
        const outcome = failJob(
          ctx,
          rec.job.issue,
          "ready-human",
          "accepting job missing branch/head/base",
        );
        return `#${outcome.issue} -> ${outcome.final}: ${outcome.detail}`;
      }
      try {
        ctx.git.checkoutBranch(ctx.config.repo, branch, timeoutOf(ctx));
        if (!ctx.git.worktreeClean(ctx.config.repo, timeoutOf(ctx))) {
          const outcome = failJob(
            ctx,
            rec.job.issue,
            "ready-human",
            "accepting recovery found dirty worktree",
          );
          return `#${outcome.issue} -> ${outcome.final}: ${outcome.detail}`;
        }
        if (ctx.git.headSha(ctx.config.repo, timeoutOf(ctx)) !== head) {
          const outcome = failJob(
            ctx,
            rec.job.issue,
            "ready-human",
            "accepting recovery HEAD mismatch",
          );
          return `#${outcome.issue} -> ${outcome.final}: ${outcome.detail}`;
        }
        const candidate: Candidate = {
          row: detail,
          detail,
          mode: "rework",
          digest: rec.job.input_digest ?? "",
          jobBranch: branch,
          jobPrNumber: rec.job.pr_number,
        };
        const outcome = await deliverAcceptedJob(
          ctx,
          candidate,
          branch,
          baseSha,
          head,
        );
        return `#${outcome.issue} -> ${outcome.final}: ${outcome.detail}`;
      } catch (error) {
        const outcome = failJob(
          ctx,
          rec.job.issue,
          "ready-human",
          `accepting recovery failed: ${String(error).slice(0, 300)}`,
        );
        return `#${outcome.issue} -> ${outcome.final}: ${outcome.detail}`;
      }
    }
    const names = detail.labels.map((label) => label.name);
    if (names.includes(ctx.config.labels.inProgress)) {
      executeSetLabels(
        ctx,
        rec.job.issue,
        names,
        ctx.config.labels.inProgress,
        ctx.config.labels.human,
      );
    }
    const error = `daemon restarted during ${rec.job.stage}; recovered by stopping before any duplicate run`;
    ctx.store.setStage(ctx.repoName, rec.job.issue, "ready-human", {
      last_error: error,
      lease_until: Date.now(),
    });
    event(ctx, rec.job.issue, "restart-recovery-stopped", {
      stage: rec.job.stage,
      runId: rec.job.run_id,
    });
    return `#${rec.job.issue} -> ready-human: ${error}`;
  }
  const candidate = pickCandidate(ctx, options.onlyIssue);
  if (candidate === null) return "no eligible issue";
  let outcome: IssueOutcome;
  try {
    outcome = await runIssueToDelivery(ctx, launcher, candidate);
  } catch (error) {
    outcome = failJob(
      ctx,
      candidate.row.number,
      "blocked",
      `unexpected run failure: ${String(error).slice(0, 500)}`,
    );
  }
  return `#${outcome.issue} -> ${outcome.final}: ${outcome.detail}`;
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
