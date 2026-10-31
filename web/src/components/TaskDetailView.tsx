import { useEffect, useState, useSyncExternalStore } from "react";
import type { BoardModel, ClientRun, ClientTask, ClientThread } from "../lib/board-model.js";
import { taskDetailEndpoint } from "../lib/endpoints.js";
import { relativeTime } from "../lib/format.js";
import { createLatestOnly } from "../lib/latest-only.js";
import { NATIVE_STATUS_LABELS, PROVENANCE_LABELS, labelOf } from "../lib/labels.js";
import { orderProposals, type ClientProposal } from "../lib/proposal.js";
import { Markdown } from "./Markdown";
import { ProposalList } from "./ProposalPanel";
import { STATUS_LABELS, TASK_STATUSES, type TaskStatus } from "./TaskCardView";

/** 任务详情载荷：GET /api/tasks/:id（卡片字段 + runs/threads/annotations/inFlightWrite）。
 *  threads[].role 是 additive 契约（逐绑定行带角色）；载荷可能来自尚未合入该字段的旧 daemon，按可选消费。 */
interface TaskDetailPayload {
  task: ClientTask & {
    runs: ClientRun[];
    threads: Array<ClientThread & { role?: string }>;
    annotations: Array<{ id: string; kind: string; body: string; createdAt: string }>;
    inFlightWrite: boolean;
    children: Array<{ id: string; title: string }>;
    [key: string]: unknown;
  };
}

/** 解绑角色：优先取载荷给的绑定角色；旧载荷无 role 时回退启发式（primaryTaskId 指向本任务即主绑定）。 */
const unbindRoleOf = (thread: { role?: string; primaryTaskId: string | null }, taskId: string): string => {
  if (typeof thread.role === "string" && thread.role !== "") return thread.role;
  return thread.primaryTaskId === taskId ? "primary" : "derived_from";
};

const BINDING_ROLE_LABELS: Record<string, string> = {
  primary: "主绑定",
  derived_from: "从属绑定",
  evidence_for: "证据引用",
};

export interface TaskDetailViewProps {
  task: ClientTask;
  board: BoardModel;
  /** 全量线程表（绑定选择器：Inbox 未绑定线程 + 其他已知线程）。 */
  threads: ClientThread[];
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}

/** 任务详情拉取 + 按域收敛：tasks/threads 域推进即重拉（A31 同款语义，经 BoardModel 附加订阅）。 */
const useTaskDetail = (board: BoardModel, taskId: string): TaskDetailPayload | null => {
  const [payload, setPayload] = useState<TaskDetailPayload | null>(null);
  useEffect(() => {
    // latest-only 收敛第四处（晨析 10-25；#36 票面豁免在原语补 dispose 后重审撤销）：
    // 域事件连发 void load() 的在飞合并（旧响应后到不得覆盖新载荷）由 keep-last 承担，
    // 卸载守卫由 slot.dispose 承担；失败吞掉——保留上一份载荷，看板卡片仍可用
    const slot = createLatestOnly<string>({
      getKey: () => taskId,
      onError: () => undefined,
    });
    const load = (): Promise<void> =>
      slot.run(
        async () => (await board.getJson(taskDetailEndpoint(taskId))) as TaskDetailPayload,
        (body) => setPayload(body),
      );
    void load();
    const unsubscribe = board.onRevision((change) => {
      if (change.domain === "tasks" || change.domain === "threads") void load();
    });
    return () => {
      slot.dispose();
      unsubscribe();
    };
  }, [board, taskId]);
  return payload;
};

export const TaskDetailView = ({ task, board, threads, onClose, onOpenThread }: TaskDetailViewProps) => {
  const detail = useTaskDetail(board, task.id);
  const boardState = useSyncExternalStore(board.subscribe, board.getState, () => null);
  const [bindChoice, setBindChoice] = useState("");
  // 移动失败计数进 key：runAction 拒绝时不触发任何状态变更，select 受控值会滞留用户误选的目标状态
  const [moveFailures, setMoveFailures] = useState(0);
  const onError = (error: unknown): void => {
    window.alert(error instanceof Error ? error.message : String(error));
  };

  const act = async (type: string, fields: Record<string, unknown>, onFailure?: () => void): Promise<void> => {
    try {
      await board.runAction(type, fields);
    } catch (error) {
      onFailure?.();
      onError(error);
    }
  };

  const remove = (): void => {
    // 删除确认展示：悬空子任务与回 Inbox 线程数量来自卡片字段（删除接口本身返回明细，但确认在前）
    const parts = [`删除任务「${task.title}」？该操作不可撤销。`];
    if (task.childrenCount > 0) parts.push(`${task.childrenCount} 个子任务将悬空（保留并在其审计流留痕）。`);
    if (task.threadCount > 0) parts.push(`${task.threadCount} 条绑定线程将解绑并回到 Inbox。`);
    if (window.confirm(parts.join("\n"))) void act("task.delete", { taskId: task.id });
  };

  const detailThreads = detail?.task.threads ?? [];
  const boundIds = new Set(detailThreads.map((thread) => thread.id));
  const inboxChoices = (boardState?.inbox ?? []).filter((thread) => !boundIds.has(thread.id));
  // 去重按 id：inbox 与 threads 是两次独立反序列化，同一线程必然是不同对象引用
  const inboxIds = new Set(inboxChoices.map((thread) => thread.id));
  const otherChoices = threads.filter((thread) => !boundIds.has(thread.id) && !inboxIds.has(thread.id));
  const proposals = orderProposals(
    ((boardState?.proposals ?? []) as ClientProposal[]).filter(
      (candidate) => candidate.taskId === task.id,
    ),
  );
  const detailTask = detail?.task ?? null;

  return (
    <section className="detail-panel" data-testid="task-detail-panel" aria-label="任务详情">
      <header className="detail-head">
        <h2>{task.title}</h2>
        <button type="button" className="detail-close" data-testid="detail-close" onClick={onClose}>
          关闭
        </button>
      </header>

      <div className="detail-status-row" data-testid="task-detail-meta">
        <span className={`status-chip status-${task.status}`}>{task.status}</span>
        <span className={`badge badge-summary badge-summary-${task.summaryStatus}`}>
          {labelOf(PROVENANCE_LABELS, task.summaryStatus)}
        </span>
        {detailTask?.inFlightWrite === true ? (
          <span className="badge badge-run">写操作进行中</span>
        ) : null}
        <span className="detail-meta">
          更新于 {relativeTime(task.updatedAt)}
          {task.workspace !== null ? ` · ${task.workspace}` : ""}
        </span>
      </div>

      <section className="detail-section">
        <h3>操作</h3>
        <div className="detail-actions">
          <select
            aria-label="移动到"
            data-testid="detail-move-select"
            key={`${task.id}-${task.status}-${moveFailures}`}
            value={task.status}
            onChange={(event) =>
              void act("task.move", { taskId: task.id, status: event.target.value }, () =>
                setMoveFailures((count) => count + 1),
              )
            }
          >
            {TASK_STATUSES.map((status: TaskStatus) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <button type="button" data-testid="detail-archive" onClick={() => void act(task.archived ? "task.unarchive" : "task.archive", { taskId: task.id })}>
            {task.archived ? "取消归档" : "归档"}
          </button>
          <button type="button" className="danger" data-testid="detail-delete" onClick={remove}>
            删除
          </button>
        </div>
        {task.childrenCount > 0 || task.threadCount > 0 ? (
          <p className="detail-hint">
            删除影响：{task.childrenCount > 0 ? `${task.childrenCount} 个子任务将悬空 ` : ""}
            {task.threadCount > 0 ? `${task.threadCount} 条线程回 Inbox` : ""}
          </p>
        ) : null}
      </section>

      {task.prompt.trim() !== "" ? (
        <section className="detail-section">
          <h3>描述</h3>
          <Markdown text={task.prompt} />
        </section>
      ) : null}

      <section className="detail-section" data-testid="task-threads">
        <h3>绑定线程</h3>
        {detailThreads.length === 0 ? (
          <p className="detail-empty">未绑定线程</p>
        ) : (
          <ul className="bound-thread-list">
            {detailThreads.map((thread) => {
              // 解绑角色优先取载荷逐绑定的 role（evidence_for 绑定在旧启发式下永远解不掉）；
              // 同一线程挂多角色时先解载荷给出的这一行，tasks 域刷新后再解余下角色
              const role = unbindRoleOf(thread, task.id);
              const roleLabel = BINDING_ROLE_LABELS[role] ?? (role === "primary" ? "主绑定" : "从属绑定");
              return (
                <li key={thread.id} className="bound-thread" data-testid="bound-thread">
                  <button type="button" className="lineage-link" onClick={() => onOpenThread(thread.id)}>
                    {thread.title ?? thread.id.slice(0, 8)}
                  </button>
                  <span className="detail-meta">
                    {roleLabel} · {labelOf(NATIVE_STATUS_LABELS, thread.nativeStatus)}
                  </span>
                  <button
                    type="button"
                    data-testid="unbind-thread"
                    onClick={() =>
                      void act("thread.unbind", {
                        taskId: task.id,
                        threadId: thread.id,
                        role,
                      })
                    }
                  >
                    解绑
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="bind-row">
          <select
            aria-label="选择要绑定的线程"
            data-testid="bind-thread-select"
            value={bindChoice}
            onChange={(event) => setBindChoice(event.target.value)}
          >
            <option value="">选择线程…</option>
            <optgroup label="Inbox（未绑定）">
              {inboxChoices.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title ?? thread.id.slice(0, 8)}
                </option>
              ))}
            </optgroup>
            <optgroup label="其他已知线程">
              {otherChoices.map((thread) => (
                <option key={thread.id} value={thread.id}>
                  {thread.title ?? thread.id.slice(0, 8)}
                </option>
              ))}
            </optgroup>
          </select>
          <button
            type="button"
            data-testid="bind-thread-button"
            disabled={bindChoice === ""}
            onClick={() => {
              if (bindChoice !== "") void act("thread.bind", { taskId: task.id, threadId: bindChoice });
              setBindChoice("");
            }}
          >
            绑定
          </button>
        </div>
      </section>

      <section className="detail-section" data-testid="task-proposals">
        <h3>提案确认</h3>
        <ProposalList proposals={proposals} board={board} onError={onError} emptyText="暂无待处理提案" />
      </section>

      {detailTask !== null && detailTask.runs.length > 0 ? (
        <section className="detail-section" data-testid="task-runs">
          <h3>运行记录</h3>
          <ul className="run-list">
            {detailTask.runs.map((run) => (
              <li key={run.id} className={`run-item run-${run.status}`} data-testid="run-item">
                <span className="run-status">{run.status}</span>
                <span className="detail-meta">
                  {run.trigger}
                  {run.threadId !== null ? ` · ${run.threadId.slice(0, 8)}` : ""}
                  {run.orphaned ? " · 孤儿对账" : ""}
                  {run.failureReason !== null ? ` · ${run.failureReason}` : ""}
                </span>
                <time>{relativeTime(run.endedAt ?? run.startedAt ?? run.createdAt)}</time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
};
