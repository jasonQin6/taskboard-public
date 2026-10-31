/** 相对时间与卡片最近活动计算；无时间来源时返回空串，不编造日期。 */

import type { ClientTask, ClientThread } from "./board-model.js";

export const relativeTime = (iso: string | null | undefined, now: number = Date.now()): string => {
  if (iso === null || iso === undefined || iso === "") return "";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return "";
  const diff = now - parsed;
  if (diff < 45_000) return "刚刚";
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(parsed).toISOString().slice(0, 10);
};

/** 最近活动 = max(任务更新时间, 最近 Run 终态时间, 绑定线程最近活动)。 */
export const lastActivityAt = (task: ClientTask, threads: ClientThread[]): string | null => {
  const candidates = [task.updatedAt, task.lastRun?.endedAt ?? null];
  for (const thread of threads) {
    if (thread.primaryTaskId === task.id) candidates.push(thread.lastActivityAt);
  }
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const ms = Date.parse(candidate);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latest = candidate;
    }
  }
  return latest;
};
