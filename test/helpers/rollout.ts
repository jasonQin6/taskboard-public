/**
 * 固定 rollout fixture 构建器：按真机 rollout 的记录形状（session_meta / event_msg / response_item /
 * compacted / token_usage_record）构造确定性 JSONL，驱动真实 reader，不调真实 Codex。
 */

export interface UsageShape {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface SessionMetaOptions {
  sessionId: string;
  cwd?: string;
  threadSource?: string;
  parentThreadId?: string;
  subagentSpawn?: { parentThreadId: string; depth: number; nickname?: string; role?: string };
  source?: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();
export const T0 = Date.parse("2026-10-01T08:00:00.000Z");

let clock = T0;
export const resetClock = (ms = T0): void => {
  clock = ms;
};
export const tick = (ms = 1000): number => {
  clock += ms;
  return clock;
};

/** 组一条 rollout 记录；timestamp 自动推进，ordinal 显式传入以便构造缺口/回绕。 */
export const rec = (ordinal: number, type: string, payload: Record<string, unknown>, tsMs?: number): string =>
  JSON.stringify({ timestamp: iso(tsMs ?? tick()), ordinal, type, payload });

export const sessionMeta = (ordinal: number, options: SessionMetaOptions, tsMs?: number): string => {
  const payload: Record<string, unknown> = {
    session_id: options.sessionId,
    id: options.sessionId,
    timestamp: iso(tsMs ?? T0),
    cwd: options.cwd ?? "/tmp/ws",
    originator: "Codex Desktop",
    cli_version: "0.163.0",
    thread_source: options.threadSource ?? "user",
  };
  if (options.parentThreadId !== undefined) payload.parent_thread_id = options.parentThreadId;
  if (options.subagentSpawn !== undefined) {
    payload.source = {
      subagent: {
        thread_spawn: {
          parent_thread_id: options.subagentSpawn.parentThreadId,
          depth: options.subagentSpawn.depth,
          agent_path: null,
          agent_nickname: options.subagentSpawn.nickname ?? null,
          agent_role: options.subagentSpawn.role ?? "worker",
        },
      },
    };
  }
  return rec(ordinal, "session_meta", payload, tsMs ?? T0);
};

export const taskStarted = (
  ordinal: number,
  turnId: string,
  options: { subagent?: boolean; parentTurnId?: string } = {},
  tsMs?: number,
): string =>
  rec(
    ordinal,
    "event_msg",
    {
      type: "task_started",
      turn_id: turnId,
      root_turn_id: options.parentTurnId ?? turnId,
      turn_attribution: {
        turn_id: turnId,
        turn_trigger: "user",
        parent_turn_id: options.parentTurnId ?? null,
        initiating_agent_path: options.subagent === true ? "parent/worker" : null,
        root_turn_id: options.parentTurnId ?? turnId,
      },
      started_at: Math.floor((tsMs ?? T0) / 1000),
    },
    tsMs,
  );

export const taskComplete = (ordinal: number, turnId: string, tsMs?: number): string =>
  rec(ordinal, "event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: "done" }, tsMs);

export const turnAborted = (ordinal: number, turnId: string, tsMs?: number): string =>
  rec(ordinal, "event_msg", { type: "turn_aborted", turn_id: turnId, reason: "interrupted" }, tsMs);

export const errorEvent = (ordinal: number, turnId: string, message: string, tsMs?: number): string =>
  rec(ordinal, "event_msg", { type: "error", turn_id: turnId, message }, tsMs);

export interface ItemOptions {
  turnId: string;
  threadId?: string;
}

const itemCompleted = (ordinal: number, item: Record<string, unknown>, options: ItemOptions, tsMs?: number): string =>
  rec(
    ordinal,
    "event_msg",
    { type: "item_completed", thread_id: options.threadId ?? "th", turn_id: options.turnId, item },
    tsMs,
  );

export const userMessageItem = (
  ordinal: number,
  turnId: string,
  text: string,
  options: ItemOptions = { turnId },
  tsMs?: number,
): string =>
  itemCompleted(
    ordinal,
    { type: "UserMessage", id: `u_${ordinal}`, content: [{ type: "text", text }] },
    { ...options, turnId },
    tsMs,
  );

export const agentMessageItem = (
  ordinal: number,
  turnId: string,
  text: string,
  options: ItemOptions = { turnId },
  tsMs?: number,
): string =>
  itemCompleted(
    ordinal,
    { type: "AgentMessage", id: `a_${ordinal}`, content: [{ type: "Text", text }], phase: "final_answer" },
    { ...options, turnId },
    tsMs,
  );

export const reasoningItem = (
  ordinal: number,
  turnId: string,
  summaries: string[],
  options: ItemOptions = { turnId },
  tsMs?: number,
): string =>
  itemCompleted(
    ordinal,
    { type: "Reasoning", id: `rs_${ordinal}`, summary_text: summaries, raw_content: [] },
    { ...options, turnId },
    tsMs,
  );

export const commandExecutionItem = (
  ordinal: number,
  turnId: string,
  fields: {
    command?: string[];
    exitCode?: number;
    status?: string;
    durationSecs?: number;
    cwd?: string;
    aggregatedOutput?: string;
  },
  options: ItemOptions = { turnId },
  tsMs?: number,
): string =>
  itemCompleted(
    ordinal,
    {
      type: "CommandExecution",
      id: `exec_${ordinal}`,
      command: fields.command ?? ["/bin/zsh", "-lc", "ls"],
      cwd: fields.cwd ?? "file:///tmp/ws",
      status: fields.status ?? "completed",
      exit_code: fields.exitCode ?? 0,
      duration: { secs: fields.durationSecs ?? 1, nanos: 0 },
      ...(fields.aggregatedOutput !== undefined ? { aggregated_output: fields.aggregatedOutput } : {}),
    },
    { ...options, turnId },
    tsMs,
  );

export const fileChangeItem = (
  ordinal: number,
  turnId: string,
  changes: Record<string, { type: string }>,
  options: ItemOptions = { turnId },
  tsMs?: number,
): string =>
  itemCompleted(
    ordinal,
    { type: "FileChange", id: `fc_${ordinal}`, changes, status: "completed" },
    { ...options, turnId },
    tsMs,
  );

export const mcpToolCallItem = (
  ordinal: number,
  turnId: string,
  fields: { server: string; tool: string; status?: string },
  options: ItemOptions = { turnId },
  tsMs?: number,
): string =>
  itemCompleted(
    ordinal,
    { type: "McpToolCall", id: `mcp_${ordinal}`, server: fields.server, tool: fields.tool, status: fields.status ?? "completed" },
    { ...options, turnId },
    tsMs,
  );

export const opaqueItem = (ordinal: number, turnId: string, itemType: string, tsMs?: number): string =>
  itemCompleted(ordinal, { type: itemType, id: `op_${ordinal}` }, { turnId }, tsMs);

export const tokenUsageRecord = (ordinal: number, turnId: string, usage: UsageShape, tsMs?: number): string =>
  rec(
    ordinal,
    "token_usage_record",
    { thread_id: "th", turn_id: turnId, session_id: "th", usage, turn_token_usage: usage, thread_token_usage: usage },
    tsMs,
  );

export const compactedRecord = (ordinal: number, message: string, tsMs?: number): string =>
  rec(ordinal, "compacted", { message }, tsMs);

export const unknownRecordType = (ordinal: number, type: string, tsMs?: number): string =>
  rec(ordinal, type, { note: "future payload" }, tsMs);

/** response_item：模型上下文副本（developer/system 指令在这里），reader 不应入库。 */
export const developerMessageRecord = (ordinal: number, text: string, tsMs?: number): string =>
  rec(
    ordinal,
    "response_item",
    { type: "message", id: `msg_${ordinal}`, role: "developer", content: [{ type: "input_text", text }] },
    tsMs,
  );

export class RolloutFile {
  readonly lines: string[] = [];

  constructor(...initial: string[]) {
    this.lines.push(...initial);
  }

  add(...lines: string[]): this {
    this.lines.push(...lines);
    return this;
  }

  /** 丢掉末尾 count 行（截断/rollback 场景的基线）。 */
  dropLast(count: number): this {
    this.lines.length = Math.max(0, this.lines.length - count);
    return this;
  }

  text(): string {
    return `${this.lines.join("\n")}\n`;
  }

  /** 半行：最后一条记录被截断的尾部，模拟正在写入。 */
  textWithPartialLine(chars: number): string {
    const complete = `${this.lines.join("\n")}\n`;
    const partial = this.lines[this.lines.length - 1] ?? "";
    return `${complete}${partial.slice(0, chars)}`;
  }
}

export interface CodexHome {
  root: string;
  sessionsDir: string;
  archivedDir: string;
}

export const writeText = async (path: string, content: string): Promise<void> => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, content, "utf8");
};

export const writeZst = async (path: string, content: string): Promise<void> => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { zstdCompressSync } = await import("node:zlib");
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, zstdCompressSync(Buffer.from(content, "utf8")));
};
