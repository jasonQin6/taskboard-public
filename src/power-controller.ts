/** 防休眠控制器：按「存在 running Run（或 taskboard 发起的 goal 续跑）」持有平台保护；保护态不入库、不推 revision。 */

import type { PowerGuard } from "./power-guard.js";
import type { Store } from "./store/index.js";
import type { PowerProtectionStatus } from "./types.js";

export interface PowerControllerOptions {
  store: Store;
  /** 懒创建：preventIdleSleep 可在运行期通过 settings 开启，届时才装配平台保护器。 */
  createGuard: () => PowerGuard;
  guard?: PowerGuard;
}

export class PowerController {
  private readonly store: Store;
  private readonly createGuard: () => PowerGuard;
  private guard: PowerGuard | undefined;
  private holding = false;
  private readonly goalContinuations = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: PowerControllerOptions) {
    this.store = options.store;
    this.createGuard = options.createGuard;
    this.guard = options.guard;
  }

  start(): void {
    if (this.unsubscribe !== undefined) return;
    // 任何 tasks/config 域写入都可能改变持有条件（run 终态、settings 开关）
    this.unsubscribe = this.store.subscribe((changes) => {
      if (changes.some((change) => change.domain === "tasks" || change.domain === "config")) {
        void this.evaluate();
      }
    });
    void this.evaluate();
  }

  /** goal 续跑期间 thread 仍 running 但没有 Run：由 driver 登记/注销。 */
  setGoalContinuation(threadId: string, active: boolean): void {
    if (active) this.goalContinuations.add(threadId);
    else this.goalContinuations.delete(threadId);
    void this.evaluate();
  }

  private shouldHold(): boolean {
    return this.store.countRunningRuns() > 0 || this.goalContinuations.size > 0;
  }

  /** 开关打开即装配保护器（不 spawn）：平台不支持要在第一次持有之前就能如实显示 unavailable。 */
  private ensureGuard(): PowerGuard | undefined {
    if (!this.store.getSettings().preventIdleSleep) return undefined;
    this.guard ??= this.createGuard();
    return this.guard;
  }

  evaluate(): Promise<void> {
    // 串行化：acquire/release 必须按判定顺序落到保护器；只在持有态跃迁时调用
    const next = this.tail.then(async () => {
      const guard = this.ensureGuard();
      const wantHold = guard !== undefined && this.shouldHold();
      if (wantHold && !this.holding) {
        this.holding = true;
        await guard!.acquire();
      } else if (!wantHold && this.holding) {
        this.holding = false;
        await this.guard?.release();
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  status(): PowerProtectionStatus {
    const guard = this.ensureGuard();
    return guard === undefined ? "off" : guard.status();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.goalContinuations.clear();
    await this.tail;
    if (this.holding) {
      this.holding = false;
      await this.guard?.release();
    }
  }
}
