#!/usr/bin/env node
// 跟进 zai-org/ZCode 上游并重建补丁 bundle（headless workspace hook trust 修复）。
// 产物部署到 ~/.zcode/patched-bundle/<cli版本>/zcode.cjs，current 符号链接指向最新。
// v1 daemon 用安装版 bundle 不依赖本脚本；本脚本服务「增强档」与给上游的分支保鲜。
// 用法：node scripts/zcode-patch-follow.mjs [--skip-test]
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UPSTREAM_URL = "https://github.com/zai-org/ZCode.git";
const MAIN_CHECKOUT = join(homedir(), "Documents/workspace/ZCode");
const WORKTREE = join(homedir(), "Documents/workspace/zcode-headless-hooks");
const BRANCH = "fix/headless-workspace-hook-trust";
const OUT_ROOT = join(homedir(), ".zcode/patched-bundle");
const PNPM = join(homedir(), "Library/pnpm/bin/pnpm");
const run = (cmd, cwd, opts = {}) =>
  execSync(cmd, { cwd, stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8" });
const out = (cmd, cwd) => execSync(cmd, { cwd, encoding: "utf8" }).trim();

const skipTest = process.argv.includes("--skip-test");

// 单实例锁：构建期不允许第二个跟进进程
const lock = "/tmp/zcode-patch-follow.lock";
if (existsSync(lock)) {
  console.error(`另一实例运行中（${lock} 存在），退出。`);
  process.exit(1);
}
mkdirSync(lock, { recursive: true });
try {
  // 1. 主检出确保 upstream remote，并抓取
  const remotes = out("git remote", MAIN_CHECKOUT).split("\n");
  if (!remotes.includes("upstream")) run(`git remote add upstream ${UPSTREAM_URL}`, MAIN_CHECKOUT);
  console.log("fetch upstream …");
  run("git fetch upstream --quiet", MAIN_CHECKOUT, { quiet: true });
  const upstreamHead = out("git rev-parse --short upstream/main", MAIN_CHECKOUT);

  // 2. worktree 里 rebase 补丁分支；冲突即中止，绝不猜
  run(`git checkout ${BRANCH}`, WORKTREE, { quiet: true });
  const before = out("git rev-parse --short HEAD", WORKTREE);
  try {
    run("git rebase upstream/main", WORKTREE, { quiet: true });
  } catch {
    run("git rebase --abort", WORKTREE, { quiet: true });
    throw new Error(`rebase 到 upstream/main@${upstreamHead} 冲突：人工解决后重跑（补丁仅 ${BRANCH} 一个提交）。`);
  }
  const after = out("git rev-parse --short HEAD", WORKTREE);
  console.log(`rebase：${before} -> ${after}（基于 upstream/main@${upstreamHead}）`);

  // 3. 依赖与构建（与首次构建同一套已验证命令）
  console.log("install + build …");
  run(`${PNPM} install --prefer-offline`, WORKTREE);
  run(`${PNPM} run -r --if-present build`, join(WORKTREE, "apps/zcode-cli"));

  // 4. 定向回归：补丁契约测试必须绿
  if (!skipTest) {
    run(
      `node --disable-warning=DEP0205 --import tsx --test --test-name-pattern "workspace hook trust" tests/cli.unit.test.ts`,
      join(WORKTREE, "apps/zcode-cli/packages/cli"),
    );
  }

  // 5. 部署到稳定路径（版本目录 + current 链接，先写临时目录再原子换名）
  const cliVersion = JSON.parse(
    readFileSync(join(WORKTREE, "apps/zcode-cli/package.json"), "utf8"),
  ).version;
  const bundle = join(WORKTREE, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
  const destDir = join(OUT_ROOT, cliVersion);
  const staging = join(OUT_ROOT, `.staging-${cliVersion}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  run(`cp "${bundle}" "${staging}/zcode.cjs"`, WORKTREE);
  chmodExec(join(staging, "zcode.cjs"));
  rmSync(destDir, { recursive: true, force: true });
  renameSync(staging, destDir);
  const current = join(OUT_ROOT, "current");
  rmSync(current, { recursive: true, force: true });
  symlinkSync(destDir, current);
  console.log(`部署完成：${join(destDir, "zcode.cjs")}`);
  console.log(`增强档入口：${join(current, "zcode.cjs")}（daemon 配 zcodeBin 指向它）`);
} finally {
  rmSync(lock, { recursive: true, force: true });
}

function chmodExec(p) {
  execSync(`chmod +x "${p}"`);
}
