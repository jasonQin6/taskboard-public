/**
 * Git 面：分支命名、SHA 校验、门选择（纯函数）+ 无 shell 的 git 封装。
 * 不可信 issue 文本只进 argv 值位置，且分支/SHA 先过正则；命令名全是编译期字面量。
 */
import { spawnSync } from "node:child_process";

export const BRANCH_PATTERN = /^issue-[0-9]+-[a-z0-9-]+$/;
export const SHA_PATTERN = /^[0-9a-f]{40}$/;

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export const runGit = (args: string[], cwd: string, timeoutMs: number): GitResult => {
  const result = spawnSync("git", args, { encoding: "utf8", timeout: timeoutMs, cwd });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export const checkGit = (args: string[], cwd: string, timeoutMs: number): string => {
  const result = runGit(args, cwd, timeoutMs);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.slice(0, 500)}`);
  }
  return result.stdout.trim();
};

export const assertBranch = (branch: string): string => {
  if (!BRANCH_PATTERN.test(branch)) throw new Error(`invalid branch name: ${branch}`);
  return branch;
};

export const assertSha = (sha: string): string => {
  if (!SHA_PATTERN.test(sha)) throw new Error(`invalid sha: ${sha}`);
  return sha;
};

export const slugify = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "task" : slug;
};

export const branchFor = (prefix: string, issue: number, title: string): string =>
  assertBranch(`${prefix}${issue}-${slugify(title)}`);

export const worktreeClean = (cwd: string, timeoutMs: number): boolean =>
  checkGit(["status", "--porcelain"], cwd, timeoutMs) === "";

export const headSha = (cwd: string, timeoutMs: number): string =>
  assertSha(checkGit(["rev-parse", "HEAD"], cwd, timeoutMs));

export const parentOfHead = (cwd: string, timeoutMs: number): string =>
  assertSha(checkGit(["rev-parse", "HEAD^"], cwd, timeoutMs));

export const fetchOrigin = (cwd: string, timeoutMs: number): void => {
  checkGit(["fetch", "origin"], cwd, timeoutMs);
};

export const originBranchSha = (
  cwd: string,
  baseBranch: string,
  timeoutMs: number,
): string => assertSha(checkGit(["rev-parse", `origin/${baseBranch}`], cwd, timeoutMs));

export const localBranchExists = (cwd: string, branch: string, timeoutMs: number): boolean => {
  const result = runGit(["rev-parse", "--verify", `refs/heads/${assertBranch(branch)}`], cwd, timeoutMs);
  return result.status === 0;
};

export const createBranchFrom = (
  cwd: string,
  branch: string,
  baseSha: string,
  timeoutMs: number,
): void => {
  checkGit(["checkout", "-b", assertBranch(branch), assertSha(baseSha)], cwd, timeoutMs);
};

export const checkoutBranch = (cwd: string, branch: string, timeoutMs: number): void => {
  checkGit(["checkout", assertBranch(branch)], cwd, timeoutMs);
};

export const changedFilesVs = (
  cwd: string,
  baseSha: string,
  timeoutMs: number,
): string[] => {
  const committed = runGit(["diff", "--name-only", `${assertSha(baseSha)}..HEAD`], cwd, timeoutMs);
  if (committed.status !== 0) throw new Error(`git diff failed: ${committed.stderr.slice(0, 300)}`);
  const uncommitted = runGit(["status", "--porcelain"], cwd, timeoutMs);
  const files = new Set<string>();
  for (const line of committed.stdout.split("\n")) {
    const name = line.trim();
    if (name !== "") files.add(name);
  }
  for (const line of uncommitted.stdout.split("\n")) {
    const name = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
    if (name !== "") files.add(name);
  }
  return [...files].sort();
};

export const protectedDirsChanged = (
  cwd: string,
  baseSha: string,
  timeoutMs: number,
): string[] => {
  const changed = changedFilesVs(cwd, baseSha, timeoutMs);
  return changed.filter(
    (file) => file.startsWith(".zcode/workflows/") || file.startsWith("tools/issue-worker/"),
  );
};

export const gatesForDiff = (defaultGates: string[][], changedFiles: string[]): string[][] => {
  const needsUi = changedFiles.some(
    (file) =>
      file.startsWith("web/") ||
      file === "scripts/ui-smoke.ts" ||
      file.startsWith("vite.config.") ||
      file === "package.json" ||
      file === "pnpm-lock.yaml",
  );
  const gates = defaultGates.map((gate) => [...gate]);
  if (needsUi && !gates.some((gate) => gate.join(" ") === "pnpm test:ui")) {
    gates.push(["pnpm", "test:ui"]);
  }
  return gates;
};

export const pushBranch = (
  cwd: string,
  branch: string,
  timeoutMs: number,
): void => {
  checkGit(["push", "-u", "origin", assertBranch(branch)], cwd, timeoutMs);
};

export const lsRemoteHead = (
  cwd: string,
  branch: string,
  timeoutMs: number,
): string | null => {
  const out = checkGit(["ls-remote", "--heads", "origin", assertBranch(branch)], cwd, timeoutMs);
  const first = out.split("\n")[0]?.trim() ?? "";
  if (first === "") return null;
  const sha = first.split(/\s+/)[0] ?? "";
  return SHA_PATTERN.test(sha) ? sha : null;
};

export const rebaseOnto = (
  cwd: string,
  baseRef: string,
  timeoutMs: number,
): boolean => {
  const result = runGit(["rebase", baseRef], cwd, timeoutMs);
  if (result.status === 0) return true;
  runGit(["rebase", "--abort"], cwd, timeoutMs);
  return false;
};

/** 已推送分支不能用 rebase 改写历史；merge 保持远端祖先关系，交付时仍可 fast-forward。 */
export const mergeOnto = (
  cwd: string,
  baseRef: string,
  timeoutMs: number,
): boolean => {
  const result = runGit(["merge", "--no-edit", baseRef], cwd, timeoutMs);
  if (result.status === 0) return true;
  runGit(["merge", "--abort"], cwd, timeoutMs);
  return false;
};

export const runGate = (
  gate: string[],
  cwd: string,
  timeoutMs: number,
): { command: string; exit: number } => {
  const [command, ...args] = gate;
  if (command === undefined || command === "") throw new Error("empty gate command");
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, cwd });
  if (result.error !== undefined) throw result.error;
  return { command: gate.join(" "), exit: result.status ?? 1 };
};
