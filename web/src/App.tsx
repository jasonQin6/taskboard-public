import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BoardModel, type ClientTask } from "./lib/board-model.js";
import { ThreadDetailModel } from "./lib/detail-model.js";
import { matchesSearch } from "./lib/search.js";
import { TaskCardView, TASK_STATUSES, type TaskStatus } from "./components/TaskCardView.jsx";
import { TaskDetailView } from "./components/TaskDetailView.jsx";
import { ThreadDetailView } from "./components/ThreadDetailView.jsx";
import { HarnessFailures, ObservedSessionCard } from "./components/ObservedSessionCard.jsx";
import { DEFAULT_VIEW_STATE, loadViewState, saveViewState, type ViewState } from "./view-state.js";

const NO_WORKSPACE = "（无 workspace）";

/** 详情抽屉选择：浏览器本地临时状态，绝不写数据库。 */
interface DetailSelection {
  kind: "task" | "thread";
  id: string;
  /** Phase 1 观察卡（只读）打开的详情不得暴露执行入口；缺省为可管理的既有详情链路。 */
  readOnly?: boolean;
}

const workspaceKeyOf = (task: ClientTask): string => task.workspace ?? NO_WORKSPACE;

/** 列内按 workspace 分区（用户故事 4）；分区头在只有一区时隐藏。 */
const groupByWorkspace = (tasks: ClientTask[]): Array<{ workspace: string; tasks: ClientTask[] }> => {
  const groups = new Map<string, ClientTask[]>();
  for (const task of tasks) {
    const key = workspaceKeyOf(task);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [task]);
    else bucket.push(task);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workspace, grouped]) => ({ workspace, tasks: grouped }));
};

const boardModel = new BoardModel(window.location.origin);
const threadDetailModel = new ThreadDetailModel(window.location.origin);

export const App = () => {
  const state = useSyncExternalStore(boardModel.subscribe, boardModel.getState, () => null);
  const [view, setView] = useState<ViewState>(() =>
    typeof window === "undefined" ? DEFAULT_VIEW_STATE : loadViewState(),
  );
  const [detail, setDetail] = useState<DetailSelection | null>(null);
  const [visibilityEpoch, setVisibilityEpoch] = useState(0);
  const bootedRef = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    // 详情抽屉不开第二条 SSE：复用看板连接的 revision 事件做按域收敛
    const unsubscribeDetail = boardModel.onRevision((change) => threadDetailModel.handleRevisionEvent(change));
    // 首刷失败也必须接上事件循环：事件循环的重连 pull 会收敛状态，否则断言失败时永远停在「连接中」
    void boardModel
      .refresh()
      .catch(() => undefined)
      .finally(() => boardModel.connectEvents());
    return () => {
      unsubscribeDetail();
      boardModel.close();
      bootedRef.current = false;
    };
  }, []);

  useEffect(() => {
    saveViewState(view);
  }, [view]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") setVisibilityEpoch((value) => value + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const threadsRevision = state?.revisions.threads ?? 0;
  const configRevision = state?.revisions.config ?? 0;
  const revisionKnown = state !== null;
  const openThreadId = detail?.kind === "thread" ? detail.id : null;
  const assessedKey = `${threadsRevision}:${configRevision}:${openThreadId ?? ""}:${visibilityEpoch}`;
  const lastAssessedKeyRef = useRef<string | null>(null);

  // 自动判定只登记可见会话（非 force）：成功后命中缓存不再写库，revision 收敛即停。
  // 显式 force 只属于详情按钮，混进来会把「判定落库 → revision → 再判定」变成刷新环。
  useEffect(() => {
    if (!revisionKnown || document.visibilityState !== "visible") return;
    if (lastAssessedKeyRef.current === assessedKey) return;
    const timer = setTimeout(() => {
      if (document.visibilityState !== "visible") return;
      lastAssessedKeyRef.current = assessedKey;
      const ids = [
        ...new Set([
          ...(stateRef.current?.sessions ?? []).map((session) => session.id),
          ...(openThreadId === null ? [] : [openThreadId]),
        ]),
      ];
      if (ids.length === 0) return;
      void boardModel.assessVisible(ids).catch(() => undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [assessedKey, revisionKnown, openThreadId]);

  const threads = state?.threads ?? [];
  const visible = useMemo(() => {
    const all = state?.tasks ?? [];
    const inWorkspace = view.workspace === "" ? all : all.filter((task) => workspaceKeyOf(task) === view.workspace);
    return inWorkspace.filter((task) => matchesSearch(task, threads, view.query));
  }, [state, threads, view.workspace, view.query]);

  const active = visible.filter((task) => !task.archived);
  const archived = visible.filter((task) => task.archived);
  const workspaces = useMemo(
    () => [...new Set((state?.tasks ?? []).map(workspaceKeyOf))].sort((a, b) => a.localeCompare(b)),
    [state],
  );
  const inboxCount = state?.inbox.length ?? 0;
  const verdicts = useMemo(
    () => new Map((state?.progressVerdicts ?? []).map((view) => [view.threadId, view])),
    [state],
  );

  // 幽灵 workspace 自愈：过滤值持久化在 localStorage，其任务被删/移走后选项消失、整板只剩「无任务」，
  // 且该值跨重载存活。workspace 集合可知后重置为「全部」，不留无提示的死过滤。
  useEffect(() => {
    if (view.workspace === "" || workspaces.includes(view.workspace)) return;
    setView((prev) => ({ ...prev, workspace: "" }));
  }, [view.workspace, workspaces]);

  // 详情抽屉目标任务一次求值：任务被删时抽屉静默关闭（null 渲染），不藏在 JSX 内联 IIFE 里
  const detailTask =
    detail !== null && detail.kind === "task"
      ? (state?.tasks ?? []).find((candidate) => candidate.id === detail.id)
      : undefined;

  return (
    <div className={`board-root${view.compact ? " compact" : ""}`} data-testid="board">
      <header className="board-header">
        <h1>taskboard</h1>
        <input
          type="search"
          placeholder="搜索标题、标签、摘要、线程标题…"
          value={view.query}
          data-testid="search-input"
          onChange={(event) => setView((prev) => ({ ...prev, query: event.target.value }))}
        />
        <select
          aria-label="workspace 过滤"
          data-testid="workspace-filter"
          value={view.workspace}
          onChange={(event) => setView((prev) => ({ ...prev, workspace: event.target.value }))}
        >
          <option value="">全部 workspace</option>
          {workspaces.map((workspace) => (
            <option key={workspace} value={workspace}>
              {workspace}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="compact-toggle"
          aria-pressed={view.compact}
          onClick={() => setView((prev) => ({ ...prev, compact: !prev.compact }))}
        >
          {view.compact ? "舒适模式" : "紧凑模式"}
        </button>
        <span className="header-chips">
          <span className="chip" data-testid="inbox-count" title="Inbox：未绑定任务的线程">
            Inbox {inboxCount}
          </span>
          {(state?.runtime.automationPaused ?? false) ? (
            <span className="chip chip-warn" data-testid="automation-paused">
              自动化已暂停
            </span>
          ) : null}
          {!revisionKnown ? <span className="chip" data-testid="connection-state">连接中…</span> : null}
          {state?.lastError != null ? (
            <span className="chip chip-warn" data-testid="board-error" title="看板全域重拉失败，将自动重试">
              重拉失败：{state.lastError}
            </span>
          ) : null}
        </span>
      </header>

      {!revisionKnown ? (
        <p className="board-empty" data-testid="board-loading">
          正在连接 daemon…
        </p>
      ) : (
        <>
          <section className="session-lane" data-testid="observed-sessions" aria-label="观察中的会话">
            <div className="session-lane-head">
              <h2>观察中的会话</h2>
              <span>{state.sessions.length}</span>
            </div>
            <HarnessFailures failures={state.failures} />
            {state.sessions.length === 0 ? (
              <p className="session-empty">尚未发现 Harness 会话</p>
            ) : (
              <div className="session-grid">
                {state.sessions.map((session) => (
                  <ObservedSessionCard
                    key={`${session.harnessId}:${session.nativeSessionId}`}
                    session={session}
                    verdict={verdicts.get(session.id) ?? null}
                    onOpen={(sessionId) => setDetail({ kind: "thread", id: sessionId, readOnly: true })}
                  />
                ))}
              </div>
            )}
          </section>
          <main className="columns" data-testid="columns">
            {TASK_STATUSES.map((status: TaskStatus) => {
              const columnTasks = active.filter((task) => task.status === status);
              const groups = groupByWorkspace(columnTasks);
              return (
                <section key={status} className="column" data-testid={`column-${status}`} data-count={columnTasks.length}>
                  <h2 className="column-title">
                    {status} <span className="column-count">{columnTasks.length}</span>
                  </h2>
                  {columnTasks.length === 0 ? <p className="column-empty">无任务</p> : null}
                  {groups.map((group) => (
                    <div key={group.workspace} className="workspace-group" data-testid="workspace-group">
                      {groups.length > 1 ? <h3 className="workspace-name">{group.workspace}</h3> : null}
                      {group.tasks.map((task) => (
                        <TaskCardView
                          key={task.id}
                          task={task}
                          threads={threads}
                          model={boardModel}
                          compact={view.compact}
                          onOpen={() => setDetail({ kind: "task", id: task.id })}
                          onOpenThread={(threadId) => setDetail({ kind: "thread", id: threadId })}
                        />
                      ))}
                    </div>
                  ))}
                </section>
              );
            })}
          </main>
        </>
      )}

      {revisionKnown ? (
        <section className="archive-section" data-testid="archive-section">
          <button
            type="button"
            className="archive-toggle"
            data-testid="archive-toggle"
            aria-expanded={view.archivedVisible}
            onClick={() => setView((prev) => ({ ...prev, archivedVisible: !prev.archivedVisible }))}
          >
            {view.archivedVisible ? "▾" : "▸"} 已归档（{archived.length}）
          </button>
          {view.archivedVisible ? (
            archived.length === 0 ? (
              <p className="archive-empty">暂无归档任务</p>
            ) : (
              <div className="archive-list">
                {archived.map((task) => (
                  <TaskCardView
                    key={task.id}
                    task={task}
                    threads={threads}
                    model={boardModel}
                    compact={view.compact}
                    onOpen={() => setDetail({ kind: "task", id: task.id })}
                  />
                ))}
              </div>
            )
          ) : null}
        </section>
      ) : null}

      {detailTask !== undefined ? (
        <TaskDetailView
          task={detailTask}
          board={boardModel}
          threads={threads}
          onClose={() => setDetail(null)}
          onOpenThread={(threadId) => setDetail({ kind: "thread", id: threadId })}
        />
      ) : null}
      {detail !== null && detail.kind === "thread" ? (
        <ThreadDetailView
          threadId={detail.id}
          model={threadDetailModel}
          board={boardModel}
          readOnly={detail.readOnly === true}
          onClose={() => setDetail(null)}
          onOpenThread={(threadId) => setDetail({ kind: "thread", id: threadId, readOnly: detail.readOnly === true })}
        />
      ) : null}
    </div>
  );
};
