/**
 * 多线程 watch 薄封装：先测纯函数语义，再用假 codexhost 端到端跑真脚本，
 * 断言外部可观察行为（输出行与退出码），不锁内部实现。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  diffSnapshots,
  exitCodeFor,
  isTerminalStatus,
  type ThreadSnapshot,
} from "../scripts/watch-threads.ts";

test("terminal status: only running/pending/queued are non-terminal", () => {
  for (const status of ["running", "pending", "queued", ""]) {
    assert.equal(isTerminalStatus(status), false, status);
  }
  for (const status of ["completed", "failed", "cancelled", "error"]) {
    assert.equal(isTerminalStatus(status), true, status);
  }
});

const snap = (thread: string, status: string, progress = ""): ThreadSnapshot => ({
  thread,
  status,
  progress,
});

test("diffSnapshots reports first sighting and transitions only", () => {
  const previous = new Map<string, string>();
  const first = diffSnapshots(previous, [snap("a", "running", "start")]);
  assert.deepEqual(first.lines, ["[a] new -> running — start"]);
  assert.deepEqual(first.running, ["a"]);
  previous.set("a", "running");

  const same = diffSnapshots(previous, [snap("a", "running", "later")]);
  assert.deepEqual(same.lines, []);

  const done = diffSnapshots(previous, [snap("a", "completed")]);
  assert.deepEqual(done.lines, ["[a] running -> completed"]);
  assert.deepEqual(done.running, []);
  assert.deepEqual(done.failed, []);
});

test("diffSnapshots separates failure from success terminal states", () => {
  const result = diffSnapshots(new Map(), [snap("ok", "completed"), snap("bad", "failed")]);
  assert.deepEqual(result.running, []);
  assert.deepEqual(result.failed, ["bad"]);
});

test("exitCodeFor: all terminal = 0, any failure = 2, still running = 124", () => {
  assert.equal(exitCodeFor([], []).code, 0);
  assert.equal(exitCodeFor([], ["t1"]).code, 2);
  assert.equal(exitCodeFor(["t1"], []).code, 124);
  assert.equal(exitCodeFor(["t1"], ["t2"]).code, 124);
  assert.match(exitCodeFor(["t1"], []).reason, /不代表失败/);
});

/* ---------------- 端到端：假 codexhost + 真脚本 ---------------- */

interface Sandbox {
  dir: string;
  run: (threads: string[], timeoutMs: number) => {
    code: number | null;
    stdout: string;
    stderr: string;
  };
  setStatus: (thread: string, status: string) => Promise<void>;
}

const makeSandbox = async (t: { after: (fn: () => Promise<void>) => void }): Promise<Sandbox> => {
  const dir = await mkdtemp(join(tmpdir(), "tb-watch-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  await mkdir(bin, { recursive: true });
  const fake = join(bin, "codexhost");
  // 假 CLI：每次调用返回当前状态，并把进度计数写进文件，模拟"状态变化"
  await writeFile(
    fake,
    `#!/bin/sh
ref="$3"
count_file="$TB_WATCH_SANDBOX/$ref.count"
n=$(cat "$count_file" 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > "$count_file"
status=$(cat "$TB_WATCH_SANDBOX/$ref.status" 2>/dev/null || echo running)
printf '{"thread":"%s","status":"%s","progress":"tick %s"}\\n' "$ref" "$status" "$n"
`,
  );
  await chmod(fake, 0o755);
  return {
    dir,
    run: (threads, timeoutMs) => {
      const spawned = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          join(import.meta.dirname, "..", "scripts", "watch-threads.ts"),
          ...threads,
          "--interval-ms",
          "40",
          "--timeout-ms",
          String(timeoutMs),
        ],
        {
          encoding: "utf8",
          env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, TB_WATCH_SANDBOX: dir },
          timeout: 30_000,
        },
      );
      return { code: spawned.status, stdout: spawned.stdout ?? "", stderr: spawned.stderr ?? "" };
    },
    setStatus: async (thread, status) => {
      await writeFile(join(dir, `${thread}.status`), status);
    },
  };
};

test("e2e: all threads terminal exits 0 and prints one line per transition", async (t) => {
  const box = await makeSandbox(t);
  await box.setStatus("t1", "completed");
  await box.setStatus("t2", "completed");
  const result = box.run(["t1", "t2"], 5_000);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[t1\] new -> completed/);
  assert.match(result.stdout, /\[t2\] new -> completed/);
  assert.match(result.stdout, /全部线程到终态/);
  assert.match(result.stdout, /不代表验收通过/);
});

test("e2e: a failed thread exits 2", async (t) => {
  const box = await makeSandbox(t);
  await box.setStatus("t1", "completed");
  await box.setStatus("t2", "failed");
  const result = box.run(["t1", "t2"], 5_000);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /非成功终态/);
});

test("e2e: never-ending threads exit 124 as a running checkpoint", async (t) => {
  const box = await makeSandbox(t);
  await box.setStatus("t1", "running");
  const result = box.run(["t1"], 600);
  assert.equal(result.code, 124, result.stdout + result.stderr);
  assert.match(result.stdout, /不代表失败/);
});
