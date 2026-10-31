/**
 * 真实 Magpie schema 不在仓库内，所有形状假设钉在这里的 loopback fake 上；
 * MagpieProvider 走真 fetch，断言只看可观察行为，不直调内部组装/解析函数。不访问环回之外的地址。
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { SystemOneProviderError } from "../src/systemone/errors.js";
import { MagpieProvider } from "../src/systemone/magpie.js";
import type { JudgeInput } from "../src/systemone/provider.js";
import type { Settings } from "../src/types.js";
import { DEFAULT_SETTINGS } from "../src/store/index.js";

const tmpServers: Server[] = [];
afterEach(async () => {
  while (tmpServers.length > 0) {
    const server = tmpServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const baseInput = (): JudgeInput => ({
  subject: {
    threadId: "th_wire",
    harnessId: "codex",
    nativeSessionId: "th_wire",
    nativeStatus: "running",
    title: "修复登录页",
    workspace: "/tmp/ws",
  },
  cursor: null,
  turns: { total: 2, byStatus: { completed: 1, running: 1 }, latest: { ordinal: 1, nativeStatus: "running" } },
  evidence: [
    { id: "ev_1", kind: "message", turnOrdinal: 0, excerpt: "实现登录表单", recordHash: "h1" },
    { id: "ev_2", kind: "tool", turnOrdinal: 1, excerpt: "pnpm test 通过", recordHash: "h2" },
  ],
  summary: null,
  overlay: { primaryTaskId: null, taskTitle: null, labels: [], notes: [] },
  allowedEvidenceIds: ["ev_1", "ev_2"],
});

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

const providerFor = (env: NodeJS.ProcessEnv, patch: Partial<Settings> = {}): MagpieProvider =>
  new MagpieProvider({ env, settings: () => settings(patch) });

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

type FakeOutcome = { status: number; body?: unknown; raw?: string; headers?: Record<string, string> } | "hang";

const startFakeGateway = async (
  handler: (request: CapturedRequest) => FakeOutcome,
): Promise<{ url: string; requests: CapturedRequest[] }> => {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const captured: CapturedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: (JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") ?? {}) as Record<string, unknown>,
      };
      requests.push(captured);
      const outcome = handler(captured);
      if (outcome === "hang") return;
      res.writeHead(outcome.status, { "content-type": "application/json", ...outcome.headers });
      res.end(outcome.raw ?? JSON.stringify(outcome.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  tmpServers.push(server);
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}/v1/systemone`, requests };
};

const rejectOf = async (pending: Promise<unknown>): Promise<SystemOneProviderError> => {
  try {
    await pending;
  } catch (error) {
    assert.ok(error instanceof SystemOneProviderError, `expected SystemOneProviderError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the judge call to reject");
};

const goodAnswer = {
  answers: {
    progress_status: {
      choice: "progressing",
      confidence: 0.86,
      usage: { input_tokens: 120, output_tokens: 18 },
    },
  },
};

test("wire: POST 端点路径、body 形状、Bearer 来自 env、成功响应映射为判定", async () => {
  const gateway = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok-wire" });
  const result = await provider.judge(baseInput(), new AbortController().signal);
  assert.equal(result.status, "progressing");
  assert.equal(result.confidence, 0.86);
  assert.deepEqual(result.evidenceRefs, [], "响应未给 refs 时空数组，不伪造");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 18 });
  assert.equal(result.provider, "magpie");
  assert.equal(result.model, "typesafe/jev-latest");
  const request = gateway.requests[0]!;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v1/systemone");
  assert.equal(request.authorization, "Bearer tok-wire");
  assert.equal(request.contentType, "application/json");
  assert.deepEqual(Object.keys(request.body).sort(), ["model", "questions", "state"]);
  const state = request.body.state as string;
  assert.ok(state.includes("codex/th_wire"));
  assert.ok(state.includes("native_status: running"));
  assert.ok(state.includes("ev_2"));
  assert.ok(!state.includes("tok-wire"));
  const questions = request.body.questions as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(questions), ["progress_status"]);
  assert.deepEqual(Object.keys(questions.progress_status!).sort(), ["criteria", "instructions", "type"]);
  assert.equal(questions.progress_status!.type, "choice");
  const criteria = questions.progress_status!.criteria as Record<string, string>;
  assert.deepEqual(Object.keys(criteria), [
    "progressing",
    "waiting_user",
    "blocked",
    "complete",
    "needs_attention",
    "unknown",
  ]);
  assert.equal(typeof criteria.progressing, "string");
});

test("wire: settings 覆盖模型与令牌 env 名；MAGPIE_SYSTEMONE_URL 是端点回退", async () => {
  const gateway = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const provider = providerFor(
    { MAGPIE_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok-plain", MAGPIE_GATE_KEY: "tok-named" },
    { systemoneModel: "custom/model", systemoneTokenEnv: "MAGPIE_GATE_KEY" },
  );
  const result = await provider.judge(baseInput(), new AbortController().signal);
  assert.equal(result.model, "custom/model");
  assert.equal(gateway.requests[0]!.authorization, "Bearer tok-named");
  assert.equal(gateway.requests[0]!.body.model, "custom/model");
});

test("wire: 端点 env 链 TASKBOARD_SYSTEMONE_URL 优先于 MAGPIE_SYSTEMONE_URL", async () => {
  const primary = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const secondary = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const provider = providerFor({
    TASKBOARD_SYSTEMONE_URL: primary.url,
    MAGPIE_SYSTEMONE_URL: secondary.url,
    TASKBOARD_SYSTEMONE_TOKEN: "tok",
  });
  await provider.judge(baseInput(), new AbortController().signal);
  assert.equal(primary.requests.length, 1);
  assert.equal(secondary.requests.length, 0);
});

test("wire: 缺令牌时 available 给 missing_token_env 与首选 env 名，judge 拒发请求", async () => {
  const gateway = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url });
  assert.deepEqual(provider.available(settings()), {
    ok: false,
    reason: "missing_token_env:TASKBOARD_SYSTEMONE_TOKEN",
  });
  assert.deepEqual(
    providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url }).available(settings({ systemoneTokenEnv: "CUSTOM_KEY" })),
    { ok: false, reason: "missing_token_env:CUSTOM_KEY" },
  );
  assert.deepEqual(
    providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, MAGPIE_CALLER_KEY: "tok" }).available(settings()),
    { ok: true },
    "MAGPIE_CALLER_KEY 是令牌链最后一级回退",
  );
  const error = await rejectOf(provider.judge(baseInput(), new AbortController().signal));
  assert.equal(error.code, "auth");
  assert.equal(error.message, "missing_token_env:TASKBOARD_SYSTEMONE_TOKEN");
  assert.equal(gateway.requests.length, 0);
});

test("wire: 非 2xx 映射 http_error，401/403 映射 auth，message 只有状态码没有响应体与令牌", async () => {
  const token = "sekrit-token";
  const cases: Array<{ status: number; code: SystemOneProviderError["code"]; body: unknown }> = [
    { status: 502, code: "http_error", body: { error: "bad gateway body fragment" } },
    { status: 401, code: "auth", body: { error: "denied" } },
    { status: 403, code: "auth", body: { error: "forbidden" } },
  ];
  for (const item of cases) {
    const gateway = await startFakeGateway(() => ({ status: item.status, body: item.body }));
    const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: token });
    const error = await rejectOf(provider.judge(baseInput(), new AbortController().signal));
    assert.equal(error.code, item.code, `HTTP ${item.status}`);
    assert.ok(error.message.includes(String(item.status)));
    assert.ok(!error.message.includes(token));
    assert.ok(!error.message.includes("body fragment"));
  }
});

test("wire: 连接拒绝映射 connection", async () => {
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: "http://127.0.0.1:9/v1/systemone", TASKBOARD_SYSTEMONE_TOKEN: "tok" });
  const error = await rejectOf(provider.judge(baseInput(), new AbortController().signal));
  assert.equal(error.code, "connection");
});

test("wire: AbortSignal.timeout 超时映射 timeout", async () => {
  const gateway = await startFakeGateway(() => "hang");
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
  const error = await rejectOf(provider.judge(baseInput(), AbortSignal.timeout(50)));
  assert.equal(error.code, "timeout");
});

test("wire: close 类非超时中止映射 connection", async () => {
  const gateway = await startFakeGateway(() => "hang");
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
  const controller = new AbortController();
  const pending = provider.judge(baseInput(), controller.signal);
  controller.abort(new Error("daemon closed"));
  const error = await rejectOf(pending);
  assert.equal(error.code, "connection");
});

test("wire: 非法 JSON、缺 answer、非法 choice/confidence/usage/refs 一律 invalid_output", async () => {
  const cases: FakeOutcome[] = [
    { status: 200, raw: "not-json{{" },
    { status: 200, body: 5 },
    { status: 200, body: {} },
    { status: 200, body: { progress_status: {} } },
    { status: 200, body: { progress_status: { choice: "doing_great", confidence: 0.5 } } },
    { status: 200, body: { progress_status: { choice: 99, confidence: 0.5 } } },
    { status: 200, body: { progress_status: { choice: 0, confidence: 0.5 } } },
    { status: 200, body: { progress_status: { choice: 1.5, confidence: 0.5 } } },
    { status: 200, body: { progress_status: { choice: "progressing" } } },
    { status: 200, body: { progress_status: { choice: "progressing", confidence: 1.5 } } },
    { status: 200, body: { progress_status: { choice: "progressing", confidence: 0.5, usage: { input_tokens: -1, output_tokens: 2 } } } },
    { status: 200, body: { progress_status: { choice: "progressing", confidence: 0.5, usage: { input_tokens: 1.5, output_tokens: 2 } } } },
    { status: 200, body: { progress_status: { choice: "progressing", confidence: 0.5 }, input_tokens: 3 } },
    { status: 200, body: { progress_status: { choice: "progressing", confidence: 0.5, evidence_refs: ["ev_999"] } } },
    { status: 200, body: { progress_status: { choice: "progressing", confidence: 0.5, evidence_refs: "ev_1" } } },
  ];
  for (const body of cases) {
    const gateway = await startFakeGateway(() => body);
    const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
    const error = await rejectOf(provider.judge(baseInput(), new AbortController().signal));
    assert.equal(error.code, "invalid_output", JSON.stringify(body));
    assert.ok(!error.message.includes("doing_great"), "message 不回显响应内容");
  }
});

test("wire: 扁平 progress_status.* 键、criteria 索引、顶层 confidence/usage 位置都可解析", async () => {
  const cases: Array<{
    name: string;
    body: Record<string, unknown>;
    status: string;
    confidence: number;
    usage: { inputTokens: number; outputTokens: number } | null;
  }> = [
    {
      name: "字面扁平键",
      body: { "progress_status.choice": "complete", "progress_status.confidence": 0.4 },
      status: "complete",
      confidence: 0.4,
      usage: null,
    },
    {
      name: "criteria 索引按 1 起",
      body: { progress_status: { choice: 5, confidence: 0.4 } },
      status: "needs_attention",
      confidence: 0.4,
      usage: null,
    },
    {
      name: "顶层 confidence 与 usage 包裹对象",
      body: { progress_status: { choice: "blocked" }, confidence: 0.7, usage: { input_tokens: 9, output_tokens: 1 } },
      status: "blocked",
      confidence: 0.7,
      usage: { inputTokens: 9, outputTokens: 1 },
    },
    {
      name: "顶层 token 计数",
      body: { progress_status: { choice: "waiting_user", confidence: 0.2 }, input_tokens: 11, output_tokens: 3 },
      status: "waiting_user",
      confidence: 0.2,
      usage: { inputTokens: 11, outputTokens: 3 },
    },
  ];
  for (const item of cases) {
    const gateway = await startFakeGateway(() => ({ status: 200, body: item.body }));
    const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
    const result = await provider.judge(baseInput(), new AbortController().signal);
    assert.equal(result.status, item.status, item.name);
    assert.equal(result.confidence, item.confidence, item.name);
    assert.deepEqual(result.usage, item.usage, item.name);
    assert.deepEqual(result.evidenceRefs, [], item.name);
  }
});

test("wire: evidence_refs 是输入 id 子集时透传（含 answers 包裹层形态）", async () => {
  const gateway = await startFakeGateway(() => ({
    status: 200,
    body: { answers: { progress_status: { choice: "blocked", confidence: 0.9, evidence_refs: ["ev_2"] } } },
  }));
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
  const result = await provider.judge(baseInput(), new AbortController().signal);
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.evidenceRefs, ["ev_2"]);
});

test("wire: overlay 任务/标签/注记进入 state，注记最多 10 条", async () => {
  const gateway = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
  const input: JudgeInput = {
    ...baseInput(),
    overlay: {
      primaryTaskId: "task_1",
      taskTitle: "修复登录",
      labels: ["bug", "phase1"],
      notes: Array.from({ length: 12 }, (_, index) => ({
        id: `note_${index}`,
        kind: "note",
        body: `note-${index} ${"y".repeat(20)}`,
      })),
    },
  };
  await provider.judge(input, new AbortController().signal);
  const state = gateway.requests[0]!.body.state as string;
  assert.match(state, /^task: task_1 修复登录$/m);
  assert.match(state, /^labels: bug, phase1$/m);
  assert.match(state, /^note\(note\): note-0 /m);
  assert.ok(!state.includes("note-10 "), "第 11 条注记起不渲染");
  assert.ok(state.length <= 4000);
});

test("wire: 标题/workspace/任务/标签/注记外发前脱敏", async () => {
  const gateway = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
  const secret = "Bearer sekrit-in-a-note";
  const input: JudgeInput = {
    ...baseInput(),
    subject: { ...baseInput().subject, title: `标题 ${secret}`, workspace: `/tmp/${secret}` },
    overlay: {
      primaryTaskId: "task_1",
      taskTitle: `任务 ${secret}`,
      labels: [secret],
      notes: [{ id: "note_1", kind: "note", body: `备注 ${secret}` }],
    },
  };
  await provider.judge(input, new AbortController().signal);
  const state = gateway.requests[0]!.body.state as string;
  assert.ok(!state.includes("sekrit-in-a-note"), "人工输入里的凭据不得外发");
  assert.ok(state.includes("[redacted]"));
});

test("wire: 网关重定向按 http_error 拒绝且不跟随", async () => {
  const gateway = await startFakeGateway(() => ({
    status: 302,
    headers: { location: "http://127.0.0.1:1/v1/systemone" },
  }));
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "tok" });
  const error = await rejectOf(provider.judge(baseInput(), new AbortController().signal));
  assert.equal(error.code, "http_error");
});

test("wire: state 有界且令牌只出现在 Authorization 头", async () => {
  const gateway = await startFakeGateway(() => ({ status: 200, body: goodAnswer }));
  const provider = providerFor({ TASKBOARD_SYSTEMONE_URL: gateway.url, TASKBOARD_SYSTEMONE_TOKEN: "sekrit-token" });
  const noisy: JudgeInput = {
    ...baseInput(),
    evidence: Array.from({ length: 30 }, (_, index) => ({
      id: `ev_${index}`,
      kind: "message",
      turnOrdinal: index,
      excerpt: "x".repeat(500),
      recordHash: `h${index}`,
    })),
    allowedEvidenceIds: Array.from({ length: 30 }, (_, index) => `ev_${index}`),
  };
  await provider.judge(noisy, new AbortController().signal);
  const request = gateway.requests[0]!;
  const raw = JSON.stringify(request.body);
  assert.ok(!raw.includes("sekrit-token"), "令牌只能进 Authorization 头");
  assert.ok((request.body.state as string).length <= 4000);
});
