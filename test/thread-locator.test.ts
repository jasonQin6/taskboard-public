/**
 * Issue #43 审计返工（F2/F3/F4）：turn/summary 的 source locator 必须与自身 source 一致。
 * 跨 source 时 turn 的 sourcePath 必须按自己的 sourceRef 解析；同一 turn id 跨 source 重放时
 * sourceRef/byteStart/recordHash 作为整体替换；sample/legacy 摘要（sourceId=null）不得伪造来源。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { openStateDb } from "../src/db.js";
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";
import { createHttpServer, type TaskboardHttp } from "../src/http.js";
import { SingleFlightRegistry } from "../src/single-flight.js";
import { Store, type SourceScanPatch } from "../src/store/index.js";
import type { ViewContext } from "../src/views.js";

const tmpDirs: string[] = [];
const servers: TaskboardHttp[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.shutdown();
  while (tmpDirs.length > 0) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

const boot = async (): Promise<{ store: Store; base: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-locator-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "taskboard.sqlite");
  const { db } = await openStateDb(dbPath);
  const store = new Store(db);
  const views = { store, singleFlight: new SingleFlightRegistry(), runtime: () => ({}) } as unknown as ViewContext;
  const http = createHttpServer({ store, views, dbPath });
  servers.push(http);
  const port = await new Promise<number>((resolve) => {
    http.server.listen(0, "127.0.0.1", () => {
      const address = http.server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  return { store, base: `http://127.0.0.1:${port}` };
};

const getJson = async (base: string, path: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`${base}${path}`)).json()) as Record<string, unknown>;

interface TurnSeed {
  id: string;
  threadId: string;
  ordinal: number;
  sourceRef: string | null;
  byteStart: number | null;
  recordHash: string | null;
  sourceLocatorKind?: "start" | "terminal" | null;
}

const commitSource = (
  store: Store,
  source: { sourceId: string; path: string; threadId: string; threadSourcePath?: string | null },
  turns: TurnSeed[],
): void => {
  const patch: SourceScanPatch = {
    source: {
      sourceId: source.sourceId,
      path: source.path,
      threadId: source.threadId,
      inode: 1,
      size: 1,
      mtime: 1,
      consumedBytes: 1,
      prefixHash: "p",
      tailHash: null,
      nextOrdinal: turns.length,
      parserVersion: 1,
      rewritten: false,
    },
    threads:
      source.threadSourcePath === undefined
        ? []
        : [
            {
              id: source.threadId,
              harnessId: CODEX_HARNESS_ID,
              nativeStatus: "running",
              title: null,
              sourcePath: source.threadSourcePath,
              lastActivityAt: store.now(),
            },
          ],
    turns: turns.map((turn) => ({
      id: turn.id,
      threadId: turn.threadId,
      ordinal: turn.ordinal,
      nativeStatus: "completed",
      startedAt: null,
      endedAt: null,
      sourceRef: turn.sourceRef,
      sourceByteStart: turn.byteStart,
      sourceRecordHash: turn.recordHash,
      sourceLocatorKind: turn.sourceLocatorKind,
    })),
    evidence: [],
    supersedeEvidence: false,
    rebuildTurns: false,
    anomalies: [],
    resolveAnomalies: false,
    summaries: [],
    lineage: [],
  };
  store.commitSourceScan(patch);
};

type TurnLocator = {
  sourceRef: string | null;
  sourcePath: string | null;
  byteStart: number | null;
  recordHash: string | null;
  kind?: string | null;
};

test("F2: turn locator sourcePath resolves per the turn's own sourceRef, not the thread's latest source", async () => {
  const { store, base } = await boot();
  store.upsertThread({ id: "th_multi", harnessId: CODEX_HARNESS_ID, nativeStatus: "running", lastActivityAt: store.now() });
  commitSource(store, { sourceId: "srcB", path: "/tmp/B.jsonl", threadId: "th_multi", threadSourcePath: "/tmp/B.jsonl" }, [
    { id: "t-b", threadId: "th_multi", ordinal: 0, sourceRef: "srcB", byteStart: 200, recordHash: "hashB" },
  ]);
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_multi" }, [
    { id: "t-a", threadId: "th_multi", ordinal: 1, sourceRef: "srcA", byteStart: 10, recordHash: "hashA" },
  ]);
  assert.equal(store.threadIdentity("th_multi").sourcePath, "/tmp/B.jsonl", "线程最新 source 应为 B（构造前提）");

  const page = await getJson(base, "/api/threads/th_multi/turns?limit=50");
  const items = page.items as Array<{ id: string; locator: TurnLocator }>;
  const locatorOf = (id: string): TurnLocator => items.find((turn) => turn.id === id)!.locator;
  assert.deepEqual(locatorOf("t-a"), {
    sourceRef: "srcA",
    sourcePath: "/tmp/A.jsonl",
    byteStart: 10,
    recordHash: "hashA",
    kind: null,
  });
  assert.deepEqual(locatorOf("t-b"), {
    sourceRef: "srcB",
    sourcePath: "/tmp/B.jsonl",
    byteStart: 200,
    recordHash: "hashB",
    kind: null,
  });

  const detail = (await getJson(base, "/api/threads/th_multi")).thread as {
    latestTurn: { id: string; locator: TurnLocator };
  };
  assert.equal(detail.latestTurn.id, "t-a");
  assert.deepEqual(detail.latestTurn.locator, {
    sourceRef: "srcA",
    sourcePath: "/tmp/A.jsonl",
    byteStart: 10,
    recordHash: "hashA",
    kind: null,
  });
});

test("F3: cross-source replay of the same turn id replaces sourceRef, byteStart and recordHash as a unit", async () => {
  const { store } = await boot();
  store.upsertThread({ id: "th_replay", harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_replay" }, [
    { id: "t1", threadId: "th_replay", ordinal: 0, sourceRef: "srcA", byteStart: 10, recordHash: "hashA" },
  ]);
  // resume 链：同一 turn id 由另一个 source 重放（不同 byte/hash）
  commitSource(store, { sourceId: "srcB", path: "/tmp/B.jsonl", threadId: "th_replay" }, [
    { id: "t1", threadId: "th_replay", ordinal: 0, sourceRef: "srcB", byteStart: 200, recordHash: "hashB" },
  ]);

  const rows = store.listThreadTurns("th_replay");
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.deepEqual(
    { sourceRef: row.sourceRef, byteStart: row.sourceByteStart, recordHash: row.sourceRecordHash },
    { sourceRef: "srcB", byteStart: 200, recordHash: "hashB" },
    "新 sourceRef 不得与旧 byteStart/recordHash 混用",
  );
});

test("F3: a null old locator is replaced when the replay moves to a non-null source", async () => {
  const { store } = await boot();
  store.upsertThread({ id: "th_replay", harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_replay" }, [
    { id: "t1", threadId: "th_replay", ordinal: 0, sourceRef: null, byteStart: 10, recordHash: "hashA" },
  ]);
  commitSource(store, { sourceId: "srcB", path: "/tmp/B.jsonl", threadId: "th_replay" }, [
    { id: "t1", threadId: "th_replay", ordinal: 0, sourceRef: "srcB", byteStart: 200, recordHash: "hashB" },
  ]);

  const row = store.listThreadTurns("th_replay")[0]!;
  assert.deepEqual(
    { sourceRef: row.sourceRef, byteStart: row.sourceByteStart, recordHash: row.sourceRecordHash },
    { sourceRef: "srcB", byteStart: 200, recordHash: "hashB" },
  );
});

test("F3: a null new locator does not retain the previous source's locator", async () => {
  const { store } = await boot();
  store.upsertThread({ id: "th_replay", harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_replay" }, [
    { id: "t1", threadId: "th_replay", ordinal: 0, sourceRef: "srcA", byteStart: 10, recordHash: "hashA" },
  ]);
  commitSource(store, { sourceId: "srcB", path: "/tmp/B.jsonl", threadId: "th_replay" }, [
    { id: "t1", threadId: "th_replay", ordinal: 0, sourceRef: "srcB", byteStart: null, recordHash: null },
  ]);

  const row = store.listThreadTurns("th_replay")[0]!;
  assert.deepEqual(
    { sourceRef: row.sourceRef, byteStart: row.sourceByteStart, recordHash: row.sourceRecordHash },
    { sourceRef: "srcB", byteStart: null, recordHash: null },
  );
});

test("F3: same-source incremental replay preserves a non-null locator", async () => {
  const { store } = await boot();
  store.upsertThread({ id: "th_replay", harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_replay" }, [
    {
      id: "t1",
      threadId: "th_replay",
      ordinal: 0,
      sourceRef: "srcA",
      byteStart: 10,
      recordHash: "hashA",
      sourceLocatorKind: "start",
    },
  ]);
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_replay" }, [
    {
      id: "t1",
      threadId: "th_replay",
      ordinal: 0,
      sourceRef: "srcA",
      byteStart: 20,
      recordHash: "hashTerminal",
      sourceLocatorKind: "terminal",
    },
  ]);

  const row = store.listThreadTurns("th_replay")[0]!;
  assert.deepEqual(
    {
      sourceRef: row.sourceRef,
      byteStart: row.sourceByteStart,
      recordHash: row.sourceRecordHash,
      kind: row.sourceLocatorKind,
    },
    { sourceRef: "srcA", byteStart: 10, recordHash: "hashA", kind: "start" },
  );
});

test("F9: a legacy non-null locator without a kind stays unknown when a terminal replay arrives", async () => {
  const { store } = await boot();
  store.upsertThread({ id: "th_legacy_kind", harnessId: CODEX_HARNESS_ID, nativeStatus: "running" });
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_legacy_kind" }, [
    { id: "t1", threadId: "th_legacy_kind", ordinal: 0, sourceRef: "srcA", byteStart: 10, recordHash: "hashA" },
  ]);
  commitSource(store, { sourceId: "srcA", path: "/tmp/A.jsonl", threadId: "th_legacy_kind" }, [
    {
      id: "t1",
      threadId: "th_legacy_kind",
      ordinal: 0,
      sourceRef: "srcA",
      byteStart: 20,
      recordHash: "hashTerminal",
      sourceLocatorKind: "terminal",
    },
  ]);

  const row = store.listThreadTurns("th_legacy_kind")[0]!;
  assert.equal(row.sourceByteStart, 10);
  assert.equal(row.sourceRecordHash, "hashA");
  assert.equal(row.sourceLocatorKind, null, "old mixed locators cannot be relabeled as terminal fallback");
});

test("F4: a summary with sourceId=null reports sourcePath=null instead of the thread's rollout path", async () => {
  const { store, base } = await boot();
  store.upsertThread({ id: "th_sample", harnessId: CODEX_HARNESS_ID, nativeStatus: "completed", lastActivityAt: store.now() });
  commitSource(store, { sourceId: "srcS", path: "/tmp/rollout.jsonl", threadId: "th_sample", threadSourcePath: "/tmp/rollout.jsonl" }, [
    { id: "t1", threadId: "th_sample", ordinal: 0, sourceRef: "srcS", byteStart: 5, recordHash: "h1" },
  ]);
  // sample/legacy 摘要走 addThreadSummary（source_id 恒 null）
  store.addThreadSummary({ threadId: "th_sample", provenance: "sample", text: "legacy sample summary" });

  const detail = (await getJson(base, "/api/threads/th_sample")).thread as {
    summary: { provenance: string; locator: { sourceId: string | null; sourcePath: string | null } };
  };
  assert.equal(detail.summary.provenance, "sample");
  assert.equal(detail.summary.locator.sourceId, null);
  assert.equal(detail.summary.locator.sourcePath, null, "sample 摘要不是从 rollout 解析而来，不得回退线程 rollout path");

  const list = await getJson(base, "/api/threads/th_sample/summaries");
  const item = (list.items as Array<{ locator: { sourceId: string | null; sourcePath: string | null } }>)[0]!;
  assert.equal(item.locator.sourceId, null);
  assert.equal(item.locator.sourcePath, null);
});

test("F9: turn locator projections distinguish start records, terminal fallback, and unknown locators", async () => {
  const { store, base } = await boot();
  store.upsertThread({ id: "th_kind", harnessId: CODEX_HARNESS_ID, nativeStatus: "completed", lastActivityAt: store.now() });
  commitSource(store, { sourceId: "srcK", path: "/tmp/kind.jsonl", threadId: "th_kind" }, [
    {
      id: "t-start",
      threadId: "th_kind",
      ordinal: 0,
      sourceRef: "srcK",
      byteStart: 10,
      recordHash: "start-hash",
      sourceLocatorKind: "start",
    },
    {
      id: "t-terminal",
      threadId: "th_kind",
      ordinal: 1,
      sourceRef: "srcK",
      byteStart: 20,
      recordHash: "terminal-hash",
      sourceLocatorKind: "terminal",
    },
    { id: "t-unknown", threadId: "th_kind", ordinal: 2, sourceRef: "srcK", byteStart: null, recordHash: null },
  ]);

  const page = await getJson(base, "/api/threads/th_kind/turns?limit=50");
  const items = page.items as Array<{ id: string; locator: TurnLocator & { kind?: string | null } }>;
  assert.deepEqual(
    items.map((turn) => ({ id: turn.id, kind: turn.locator.kind })),
    [
      { id: "t-start", kind: "start" },
      { id: "t-terminal", kind: "terminal" },
      { id: "t-unknown", kind: null },
    ],
  );
});
