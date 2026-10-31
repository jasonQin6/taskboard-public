/**
 * WorktreeManager：isolated_worktree 模式的 git 执行面（issue #9 / 故事 70–73）。
 * 只调系统 git（child_process），不引入运行时依赖；所有状态落 Store 事务（单一写者不变量）。
 * 保留语义：ensure 复用或新开一档记录，绝不删除；clean 是验收后的显式动作，
 * 未合并的 branch 由 git -d 拒绝（绝不静默丢工作），失败保留 worktree 与 branch 证据。
 * 不 push、不 merge、不重试——那些动作不存在于这个类里。
 */

import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import type { Store } from "./store/index.js";
import type { Task, WorktreeRecord } from "./types.js";

const execFile = promisify(execFileCb);

export interface WorktreeManagerOptions {
  store: Store;
  /** worktree 母目录（daemon 按数据库同目录装配：<dbDir>/worktrees）。 */
  root: string;
  /** 测试注入假 git 可执行；缺省系统 git。 */
  gitCommand?: string;
}

export interface EnsureResult {
  path: string;
  branch: string;
  /** 本次是否新开一档（false = 复用既有 worktree）。 */
  created: boolean;
}

export interface CleanResult {
  /** 本次真的清理了（false = 本来就没有未清理的记录，幂等重放）。 */
  cleaned: boolean;
  /** 清理后的最新记录（可能仍是历史记录）；从未创建过则 null。 */
  worktree: WorktreeRecord | null;
}

export class WorktreeManager {
  private readonly store: Store;
  private readonly root: string;
  private readonly gitCommand: string;

  constructor(options: WorktreeManagerOptions) {
    this.store = options.store;
    this.root = options.root;
    this.gitCommand = options.gitCommand ?? "git";
  }

  /**
   * Run 起跑前确保任务有可用 worktree，返回交给 harness 的 cwd。
   * 已有生效记录 → 复用（目录被外部移走时重新挂回同一 branch）；
   * 没有生效记录（从未创建或上次已清理）→ 从基准分支新开一档。
   */
  async ensureForTask(task: Task): Promise<EnsureResult> {
    if (task.workspace === null) throw new ValidationError(`task has no workspace: ${task.id}`);
    const existing = this.store.activeWorktreeOf(task.id);
    if (existing !== null) {
      if (existing.sourceWorkspace !== task.workspace) {
        throw new ValidationError(
          `worktree ${existing.path} was created from workspace ${existing.sourceWorkspace}, ` +
            `but the task now points to ${task.workspace}; point the task back or clean the worktree up (after acceptance)`,
        );
      }
      if (existsSync(existing.path)) {
        return { path: existing.path, branch: existing.branch, created: false };
      }
      // 自愈：目录被外部移走 → prune 清掉 git 的残留登记后把同一 branch 重新挂回来
      const createFailure = {
        label: `failed to create isolated worktree for task ${task.id} (re-registering ${existing.path})`,
        error: (message: string) => new ValidationError(message),
      };
      await this.runGit(task.workspace, ["worktree", "prune"], createFailure);
      if (await this.branchExists(task.workspace, existing.branch)) {
        await this.runGit(
          task.workspace,
          ["worktree", "add", existing.path, existing.branch],
          createFailure,
        );
        return { path: existing.path, branch: existing.branch, created: false };
      }
      // 注册的 branch 已被手工删除：旧记录不得保持 active——否则两个 active 行并存，
      // 新档清理后 clean() 会永久卡在「删除不存在的 branch」上且 markWorktreeRemoved 永不抵达
      this.store.markWorktreeRemoved(task.id, existing.seq);
    }
    return this.createWorktree(task);
  }

  /** 新开一档：branch `taskboard/<taskId>/<seq>`，从基准分支（缺 settings 时 git 默认 HEAD）创建。 */
  private async createWorktree(task: Task): Promise<EnsureResult> {
    if (task.workspace === null) throw new ValidationError(`task has no workspace: ${task.id}`);
    const seq = this.store.countWorktrees(task.id) + 1;
    const branch = `taskboard/${task.id}/${seq}`;
    const path = join(this.root, task.id, String(seq));
    const baseBranch = this.store.getSettings().worktreeBaseBranch;
    const args = ["worktree", "add", "-b", branch, path];
    if (baseBranch !== null) args.push(baseBranch);
    // git 需要叶子目录的父链存在
    await mkdir(dirname(path), { recursive: true });
    await this.runGit(task.workspace, args, {
      label:
        `failed to create isolated worktree for task ${task.id} ` +
        `(branch ${branch} from ${baseBranch ?? "HEAD"})`,
      error: (message) => new ValidationError(message),
    });
    const record = this.store.insertWorktree({
      taskId: task.id,
      seq,
      branch,
      path,
      baseBranch,
      sourceWorkspace: task.workspace,
    });
    return { path: record.path, branch: record.branch, created: true };
  }

  /**
   * 验收后的显式清理（幂等）：删 worktree 目录 → 删 branch → 落 removedAt。
   * 门：有活跃 Run 或任务未验收（done/archived 之外）都拒绝；目录已不在走 prune 收残留；
   * branch 未合并由 git -d 拒绝并保留 branch（人话指路 merge 或手工 -D）。
   */
  async clean(taskId: string): Promise<CleanResult> {
    const task = this.store.requireTask(taskId);
    const record = this.store.activeWorktreeOf(taskId);
    if (record === null) {
      return { cleaned: false, worktree: this.store.latestWorktreeOf(taskId) };
    }
    if (this.store.activeRunOf(taskId) !== null) {
      throw new ConflictError(`task ${taskId} has an active run; cancel it before cleaning the worktree`);
    }
    if (task.status !== "done" && !task.archived) {
      throw new ConflictError(
        `task ${taskId} is ${task.status}; worktree cleanup waits for acceptance (done or archived) — ` +
          "branch, commits and the worktree stay as review evidence until then",
      );
    }
    if (existsSync(record.path)) {
      // --force：验收后人话确认过；未提交的残留文件不属于保留证据（commit 都在 branch 上）
      await this.runGit(record.sourceWorkspace, ["worktree", "remove", "--force", record.path], {
        label: `worktree cleanup failed for task ${taskId} (removing ${record.path})`,
        error: (message) => new ConflictError(message),
      });
    } else {
      await this.runGit(record.sourceWorkspace, ["worktree", "prune"], {
        label: `worktree cleanup failed for task ${taskId} (pruning stale registration for ${record.path})`,
        error: (message) => new ConflictError(message),
      });
    }
    try {
      await this.runGit(record.sourceWorkspace, ["branch", "-d", record.branch], {
        label:
          `worktree cleanup failed for task ${taskId} (deleting branch ${record.branch}; ` +
          "unmerged branches are refused — merge it or delete it by hand)",
        error: (message) => new ConflictError(message),
      });
    } catch (error) {
      // branch 已被手工删除：清理目标（目录与 branch 证据收口）已达成，视为已清
      const message = error instanceof Error ? error.message : String(error);
      if (!/branch .*not found/i.test(message)) throw error;
    }
    const removed = this.store.markWorktreeRemoved(taskId, record.seq);
    return { cleaned: true, worktree: removed };
  }

  private async branchExists(repo: string, branch: string): Promise<boolean> {
    try {
      await execFile(this.gitCommand, ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /** git 失败 → 人话错误：带上意图、基准分支与 git stderr（保留排障证据）。 */
  private async runGit(
    repo: string,
    args: string[],
    failure: { label: string; error: (message: string) => Error },
  ): Promise<void> {
    try {
      await execFile(this.gitCommand, ["-C", repo, ...args]);
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      const detail = (err.stderr ?? err.message ?? String(error)).trim();
      throw failure.error(`${failure.label}: ${detail}`);
    }
  }
}
