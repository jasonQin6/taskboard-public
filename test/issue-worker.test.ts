/**
 * issue-worker 单测：只断言外部可观察行为（选票、摘要、投影、幂等键、帧、
 * 截断、超时、恢复、一条真实 git 交付链），不锁实现细节。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildConfig, defaultConfig } from "../tools/issue-worker/config.ts";
import { Store, acquireSingletonLock, leaseAlive, stateDbPathFor } from "../tools/issue-worker/store.ts";
import {
  GITHUB_BODY_LIMIT,
  WORKER_MARKER,
  checkEligibility,
  commentBodyFor,
  inputDigest,
  outboxKeyFor,
  parseDependsOn,
  prBodyFor,
  projectLabels,
  renderDeliveryEvidence,
  type DeliveryEvidence,
} from "../tools/issue-worker/github.ts";
import {
  assertBranch,
  assertSha,
  branchFor,
  gatesForDiff,
  slugify,
  headSha as gitHeadSha,
} from "../tools/issue-worker/git.ts";
import * as gitMod from "../tools/issue-worker/git.ts";
import {
  AppServer,
  DEFAULT_SESSION_RUNTIME_PREFERENCES,
  buildIssueToPrArgs,
  canonicalize,
  classifyAckFailure,
  classifyLine,
  conversationTopic,
  extractRunIdFromProgress,
  frameCommand,
  isRetryableInfraError,
  isRunSettledEvent,
  newCommandId,
  parseAck,
  persistCommandId,
  providerEnvironment,
  loadCommandIds,
  readDwfRun,
  truncateDwfText,
  waitRunSettled,
} from "../tools/issue-worker/zcode.ts";
import {
  nextCommandId,
  pickCandidate,
  reconcile,
  deliverAcceptedJob,
  runIssueToDelivery,
  scanOnce,
  realGit,
  type Ctx,
  type GhPort,
  type RunHandle,
} from "../tools/issue-worker/daemon.ts";
import {
  evaluateFindings,
  evaluateGithubGate,
  evaluatePathPolicy,
  parseOcrReview,
  parseMergeEvidence,
  realMergeGatePort,
  renderMergeEvidence,
  runOcrAudit,
  type CheckRunSnapshot,
  type MergeApiResult,
  type MergeEvidence,
  type MergeGatePort,
  type RepositoryRuleset,
} from "../tools/issue-worker/merge-gate.ts";

/* ---------------- 选票 ---------------- */

test("depends-on only matches explicit 'Depends on: #N' lines", () => {
  assert.deepEqual(parseDependsOn("Depends on: #12"), [12]);
  assert.deepEqual(parseDependsOn("  depends on: #3 and #4\nDepends on: #3"), [3]);
  assert.deepEqual(parseDependsOn("see also #12, related to #13"), []);
  assert.deepEqual(parseDependsOn("Depends on #12"), []);
});

test("eligibility: native blocker rejects first", () => {
  const base = {
    issue: { number: 7, title: "t", body: "", updatedAt: "", labels: [], blockedBy: [] },
    jobBranch: null,
    jobPrNumber: null,
    openPrs: [],
    closedUnmergedPrNumber: null,
    openBlockers: [],
    digestDelivered: false,
    readyLabeled: true,
    hasActiveJob: false,
    worktreeClean: true,
  };
  assert.deepEqual(checkEligibility({ ...base, openBlockers: [3] }), {
    ok: false,
    reason: "blocked-by:3",
  });
  assert.deepEqual(checkEligibility(base), { ok: true, mode: "implement" });
});

test("eligibility: open PR blocks unless marker rework", () => {
  const base = {
    issue: { number: 7, title: "t", body: "", updatedAt: "", labels: [], blockedBy: [] },
    openBlockers: [],
    digestDelivered: false,
    readyLabeled: true,
    hasActiveJob: false,
    worktreeClean: true,
  };
  const blocked = checkEligibility({
    ...base,
    jobBranch: "issue-7-x",
    jobPrNumber: null,
    openPrs: [{ number: 9, url: "u", body: "no marker" }],
    closedUnmergedPrNumber: null,
  });
  assert.deepEqual(blocked, { ok: false, reason: "open-pr:9" });
  const rework = checkEligibility({
    ...base,
    jobBranch: "issue-7-x",
    jobPrNumber: null,
    openPrs: [{ number: 9, url: "u", body: `x\n${WORKER_MARKER}\n` }],
    closedUnmergedPrNumber: null,
  });
  assert.deepEqual(rework, { ok: true, mode: "rework" });
});

test("eligibility: a daemon-owned closed unmerged PR blocks a second PR", () => {
  const base = {
    issue: { number: 7, title: "t", body: "", updatedAt: "", labels: [], blockedBy: [] },
    openBlockers: [],
    jobBranch: "issue-7-x",
    jobPrNumber: 9,
    openPrs: [],
    closedUnmergedPrNumber: 9,
    digestDelivered: false,
    readyLabeled: true,
    hasActiveJob: false,
    worktreeClean: true,
  };
  assert.deepEqual(checkEligibility(base), {
    ok: false,
    reason: "closed-unmerged-pr:9",
  });
});

test("eligibility: digest dedup, active job, dirty tree", () => {
  const base = {
    issue: { number: 7, title: "t", body: "", updatedAt: "", labels: [], blockedBy: [] },
    openBlockers: [],
    jobBranch: null,
    jobPrNumber: null,
    openPrs: [],
    closedUnmergedPrNumber: null,
    digestDelivered: false,
    readyLabeled: false,
    hasActiveJob: false,
    worktreeClean: true,
  };
  assert.deepEqual(checkEligibility({ ...base, digestDelivered: true }), {
    ok: false,
    reason: "digest-delivered:7",
  });
  assert.deepEqual(checkEligibility({ ...base, hasActiveJob: true }), {
    ok: false,
    reason: "another-active-job",
  });
  assert.deepEqual(checkEligibility({ ...base, worktreeClean: false }), {
    ok: false,
    reason: "dirty-worktree",
  });
});

/* ---------------- 摘要 / label / 幂等键 ---------------- */

test("inputDigest is stable and sensitive to body", () => {
  const input = { title: "t", body: "b", comments: ["c"], updatedAt: "u" };
  const again = { title: "t", body: "b", comments: ["c"], updatedAt: "u" };
  assert.equal(inputDigest(input), inputDigest(again));
  assert.match(inputDigest(input), /^[0-9a-f]{64}$/);
  assert.notEqual(inputDigest(input), inputDigest({ ...input, body: "b2" }));
});

test("projectLabels replaces as a set and stays idempotent", () => {
  assert.deepEqual(projectLabels(["ready-for-agent", "x"], "ready-for-agent", "in-progress"), [
    "in-progress",
    "x",
  ]);
  assert.deepEqual(projectLabels(["in-progress"], "ready-for-agent", "in-progress"), [
    "in-progress",
  ]);
  assert.deepEqual(projectLabels(["a"], "ready-for-agent", "ready-for-human"), [
    "a",
    "ready-for-human",
  ]);
  assert.deepEqual(projectLabels(["in-progress", "x"], "in-progress", "in-progress"), [
    "in-progress",
    "x",
  ]);
});

test("outbox keys follow the delivery contract", () => {
  assert.equal(outboxKeyFor("push_branch", { branch: "b", headSha: "h" }), "b:h");
  assert.equal(
    outboxKeyFor("push_branch", { branch: "b", headSha: "h" }),
    outboxKeyFor("open_pr", { branch: "b", headSha: "h" }),
  );
  assert.notEqual(
    outboxKeyFor("push_branch", { branch: "b", headSha: "h1" }),
    outboxKeyFor("push_branch", { branch: "b", headSha: "h2" }),
  );
  const comment = (phase: string): string =>
    outboxKeyFor("comment_issue", { issue: 7, phase, headSha: "h", content: "same" });
  assert.notEqual(comment("a"), comment("b"));
  assert.equal(comment("a"), comment("a"));
  assert.equal(
    outboxKeyFor("edit_pr", { branch: "b", headSha: "h", content: "same" }),
    "b:h:0967115f2813a354",
  );
  assert.notEqual(
    outboxKeyFor("edit_pr", { branch: "b", headSha: "h", content: "one" }),
    outboxKeyFor("edit_pr", { branch: "b", headSha: "h", content: "two" }),
  );
  assert.equal(
    outboxKeyFor("set_labels", { issue: 7, labelSet: ["b", "a"] }),
    outboxKeyFor("set_labels", { issue: 7, labelSet: ["a", "b"] }),
  );
  assert.equal(
    outboxKeyFor("merge_pr", { branch: "b", headSha: "h" }),
    "b:h",
  );
  assert.notEqual(
    outboxKeyFor("merge_pr", { branch: "b", headSha: "h1" }),
    outboxKeyFor("merge_pr", { branch: "b", headSha: "h2" }),
  );
});

test("PR body carries Closes and marker; comment carries marker", () => {
  const body = prBodyFor({
    issue: 7,
    summary: "Add thing",
    branch: "issue-7-add-thing",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    gates: [{ command: "pnpm test", exit: 0 }],
    evidence: {
      implementSummary:
        "Implemented the registry stop isolation and tests. Closes #99; Closes: #98; Closes:#96; Fixes other/repo#97; Resolves GH-96",
      commits: ["b".repeat(40)],
      changedFiles: ["src/harness/registry.ts", "test/harness-contract.test.ts"],
      notCovered: ["UI smoke is unchanged because scripts/ is outside this slice"],
      audit: {
        verdict: "approved",
        reviewedSha: "b".repeat(40),
        summary: "No blocking findings.",
        findings: [
          {
            severity: "low",
            location: "src/a.ts:1",
            what: "A non-blocking cleanup remains",
            evidence: "The old literal is still present.",
            recommendation: "Move the literal into the shared constant in a later slice.",
          },
        ],
      },
    },
  });
  assert.ok(body.includes("Closes #7"));
  assert.ok(body.includes("Implemented the registry stop isolation"));
  assert.ok(body.includes("approved at bbbbbbbb"));
  assert.ok(body.includes("low: src/a.ts:1"));
  assert.ok(body.includes("UI smoke is unchanged"));
  assert.ok(body.includes("src/harness/registry.ts"));
  assert.ok(body.includes("The old literal is still present."));
  assert.ok(body.includes("Move the literal into the shared constant"));
  assert.ok(body.includes("Closes \\#99"));
  assert.ok(body.includes("Closes: \\#98"));
  assert.ok(body.includes("Closes:\\#96"));
  assert.ok(body.includes("Fixes other/repo\\#97"));
  assert.ok(body.includes("Resolves GH\\-96"));
  assert.equal(body.match(/Closes #\d+/g)?.length, 1);
  assert.ok(body.includes(WORKER_MARKER));
  assert.ok(commentBodyFor({ issue: 7, phase: "delivered", headSha: "h", detail: "d" }).includes(WORKER_MARKER));
});

test("delivery evidence marks omitted list items and stays under the GitHub body limit", () => {
  const evidence: DeliveryEvidence = {
    implementSummary: "Large delivery",
    commits: ["b".repeat(40)],
    changedFiles: Array.from({ length: 51 }, (_value, index) => `src/file-${index}.ts`),
    notCovered: Array.from({ length: 21 }, (_value, index) => `not covered ${index}`),
    audit: {
      verdict: "approved",
      reviewedSha: "b".repeat(40),
      summary: "No blocking findings.",
      findings: Array.from({ length: 21 }, (_value, index) => ({
        severity: "low",
        location: `src/file-${index}.ts:1`,
        what: "A cleanup remains.",
        evidence: "The old form is still present.",
        recommendation: "Remove it later.",
      })),
    },
  };
  const rendered = renderDeliveryEvidence(evidence);
  assert.match(rendered, /1 more findings not shown/);
  assert.match(rendered, /1 more changed files not shown/);
  assert.match(rendered, /1 more not-covered items not shown/);

  evidence.audit.findings = Array.from({ length: 20 }, (_value, index) => ({
    severity: "low",
    location: `src/file-${index}.ts:1`,
    what: "x".repeat(5000),
    evidence: "y".repeat(5000),
    recommendation: "z".repeat(5000),
  }));
  const body = prBodyFor({
    issue: 7,
    summary: "Large delivery",
    branch: "issue-7-large",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    gates: [{ command: "pnpm test", exit: 0 }],
    evidence,
  });
  assert.ok(body.length <= GITHUB_BODY_LIMIT);
  assert.match(body, /Delivery evidence truncated/);
  assert.match(body, /Closes #7/);
  assert.ok(body.includes(WORKER_MARKER));

  const comment = commentBodyFor({
    issue: 7,
    phase: "delivered",
    headSha: "b".repeat(40),
    detail: "x".repeat(GITHUB_BODY_LIMIT * 2),
  });
  assert.ok(comment.length <= GITHUB_BODY_LIMIT);
  assert.match(comment, /Delivery detail truncated/);
  assert.ok(comment.includes(WORKER_MARKER));
});

/* ---------------- git 纯函数 ---------------- */

test("branch and sha validation is fail-closed", () => {
  assert.equal(branchFor("issue-", 49, "Hello, World!"), "issue-49-hello-world");
  assert.equal(slugify("!!!"), "task");
  assert.throws(() => assertBranch("main"));
  assert.throws(() => assertBranch("issue-1-EVIL;rm"));
  assert.throws(() => assertSha("abc"));
  assert.equal(assertSha("a".repeat(40)), "a".repeat(40));
});

test("gatesForDiff adds ui gate only on web/build/deps touch", () => {
  const base = [["pnpm", "typecheck"], ["pnpm", "test"]];
  assert.deepEqual(gatesForDiff(base, ["src/a.ts"]), base);
  for (const file of ["web/x.ts", "scripts/ui-smoke.ts", "vite.config.ts", "package.json", "pnpm-lock.yaml"]) {
    const gates = gatesForDiff(base, [file]);
    assert.ok(gates.some((gate) => gate.join(" ") === "pnpm test:ui"), file);
  }
});

/* ---------------- OCR 第二审计源与合并门 ---------------- */

const ocrBaseSha = "a".repeat(40);
const ocrHeadSha = "b".repeat(40);
const ocrManifest = {
  terminal_state: "complete",
  input: {
    resolved_base: ocrBaseSha,
    resolved_head: ocrHeadSha,
    exact_range: `${ocrBaseSha}..${ocrHeadSha}`,
  },
  coverage: {
    selected: [
      { item_id: "fixture-item", path: "src/fixture.ts", fingerprint: "fixture-fingerprint" },
    ],
    completed: [
      { item_id: "fixture-item", path: "src/fixture.ts", fingerprint: "fixture-fingerprint" },
    ],
    reused: [],
    failed: [],
    waived: [],
  },
};
const completeOcrFixture = {
  status: "complete",
  message: "Review complete.",
  session_id: "ocr-session-1",
  manifest: ocrManifest,
  comments: [
    {
      path: "docs/guide.md",
      content: "The example no longer matches the command.",
      existing_code: "old command",
      suggestion_code: "new command",
      start_line: 12,
      end_line: 12,
      category: "documentation",
      severity: "low",
    },
  ],
};

test("OCR audit accepts only complete, parseable output files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iw-ocr-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const cases = [
    { name: "complete", raw: JSON.stringify(completeOcrFixture), write: true, pass: true, exit: 0 },
    {
      name: "aborted",
      raw: JSON.stringify({ ...completeOcrFixture, status: "aborted" }),
      write: true,
      pass: false,
      exit: 0,
    },
    { name: "missing file", raw: "", write: false, pass: false, exit: 0 },
    { name: "bad JSON", raw: "{", write: true, pass: false, exit: 0 },
    { name: "non-zero exit", raw: JSON.stringify(completeOcrFixture), write: true, pass: false, exit: 1 },
  ];
  for (const item of cases) {
    await t.test(item.name, () => {
      const outputPath = join(dir, `${item.name.replaceAll(" ", "-")}.json`);
      let argv: string[] = [];
      const evidence = runOcrAudit({
        repo: dir,
        baseSha: ocrBaseSha,
        headSha: ocrHeadSha,
        title: "Improve docs",
        body: "Update the guide.",
        outputPath,
        timeoutMs: 1000,
        dismissals: [],
        runCommand: (command, args) => {
          argv = [command, ...args];
          if (item.write) writeFileSync(outputPath, item.raw, "utf8");
          return {
            status: item.exit,
            stdout: "",
            stderr: item.exit === 0 ? "" : "provider failed",
            error: null,
          };
        },
      });
      assert.equal(evidence.status === "passed", item.pass);
      assert.ok(argv.includes("--from"));
      assert.ok(argv.includes(ocrBaseSha));
      assert.ok(argv.includes("--to"));
      assert.ok(argv.includes(ocrHeadSha));
      assert.ok(argv.includes("--audience"));
      assert.ok(argv.includes("agent"));
      assert.ok(argv.includes("--format"));
      assert.ok(argv.includes("json"));
      assert.ok(argv.includes("--output"));
      assert.ok(argv.includes("-b"));
      if (item.pass) {
        assert.equal(evidence.sessionId, "ocr-session-1");
        assert.equal(evidence.findings[0]?.disposition, "allowed");
      } else {
        assert.equal(evidence.verdict, "error");
      }
    });
  }
});

test("OCR audit turns output path setup failures into failed evidence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iw-ocr-path-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const notDirectory = join(dir, "not-a-directory");
  writeFileSync(notDirectory, "file\n", "utf8");
  let called = false;
  const evidence = runOcrAudit({
    repo: dir,
    baseSha: ocrBaseSha,
    headSha: ocrHeadSha,
    title: "Improve docs",
    body: "Update the guide.",
    outputPath: join(notDirectory, "review.json"),
    timeoutMs: 1000,
    dismissals: [],
    runCommand: () => {
      called = true;
      return { status: 0, stdout: "", stderr: "", error: null };
    },
  });
  assert.equal(called, false);
  assert.equal(evidence.status, "failed");
  assert.match(evidence.summary, /output path is unavailable/);
});

test("OCR subprocess strips GitHub and Actions credentials but keeps OCR credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iw-ocr-env-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const outputPath = join(dir, "review.json");
  const envCapture = join(dir, "env.txt");
  const ocrPath = join(dir, "ocr");
  writeFileSync(
    ocrPath,
    `#!/bin/sh
out=''
from=''
to=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; out="$1" ;;
    --from) shift; from="$1" ;;
    --to) shift; to="$1" ;;
  esac
  shift
done
env | sort > "$OCR_ENV_CAPTURE"
printf '{"status":"complete","message":"OCR approved.","session_id":"ocr-env","comments":[],"manifest":{"terminal_state":"complete","input":{"resolved_base":"%s","resolved_head":"%s","exact_range":"%s..%s"},"coverage":{"selected":[{"item_id":"fixture-item","path":"src/fixture.ts","fingerprint":"fixture-fingerprint"}],"completed":[{"item_id":"fixture-item","path":"src/fixture.ts","fingerprint":"fixture-fingerprint"}],"reused":[],"failed":[],"waived":[]}}}\\n' "$from" "$to" "$from" "$to" > "$out"
`,
    "utf8",
  );
  chmodSync(ocrPath, 0o755);
  const savedPath = process.env.PATH;
  const savedCapture = process.env.OCR_ENV_CAPTURE;
  const credentials = {
    GH_TOKEN: "gh-token-secret",
    GITHUB_TOKEN: "github-token-secret",
    GITHUB_PERSONAL_ACCESS_TOKEN: "github-pat-secret",
    GH_ENTERPRISE_TOKEN: "gh-enterprise-secret",
    GITHUB_ENTERPRISE_TOKEN: "github-enterprise-secret",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "actions-id-secret",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.example/token",
    ACTIONS_RUNTIME_TOKEN: "actions-runtime-secret",
    ACTIONS_RUNTIME_URL: "https://actions.example/runtime",
    ACTIONS_CACHE_URL: "https://actions.example/cache",
    ACTIONS_RESULTS_URL: "https://actions.example/results",
    OCR_API_TOKEN: "ocr-provider-secret",
  };
  const saved = Object.fromEntries(
    Object.keys(credentials).map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedCapture === undefined) delete process.env.OCR_ENV_CAPTURE;
    else process.env.OCR_ENV_CAPTURE = savedCapture;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.PATH = `${dir}:${savedPath ?? ""}`;
  process.env.OCR_ENV_CAPTURE = envCapture;
  Object.assign(process.env, credentials);

  const evidence = runOcrAudit({
    repo: dir,
    baseSha: ocrBaseSha,
    headSha: ocrHeadSha,
    title: "Improve docs",
    body: "Update the guide.",
    outputPath,
    timeoutMs: 5_000,
    dismissals: [],
  });
  assert.equal(evidence.status, "passed");
  assert.ok(!evidence.summary.includes(credentials.OCR_API_TOKEN));
  const captured = await readFile(envCapture, "utf8");
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "ACTIONS_CACHE_URL",
    "ACTIONS_RESULTS_URL",
  ]) {
    assert.ok(!captured.split("\n").some((line) => line.startsWith(`${name}=`)), name);
  }
  assert.match(captured, /^OCR_API_TOKEN=ocr-provider-secret$/m);
});

test("OCR parser rejects non-complete sessions and malformed comments", () => {
  const expected = { baseSha: ocrBaseSha, headSha: ocrHeadSha };
  assert.equal(parseOcrReview(JSON.stringify(completeOcrFixture), expected).ok, true);
  const aborted = parseOcrReview(
    JSON.stringify({ ...completeOcrFixture, status: "skipped" }),
    expected,
  );
  assert.equal(aborted.ok, false);
  const badManifest = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      manifest: { terminal_state: "partial" },
    }),
    expected,
  );
  assert.equal(badManifest.ok, false);
  const malformed = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      comments: [{ path: "", content: "x", severity: "low" }],
    }),
    expected,
  );
  assert.equal(malformed.ok, false);
  const missingComments = parseOcrReview(
    JSON.stringify({ ...completeOcrFixture, comments: undefined }),
    expected,
  );
  assert.equal(missingComments.ok, false);
  assert.match(missingComments.ok ? "" : missingComments.reason, /comments are missing/);
});

test("OCR manifest must prove the exact reviewed base and head", () => {
  const expected = { baseSha: ocrBaseSha, headSha: ocrHeadSha };
  const missing = parseOcrReview(
    JSON.stringify({ ...completeOcrFixture, manifest: undefined }),
    expected,
  );
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /manifest is missing/);

  const headDrift = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      manifest: {
        ...ocrManifest,
        input: { ...ocrManifest.input, resolved_head: "c".repeat(40) },
      },
    }),
    expected,
  );
  assert.equal(headDrift.ok, false);
  assert.match(headDrift.ok ? "" : headDrift.reason, /resolved base\/head do not match/);

  const inconsistent = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      manifest: {
        ...ocrManifest,
        input: { ...ocrManifest.input, exact_range: "c".repeat(40) + ".." + "d".repeat(40) },
      },
    }),
    expected,
  );
  assert.equal(inconsistent.ok, false);
  assert.match(inconsistent.ok ? "" : inconsistent.reason, /inconsistent reviewed SHAs/);

  const rangeOnly = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      manifest: {
        terminal_state: "complete",
        input: { exact_range: `${ocrBaseSha}..${ocrHeadSha}` },
      },
    }),
    expected,
  );
  assert.equal(rangeOnly.ok, false);
  assert.match(rangeOnly.ok ? "" : rangeOnly.reason, /resolved_base and resolved_head are required/);

  const missingHead = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      manifest: {
        terminal_state: "complete",
        input: { resolved_base: ocrBaseSha },
      },
    }),
    expected,
  );
  assert.equal(missingHead.ok, false);

  const resolvedOnly = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      manifest: {
        terminal_state: "complete",
        input: { resolved_base: ocrBaseSha, resolved_head: ocrHeadSha },
        coverage: ocrManifest.coverage,
      },
    }),
    expected,
  );
  assert.equal(resolvedOnly.ok, true);
});

test("OCR coverage must prove every selected item completed or reused", () => {
  const expected = { baseSha: ocrBaseSha, headSha: ocrHeadSha };
  const withCoverage = (coverage: Record<string, unknown>) =>
    JSON.stringify({
      ...completeOcrFixture,
      manifest: { ...ocrManifest, coverage },
    });
  const missing = parseOcrReview(
    JSON.stringify({
      ...completeOcrFixture,
      manifest: { terminal_state: "complete", input: ocrManifest.input },
    }),
    expected,
  );
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.reason, /coverage is missing/);

  const failed = parseOcrReview(
    withCoverage({
      ...ocrManifest.coverage,
      failed: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "fixture-fingerprint",
        },
      ],
    }),
    expected,
  );
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? "" : failed.reason, /failed coverage/);

  const waived = parseOcrReview(
    withCoverage({
      ...ocrManifest.coverage,
      waived: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "fixture-fingerprint",
        },
      ],
    }),
    expected,
  );
  assert.equal(waived.ok, false);
  assert.match(waived.ok ? "" : waived.reason, /waived coverage/);

  const unreviewed = parseOcrReview(
    withCoverage({
      selected: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "fixture-fingerprint",
        },
        { item_id: "new-item", path: "src/new.ts", fingerprint: "new-fingerprint" },
      ],
      completed: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "fixture-fingerprint",
        },
      ],
      reused: [],
      failed: [],
      waived: [],
    }),
    expected,
  );
  assert.equal(unreviewed.ok, false);
  assert.match(unreviewed.ok ? "" : unreviewed.reason, /did not review selected item new-item/);

  const fingerprintDrift = parseOcrReview(
    withCoverage({
      ...ocrManifest.coverage,
      completed: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "changed",
        },
      ],
    }),
    expected,
  );
  assert.equal(fingerprintDrift.ok, false);

  const reused = parseOcrReview(
    withCoverage({
      selected: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "fixture-fingerprint",
        },
      ],
      completed: [],
      reused: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "fixture-fingerprint",
        },
      ],
      failed: [],
      waived: [],
    }),
    expected,
  );
  assert.equal(reused.ok, true);

  const omittedRequiredPath = parseOcrReview(JSON.stringify(completeOcrFixture), {
    ...expected,
    requiredPaths: ["src/omitted.ts"],
  });
  assert.equal(omittedRequiredPath.ok, false);
  assert.match(
    omittedRequiredPath.ok ? "" : omittedRequiredPath.reason,
    /coverage omitted required path src\/omitted.ts/,
  );

  const noSelectableCode = parseOcrReview(
    withCoverage({ selected: [], completed: [], reused: [], failed: [], waived: [] }),
    expected,
  );
  assert.equal(noSelectableCode.ok, true);

  const normalizedPath = parseOcrReview(
    withCoverage({
      selected: [
        {
          item_id: "fixture-item",
          path: " /./src\\\\fixture.ts/ ",
          fingerprint: "fixture-fingerprint",
        },
      ],
      completed: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "fixture-fingerprint",
        },
      ],
      reused: [],
      failed: [],
      waived: [],
    }),
    { ...expected, requiredPaths: ["src/fixture.ts"] },
  );
  assert.equal(normalizedPath.ok, true);

  const wrongCompletedPath = parseOcrReview(
    withCoverage({
      ...ocrManifest.coverage,
      completed: [
        {
          item_id: "fixture-item",
          path: "src/other.ts",
          fingerprint: "fixture-fingerprint",
        },
      ],
    }),
    expected,
  );
  assert.equal(wrongCompletedPath.ok, false);

  const conflictingReuse = parseOcrReview(
    withCoverage({
      ...ocrManifest.coverage,
      reused: [
        {
          item_id: "fixture-item",
          path: "src/fixture.ts",
          fingerprint: "different",
        },
      ],
    }),
    expected,
  );
  assert.equal(conflictingReuse.ok, false);
  assert.match(conflictingReuse.ok ? "" : conflictingReuse.reason, /coverage conflicts/);

  for (const path of ["./", "/./", "..", "src/../fixture.ts"]) {
    const degenerate = parseOcrReview(
      withCoverage({
        selected: [{ item_id: "fixture-item", path, fingerprint: "fixture-fingerprint" }],
        completed: [
          { item_id: "fixture-item", path, fingerprint: "fixture-fingerprint" },
        ],
        reused: [],
        failed: [],
        waived: [],
      }),
      expected,
    );
    assert.equal(degenerate.ok, false, path);
  }
});

test("finding grades and dismissals are fail-closed and retained as evidence", () => {
  const finding = (severity: string, location = "test/a.test.ts:4") => ({
    severity,
    location,
    what: "Known false positive from a generated fixture.",
    evidence: "fixture",
    recommendation: "No action.",
  });
  const graded = evaluateFindings(
    "ocr",
    [finding("critical"), finding("high"), finding("medium"), finding("low"), finding("bogus")],
    [],
  );
  assert.deepEqual(
    graded.map((item) => item.disposition),
    ["blocking", "blocking", "blocking", "allowed", "blocking"],
  );
  const id = graded[0]!.finding.id;
  const dismissedById = evaluateFindings("ocr", [finding("critical")], [
    { id, reason: "confirmed upstream test fixture" },
  ]);
  assert.equal(dismissedById[0]?.disposition, "dismissed");
  assert.equal(dismissedById[0]?.reason, "confirmed upstream test fixture");
  assert.equal(dismissedById[0]?.finding.id, id);
  const dismissedByFile = evaluateFindings("ocr", [finding("high")], [
    {
      file: "test/**",
      pattern: "generated fixture",
      reason: "generated fixture is intentionally stable",
    },
  ]);
  assert.equal(dismissedByFile[0]?.disposition, "dismissed");
  assert.equal(dismissedByFile[0]?.matchedRule?.reason, "generated fixture is intentionally stable");
});

test("auto-merge path policy defaults to docs+tests and hard-denies protected paths", () => {
  const disabled = buildConfig({}, "/tmp").autoMerge;
  assert.equal(evaluatePathPolicy(["docs/a.md", "test/a.test.ts"], disabled).allowed, false);
  const enabled = buildConfig(
    { autoMerge: { enabled: true, allowedScopes: ["docs", "test"] } },
    "/tmp",
  ).autoMerge;
  assert.equal(evaluatePathPolicy(["docs/a.md", "test/a.test.ts"], enabled).allowed, true);
  assert.equal(evaluatePathPolicy(["src/a.ts"], enabled).allowed, false);
  const withSrc = buildConfig(
    { autoMerge: { enabled: true, allowedScopes: ["docs", "test", "src"] } },
    "/tmp",
  ).autoMerge;
  assert.equal(evaluatePathPolicy(["src/a.ts"], withSrc).allowed, true);
  for (const path of [
    ".github/workflows/checks.yml",
    ".zcode/workflows/a.dwf.ts",
    "tools/issue-worker/daemon.ts",
    "src/store/db.ts",
    "docs/adr/0022-controlled-auto-merge.md",
    "src/store/migrations/001-add.sql",
    "pnpm-lock.yaml",
    ".env.local",
    "src/permissions.ts",
  ]) {
    const decision = evaluatePathPolicy([path], withSrc);
    assert.equal(decision.allowed, false, path);
    assert.ok(decision.protectedFiles.includes(path), path);
  }
});

const mergeBaseSha = "a".repeat(40);
const mergeHeadSha = "b".repeat(40);
const validRuleset: RepositoryRuleset = {
  id: 1,
  name: "main required checks",
  target: "branch",
  enforcement: "active",
  includeRefs: ["refs/heads/main"],
  excludeRefs: [],
  requiredChecks: [{ context: "checks", appId: 15368 }],
  strict: true,
  bypassActorCount: 0,
};
const validCheckRun: CheckRunSnapshot = {
  name: "checks",
  status: "completed",
  conclusion: "success",
  headSha: mergeHeadSha,
  appId: 15368,
  appSlug: "github-actions",
};
const validPullRequest = {
  number: 17,
  url: "https://example/pr/17",
  state: "open" as const,
  merged: false,
  mergeable: true,
  draft: false,
  headSha: mergeHeadSha,
  baseSha: mergeBaseSha,
  baseRef: "main",
};
const githubGateInput = () => ({
  baseRef: "main",
  baseSha: mergeBaseSha,
  headSha: mergeHeadSha,
  pullRequest: { status: 200, data: { ...validPullRequest }, error: null },
  repository: { status: 200, data: { defaultBranch: "main" }, error: null },
  branchProtection: { status: 404, data: null, error: "not protected" },
  rulesets: { status: 200, data: [{ ...validRuleset }], error: null },
  checkRuns: { status: 200, data: [{ ...validCheckRun }], error: null },
  statuses: { status: 200, data: [], error: null },
});

test("GitHub gate binds exact SHA, accepts either enforcement layer, and waits for pending checks", () => {
  assert.equal(evaluateGithubGate(githubGateInput()).conclusion, "success");
  const headDrift = githubGateInput();
  headDrift.pullRequest.data.headSha = "c".repeat(40);
  assert.equal(evaluateGithubGate(headDrift).conclusion, "failure");
  assert.ok(
    evaluateGithubGate(headDrift).reasons.some((reason) => reason.includes("PR head changed")),
  );
  const baseDrift = githubGateInput();
  baseDrift.pullRequest.data.baseSha = "d".repeat(40);
  assert.ok(
    evaluateGithubGate(baseDrift).reasons.some((reason) => reason.includes("PR base changed")),
  );
  const noRules = githubGateInput();
  noRules.rulesets.data = [];
  const missingRules = evaluateGithubGate(noRules);
  assert.equal(missingRules.conclusion, "failure");
  assert.ok(
    missingRules.reasons.some((reason) => reason.includes("no valid GitHub rule")),
  );
  const skipped = githubGateInput();
  skipped.checkRuns.data = [{ ...validCheckRun, conclusion: "skipped" }];
  assert.equal(evaluateGithubGate(skipped).conclusion, "failure");
  const wrongApp = githubGateInput();
  wrongApp.checkRuns.data = [{ ...validCheckRun, appId: 42 }];
  const appMismatch = evaluateGithubGate(wrongApp);
  assert.equal(appMismatch.conclusion, "waiting");
  assert.ok(appMismatch.pendingReasons.some((reason) => reason.includes("has not registered")));

  const optional = githubGateInput();
  optional.checkRuns.data = [
    { ...validCheckRun },
    {
      ...validCheckRun,
      name: "optional",
      conclusion: "skipped",
      appId: 42,
    },
  ];
  assert.equal(evaluateGithubGate(optional).conclusion, "success");

  const queued = githubGateInput();
  queued.checkRuns.data = [{ ...validCheckRun, status: "queued", conclusion: null }];
  assert.equal(evaluateGithubGate(queued).conclusion, "waiting");

  const mergeableUnknown = githubGateInput();
  mergeableUnknown.pullRequest.data.mergeable = null;
  assert.equal(evaluateGithubGate(mergeableUnknown).conclusion, "waiting");

  const protectionOnly = githubGateInput();
  protectionOnly.rulesets.data = [];
  protectionOnly.branchProtection = {
    status: 200,
    data: {
      requiredChecks: [{ context: "checks", appId: 15368 }],
      strict: true,
      enforceAdmins: true,
    },
    error: null,
  };
  assert.equal(evaluateGithubGate(protectionOnly).conclusion, "success");

  const rulesetWins = githubGateInput();
  rulesetWins.branchProtection = {
    status: 200,
    data: { requiredChecks: [], strict: false, enforceAdmins: false },
    error: null,
  };
  assert.equal(evaluateGithubGate(rulesetWins).conclusion, "success");

  const noRule = githubGateInput();
  noRule.rulesets.data = [];
  noRule.branchProtection = {
    status: 200,
    data: { requiredChecks: [], strict: false, enforceAdmins: false },
    error: null,
  };
  assert.equal(evaluateGithubGate(noRule).conclusion, "failure");

  const transient = githubGateInput();
  transient.rulesets = { status: 503, data: null, error: "temporarily unavailable" };
  transient.branchProtection = { status: 503, data: null, error: "temporarily unavailable" };
  assert.equal(evaluateGithubGate(transient).conclusion, "waiting");

  const forbidden = githubGateInput();
  forbidden.rulesets = { status: 403, data: null, error: "forbidden" };
  forbidden.branchProtection = { status: 403, data: null, error: "forbidden" };
  assert.equal(evaluateGithubGate(forbidden).conclusion, "failure");
});

test("GitHub gate evaluates each readable check source without hiding failures", () => {
  const statusContextInput = () => {
    const input = githubGateInput();
    input.rulesets.data = [
      { ...validRuleset, requiredChecks: [{ context: "checks", appId: null }] },
    ];
    return input;
  };

  const checksDownStatusFailure = statusContextInput();
  checksDownStatusFailure.checkRuns = {
    status: 503,
    data: null,
    error: "check runs unavailable",
  };
  checksDownStatusFailure.statuses = {
    status: 200,
    data: [{ context: "checks", state: "failure" }],
    error: null,
  };
  const statusFailure = evaluateGithubGate(checksDownStatusFailure);
  assert.equal(statusFailure.conclusion, "failure");
  assert.ok(statusFailure.reasons.some((reason) => reason.includes("required status checks is failure")));

  const checksFailureStatusesDown = statusContextInput();
  checksFailureStatusesDown.checkRuns.data = [{ ...validCheckRun, conclusion: "failure" }];
  checksFailureStatusesDown.statuses = {
    status: 503,
    data: null,
    error: "statuses unavailable",
  };
  const checkFailure = evaluateGithubGate(checksFailureStatusesDown);
  assert.equal(checkFailure.conclusion, "failure");
  assert.ok(checkFailure.reasons.some((reason) => reason.includes("required check checks concluded failure")));

  const checksDownStatusSuccess = statusContextInput();
  checksDownStatusSuccess.checkRuns = {
    status: 503,
    data: null,
    error: "check runs unavailable",
  };
  checksDownStatusSuccess.statuses = {
    status: 200,
    data: [{ context: "checks", state: "success" }],
    error: null,
  };
  const statusSuccess = evaluateGithubGate(checksDownStatusSuccess);
  assert.equal(statusSuccess.conclusion, "waiting");
  assert.ok(statusSuccess.pendingReasons.some((reason) => reason.includes("check runs unavailable")));
  assert.ok(!statusSuccess.pendingReasons.some((reason) => reason.includes("has not registered")));

  const appBoundStatus = githubGateInput();
  appBoundStatus.checkRuns = {
    status: 503,
    data: null,
    error: "check runs unavailable",
  };
  appBoundStatus.statuses = {
    status: 200,
    data: [{ context: "checks", state: "failure" }],
    error: null,
  };
  const appBound = evaluateGithubGate(appBoundStatus);
  assert.equal(appBound.conclusion, "waiting");
  assert.ok(!appBound.reasons.some((reason) => reason.includes("required status")));

  const bothUnavailable = githubGateInput();
  bothUnavailable.checkRuns = { status: 503, data: null, error: "check runs unavailable" };
  bothUnavailable.statuses = { status: 503, data: null, error: "statuses unavailable" };
  const unavailable = evaluateGithubGate(bothUnavailable);
  assert.equal(unavailable.conclusion, "waiting");
  assert.ok(unavailable.pendingReasons.some((reason) => reason.includes("check runs unavailable")));
  assert.ok(unavailable.pendingReasons.some((reason) => reason.includes("commit statuses unavailable")));
});

test("GitHub ruleset ~DEFAULT_BRANCH uses the repository default branch, not baseBranch", () => {
  const input = githubGateInput();
  input.baseRef = "develop";
  input.pullRequest.data.baseRef = "develop";
  input.rulesets.data = [{ ...validRuleset, includeRefs: ["~DEFAULT_BRANCH"] }];
  assert.equal(evaluateGithubGate(input).conclusion, "failure");

  input.rulesets.data = [{ ...validRuleset, includeRefs: ["refs/heads/develop"] }];
  assert.equal(evaluateGithubGate(input).conclusion, "success");

  const defaultBranches = githubGateInput();
  defaultBranches.rulesets.data = [{ ...validRuleset, includeRefs: ["~DEFAULT_BRANCH"] }];
  assert.equal(evaluateGithubGate(defaultBranches).conclusion, "success");

  const unknownRepository = githubGateInput();
  unknownRepository.rulesets.data = [{ ...validRuleset, includeRefs: ["~DEFAULT_BRANCH"] }];
  unknownRepository.repository = {
    status: 503,
    data: null,
    error: "temporarily unavailable",
  };
  assert.equal(evaluateGithubGate(unknownRepository).conclusion, "waiting");

  unknownRepository.repository = {
    status: 200,
    data: null,
    error: "invalid response",
  };
  assert.equal(evaluateGithubGate(unknownRepository).conclusion, "failure");
});

test("dismissal file globs match files at the subtree root", () => {
  const finding = {
    severity: "medium",
    location: "src/foo.ts:1",
    what: "Generated file differs.",
    evidence: "fixture",
    recommendation: "Regenerate.",
  };
  const dispositions = evaluateFindings("ocr", [finding], [
    { file: "src/**/*.ts", pattern: "generated", reason: "fixture is generated" },
  ]);
  assert.equal(dispositions[0]?.disposition, "dismissed");
});

test("parseMergeEvidence rejects nested corruption before rendering", () => {
  const valid: MergeEvidence = {
    version: 1,
    stage: "audit_only",
    repo: "o/r",
    issue: 7,
    prNumber: null,
    branch: "issue-7",
    baseRef: "main",
    baseSha: mergeBaseSha,
    headSha: mergeHeadSha,
    issueSnapshotHash: "digest",
    changedFiles: ["docs/a.md"],
    pathPolicy: {
      allowed: true,
      reasons: [],
      scopes: ["docs"],
      protectedFiles: [],
      disallowedFiles: [],
    },
    zcode: {
      source: "zcode",
      status: "passed",
      verdict: "approved",
      reviewedSha: mergeHeadSha,
      baseSha: mergeBaseSha,
      summary: "approved",
      findings: [],
    },
    ocr: null,
    controllerGates: [{ command: "pnpm test", exit: 0 }],
    github: null,
    reasons: [],
  };
  const parsed = parseMergeEvidence(JSON.stringify(valid));
  assert.ok(parsed !== null);
  assert.match(renderMergeEvidence(parsed), /merge stage: audit_only/);

  const badPathPolicy = structuredClone(valid) as unknown as Record<string, unknown>;
  (badPathPolicy["pathPolicy"] as Record<string, unknown>)["allowed"] = "yes";
  assert.equal(parseMergeEvidence(JSON.stringify(badPathPolicy)), null);

  const badFinding = structuredClone(valid) as unknown as Record<string, unknown>;
  (badFinding["zcode"] as Record<string, unknown>)["findings"] = [{}];
  assert.equal(parseMergeEvidence(JSON.stringify(badFinding)), null);

  const badGithub = structuredClone(valid) as unknown as Record<string, unknown>;
  badGithub["github"] = { conclusion: "success", reasons: [] };
  assert.equal(parseMergeEvidence(JSON.stringify(badGithub)), null);

  const badFinalizationStart = structuredClone(valid) as unknown as Record<string, unknown>;
  badFinalizationStart["finalizationStartedAt"] = "yesterday";
  assert.equal(parseMergeEvidence(JSON.stringify(badFinalizationStart)), null);
});

test("real merge adapter sends pinned SHA and classifies HTTP 422", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iw-gh-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const ghPath = join(dir, "gh");
  const capture = join(dir, "args.txt");
  writeFileSync(
    ghPath,
    `#!/bin/sh
printf '%s\\n' "$@" >> "$GH_CAPTURE"
if [ "$GH_MODE" = "422" ]; then
  echo 'gh: Validation Failed (HTTP 422)' >&2
  exit 1
fi
if [ "$GH_MODE" = "repository" ]; then
  printf '%s\\n' '{"default_branch":"trunk","private":true}'
  exit 0
fi
if [ "$GH_MODE" = "rulesets" ]; then
  case "$*" in
    */rulesets/7)
      printf '%s\\n' '{"id":7,"name":"main checks","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},"rules":[{"type":"required_status_checks","parameters":{"strict_required_status_policy":true,"strict_required_status_checks_policy":true,"required_status_checks":[{"context":"checks","integration_id":15368}]}}],"bypass_actors":[]}'
      ;;
    */rulesets/8)
      printf '%s\\n' '{"id":8,"name":"second page","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/main"],"exclude":[]}},"rules":[{"type":"required_status_checks","parameters":{"strict_required_status_policy":true,"strict_required_status_checks_policy":true,"required_status_checks":[{"context":"checks","integration_id":15368}]}}],"bypass_actors":[]}'
      ;;
    *)
      printf '%s\\n' '[[{"id":7}],[{"id":8}]]'
      ;;
  esac
  exit 0
fi
printf '%s\\n' '{"merged":true,"sha":"cccccccccccccccccccccccccccccccccccccccc"}'
`,
    "utf8",
  );
  chmodSync(ghPath, 0o755);
  const savedPath = process.env.PATH;
  const savedCapture = process.env.GH_CAPTURE;
  const savedMode = process.env.GH_MODE;
  try {
    process.env.PATH = `${dir}:${savedPath ?? ""}`;
    process.env.GH_CAPTURE = capture;
    delete process.env.GH_MODE;
    writeFileSync(capture, "");
    const merged = realMergeGatePort.mergePullRequest({
      repo: "o/r",
      prNumber: 17,
      headSha: mergeHeadSha,
    });
    assert.equal(merged.merged, true);
    const args = (await readFile(capture, "utf8")).trim().split("\n");
    assert.ok(args.includes("--method"));
    assert.ok(args.includes("PUT"));
    assert.ok(args.includes(`sha=${mergeHeadSha}`));
    assert.ok(args.includes("merge_method=merge"));
    assert.ok(args.some((arg) => arg.includes("/pulls/17/merge")));

    process.env.GH_MODE = "422";
    writeFileSync(capture, "");
    const failed = realMergeGatePort.mergePullRequest({
      repo: "o/r",
      prNumber: 17,
      headSha: mergeHeadSha,
    });
    assert.equal(failed.status, 422);
    assert.equal(failed.merged, false);

    process.env.GH_MODE = "repository";
    writeFileSync(capture, "");
    const repository = realMergeGatePort.getRepository("o/r");
    assert.equal(repository.status, 200);
    assert.deepEqual(repository.data, { defaultBranch: "trunk" });
    const repositoryArgs = (await readFile(capture, "utf8")).trim().split("\n");
    assert.ok(repositoryArgs.some((arg) => arg === "repos/o/r"));

    process.env.GH_MODE = "rulesets";
    writeFileSync(capture, "");
    const rulesets = realMergeGatePort.listRulesets("o/r");
    assert.equal(rulesets.status, 200);
    assert.equal(rulesets.data?.[0]?.id, 7);
    assert.equal(rulesets.data?.[0]?.strict, true);
    assert.deepEqual(rulesets.data?.[0]?.requiredChecks, [{ context: "checks", appId: 15368 }]);
    assert.equal(rulesets.data?.[0]?.bypassActorCount, 0);
    assert.deepEqual(rulesets.data?.map((ruleset) => ruleset.id), [7, 8]);
    const rulesetArgs = (await readFile(capture, "utf8")).trim().split("\n");
    assert.ok(rulesetArgs.includes("--paginate"));
    assert.ok(rulesetArgs.includes("--slurp"));
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedCapture === undefined) delete process.env.GH_CAPTURE;
    else process.env.GH_CAPTURE = savedCapture;
    if (savedMode === undefined) delete process.env.GH_MODE;
    else process.env.GH_MODE = savedMode;
  }
});

/* ---------------- zcode 纯函数 ---------------- */

test("v4 frame carries number issuedAt and no model fields", () => {
  const line = frameCommand({
    id: 1,
    commandId: "cmd-1",
    sessionId: "sess",
    type: "startSavedWorkflow",
    payload: { name: "issue-to-pr", scope: "project", args: { issue: 7 } },
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed["method"], "v4/command");
  const params = parsed["params"] as Record<string, unknown>;
  assert.equal(params["clientId"], "issue-worker");
  assert.equal(typeof params["issuedAt"], "number");
  assert.ok(!line.includes("modelSelection"));
  assert.ok(!line.includes("dynamicWorkflow"));
});

test("classifyLine tolerates logs and notifications", () => {
  assert.equal(classifyLine("not json").kind, "log");
  assert.equal(classifyLine('{"id":1,"result":{"status":"accepted"}}').kind, "ack");
  assert.equal(classifyLine('{"method":"startup","params":{}}').kind, "notification");
  assert.equal(classifyLine('{"topic":"conversation/x"}').kind, "event");
});

test("app-server answers runtime preference and yolo permission requests", () => {
  const app = new AppServer({ helperPath: "/helper", cliPath: "/zcode.cjs", repo: "/repo" });
  const sent: Record<string, unknown>[] = [];
  app.sendRaw = (line: string): void => {
    sent.push(JSON.parse(line) as Record<string, unknown>);
  };
  app.onLine(JSON.stringify({
    id: "prefs-1",
    method: "session/requestRuntimePreferences",
    params: { sessionId: "s", scope: "runtime-materialization" },
  }));
  app.onLine(JSON.stringify({
    id: 17,
    method: "interaction/requestPermission",
    params: { sessionId: "s" },
  }));
  assert.deepEqual(sent[0], {
    id: "prefs-1",
    result: DEFAULT_SESSION_RUNTIME_PREFERENCES,
  });
  assert.deepEqual(sent[1], {
    id: 17,
    result: {
      decision: "allow",
      reason: "issue-worker runs ZCode in yolo mode",
    },
  });
});

test("conversation subscribe accepts the real v4 subscription ACK shape", async () => {
  const app = new AppServer({ helperPath: "/helper", cliPath: "/zcode.cjs", repo: "/repo" });
  app.sendEnvelope = async (): Promise<Record<string, unknown>> => ({
    id: 2,
    result: {
      ack: {
        subscriptionId: "sub-1",
        mode: "snapshot",
      },
    },
  });
  await app.subscribeConversation("sess-1", "conn-1", 1000);
});

test("ack parsing and failure classes", () => {
  const accepted = parseAck({ result: { status: "accepted", result: { runId: "r", toolCallId: "t" } } });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.runId, "r");
  assert.equal(classifyAckFailure({ accepted: false, reasonCode: "session_busy" }), "retryable_launch");
  assert.equal(classifyAckFailure({ accepted: false, reasonCode: "not_found" }), "terminal");
  assert.equal(classifyAckFailure({ accepted: false, reasonCode: "compile_failed" }), "terminal");
  assert.equal(classifyAckFailure({ accepted: false, errorCode: -32601 }), "fallback");
  assert.equal(classifyAckFailure({ accepted: false, reasonCode: "capabilityUnsupported" }), "fallback");
});

test("infra errors are retryable, task errors are not", () => {
  assert.equal(isRetryableInfraError("ProviderBusinessError: [1302] rate limited"), true);
  assert.equal(isRetryableInfraError("OCR provider connection failed"), true);
  assert.equal(isRetryableInfraError("LLM request timed out"), true);
  assert.equal(isRetryableInfraError("request failed 429"), true);
  assert.equal(isRetryableInfraError("socket hang up"), true);
  assert.equal(isRetryableInfraError("LLM found blocking findings"), false);
  assert.equal(isRetryableInfraError("unknown provider config"), false);
  assert.equal(isRetryableInfraError("compile_failed"), false);
  assert.equal(isRetryableInfraError("invalid_args"), false);
});

test("ZCode child environment strips GitHub token variables", () => {
  const names = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_PERSONAL_ACCESS_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
  ];
  const saved = names.map((name) => [name, process.env[name]] as const);
  try {
    for (const name of names) process.env[name] = "secret";
    const env = providerEnvironment("/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs");
    for (const name of names) assert.equal(env[name], undefined, name);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("run-settled detection is shape tolerant", () => {
  assert.equal(
    isRunSettledEvent({ payload: { eventType: "run-settled", runId: "r1" } }, "r1"),
    true,
  );
  assert.equal(
    isRunSettledEvent({ payload: { eventType: "run-settled", runId: "r2" } }, "r1"),
    false,
  );
  assert.equal(isRunSettledEvent({ type: "log", text: "x" }, "r1"), false);
  assert.equal(extractRunIdFromProgress(JSON.stringify({
    type: "workflow.run.progress",
    payload: { runId: "dwfrun-1", eventType: "run-started", payload: {} },
  })), "dwfrun-1");
  assert.equal(extractRunIdFromProgress("garbage"), null);
});

test("truncateDwfText keeps total under 64 KiB and marks truncation", () => {
  const big = "x".repeat(10_000);
  const result = truncateDwfText({ title: "t", brief: big.repeat(8), comments: [big, big, big], reviewFeedback: "fb" });
  const total = Buffer.byteLength(JSON.stringify(result), "utf8");
  assert.ok(total <= 64 * 1024, `total=${total}`);
  assert.equal(result.truncated, true);
  assert.equal(result.title, "t");
  const small = truncateDwfText({ title: "t", brief: "b", comments: ["c"] });
  assert.equal(small.truncated, false);
  assert.throws(() => truncateDwfText({ title: "t".repeat(3000), brief: "", comments: [] }));
});

test("buildIssueToPrArgs never puts text into command names", () => {
  const { args } = buildIssueToPrArgs({
    issue: 7,
    title: "t; rm -rf /",
    brief: "b",
    comments: [],
    branch: "issue-7-t-rm-rf",
    baseSha: "a".repeat(40),
    mode: "implement",
  });
  assert.equal(args.branch, "issue-7-t-rm-rf");
  assert.equal(args.mode, "implement");
});

test("newCommandId looks like uuidv7; persist/reuse is stable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iw-cmd-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const first = nextCommandId(dir, "k:start");
  const second = nextCommandId(dir, "k:start");
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(loadCommandIds(dir)["k:start"], first);
  persistCommandId(dir, "other", "x");
  assert.equal(loadCommandIds(dir)["k:start"], first);
});

test("canonicalize is key-order insensitive", () => {
  assert.equal(canonicalize({ b: 1, a: [1, 2] }), canonicalize({ a: [1, 2], b: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }));
});

/* ---------------- ZCode DB 只读兜底 ---------------- */

const makeDwfDb = async (t: { after: (fn: () => Promise<void>) => void }): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "iw-dwf-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE dwf_run (id text primary key, cwd text, name text, args_json text, status text, result_json text, failure_json text)",
  );
  db.close();
  return path;
};

test("readDwfRun validates identity and parses results", async (t) => {
  const path = await makeDwfDb(t);
  const args = { issue: 7 };
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO dwf_run VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "r1",
    "/repo",
    "issue-to-pr",
    JSON.stringify(args),
    "completed",
    JSON.stringify({ outcome: "implemented" }),
    null,
  );
  db.close();
  const expected = { runId: "r1", cwd: "/repo", names: ["issue-to-pr"], argsDigest: canonicalize(args) };
  const row = readDwfRun(path, expected);
  assert.equal(row?.status, "completed");
  assert.deepEqual(row?.resultJson, { outcome: "implemented" });
  assert.equal(readDwfRun(path, { runId: "missing", cwd: "/repo", names: ["issue-to-pr"] }), null);
  assert.throws(() => readDwfRun(path, { ...expected, cwd: "/other" }), /cwd mismatch/);
  assert.throws(() => readDwfRun(path, { ...expected, names: ["auditor"] }), /name mismatch/);
  assert.throws(() => readDwfRun(path, { ...expected, argsDigest: "nope" }), /args mismatch/);
});

test("waitRunSettled rejects on wall clock", async (t) => {
  const path = await makeDwfDb(t);
  const fakeApp = { onEvent: (_l: unknown): (() => void) => () => {} };
  await assert.rejects(
    waitRunSettled({
      app: fakeApp as unknown as Parameters<typeof waitRunSettled>[0]["app"],
      runId: "r-missing",
      dbPath: path,
      expected: { runId: "r-missing", cwd: "/repo", names: ["issue-to-pr"] },
      timeoutMs: 150,
      pollStartMs: 20,
      pollMaxMs: 40,
    }),
    /did not settle/,
  );
});

test("run-settled events only wake the waiter and never replace a verified DB row", async () => {
  const fakeApp = {
    onEvent: (listener: (body: Record<string, unknown>) => void): (() => void) => {
      listener({ payload: { eventType: "run-settled", runId: "r-race" } });
      return () => {};
    },
  };
  await assert.rejects(
    waitRunSettled({
      app: fakeApp as unknown as Parameters<typeof waitRunSettled>[0]["app"],
      runId: "r-race",
      dbPath: "/definitely/missing/zcode.sqlite",
      expected: { runId: "r-race", cwd: "/repo", names: ["issue-to-pr"] },
      timeoutMs: 150,
      pollStartMs: 20,
      pollMaxMs: 40,
    }),
  );
});

/* ---------------- store：claim / outbox / 锁 ---------------- */

test("store claim enforces one active job and outbox dedups", (t) => {
  const store = Store.open(":memory:");
  t.after(() => store.close());
  const repo = "o/r";
  store.upsertClaim({
    repo,
    issue: 1,
    branch: "issue-1-a",
    baseSha: "a".repeat(40),
    digest: "d1",
    owner: "pid:1",
    leaseUntil: Date.now() + 60_000,
    mode: "implement",
  });
  assert.equal(store.getActiveJob(repo)?.issue, 1);
  assert.ok(leaseAlive(store.getActiveJob(repo)!));
  assert.throws(() =>
    store.upsertClaim({
      repo,
      issue: 2,
      branch: "issue-2-b",
      baseSha: "a".repeat(40),
      digest: "d2",
      owner: "pid:1",
      leaseUntil: Date.now() + 60_000,
      mode: "implement",
    }),
  );
  store.enqueueOutbox({ repo, issue: 1, action: "push_branch", idempotencyKey: "k", payload: {} });
  store.enqueueOutbox({ repo, issue: 1, action: "push_branch", idempotencyKey: "k", payload: {} });
  assert.equal(store.pendingOutbox(repo, 1).length, 1);
  store.enqueueOutbox({ repo, issue: 1, action: "open_pr", idempotencyKey: "k", payload: {} });
  assert.equal(store.pendingOutbox(repo, 1).length, 2);
  store.markOutbox("push_branch", "k", "done");
  assert.equal(store.pendingOutbox(repo, 1).length, 1);
});

test("store migrates an existing job table to carry delivery evidence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iw-migrate-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite3");
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE job (repo TEXT, issue INTEGER)");
  legacy.close();
  const store = Store.open(path);
  t.after(() => store.close());
  const columns = store.db.prepare("PRAGMA table_info(job)").all() as { name?: string }[];
  assert.ok(columns.some((column) => column.name === "evidence_json"));
  assert.ok(columns.some((column) => column.name === "merge_evidence_json"));
});

test("store re-claim preserves the rework target and starts a fresh attempt budget", (t) => {
  const store = Store.open(":memory:");
  t.after(() => store.close());
  const repo = "o/r";
  const baseSha = "a".repeat(40);
  const previousHeadSha = "b".repeat(40);
  store.upsertClaim({
    repo,
    issue: 1,
    branch: "issue-1-a",
    baseSha,
    digest: "d1",
    owner: "pid:1",
    leaseUntil: Date.now() + 60_000,
    mode: "implement",
  });
  store.setStage(repo, 1, "blocked", {
    base_sha: baseSha,
    head_sha: previousHeadSha,
    pr_number: 9,
    implementation_attempt: 3,
    rework_round: 2,
    delivery_attempt: 3,
    run_id: "dwfrun-old",
    run_session_id: "session-old",
    log_dir: "/tmp/old",
    lease_until: Date.now(),
  });
  store.upsertClaim({
    repo,
    issue: 1,
    branch: "issue-1-a",
    baseSha: "",
    digest: "d2",
    owner: "pid:2",
    leaseUntil: Date.now() + 60_000,
    mode: "rework",
  });
  const job = store.getJob(repo, 1);
  assert.equal(job?.base_sha, baseSha);
  assert.equal(job?.head_sha, previousHeadSha);
  assert.equal(job?.pr_number, 9);
  assert.equal(job?.implementation_attempt, 0);
  assert.equal(job?.rework_round, 0);
  assert.equal(job?.delivery_attempt, 0);
  assert.equal(job?.run_id, null);
  assert.equal(job?.run_session_id, null);
  assert.equal(job?.log_dir, null);
});

test("singleton lock rejects a live holder", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "iw-lock-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "singleton.lock");
  const first = acquireSingletonLock(path);
  assert.throws(() => acquireSingletonLock(path), /holds/);
  first.release();
  const second = acquireSingletonLock(path);
  second.release();
});

/* ---------------- config fail closed ---------------- */

test("buildConfig rejects unknown keys and bad values", () => {
  const cwd = "/tmp";
  assert.throws(() => buildConfig({ nope: 1 }, cwd), /unknown key/);
  assert.throws(() => buildConfig({ repo: "relative/path" }, cwd), /absolute/);
  assert.throws(() => buildConfig({ timeouts: { pollMs: 0 } }, cwd), /positive integer/);
  assert.throws(() => buildConfig({ gates: [] }, cwd), /non-empty/);
  assert.throws(() => buildConfig({ branchPrefix: "issue!" }, cwd), /branchPrefix/);
  assert.throws(
    () => buildConfig({ autoMerge: { enabled: "yes" } }, cwd),
    /autoMerge.enabled must be a boolean/,
  );
  assert.throws(
    () => buildConfig({ autoMerge: { enabled: true, allowedScopes: ["all"] } }, cwd),
    /allowedScopes/,
  );
  assert.throws(
    () => buildConfig({ autoMerge: { enabled: true, allowedScopes: [] } }, cwd),
    /allowedScopes must be non-empty/,
  );
  assert.throws(
    () => buildConfig({ autoMerge: { dismissals: [{ file: "docs/**", reason: "x" }] } }, cwd),
    /id or by file plus pattern/,
  );
  assert.throws(
    () =>
      buildConfig(
        {
          autoMerge: {
            dismissals: [
              { id: "0123456789abcdef", file: "docs/**", reason: "mixed matcher" },
            ],
          },
        },
        cwd,
      ),
    /id or by file plus pattern/,
  );
  assert.throws(
    () =>
      buildConfig(
        {
          autoMerge: {
            dismissals: [
              { id: "0123456789abcdef", pattern: "mixed matcher", reason: "mixed matcher" },
            ],
          },
        },
        cwd,
      ),
    /id or by file plus pattern/,
  );
  assert.throws(
    () =>
      buildConfig(
        {
          autoMerge: {
            dismissals: [{ file: "docs/**", pattern: "[", reason: "bad regex" }],
          },
        },
        cwd,
      ),
    /valid regular expression/,
  );
  assert.throws(() => buildConfig({ timeouts: { ocrMs: 0 } }, cwd), /positive integer/);
  assert.throws(() => buildConfig({ timeouts: { mergeMs: 0 } }, cwd), /positive integer/);
  assert.throws(() => buildConfig({ timeouts: { typoMs: 1 } }, cwd), /unknown key/);
  const config = buildConfig({}, cwd);
  assert.equal(config.baseBranch, "main");
  assert.equal(config.maxImplementAttempts, 3);
  assert.equal(config.timeouts.mergeMs, 30 * 60_000);
  assert.equal(config.autoMerge.enabled, false);
  assert.deepEqual(config.autoMerge.allowedScopes, ["docs", "test"]);
});

/* ---------------- reconcile ---------------- */

const ghStub = (over: Partial<GhPort>): GhPort =>
  ({
    listReadyIssues: () => [],
    getIssueDetail: () => {
      throw new Error("not stubbed");
    },
    isIssueClosed: () => false,
    listPullRequestsForBranch: () => [],
    createPr: () => "",
    editPrBody: () => {},
    commentIssue: () => {},
    moveIssueLabel: () => {},
    ...over,
  }) as GhPort;

const testCtx = (store: Store, gh: GhPort): Ctx => {
  const config = defaultConfig("/tmp");
  config.repoName = "o/r";
  return { config, store, gh, git: realGit, mergeGate: realMergeGatePort, repoName: "o/r" };
};

const implementationResult = (repo: string): Record<string, unknown> => ({
  outcome: "implemented",
  summary: "Implementation completed.",
  commits: [gitHeadSha(repo, 10_000)],
  changedFiles: ["src/example.ts"],
  notCovered: [],
});

const auditResult = (repo: string): Record<string, unknown> => ({
  verdict: "approved",
  reviewedSha: gitHeadSha(repo, 10_000),
  summary: "Independent audit approved the change.",
  findings: [],
  notCovered: [],
});

test("reconcile respects human label changes and reprojects delivered", () => {
  const store = Store.open(":memory:");
  const moved: string[][] = [];
  const gh = ghStub({
    getIssueDetail: (_repo: string, issue: number) => ({
      number: issue,
      title: "t",
      body: "",
      updatedAt: "",
      labels: issue === 1 ? [{ name: "needs-info" }] : [{ name: "in-progress" }],
      blockedBy: [],
      comments: [],
    }),
    moveIssueLabel: (_repo: string, _issue: number, _cur: string[], _labels: unknown, _f: string, to: string) => {
      moved.push([String(_issue), to]);
    },
  });
  const ctx = testCtx(store, gh);
  assert.equal(reconcile(ctx).action, "no-active-job");
  store.upsertClaim({
    repo: "o/r",
    issue: 1,
    branch: "issue-1-a",
    baseSha: "a".repeat(40),
    digest: "d",
    owner: "t",
    leaseUntil: Date.now() + 60_000,
    mode: "implement",
  });
  const stopped = reconcile(ctx);
  assert.equal(stopped.action, "human-override-stopped");
  assert.equal(store.getJob("o/r", 1)?.stage, "blocked");
  store.upsertClaim({
    repo: "o/r",
    issue: 2,
    branch: "issue-2-b",
    baseSha: "a".repeat(40),
    digest: "d",
    owner: "t",
    leaseUntil: Date.now() + 60_000,
    mode: "implement",
  });
  store.setStage("o/r", 2, "delivered", {});
  assert.equal(reconcile(ctx).action, "reprojected-to-human");
  assert.deepEqual(moved, [["2", "ready-for-human"]]);
  store.close();
});

/* ---------------- 真实 git 交付链 ---------------- */

const sh = (cwd: string, ...args: string[]): string => {
  const result = spawnSync(args[0]!, args.slice(1), { encoding: "utf8", cwd });
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed: ${result.stderr}`);
  return (result.stdout ?? "").trim();
};

const initRepo = async (t: { after: (fn: () => Promise<void>) => void }): Promise<{ repo: string; state: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "iw-e2e-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  const origin = join(dir, "origin.git");
  const state = join(dir, "state");
  sh(dir, "git", "init", "--bare", origin);
  sh(dir, "git", "init", "-b", "main", repo);
  sh(repo, "git", "config", "user.email", "t@t.t");
  sh(repo, "git", "config", "user.name", "t");
  sh(repo, "git", "commit", "--allow-empty", "-m", "init");
  sh(repo, "git", "remote", "add", "origin", origin);
  sh(repo, "git", "push", "-u", "origin", "main");
  return { repo, state };
};

const setupAutoMergeDelivery = async (
  t: { after: (fn: () => Promise<void>) => void },
  options: {
    changedFile?: string;
    pullRequestHead?: string;
    rulesets?: RepositoryRuleset[];
    mergeResponse?: MergeApiResult;
    mergeResponses?: MergeApiResult[];
    gateAlreadyMerged?: boolean;
    mergeable?: () => boolean | null;
    checkRuns?: () => CheckRunSnapshot[];
    gateExit?: number;
    commentFailures?: number;
    labelFailures?: number;
    getPullRequest?: () => ReturnType<MergeGatePort["getPullRequest"]>;
  } = {},
) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const baseSha = gitHeadSha(repo, 10_000);
  const branch = "issue-7-controlled-merge";
  sh(repo, "git", "checkout", "-b", branch);
  const changedFile = options.changedFile ?? "docs/controlled-merge.md";
  const absoluteChanged = join(repo, changedFile);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(absoluteChanged), { recursive: true });
  await writeFile(absoluteChanged, "controlled merge\n", "utf8");
  sh(repo, "git", "add", changedFile);
  sh(repo, "git", "commit", "-m", "controlled merge change");
  const head = gitHeadSha(repo, 10_000);
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.timeouts.commandMs = 10_000;
  config.autoMerge = buildConfig(
    { autoMerge: { enabled: true, allowedScopes: ["docs", "test"] } },
    repo,
  ).autoMerge;
  const pathPolicy = evaluatePathPolicy([changedFile], config.autoMerge);
  const issueSnapshotHash = inputDigest({
    title: "Controlled merge",
    body: "Update docs.",
    comments: [],
    updatedAt: "",
  });
  const audit = (source: "zcode" | "ocr") => ({
    source,
    status: "passed" as const,
    verdict: "approved" as const,
    reviewedSha: head,
    baseSha,
    summary: `${source} approved ${head.slice(0, 8)}`,
    findings: [],
  });
  const mergeEvidence: MergeEvidence = {
    version: 1,
    stage: pathPolicy.allowed ? "audit_only" : "manual_only",
    repo: "o/r",
    issue: 7,
    prNumber: null,
    branch,
    baseRef: "main",
    baseSha,
    headSha: head,
    issueSnapshotHash,
    changedFiles: [changedFile],
    pathPolicy,
    zcode: audit("zcode"),
    ocr: audit("ocr"),
    controllerGates: [{ command: "pnpm test", exit: 0 }],
    github: null,
    reasons: pathPolicy.reasons,
  };
  const labels = new Map<number, string[]>([[7, ["in-progress"]]]);
  const comments: string[] = [];
  const prs = [{
    number: 17,
    url: "https://example/pr/17",
    body: `${WORKER_MARKER}\nlegacy`,
    state: "OPEN" as "OPEN" | "CLOSED" | "MERGED",
    mergedAt: null as string | null,
  }];
  const mergeCalls: { repo: string; prNumber: number; headSha: string }[] = [];
  let remoteMerged = options.gateAlreadyMerged === true;
  const mergeResponse = options.mergeResponse ?? {
    status: 200,
    merged: true,
    mergeCommitSha: "c".repeat(40),
    message: "Pull Request successfully merged",
    error: null,
  };
  const mergeResponses = options.mergeResponses === undefined ? null : [...options.mergeResponses];
  let commentFailures = options.commentFailures ?? 0;
  let labelFailures = options.labelFailures ?? 0;
  let issueDetailFailures = 0;
  const mergeGate: MergeGatePort = {
    getRepository: () => ({
      status: 200,
      data: { defaultBranch: "main" },
      error: null,
    }),
    getPullRequest: () =>
      options.getPullRequest?.() ?? {
        status: 200,
        data: {
          number: 17,
          url: "https://example/pr/17",
          state: remoteMerged ? "closed" : "open",
          merged: remoteMerged,
          mergeable: options.mergeable === undefined ? true : options.mergeable(),
          draft: false,
          headSha: options.pullRequestHead ?? head,
          baseSha,
          baseRef: "main",
        },
        error: null,
      },
    getBranchProtection: () => ({ status: 404, data: null, error: "not protected" }),
    listRulesets: () => ({
      status: 200,
      data: options.rulesets ?? [{ ...validRuleset }],
      error: null,
    }),
    listCheckRuns: () => ({
      status: 200,
      data:
        options.checkRuns?.() ?? [{ ...validCheckRun, headSha: options.pullRequestHead ?? head }],
      error: null,
    }),
    getCombinedStatus: () => ({ status: 200, data: [], error: null }),
    mergePullRequest: (input) => {
      mergeCalls.push(input);
      const response = mergeResponses === null ? mergeResponse : mergeResponses.shift()!;
      if (response.merged) {
        remoteMerged = true;
        prs[0]!.state = "MERGED";
      }
      return response;
    },
  };
  const gh = ghStub({
    getIssueDetail: () => {
      if (issueDetailFailures > 0) {
        issueDetailFailures -= 1;
        throw new Error("issue lookup unavailable");
      }
      return {
        number: 7,
        title: "Controlled merge",
        body: "Update docs.",
        updatedAt: "u",
        labels: (labels.get(7) ?? []).map((name) => ({ name })),
        blockedBy: [],
        comments: [...comments],
      };
    },
    listPullRequestsForBranch: () => [...prs],
    editPrBody: (_repo, prNumber, body) => {
      const pr = prs.find((item) => item.number === prNumber);
      if (pr !== undefined) pr.body = body;
    },
    commentIssue: (_repo, _issue, body) => {
      if (commentFailures > 0) {
        commentFailures -= 1;
        throw new Error("comment backend unavailable");
      }
      comments.push(body);
    },
    moveIssueLabel: (_repo, issue, _current, _labels, _from, to) => {
      if (labelFailures > 0) {
        labelFailures -= 1;
        throw new Error("label backend unavailable");
      }
      labels.set(issue, [to]);
    },
    createPr: () => {
      return "unexpected";
    },
  });
  store.upsertClaim({
    repo: "o/r",
    issue: 7,
    branch,
    baseSha,
    digest: issueSnapshotHash,
    owner: "pid:1",
    leaseUntil: Date.now() + 60_000,
    mode: "implement",
  });
  store.setStage("o/r", 7, "accepting", {
    base_sha: baseSha,
    head_sha: head,
    lease_until: Date.now() + 60_000,
    evidence_json: JSON.stringify({
      implementSummary: "Updated controlled merge docs.",
      commits: [head],
      changedFiles: [changedFile],
      notCovered: [],
      audit: {
        verdict: "approved",
        reviewedSha: head,
        summary: "ZCode approved the exact SHA.",
        findings: [],
      },
    }),
    merge_evidence_json: JSON.stringify(mergeEvidence),
  });
  const gitPort = {
    ...realGit,
    runGate: (gate: string[]) => ({
      command: gate.join(" "),
      exit: options.gateExit ?? 0,
    }),
  };
  const ctx: Ctx = {
    config,
    store,
    gh,
    git: gitPort,
    mergeGate,
    repoName: "o/r",
  };
  const detail = gh.getIssueDetail("o/r", 7, 10_000);
  const candidate = {
    row: detail,
    detail,
    mode: "implement" as const,
    digest: issueSnapshotHash,
    jobBranch: branch,
    jobPrNumber: null,
  };
  return {
    ctx,
    store,
    branch,
    baseSha,
    head,
    candidate,
    prs,
    comments,
    mergeCalls,
    labels,
    repo,
    failIssueDetailLookups: (count: number) => {
      issueDetailFailures = count;
    },
  };
};

test("pickCandidate orders by number and skips blocked", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const gh = ghStub({
    listReadyIssues: () => [
      { number: 9, title: "nine", body: "", updatedAt: "", labels: [], blockedBy: [] },
      { number: 7, title: "seven", body: "", updatedAt: "", labels: [], blockedBy: [] },
    ],
    getIssueDetail: (_r: string, issue: number) => ({
      number: issue,
      title: issue === 7 ? "seven" : "nine",
      body: issue === 9 ? "Depends on: #8" : "",
      updatedAt: "",
      labels: [{ name: "ready-for-agent" }],
      blockedBy: [],
      comments: [],
    }),
    isIssueClosed: (_r: string, issue: number) => issue !== 8,
    listPullRequestsForBranch: () => [],
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  const ctx: Ctx = { config, store, gh, git: realGit, mergeGate: realMergeGatePort, repoName: "o/r" };
  const candidate = pickCandidate(ctx);
  assert.ok(candidate !== null && candidate.row.number === 7, JSON.stringify(candidate?.row.number));
});

test("runIssueToDelivery delivers through gates and audit to PR", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const calls: string[] = [];
  const labelsLive = new Map<number, string[]>([[7, ["ready-for-agent"]]]);
  const prs: { number: number; url: string; body: string; state: "OPEN" | "CLOSED" | "MERGED"; mergedAt: string | null }[] = [];
  const gh = ghStub({
    listReadyIssues: () => [
      { number: 7, title: "Add thing", body: "do it", updatedAt: "u", labels: [{ name: "ready-for-agent" }], blockedBy: [] },
    ],
    getIssueDetail: () => ({
      number: 7,
      title: "Add thing",
      body: "do it",
      updatedAt: "u",
      labels: (labelsLive.get(7) ?? []).map((name) => ({ name })),
      blockedBy: [],
      comments: [],
    }),
    listPullRequestsForBranch: () => [...prs],
    createPr: (_r: string, input: { body: string }) => {
      calls.push(`createPr:${input.body.includes("Closes #7") ? "closes" : "NO-CLOSES"}`);
      prs.push({ number: 11, url: "https://example/pr/11", body: input.body, state: "OPEN", mergedAt: null });
      return "https://example/pr/11";
    },
    commentIssue: () => {
      calls.push("comment");
    },
    moveIssueLabel: (_r: string, issue: number, _c: string[], _l: unknown, _f: string, to: string) => {
      calls.push(`label:${to}`);
      labelsLive.set(issue, [to]);
    },
  });
  const gitPort = { ...realGit, runGate: () => ({ command: "echo gate", exit: 0 }) };
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.timeouts.commandMs = 10_000;
  const ctx: Ctx = { config, store, gh, git: gitPort, mergeGate: realMergeGatePort, repoName: "o/r" };
  const candidate = pickCandidate(ctx);
  assert.ok(candidate !== null);
  let auditComments: string | null = null;
  const launcher = {
    startImplement: async (_args: unknown, _logDir: string, _key: string): Promise<RunHandle> => {
      sh(repo, "git", "commit", "--allow-empty", "-m", "implement 7");
      return { runId: "dwfrun-impl-1", sessionId: "sess", launchPath: "app-server", child: null, app: null };
    },
    startAudit: async (args: { comments: string }): Promise<RunHandle> => {
      auditComments = args.comments;
      return {
        runId: "dwfrun-audit-1",
        sessionId: "sess",
        launchPath: "app-server",
        child: null,
        app: null,
      };
    },
    waitSettled: async (handle: RunHandle) => {
      if (handle.runId === "dwfrun-impl-1") {
        return {
          status: "completed",
          resultJson: {
            outcome: "implemented",
            summary: "Implemented issue 7.",
            commits: [gitHeadSha(repo, 10_000)],
            changedFiles: ["src/example.ts"],
            notCovered: ["UI smoke was not run for this backend-only change."],
          },
          failureJson: null,
        };
      }
      return {
        status: "completed",
        resultJson: {
          verdict: "approved",
          reviewedSha: gitHeadSha(repo, 10_000),
          summary: "Independent audit approved the change.",
          notCovered: ["No runtime injection test for the shutdown path."],
          findings: [
            {
              severity: "low",
              location: "src/a.ts:1",
              what: "A non-blocking cleanup remains.",
              evidence: "The test fixture still uses the old literal.",
              recommendation: "Move it to the shared constant.",
            },
          ],
        },
        failureJson: null,
      };
    },
    stop: () => {},
  };
  const outcome = await runIssueToDelivery(ctx, launcher, candidate!);
  assert.equal(outcome.final, "delivered");
  assert.ok(calls.some((call) => call === "createPr:closes"), JSON.stringify(calls));
  assert.ok(calls.includes("comment"));
  assert.ok(calls.includes("label:ready-for-human"));
  assert.equal(auditComments, "");
  const job = store.getJob("o/r", 7)!;
  assert.equal(job.stage, "delivered");
  assert.equal(job.pr_number, 11);
  assert.match(prs[0]!.body, /Implemented issue 7\./);
  assert.match(prs[0]!.body, /Independent audit approved the change\./);
  assert.match(prs[0]!.body, /UI smoke was not run for this backend-only change\./);
  assert.match(prs[0]!.body, /No runtime injection test for the shutdown path\./);
  assert.match(prs[0]!.body, /A non-blocking cleanup remains\./);
  assert.match(prs[0]!.body, /Move it to the shared constant\./);
  // 远端回读一致
  const remote = sh(repo, "git", "ls-remote", "--heads", "origin", job.branch!);
  assert.ok(remote.startsWith(job.head_sha!));
  // 已交付 + 无 ready 标签：再次扫描 no-op
  (gh.listReadyIssues as () => unknown[]).valueOf;
  const ghEmpty = ghStub({ ...({} as Partial<GhPort>), listReadyIssues: () => [] });
  const ctx2: Ctx = { config, store, gh: ghEmpty, git: gitPort, mergeGate: realMergeGatePort, repoName: "o/r" };
  assert.equal(pickCandidate(ctx2), null);
});

test("runIssueToDelivery maps implement blocked to ready-human", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const gh = ghStub({
    listReadyIssues: () => [
      { number: 7, title: "Add thing", body: "do it", updatedAt: "u", labels: [{ name: "ready-for-agent" }], blockedBy: [] },
    ],
    getIssueDetail: () => ({
      number: 7,
      title: "Add thing",
      body: "do it",
      updatedAt: "u",
      labels: [{ name: "in-progress" }],
      blockedBy: [],
      comments: [],
    }),
    listPullRequestsForBranch: () => [],
    moveIssueLabel: () => {},
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.maxImplementAttempts = 1;
  config.timeouts.commandMs = 10_000;
  const ctx: Ctx = { config, store, gh, git: realGit, mergeGate: realMergeGatePort, repoName: "o/r" };
  const candidate = pickCandidate(ctx);
  assert.ok(candidate !== null);
  const launcher = {
    startImplement: async (): Promise<RunHandle> => ({
      runId: "dwfrun-x",
      sessionId: null,
      launchPath: "app-server",
      child: null,
      app: null,
    }),
    startAudit: async (): Promise<RunHandle> => {
      throw new Error("must not audit a blocked implement");
    },
    waitSettled: async () => ({
      status: "completed",
      resultJson: { outcome: "blocked", blockers: ["no clue"] },
      failureJson: null,
    }),
    stop: () => {},
  };
  const outcome = await runIssueToDelivery(ctx, launcher, candidate!);
  assert.equal(outcome.final, "ready-human");
});

test("retryable provider failures do not consume an implementation attempt", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const labels = new Map<number, string[]>([[7, ["ready-for-agent"]]]);
  const prs: {
    number: number;
    url: string;
    body: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergedAt: string | null;
  }[] = [];
  const gh = ghStub({
    listReadyIssues: () => [
      {
        number: 7,
        title: "Retry me",
        body: "do it",
        updatedAt: "u",
        labels: [{ name: "ready-for-agent" }],
        blockedBy: [],
      },
    ],
    getIssueDetail: () => ({
      number: 7,
      title: "Retry me",
      body: "do it",
      updatedAt: "u",
      labels: (labels.get(7) ?? []).map((name) => ({ name })),
      blockedBy: [],
      comments: [],
    }),
    listPullRequestsForBranch: () => [...prs],
    createPr: (_repo: string, input: { body: string }) => {
      prs.push({
        number: 12,
        url: "https://example/pr/12",
        body: input.body,
        state: "OPEN",
        mergedAt: null,
      });
      return "https://example/pr/12";
    },
    moveIssueLabel: (_repo: string, issue: number, _current: string[], _labels: unknown, _from: string, to: string) => {
      labels.set(issue, [to]);
    },
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.maxImplementAttempts = 1;
  config.timeouts.commandMs = 10_000;
  config.timeouts.infraBackoffMs = [1];
  const gitPort = { ...realGit, runGate: () => ({ command: "echo gate", exit: 0 }) };
  const ctx: Ctx = { config, store, gh, git: gitPort, mergeGate: realMergeGatePort, repoName: "o/r" };
  const candidate = pickCandidate(ctx);
  assert.ok(candidate !== null);
  let waitCalls = 0;
  const launcher = {
    startImplement: async (): Promise<RunHandle> => ({
      runId: `impl-${++waitCalls}`,
      sessionId: "sess",
      launchPath: "app-server",
      child: null,
      app: null,
    }),
    startAudit: async (): Promise<RunHandle> => ({
      runId: "audit-1",
      sessionId: "sess",
      launchPath: "app-server",
      child: null,
      app: null,
    }),
    waitSettled: async (handle: RunHandle) => {
      if (handle.runId === "impl-1") {
        return {
          status: "failed",
          resultJson: null,
          failureJson: { code: "PROVIDER_BUSINESS_ERROR", message: "429 rate limit" },
        };
      }
      if (handle.runId === "impl-2") {
        sh(repo, "git", "commit", "--allow-empty", "-m", "implement retry");
        return { status: "completed", resultJson: implementationResult(repo), failureJson: null };
      }
      return {
        status: "completed",
        resultJson: auditResult(repo),
        failureJson: null,
      };
    },
    stop: () => {},
  };
  const outcome = await runIssueToDelivery(ctx, launcher, candidate!);
  assert.equal(outcome.final, "delivered");
  assert.equal(store.getJob("o/r", 7)?.implementation_attempt, 1);
});

test("rework rebases onto a moved main before handing the new HEAD to the DWF", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const baseSha = gitHeadSha(repo, 10_000);
  sh(repo, "git", "checkout", "-b", "issue-7-rebase");
  await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");
  sh(repo, "git", "add", "feature.txt");
  sh(repo, "git", "commit", "-m", "feature");
  const oldHead = gitHeadSha(repo, 10_000);
  store.upsertClaim({
    repo: "o/r",
    issue: 7,
    branch: "issue-7-rebase",
    baseSha,
    digest: "d",
    owner: "old",
    leaseUntil: Date.now() - 1,
    mode: "implement",
  });
  store.setStage("o/r", 7, "ready-human", {
    head_sha: oldHead,
    implementation_attempt: 3,
    lease_until: Date.now() - 1,
  });
  sh(repo, "git", "checkout", "main");
  await writeFile(join(repo, "main.txt"), "main moved\n", "utf8");
  sh(repo, "git", "add", "main.txt");
  sh(repo, "git", "commit", "-m", "move main");
  sh(repo, "git", "push", "origin", "main");
  const movedMain = gitHeadSha(repo, 10_000);
  sh(repo, "git", "checkout", "issue-7-rebase");

  const labels = new Map<number, string[]>([[7, ["in-progress"]]]);
  const gh = ghStub({
    getIssueDetail: () => ({
      number: 7,
      title: "Rebase rework",
      body: "",
      updatedAt: "",
      labels: (labels.get(7) ?? []).map((name) => ({ name })),
      blockedBy: [],
      comments: [],
    }),
    listPullRequestsForBranch: () => [],
    moveIssueLabel: (_repo: string, issue: number, _current: string[], _labels: unknown, _from: string, to: string) => {
      labels.set(issue, [to]);
    },
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.maxImplementAttempts = 1;
  config.timeouts.commandMs = 10_000;
  const ctx: Ctx = { config, store, gh, git: realGit, mergeGate: realMergeGatePort, repoName: "o/r" };
  const detail = gh.getIssueDetail("o/r", 7, 10_000);
  const candidate = {
    row: detail,
    detail,
    mode: "rework" as const,
    digest: "d2",
    jobBranch: "issue-7-rebase",
    jobPrNumber: null,
  };
  let dwfStart = "";
  const launcher = {
    startImplement: async (args: Record<string, unknown>): Promise<RunHandle> => {
      dwfStart = String(args["previousHeadSha"]);
      return {
        runId: "dwfrun-rebase",
        sessionId: "sess",
        launchPath: "app-server",
        child: null,
        app: null,
      };
    },
    startAudit: async (): Promise<RunHandle> => {
      throw new Error("unexpected audit");
    },
    waitSettled: async () => ({
      status: "completed",
      resultJson: { outcome: "blocked", blockers: ["stop after launch"] },
      failureJson: null,
    }),
    stop: () => {},
  };

  await runIssueToDelivery(ctx, launcher, candidate);
  const rebasedHead = gitHeadSha(repo, 10_000);
  assert.notEqual(rebasedHead, oldHead);
  assert.equal(dwfStart, rebasedHead);
  assert.equal(store.getJob("o/r", 7)?.base_sha, movedMain);
});

test("rework merges moved main into a pushed branch so delivery stays fast-forward", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const baseSha = gitHeadSha(repo, 10_000);
  sh(repo, "git", "checkout", "-b", "issue-8-pushed");
  await writeFile(join(repo, "feature.txt"), "feature\n", "utf8");
  sh(repo, "git", "add", "feature.txt");
  sh(repo, "git", "commit", "-m", "feature");
  const oldHead = gitHeadSha(repo, 10_000);
  sh(repo, "git", "push", "-u", "origin", "issue-8-pushed");
  store.upsertClaim({
    repo: "o/r",
    issue: 8,
    branch: "issue-8-pushed",
    baseSha,
    digest: "d",
    owner: "old",
    leaseUntil: Date.now() - 1,
    mode: "implement",
  });
  store.setStage("o/r", 8, "ready-human", {
    head_sha: oldHead,
    implementation_attempt: 3,
    lease_until: Date.now() - 1,
  });
  sh(repo, "git", "checkout", "main");
  await writeFile(join(repo, "main.txt"), "main moved\n", "utf8");
  sh(repo, "git", "add", "main.txt");
  sh(repo, "git", "commit", "-m", "move main");
  sh(repo, "git", "push", "origin", "main");
  const movedMain = gitHeadSha(repo, 10_000);
  sh(repo, "git", "checkout", "issue-8-pushed");

  const labels = new Map<number, string[]>([[8, ["in-progress"]]]);
  const prs: {
    number: number;
    url: string;
    body: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergedAt: string | null;
  }[] = [];
  const gh = ghStub({
    getIssueDetail: () => ({
      number: 8,
      title: "Pushed rework",
      body: "do it",
      updatedAt: "u",
      labels: (labels.get(8) ?? []).map((name) => ({ name })),
      blockedBy: [],
      comments: [],
    }),
    listPullRequestsForBranch: () => [...prs],
    createPr: (_repo: string, input: { body: string }) => {
      prs.push({
        number: 18,
        url: "https://example/pr/18",
        body: input.body,
        state: "OPEN",
        mergedAt: null,
      });
      return "https://example/pr/18";
    },
    moveIssueLabel: (_repo: string, issue: number, _current: string[], _labels: unknown, _from: string, to: string) => {
      labels.set(issue, [to]);
    },
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.timeouts.commandMs = 10_000;
  const gitPort = { ...realGit, runGate: () => ({ command: "echo gate", exit: 0 }) };
  const ctx: Ctx = { config, store, gh, git: gitPort, mergeGate: realMergeGatePort, repoName: "o/r" };
  const detail = gh.getIssueDetail("o/r", 8, 10_000);
  const candidate = {
    row: detail,
    detail,
    mode: "rework" as const,
    digest: "d2",
    jobBranch: "issue-8-pushed",
    jobPrNumber: null,
  };
  let dwfStart = "";
  const launcher = {
    startImplement: async (args: Record<string, unknown>): Promise<RunHandle> => {
      dwfStart = String(args["previousHeadSha"]);
      await writeFile(join(repo, "rework.txt"), "rework\n", "utf8");
      sh(repo, "git", "add", "rework.txt");
      sh(repo, "git", "commit", "-m", "rework");
      return {
        runId: "dwfrun-pushed-rework",
        sessionId: "sess",
        launchPath: "app-server",
        child: null,
        app: null,
      };
    },
    startAudit: async (): Promise<RunHandle> => ({
      runId: "dwfrun-pushed-audit",
      sessionId: "sess",
      launchPath: "app-server",
      child: null,
      app: null,
    }),
    waitSettled: async (handle: RunHandle) =>
      handle.runId === "dwfrun-pushed-rework"
        ? {
            status: "completed",
            resultJson: implementationResult(repo),
            failureJson: null,
          }
        : {
            status: "completed",
            resultJson: auditResult(repo),
            failureJson: null,
          },
    stop: () => {},
  };

  const outcome = await runIssueToDelivery(ctx, launcher, candidate);
  const deliveredHead = gitHeadSha(repo, 10_000);
  const remoteHead = sh(
    repo,
    "git",
    "ls-remote",
    "origin",
    "refs/heads/issue-8-pushed",
  ).split(/\s+/)[0];
  assert.equal(outcome.final, "delivered");
  assert.notEqual(dwfStart, oldHead);
  assert.equal(store.getJob("o/r", 8)?.base_sha, movedMain);
  assert.equal(remoteHead, deliveredHead);
  assert.equal(prs.length, 1);
  assert.match(prs[0]!.body, /Closes #8/);
});

test("accepting recovery re-runs gates and completes without a new implementation", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const baseSha = gitHeadSha(repo, 10_000);
  sh(repo, "git", "checkout", "-b", "issue-7-recover");
  await writeFile(join(repo, "recover.txt"), "recover\n", "utf8");
  sh(repo, "git", "add", "recover.txt");
  sh(repo, "git", "commit", "-m", "recover");
  const head = gitHeadSha(repo, 10_000);
  store.upsertClaim({
    repo: "o/r",
    issue: 7,
    branch: "issue-7-recover",
    baseSha,
    digest: "d",
    owner: "dead",
    leaseUntil: Date.now() - 1,
    mode: "implement",
  });
  store.setStage("o/r", 7, "accepting", {
    base_sha: baseSha,
    head_sha: head,
    lease_until: Date.now() - 1,
    evidence_json: JSON.stringify({
      implementSummary: "Recovered delivery evidence",
      commits: [head],
      changedFiles: ["src/recover.ts"],
      notCovered: [],
      audit: {
        verdict: "approved",
        reviewedSha: head,
        summary: "Independent audit approved the recovered head.",
        findings: [],
      },
    }),
  });
  const labels = new Map<number, string[]>([[7, ["in-progress"]]]);
  const prs: {
    number: number;
    url: string;
    body: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergedAt: string | null;
  }[] = [];
  const gh = ghStub({
    getIssueDetail: () => ({
      number: 7,
      title: "Recover",
      body: "",
      updatedAt: "",
      labels: (labels.get(7) ?? []).map((name) => ({ name })),
      blockedBy: [],
      comments: [],
    }),
    listPullRequestsForBranch: () => [...prs],
    createPr: (_repo: string, input: { body: string }) => {
      prs.push({
        number: 13,
        url: "https://example/pr/13",
        body: input.body,
        state: "OPEN",
        mergedAt: null,
      });
      return "https://example/pr/13";
    },
    moveIssueLabel: (_repo: string, issue: number, _current: string[], _labels: unknown, _from: string, to: string) => {
      labels.set(issue, [to]);
    },
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.timeouts.commandMs = 10_000;
  const gitPort = { ...realGit, runGate: () => ({ command: "echo gate", exit: 0 }) };
    const ctx: Ctx = { config, store, gh, git: gitPort, mergeGate: realMergeGatePort, repoName: "o/r" };
  const launcher = {
    startImplement: async (): Promise<RunHandle> => {
      throw new Error("must not implement during accepting recovery");
    },
    startAudit: async (): Promise<RunHandle> => {
      throw new Error("must not audit during accepting recovery");
    },
    waitSettled: async (): Promise<never> => {
      throw new Error("must not wait during accepting recovery");
    },
    stop: () => {},
  };
  const summary = await scanOnce(ctx, launcher, { onlyIssue: 7 });
  assert.match(summary, /delivered/);
  assert.equal(store.getJob("o/r", 7)?.stage, "delivered");
});

test("delivery refuses missing or invalid evidence before any remote write", async (t) => {
  const validEvidence = (head: string): Record<string, unknown> => ({
    implementSummary: "Delivery evidence",
    commits: [head],
    changedFiles: ["src/evidence.ts"],
    notCovered: [],
    audit: {
      verdict: "approved",
      reviewedSha: head,
      summary: "Independent audit approved the change.",
      findings: [
        {
          severity: "low",
          location: "src/a.ts:1",
          what: "A cleanup remains.",
          evidence: "The old branch is still present.",
          recommendation: "Remove it later.",
        },
      ],
    },
  });
  const cases: { name: string; raw: (head: string) => string | null }[] = [
    { name: "missing", raw: () => null },
    { name: "corrupt JSON", raw: () => "{" },
    {
      name: "wrong reviewed SHA",
      raw: (head) =>
        JSON.stringify({
          ...validEvidence(head),
          audit: { ...(validEvidence(head).audit as object), reviewedSha: "c".repeat(40) },
        }),
    },
    {
      name: "incomplete finding",
      raw: (head) => {
        const evidence = validEvidence(head);
        const audit = evidence.audit as { findings: Record<string, unknown>[] };
        audit.findings = [{ severity: "low", location: "src/a.ts:1", what: "Missing evidence" }];
        return JSON.stringify(evidence);
      },
    },
  ];
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const { repo, state } = await initRepo(t);
      const store = Store.open(stateDbPathFor(state));
      t.after(async () => store.close());
      const head = gitHeadSha(repo, 10_000);
      const branch = "issue-7-invalid-evidence";
      store.upsertClaim({
        repo: "o/r",
        issue: 7,
        branch,
        baseSha: head,
        digest: "d",
        owner: "pid:1",
        leaseUntil: Date.now() + 60_000,
        mode: "implement",
      });
      const raw = item.raw(head);
      store.setStage("o/r", 7, "accepting", {
        base_sha: head,
        head_sha: head,
        lease_until: Date.now() + 60_000,
        ...(raw === null ? {} : { evidence_json: raw }),
      });
      let createCalls = 0;
      const comments: string[] = [];
      const gh = ghStub({
        getIssueDetail: () => ({
          number: 7,
          title: "Invalid evidence",
          body: "",
          updatedAt: "",
          labels: [{ name: "in-progress" }],
          blockedBy: [],
          comments: [],
        }),
        createPr: () => {
          createCalls += 1;
          return "https://example/pr/15";
        },
        commentIssue: (_repo, _issue, body) => {
          comments.push(body);
        },
      });
      const config = defaultConfig(repo);
      config.repoName = "o/r";
      config.stateDir = state;
      const ctx: Ctx = { config, store, gh, git: realGit, mergeGate: realMergeGatePort, repoName: "o/r" };
      const detail = gh.getIssueDetail("o/r", 7, 10_000);
      const candidate = {
        row: detail,
        detail,
        mode: "implement" as const,
        digest: "d",
        jobBranch: branch,
        jobPrNumber: null,
      };
      const outcome = await deliverAcceptedJob(
        ctx,
        candidate,
        branch,
        head,
        head,
      );
      assert.equal(outcome.final, "ready-human");
      assert.match(outcome.detail, /delivery evidence missing or invalid/);
      assert.equal(createCalls, 0);
      assert.equal(comments.length, 0);
      assert.equal(store.getJob("o/r", 7)?.stage, "ready-human");
    });
  }
});

test("delivery replays remote writes without duplicating the PR or comment", async (t) => {
  const { repo, state } = await initRepo(t);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const baseSha = gitHeadSha(repo, 10_000);
  sh(repo, "git", "checkout", "-b", "issue-7-idempotent");
  await writeFile(join(repo, "idempotent.txt"), "idempotent\n", "utf8");
  sh(repo, "git", "add", "idempotent.txt");
  sh(repo, "git", "commit", "-m", "idempotent");
  const head = gitHeadSha(repo, 10_000);
  store.upsertClaim({
    repo: "o/r",
    issue: 7,
    branch: "issue-7-idempotent",
    baseSha,
    digest: "d",
    owner: "pid:1",
    leaseUntil: Date.now() + 60_000,
    mode: "implement",
  });
  store.setStage("o/r", 7, "accepting", {
    base_sha: baseSha,
    head_sha: head,
    lease_until: Date.now() + 60_000,
    evidence_json: JSON.stringify({
      implementSummary: "Durable delivery evidence",
      commits: [head],
      changedFiles: ["src/durable.ts"],
      notCovered: ["UI smoke was not needed"],
      audit: {
        verdict: "approved",
        reviewedSha: head,
        summary: "Independent audit found no blocking issue.",
        findings: [
          {
            severity: "low",
            location: "src/a.ts:1",
            what: "A cleanup remains",
            evidence: "The old helper is still present.",
            recommendation: "Remove it in a follow-up.",
          },
        ],
      },
    }),
  });
  const labels = new Map<number, string[]>([[7, ["in-progress"]]]);
  const comments: string[] = [
    `${WORKER_MARKER}\nissue-worker delivered: #7 @ ${head}\n\nlegacy evidence without audit`,
  ];
  const prs: {
    number: number;
    url: string;
    body: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergedAt: string | null;
  }[] = [
    {
      number: 14,
      url: "https://example/pr/14",
      body: `${WORKER_MARKER}\nlegacy body without audit evidence`,
      state: "OPEN",
      mergedAt: null,
    },
  ];
  let editCalls = 0;
  const gh = ghStub({
    getIssueDetail: () => ({
      number: 7,
      title: "Idempotent",
      body: "",
      updatedAt: "",
      labels: (labels.get(7) ?? []).map((name) => ({ name })),
      blockedBy: [],
      comments: [...comments],
    }),
    listPullRequestsForBranch: () => [...prs],
    editPrBody: (_repo: string, prNumber: number, body: string) => {
      editCalls += 1;
      const pr = prs.find((item) => item.number === prNumber);
      assert.ok(pr !== undefined);
      pr.body = body;
    },
    commentIssue: (_repo: string, _issue: number, body: string) => {
      comments.push(body);
    },
    moveIssueLabel: (_repo: string, issue: number, _current: string[], _labels: unknown, _from: string, to: string) => {
      labels.set(issue, [to]);
    },
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.timeouts.commandMs = 10_000;
  const ctx: Ctx = {
    config,
    store,
    gh,
    git: { ...realGit, runGate: () => ({ command: "pnpm test", exit: 0 }) },
    mergeGate: realMergeGatePort,
    repoName: "o/r",
  };
  const detail = gh.getIssueDetail("o/r", 7, 10_000);
  const candidate = {
    row: detail,
    detail,
    mode: "implement" as const,
    digest: "d",
    jobBranch: "issue-7-idempotent",
    jobPrNumber: null,
  };
  await deliverAcceptedJob(ctx, candidate, "issue-7-idempotent", baseSha, head);
  const commentKey = outboxKeyFor("comment_issue", {
    issue: 7,
    phase: "delivered",
    headSha: head,
    content: comments[1]!,
  });
  store.markOutbox("comment_issue", commentKey, "pending");
  await deliverAcceptedJob(ctx, candidate, "issue-7-idempotent", baseSha, head);
  assert.match(prs[0]!.body, /Durable delivery evidence/);
  assert.match(prs[0]!.body, /Independent audit found no blocking issue/);
  assert.match(prs[0]!.body, /A cleanup remains/);
  assert.match(prs[0]!.body, /The old helper is still present/);
  prs[0]!.body = "manual edit after delivery";
  await deliverAcceptedJob(ctx, candidate, "issue-7-idempotent", baseSha, head);
  assert.equal(editCalls, 1);
  assert.equal(comments.length, 2);
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.body, "manual edit after delivery");
  assert.match(comments[1]!, /UI smoke was not needed/);
});

test("issue lifecycle runs OCR on the audited SHA before controlled merge", async (t) => {
  const { repo, state } = await initRepo(t);
  const baseSha = gitHeadSha(repo, 10_000);
  const store = Store.open(stateDbPathFor(state));
  t.after(async () => store.close());
  const binDir = await mkdtemp(join(tmpdir(), "iw-ocr-bin-"));
  t.after(async () => rm(binDir, { recursive: true, force: true }));
  const ocrArgsPath = join(binDir, "ocr-args.txt");
  const ocrAttemptsPath = join(binDir, "ocr-attempts.txt");
  const ocrOutputsPath = join(binDir, "ocr-outputs.txt");
  const ocrPath = join(binDir, "ocr");
  writeFileSync(
    ocrPath,
    `#!/bin/sh
printf '%s\\n' "$@" > "$OCR_ARGS_CAPTURE"
attempts=0
if [ -f "$OCR_ATTEMPTS_CAPTURE" ]; then
  attempts=$(cat "$OCR_ATTEMPTS_CAPTURE")
fi
attempts=$((attempts + 1))
printf '%s' "$attempts" > "$OCR_ATTEMPTS_CAPTURE"
out=''
from=''
to=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; out="$1" ;;
    --from) shift; from="$1" ;;
    --to) shift; to="$1" ;;
  esac
  shift
done
printf '%s\\n' "$out" >> "$OCR_OUTPUTS_CAPTURE"
if [ "$attempts" -eq 1 ]; then
  printf '429 rate limit\\n' >&2
  exit 1
fi
printf '%s\\n' "{\\"status\\":\\"complete\\",\\"message\\":\\"OCR approved.\\",\\"session_id\\":\\"ocr-e2e\\",\\"comments\\":[],\\"manifest\\":{\\"terminal_state\\":\\"complete\\",\\"input\\":{\\"resolved_base\\":\\"$from\\",\\"resolved_head\\":\\"$to\\",\\"exact_range\\":\\"$from..$to\\"},\\"coverage\\":{\\"selected\\":[{\\"item_id\\":\\"fixture-item\\",\\"path\\":\\"src/fixture.ts\\",\\"fingerprint\\":\\"fixture-fingerprint\\"}],\\"completed\\":[{\\"item_id\\":\\"fixture-item\\",\\"path\\":\\"src/fixture.ts\\",\\"fingerprint\\":\\"fixture-fingerprint\\"}],\\"reused\\":[],\\"failed\\":[],\\"waived\\":[]}}}" > "$out"
`,
    "utf8",
  );
  chmodSync(ocrPath, 0o755);
  const savedPath = process.env.PATH;
  const savedArgsCapture = process.env.OCR_ARGS_CAPTURE;
  const savedAttemptsCapture = process.env.OCR_ATTEMPTS_CAPTURE;
  const savedOutputsCapture = process.env.OCR_OUTPUTS_CAPTURE;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  process.env.OCR_ARGS_CAPTURE = ocrArgsPath;
  process.env.OCR_ATTEMPTS_CAPTURE = ocrAttemptsPath;
  process.env.OCR_OUTPUTS_CAPTURE = ocrOutputsPath;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedArgsCapture === undefined) delete process.env.OCR_ARGS_CAPTURE;
    else process.env.OCR_ARGS_CAPTURE = savedArgsCapture;
    if (savedAttemptsCapture === undefined) delete process.env.OCR_ATTEMPTS_CAPTURE;
    else process.env.OCR_ATTEMPTS_CAPTURE = savedAttemptsCapture;
    if (savedOutputsCapture === undefined) delete process.env.OCR_OUTPUTS_CAPTURE;
    else process.env.OCR_OUTPUTS_CAPTURE = savedOutputsCapture;
  });

  const labels = new Map<number, string[]>([[7, ["ready-for-agent"]]]);
  const prs: {
    number: number;
    url: string;
    body: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergedAt: string | null;
  }[] = [];
  const mergeCalls: { repo: string; prNumber: number; headSha: string }[] = [];
  let remoteMerged = false;
  const mergeGate: MergeGatePort = {
    getRepository: () => ({
      status: 200,
      data: { defaultBranch: "main" },
      error: null,
    }),
    getPullRequest: () => ({
      status: 200,
      data: {
        number: 27,
        url: "https://example/pr/27",
        state: remoteMerged ? "closed" : "open",
        merged: remoteMerged,
        mergeable: true,
        draft: false,
        headSha: gitHeadSha(repo, 10_000),
        baseSha,
        baseRef: "main",
      },
      error: null,
    }),
    getBranchProtection: () => ({ status: 404, data: null, error: "not protected" }),
    listRulesets: () => ({ status: 200, data: [{ ...validRuleset }], error: null }),
    listCheckRuns: () => ({
      status: 200,
      data: [{ ...validCheckRun, headSha: gitHeadSha(repo, 10_000) }],
      error: null,
    }),
    getCombinedStatus: () => ({ status: 200, data: [], error: null }),
    mergePullRequest: (input) => {
      mergeCalls.push(input);
      remoteMerged = true;
      return {
        status: 200,
        merged: true,
        mergeCommitSha: "c".repeat(40),
        message: "merged",
        error: null,
      };
    },
  };
  const gh = ghStub({
    listReadyIssues: () => [
      {
        number: 7,
        title: "Add auto merge docs",
        body: "Document automatic merge.",
        updatedAt: "u",
        labels: [{ name: "ready-for-agent" }],
        blockedBy: [],
      },
    ],
    getIssueDetail: () => ({
      number: 7,
      title: "Add auto merge docs",
      body: "Document automatic merge.",
      updatedAt: "u",
      labels: (labels.get(7) ?? []).map((name) => ({ name })),
      blockedBy: [],
      comments: [],
    }),
    listPullRequestsForBranch: () => [...prs],
    createPr: (_repo, input) => {
      prs.push({
        number: 27,
        url: "https://example/pr/27",
        body: input.body,
        state: "OPEN",
        mergedAt: null,
      });
      return "https://example/pr/27";
    },
    editPrBody: (_repo, prNumber, body) => {
      const pr = prs.find((item) => item.number === prNumber);
      if (pr !== undefined) pr.body = body;
    },
    moveIssueLabel: (_repo, issue, _current, _labels, _from, to) => {
      labels.set(issue, [to]);
    },
  });
  const config = defaultConfig(repo);
  config.repoName = "o/r";
  config.stateDir = state;
  config.timeouts.commandMs = 10_000;
  config.timeouts.ocrMs = 5_000;
  config.timeouts.infraBackoffMs = [1];
  config.autoMerge = buildConfig(
    { autoMerge: { enabled: true, allowedScopes: ["docs", "test"] } },
    repo,
  ).autoMerge;
  const gitPort = { ...realGit, runGate: () => ({ command: "pnpm test", exit: 0 }) };
  const ctx: Ctx = { config, store, gh, git: gitPort, mergeGate, repoName: "o/r" };
  const candidate = pickCandidate(ctx);
  assert.ok(candidate !== null);
  const launcher = {
    startImplement: async (): Promise<RunHandle> => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(join(repo, "docs"), { recursive: true });
      await writeFile(join(repo, "docs", "auto-merge.md"), "auto merge\n", "utf8");
      sh(repo, "git", "add", "docs/auto-merge.md");
      sh(repo, "git", "commit", "-m", "document auto merge");
      return {
        runId: "dwfrun-ocr-e2e",
        sessionId: "sess",
        launchPath: "app-server",
        child: null,
        app: null,
      };
    },
    startAudit: async (): Promise<RunHandle> => ({
      runId: "dwfrun-ocr-audit",
      sessionId: "sess",
      launchPath: "app-server",
      child: null,
      app: null,
    }),
    waitSettled: async (handle: RunHandle) =>
      handle.runId === "dwfrun-ocr-e2e"
        ? {
            status: "completed",
            resultJson: {
              outcome: "implemented",
              summary: "Documented automatic merge.",
              commits: [gitHeadSha(repo, 10_000)],
              changedFiles: ["docs/auto-merge.md"],
              notCovered: [],
            },
            failureJson: null,
          }
        : {
            status: "completed",
            resultJson: {
              verdict: "approved",
              reviewedSha: gitHeadSha(repo, 10_000),
              summary: "ZCode approved the documentation.",
              findings: [],
              notCovered: [],
            },
            failureJson: null,
          },
    stop: () => {},
  };
  const outcome = await runIssueToDelivery(ctx, launcher, candidate);
  assert.equal(outcome.final, "merged");
  const auditedHead = gitHeadSha(repo, 10_000);
  assert.equal(mergeCalls.length, 1);
  assert.equal(mergeCalls[0]?.headSha, auditedHead);
  const ocrArgs = (await readFile(ocrArgsPath, "utf8")).trim().split("\n");
  assert.equal(await readFile(ocrAttemptsPath, "utf8"), "2");
  const ocrOutputs = (await readFile(ocrOutputsPath, "utf8")).trim().split("\n");
  assert.equal(ocrOutputs.length, 2);
  assert.match(ocrOutputs[0]!, /review-attempt-1\.json$/);
  assert.match(ocrOutputs[1]!, /review-attempt-2\.json$/);
  assert.ok(ocrArgs.includes("--from"));
  assert.ok(ocrArgs.includes(baseSha));
  assert.ok(ocrArgs.includes("--to"));
  assert.ok(ocrArgs.includes(auditedHead));
  assert.equal(store.getJob("o/r", 7)?.stage, "merged");
  assert.ok(store.recentEvents("o/r", 7, 50).some((row) => row.kind === "infra-backoff"));
});

test("merged accepting recovery verifies the job branch before delivery", async (t) => {
  const setup = await setupAutoMergeDelivery(t);
  const evidence = parseMergeEvidence(setup.store.getJob("o/r", 7)?.merge_evidence_json ?? null)!;
  evidence.stage = "merged";
  setup.store.setStage("o/r", 7, "accepting", {
    merge_evidence_json: JSON.stringify(evidence),
  });
  sh(setup.repo, "git", "checkout", "-b", "wrong-branch");
  assert.equal(sh(setup.repo, "git", "branch", "--show-current"), "wrong-branch");

  const launcher = {
    startImplement: async (): Promise<never> => {
      throw new Error("must not implement during merged recovery");
    },
    startAudit: async (): Promise<never> => {
      throw new Error("must not audit during merged recovery");
    },
    waitSettled: async (): Promise<never> => {
      throw new Error("must not wait during merged recovery");
    },
    stop: () => {},
  };
  const summary = await scanOnce(setup.ctx, launcher, { onlyIssue: 7 });
  assert.match(summary, /merged/);
  assert.equal(setup.store.getJob("o/r", 7)?.stage, "merged");
  assert.equal(sh(setup.repo, "git", "branch", "--show-current"), setup.branch);
});

test("controlled delivery merges the audited head once and records evidence", async (t) => {
  const setup = await setupAutoMergeDelivery(t);
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "merged");
  assert.equal(setup.mergeCalls.length, 1);
  assert.deepEqual(setup.mergeCalls[0], {
    repo: "o/r",
    prNumber: 17,
    headSha: setup.head,
  });
  const job = setup.store.getJob("o/r", 7)!;
  assert.equal(job.stage, "merged");
  const evidence = JSON.parse(job.merge_evidence_json!) as MergeEvidence;
  assert.equal(evidence.stage, "merged");
  assert.equal(evidence.headSha, setup.head);
  assert.equal(evidence.zcode.status, "passed");
  assert.equal(evidence.ocr?.status, "passed");
  assert.equal(evidence.github?.conclusion, "success");
  assert.deepEqual(evidence.controllerGates, [
    { command: "pnpm typecheck", exit: 0 },
    { command: "pnpm test", exit: 0 },
  ]);
  assert.equal(evidence.mergeOutcome?.merged, true);
  assert.deepEqual(setup.labels.get(7), ["ready-for-human"]);
  const key = outboxKeyFor("merge_pr", { branch: setup.branch, headSha: setup.head });
  assert.equal(setup.store.getOutbox("merge_pr", key)?.state, "done");
  const events = setup.store.recentEvents("o/r", 7, 20).map((row) => row.kind);
  assert.ok(events.includes("merge-gate-evaluated"));
  assert.ok(events.includes("merge-started"));
  assert.ok(events.includes("merged"));
  assert.ok(setup.comments.some((body) => body.includes("merge stage: merged")));

  const replay = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(replay.final, "merged");
  assert.equal(setup.mergeCalls.length, 1, "same head replay must not call merge API twice");
});

test("legacy merge evidence remains non-authoritative", async (t) => {
  const setup = await setupAutoMergeDelivery(t);
  const legacy = JSON.stringify({
    stage: "merged",
    repo: "o/r",
    issue: 7,
    branch: setup.branch,
    headSha: setup.head,
  });
  assert.equal(parseMergeEvidence(legacy), null);
  setup.store.setStage("o/r", 7, "accepting", { merge_evidence_json: legacy });

  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.match(outcome.detail, /dual-audit evidence is missing/);
  assert.equal(setup.mergeCalls.length, 0);
});

test("missing OCR evidence fails closed without throwing", async (t) => {
  const setup = await setupAutoMergeDelivery(t);
  const evidence = parseMergeEvidence(setup.store.getJob("o/r", 7)?.merge_evidence_json ?? null)!;
  evidence.ocr = null;
  setup.store.setStage("o/r", 7, "accepting", {
    merge_evidence_json: JSON.stringify(evidence),
  });

  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.match(outcome.detail, /dual-audit evidence is missing/);
  assert.equal(setup.mergeCalls.length, 0);
});

test("pending merge inputs keep accepting and merge after checks turn green", async (t) => {
  const checkRuns: CheckRunSnapshot[] = [];
  let mergeable: boolean | null = null;
  const setup = await setupAutoMergeDelivery(t, {
    checkRuns: () => checkRuns,
    mergeable: () => mergeable,
  });
  checkRuns.push({
    ...validCheckRun,
    headSha: setup.head,
    status: "queued",
    conclusion: null,
  });
  const staleEvidence = parseMergeEvidence(setup.store.getJob("o/r", 7)?.merge_evidence_json ?? null)!;
  staleEvidence.changedFiles = ["docs/stale.md"];
  staleEvidence.controllerGates = [{ command: "stale gate", exit: 1 }];
  setup.store.setStage("o/r", 7, "accepting", {
    merge_evidence_json: JSON.stringify(staleEvidence),
  });
  const first = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(first.final, "accepting");
  assert.equal(setup.mergeCalls.length, 0);
  const waitingJob = setup.store.getJob("o/r", 7)!;
  assert.equal(waitingJob.stage, "accepting");
  assert.equal(waitingJob.delivery_attempt, 1);
  const waitingEvidence = parseMergeEvidence(waitingJob.merge_evidence_json);
  assert.equal(waitingEvidence?.stage, "waiting");
  assert.ok((waitingEvidence?.mergeWaitStartedAt ?? 0) > 0);
  assert.ok((waitingEvidence?.github?.pendingReasons.length ?? 0) >= 1);
  assert.deepEqual(waitingEvidence?.changedFiles, ["docs/controlled-merge.md"]);
  assert.deepEqual(
    waitingEvidence?.controllerGates.map((gate) => gate.command),
    ["pnpm typecheck", "pnpm test"],
  );
  assert.equal(waitingEvidence?.github?.conclusion, "waiting");
  assert.equal(
    setup.store.getOutbox(
      "merge_pr",
      outboxKeyFor("merge_pr", { branch: setup.branch, headSha: setup.head }),
    ),
    null,
  );

  mergeable = true;
  checkRuns[0] = { ...validCheckRun, headSha: setup.head };
  const second = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(second.final, "merged");
  assert.equal(setup.mergeCalls.length, 1);
  assert.equal(setup.store.getJob("o/r", 7)?.delivery_attempt, 1);
});

test("merge wait deadline turns a still-pending gate into ready-human", async (t) => {
  const setup = await setupAutoMergeDelivery(t, {
    mergeable: () => null,
  });
  setup.ctx.config.timeouts.mergeMs = 1;
  const job = setup.store.getJob("o/r", 7)!;
  const evidence = parseMergeEvidence(job.merge_evidence_json)!;
  evidence.mergeWaitStartedAt = Date.now() - 10;
  setup.store.setStage("o/r", 7, "accepting", {
    merge_evidence_json: JSON.stringify(evidence),
  });
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.match(outcome.detail, /merge wait timed out/);
  assert.equal(setup.mergeCalls.length, 0);
  const failed = setup.store.getJob("o/r", 7)!;
  assert.equal(failed.stage, "ready-human");
  assert.equal(parseMergeEvidence(failed.merge_evidence_json)?.stage, "blocked");
});

test("base revalidation failures use the bounded merge wait", async (t) => {
  const setup = await setupAutoMergeDelivery(t);
  setup.ctx.config.timeouts.mergeMs = 1_000;
  const originBranchSha = setup.ctx.git.originBranchSha.bind(setup.ctx.git);
  let calls = 0;
  setup.ctx.git.originBranchSha = (...args) => {
    calls += 1;
    if (calls % 2 === 0) throw new Error("temporary base read failure");
    return originBranchSha(...args);
  };

  const first = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(first.final, "accepting");
  const waitingEvidence = parseMergeEvidence(
    setup.store.getJob("o/r", 7)?.merge_evidence_json ?? null,
  );
  assert.ok(waitingEvidence !== null);
  assert.equal(waitingEvidence?.stage, "waiting");
  assert.ok(
    waitingEvidence?.reasons.some((reason) => reason.includes("base branch revalidation failed")),
  );
  assert.equal(setup.mergeCalls.length, 0);

  waitingEvidence.mergeWaitStartedAt =
    Date.now() - setup.ctx.config.timeouts.mergeMs - 1_000;
  setup.store.setStage("o/r", 7, "accepting", {
    merge_evidence_json: JSON.stringify(waitingEvidence),
  });
  const second = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(second.final, "ready-human");
  assert.match(second.detail, /merge wait timed out/);
  assert.equal(setup.mergeCalls.length, 0);
});

test("completed merge_pr outbox waits when the PR read is transient", async (t) => {
  const setup = await setupAutoMergeDelivery(t, {
    getPullRequest: () => ({
      status: null,
      data: null,
      error: "temporary GitHub timeout",
    }),
  });
  const key = outboxKeyFor("merge_pr", { branch: setup.branch, headSha: setup.head });
  setup.store.enqueueOutbox({
    repo: "o/r",
    issue: 7,
    action: "merge_pr",
    idempotencyKey: key,
    payload: { branch: setup.branch, headSha: setup.head },
  });
  setup.store.markOutbox("merge_pr", key, "done");
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "accepting");
  assert.match(outcome.detail, /pull request unavailable after merge_pr completed/);
  assert.equal(setup.mergeCalls.length, 0);
  assert.equal(setup.store.getJob("o/r", 7)?.stage, "accepting");
  assert.equal(setup.store.getOutbox("merge_pr", key)?.state, "done");
  assert.match(
    parseMergeEvidence(setup.store.getJob("o/r", 7)?.merge_evidence_json ?? null)?.reasons.join("; ") ??
      "",
    /pull request unavailable after merge_pr completed/,
  );
});

test("unknown merge API outcome keeps the outbox pending for a safe retry", async (t) => {
  const setup = await setupAutoMergeDelivery(t, {
    mergeResponses: [
      {
        status: null,
        merged: false,
        mergeCommitSha: null,
        message: "timeout",
        error: "merge request timed out",
      },
      {
        status: 200,
        merged: true,
        mergeCommitSha: "c".repeat(40),
        message: "merged",
        error: null,
      },
    ],
  });
  const key = outboxKeyFor("merge_pr", { branch: setup.branch, headSha: setup.head });
  const first = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(first.final, "accepting");
  assert.equal(setup.store.getOutbox("merge_pr", key)?.state, "pending");
  assert.equal(setup.store.getJob("o/r", 7)?.stage, "accepting");
  const second = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(second.final, "merged");
  assert.equal(setup.mergeCalls.length, 2);
  assert.equal(setup.store.getOutbox("merge_pr", key)?.state, "done");
});

test("missing GitHub required-check rules refuse auto-merge", async (t) => {
  const setup = await setupAutoMergeDelivery(t, { rulesets: [] });
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.equal(setup.mergeCalls.length, 0);
  const job = setup.store.getJob("o/r", 7)!;
  assert.equal(job.stage, "ready-human");
  assert.match(job.last_error ?? "", /no valid GitHub rule/);
  const key = outboxKeyFor("merge_pr", { branch: setup.branch, headSha: setup.head });
  assert.equal(setup.store.getOutbox("merge_pr", key), null);
  const events = setup.store.recentEvents("o/r", 7, 30).map((row) => row.kind);
  assert.ok(events.includes("merge-gate-evaluated"));
  assert.ok(!events.includes("merge-started"));
});

test("PR head drift invalidates the merge authorization before the API call", async (t) => {
  const setup = await setupAutoMergeDelivery(t, {
    pullRequestHead: "d".repeat(40),
  });
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.equal(setup.mergeCalls.length, 0);
  assert.match(setup.store.getJob("o/r", 7)?.last_error ?? "", /PR head changed/);
});

test("a merged PR without a merge attempt is not claimed as an auto-merge", async (t) => {
  const setup = await setupAutoMergeDelivery(t, { gateAlreadyMerged: true });
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.equal(setup.mergeCalls.length, 0);
  assert.equal(setup.store.getJob("o/r", 7)?.stage, "ready-human");
  assert.match(setup.store.getJob("o/r", 7)?.last_error ?? "", /already merged/);
});

test("final controller gates rerun on the audited head before remote writes", async (t) => {
  const setup = await setupAutoMergeDelivery(t, { gateExit: 1 });
  const before = setup.prs[0]!.body;
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.match(outcome.detail, /final controller gates red/);
  assert.equal(setup.mergeCalls.length, 0);
  assert.equal(setup.comments.length, 0);
  assert.equal(setup.prs[0]!.body, before);
  assert.equal(gitMod.lsRemoteHead(setup.repo, setup.branch, 10_000), null);
});

test("merged comment failure retries without duplicating the comment", async (t) => {
  const setup = await setupAutoMergeDelivery(t, { commentFailures: 1 });
  const first = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(first.final, "accepting");
  assert.equal(setup.mergeCalls.length, 1);
  const pending = setup.store.getJob("o/r", 7)!;
  assert.equal(pending.stage, "accepting");
  assert.match(pending.last_error ?? "", /merged finalization pending \(comment\)/);
  assert.equal(parseMergeEvidence(pending.merge_evidence_json)?.stage, "merged");
  assert.equal(setup.comments.length, 0);
  assert.deepEqual(setup.labels.get(7), ["in-progress"]);
  assert.ok(
    setup.store.pendingOutbox("o/r", 7).some((item) => item.action === "comment_issue"),
  );

  const second = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(second.final, "merged");
  assert.equal(setup.mergeCalls.length, 1);
  assert.equal(setup.comments.length, 1);
  assert.deepEqual(setup.labels.get(7), ["ready-for-human"]);
  assert.equal(setup.store.getJob("o/r", 7)?.stage, "merged");
});

test("merged label failure retries after the comment was already posted", async (t) => {
  const setup = await setupAutoMergeDelivery(t, { labelFailures: 1 });
  const first = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(first.final, "accepting");
  assert.match(
    setup.store.getJob("o/r", 7)?.last_error ?? "",
    /merged finalization pending \(label\)/,
  );
  assert.equal(setup.comments.length, 1);
  assert.deepEqual(setup.labels.get(7), ["in-progress"]);

  const second = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(second.final, "merged");
  assert.equal(setup.mergeCalls.length, 1);
  assert.equal(setup.comments.length, 1);
  assert.deepEqual(setup.labels.get(7), ["ready-for-human"]);
});

test("merged finalization failures stop at a wall-clock deadline", async (t) => {
  const expireFinalization = (
    setup: Awaited<ReturnType<typeof setupAutoMergeDelivery>>,
  ): void => {
    const evidence = parseMergeEvidence(
      setup.store.getJob("o/r", 7)?.merge_evidence_json ?? null,
    );
    assert.equal(evidence?.stage, "merged");
    assert.equal(typeof evidence?.finalizationStartedAt, "number");
    evidence.finalizationStartedAt =
      Date.now() - setup.ctx.config.timeouts.mergeMs - 1_000;
    setup.store.setStage("o/r", 7, "accepting", {
      merge_evidence_json: JSON.stringify(evidence),
    });
  };

  await t.test("lookup", async (t) => {
    const setup = await setupAutoMergeDelivery(t);
    setup.ctx.config.timeouts.mergeMs = 1_000;
    setup.prs[0]!.state = "MERGED";
    const outboxKey = outboxKeyFor("merge_pr", {
      branch: setup.branch,
      headSha: setup.head,
    });
    setup.store.enqueueOutbox({
      repo: "o/r",
      issue: 7,
      action: "merge_pr",
      idempotencyKey: outboxKey,
      payload: { branch: setup.branch, headSha: setup.head },
    });
    setup.store.markOutbox("merge_pr", outboxKey, "done");
    setup.failIssueDetailLookups(100);
    const first = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(first.final, "accepting");
    expireFinalization(setup);

    const second = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(second.final, "ready-human");
    assert.match(second.detail, /merged finalization timed out/);
    assert.equal(setup.store.getJob("o/r", 7)?.stage, "ready-human");
    assert.equal(parseMergeEvidence(setup.store.getJob("o/r", 7)?.merge_evidence_json ?? null)?.stage, "merged");
  });

  await t.test("comment", async (t) => {
    const setup = await setupAutoMergeDelivery(t, { commentFailures: 100 });
    setup.ctx.config.timeouts.mergeMs = 1_000;
    const first = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(first.final, "accepting");
    expireFinalization(setup);

    const second = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(second.final, "ready-human");
    assert.equal(setup.comments.length, 0);
    assert.equal(setup.store.getJob("o/r", 7)?.stage, "ready-human");
  });

  await t.test("label", async (t) => {
    const setup = await setupAutoMergeDelivery(t, { labelFailures: 100 });
    setup.ctx.config.timeouts.mergeMs = 1_000;
    const first = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(first.final, "accepting");
    assert.equal(setup.comments.length, 1);
    expireFinalization(setup);

    const second = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(second.final, "ready-human");
    assert.equal(setup.comments.length, 1);
    assert.equal(setup.store.getJob("o/r", 7)?.stage, "ready-human");
  });
});

test("missing PR number stops before controlled merge", async (t) => {
  const setup = await setupAutoMergeDelivery(t);
  setup.prs.length = 0;
  const outcome = await deliverAcceptedJob(
    setup.ctx,
    setup.candidate,
    setup.branch,
    setup.baseSha,
    setup.head,
  );
  assert.equal(outcome.final, "ready-human");
  assert.match(outcome.detail, /PR number is unavailable/);
  assert.equal(setup.mergeCalls.length, 0);
  assert.equal(setup.comments.length, 0);
});

test("protected paths and HTTP 422 never auto-merge", async (t) => {
  await t.test("protected path", async (t) => {
    const setup = await setupAutoMergeDelivery(t, {
      changedFile: "tools/issue-worker/generated.ts",
    });
    const outcome = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(outcome.final, "delivered");
    assert.equal(setup.mergeCalls.length, 0);
    assert.equal(setup.store.getJob("o/r", 7)?.stage, "delivered");
  });

  await t.test("422 response", async (t) => {
    const setup = await setupAutoMergeDelivery(t, {
      mergeResponse: {
        status: 422,
        merged: false,
        mergeCommitSha: null,
        message: "Validation Failed",
        error: "head sha does not match",
      },
    });
    const outcome = await deliverAcceptedJob(
      setup.ctx,
      setup.candidate,
      setup.branch,
      setup.baseSha,
      setup.head,
    );
    assert.equal(outcome.final, "ready-human");
    assert.equal(setup.mergeCalls.length, 1);
    assert.deepEqual(setup.mergeCalls[0], {
      repo: "o/r",
      prNumber: 17,
      headSha: setup.head,
    });
    assert.match(
      setup.store.getJob("o/r", 7)?.last_error ?? "",
      /head SHA changed|re-audit required/,
    );
    const key = outboxKeyFor("merge_pr", { branch: setup.branch, headSha: setup.head });
    assert.equal(setup.store.getOutbox("merge_pr", key)?.state, "failed");
  });
});

test("CLI daemon --help exits zero", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "tools/issue-worker/cli.ts", "daemon", "--help"],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /issue-worker daemon/);
  assert.match(result.stdout, /timeouts\.mergeMs/);
});

/* ---------------- 生产约束回归 ---------------- */

test("tools sources stay strip-types erasable", async () => {
  const dir = new URL("../tools/issue-worker/", import.meta.url);
  const { readdir } = await import("node:fs/promises");
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(new URL(file, dir), "utf8");
    assert.ok(!/\bconstructor\s*\([^)]*\b(private|protected|public|readonly)\b/.test(text), `${file}: no parameter properties`);
    assert.ok(!/^enum\s/m.test(text), `${file}: no enums`);
    assert.ok(!/^namespace\s/m.test(text), `${file}: no namespaces`);
  }
});
