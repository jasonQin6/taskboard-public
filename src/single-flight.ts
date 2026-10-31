/** 进程内单飞登记：同一 thread 至多一个 in-flight 写操作（不变量「单条 Codex 写路径」）。跨进程持有由 app-server 写锁探测，不在这里排队。 */

export type InFlightKind =
  | "send"
  | "cancel"
  | "goal"
  | "sample"
  | "proposal"
  | "resume";

export interface InFlightEntry {
  threadId: string;
  kind: InFlightKind;
  startedAt: number;
}

export class SingleFlightRegistry {
  private readonly entries = new Map<string, InFlightEntry>();

  /** 成功即登记；已有 in-flight 返回 false，调用方决定排队或明确拒绝（绝不并行）。 */
  tryAcquire(threadId: string, kind: InFlightKind, now = Date.now()): boolean {
    if (this.entries.has(threadId)) return false;
    this.entries.set(threadId, { threadId, kind, startedAt: now });
    return true;
  }

  release(threadId: string): void {
    this.entries.delete(threadId);
  }

  /** 槽位平移（resume→send）：持有者把在飞登记原位换成下一阶段，thread 从未无主——
   *  释放再认领之间的微任务窗口会被 goal/sample 等第三者插队，把正常的续跑打成单飞冲突。 */
  transfer(threadId: string, toKind: InFlightKind): boolean {
    const entry = this.entries.get(threadId);
    if (entry === undefined) return false;
    this.entries.set(threadId, { threadId, kind: toKind, startedAt: entry.startedAt });
    return true;
  }

  isInFlight(threadId: string): boolean {
    return this.entries.has(threadId);
  }

  anyInFlight(threadIds: readonly string[]): boolean {
    return threadIds.some((id) => this.entries.has(id));
  }

  count(): number {
    return this.entries.size;
  }

  /** 重启对账的进程内部分：daemon 启动时必为空，显式清空是为了测试与语义对齐。 */
  clear(): void {
    this.entries.clear();
  }
}
