/**
 * 真实 Codex app-server 冒烟门（env-gated，不进默认单测——需求「Testing Decisions」）。
 * 启用：TASKBOARD_SMOKE=1（本机需有可用凭据的 codex CLI；命令可用 TASKBOARD_CODEX_COMMAND 覆盖）。
 * 验证线上协议假设仍成立：experimental opt-in initialize、能力探测、thread/start
 * （approval_policy=never + sandbox）、turn/start 到原生终态、turn/interrupt 可用。
 * 断言保持宽松（真实模型行为不可脚本化）：只钉协议往返与终态词表，不钉业务内容。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexDriver } from "../src/driver/codex-driver.js";

const smokeEnabled = process.env.TASKBOARD_SMOKE === "1";
const skipReason = smokeEnabled ? false : "set TASKBOARD_SMOKE=1 to run against the real codex app-server";

/** 终态等待是事件驱动的（无内建超时）；冒烟门整体限时，防止真机挂起拖死门。 */
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`smoke timeout after ${ms}ms: ${label}`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

test("real app-server: initialize+probe, thread create, send to native terminal, interrupt method", { skip: skipReason }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "tb-smoke-ws-"));
  const command = process.env.TASKBOARD_CODEX_COMMAND?.trim() || "codex";
  const driver = new CodexDriver({ command, args: ["app-server"] });
  try {
    const client = await driver.ensureStarted();
    const info = client.info();
    assert.ok(info.userAgent !== null, "initialize must report userAgent");
    // 能力注册表只登记实际探测到的；写核心 method 不在探测清单
    const capabilities = client.capabilities();
    assert.ok(capabilities.available.length > 0, "capability probe must record at least one method");

    const threadId = await withTimeout(
      driver.createThread({ workspace, idempotencyKey: `smoke/${Date.now()}` }),
      30_000,
      "thread/start",
    );
    assert.ok(threadId.length > 0);

    const terminal = await withTimeout(
      driver.send({
        threadId,
        message: "Reply with the single word: ok",
        idempotencyKey: `smoke-turn/${Date.now()}`,
      }),
      120_000,
      "turn terminal",
    );
    assert.ok(
      ["completed", "failed", "interrupted"].includes(terminal.kind),
      `terminal kind must be a native turn terminal, got: ${terminal.kind}`,
    );

    // interrupt 在真机上对无在飞 turn 的线程应答 interrupted:false（协议形态可往返）
    const interrupt = await driver.interrupt(threadId);
    assert.equal(typeof interrupt.interrupted, "boolean");
  } finally {
    await driver.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
});
