/**
 * cron 触发器：到点经 onFire 起单（daemon 注入，与手动同一条 Run 创建路径）；错过不补；
 * 活跃 Run/归档/缺 workspace/onFire 未起跑都跳过并记原因（不建永远排队的 Run）。
 */

import type { Store } from "./store/index.js";
import type { Task } from "./types.js";

export type FireOutcome = { fired: true; runId: string } | { fired: false; reason: string };

export interface CronTickerOptions {
  store: Store;
  onFire: (task: Task) => Promise<FireOutcome> | FireOutcome;
  now?: () => number;
  intervalMs?: number;
  /** 到期时刻落后 now 超过此值视为停机跨越：跳过不补跑（缺省 tick 间隔 + 10s）。 */
  graceMs?: number;
}

export const DEFAULT_CRON_TICK_MS = 30_000;
export const CRON_SKIP_KIND = "cron_skip";

export class CronTicker {
  private readonly store: Store;
  private readonly onFire: CronTickerOptions["onFire"];
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly graceMs: number;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(options: CronTickerOptions) {
    this.store = options.store;
    this.onFire = options.onFire;
    this.now = options.now ?? (() => Date.now());
    this.intervalMs = options.intervalMs ?? DEFAULT_CRON_TICK_MS;
    this.graceMs = options.graceMs ?? this.intervalMs + 10_000;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private skip(task: Task, reason: string, nowMs: number): void {
    this.store.addAnnotation({ taskId: task.id, kind: CRON_SKIP_KIND, body: reason });
    this.store.advanceCron(task.id, nowMs);
  }

  async tick(): Promise<void> {
    if (this.ticking) return; // 上一轮未落完（onFire 慢），本轮让过
    this.ticking = true;
    try {
      const nowMs = this.now();
      for (const task of this.store.listDueCronTasks(nowMs)) {
        if (task.schedule === null || task.schedule.nextRunAt === null) continue;
        const dueAt = Date.parse(task.schedule.nextRunAt);
        if (task.archived) {
          this.skip(task, "task is archived", nowMs);
          continue;
        }
        if (nowMs - dueAt > this.graceMs) {
          this.skip(task, "missed window while daemon was not running; not backfilled", nowMs);
          continue;
        }
        if (task.workspace === null) {
          this.skip(task, "task has no workspace", nowMs);
          continue;
        }
        const active = this.store.activeRunOf(task.id);
        if (active !== null) {
          this.skip(task, `active run ${active.id} still in progress`, nowMs);
          continue;
        }
        // 先推进 nextRunAt 再起单：onFire 慢或失败都不会让同一窗口二次触发
        this.store.advanceCron(task.id, nowMs);
        let outcome: FireOutcome;
        try {
          outcome = await this.onFire(task);
        } catch (error) {
          outcome = { fired: false, reason: error instanceof Error ? error.message : String(error) };
        }
        if (!outcome.fired) {
          this.store.addAnnotation({ taskId: task.id, kind: CRON_SKIP_KIND, body: outcome.reason });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
