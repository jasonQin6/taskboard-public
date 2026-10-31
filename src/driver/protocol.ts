/**
 * Codex app-server 线上协议常量。事实源：
 * - 真机 0.163.0 探针（2026-10-22）：initialize 结果为 {userAgent, codexHome, platformFamily, platformOs}
 *   （无 protocolVersion 字段）；未知 method 返回 -32600 "unknown variant … expected one of …"，
 *   已知 method 缺参数返回 -32600 "missing field …"——这是无副作用的 method 存在性探测依据。
 * - 写 method：thread/start（建线程）、turn/start（发消息，需 threadId+input）、
 *   turn/interrupt（取消）、thread/resume（接管写锁）、thread/close（释放写锁）、
 *   thread/goal/*（原生 goal：enable/set/get/pause/resume/clear/status）、
 *   thread/sample（experimental 采样：threadId+expectedTurnId+prompt≤4000B，返回纯 text）。
 *   experimental API 需 initialize 携带 capabilities.experimentalApi=true
 *   （docs/research/2026-10-21-codex-app-server-runtime-facts.md）。
 * 测试契约在 test/fake-app-server.mjs 头注锁定；两侧必须同步演化。
 */

export const M_INITIALIZE = "initialize";
export const M_THREAD_START = "thread/start";
export const M_TURN_START = "turn/start";
export const M_TURN_INTERRUPT = "turn/interrupt";
export const M_THREAD_RESUME = "thread/resume";
export const M_THREAD_CLOSE = "thread/close";
export const M_THREAD_SAMPLE = "thread/sample";

/** 原生 goal 的 driver 级操作词表（用户故事 62：七操作全部映射到 thread/goal/*）。 */
export const GOAL_OPS = ["enable", "set", "get", "pause", "resume", "clear", "status"] as const;
export type GoalOpName = (typeof GOAL_OPS)[number];

export const goalMethod = (op: GoalOpName): string => `thread/goal/${op}`;

/** thread/sample 的线上约束（runtime facts：prompt ≤ 4000 字节，返回纯 text）。 */
export const SAMPLE_MAX_PROMPT_BYTES = 4000;

/** 采样请求的固定模板：纯摘要指令，不带 taskboard 数据出站（证据持久化边界）。 */
export const SAMPLE_PROMPT =
  "Summarize the progress of this session in a few sentences: what was attempted, " +
  "what succeeded, and what remains. Reply with the summary text only.";

/** 客户端支持的协议大版本；initialize 结果带 protocolVersion 时按大版本校验，缺省视为兼容。 */
export const SUPPORTED_PROTOCOL_MAJOR = 1;

/**
 * 事件通知 method 与 turn 终态词表。终局判定只认 event_msg 原生终态（不变量）：
 * task_complete=成功终局、turn_aborted=interrupted（非 failed）、error=failed。
 */
export const EVENT_MSG_METHOD = "event_msg";
export type EventMsgType = "task_started" | "task_complete" | "turn_aborted" | "error";

/** 自驱 turn 的固定审批策略与沙箱（需求「Codex 调度与原生能力」）。 */
export const SELF_DRIVEN_APPROVAL_POLICY = "never";
export const SELF_DRIVEN_SANDBOX = "workspace-write";

export interface TurnTerminal {
  kind: "completed" | "failed" | "interrupted";
  /** Codex 停下原因；"approval_needed" 表示遇需审批动作停下（归 waiting_user/needs_attention）。 */
  stopReason: string | null;
  /** error 事件的人话消息；其他终态为 null。 */
  message: string | null;
}

/** 事件 → 终态映射；task_started 只表进行中，不是终态。未知类型返回 null（不作终局）。 */
export const terminalOfEventMsg = (type: string, msg: Record<string, unknown>): TurnTerminal | null => {
  switch (type) {
    case "task_complete":
      return {
        kind: "completed",
        stopReason: typeof msg.stopReason === "string" ? msg.stopReason : null,
        message: null,
      };
    case "turn_aborted":
      return { kind: "interrupted", stopReason: null, message: null };
    case "error":
      return { kind: "failed", stopReason: null, message: typeof msg.message === "string" ? msg.message : "turn failed" };
    default:
      return null;
  }
};

/**
 * 能力探测清单：只探测空参数下必然停在参数校验的 method（无副作用）。
 * 核心写 method（thread/start、turn/start）不探测——缺了在首次使用时报错即可；
 * goal 写 method 空参只可能停在缺 threadId 校验，thread/close 空参同理，均无副作用。
 */
export const PROBED_METHODS: readonly string[] = [
  M_THREAD_RESUME,
  M_TURN_INTERRUPT,
  M_THREAD_CLOSE,
  ...GOAL_OPS.map(goalMethod),
  M_THREAD_SAMPLE,
];

/** app-server 服务端错误码（-32000..-32099 为 JSON-RPC 保留的服务端自定义段）。 */
export const SERVER_ERROR_THREAD_NOT_FOUND = -32001;
export const SERVER_ERROR_THREAD_BUSY = -32002;
export const SERVER_ERROR_CONFLICT = -32003;
export const SERVER_ERROR_TURN_MISMATCH = -32004;
export const SERVER_ERROR_NO_GOAL = -32005;
export const ERROR_UNKNOWN_VARIANT = -32600;

export const isUnknownVariantError = (code: number, message: string): boolean =>
  code === ERROR_UNKNOWN_VARIANT && message.includes("unknown variant");

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  id: number;
  result: unknown;
}

export interface JsonRpcError {
  id: number;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// 只认带 result/error 且不带 method 的消息为应答：服务端主动请求（id+method+params）若被
// 当成应答，其 id 与客户端小整数 id 撞上时会以 undefined 结果静默resolve 在飞请求
export const isJsonRpcResponse = (value: unknown): value is JsonRpcResponse =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  ("result" in value || "error" in value) &&
  !("method" in value);

export interface EventMsgNotification {
  threadId: string;
  msg: { type: string } & Record<string, unknown>;
}

/** thread/goal/* 应答的归一化视图；status 是 Codex 的原生词（active/paused/complete/budget_limited…），taskboard 只当证据缓存。 */
export interface GoalView {
  threadId: string;
  status: string | null;
  text: string | null;
  budgetTokens: number | null;
}

/** 归一化两种应答形态：{goal: {...}|null}（enable/set/get/pause/resume/clear）与 {status}（status）。 */
export const goalViewOf = (threadId: string, result: unknown): GoalView => {
  const record = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const goal = (typeof record.goal === "object" && record.goal !== null ? record.goal : null) as Record<string, unknown> | null;
  const status =
    typeof record.status === "string"
      ? record.status
      : goal !== null && typeof goal.status === "string"
        ? goal.status
        : null;
  const text = goal !== null && typeof goal.text === "string" ? goal.text : null;
  const budgetTokens = goal !== null && typeof goal.budgetTokens === "number" ? goal.budgetTokens : null;
  return { threadId, status, text, budgetTokens };
};

export const asEventMsgNotification = (params: unknown): EventMsgNotification | null => {
  if (typeof params !== "object" || params === null) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.threadId !== "string" || typeof record.msg !== "object" || record.msg === null) return null;
  const msg = record.msg as { type?: unknown };
  if (typeof msg.type !== "string") return null;
  return { threadId: record.threadId, msg: record.msg as EventMsgNotification["msg"] };
};
