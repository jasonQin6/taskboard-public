/**
 * 真 daemon + loopback fake Magpie：SystemOne 判定成功后 Task/Run/Proposal/Annotation/
 * ActionExecution/nativeStatus 与 driver 均不得变化——判定是带外只读面。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";

const startFakeGateway = async (): Promise<{ url: string; calls: number; close: () => Promise<void> }> => {
  let calls = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          answers: {
            progress_status: {
              choice: "progressing",
              confidence: 0.9,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/v1/systemone`,
    get calls() {
      return calls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const seedThread = (daemon: RunningDaemon): void => {
  const store = daemon.store;
  const now = store.now();
  store.upsertThread({
    id: "th_iso",
    harnessId: CODEX_HARNESS_ID,
    nativeStatus: "running",
    title: "isolation fixture",
    lastActivityAt: now,
  });
  store.commitSourceScan({
    source: {
      sourceId: "src_iso",
      path: "/tmp/th_iso.jsonl",
      threadId: "th_iso",
      inode: 42,
      size: 10,
      mtime: now,
      consumedBytes: 10,
      prefixHash: "p",
      tailHash: null,
      nextOrdinal: 2,
      parserVersion: 1,
      rewritten: false,
    },
    threads: [{
      id: "th_iso",
      harnessId: CODEX_HARNESS_ID,
      nativeSessionId: "th_iso",
      nativeStatus: "running",
      title: "isolation fixture",
      workspace: "/tmp/ws",
      nativeGroup: null,
      sourcePath: "/tmp/th_iso.jsonl",
      sourceByteStart: 0,
      sourceRecordHash: "h0",
      lastActivityAt: now,
    }],
    turns: [
      { id: "t_iso_0", threadId: "th_iso", ordinal: 0, nativeStatus: "completed", startedAt: now - 2, endedAt: now - 1, sourceRef: "src_iso" },
      { id: "t_iso_1", threadId: "th_iso", ordinal: 1, nativeStatus: "running", startedAt: now, endedAt: null, sourceRef: "src_iso" },
    ],
    evidence: [
      { threadId: "th_iso", sourceId: "src_iso", byteStart: 0, recordHash: "e0", turnOrdinal: 0, kind: "message", summary: "hello", props: null },
    ],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  });
};

test("systemone-isolation: refresh 不触碰执行面，也不 spawn driver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tb-s1iso-"));
  const webDir = await mkdtemp(join(tmpdir(), "tb-s1iso-web-"));
  const gateway = await startFakeGateway();
  let daemon: RunningDaemon | null = null;
  try {
    daemon = await startDaemon({
      port: 0,
      dbPath: join(dir, "taskboard.sqlite"),
      codexHome: null,
      webDir,
      automationTickMs: 60_000,
      env: {
        TASKBOARD_SYSTEMONE_URL: gateway.url,
        TASKBOARD_SYSTEMONE_TOKEN: "tok-isolation",
      },
    });
    seedThread(daemon);
    const store = daemon.store;
    const before = {
      tasks: store.listTasks(),
      proposals: store.listProposals({ limit: 100 }),
      annotations: store.listAnnotations({}),
      executions: store.listActionExecutions({}),
      activeRuns: store.countActiveRuns(),
      thread: store.listThreads().find((thread) => thread.id === "th_iso"),
      revisions: store.revisions(),
    };
    assert.ok(before.thread !== undefined);
    assert.equal(daemon.driver.clientRef(), null);

    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "systemone.refresh", threadId: "th_iso", requestId: "iso-1" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    const outcome = body.outcome as Record<string, unknown>;
    const view = outcome.view as Record<string, unknown>;
    assert.equal(view.state, "current");
    assert.equal((view.verdict as Record<string, unknown>).status, "progressing");
    assert.equal(gateway.calls, 1);

    assert.deepEqual(store.listTasks(), before.tasks);
    assert.deepEqual(store.listProposals({ limit: 100 }), before.proposals);
    assert.deepEqual(store.listAnnotations({}), before.annotations);
    assert.deepEqual(store.listActionExecutions({}), before.executions);
    assert.equal(store.countActiveRuns(), before.activeRuns);
    assert.deepEqual(store.listThreads().find((thread) => thread.id === "th_iso"), before.thread);
    assert.equal(store.revisions().tasks, before.revisions.tasks);
    assert.equal(store.revisions().config, before.revisions.config);
    assert.ok(store.revisions().threads > before.revisions.threads);
    assert.equal(daemon.driver.clientRef(), null, "SystemOne 不得触发 driver");
  } finally {
    await daemon?.close();
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
    await rm(webDir, { recursive: true, force: true });
  }
});
