import { useState } from "react";
import type { BoardModel, ClientTask, ClientThread } from "../lib/board-model.js";
import { lastActivityAt, relativeTime } from "../lib/format.js";
import { Markdown } from "./Markdown";

export const TASK_STATUSES = ["backlog", "todo", "running", "done", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "backlog",
  todo: "todo",
  running: "running",
  done: "done",
  failed: "failed",
};

const BADGE_LABELS: Record<string, string> = {
  interrupted: "已中断",
  external_activity: "外部活动中",
  held: "写锁被持有",
};

const SUMMARY_LABELS: Record<string, string> = {
  none: "无摘要",
  compacted: "摘要:compacted",
  sample: "摘要:sample",
};

export interface TaskCardProps {
  task: ClientTask;
  threads: ClientThread[];
  model: BoardModel;
  compact: boolean;
  /** 打开任务详情抽屉（#12）；标题可点击。 */
  onOpen?: () => void;
  /** 打开代表线程详情抽屉；线程行可点击。 */
  onOpenThread?: (threadId: string) => void;
}

export const TaskCardView = ({ task, threads, model, compact, onOpen, onOpenThread }: TaskCardProps) => {
  const activity = relativeTime(lastActivityAt(task, threads));
  // 移动失败计数进 key：runAction 拒绝不触发任何状态变更，受控 select 会滞留用户误选的目标状态
  const [moveFailures, setMoveFailures] = useState(0);
  const onError = (error: unknown): void => {
    window.alert(error instanceof Error ? error.message : String(error));
  };
  const move = async (status: string): Promise<void> => {
    if (status === task.status) return;
    try {
      await model.runAction("task.move", { taskId: task.id, status });
    } catch (error) {
      setMoveFailures((count) => count + 1);
      onError(error);
    }
  };
  const toggleArchive = async (): Promise<void> => {
    try {
      await model.runAction(task.archived ? "task.unarchive" : "task.archive", { taskId: task.id });
    } catch (error) {
      onError(error);
    }
  };
  const remove = async (): Promise<void> => {
    if (!window.confirm(`删除任务「${task.title}」？该操作不可撤销。`)) return;
    try {
      await model.runAction("task.delete", { taskId: task.id });
    } catch (error) {
      onError(error);
    }
  };

  return (
    <article className={`card${compact ? " card-compact" : ""}`} data-testid={`card-${task.id}`}>
      <header className="card-head">
        <span className={`status-chip status-${task.status}`}>{task.status}</span>
        {onOpen !== undefined ? (
          <strong className="card-title">
            <button type="button" className="card-title-button" data-testid={`open-detail-${task.id}`} onClick={onOpen}>
              {task.title}
            </button>
          </strong>
        ) : (
          <strong className="card-title">{task.title}</strong>
        )}
      </header>
      <div className="card-badges">
        {task.badges.map((badge) => (
          <span key={badge} className={`badge badge-${badge}`} data-testid={`badge-${badge}`}>
            {BADGE_LABELS[badge] ?? badge}
          </span>
        ))}
        <span className={`badge badge-summary badge-summary-${task.summaryStatus}`}>
          {SUMMARY_LABELS[task.summaryStatus] ?? task.summaryStatus}
        </span>
        {task.activeRun !== null ? (
          <span className="badge badge-run" data-testid="badge-active-run">
            run {task.activeRun.status}
          </span>
        ) : null}
      </div>
      {!compact ? (
        <>
          {task.labels.length > 0 ? <div className="card-labels">{task.labels.map((label) => `#${label}`).join(" ")}</div> : null}
          <div className="card-thread" data-testid="thread-info">
            {task.primaryThreadId !== null ? (
              onOpenThread !== undefined ? (
                <button
                  type="button"
                  className="thread-link"
                  data-testid={`open-thread-${task.primaryThreadId}`}
                  onClick={() => onOpenThread(task.primaryThreadId!)}
                >
                  线程 {task.primaryThreadId.slice(0, 8)} · {task.primaryThreadStatus ?? "unknown"} · 共 {task.threadCount} 条
                </button>
              ) : (
                `线程 ${task.primaryThreadId.slice(0, 8)} · ${task.primaryThreadStatus ?? "unknown"} · 共 ${task.threadCount} 条`
              )
            ) : (
              "未绑定线程"
            )}
          </div>
          {task.prompt.trim() !== "" ? (
            <details className="card-prompt">
              <summary>描述</summary>
              <Markdown text={task.prompt} />
            </details>
          ) : null}
        </>
      ) : null}
      <footer className="card-foot">
        {activity !== "" ? <time className="card-activity">{activity}</time> : <span className="card-activity" />}
        <span className="card-actions">
          <select
            aria-label="移动到"
            data-testid="move-select"
            key={`${task.id}-${task.status}-${moveFailures}`}
            value={task.status}
            onChange={(event) => {
              void move(event.target.value);
            }}
          >
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <button type="button" data-testid="archive-button" onClick={() => void toggleArchive()}>
            {task.archived ? "取消归档" : "归档"}
          </button>
          <button type="button" className="danger" data-testid="delete-button" onClick={() => void remove()}>
            删除
          </button>
        </span>
      </footer>
    </article>
  );
};
