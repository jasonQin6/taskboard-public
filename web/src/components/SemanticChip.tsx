import type { ClientProgressVerdictView } from "../lib/board-model.js";
import { SEMANTIC_STATUS_LABELS, labelOf } from "../lib/labels.js";

/** 语义状态 chip 与原生状态 chip 并列；原生 chip 的展示永不因判定结果改变。 */
export const SemanticChip = ({
  view,
  testId,
}: {
  view: ClientProgressVerdictView | null | undefined;
  testId: string;
}) => {
  const verdict = view?.verdict ?? null;
  if (verdict === null) {
    const degradation = view?.degradation ?? null;
    return (
      <span
        className="status-chip status-semantic-pending"
        data-testid={testId}
        title={degradation?.message ?? "尚未判定"}
      >
        语义 {degradation === null ? "待判定" : "未判定"}
      </span>
    );
  }
  const stale = view?.state === "stale";
  return (
    <span
      className={`status-chip status-semantic status-semantic-${verdict.status}${stale ? " is-stale" : ""}`}
      data-testid={testId}
      title={`${verdict.provenance} · ${verdict.assessedAt}`}
    >
      语义 {labelOf(SEMANTIC_STATUS_LABELS, verdict.status)}
      {stale ? "（旧）" : ""}
    </span>
  );
};

export const confidenceText = (confidence: number): string => `置信 ${Math.round(confidence * 100)}%`;
