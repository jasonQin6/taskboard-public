/**
 * daemon 装配：锁 → 数据库（损坏即拒启）→ 设置覆盖 → 重启对账 → HTTP（恒绑 127.0.0.1）→ cron ticker。
 * 关闭顺序见 ADR-0014：先停 HTTP（停收新连接并排空在飞处理器）→ 收服务 → db 关闭 → 最后放锁
 * （锁必须仍最后释放，db 必须在一切写者停止后才关），才允许下一个 daemon 接管同一数据库。
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AutomationScheduler } from "./automation.js";
import { CronTicker, type FireOutcome } from "./cron-ticker.js";
import { acquireDaemonLock, daemonLockPathFor } from "./daemon-lock.js";
import { CodexDriver, type DriverOptions } from "./driver/codex-driver.js";
import { openStateDb } from "./db.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { GoalService } from "./goals.js";
import { CodexAdapter } from "./harness/codex/adapter.js";
import { HarnessRegistry } from "./harness/registry.js";
import { JevService } from "./jev.js";
import { SummaryService } from "./summary.js";
import { MagpieProvider } from "./systemone/magpie.js";
import { SystemOneService } from "./systemone/service.js";
import { assembleProxyGuard } from "./http-guard.js";
import { createHttpServer } from "./http.js";
import { PowerController } from "./power-controller.js";
import { createPlatformPowerGuard, type PowerGuard } from "./power-guard.js";
import { RunManager } from "./runs.js";
import { SingleFlightRegistry } from "./single-flight.js";
import { Store } from "./store/index.js";
import type { Settings, Task } from "./types.js";
import type { ViewContext } from "./views.js";
import { WorktreeManager } from "./worktree.js";

export const DEFAULT_PORT = 47830;
export const DEFAULT_DB_FILENAME = "taskboard.sqlite";
export const DEFAULT_CODEX_COMMAND = "codex";
export const DEFAULT_SCAN_INTERVAL_MS = 30_000;

/** 构建产物目录随包走（<repo>/web/dist）；无产物时看板路由返回构建提示，不影响 API。 */
export const defaultWebDir = (): string => fileURLToPath(new URL("../web/dist", import.meta.url));

export interface DaemonConfig {
  port: number;
  dbPath: string;
  /**
   * Codex 家目录（rollout 扫描根：$CODEX_HOME/sessions 与 archived_sessions）；
   * 缺省环境变量 CODEX_HOME 或 ~/.codex，显式 null 关闭 reader（仅测试用）。
   */
  codexHome?: string | null;
  /** 增量扫描周期；测试注入，缺省 30 秒（需求「增量与恢复」）。 */
  scanIntervalMs?: number;
  /** 启动时持久化到 settings 的覆盖项（CLI 旗标 → settings 表；缺省沿用已存值）。 */
  settingsOverrides?: Partial<Settings>;
  /** CSRF 允许的额外主机名（反代场景）。 */
  allowedHosts?: string[];
  /** 代理令牌值（仅测试注入；生产走 settings.proxyTokenEnv 指向的环境变量）。 */
  proxyToken?: string;
  /** 前端构建产物目录；缺省取 TASKBOARD_WEB_DIR，再缺省 <repo>/web/dist。 */
  webDir?: string;
  lockHeartbeatMs?: number;
  lockStaleMs?: number;
  cronTickMs?: number;
  /** 自动化评估调度器的 tick 间隔；测试注入，缺省 30 秒（调度语义用注入时钟，见 automation.ts）。 */
  automationTickMs?: number;
  /** 覆盖 cron 到点行为（测试注入）；缺省接 RunManager 真实创建路径。 */
  onCronFire?: (task: Task) => Promise<FireOutcome> | FireOutcome;
  /**
   * Codex app-server 子进程命令。缺省 `codex app-server`（懒启动：首个 Run 起跑才 spawn）；
   * 单测注入假 app-server（test/fake-app-server.mjs），真机冒烟见 test/driver.smoke.test.ts。
   */
  driver?: DriverOptions;
  powerGuard?: PowerGuard;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export const defaultDbPath = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(env.TASKBOARD_DB_PATH ?? join(homedir(), ".taskboard", DEFAULT_DB_FILENAME));

/** 环境变量空串视为未设置：`resolve("")` 会落到 process.cwd()，静默扫错根/服务错目录且无报错。 */
const nonEmptyEnv = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim() !== "" ? value : undefined;

export const resolveDaemonConfig = (
  input: Partial<DaemonConfig> = {},
): DaemonConfig => {
  const env = input.env ?? process.env;
  const envPort = env.TASKBOARD_PORT !== undefined ? Number(env.TASKBOARD_PORT) : undefined;
  const allowedFromEnv =
    env.TASKBOARD_ALLOWED_HOSTS !== undefined && env.TASKBOARD_ALLOWED_HOSTS.trim() !== ""
      ? env.TASKBOARD_ALLOWED_HOSTS.split(",").map((entry) => entry.trim().toLowerCase())
      : [];
  return {
    ...input,
    port: input.port ?? (envPort !== undefined && Number.isInteger(envPort) ? envPort : DEFAULT_PORT),
    dbPath: resolve(input.dbPath ?? defaultDbPath(env)),
    codexHome:
      input.codexHome === null
        ? null
        : resolve(nonEmptyEnv(input.codexHome) ?? nonEmptyEnv(env.CODEX_HOME) ?? join(homedir(), ".codex")),
    allowedHosts: input.allowedHosts ?? allowedFromEnv,
    webDir: resolve(nonEmptyEnv(input.webDir) ?? nonEmptyEnv(env.TASKBOARD_WEB_DIR) ?? defaultWebDir()),
    env,
  };
};

export interface RunningDaemon {
  port: number;
  dbPath: string;
  pid: number;
  /** daemon 自有的唯一写入面；driver/测试经此改状态，不另开写路径。 */
  store: Store;
  /** 跨 Harness 观察 registry：daemon 唯一的摄取面（启停/扫描/进度/投影都经此，不直摸 reader）。 */
  harnesses: HarnessRegistry;
  /** 长驻 driver 引用（测试对假 app-server 做内省用；clientRef() 可能为 null = 尚未 spawn）。 */
  driver: CodexDriver;
  /** Run 生命周期驱动（测试经公共缝直接驱动 close/级联收口，ADR-0012）。 */
  runs: RunManager;
  /** Jev 决策与提案执行面（#15/S2）。 */
  jev: JevService;
  /** SystemOne 语义进度判定面（#45；带外只读，不产生 Run/Task/Proposal 变更）。 */
  systemone: SystemOneService;
  close: () => Promise<void>;
}

const DEFAULT_SECRET_ENV_KEYS = ["TASKBOARD_SYSTEMONE_TOKEN", "MAGPIE_CALLER_KEY"] as const;

const resolveSecretEnvKeys = (keys: DriverOptions["secretEnvKeys"]): readonly string[] =>
  typeof keys === "function" ? keys() : (keys ?? []);

const resolveDriverOptions = (
  config: DaemonConfig,
  extraSecretEnvKeys: DriverOptions["secretEnvKeys"] = [],
): DriverOptions => {
  const secretEnvKeys = (): readonly string[] => [
    ...new Set([...DEFAULT_SECRET_ENV_KEYS, ...resolveSecretEnvKeys(extraSecretEnvKeys)]),
  ];
  if (config.driver !== undefined) {
    return {
      ...config.driver,
      secretEnvKeys: () => [
        ...new Set([...resolveSecretEnvKeys(config.driver?.secretEnvKeys), ...secretEnvKeys()]),
      ],
    };
  }
  const env = config.env ?? process.env;
  const fromEnv = env.TASKBOARD_CODEX_COMMAND?.trim();
  return {
    command: fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_CODEX_COMMAND,
    args: ["app-server"],
    secretEnvKeys,
  };
};

const log = (event: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

export const startDaemon = async (config: DaemonConfig): Promise<RunningDaemon> => {
  await mkdir(dirname(config.dbPath), { recursive: true });
  // 锁先于打开数据库：第二个 daemon 在触碰数据库（哪怕只是初始化）之前就该失败关闭
  const lock = await acquireDaemonLock(daemonLockPathFor(config.dbPath), {
    ...(config.lockHeartbeatMs !== undefined ? { heartbeatMs: config.lockHeartbeatMs } : {}),
    ...(config.lockStaleMs !== undefined ? { staleMs: config.lockStaleMs } : {}),
  });
  try {
    return await assemble(config, lock.release);
  } catch (error) {
    // 装配中途失败（损坏库、端口占用、栅栏配置错）也要放锁，否则要等心跳过期才能重启
    await lock.release().catch(() => undefined);
    throw error;
  }
};

const assemble = async (config: DaemonConfig, releaseLock: () => Promise<void>): Promise<RunningDaemon> => {
  const startedAt = new Date().toISOString();
  const { db, created } = await openStateDb(config.dbPath);
  const store = new Store(db, config.now !== undefined ? { now: config.now } : {});
  try {
    if (config.settingsOverrides !== undefined && Object.keys(config.settingsOverrides).length > 0) {
      store.updateSettings(config.settingsOverrides);
    }
    const settings = store.getSettings();
    // provider/service 都读活设置：settings.update 后无需重启 daemon；令牌只在调用时从 env 解析
    const systemoneProvider = new MagpieProvider({
      env: config.env ?? process.env,
      settings: () => store.getSettings(),
    });
    const systemone = new SystemOneService({
      store,
      provider: systemoneProvider,
      settings: () => store.getSettings(),
      ...(config.now !== undefined ? { now: config.now } : {}),
    });
    // 栅栏装配先于对账：配置错误（非法条目/令牌变量缺失）不带病运行
    const proxyGuard = assembleProxyGuard({
      trustedProxyHosts: settings.trustedProxyHosts,
      ...(settings.proxyTokenEnv !== null ? { proxyTokenEnv: settings.proxyTokenEnv } : {}),
      ...(config.proxyToken !== undefined ? { proxyToken: config.proxyToken } : {}),
      env: config.env ?? process.env,
    });
    const reconciled = store.reconcileOnStartup();
    if (
      reconciled.orphanedRuns.length > 0 ||
      reconciled.cancelledRuns.length > 0 ||
      reconciled.failedActions.length > 0
    ) {
      log({ event: "reconcile", ...reconciled });
    }
    const singleFlight = new SingleFlightRegistry();
    singleFlight.clear();
    const power = new PowerController({
      store,
      createGuard: () => createPlatformPowerGuard(),
      ...(config.powerGuard !== undefined ? { guard: config.powerGuard } : {}),
    });
    power.start();
    const driverOptions = resolveDriverOptions(config, () => {
      const tokenEnv = store.getSettings().systemoneTokenEnv;
      return tokenEnv === null ? [] : [tokenEnv];
    });
    const driver = new CodexDriver(driverOptions);
    // isolated worktree 母目录跟数据库走（<dbDir>/worktrees）：临时库的 worktree 也落在临时目录
    const worktrees = new WorktreeManager({ store, root: join(dirname(config.dbPath), "worktrees") });
    const runs = new RunManager({ store, driver, singleFlight, worktrees });
    // goal/sample 执行面：与 RunManager 共享 driver 与单飞登记；防休眠续跑窗口经 power 接线
    const goals = new GoalService({ store, driver, singleFlight, power });
    // 摘要评估数据面：复用 GoalService 的 sample 写路径与单飞；自身无在飞资源，关闭顺序随 goals 收敛
    const summaries = new SummaryService({ store, goals });
    // Jev 决策面：同 driver 同单飞；评估经一次性 ephemeral 调用，输出只进提案（ADR-0010）
    const jev = new JevService({ store, driver, singleFlight });
    // 摄取在 HTTP 就绪之后才 start：daemon 可用不等待扫描完成（需求「单实例锁与重启恢复」）
    const codexHome =
      config.codexHome !== undefined
        ? config.codexHome
        : (nonEmptyEnv((config.env ?? process.env).CODEX_HOME) ?? join(homedir(), ".codex"));
    const codex =
      codexHome === null ? null : new CodexAdapter(store, {
        codexHome,
        ...(config.scanIntervalMs !== undefined ? { scanIntervalMs: config.scanIntervalMs } : {}),
        ...(config.now !== undefined ? { now: config.now } : {}),
        // A20 触发面：interrupted turn 落库即对已绑定线程自动评估一次（未绑定/去重/断路由 JevService 收口）
        onInterruptedTurns: (threadIds) => {
          for (const threadId of threadIds) {
            void jev.evaluateThread(threadId, { trigger: "interrupted" }).catch((error: unknown) => {
              // 领域跳过（未绑定/pause/断路器，以领域异常表达）预期内可静默；
              // 其余 store/driver 异常必须留痕，否则自动评估永久不可见地失败
              if (
                error instanceof ConflictError ||
                error instanceof NotFoundError ||
                error instanceof ValidationError
              ) {
                return;
              }
              log({
                event: "interrupted_evaluation_failed",
                threadId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        },
      });
    const harnesses = new HarnessRegistry(codex === null ? [] : [codex]);
    const views: ViewContext = {
      store,
      singleFlight,
      harnesses,
      systemone,
      runtime: () => ({
        pid: process.pid,
        startedAt,
        powerProtection: power.status(),
        proxyGuard: proxyGuard !== undefined,
        driver: driver.describe(),
      }),
      sessionCache: { threadsRevision: 0, sessions: [], failures: [] },
      ...(harnesses.size() === 0
        ? {}
        : {
            scan: () => harnesses.scanProgress(),
            scanNow: () => harnesses.scanNow(),
          }),
    };
    const http = createHttpServer({
      store,
      views,
      dbPath: config.dbPath,
      runs,
      goals,
      summaries,
      jev,
      worktrees,
      systemone,
      ...(proxyGuard !== undefined ? { proxyGuard } : {}),
      allowedHosts: config.allowedHosts ?? [],
      ...(config.webDir !== undefined ? { webDir: config.webDir } : {}),
      onLog: log,
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      http.server.once("error", rejectListen);
      http.server.listen(config.port, "127.0.0.1", () => resolveListen());
    });
    const address = http.server.address();
    const port = typeof address === "object" && address !== null ? address.port : config.port;
    harnesses.start();
    const ticker = new CronTicker({
      store,
      // cron 与手动/cascade 走同一条 Run 创建路径；config.onCronFire 仅测试注入覆盖
      onFire: config.onCronFire ?? ((task: Task) => runs.cronFire(task)),
      ...(config.now !== undefined ? { now: config.now } : {}),
      ...(config.cronTickMs !== undefined ? { intervalMs: config.cronTickMs } : {}),
    });
    ticker.start();
    // 自动化评估调度器：与 cron 同为 ticker，但受全局 pause 约束（cron 是用户显式调度，不受 pause 影响）
    const scheduler = new AutomationScheduler({
      store,
      onEvaluate: ({ threadId }) => jev.evaluateThread(threadId, { trigger: "auto" }),
      ...(config.now !== undefined ? { now: config.now } : {}),
      ...(config.automationTickMs !== undefined ? { intervalMs: config.automationTickMs } : {}),
    });
    scheduler.start();
    log({
      event: "listening",
      port,
      db: config.dbPath,
      created,
      pid: process.pid,
      driver: { command: driverOptions.command },
      // 栅栏只记条目数与变量名，令牌值绝不入日志
      ...(proxyGuard !== undefined
        ? { proxyGuard: { trustedHosts: proxyGuard.trustedHosts.length, tokenEnv: settings.proxyTokenEnv } }
        : {}),
      powerProtection: power.status(),
      // 只记 provider/model/可用性，不记端点令牌
      systemone: {
        enabled: settings.systemoneEnabled,
        provider: systemoneProvider.id,
        model: systemoneProvider.resolveModel(),
        available: systemoneProvider.available(settings).ok,
      },
    });
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      // ADR-0014：先停 HTTP——停收新连接并排空在飞处理器（应答可送达，其 store/driver 调用
      // 发生在一切仍全开时），之后拆除期间不再有任何 handler 能触碰正在关闭的资源
      await http.shutdown();
      // HTTP 已排空，不会再有新判定；abort 在飞 provider 调用后再拆其余资源
      await systemone.close();
      ticker.stop();
      scheduler.stop();
      await harnesses.stop();
      // goal/sample 在飞动作先收敛（还要用 driver），Jev 评估随之收敛，再放 power（续跑窗口随关键区关闭）、再停 driver
      await goals.close();
      await jev.close();
      await power.stop();
      // 先停 driver（在飞 Run 随断连显式失败落账），RunManager 再收敛执行与级联
      await runs.close(async () => driver.close());
      db.close();
      // 锁最后释放：db 关闭完成后才允许下一个 daemon 接管（ADR-0002）
      await releaseLock();
    };
    return {
      port,
      dbPath: config.dbPath,
      pid: process.pid,
      store,
      harnesses,
      driver,
      runs,
      jev,
      systemone,
      close,
    };
  } catch (error) {
    db.close();
    throw error;
  }
};
