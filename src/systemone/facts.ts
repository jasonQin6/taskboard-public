import { createHash } from "node:crypto";
import type { Cursor } from "../harness/contract.js";
import { redactExcerpt } from "../redact.js";
import type { Store } from "../store/index.js";
import type { FingerprintInput } from "./fingerprint.js";
import type { JudgeInput } from "./provider.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const EVIDENCE_LIMIT = 20;
const TURN_LIMIT = 20;
const ANNOTATION_LIMIT = 100;
const EXCERPT_CHARS = 280;

export const systemOneFactsEmpty = (input: JudgeInput): boolean =>
  input.turns.total === 0 && input.evidence.length === 0 && input.summary === null;

export const readJudgeInput = (store: Store, threadId: string): JudgeInput | null => {
  const thread = store.getThread(threadId);
  if (thread === null) return null;
  const identity = store.threadIdentity(threadId);
  const turnPage = store.listTurnsPage(threadId, { limit: TURN_LIMIT, offset: 0 });
  const turnOffset = Math.max(0, turnPage.total - TURN_LIMIT);
  const turns =
    turnOffset === 0
      ? turnPage.items
      : store.listTurnsPage(threadId, { limit: TURN_LIMIT, offset: turnOffset }).items;
  const latest = turns.length > 0 ? turns[turns.length - 1]! : null;
  const byStatus: Record<string, number> = {};
  for (const turn of turns) {
    byStatus[turn.nativeStatus] = (byStatus[turn.nativeStatus] ?? 0) + 1;
  }
  const sortedByStatus = Object.fromEntries(
    Object.entries(byStatus).sort(([a], [b]) => a.localeCompare(b)),
  );
  const evidencePage = store.listEvidencePage(threadId, { limit: EVIDENCE_LIMIT, offset: 0 });
  const evidenceOffset = Math.max(0, evidencePage.total - EVIDENCE_LIMIT);
  const evidenceRows =
    evidenceOffset === 0
      ? evidencePage.items
      : store.listEvidencePage(threadId, { limit: EVIDENCE_LIMIT, offset: evidenceOffset }).items;
  const latestSummary = store.latestThreadSummary(threadId);
  const notes = store.listAnnotations({ threadId, limit: ANNOTATION_LIMIT });
  const cursorRow = store.latestReaderSource(threadId);
  const cursor: Cursor | null =
    cursorRow === null
      ? null
      : {
          sourceUnitId: cursorRow.sourceId,
          contentPosition: cursorRow.consumedBytes,
          prefixHash: cursorRow.prefixHash,
          tailHash: cursorRow.tailHash,
          parserVersion: cursorRow.parserVersion,
        };
  const primaryTaskId = thread.primaryTaskId;
  const primaryTask = primaryTaskId === null ? null : store.getTask(primaryTaskId);
  const labels = primaryTask === null ? [] : [...primaryTask.labels].sort();
  const overlayNotes = notes
    .map((note) => ({ id: note.id, kind: note.kind, body: note.body }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const evidence = evidenceRows
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      turnOrdinal: row.turnOrdinal,
      excerpt: row.summary === null ? "" : redactExcerpt(row.summary, EXCERPT_CHARS),
      recordHash: row.recordHash,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    subject: {
      threadId,
      harnessId: identity.harnessId,
      nativeSessionId: identity.nativeSessionId ?? threadId,
      nativeStatus: thread.nativeStatus,
      title: thread.title,
      workspace: store.threadWorkspace(threadId),
    },
    cursor,
    turns: {
      total: turnPage.total,
      byStatus: sortedByStatus,
      latest:
        latest === null
          ? null
          : { ordinal: latest.ordinal, nativeStatus: String(latest.nativeStatus) },
    },
    evidence,
    summary:
      latestSummary === null || latestSummary.provenance === "none"
        ? null
        : {
            provenance: latestSummary.provenance,
            text: redactExcerpt(latestSummary.text, 900),
            coveredThroughTurnOrdinal: latestSummary.coveredThroughTurnOrdinal,
          },
    overlay: {
      primaryTaskId,
      taskTitle: primaryTask?.title ?? null,
      labels,
      notes: overlayNotes,
    },
    allowedEvidenceIds: evidence.map((item) => item.id),
  };
};

export const fingerprintInputOfJudgeInput = (input: JudgeInput): FingerprintInput => ({
  nativeStatus: input.subject.nativeStatus,
  title: input.subject.title,
  workspace: input.subject.workspace,
  cursor:
    input.cursor === null
      ? null
      : ([
          input.cursor.sourceUnitId,
          input.cursor.contentPosition,
          input.cursor.prefixHash,
          input.cursor.tailHash,
          input.cursor.parserVersion,
        ] as const),
  turnsTotal: input.turns.total,
  turnsByStatus: input.turns.byStatus,
  latestOrdinal: input.turns.latest?.ordinal ?? null,
  latestNativeStatus: input.turns.latest?.nativeStatus ?? null,
  evidence: input.evidence.map(
    (item) =>
      [item.id, item.kind, item.turnOrdinal, item.recordHash, sha256(item.excerpt)] as const,
  ),
  summary:
    input.summary === null
      ? null
      : ([
          input.summary.provenance,
          sha256(input.summary.text),
          input.summary.coveredThroughTurnOrdinal,
        ] as const),
  overlay: [
    input.overlay.primaryTaskId,
    input.overlay.taskTitle,
    input.overlay.labels,
    input.overlay.notes.map(
      (note) => [note.id, note.kind, sha256(note.body)] as const,
    ),
  ],
});
