/**
 * 领域措辞统一出口（GLOSSARY 定名）：原生/语义状态、摘要 provenance、风险、Jev 候选动作。
 * 未知值原样回显（契约字段只增不删，消费方容忍未知）。
 */

export const NATIVE_STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  idle: "空闲",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  held: "写锁被持有",
  unknown: "未知",
};

export const SEMANTIC_STATUS_LABELS: Record<string, string> = {
  progressing: "进行中",
  waiting_user: "等待用户",
  blocked: "阻塞",
  complete: "已完成",
  needs_attention: "需要关注",
  unknown: "未知",
};

export const PROVENANCE_LABELS: Record<string, string> = {
  none: "无摘要",
  compacted: "摘要:compacted",
  sample: "摘要:sample",
};

export const RISK_LABELS: Record<string, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "严重风险",
};

export const JEV_ACTION_LABELS: Record<string, string> = {
  continue_thread: "继续线程",
  retry_run: "重试运行",
  create_child_task: "创建子任务",
  annotate: "标注",
  ask_user: "询问用户",
  mark_blocked: "标记阻塞",
  mark_done: "标记完成",
  no_op: "无需动作",
};

export const labelOf = (labels: Record<string, string>, value: string | null | undefined): string =>
  value !== null && value !== undefined && labels[value] !== undefined ? labels[value] : (value ?? "—");
