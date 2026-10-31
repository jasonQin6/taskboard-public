import type { ClientFailure, ClientProgressVerdictView, ClientSessionSnapshot } from "../lib/board-model.js";
import { relativeTime } from "../lib/format.js";
import { NATIVE_STATUS_LABELS, labelOf } from "../lib/labels.js";
import { SemanticChip, confidenceText } from "./SemanticChip.jsx";

const unknown = (value: string | null): string => value ?? "unknown";

export const ObservedSessionCard = ({
  session,
  verdict,
  onOpen,
}: {
  session: ClientSessionSnapshot;
  verdict?: ClientProgressVerdictView | null;
  onOpen?: (sessionId: string) => void;
}) => {
  const source =
    session.locator.sourcePath === null
      ? "unknown"
      : `${session.locator.sourcePath}:${session.locator.byteStart ?? "?"}`;
  const hash = session.locator.recordHash === null ? "unknown" : session.locator.recordHash.slice(0, 12);
  const judged = verdict?.verdict ?? null;
  const degradation = verdict?.degradation ?? null;
  return (
    <article className="session-card" data-testid={`observed-session-${session.id}`}>
      <header className="session-card-head">
        <span className="status-chip session-harness">{session.harnessId}</span>
        <strong className="session-title">{unknown(session.title)}</strong>
        <span className={`status-chip status-native-${session.nativeStatus}`}>
          {labelOf(NATIVE_STATUS_LABELS, session.nativeStatus)}
        </span>
        <SemanticChip view={verdict} testId={`semantic-status-${session.id}`} />
      </header>
      <div className="session-workspace" title={unknown(session.workspace)}>
        {unknown(session.workspace)}
      </div>
      <div className="session-meta">
        <span>{relativeTime(session.lastActivityAt) || "无最近活动"}</span>
        <span>group {unknown(session.nativeGroup)}</span>
        <span>{session.provenance}</span>
      </div>
      {judged !== null ? (
        <div
          className={`session-verdict${verdict?.state === "stale" ? " is-stale" : ""}`}
          data-testid={`session-verdict-${session.id}`}
          title={judged.provenance}
        >
          <span className="session-verdict-reason">{judged.reasonShort}</span>
          <span>{confidenceText(judged.confidence)}</span>
          <span>{relativeTime(judged.assessedAt)}</span>
        </div>
      ) : degradation !== null ? (
        <div className="session-verdict session-verdict-degraded" data-testid={`session-verdict-${session.id}`}>
          {degradation.message}
        </div>
      ) : null}
      <div className="session-source" title={source}>
        <span>{source}</span>
        <span>#{hash}</span>
      </div>
      {onOpen !== undefined ? (
        <button
          type="button"
          className="session-open"
          data-testid={`open-observed-session-${session.id}`}
          onClick={() => onOpen(session.id)}
        >
          查看详情
        </button>
      ) : null}
    </article>
  );
};

export const HarnessFailures = ({ failures }: { failures: ClientFailure[] }) => {
  if (failures.length === 0) return null;
  return (
    <section className="session-failures" data-testid="session-failures" aria-label="观察降级">
      {failures.map((failure, index) => (
        <p key={`${failure.code}-${index}`} data-testid={`session-failure-${failure.code}`}>
          <strong>{failure.code}</strong> {failure.message}
          {failure.retryable ? "（可重试）" : ""}
        </p>
      ))}
    </section>
  );
};
