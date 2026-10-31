/** 单 daemon 文件锁：进程存活性的带外标记，不是数据库状态（不经 Store 事务）。 */

import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

export class DaemonLockHeldError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holderPid: number,
  ) {
    super(
      `another daemon holds the lock at ${lockPath} (holder pid ${holderPid}); ` +
        `if it is dead, the lock expires once its heartbeat goes stale`,
    );
    this.name = "DaemonLockHeldError";
  }
}

export interface DaemonLockOptions {
  /** 心跳间隔：持有期间每隔这么久重写锁文件刷新 mtime。默认 30s。 */
  heartbeatMs?: number;
  /** 新鲜阈值：锁 mtime 距今小于该值视为有活着的持有者。默认 90s（= 3 个心跳）。 */
  staleMs?: number;
}

export interface DaemonLockIdentity {
  pid: number;
  startedAt: string;
}

export interface DaemonLock {
  readonly path: string;
  readonly identity: DaemonLockIdentity;
  /** 删锁并停心跳。幂等；若锁已被他人抢走则不删（见 release 内注释）。 */
  release: () => Promise<void>;
}

export const daemonLockPathFor = (dbPath: string): string => `${dbPath}.lock`;

export const DEFAULT_HEARTBEAT_MS = 30_000;
export const DEFAULT_STALE_MS = 90_000;

interface LockContent extends DaemonLockIdentity {
  heartbeatAt: string;
}

const isLockContent = (value: unknown): value is LockContent => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LockContent>;
  return (
    typeof candidate.pid === "number" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.heartbeatAt === "string"
  );
};

/** 读锁内容；损坏/为空/不是合法 JSON → null（调用方按「陈旧」处理，见 acquireDaemonLock）。 */
const readLockContent = async (lockPath: string): Promise<LockContent | null> => {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isLockContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const acquireDaemonLock = async (
  lockPath: string,
  options: DaemonLockOptions = {},
): Promise<DaemonLock> => {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const identity: DaemonLockIdentity = { pid: process.pid, startedAt: new Date().toISOString() };

  // EEXIST 后的「读—判新鲜—抢」可能与其他进程的抢锁者竞争，限次重试后放弃。
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        const content: LockContent = { ...identity, heartbeatAt: identity.startedAt };
        await handle.writeFile(`${JSON.stringify(content, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return buildHeldLock(lockPath, identity, heartbeatMs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await readLockContent(lockPath);
// 写锁是「创建后立即写」两步：半截内容只可能来自已死创建者，按陈旧抢锁。
      if (held !== null && (await isLockFresh(lockPath, staleMs))) {
        throw new DaemonLockHeldError(lockPath, held.pid);
      }
      await unlink(lockPath).catch(() => undefined); // 竞争者抢先删掉也无妨，下轮重试
    }
  }
  throw new DaemonLockHeldError(lockPath, (await readLockContent(lockPath))?.pid ?? -1);
};

const isLockFresh = async (lockPath: string, staleMs: number): Promise<boolean> => {
  try {
    const stats = await stat(lockPath);
    return Date.now() - stats.mtimeMs < staleMs;
  } catch {
    return false; // 锁文件消失 = 无持有者
  }
};

const buildHeldLock = (lockPath: string, identity: DaemonLockIdentity, heartbeatMs: number): DaemonLock => {
  let timer: NodeJS.Timeout | undefined;
  if (heartbeatMs > 0) {
    timer = setInterval(() => {
      void heartbeat(lockPath, identity);
    }, heartbeatMs);
    timer.unref(); // 心跳不保活进程；daemon 的存活由 HTTP server 句柄负责
  }
  const release = async (): Promise<void> => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    // 只删「仍是自己身份」的锁：若锁已被他人抢走（我们的心跳早已停写），
    const content = await readLockContent(lockPath);
    if (content !== null && content.pid === identity.pid && content.startedAt === identity.startedAt) {
      await unlink(lockPath).catch(() => undefined);
    }
  };
  return { path: lockPath, identity, release };
};

const heartbeat = async (lockPath: string, identity: DaemonLockIdentity): Promise<void> => {
  const content = await readLockContent(lockPath);
  if (content === null || content.pid !== identity.pid || content.startedAt !== identity.startedAt) {
    return; // 锁被抢/被删：停止刷新（timer 由下一次 release 清理）
  }
  const fresh: LockContent = { ...content, heartbeatAt: new Date().toISOString() };
// 直接 writeFile 是「截断→写」两步，并发读者会读到空文件；rename 原子替换消除窗口。
  const tempPath = `${lockPath}.tmp-${process.pid}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
    await rename(tempPath, lockPath);
  } catch {
    await unlink(tempPath).catch(() => undefined); // 本轮心跳失败不打紧，下轮重试
  }
};
