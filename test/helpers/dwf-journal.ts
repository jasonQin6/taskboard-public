/**
 * 固定 dwf journal fixture 构建器（#69）：按真库 ~/.zcode/cli/db/db.sqlite 的 dwf_run/
 * dwf_event/dwf_node 形状（2026-10-31 抽样核对，DDL 同形含 CHECK 约束）构造最小库，驱动
 * attempt 复盘的只读消费，不碰真实 ZCode 库。
 */
import { DatabaseSync } from "node:sqlite";

const DWF_DDL = `
CREATE TABLE dwf_run (
  id text primary key,
  parent_session_id text,
  cwd text,
  name text,
  script_text text,
  script_hash text,
  args_json text,
  tool_call_id text,
  resumed_from text,
  caps_max_concurrency integer not null,
  spent_tokens integer not null default 0,
  status text not null check(status in ('pending','running','completed','failed','cancelled')),
  result_json text,
  failure_json text,
  time_created integer not null,
  time_updated integer not null
);
CREATE TABLE dwf_event (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  sequence integer not null,
  type text not null,
  payload_json text not null,
  time_created integer not null,
  unique(run_id, sequence)
);
CREATE TABLE dwf_node (
  id integer primary key autoincrement,
  run_id text not null references dwf_run(id) on delete cascade,
  site_id text not null,
  ordinal integer not null,
  kind text not null check(kind in ('ask','world-read','world-run','report','artifact')),
  actor_site_id text,
  actor_ordinal integer,
  actor_seq integer,
  input_hash text not null,
  input_json text,
  status text not null check(status in ('running','completed','failed')),
  result_json text,
  error_json text,
  stats_json text,
  message_boundary integer,
  artifact_id text,
  time_created integer not null,
  time_updated integer not null,
  unique(run_id, site_id, ordinal)
);
`;

export const DWF_T0 = 1_735_300_000_000;

export interface FixtureWorldRun {
  siteId: string;
  status?: string;
  input?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface FixtureRun {
  id: string;
  cwd: string;
  name?: string;
  status: string;
  resultJson?: string | null;
  failureJson?: string | null;
  resumedFrom?: string | null;
  spentTokens?: number;
  /** null = 不写 run-settled 事件（未结算）；payload 会并入 {type:"run-settled", status} */
  settled?: { status: string; payload?: Record<string, unknown> } | null;
  worldRuns?: FixtureWorldRun[];
}

export const fixtureRun = (
  overrides: Partial<FixtureRun> & Pick<FixtureRun, "id" | "status" | "cwd">,
): FixtureRun => ({ settled: { status: "completed" }, ...overrides });

export const writeDwfFixture = (path: string, runs: FixtureRun[]): void => {
  const db = new DatabaseSync(path);
  db.exec(DWF_DDL);
  const insertRun = db.prepare(
    `INSERT INTO dwf_run (id, cwd, name, resumed_from, spent_tokens, status, result_json, failure_json,
       time_created, time_updated, caps_max_concurrency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const insertEvent = db.prepare(
    "INSERT INTO dwf_event (run_id, sequence, type, payload_json, time_created) VALUES (?, ?, ?, ?, ?)",
  );
  const insertNode = db.prepare(
    `INSERT INTO dwf_node (run_id, site_id, ordinal, kind, input_hash, input_json, status, result_json,
       error_json, time_created, time_updated)
     VALUES (?, ?, 1, 'world-run', 'h', ?, ?, ?, ?, ?, ?)`,
  );
  let sequence = 0;
  for (const run of runs) {
    insertRun.run(
      run.id,
      run.cwd,
      run.name ?? "issue-to-pr",
      run.resumedFrom ?? null,
      run.spentTokens ?? 0,
      run.status,
      run.resultJson ?? null,
      run.failureJson ?? null,
      DWF_T0,
      DWF_T0 + 1000,
    );
    insertEvent.run(run.id, (sequence += 1), "run-started", "{}", DWF_T0);
    if (run.settled !== null) {
      const settled = run.settled ?? { status: run.status };
      insertEvent.run(
        run.id,
        (sequence += 1),
        "run-settled",
        JSON.stringify({ type: "run-settled", ...settled.payload, status: settled.status }),
        DWF_T0 + 500,
      );
    }
    for (const node of run.worldRuns ?? []) {
      insertNode.run(
        run.id,
        node.siteId,
        node.input === undefined ? null : JSON.stringify(node.input),
        node.status ?? "completed",
        node.result === undefined || node.result === null ? null : JSON.stringify(node.result),
        node.error === undefined || node.error === null ? null : JSON.stringify(node.error),
        DWF_T0 + 100,
        DWF_T0 + 200,
      );
    }
  }
  db.close();
};
