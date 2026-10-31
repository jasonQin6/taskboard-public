/**
 * 防休眠电源保护（纯保护器层）：
 *  - platformGuardCommand 平台命令装配（纯函数）；
 *  - createPlatformPowerGuard 以注入 spawnFn/平台验证 acquire/release/status 语义（不依赖真实平台工具跑 CI）。
 * daemon 装配与 state 透出见 test/daemon.test.ts。macOS 真机 caffeinate 实测不入 CI。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPlatformPowerGuard,
  platformGuardCommand,
  type GuardChild,
  type SpawnFn,
} from "../src/power-guard.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 4_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return predicate();
};

// ---- 手工可控的假 spawn：child 的退出时机由测试显式驱动 ----

interface ManualChild extends GuardChild {
  exitNow: (code: number | null, signal?: string | null) => void;
  kills: Array<NodeJS.Signals | undefined>;
}

interface ManualHarness {
  spawnFn: SpawnFn;
  calls: Array<{ command: string; args: string[]; cwd: string }>;
  children: ManualChild[];
}

export const makeManualSpawn = (script: { exitImmediately?: { code: number | null } } = {}): ManualHarness => {
  const calls: ManualHarness["calls"] = [];
  const children: ManualChild[] = [];
  const spawnFn: SpawnFn = (command, args, cwd) => {
    calls.push({ command, args: [...args], cwd });
    let settle!: (value: { code: number | null; signal: string | null }) => void;
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      settle = resolve;
    });
    const kills: Array<NodeJS.Signals | undefined> = [];
    const child: ManualChild = {
      exit,
      kills,
      kill: (signal) => {
        kills.push(signal);
        settle({ code: null, signal: signal ?? null });
      },
      exitNow: (code, signal = null) => settle({ code, signal }),
    };
    children.push(child);
    if (script.exitImmediately !== undefined) {
      // 模拟「工具缺失/秒退」：defaultSpawnFn 对 spawn 失败以 code=-1 收口，行为同类。
      queueMicrotask(() => child.exitNow(script.exitImmediately!.code));
    }
    return child;
  };
  return { spawnFn, calls, children };
};

// ---- platformGuardCommand：平台 → 命令装配 ----

test("platformGuardCommand: darwin binds caffeinate -i to the daemon pid via -w", () => {
  const spec = platformGuardCommand("darwin", 4242)!;
  assert.equal(spec.command, "caffeinate");
  assert.deepEqual(spec.args, ["-i", "-w", "4242"]);
});

test("platformGuardCommand: windows uses SetThreadExecutionState ES_SYSTEM_REQUIRED (screen off allowed)", () => {
  const spec = platformGuardCommand("win32", 1)!;
  assert.equal(spec.command, "powershell");
  const script = spec.args.join(" ");
  assert.match(script, /SetThreadExecutionState/);
  // ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x1) = 2147483649；不带 ES_DISPLAY_REQUIRED。
  assert.match(script, /2147483649/);
  assert.doesNotMatch(script, /2147483649[1-9]/);
});

test("platformGuardCommand: linux wraps systemd-inhibit --what=sleep", () => {
  const spec = platformGuardCommand("linux", 1)!;
  assert.equal(spec.command, "systemd-inhibit");
  assert.ok(spec.args.includes("--what=sleep"));
});

test("platformGuardCommand: unknown platform yields null (unsupported)", () => {
  assert.equal(platformGuardCommand("freebsd", 1), null);
  assert.equal(platformGuardCommand("sunos", 1), null);
});

// ---- createPlatformPowerGuard：注入 spawn 的语义验证 ----

test("power guard (darwin): acquire spawns caffeinate and holds; release kills and returns to idle", async () => {
  const fake = makeManualSpawn();
  const guard = createPlatformPowerGuard({
    platform: "darwin",
    spawnFn: fake.spawnFn,
    daemonPid: 4242,
    settleMs: 5,
  });
  assert.equal(guard.status(), "idle"); // 已开启、待命
  await guard.acquire();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.command, "caffeinate");
  assert.deepEqual(fake.calls[0]!.args, ["-i", "-w", "4242"]);
  assert.equal(guard.status(), "active");

  await guard.release();
  assert.equal(fake.children[0]!.kills.length, 1);
  assert.equal(fake.children[0]!.kills[0], "SIGTERM");
  const exit = await fake.children[0]!.exit;
  assert.equal(exit.signal, "SIGTERM");
  assert.equal(guard.status(), "idle"); // 平台可用 → 释放后回待命
});

test("power guard: acquire is idempotent (one child per window)", async () => {
  const fake = makeManualSpawn();
  const guard = createPlatformPowerGuard({ platform: "darwin", spawnFn: fake.spawnFn, settleMs: 5 });
  await guard.acquire();
  await guard.acquire();
  assert.equal(fake.calls.length, 1);
  await guard.release();
  assert.equal(guard.status(), "idle");
});

test("power guard: release without acquire is a no-op", async () => {
  const fake = makeManualSpawn();
  const guard = createPlatformPowerGuard({ platform: "darwin", spawnFn: fake.spawnFn, settleMs: 5 });
  await guard.release();
  assert.equal(fake.calls.length, 0);
  assert.equal(guard.status(), "idle");
});

test("power guard: unsupported platform degrades silently to unavailable and never spawns", async () => {
  const fake = makeManualSpawn();
  const guard = createPlatformPowerGuard({ platform: "freebsd", spawnFn: fake.spawnFn, settleMs: 5 });
  assert.equal(guard.status(), "unavailable");
  await guard.acquire();
  await guard.release();
  assert.equal(fake.calls.length, 0);
  assert.equal(guard.status(), "unavailable");
});

test("power guard: tool missing (immediate exit) degrades to unavailable without throwing", async () => {
  const fake = makeManualSpawn({ exitImmediately: { code: -1 } });
  const guard = createPlatformPowerGuard({ platform: "linux", spawnFn: fake.spawnFn, settleMs: 20 });
  await guard.acquire(); // 绝不抛错
  assert.equal(guard.status(), "unavailable");
  await guard.release(); // 未持有 → no-op，不再 kill
  assert.equal(fake.children[0]!.kills.length, 0);
  assert.equal(guard.status(), "unavailable"); // 降级态持续暴露
});

test("power guard: release during in-flight acquire leaves no residue child", async () => {
  const fake = makeManualSpawn();
  const guard = createPlatformPowerGuard({ platform: "darwin", spawnFn: fake.spawnFn, settleMs: 15 });
  const acquiring = guard.acquire();
  const releasing = guard.release(); // acquire 未完成时窗口已关（run 秒终态的竞态）
  await Promise.all([acquiring, releasing]);
  assert.equal(fake.calls.length, 1, "exactly one child spawned");
  const exit = await fake.children[0]!.exit;
  assert.equal(exit.signal, "SIGTERM", "child killed by the serialized release");
  assert.equal(guard.status(), "idle");
});

test("power guard: unexpected child death while holding degrades to unavailable", async () => {
  const fake = makeManualSpawn();
  const guard = createPlatformPowerGuard({ platform: "darwin", spawnFn: fake.spawnFn, settleMs: 5 });
  await guard.acquire();
  assert.equal(guard.status(), "active");
  fake.children[0]!.exitNow(1); // 保护进程崩溃
  assert.ok(
    await until(() => guard.status() === "unavailable"),
    "crash while holding must surface as unavailable",
  );
  await guard.release(); // 已不持有 → no-op
  assert.equal(fake.children[0]!.kills.length, 0);
});
