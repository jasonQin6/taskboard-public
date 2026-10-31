/** 看板视图装配：卡片级数据不内联完整证据（需求「API 与 CLI」）。纯读取，不写库。 */

import { CRON_SKIP_KIND } from "./cron-ticker.js";
import type { CapabilityManifest, Failure, SessionSnapshot } from "./harness/contract.js";
import type { HarnessRegistry } from "./harness/registry.js";
import { APPROVAL_STOP_KIND } from "./runs.js";
import type { SingleFlightRegistry } from "./single-flight.js";
import type { ProposalView, Store, ThreadSummaryView } from "./store/index.js";
import type { ProgressVerdictView, SystemOneRuntimeView } from "./systemone/contract.js";
import type { SystemOneService } from "./systemone/service.js";
import {
  NEEDS_ATTENTION_KIND,
  type Annotation,
  type AutomationGateMode,
  type PowerProtectionStatus,
  type RevisionDomain,
  type Run,
  type Task,
  type Thread,
  type WorktreeRecord,
} from "./types.js";

export type TaskBadge = "interrupted" | "external_activity" | "held" | typeof NEEDS_ATTENTION_KIND;

/** 任务卡上的 worktree 概要（U 契约：字段只增不删）。 */
export interface WorktreeView {
  seq: number;
  branch: string;
  path: string;
  baseBranch: string | null;
  status: "active" | "removed";
  createdAt: string;
  removedAt: string | null;
}

export const worktreeViewOf = (record: WorktreeRecord | null): WorktreeView | null =>
  record === null
    ? null
    : {
        seq: record.seq,
        branch: record.branch,
        path: record.path,
        baseBranch: record.baseBranch,
        status: record.removedAt === null ? "active" : "removed",
        createdAt: record.createdAt,
        removedAt: record.removedAt,
      };

export interface TaskCard extends Task {
  lastRun: Run | null;
  activeRun: Run | null;
  primaryThreadId: string | null;
  primaryThreadStatus: Thread["nativeStatus"] | null;
  /** 主绑定线程最近观测的 Codex goal 状态（证据缓存；null = 无绑定或无 goal）。 */
  goalStatus: string | null;
  threadCount: number;
  childrenCount: number;
  badges: TaskBadge[];
  lastCronSkip: { reason: string; at: string } | null;
  summaryStatus: "none" | "compacted" | "sample";
  /** isolated_worktree 模式的最近一条记录（含已清理）；从未创建过则 null。 */
  worktree: WorktreeView | null;
}

export interface TaskDetail extends TaskCard {
  runs: Run[];
  threads: Thread[];
  children: string[];
  annotations: Annotation[];
  inFlightWrite: boolean;
}

export interface RuntimeView {
  pid: number;
  startedAt: string;
  automationPaused: boolean;
  /** 自治上线门模式（门动作判定流转；settings.update 不在白名单）。 */
  automationLiveGate: AutomationGateMode;
  concurrencyLimit: number;
  activeRuns: number;
  inFlightWrites: number;
  powerProtection: PowerProtectionStatus;
  proxyGuard: boolean;
  /**
   * 扫描索引进度：phase=unavailable 表示本构建未接 reader（codexHome=null 的测试装配）；
   * running 期间 filesDone/filesTotal 是全量对账进度（需求「单实例锁与重启恢复」）。
   */
  scan: {
    phase: "unavailable" | "idle" | "running" | "done";
    sources: number;
    anomalies: number;
    filesTotal: number;
    filesDone: number;
    lastCompletedAt: string | null;
  };
  driver: { available: boolean; note: string };
  /** 各 Harness 能力清单：readPaths/degradations 的真实消费面；未装配 registry 时为空数组。 */
  manifests: CapabilityManifest[];
  /** SystemOne 运行时披露；未装配服务时为 null（不伪造 provider/budget 字段）。 */
  systemone: SystemOneRuntimeView | null;
}

export interface StateView {
  ok: true;
  revisions: Record<RevisionDomain, number>;
  tasks: TaskCard[];
  threads: Thread[];
  inbox: Thread[];
  /** Phase 1 跨 Harness 只读会话投影；不参与 Task/Run 状态机。 */
  sessions: SessionSnapshot[];
  /** adapter/source 的结构化降级；局部失败不阻塞其余 sessions。 */
  failures: Failure[];
  /** 每线程最近一条摘要（S1/S2 摘要面；空库为空数组）。 */
  summaries: ThreadSummaryView[];
  /** SystemOne 语义进度视图（只读投影；未装配服务时为空数组）。 */
  progressVerdicts: ProgressVerdictView[];
  /** 待裁决优先的最近提案（S2 提案面；字段只增不删）。 */
  proposals: ProposalView[];
  annotations: Annotation[];
  runtime: RuntimeView;
}

export interface ViewContext {
  store: Store;
  singleFlight: SingleFlightRegistry;
  runtime: () => Omit<RuntimeView, "scan" | "concurrencyLimit" | "automationPaused" | "automationLiveGate" | "activeRuns" | "inFlightWrites" | "manifests" | "systemone">;
  /** 扫描进度（daemon 经 registry 聚合注入；缺失时 scan 恒为 unavailable）。 */
  scan?: () => {
    phase: "idle" | "running" | "done";
    filesTotal: number;
    filesDone: number;
    lastCompletedAt: string | null;
  };
  /** 手动立即扫描（scan.refresh 动作用；缺失时动作保持 501 占位）。 */
  scanNow?: () => Promise<unknown>;
  /** Phase 1 adapter registry；未装配时 sessions/failures 为空。 */
  harnesses?: HarnessRegistry;
  /** observe 结果按 threads revision 记忆化；daemon 单例持有，缺省每次直查。 */
  sessionCache?: { threadsRevision: number; sessions: SessionSnapshot[]; failures: Failure[] };
  /** SystemOne 判定面；未装配时 state 的 progressVerdicts 为空、runtime.systemone 为 null。 */
  systemone?: SystemOneService;
}

/**
 * 徽标只来自第一方事实：线程原生状态与两类「等待人」审计（审批停下 / 评估层 needs_attention）。
 * needs_attention（A16）= 最近一次等待人审计晚于最后一次 Run 起跑——
 * 人工再起跑即视为接手，徽标随之清除，不需要独立的清除状态。
 */
const badgesFor = (
  activeRun: Run | null,
  lastRun: Run | null,
  primary: Thread | null,
  waitingForUserAt: string | null,
): TaskBadge[] => {
  const badges: TaskBadge[] = [];
  if (primary !== null) {
    if (primary.nativeStatus === "interrupted") badges.push("interrupted");
    if (primary.nativeStatus === "held") badges.push("held");
    // cancelled 之后 thread 仍在跑只亮徽标，不把任务拉回 running（需求「Run 终态与看板列映射」）
    if (primary.nativeStatus === "running" && activeRun === null && lastRun?.status === "cancelled") {
      badges.push("external_activity");
    }
  }
  if (waitingForUserAt !== null) {
    const lastStart = activeRun?.startedAt ?? lastRun?.startedAt ?? null;
    if (lastStart === null || Date.parse(waitingForUserAt) > Date.parse(lastStart)) {
      badges.push(NEEDS_ATTENTION_KIND);
    }
  }
  return badges;
};

/**
 * 看板渲染的批量预取索引：轮询热路径（stateView 对每任务/每线程的查询）从 N+1 收敛为两条
 * 批量 SQL。批量方法与逐个查询的等价性由 store 层测试钉住（deepEqual 逐任务/逐线程对齐）。
 */
export interface TaskViewIndex {
  /** taskId → 最近注记（等价 listAnnotations({taskId, limit: 50})，无注记任务无条目）。 */
  annotationsByTask: Map<string, Annotation[]>;
  /** threadId → 最新摘要（等价 latestThreadSummary(threadId)，无摘要线程无条目）。 */
  summariesByThread: Map<string, ThreadSummaryView>;
}

export const buildTaskViewIndex = (store: ViewContext["store"]): TaskViewIndex => ({
  annotationsByTask: store.recentAnnotationsByTask(50),
  summariesByThread: store.latestThreadSummaries(),
});

export const taskCard = (ctx: ViewContext, task: Task, index?: TaskViewIndex): TaskCard => {
  const runs = ctx.store.listRuns(task.id, 1);
  const lastRun = runs[0] ?? null;
  const activeRun = ctx.store.activeRunOf(task.id);
  const primary = ctx.store.primaryThreadOf(task.id);
  const threads = ctx.store.threadsOf(task.id);
  const children = ctx.store.childIds(task.id);
  const annotations =
    index?.annotationsByTask.get(task.id) ?? ctx.store.listAnnotations({ taskId: task.id, limit: 50 });
  const lastSkip = annotations.find((note) => note.kind === CRON_SKIP_KIND);
  // 两类「等待人」审计取最新：审批停下（自驱 turn 需审批）或评估层 needs_attention
  const waitingForUser = annotations
    .filter((note) => note.kind === APPROVAL_STOP_KIND || note.kind === NEEDS_ATTENTION_KIND)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  // 摘要来源跟主绑定线程的最新一条摘要走（compacted 由 reader 落库，sample 由 GoalService 落库）
  const primarySummary =
    primary === null
      ? null
      : (index?.summariesByThread.get(primary.id) ?? ctx.store.latestThreadSummary(primary.id));
  return {
    ...task,
    lastRun,
    activeRun,
    primaryThreadId: primary?.id ?? null,
    primaryThreadStatus: primary?.nativeStatus ?? null,
    goalStatus: primary?.goalStatus ?? null,
    threadCount: threads.length,
    childrenCount: children.length,
    badges: badgesFor(activeRun, lastRun, primary, waitingForUser?.createdAt ?? null),
    lastCronSkip: lastSkip === undefined ? null : { reason: lastSkip.body, at: lastSkip.createdAt },
    summaryStatus: primarySummary?.provenance ?? "none",
    worktree: worktreeViewOf(ctx.store.latestWorktreeOf(task.id)),
  };
};

export const taskDetail = (ctx: ViewContext, task: Task): TaskDetail => {
  const card = taskCard(ctx, task);
  const threads = ctx.store.threadsOf(task.id);
  return {
    ...card,
    runs: ctx.store.listRuns(task.id, 20),
    threads,
    children: ctx.store.childIds(task.id),
    annotations: ctx.store.listAnnotations({ taskId: task.id, limit: 100 }),
    inFlightWrite: ctx.singleFlight.anyInFlight(threads.map((thread) => thread.id)),
  };
};

export const stateView = (ctx: ViewContext): StateView => {
  const settings = ctx.store.getSettings();
  const runtimeBase = ctx.runtime();
  const cursor = ctx.store.readerCursorSummary();
  const progress = ctx.scan?.() ?? null;
  // 轮询热路径：两条批量查询预取全部任务的注记与全部线程的最新摘要（此前是每任务/每线程一查的 N+1）
  const index = buildTaskViewIndex(ctx.store);
  const summariesByThread = index.summariesByThread;
  const revisions = ctx.store.revisions();
  // observe 读的是 reader 内存投影：error-only 扫描不落库，只能以 threads revision 为缓存键；
  // fileErrors 集合变化由 reader 主动 touch threads 驱动失效（见 scanner runPass），失败才对客户端可见
  const cache = ctx.sessionCache;
  let sessions: SessionSnapshot[];
  let failures: Failure[];
  if (cache !== undefined && cache.threadsRevision === revisions.threads) {
    sessions = cache.sessions;
    failures = cache.failures;
  } else {
    const observation = ctx.harnesses?.observe() ?? { sessions: [], failures: [] };
    sessions = [...observation.sessions];
    failures = [...observation.failures];
    if (cache !== undefined) {
      cache.threadsRevision = revisions.threads;
      cache.sessions = sessions;
      cache.failures = failures;
    }
  }
  return {
    ok: true,
    revisions,
    tasks: ctx.store.listTasks().map((task) => taskCard(ctx, task, index)),
    threads: ctx.store.listThreads(),
    inbox: ctx.store.listInbox(),
    sessions,
    failures,
    // 只读投影；SystemOne 写入只 touch threads，不会经这里反写任何执行面
    progressVerdicts: ctx.systemone?.views() ?? [],
    // 保持逐线程查询时代的顺序（listThreads 序），只是把每线程一查换成批量映射查找
    summaries: ctx.store
      .listThreads()
      .map((thread) => summariesByThread.get(thread.id) ?? null)
      .filter((summary): summary is ThreadSummaryView => summary !== null),
    proposals: ctx.store.listProposals({ limit: 100 }),
    annotations: ctx.store.listAnnotations({ limit: 200 }),
    runtime: {
      ...runtimeBase,
      automationPaused: settings.automationPaused,
      automationLiveGate: settings.automationLiveGate,
      concurrencyLimit: settings.concurrencyLimit,
      activeRuns: ctx.store.countActiveRuns(),
      inFlightWrites: ctx.singleFlight.count(),
      scan: {
        phase: progress === null ? "unavailable" : progress.phase,
        sources: cursor.sources,
        anomalies: cursor.anomalies,
        filesTotal: progress?.filesTotal ?? 0,
        filesDone: progress?.filesDone ?? 0,
        lastCompletedAt: progress?.lastCompletedAt ?? null,
      },
      manifests: ctx.harnesses?.capabilityManifests() ?? [],
      systemone: ctx.systemone?.runtime() ?? null,
    },
  };
};
