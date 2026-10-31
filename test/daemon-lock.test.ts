/**
 * 单实例锁的文件语义（纯锁层）。daemon 装配层的双启/接管/SIGTERM 场景在 test/daemon.test.ts。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { acquireDaemonLock, DaemonLockHeldError, daemonLockPathFor } from "../src/daemon-lock.js";

const tmpDirs: string[] = [];
afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

const makeDbPath = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-lock-"));
  tmpDirs.push(dir);
  return join(dir, "taskboard.sqlite");
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("acquire creates <db>.lock with pid+startedAt; release removes it", async () => {
  const dbPath = await makeDbPath();
  const lockPath = daemonLockPathFor(dbPath);
  const lock = await acquireDaemonLock(lockPath);
  try {
    const raw = await readFile(lockPath, "utf8");
    const content = JSON.parse(raw) as { pid: number; startedAt: string };
    assert.equal(content.pid, process.pid);
    assert.equal(Number.isNaN(Date.parse(content.startedAt)), false);
    // 数据库文件本身不该被锁的获取触碰（锁先于打开数据库）
    assert.equal(await stat(dbPath).then(() => true, () => false), false);
  } finally {
    await lock.release();
  }
  await assert.rejects(stat(lockPath), /ENOENT/);
  // 释放后可重新获取（同一进程内两段语义闭环）
  const again = await acquireDaemonLock(lockPath);
  await again.release();
});

test("fresh lock rejects second acquirer reporting holder pid", async () => {
  const dbPath = await makeDbPath();
  const lockPath = daemonLockPathFor(dbPath);
  const first = await acquireDaemonLock(lockPath, { staleMs: 60_000, heartbeatMs: 0 });
  try {
    await assert.rejects(
      acquireDaemonLock(lockPath, { staleMs: 60_000, heartbeatMs: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof DaemonLockHeldError);
        assert.equal(error.holderPid, process.pid);
        assert.match(error.message, new RegExp(`pid ${process.pid}`));
        return true;
      },
    );
  } finally {
    await first.release();
  }
});

test("stale lock (heartbeat expired) is stolen by new acquirer", async () => {
  const dbPath = await makeDbPath();
  const lockPath = daemonLockPathFor(dbPath);
  const first = await acquireDaemonLock(lockPath, { heartbeatMs: 0 });
  // 模拟持有者 kill -9 后心跳停摆：把 mtime 回拨到阈值之外
  const dead = new Date(Date.now() - 10 * 60_000);
  await utimes(lockPath, dead, dead);
  const second = await acquireDaemonLock(lockPath, { staleMs: 90_000, heartbeatMs: 0 });
  try {
    const content = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    assert.equal(content.pid, process.pid);
  } finally {
    await second.release();
  }
});

test("heartbeat refreshes mtime and preserves identity", async () => {
  const dbPath = await makeDbPath();
  const lockPath = daemonLockPathFor(dbPath);
  const lock = await acquireDaemonLock(lockPath, { heartbeatMs: 15, staleMs: 60_000 });
  try {
    const initial = await stat(lockPath);
    await sleep(80); // > 4 个心跳周期
    const after = await stat(lockPath);
    assert.ok(after.mtimeMs > initial.mtimeMs, "heartbeat should bump mtime");
    const content = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid: number;
      startedAt: string;
    };
    assert.equal(content.pid, process.pid);
    assert.equal(content.startedAt, lock.identity.startedAt);
  } finally {
    await lock.release();
  }
});

test("concurrent reads during heartbeats never see partial lock content (atomic rewrite)", async () => {
  // 心跳写曾经是「截断→写」两步：并发读者落在截断后写入前会读到空文件，
  // 抢锁方会把活着的持有者误判为陈旧。钉死原子重写（临时文件 + rename）后
  // 每次读都必须是完整 JSON（旧或新内容之一，身份恒为持有者）。
  const dbPath = await makeDbPath();
  const lockPath = daemonLockPathFor(dbPath);
  const lock = await acquireDaemonLock(lockPath, { heartbeatMs: 5, staleMs: 60_000 });
  try {
    for (let i = 0; i < 60; i += 1) {
      const content = JSON.parse(await readFile(lockPath, "utf8")) as {
        pid: number;
        startedAt: string;
      };
      assert.equal(content.pid, process.pid, `read ${i} saw torn content`);
      assert.equal(content.startedAt, lock.identity.startedAt);
    }
  } finally {
    await lock.release();
  }
});

test("corrupt lock content is treated as stale and stolen", async () => {
  // 写锁 = 创建 + 写内容两步，半截内容只可能来自已死的创建者；等它没有意义。
  const dbPath = await makeDbPath();
  const lockPath = daemonLockPathFor(dbPath);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(lockPath, "", "utf8"); // 新鲜 mtime + 空内容
  const lock = await acquireDaemonLock(lockPath, { heartbeatMs: 0 });
  try {
    const content = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    assert.equal(content.pid, process.pid);
  } finally {
    await lock.release();
  }
});

test("stolen holder neither overwrites nor deletes the new holder's lock", async () => {
  const dbPath = await makeDbPath();
  const lockPath = daemonLockPathFor(dbPath);
  // A 心跳周期拉长：让「心跳定时器仍活着」与「锁 mtime 已陈旧可被抢」不互相打架
  // （模拟持有者事件循环停摆/机器休眠 > 90s 后被抢锁，醒来后还有一次待触发的旧心跳）。
  const a = await acquireDaemonLock(lockPath, { heartbeatMs: 200, staleMs: 60_000 });
  await sleep(5); // startedAt 是毫秒精度，隔开保证 A/B 身份可区分
  const dead = new Date(Date.now() - 10 * 60_000);
  await utimes(lockPath, dead, dead);
  const b = await acquireDaemonLock(lockPath, { heartbeatMs: 60_000, staleMs: 90_000 });
  try {
    assert.notEqual(a.identity.startedAt, b.identity.startedAt);
    await sleep(250); // A 的旧心跳至少触发一次
    const content = JSON.parse(await readFile(lockPath, "utf8")) as { startedAt: string };
    assert.equal(content.startedAt, b.identity.startedAt, "A must not overwrite B's lock");
    await a.release();
    // A 释放时锁已不是它的身份，不得误删 B 的锁
    assert.equal(await stat(lockPath).then(() => true, () => false), true, "A must not delete B's lock");
  } finally {
    await b.release();
  }
  await assert.rejects(stat(lockPath), /ENOENT/);
});
