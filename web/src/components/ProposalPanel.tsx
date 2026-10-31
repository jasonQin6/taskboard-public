import { useState } from "react";
import type { BoardModel } from "../lib/board-model.js";
import { relativeTime } from "../lib/format.js";
import { JEV_ACTION_LABELS, RISK_LABELS, labelOf } from "../lib/labels.js";
import type { ClientProposal } from "../lib/proposal.js";

const PROPOSAL_STATUS_LABELS: Record<string, string> = {
  pending: "待裁决",
  accepted: "已接受",
  rejected: "已拒绝",
  expired: "已过期",
};

/** 执行结果里值得人读的键；其余键原样 JSON 吐出（未知字段容忍）。 */
const EXECUTION_KEYS: Record<string, string> = {
  executed: "已执行",
  movedTo: "移动到",
  annotationId: "标注",
  message: "发送内容",
  authorizedBy: "授权方",
  turn: "turn 终态",
};

const ExecutionChain = ({ result }: { result: Record<string, unknown> }) => (
  <div className="proposal-execution" data-testid="proposal-execution">
    <span className="proposal-execution-title">动作执行链</span>
    <ul>
      {Object.entries(result).map(([key, value]) => (
        <li key={key}>
          <span className="proposal-exec-key">{EXECUTION_KEYS[key] ?? key}</span>
          <span className="proposal-exec-value">{typeof value === "string" ? value : JSON.stringify(value)}</span>
        </li>
      ))}
    </ul>
  </div>
);

export const ProposalPanel = ({
  proposal,
  board,
  onError,
}: {
  proposal: ClientProposal;
  board: BoardModel;
  onError: (error: unknown) => void;
}) => {
  const answer = proposal.payload.ok === true ? proposal.payload.answer : undefined;
  // 裁决在途守卫：双击接受 / 接受后又点拒绝会发出并发请求，第二个只会以错误弹窗收场
  const [deciding, setDeciding] = useState(false);
  const decide = async (type: "proposal.accept" | "proposal.reject"): Promise<void> => {
    setDeciding(true);
    try {
      await board.runAction(type, { proposalId: proposal.id });
    } catch (error) {
      onError(error);
    } finally {
      setDeciding(false);
    }
  };

  return (
    <article className={`proposal proposal-${proposal.status}`} data-testid={`proposal-${proposal.id}`}>
      <header className="proposal-head">
        <span className={`proposal-status proposal-status-${proposal.status}`}>
          {PROPOSAL_STATUS_LABELS[proposal.status] ?? proposal.status}
        </span>
        {answer !== undefined ? (
          <span className="proposal-confidence" data-testid="proposal-confidence">
            置信度 {(answer.confidence * 100).toFixed(0)}%
          </span>
        ) : null}
        <time className="proposal-time">{relativeTime(proposal.createdAt)}</time>
      </header>

      {answer !== undefined ? (
        <>
          <p className="proposal-summary" data-testid="proposal-summary">
            {answer.summaryShort}
          </p>
          <div className="proposal-candidates" data-testid="proposal-candidates">
            {answer.candidates.map((candidate) => (
              <div
                key={candidate.action}
                className={`proposal-candidate${candidate.action === answer.recommended ? " recommended" : ""}`}
                data-testid={`candidate-${candidate.action}`}
              >
                <span className="candidate-action">
                  {candidate.action === answer.recommended ? "★ " : ""}
                  {labelOf(JEV_ACTION_LABELS, candidate.action)}
                </span>
                <span className={`candidate-risk risk-${candidate.risk}`}>{labelOf(RISK_LABELS, candidate.risk)}</span>
                <span className="candidate-reason">{candidate.reasonShort}</span>
                {candidate.evidenceRefs.length > 0 ? (
                  <span className="candidate-refs" title="证据引用">
                    证据 ×{candidate.evidenceRefs.length}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="proposal-failed" data-testid="proposal-failed">
          评估失败
          {proposal.payload.error !== undefined ? `（${proposal.payload.error.kind}: ${proposal.payload.error.message}）` : ""}
        </p>
      )}

      {proposal.payload.executionResult !== undefined ? (
        <ExecutionChain result={proposal.payload.executionResult} />
      ) : null}

      {proposal.status === "pending" && answer !== undefined ? (
        <footer className="proposal-actions">
          <button
            type="button"
            data-testid="proposal-accept"
            disabled={deciding}
            onClick={() => void decide("proposal.accept")}
          >
            接受提案
          </button>
          <button
            type="button"
            className="danger"
            data-testid="proposal-reject"
            disabled={deciding}
            onClick={() => void decide("proposal.reject")}
          >
            拒绝提案
          </button>
        </footer>
      ) : null}
    </article>
  );
};

/** 详情抽屉里的提案列表：按 pending 优先排序；空态一句话。 */
export const ProposalList = ({
  proposals,
  board,
  onError,
  emptyText,
}: {
  proposals: ClientProposal[];
  board: BoardModel;
  onError: (error: unknown) => void;
  emptyText: string;
}) => (
  <div className="proposal-list" data-testid="proposal-list">
    {proposals.length === 0 ? (
      <p className="detail-empty">{emptyText}</p>
    ) : (
      proposals.map((proposal) => <ProposalPanel key={proposal.id} proposal={proposal} board={board} onError={onError} />)
    )}
  </div>
);
