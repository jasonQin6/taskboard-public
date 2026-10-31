/** 活跃 run 期间持有平台防休眠；平台不可用静默降级。持有态是进程内运行时态，不入库。macOS -w 绑定 daemon pid，SIGKILL 也不会残留。 */

import { spawn, type ChildProcess } from "node:child_process";

export interface GuardChild {
  exit: Promise<{ code: number | null; signal: string | null }>;
  kill: (signal?: NodeJS.Signals) => void;
}

export type SpawnFn = (command: string, args: readonly string[], cwd: string) => GuardChild;

export const defaultSpawnFn: SpawnFn = (command, args, cwd) => {
  const child: ChildProcess = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return {
    kill: (signal) => {
      child.kill(signal);
    },
    exit: new Promise((resolve) => {
      // spawn 失败（ENOENT 等）走 error 事件而非 exit：按 code=-1 收口，acquire 观察窗判为不可用。
      child.once("error", () => resolve({ code: -1, signal: null }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
  };
};

export type PowerProtectionStatus =
  | "off" // preventIdleSleep 未开启（默认）
  | "idle" // 已开启、保护器待命（当前无活跃执行；平台此前可用或尚未尝试）
  | "active" // 已开启且当前正持有平台级防休眠
  | "unavailable"; // 已开启但本平台无法持有（不支持的平台/工具缺失/启动失败/持有中崩溃）

export interface PowerGuard {
  /** 进入保护窗口。幂等；绝不抛错——平台不可用时静默降级为 unavailable，不阻塞执行。 */
  acquire: () => Promise<void>;
  /** 退出保护窗口。幂等；未持有时 no-op；绝不抛错。 */
  release: () => Promise<void>;
  status: () => PowerProtectionStatus;
}

export interface PlatformGuardCommand {
  command: string;
  args: string[];
}

/** null = 本平台不支持（构造即 unavailable）。 */
export const platformGuardCommand = (
  platform: string,
  daemonPid: number,
): PlatformGuardCommand | null => {
  switch (platform) {
    case "darwin":
      // -i 防系统空闲睡眠；-w <pid> 把子进程寿命绑到 daemon 进程（SIGKILL 也不残留防休眠）。
      return { command: "caffeinate", args: ["-i", "-w", String(daemonPid)] };
    case "win32":
      // ES_* 只对调用线程生效，所以用常驻 PowerShell 进程持有并在循环里保活；释放时 kill。
      // （best-effort：本仓无 Windows 真机验证，静默降级覆盖其失败路径。）
      return {
        command: "powershell",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          [
            "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
            "$t = Add-Type -MemberDefinition $sig -Name TaskboardSes -Namespace Kernel32 -PassThru",
            "$null = $t::SetThreadExecutionState([uint32]'2147483649')",
            "while ($true) { Start-Sleep -Seconds 3600 }",
          ].join("; "),
        ],
      };
    case "linux":
      // systemd-inhibit 需要托管一个子命令，抑制锁在子命令存活期间有效；长驻子命令用
      // 在 acquire 观察窗判为不可用，静默降级。
      return { command: "systemd-inhibit", args: ["--what=sleep", "sleep", "infinity"] };
    default:
      return null;
  }
};

export interface PlatformPowerGuardOptions {
  platform?: string;
  spawnFn?: SpawnFn;
  /** 绑定的宿主进程 pid（macOS -w 参数；缺省 process.pid）。 */
  daemonPid?: number;
  /** acquire 判定「子进程是否稳定存活」的观察窗 ms（缺省 500；工具缺失/秒退在此判为不可用）。 */
  settleMs?: number;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const createPlatformPowerGuard = (options: PlatformPowerGuardOptions = {}): PowerGuard => {
  const platform = options.platform ?? process.platform;
  const spawnFn = options.spawnFn ?? defaultSpawnFn;
  const daemonPid = options.daemonPid ?? process.pid;
  const settleMs = options.settleMs ?? 500;
  // spec 为 null = 不支持的平台：acquire/release 直接 no-op，status 恒 unavailable。
  const spec = platformGuardCommand(platform, daemonPid);

  /** 平台最近一次尝试的结论：null = 尚未尝试。决定释放后回 idle 还是停在 unavailable。 */
  let platformUsable: boolean | null = spec !== null;
  let holding = false;
  let child: GuardChild | undefined;

  const status = (): PowerProtectionStatus => {
    if (spec === null) return "unavailable";
    if (holding) return "active";
    return platformUsable === false ? "unavailable" : "idle";
  };

  // acquire/release 的串行化队列：保证底层 spawn/kill 严格按调用顺序生效
  // （op 内部吞掉一切异常——保护器的失败语义是降级不是抛错，队列绝不断链）。
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const next = tail.then(op, op);
    tail = next.catch(() => undefined);
    return next;
  };

  /** 持有期间保护进程意外退出（崩溃）：如实降级为 unavailable，不假装仍在保护。 */
  const watchUnexpectedExit = (proc: GuardChild): void => {
    void proc.exit.then(() => {
      if (child === proc && holding) {
        holding = false;
        child = undefined;
        platformUsable = false;
      }
    });
  };

  const acquire = (): Promise<void> =>
    enqueue(async () => {
      if (spec === null || holding) return;
      const proc = spawnFn(spec.command, spec.args, process.cwd());
      child = proc;
      // 观察窗：命令不存在/秒退（ENOENT、systemd 未运行等）→ 静默降级，绝不抛错。
      const outcome = await Promise.race([
        proc.exit.then((exitValue) => ({ kind: "exit" as const, exitValue })),
        delay(settleMs).then(() => ({ kind: "alive" as const })),
      ]);
      if (outcome.kind === "exit") {
        child = undefined;
        platformUsable = false;
        return;
      }
      holding = true;
      platformUsable = true;
      watchUnexpectedExit(proc);
    });

  const release = (): Promise<void> =>
    enqueue(async () => {
      const proc = child;
      child = undefined;
      if (!holding) return; // 未持有（含 acquire 失败后）→ no-op
      holding = false;
      if (proc === undefined) return;
      proc.kill("SIGTERM");
      const graceful = await Promise.race([
        proc.exit.then(() => true),
        delay(1_000).then(() => false),
      ]);
      if (!graceful) {
        // 1s 内不退就补 SIGKILL——释放路径必须确实收掉防休眠进程，不能赌它听话。
        proc.kill("SIGKILL");
        await Promise.race([proc.exit, delay(1_000)]);
      }
    });

  return { acquire, release, status };
};
