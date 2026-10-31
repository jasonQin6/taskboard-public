import { useEffect, useState, useSyncExternalStore } from "react";
import type { BoardModel, ClientSystemOneRuntime } from "../lib/board-model.js";
import { relativeTime } from "../lib/format.js";
import { NATIVE_STATUS_LABELS, PROVENANCE_LABELS, SEMANTIC_STATUS_LABELS, labelOf } from "../lib/labels.js";
import { orderProposals, type ClientProposal } from "../lib/proposal.js";
import type { ThreadDetailModel } from "../lib/detail-model.js";
import { ProposalList } from "./ProposalPanel";
import { confidenceText } from "./SemanticChip.jsx";

export interface ThreadDetailViewProps {
  threadId: string;
  model: ThreadDetailModel;
  board: BoardModel;
  onClose: () => void;
  /** lineage 关联跳转（fork/rollback/subagent 可视化关联）。 */
  onOpenThread: (threadId: string) => void;
  /** Phase 1 只读观察详情：隐藏提案执行区（accept/reject 会变更任务状态）。 */
  readOnly?: boolean;
}

const RELATION_LABELS: Record<string, string> = {
  fork: "fork",
  rollback: "回滚",
  subagent: "子代理",
  resumed: "续跑",
};

const runtimeBannerOf = (runtime: ClientSystemOneRuntime | null): string | null => {
  if (runtime === null) return null;
  if (!runtime.enabled) return "语义判断已关闭（settings.systemoneEnabled=false）";
  if (!runtime.available) return `语义判断不可用：${runtime.unavailableReason ?? "原因未知"}`;
  if (runtime.budget.exhausted) {
    return `今日语义判断预算已用尽（${runtime.budget.usedTokens}/${runtime.budget.limitTokens} tokens）`;
  }
  return null;
};

const locatorLabel = (
  locator:
    | {
        sourcePath: string | null;
        byteStart: number | null;
        recordHash: string | null;
        kind?: "start" | "terminal" | null;
      }
    | null
    | undefined,
): string => {
  if (locator === null || locator === undefined) return "来源不可用";
  const path = locator.sourcePath ?? "source unknown";
  const position = locator.byteStart === null ? "?" : locator.byteStart;
  const hash = locator.recordHash === null ? "hash unknown" : `#${locator.recordHash.slice(0, 12)}`;
  const kind = locator.kind === "start" ? "起点" : locator.kind === "terminal" ? "终态回退" : null;
  return `${path}:${position} ${hash}${kind === null ? "" : ` (${kind})`}`;
};

interface LineageEdge {
  threadId: string;
  parentThreadId: string;
  relation: string;
  createdAt: string;
  [key: string]: unknown;
}

const LineageList = ({
  edges,
  direction,
  selfId,
  onOpenThread,
}: {
  edges: unknown[];
  direction: "parents" | "children";
  selfId: string;
  onOpenThread: (threadId: string) => void;
}) => {
  if (edges.length === 0) return null;
  return (
    <div className="lineage-group" data-testid={`lineage-${direction}`}>
      <span className="lineage-title">{direction === "parents" ? "来源" : "派生"}</span>
      {edges.map((edge) => {
        const e = edge as LineageEdge;
        const other = direction === "parents" ? e.parentThreadId : e.threadId;
        return (
          <button
            // 三元组不保证唯一（同对线程可重复建立同 relation 的边）；createdAt 保证 key 稳定且不撞
            key={`${e.parentThreadId}-${e.threadId}-${e.relation}-${e.createdAt}`}
            type="button"
            className="lineage-link"
            data-testid="lineage-link"
            onClick={() => onOpenThread(other)}
          >
            {RELATION_LABELS[e.relation] ?? e.relation} · {other.slice(0, 8)}
            {other === selfId ? "（本线程）" : ""}
          </button>
        );
      })}
    </div>
  );
};

export const ThreadDetailView = ({ threadId, model, board, onClose, onOpenThread, readOnly = false }: ThreadDetailViewProps) => {
  const state = useSyncExternalStore(model.subscribe, model.getState, () => null);
  const boardState = useSyncExternalStore(board.subscribe, board.getState, () => null);
  const [verdictBusy, setVerdictBusy] = useState<"refresh" | "resume" | null>(null);
  const [verdictError, setVerdictError] = useState<string | null>(null);

  useEffect(() => {
    setVerdictBusy(null);
    setVerdictError(null);
    void model.open(threadId).catch(() => undefined);
    return () => {
      model.close();
    };
  }, [model, threadId]);

  const detail = state?.detail ?? null;
  const turns = state?.turns ?? [];
  const evidence = state?.evidence ?? [];
  const loadedTurns = turns.length;
  const turnTotal = detail?.turnCount ?? 0;
  const threadProposals = orderProposals(
    ((boardState?.proposals ?? []) as ClientProposal[]).filter((candidate) => candidate.threadId === threadId),
  );
  const runtimeBanner = runtimeBannerOf(boardState?.runtime.systemone ?? null);
  const verdictView = detail?.progressVerdict ?? null;
  const verdict = verdictView?.verdict ?? null;
  const degradation = verdictView?.degradation ?? null;
  const breakerOpen = verdictView?.breakerOpen === true;

  const runVerdictAction = (kind: "refresh" | "resume"): void => {
    setVerdictBusy(kind);
    setVerdictError(null);
    const action = kind === "refresh" ? board.refreshVerdict(threadId) : board.resumeVerdict(threadId);
    void action
      .catch((error: unknown) => setVerdictError(error instanceof Error ? error.message : String(error)))
      .finally(() => setVerdictBusy(null));
  };

  return (
    <section className="detail-panel" data-testid="thread-detail-panel" aria-label="线程详情">
      <header className="detail-head">
        <h2>{detail?.title ?? threadId.slice(0, 8)}</h2>
        <button type="button" className="detail-close" data-testid="detail-close" onClick={onClose}>
          关闭
        </button>
      </header>

      {runtimeBanner !== null ? (
        <p className="verdict-banner" data-testid="systemone-banner">
          {runtimeBanner}
        </p>
      ) : null}

      {state?.error !== null && state?.error !== undefined && detail === null ? (
        <p className="detail-error" data-testid="detail-error">
          加载失败：{state.error}
        </p>
      ) : null}

      {detail !== null ? (
        <>
          <div className="detail-status-row" data-testid="thread-status-row">
            <span className={`status-chip status-native-${detail.nativeStatus}`} data-testid="thread-native-status">
              原生 {labelOf(NATIVE_STATUS_LABELS, detail.nativeStatus)}
            </span>
            <span className={`status-chip status-semantic`} data-testid="thread-semantic-status">
              语义 {detail.semanticStatus === null ? "—" : labelOf(SEMANTIC_STATUS_LABELS, detail.semanticStatus)}
            </span>
            <span className="detail-meta">
              turn {turnTotal} · 证据 {detail.evidenceCount} · 最近活动 {relativeTime(detail.lastActivityAt)}
            </span>
          </div>

          <div className="detail-source-row" data-testid="thread-source-row">
            <span className="session-harness status-chip">{detail.harnessId}</span>
            <span className="detail-meta" title={locatorLabel(detail.locator)}>
              {locatorLabel(detail.locator)}
            </span>
          </div>

          <section className="detail-section verdict-panel" data-testid="thread-verdict">
            <h3>语义判断（SystemOne）</h3>
            {verdict === null ? (
              <p className="detail-empty" data-testid="verdict-none">
                {degradation?.message ?? "尚未判定；打开详情或看板可见时自动触发"}
              </p>
            ) : (
              <>
                <div className="verdict-line">
                  <strong data-testid="verdict-status">
                    语义 {labelOf(SEMANTIC_STATUS_LABELS, verdict.status)}
                  </strong>
                  <span data-testid="verdict-reason">{verdict.reasonShort}</span>
                  <span data-testid="verdict-confidence">{confidenceText(verdict.confidence)}</span>
                  <span data-testid="verdict-assessed-at">{relativeTime(verdict.assessedAt)}</span>
                </div>
                <div className="verdict-line">
                  <span className="verdict-provenance" data-testid="verdict-provenance">
                    {verdict.provenance}
                  </span>
                  <span data-testid="verdict-evidence-count">证据引用 {verdict.evidenceRefs.length}</span>
                  <span>{verdictView?.state === "stale" ? "结果已过期（证据已变化）" : "当前结果"}</span>
                </div>
              </>
            )}
            {degradation !== null ? (
              <p className="verdict-degradation" data-testid="verdict-degradation">
                {degradation.code}：{degradation.message}
              </p>
            ) : null}
            {breakerOpen ? (
              <p className="verdict-degradation" data-testid="verdict-breaker">
                判定断路器已打开；可点「恢复判断」清除后重试
              </p>
            ) : null}
            <div className="verdict-actions">
              <button
                type="button"
                className="load-more"
                data-testid="verdict-refresh"
                disabled={verdictBusy !== null}
                onClick={() => runVerdictAction("refresh")}
              >
                {verdictBusy === "refresh" ? "刷新中…" : "刷新判断"}
              </button>
              <button
                type="button"
                className="load-more"
                data-testid="verdict-resume"
                disabled={verdictBusy !== null}
                onClick={() => runVerdictAction("resume")}
              >
                {verdictBusy === "resume" ? "恢复中…" : "恢复判断"}
              </button>
            </div>
            {verdictError !== null ? (
              <p className="detail-error" data-testid="verdict-action-error">
                {verdictError}
              </p>
            ) : null}
          </section>

          <div className="lineage-row">
            <LineageList edges={detail.lineage.parents} direction="parents" selfId={detail.id} onOpenThread={onOpenThread} />
            <LineageList edges={detail.lineage.children} direction="children" selfId={detail.id} onOpenThread={onOpenThread} />
          </div>

          <section className="detail-section" data-testid="thread-summaries">
            <h3>多轮摘要</h3>
            {state?.summaries.length === 0 ? (
              <p className="detail-empty" data-testid="summary-none">
                原生摘要：none（Harness 未产出 compacted 记录）
              </p>
            ) : (
              state?.summaries.map((summary) => (
                <div key={summary.id} className={`summary-item provenance-${summary.provenance}`}>
                  <span className={`badge badge-summary provenance-tag provenance-${summary.provenance}`}>
                    {labelOf(PROVENANCE_LABELS, summary.provenance)}
                  </span>
                  <span className="summary-text">{summary.text}</span>
                  <span className="summary-locator" title={locatorLabel(summary.locator)}>
                    {locatorLabel(summary.locator)}
                  </span>
                  <time>{relativeTime(summary.createdAt)}</time>
                </div>
              ))
            )}
          </section>

          <section className="detail-section" data-testid="turn-timeline">
            <h3>
              Turn 时间线（已载 {loadedTurns}/{turnTotal}）
            </h3>
            <table className="turn-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">原生状态</th>
                  <th scope="col">语义状态</th>
                  <th scope="col">开始</th>
                  <th scope="col">结束</th>
                  <th scope="col">来源</th>
                </tr>
              </thead>
              <tbody>
                {turns.map((turn) => (
                  <tr key={turn.id} data-testid={`turn-${turn.ordinal}`}>
                    <td>{turn.ordinal}</td>
                    <td>
                      <span className={`native-dot native-${turn.nativeStatus}`} />{" "}
                      {labelOf(NATIVE_STATUS_LABELS, turn.nativeStatus)}
                    </td>
                    <td className="turn-semantic">{detail.semanticStatus === null ? "—" : labelOf(SEMANTIC_STATUS_LABELS, detail.semanticStatus)}</td>
                    <td>{relativeTime(turn.startedAt)}</td>
                    <td>{relativeTime(turn.endedAt)}</td>
                    <td className="turn-locator" title={locatorLabel(turn.locator)}>
                      {locatorLabel(turn.locator)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {state?.turnsCursor !== null && state?.turnsCursor !== undefined ? (
              <button
                type="button"
                className="load-more"
                data-testid="load-more-turns"
                onClick={() => void model.loadMoreTurns()}
              >
                加载更多 turn
              </button>
            ) : null}
          </section>

          <section className="detail-section" data-testid="thread-evidence">
            <h3>
              证据（已载 {evidence.length}/{detail.evidenceCount}）
            </h3>
            {evidence.length === 0 ? (
              <p className="detail-empty">暂无证据</p>
            ) : (
              <ul className="evidence-list">
                {evidence.map((item) => (
                  <li key={item.id} className={`evidence-item evidence-${item.kind}`} data-testid="evidence-item">
                    <span className="evidence-kind">{item.kind}</span>
                    {item.turnOrdinal !== null ? <span className="evidence-turn">turn {item.turnOrdinal}</span> : null}
                    <span className="evidence-summary">{item.summary ?? ""}</span>
                    <span className="evidence-locator" title={locatorLabel(item.source)}>
                      {locatorLabel(item.source)}
                    </span>
                    <time>{relativeTime(item.createdAt)}</time>
                  </li>
                ))}
              </ul>
            )}
            {state?.evidenceCursor !== null && state?.evidenceCursor !== undefined ? (
              <button
                type="button"
                className="load-more"
                data-testid="load-more-evidence"
                onClick={() => void model.loadMoreEvidence()}
              >
                加载更多证据
              </button>
            ) : null}
          </section>

          {readOnly ? null : (
            <section className="detail-section" data-testid="thread-proposals">
              <h3>Jev 提案</h3>
              <ProposalList
                proposals={threadProposals}
                board={board}
                onError={(error) => window.alert(error instanceof Error ? error.message : String(error))}
                emptyText="暂无提案（automation=suggest 时评估层产出）"
              />
            </section>
          )}
        </>
      ) : state?.error != null ? (
        // 初次装载失败（404/daemon 重启）时不得再显示永久「正在加载」占位；给出重试入口
        <div className="detail-retry">
          <button
            type="button"
            className="load-more"
            data-testid="detail-retry"
            onClick={() => void model.open(threadId).catch(() => undefined)}
          >
            重试加载
          </button>
        </div>
      ) : (
        <p className="detail-empty">正在加载线程详情…</p>
      )}
    </section>
  );
};
