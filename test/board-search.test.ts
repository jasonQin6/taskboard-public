/**
 * 看板搜索语义（issue #6，用户故事 7）：标题、标签、摘要（任务描述）、线程标题。
 * 纯函数缝；大小写不敏感，多词 AND。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientTask, ClientThread } from "../web/src/lib/board-model.js";
import { matchesSearch } from "../web/src/lib/search.js";

const task = (overrides: Partial<ClientTask> = {}): ClientTask => ({
  id: "t1",
  title: "Fix login flow",
  prompt: "Handle SSO redirect edge case",
  workspace: "/tmp/ws",
  status: "todo",
  archived: false,
  labels: ["auth", "urgent"],
  acceptanceMode: "human",
  automationMode: "suggest",
  parentId: null,
  primaryThreadId: "th1",
  primaryThreadStatus: "idle",
  threadCount: 1,
  childrenCount: 0,
  badges: [],
  summaryStatus: "none",
  activeRun: null,
  lastRun: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

const thread = (overrides: Partial<ClientThread> = {}): ClientThread => ({
  id: "th1",
  nativeStatus: "idle",
  title: "Codex session about login",
  lastActivityAt: null,
  ignored: false,
  primaryTaskId: "t1",
  ...overrides,
});

test("search: empty query matches everything", () => {
  assert.equal(matchesSearch(task(), [], "  "), true);
});

test("search: matches title, label, prompt and bound thread title, case-insensitively", () => {
  const threads = [thread()];
  assert.equal(matchesSearch(task(), threads, "login"), true);
  assert.equal(matchesSearch(task(), threads, "URGENT"), true);
  assert.equal(matchesSearch(task(), threads, "sso redirect"), true);
  assert.equal(matchesSearch(task(), threads, "codex session"), true);
});

test("search: multiple terms are ANDed", () => {
  const threads = [thread()];
  assert.equal(matchesSearch(task(), threads, "login urgent"), true);
  assert.equal(matchesSearch(task(), threads, "login missing"), false);
});

test("search: no match returns false; threads of other tasks do not leak in", () => {
  assert.equal(matchesSearch(task(), [], "nomatch"), false);
  const otherThread = thread({ id: "th9", title: "unrelated conversation", primaryTaskId: "t_other" });
  assert.equal(matchesSearch(task(), [otherThread], "unrelated"), false);
});
