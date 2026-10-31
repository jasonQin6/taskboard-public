/**
 * mark_done 证据门（需求「验收与 mark_done 证据门」；issue #34 / Commit 1 自 jev.ts 下沉的纯函数区）：
 * 确定性前置条件的静态判定，零 class 实例依赖。「单飞与幂等校验」在执行面成立——
 * 单飞走 thread 槽互斥，幂等走 requestId 环 + 提案 pending 一次性裁决，不在生成时判定。
 */

import type { ReaderTurnStatus } from "./store/index.js";
import { isCriticalRisk, type AcceptanceMode, type AutomationMode } from "./types.js";
import type { JevRisk } from "./jev-answer.js";

export interface MarkDoneGateConditions {
  acceptanceAgent: boolean;
  automationAuto: boolean;
  acceptanceCriteriaNonEmpty: boolean;
  latestTurnCompleted: boolean;
  noUnresolvedAnomalies: boolean;
  referencesAcceptanceEvidence: boolean;
  riskNotCritical: boolean;
}

export interface MarkDoneGateVerdict {
  eligible: boolean;
  conditions: MarkDoneGateConditions;
  failed: string[];
}

export interface MarkDoneGateInput {
  task: { acceptanceMode: AcceptanceMode; automationMode: AutomationMode; acceptanceCriteria: string };
  /** 主绑定 thread 最新 turn 的原生状态；null = reader 尚无 turn 记录。 */
  latestTurnStatus: ReaderTurnStatus | null;
  unresolvedAnomalies: number;
  risk: JevRisk;
  /** 提案引用的 id → 证据类（evidence kind，或 "annotation" = 人工标注）。 */
  evidenceRefKinds: Record<string, string>;
  refs: readonly string[];
}

/** 验收证据类：file change、tool 结果或人工标注（annotations 表即人工标注）。 */
const ACCEPTANCE_EVIDENCE_KINDS = new Set(["file_change", "tool", "annotation"]);

/**
 * 确定性前置的静态六条（风险条含在内）；「单飞与幂等校验」在执行面成立——
 * 单飞走 thread 槽互斥，幂等走 requestId 环 + 提案 pending 一次性裁决，不在生成时判定。
 */
export const evaluateMarkDoneGate = (input: MarkDoneGateInput): MarkDoneGateVerdict => {
  const conditions: MarkDoneGateConditions = {
    acceptanceAgent: input.task.acceptanceMode === "agent",
    automationAuto: input.task.automationMode === "auto",
    acceptanceCriteriaNonEmpty: input.task.acceptanceCriteria.trim().length > 0,
    latestTurnCompleted: input.latestTurnStatus === "completed",
    noUnresolvedAnomalies: input.unresolvedAnomalies === 0,
    referencesAcceptanceEvidence: input.refs.some((ref) => ACCEPTANCE_EVIDENCE_KINDS.has(input.evidenceRefKinds[ref] ?? "")),
    // riskNotCritical 取反自 types.ts 共享判定：critical 永不执行的不变量三面（决策/执行/证据门）同源
    riskNotCritical: !isCriticalRisk(input.risk),
  };
  const failed = (Object.keys(conditions) as Array<keyof MarkDoneGateConditions>).filter((key) => !conditions[key]);
  return { eligible: failed.length === 0, conditions, failed };
};
