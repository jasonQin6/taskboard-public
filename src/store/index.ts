/**
 * Store：SQLite 之上的唯一写入面（组合门面；ADR-0016 #19 步④门面收口）。视图/CLI/调度器一律
 * 经此，不直写数据库（不变量「数据库单一写者」）。所有变更走 write()：一个事务 + 按域推进
 * revision + 提交后广播。本文件承接原 src/store.ts 的 import 路径——NodeNext 下 "./store.js"
 * 解析到 store/index.ts，消费面 import 零改动。域方法全部在各族 store：
 * 底盘（事务与域 revision/幂等键/newId）在 ./core.js 的 StoreCore；settings 域在
 * ./settings-store.js 的 SettingsStore（晨析 10-25 自 core 外挪）；任务族
 * （tasks/runs/cron 调度面/annotations/action executions/worktrees 记录）在 ./task-store.js 的
 * TaskStore；线程族（threads 读取面/thread 绑定/reader 扫描游标/reader 写面/线程评估状态）在
 * ./thread-store.js 的 ThreadStore；自治族（next_action_proposals/shadow 回放及节内留守方法）在
 * ./automation-store.js 的 AutomationStore——本类按原签名逐一转发，不做接口收窄。
 */

import type { DatabaseSync } from "node:sqlite";
import type { CreateTaskInput, UpdateTaskInput } from "../task-input.js";
import type {
  ActionExecution,
  Annotation,
  RevisionChange,
  RevisionDomain,
  Run,
  RunTrigger,
  Settings,
  ShadowLabel,
  Task,
  TaskStatus,
  Thread,
  ThreadBinding,
  ThreadBindingRole,
  ThreadLineageEdge,
  ThreadNativeStatus,
  WorktreeRecord,
} from "../types.js";
import { StoreCore, type Touch } from "./core.js";
import { SystemOneStore } from "./systemone-store.js";
import {
  AutomationStore,
  type ProposalView,
  type ShadowComparisonView,
} from "./automation-store.js";
import { SettingsStore } from "./settings-store.js";
import { TaskStore } from "./task-store.js";
import {
  RetroStore,
  type ComboRecordInput,
  type ComboRecordView,
  type RetroIdentity,
  type RetroRecordInput,
  type RetroRecordView,
  type SameTypeQuery,
} from "./retro-store.js";
import {
  ThreadStore,
  type EvidenceView,
  type ObservedSessionRecord,
  type ReaderSourceLocatorKind,
  type ReaderSourceView,
  type ReaderTurn,
  type SourceScanPatch,
  type ThreadEvaluationStateView,
  type ThreadSummaryView,
} from "./thread-store.js";

// 底盘符号的单一定义处在 ./core.js；settings 符号在 ./settings-store.js（晨析 10-25 外挪）。
// 此处按原路径 re-export，消费面 import 零改动。
export { newId, IDEMPOTENCY_RING } from "./core.js";
export { DEFAULT_SETTINGS, mergeSettings, validateSettingsPatch } from "./settings-store.js";
export type { Touch } from "./core.js";
// 线程族符号的单一定义处自步③起在 ./thread-store.js；此处按原路径 re-export，消费面 import 零改动。
export {
  EVALUATION_BREAKER_OPENED_ANNOTATION,
  EVALUATION_BREAKER_RESUMED_ANNOTATION,
  EVALUATION_BREAKER_THRESHOLD,
} from "./thread-store.js";
export type {
  EvidenceView,
  ObservedSessionRecord,
  ReaderSourceLocatorKind,
  ReaderSourceView,
  ReaderTurn,
  ReaderTurnStatus,
  SourceScanPatch,
  ThreadEvaluationStateView,
  ThreadSummaryView,
} from "./thread-store.js";
// 自治族符号的单一定义处自步④起在 ./automation-store.js；此处按原路径 re-export，消费面 import 零改动。
export type { ProposalView, ShadowComparisonView } from "./automation-store.js";
// retro 族符号的单一定义处在 ./retro-store.js（#65）。
export type {
  ComboRecordInput,
  ComboRecordView,
  RetroIdentity,
  RetroRecordInput,
  RetroRecordView,
  SameTypeQuery,
} from "./retro-store.js";
export { normalizeComboSkill } from "./retro-store.js";

export class Store {
  private readonly core: StoreCore;
  private readonly settings: SettingsStore;
  private readonly tasks: TaskStore;
  private readonly threads: ThreadStore;
  private readonly automation: AutomationStore;
  private readonly systemoneStore: SystemOneStore;
  private readonly retroStore: RetroStore;

  constructor(
    readonly db: DatabaseSync,
    options: { now?: () => number } = {},
  ) {
    this.core = new StoreCore(db, options);
    this.settings = new SettingsStore(this.core);
    this.tasks = new TaskStore(this.core, this.settings);
    this.threads = new ThreadStore(this.core, this.tasks);
    this.automation = new AutomationStore(this.core, this.settings, this.tasks, this.threads);
    this.systemoneStore = new SystemOneStore(this.core);
    this.retroStore = new RetroStore(this.core);
  }

  readonly now = (): number => this.core.now();

  // ---- 事务与域 revision（转发 StoreCore）----

  subscribe(listener: (changes: RevisionChange[]) => void): () => void {
    return this.core.subscribe(listener);
  }

  write<T>(fn: (touch: Touch) => T): T {
    return this.core.write(fn);
  }

  revisions(): Record<RevisionDomain, number> {
    return this.core.revisions();
  }

  // ---- settings（转发 SettingsStore）----

  getSettings(): Settings {
    return this.settings.getSettings();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    return this.settings.updateSettings(patch);
  }

  // ---- tasks（转发 TaskStore）----

  getTask(id: string): Task | null {
    return this.tasks.getTask(id);
  }

  requireTask(id: string): Task {
    return this.tasks.requireTask(id);
  }

  listTasks(options: { includeArchived?: boolean } = {}): Task[] {
    return this.tasks.listTasks(options);
  }

  childIds(taskId: string): string[] {
    return this.tasks.childIds(taskId);
  }

  createTask(input: CreateTaskInput): Task {
    return this.tasks.createTask(input);
  }

  updateTask(id: string, patch: UpdateTaskInput): Task {
    return this.tasks.updateTask(id, patch);
  }

  applyTaskboardThreadDefault(taskId: string): Task {
    return this.tasks.applyTaskboardThreadDefault(taskId);
  }

  moveTask(id: string, status: TaskStatus): Task {
    return this.tasks.moveTask(id, status);
  }

  archiveTask(id: string): Task {
    return this.tasks.archiveTask(id);
  }

  unarchiveTask(id: string): Task {
    return this.tasks.unarchiveTask(id);
  }

  deleteTask(id: string): { id: string; danglingChildren: string[]; unboundThreads: string[] } {
    return this.tasks.deleteTask(id);
  }

  // ---- runs（转发 TaskStore）----

  createRun(taskId: string, trigger: RunTrigger): Run {
    return this.tasks.createRun(taskId, trigger);
  }

  getRun(runId: string): Run | null {
    return this.tasks.getRun(runId);
  }

  listQueuedRuns(): Run[] {
    return this.tasks.listQueuedRuns();
  }

  flipRun(runId: string, status: "failed" | "cancelled", failureReason?: string): Run {
    return this.tasks.flipRun(runId, status, failureReason);
  }

  markRunRunning(runId: string, options: { threadId?: string } = {}): Run {
    return this.tasks.markRunRunning(runId, options);
  }

  finishRun(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    options: { failureReason?: string; threadId?: string } = {},
  ): Run {
    return this.tasks.finishRun(runId, status, options);
  }

  listRuns(taskId: string, limit = 20): Run[] {
    return this.tasks.listRuns(taskId, limit);
  }

  activeRunOf(taskId: string): Run | null {
    return this.tasks.activeRunOf(taskId);
  }

  countActiveRuns(): number {
    return this.tasks.countActiveRuns();
  }

  countRunningRuns(): number {
    return this.tasks.countRunningRuns();
  }

  // ---- cron 调度面（转发 TaskStore）----

  listDueCronTasks(nowMs: number): Task[] {
    return this.tasks.listDueCronTasks(nowMs);
  }

  advanceCron(taskId: string, fromMs: number): Task {
    return this.tasks.advanceCron(taskId, fromMs);
  }

  reconcileOnStartup(): {
    orphanedRuns: string[];
    cancelledRuns: string[];
    failedActions: string[];
    resetTaskIds: string[];
  } {
    return this.tasks.reconcileOnStartup();
  }

  // ---- annotations（转发 TaskStore）----

  addAnnotation(input: {
    taskId?: string | null;
    threadId?: string | null;
    kind: string;
    body: string;
  }): Annotation {
    return this.tasks.addAnnotation(input);
  }

  listAnnotations(options: { taskId?: string; threadId?: string; limit?: number } = {}): Annotation[] {
    return this.tasks.listAnnotations(options);
  }

  recentAnnotationsByTask(limit: number): Map<string, Annotation[]> {
    return this.tasks.recentAnnotationsByTask(limit);
  }

  // ---- action executions（转发 TaskStore）----

  beginActionExecution(input: {
    action: string;
    trigger: ActionExecution["trigger"];
    taskId?: string | null;
    threadId?: string | null;
    requestId?: string | null;
    detail?: Record<string, unknown> | null;
  }): ActionExecution {
    return this.tasks.beginActionExecution(input);
  }

  finishActionExecution(
    id: string,
    status: "completed" | "failed",
    detail?: Record<string, unknown>,
  ): void {
    this.tasks.finishActionExecution(id, status, detail);
  }

  listActionExecutions(options: { taskId?: string; threadId?: string; limit?: number } = {}): ActionExecution[] {
    return this.tasks.listActionExecutions(options);
  }

  // ---- isolated worktree 记录（转发 TaskStore）----

  activeWorktreeOf(taskId: string): WorktreeRecord | null {
    return this.tasks.activeWorktreeOf(taskId);
  }

  latestWorktreeOf(taskId: string): WorktreeRecord | null {
    return this.tasks.latestWorktreeOf(taskId);
  }

  countWorktrees(taskId: string): number {
    return this.tasks.countWorktrees(taskId);
  }

  insertWorktree(record: {
    taskId: string;
    seq: number;
    branch: string;
    path: string;
    baseBranch: string | null;
    sourceWorkspace: string;
  }): WorktreeRecord {
    return this.tasks.insertWorktree(record);
  }

  markWorktreeRemoved(taskId: string, seq: number): WorktreeRecord {
    return this.tasks.markWorktreeRemoved(taskId, seq);
  }

  // ---- threads（转发 ThreadStore）----

  upsertThread(input: {
    id: string;
    harnessId: string;
    nativeStatus?: ThreadNativeStatus;
    title?: string | null;
    lastActivityAt?: number | null;
    /** 记录最近观测的 goal 状态（证据缓存）。 */
    goalStatus?: string;
    /** 显式清除 goal 状态（goal clear / 服务端返回 null）。与 goalStatus 互斥使用。 */
    clearGoalStatus?: boolean;
  }): Thread {
    return this.threads.upsertThread(input);
  }

  getThread(id: string): Thread | null {
    return this.threads.getThread(id);
  }

  listThreads(): Thread[] {
    return this.threads.listThreads();
  }

  listInbox(options: { now?: number; windowDays?: number } = {}): Thread[] {
    return this.threads.listInbox(options);
  }

  setThreadIgnored(id: string, ignored: boolean): Thread {
    return this.threads.setThreadIgnored(id, ignored);
  }

  // ---- thread 绑定（转发 ThreadStore）----

  /**
   * 绑定 thread 到 task。primary 是自动化控制权：一个 thread 至多一个 primary Task，
   * 已被其他任务占用的 primary 席位拒绝（409）；derived_from/evidence_for 只作证据链，不限数量。
   * 同一 (task, thread, role) 重复绑定幂等返回既有绑定。
   */
  bindThread(
    taskId: string,
    threadId: string,
    options: { role?: ThreadBindingRole } = {},
  ): ThreadBinding {
    return this.threads.bindThread(taskId, threadId, options);
  }

  /** 解绑指定角色；绑定不存在（含 task 不存在）按 NotFound 报。返回解绑后的 thread。 */
  unbindThread(
    taskId: string,
    threadId: string,
    options: { role?: ThreadBindingRole } = {},
  ): Thread {
    return this.threads.unbindThread(taskId, threadId, options);
  }

  threadBindings(threadId: string): ThreadBinding[] {
    return this.threads.threadBindings(threadId);
  }

  threadLineage(threadId: string): { parents: ThreadLineageEdge[]; children: ThreadLineageEdge[] } {
    return this.threads.threadLineage(threadId);
  }

  latestThreadTurn(threadId: string): ReaderTurn | null {
    return this.threads.latestThreadTurn(threadId);
  }

  /** 最近一个「已完成」turn：sample 的 expected_turn_id 校验来源（reader 视角，非 app-server 视角）。 */
  latestCompletedTurn(threadId: string): ReaderTurn | null {
    return this.threads.latestCompletedTurn(threadId);
  }

  primaryThreadOf(taskId: string): Thread | null {
    return this.threads.primaryThreadOf(taskId);
  }

  threadsOf(taskId: string): Thread[] {
    return this.threads.threadsOf(taskId);
  }

  /** 任务维度的绑定角色（thread → 该任务下的 role）：任务详情契约 threads[].role 的数据面。 */
  bindingsOfTask(taskId: string): Array<{ threadId: string; role: ThreadBindingRole }> {
    return this.threads.bindingsOfTask(taskId);
  }

  // ---- reader 扫描游标（转发 ThreadStore）----

  readerCursorSummary(): { sources: number; anomalies: number } {
    return this.threads.readerCursorSummary();
  }

  listObservedSessions(harnessId: string): ObservedSessionRecord[] {
    return this.threads.listObservedSessions(harnessId);
  }

  threadIdentity(threadId: string): {
    harnessId: string;
    nativeSessionId: string | null;
    sourcePath: string | null;
    sourceByteStart: number | null;
    sourceRecordHash: string | null;
  } {
    return this.threads.threadIdentity(threadId);
  }

  threadWorkspace(threadId: string): string | null {
    return this.threads.threadWorkspace(threadId);
  }

  // ---- reader 写面（转发 ThreadStore）：rollout source/turn/证据/摘要/anomaly 的唯一入库通道 ----

  readerSourceByInode(inode: number): ReaderSourceView | null {
    return this.threads.readerSourceByInode(inode);
  }

  listReaderSources(): ReaderSourceView[] {
    return this.threads.listReaderSources();
  }

  latestReaderSource(threadId: string): ReaderSourceView | null {
    return this.threads.latestReaderSource(threadId);
  }

  latestReaderSourceByThread(): Map<string, ReaderSourceView> {
    return this.threads.latestReaderSourceByThread();
  }

  /** 文件移动只改 path 属性（source_id 不变，幂等键不失效）；不推域 revision，游标不是看板状态。 */
  patchReaderSourcePath(sourceId: string, path: string): void {
    this.threads.patchReaderSourcePath(sourceId, path);
  }

  /**
   * 一次 source unit 扫描结果的原子提交：游标 + thread + turns + 证据 + anomaly + 摘要 + lineage。
   * 重写路径在事务内先 supersede 旧证据（不删行）、删除被重写 source 的旧行 turn 再重建——
   * 单事务保证崩溃后重跑收敛到相同结果（需求「增量与恢复」）。
   */
  commitSourceScan(patch: SourceScanPatch): void {
    this.threads.commitSourceScan(patch);
  }

  listThreadTurns(threadId: string): ReaderTurn[] {
    return this.threads.listThreadTurns(threadId);
  }

  listTurnsPage(
    threadId: string,
    options: { limit?: number; offset?: number } = {},
  ): { items: ReaderTurn[]; total: number } {
    return this.threads.listTurnsPage(threadId, options);
  }

  listEvidencePage(
    threadId: string,
    options: { limit?: number; offset?: number; includeSuperseded?: boolean } = {},
  ): { items: EvidenceView[]; total: number } {
    return this.threads.listEvidencePage(threadId, options);
  }

  latestThreadSummary(threadId: string): ThreadSummaryView | null {
    return this.threads.latestThreadSummary(threadId);
  }

  /** 每线程最新一条摘要，一次窗口查询（等价于对每线程 latestThreadSummary；无摘要线程不产生条目）。 */
  latestThreadSummaries(): Map<string, ThreadSummaryView> {
    return this.threads.latestThreadSummaries();
  }

  listThreadSummaries(threadId: string): ThreadSummaryView[] {
    return this.threads.listThreadSummaries(threadId);
  }

  /** sample 摘要入库通道（compacted 走 reader 的 commitSourceScan）。文本必须先过脱敏+截断。 */
  addThreadSummary(input: {
    threadId: string;
    provenance: ThreadSummaryView["provenance"];
    text: string;
    sourceRef?: string | null;
    byteStart?: number | null;
    recordHash?: string | null;
    coveredThroughTurnOrdinal?: number | null;
  }): ThreadSummaryView {
    return this.threads.addThreadSummary(input);
  }

  // ---- 线程评估状态（转发 ThreadStore；no-op 指纹 / 断路器；词汇表「评估状态」） ----

  getEvaluationState(threadId: string): ThreadEvaluationStateView | null {
    return this.threads.getEvaluationState(threadId);
  }

  /**
   * 证据指纹：turn 计数按 native_status 分计 + 最近一个终态动作 id。只用库内事实行，
   * 不用时间戳（词汇表「no-op 指纹」：时间流逝本身不是证据；turn 状态翻转也要改变指纹）。
   */
  threadEvidenceFingerprint(threadId: string): string {
    return this.threads.threadEvidenceFingerprint(threadId);
  }

  /**
   * 评估落定（sample 成功、如实回落基线或 Jev 决策落提案）：消费当前证据、连败计数清零。
   * noOp 是本轮结论（S1 数据面恒为 no_op；S2 Jev 的结论跟 recommended 走）——A12 的去重只对
   * no_op 结论生效，非 no_op 结论允许下次评估重新触发。
   */
  recordEvaluationSettled(threadId: string, fingerprint: string, options: { noOp?: boolean } = {}): ThreadEvaluationStateView {
    return this.threads.recordEvaluationSettled(threadId, fingerprint, options);
  }

  /**
   * 评估失败（超时/断连/协议非法输出等驱动级失败）：只计连败并按阈值开断路器（同事务落审计），
   * 不动已消费的指纹与 no_op 结论——失败不当 no_op，新证据出现后仍允许重试直到熔断。
   */
  recordEvaluationFailure(threadId: string, reason: string): ThreadEvaluationStateView {
    return this.threads.recordEvaluationFailure(threadId, reason);
  }

  /** 人工 resume：清断路器与连败计数；保留证据指纹（恢复不凭空制造新证据）；打开过才落恢复审计。 */
  resetEvaluationBreaker(threadId: string, options: { requestId?: string } = {}): ThreadEvaluationStateView {
    return this.threads.resetEvaluationBreaker(threadId, options);
  }

  // ---- next_action_proposals（转发 AutomationStore；Jev 提案，ADR-0010） ----

  addProposal(input: {
    threadId?: string | null;
    taskId?: string | null;
    evidenceFingerprint: string;
    payload: Record<string, unknown>;
  }): ProposalView {
    return this.automation.addProposal(input);
  }

  getProposal(id: string): ProposalView | null {
    return this.automation.getProposal(id);
  }

  listProposals(options: { status?: ProposalView["status"]; threadId?: string; taskId?: string; limit?: number } = {}): ProposalView[] {
    return this.automation.listProposals(options);
  }

  /** 裁决一次写入（pending → accepted/rejected）；执行结果并入 payload；非 pending 拒绝改写。 */
  decideProposal(
    id: string,
    decision: "accepted" | "rejected",
    options: { executionResult?: Record<string, unknown> } = {},
  ): ProposalView {
    return this.automation.decideProposal(id, decision, options);
  }

  /** 未收敛 anomaly 计数（mark_done 证据门输入）：只计本线程 source 上 resolved=0 的行。 */
  unresolvedAnomalyCountForThread(threadId: string): number {
    return this.automation.unresolvedAnomalyCountForThread(threadId);
  }

  // ---- shadow 回放（转发 AutomationStore；自治上线门 1–3/6；词汇表「shadow」）----

  /**
   * 从已落库提案派生三方对比快照（no_op 基线恒定不占列；原生侧取收集时刻的最新 turn 终态与
   * goal 状态；Jev 侧取提案推荐与风险）。UNIQUE(thread,fingerprint,recommended) 去重；失败答案
   * （payload.ok!==true）没有可对比的 Jev 选择，不进表。
   */
  collectShadowComparisons(): { collected: number; total: number } {
    return this.automation.collectShadowComparisons();
  }

  listShadowComparisons(limit = 200): ShadowComparisonView[] {
    return this.automation.listShadowComparisons(limit);
  }

  shadowComparisonSummary(): {
    snapshots: number;
    labeled: number;
    unlabeled: number;
    helpful: number;
    ineffective: number;
    harmful: number;
    executedHarmful: number;
  } {
    return this.automation.shadowComparisonSummary();
  }

  /** 人工标注（三值）。已执行快照被标 harmful 时门立即转 halted 并落审计标注（门 6，证据保留）。 */
  labelShadowComparison(id: string, label: ShadowLabel): ShadowComparisonView {
    return this.automation.labelShadowComparison(id, label);
  }

  /** A32：未绑定（无 primary 绑定）thread 的派生证据按可配阈值过期清理，返回删除条数。 */
  expireUnboundEvidence(expiredBeforeMs: number): number {
    return this.automation.expireUnboundEvidence(expiredBeforeMs);
  }

  /**
   * A32：已绑定 thread 的证据保留到 primary 任务归档后 boundEvidenceDays。
   * 参数是归档时间截点（archived_at < 截点即过期）；摘要与 anomaly 不在此清理（跟随 thread）。
   */
  expireBoundEvidence(archivedBeforeMs: number): number {
    return this.automation.expireBoundEvidence(archivedBeforeMs);
  }

  systemoneRecordSuccess(
    input: Parameters<SystemOneStore["recordSuccess"]>[0],
  ): ReturnType<SystemOneStore["recordSuccess"]> {
    return this.systemoneStore.recordSuccess(input);
  }

  systemoneRecordFailure(
    input: Parameters<SystemOneStore["recordFailure"]>[0],
  ): ReturnType<SystemOneStore["recordFailure"]> {
    return this.systemoneStore.recordFailure(input);
  }

  systemoneResumeBreaker(
    input: Parameters<SystemOneStore["resumeBreaker"]>[0],
  ): ReturnType<SystemOneStore["resumeBreaker"]> {
    return this.systemoneStore.resumeBreaker(input);
  }

  systemoneCacheHit(
    input: Parameters<SystemOneStore["cacheHit"]>[0],
  ): ReturnType<SystemOneStore["cacheHit"]> {
    return this.systemoneStore.cacheHit(input);
  }

  systemoneView(threadId: string, currentVersionKey?: string): ReturnType<SystemOneStore["view"]> {
    return this.systemoneStore.view(threadId, currentVersionKey);
  }

  systemoneViews(
    threadIds?: readonly string[],
    currentVersionKey?: string,
  ): ReturnType<SystemOneStore["views"]> {
    return this.systemoneStore.views(threadIds, currentVersionKey);
  }

  systemoneUsageToday(nowMs?: number): ReturnType<SystemOneStore["usageToday"]> {
    return this.systemoneStore.usageToday(nowMs);
  }

  systemoneState(threadId: string): ReturnType<SystemOneStore["state"]> {
    return this.systemoneStore.state(threadId);
  }

  systemoneFacts(threadId: string): ReturnType<SystemOneStore["facts"]> {
    return this.systemoneStore.facts(threadId);
  }

  systemoneCurrentVersionKey(
    params: Parameters<SystemOneStore["currentVersionKey"]>[0],
  ): ReturnType<SystemOneStore["currentVersionKey"]> {
    return this.systemoneStore.currentVersionKey(params);
  }

  // ---- retro 账本（转发 RetroStore；#65，ADR-0023 短命 CLI 与 daemon 同走此写路径）----

  recordRetro(input: RetroRecordInput): RetroRecordView {
    return this.retroStore.recordRetro(input);
  }

  getRetro(identity: RetroIdentity): RetroRecordView | null {
    return this.retroStore.getRetro(identity);
  }

  listRetros(limit?: number): RetroRecordView[] {
    return this.retroStore.listRetros(limit);
  }

  recordCombo(input: ComboRecordInput): ComboRecordView {
    return this.retroStore.recordCombo(input);
  }

  getCombo(sessionId: string): ComboRecordView | null {
    return this.retroStore.getCombo(sessionId);
  }

  listCombos(limit?: number): ComboRecordView[] {
    return this.retroStore.listCombos(limit);
  }

  findSameTypeCombos(query: SameTypeQuery): ComboRecordView[] {
    return this.retroStore.findSameTypeCombos(query);
  }

  // ---- 幂等键（转发 StoreCore）----

  recallResponse(requestId: string): { action: string; status: number; response: unknown } | null {
    return this.core.recallResponse(requestId);
  }

  rememberResponse(requestId: string, action: string, status: number, response: unknown): void {
    this.core.rememberResponse(requestId, action, status, response);
  }
}
