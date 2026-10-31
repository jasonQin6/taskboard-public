/**
 * 假 Codex app-server：driver 单测的锁定协议契约（需求「Testing Decisions」）。
 *
 * 锁定内容（改动即破坏测试契约，需同步 src/driver/protocol.ts 与相关测试）：
 * - 传输：stdio 上的换行分隔 JSON-RPC 2.0。
 * - 协议版本：initialize 结果携带 protocolVersion="1.0"（FAKE_PROTOCOL_VERSION 可覆盖以测试版本失配）。
 *   真机 0.163.0 的 initialize 结果没有 protocolVersion（有 userAgent/codexHome/platform*），
 *   客户端对缺省版本按兼容处理——本字段是假服务器对「版本变化要明确处理」的可测形态。
 * - initialize 必须携带 capabilities.experimentalApi=true（experimental API opt-in），否则 -32600 拒绝。
 * - method 集合（其余一律 -32600 unknown variant）：
 *     thread/start, turn/start, turn/interrupt, thread/resume, thread/close
 *     thread/goal/enable, thread/goal/set, thread/goal/get,
 *     thread/goal/pause, thread/goal/resume, thread/goal/clear, thread/goal/status
 *     thread/sample —— 仅 FAKE_WITH_SAMPLE=1 时存在（镜像 codex main；本机 0.163.0 没有）
 *     FAKE_WITHOUT_GOAL=1 时整个 thread/goal/* 家族不存在（镜像本机 0.163.0 之外的老版本）
 *     __fake/stats  —— 测试专用内省（threads/activeTurns/cwds=thread/start 收到的 cwd、
 *     lastInputs=turn/start 收到的最新消息文本，供 A14 外发内容断言），不属于协议契约
 * - event 通知：method 固定 `event_msg`，params {threadId, msg:{type,...}}；
 *   type 词表与需求钉死的 turn 终态一致：task_started / task_complete / turn_aborted / error。
 * - 幂等：thread/start、turn/start 与 goal 写操作（enable/set/pause/resume/clear）携带
 *   idempotencyKey 时，同 key 请求回放首次结果、不再二次执行
 *   （turn 在飞期间的同 key 回放返回在飞 turnId，同样不重复执行）。
 * - 自驱审批：thread/start 的 approvalPolicy 必须 === "never" 且必须带 sandbox
 *   （A16 的契约面：假服务器拒绝任何非 never 的自驱 turn，taskboard 不存在批准路径）。
 * - turn 剧本按 prompt 标记：含 "[fail]" → error；含 "[approval]" → task_complete + stopReason="approval_needed"；
 *   含 "[hang]" → 30s 不出终态（模拟在飞悬挂，供打断/重启测试）；否则 task_complete。
 * - FAKE_TURN_DELAY_MS：turn 终态延迟（默认 25）。FAKE_TURN_REPLY_DELAY_MS：turn/start 应答延迟
 *   （turn 已受理、应答迟到——模拟 RPC 超时但服务端 turn 仍在飞）。
 * - FAKE_CREATE_DELAY_MS：thread/start 应答前的延迟毫秒（create 窗口内取消的竞态注入）。
 * - FAKE_INTERRUPT_LOSES_RACE=1：turn/interrupt 应答成功但不清在飞 turn——turn 稍后自然完成
 *   （取消后的迟到完成竞态注入）。
 * - goal 状态机（per-thread {text, status, budgetTokens}）：enable/set 必带 text（缺失 -32600），
 *   成功即 status="active"；pause → "paused"；resume → "active"；clear → 删除；get/status 只读。
 *   goal 写操作落在不存在的 thread → -32001；对无 goal 的线程 pause/resume/clear → -32005。
 * - goal 续跑剧本：enable/set/resume 成功后若线程空闲，触发一次 goal turn
 *   （task_started → FAKE_GOAL_TURN_MS 后 task_complete），期间线程忙（turn/start -32002、
 *   thread/sample -32002）；goal 文本含 "[budget]" → 该 turn 终态时 status 转 "budget_limited"。
 * - thread/close：{threadId} → 取消在飞 turn/goal turn（turn 在飞则补 turn_aborted）并释放，不删线程记录
 *   （镜像「close = 释放写锁」，close 后 resume 仍可重新接管）。
 * - thread/sample 契约：{threadId, expectedTurnId, prompt} 全必填（缺失 -32600）；prompt > 4000 字节
 *   → -32600；expectedTurnId 含 "[mismatch]" → -32004（expected_turn_id 与最新完成 turn 不一致）。
 * - FAKE_HELD_THREAD：<threadId> → thread/resume 对它返回 -32003（外部持有写锁）。
 * - FAKE_KNOWN_THREADS：逗号分隔的预置 threadId（模拟「外部创建但可被我们接管」的线程，resume 成功）。
 * - FAKE_SAMPLE_DELAY_MS：thread/sample 应答前的延迟毫秒（驱动请求超时→超时失败分类）。
 * - FAKE_EXIT_ON_SAMPLE=1：thread/sample 收到即退出进程（在飞请求→断连失败分类）。
 * - FAKE_JEV_ANSWER：thread/sample 应答文本替换（Jev 结构化答案/非法输出的脚本注入；Jev 与摘要
 *   共用 thread/sample 通道，Jev 用例的 daemon 内不会触发摘要采样）。
 * - FAKE_CRASH_ACTIVE_TURN_MS：turn 开始后 N ms 整个进程 exit(1)（崩溃注入）。
 * - FAKE_IGNORE_METHODS：逗号分隔的 method 清单——收到即吞掉不应答（驱动探测/请求超时）。
 * - FAKE_EXIT_AFTER_INIT=1：initialize 应答刷盘后立即 exit(0)（启动期子进程退出注入）。
 * - FAKE_SERVER_REQUEST=1：thread/start 应答前先以同一 id 发一条服务端主动请求
 *   （id 撞客户端 pending：应答判定错就会拿它 resolve 在飞请求）。
 * - FAKE_STDOUT_FLOOD_BYTES=N：initialize 应答后写 N 字节无换行巨行（stdout 行缓冲上限注入）。
 * - FAKE_BUSY_MESSAGE：turn/start 忙拒绝的 message 文案覆盖（码仍 -32002；锁定「按码判定」）。
 * - 错误码：-32600 无效请求/缺字段；-32001 thread 不存在；-32002 thread 忙；-32003 写锁 Conflict；
 *   -32004 expected_turn_id 失配；-32005 无 goal 可操作。
 */
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// 测试内省：把子进程实际收到的环境写到指定文件（用于凭据隔离断言）
if (process.env.FAKE_ENV_CAPTURE) {
  writeFileSync(process.env.FAKE_ENV_CAPTURE, JSON.stringify(process.env, null, 2));
}

const PROTOCOL_VERSION = process.env.FAKE_PROTOCOL_VERSION ?? "1.0";
const TURN_DELAY_MS = Number(process.env.FAKE_TURN_DELAY_MS ?? "25");
const GOAL_TURN_DELAY_MS = Number(process.env.FAKE_GOAL_TURN_MS ?? "25");
const HELD_THREAD = process.env.FAKE_HELD_THREAD ?? null;
const WITH_SAMPLE = process.env.FAKE_WITH_SAMPLE === "1";
const WITH_GOAL = process.env.FAKE_WITHOUT_GOAL !== "1";
const KNOWN_THREADS = (process.env.FAKE_KNOWN_THREADS ?? "").split(",").map((id) => id.trim()).filter((id) => id.length > 0);
const CRASH_AFTER_TURN_START_MS = Number(process.env.FAKE_CRASH_ACTIVE_TURN_MS ?? "0");
const SAMPLE_DELAY_MS = Number(process.env.FAKE_SAMPLE_DELAY_MS ?? "0");
const EXIT_ON_SAMPLE = process.env.FAKE_EXIT_ON_SAMPLE === "1";
const JEV_ANSWER = process.env.FAKE_JEV_ANSWER ?? null;
const IGNORE_METHODS = new Set(
  (process.env.FAKE_IGNORE_METHODS ?? "").split(",").map((m) => m.trim()).filter((m) => m.length > 0),
);
const EXIT_AFTER_INIT = process.env.FAKE_EXIT_AFTER_INIT === "1";
const SERVER_REQUEST_ON_START = process.env.FAKE_SERVER_REQUEST === "1";
const STDOUT_FLOOD_BYTES = Number(process.env.FAKE_STDOUT_FLOOD_BYTES ?? "0");
const BUSY_MESSAGE = process.env.FAKE_BUSY_MESSAGE ?? "already has an active turn";
const TURN_REPLY_DELAY_MS = Number(process.env.FAKE_TURN_REPLY_DELAY_MS ?? "0");
let turnReplyDelayLeft = TURN_REPLY_DELAY_MS; // 一次性：只延迟首个 turn/start 的应答
// thread/start 应答前的延迟毫秒（create 窗口竞态：窗口内取消不得落绑定/默认策略副作用）
const CREATE_DELAY_MS = Number(process.env.FAKE_CREATE_DELAY_MS ?? "0");
// turn/interrupt 应答成功但不清在飞 turn（打断输给自然完成的竞态：取消后的迟到完成不得驱动级联）
const INTERRUPT_LOSES_RACE = process.env.FAKE_INTERRUPT_LOSES_RACE === "1";

const METHODS = [
  "thread/start",
  "turn/start",
  "turn/interrupt",
  "thread/resume",
  "thread/close",
  ...(WITH_GOAL
    ? [
        "thread/goal/enable",
        "thread/goal/set",
        "thread/goal/get",
        "thread/goal/pause",
        "thread/goal/resume",
        "thread/goal/clear",
        "thread/goal/status",
      ]
    : []),
];

const unknownVariant = (method) =>
  `Invalid request: unknown variant \`${method}\`, expected one of ${METHODS.map((m) => `\`${m}\``).join(", ")}`;

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const notify = (threadId, msg) => send({ method: "event_msg", params: { threadId, msg } });

const threads = new Map(); // id -> { id, cwd, turnId, timer, goal, goalTimer }
const idempotent = new Map(); // idempotencyKey -> result（只缓存成功执行）
const lastInputs = {}; // threadId -> turn/start 最新消息文本（测试内省）
let threadSeq = 0;
let turnSeq = 0;
let goalTurnSeq = 0;

for (const id of KNOWN_THREADS) threads.set(id, { id, cwd: null, turnId: null, timer: null, goal: null, goalTimer: null });

const terminalOutcome = (text) => {
  if (text.includes("[fail]")) return { type: "error", message: "boom: scripted turn failure" };
  if (text.includes("[approval]")) return { type: "task_complete", stopReason: "approval_needed" };
  return { type: "task_complete" };
};

const goalView = (thread) =>
  thread.goal === null
    ? null
    : {
        text: thread.goal.text,
        status: thread.goal.status,
        ...(thread.goal.budgetTokens === null ? {} : { budgetTokens: thread.goal.budgetTokens }),
      };

/** goal 续跑 turn：占用线程的 turn 位（期间线程忙），到点发 task_complete；[budget] 文本把 goal 推到 budget_limited。 */
const startGoalTurn = (thread, text) => {
  if (thread.turnId !== null) return; // 真实 turn 在飞：续跑不并发（真实 codex 同样受单 turn 约束）
  thread.turnId = `goalt-${goalTurnSeq++}`;
  notify(thread.id, { type: "task_started" });
  thread.goalTimer = setTimeout(() => {
    thread.goalTimer = null;
    thread.turnId = null;
    if (thread.goal !== null && thread.goal.status === "active" && text.includes("[budget]")) {
      thread.goal.status = "budget_limited";
    }
    notify(thread.id, { type: "task_complete" });
  }, GOAL_TURN_DELAY_MS);
  thread.goalTimer.unref?.();
};

const GOAL_WRITE_OPS = new Set(["enable", "set", "pause", "resume", "clear"]);

const handleGoal = ({ id, method, params = {} }) => {
  const op = method.slice("thread/goal/".length);
  if (typeof params.threadId !== "string") return fail(id, -32600, "Invalid request: missing field `threadId`");
  const thread = threads.get(params.threadId);
  if (thread === undefined) return fail(id, -32001, `thread not found: ${params.threadId}`);
  if (op === "get") return reply(id, { threadId: thread.id, goal: goalView(thread) });
  if (op === "status") return reply(id, { threadId: thread.id, status: thread.goal === null ? null : thread.goal.status });
  if (GOAL_WRITE_OPS.has(op) && params.idempotencyKey !== undefined && idempotent.has(params.idempotencyKey)) {
    reply(id, idempotent.get(params.idempotencyKey)); // 已完成的同 key 写操作：回放缓存结果，不二次执行
    return;
  }
  if (op === "enable" || op === "set") {
    if (typeof params.text !== "string" || params.text.length === 0) {
      return fail(id, -32600, "Invalid request: missing field `text`");
    }
    thread.goal = {
      text: params.text,
      status: "active",
      budgetTokens: typeof params.budgetTokens === "number" ? params.budgetTokens : null,
    };
    const result = { threadId: thread.id, goal: goalView(thread) };
    if (params.idempotencyKey !== undefined) idempotent.set(params.idempotencyKey, result);
    startGoalTurn(thread, params.text);
    reply(id, result);
    return;
  }
  if (thread.goal === null) {
    return fail(id, -32005, `thread ${thread.id} has no goal to ${op}`);
  }
  if (op === "pause") thread.goal.status = "paused";
  if (op === "resume") {
    thread.goal.status = "active";
    startGoalTurn(thread, thread.goal.text);
  }
  if (op === "clear") thread.goal = null;
  const result = { threadId: thread.id, goal: goalView(thread) };
  if (params.idempotencyKey !== undefined) idempotent.set(params.idempotencyKey, result);
  reply(id, result);
};

const handle = async ({ id, method, params = {} }) => {
  if (id === undefined || id === null) return; // 本契约为：通知不回包
  if (method.startsWith("thread/goal/")) {
    if (!WITH_GOAL) return fail(id, -32600, unknownVariant(method));
    return handleGoal({ id, method, params });
  }
  switch (method) {
    case "initialize": {
      if (params?.capabilities?.experimentalApi !== true) {
        fail(id, -32600, "experimental api opt-in required: initialize must carry capabilities.experimentalApi=true");
        return;
      }
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        userAgent: `fake-codex/${PROTOCOL_VERSION} (test contract)`,
        codexHome: process.env.FAKE_CODEX_HOME ?? "/tmp/fake-codex-home",
        platformFamily: "test",
        platformOs: "test",
      });
      if (STDOUT_FLOOD_BYTES > 0) {
        process.stdout.write("x".repeat(STDOUT_FLOOD_BYTES)); // 无换行巨行：永不成为完整记录
      }
      if (EXIT_AFTER_INIT) {
        // 等应答刷盘再退出，否则退出可能吞掉应答行（注入点要求「启动期退出」而非「应答丢失」）
        process.stdout.write("", () => process.exit(0));
      }
      return;
    }
    case "thread/start": {
      if (SERVER_REQUEST_ON_START) {
        // 服务端主动请求（id+method+params 无 result/error）：客户端必须显式拒绝而不是当应答消费
        send({ jsonrpc: "2.0", id, method: "__fake/serverpush", params: { note: "server-initiated" } });
      }
      if (params.approvalPolicy !== "never") {
        fail(id, -32600, "self-driven turns require approvalPolicy=never (no approval path in taskboard)");
        return;
      }
      if (typeof params.sandbox !== "string" || params.sandbox.length === 0) {
        fail(id, -32600, "self-driven turns require a sandbox");
        return;
      }
      if (params.idempotencyKey !== undefined && idempotent.has(params.idempotencyKey)) {
        reply(id, idempotent.get(params.idempotencyKey));
        return;
      }
      if (CREATE_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, CREATE_DELAY_MS));
      }
      const threadId = `fake-${threadSeq++}`;
      threads.set(threadId, { id: threadId, cwd: params.cwd ?? null, turnId: null, timer: null, goal: null, goalTimer: null });
      const result = { threadId };
      if (params.idempotencyKey !== undefined) idempotent.set(params.idempotencyKey, result);
      reply(id, result);
      return;
    }
    case "turn/start": {
      if (typeof params.threadId !== "string") return fail(id, -32600, "Invalid request: missing field `threadId`");
      if (!Array.isArray(params.input)) return fail(id, -32600, "Invalid request: missing field `input`");
      const thread = threads.get(params.threadId);
      if (thread === undefined) return fail(id, -32001, `thread not found: ${params.threadId}`);
      if (params.idempotencyKey !== undefined && idempotent.has(params.idempotencyKey)) {
        reply(id, idempotent.get(params.idempotencyKey)); // 已完成的同 key 请求：回放缓存结果，不再执行
        return;
      }
      if (thread.turnId !== null) return fail(id, -32002, `thread ${params.threadId} ${BUSY_MESSAGE}`);
      const text = Array.isArray(params.input)
        ? params.input.map((item) => (item?.type === "text" ? String(item.text ?? "") : "")).join("")
        : "";
      const turnId = `turn-${turnSeq++}`;
      thread.turnId = turnId;
      lastInputs[params.threadId] = text;
      if (params.idempotencyKey !== undefined) idempotent.set(params.idempotencyKey, { turnId });
      notify(params.threadId, { type: "task_started" });
      thread.timer = setTimeout(() => {
        thread.turnId = null;
        notify(params.threadId, terminalOutcome(text));
      }, text.includes("[hang]") ? 30_000 : TURN_DELAY_MS);
      if (CRASH_AFTER_TURN_START_MS > 0) {
        setTimeout(() => process.exit(1), CRASH_AFTER_TURN_START_MS).unref?.();
      }
      // 应答延迟但 turn 已受理：模拟「RPC 超时但服务端 turn 仍在飞」的真实形态
      if (turnReplyDelayLeft > 0) {
        const delay = turnReplyDelayLeft;
        turnReplyDelayLeft = 0;
        setTimeout(() => reply(id, { turnId }), delay).unref?.();
        return;
      }
      thread.timer.unref?.();
      reply(id, { turnId });
      return;
    }
    case "turn/interrupt": {
      if (typeof params.threadId !== "string") return fail(id, -32600, "Invalid request: missing field `threadId`");
      const thread = threads.get(params.threadId);
      if (thread === undefined) return fail(id, -32001, `thread not found: ${params.threadId}`);
      if (thread.turnId === null) return reply(id, { interrupted: false });
      if (INTERRUPT_LOSES_RACE) {
        // 应答成功但不真正打断：turn 稍后自然完成（迟到完成的竞态面）
        reply(id, { interrupted: true });
        return;
      }
      clearTimeout(thread.timer);
      thread.turnId = null;
      notify(params.threadId, { type: "turn_aborted" });
      reply(id, { interrupted: true });
      return;
    }
    case "thread/resume": {
      if (typeof params.threadId !== "string") return fail(id, -32600, "Invalid request: missing field `threadId`");
      if (HELD_THREAD !== null && params.threadId === HELD_THREAD) {
        return fail(id, -32003, "thread writer lock held by another process");
      }
      if (!threads.has(params.threadId)) return fail(id, -32001, `thread not found: ${params.threadId}`);
      reply(id, { threadId: params.threadId, resumed: true });
      return;
    }
    case "thread/close": {
      if (typeof params.threadId !== "string") return fail(id, -32600, "Invalid request: missing field `threadId`");
      const thread = threads.get(params.threadId);
      if (thread === undefined) return fail(id, -32001, `thread not found: ${params.threadId}`);
      // close = 释放写锁：取消在飞计时；turn 在飞则按 interrupted 收口（不静默吞掉终态等待方）
      if (thread.goalTimer !== null) {
        clearTimeout(thread.goalTimer);
        thread.goalTimer = null;
      }
      if (thread.turnId !== null) {
        clearTimeout(thread.timer);
        thread.turnId = null;
        notify(thread.id, { type: "turn_aborted" });
      }
      reply(id, { threadId: thread.id, closed: true });
      return;
    }
    case "thread/sample": {
      if (!WITH_SAMPLE) return fail(id, -32600, unknownVariant(method));
      if (typeof params.threadId !== "string") return fail(id, -32600, "Invalid request: missing field `threadId`");
      if (typeof params.expectedTurnId !== "string") return fail(id, -32600, "Invalid request: missing field `expectedTurnId`");
      if (typeof params.prompt !== "string") return fail(id, -32600, "Invalid request: missing field `prompt`");
      if (Buffer.byteLength(params.prompt, "utf8") > 4000) {
        return fail(id, -32600, "Invalid request: prompt exceeds 4000 bytes");
      }
      const thread = threads.get(params.threadId);
      if (thread === undefined) return fail(id, -32001, `thread not found: ${params.threadId}`);
      if (thread.turnId !== null) return fail(id, -32002, `thread ${params.threadId} is not idle`);
      if (params.expectedTurnId.includes("[mismatch]")) {
        return fail(id, -32004, "expected_turn_id does not match the latest completed turn");
      }
      // FAKE_EXIT_ON_SAMPLE：采样即退出（连接错误/断连分类测试）；FAKE_SAMPLE_DELAY_MS：慢于驱动请求超时
      if (EXIT_ON_SAMPLE) process.exit(0);
      if (SAMPLE_DELAY_MS > 0) {
        setTimeout(() => reply(id, { text: JEV_ANSWER ?? `fake sample of ${params.threadId} at ${params.expectedTurnId}` }), SAMPLE_DELAY_MS);
        return;
      }
      reply(id, { text: JEV_ANSWER ?? `fake sample of ${params.threadId} at ${params.expectedTurnId}` });
      return;
    }
    case "__fake/stats": {
      const activeTurns = [...threads.values()].filter((thread) => thread.turnId !== null).length;
      // cwds：thread/start 收到的 cwd（isolated worktree 测试断言 harness 拿到的目录用）
      const cwds = {};
      for (const thread of threads.values()) {
        if (thread.cwd !== null) cwds[thread.id] = thread.cwd;
      }
      reply(id, { threads: threads.size, activeTurns, cwds, lastInputs });
      return;
    }
    default:
      fail(id, -32600, unknownVariant(method));
  }
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return; // 半截行丢弃
  }
  if (req.method === undefined) return; // 客户端对我们服务端主动请求的应答：不当作请求
  if (IGNORE_METHODS.has(req.method)) return; // 吞掉不应答：驱动传输层超时
  try {
    handle(req);
  } catch (error) {
    if (req.id !== undefined && req.id !== null) fail(req.id, -32703, `internal error: ${error?.message ?? String(error)}`);
  }
});

// stdin 结束后留出在飞 turn 的收尾窗口；正常关闭走 SIGTERM/SIGKILL，不依赖这里
rl.on("close", () => {
  setTimeout(() => process.exit(0), TURN_DELAY_MS + 200).unref();
});
