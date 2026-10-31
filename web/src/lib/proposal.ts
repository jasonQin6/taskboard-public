/** 提案（Proposal）客户端形状：对 state/proposals 载荷只读消费，未知字段原样保留。 */

export interface JevCandidate {
  action: string;
  reasonShort: string;
  risk: string;
  evidenceRefs: string[];
  [key: string]: unknown;
}

export interface JevAnswerPayload {
  needsAttention: boolean;
  progress: string;
  summaryShort: string;
  candidates: JevCandidate[];
  recommended: string;
  confidence: number;
  [key: string]: unknown;
}

export interface ClientProposal {
  id: string;
  threadId: string | null;
  taskId: string | null;
  status: "pending" | "accepted" | "rejected" | "expired";
  evidenceFingerprint: string;
  payload: {
    /** ok=false 是失败提案（Jev 输出非法/调用失败），只有审计意义，不可执行。 */
    ok?: boolean;
    answer?: JevAnswerPayload;
    error?: { kind: string; message: string };
    /** accept 落库的执行结果（动作执行链展示）。 */
    executionResult?: Record<string, unknown>;
    [key: string]: unknown;
  };
  decidedAt: string | null;
  createdAt: string;
  [key: string]: unknown;
}

export const isPending = (proposal: ClientProposal): boolean => proposal.status === "pending";

/** 提案展示排序：pending 在前，其余按创建时间倒序（最新判断先看）。 */
export const orderProposals = (proposals: ClientProposal[]): ClientProposal[] =>
  [...proposals].sort((a, b) => {
    if (isPending(a) !== isPending(b)) return isPending(a) ? -1 : 1;
    if (a.createdAt === b.createdAt) return 0;
    return a.createdAt < b.createdAt ? 1 : -1;
  });
