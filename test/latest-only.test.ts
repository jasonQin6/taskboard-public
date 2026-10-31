/**
 * latest-only 拉取原语直测（issue #36，GLOSSARY「latest-only 拉取」）：三案覆盖票面语义——
 * key 变化丢弃 / 同 key 在飞排队仅保最后一次 / 最新胜出（旧结果不覆盖新状态）。
 * 纯原语测试：不经网络、不起 daemon，seam 即 createLatestOnly 的 run(op, commit) 契约。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLatestOnly } from "../web/src/lib/latest-only.js";

/** 哨兵等待的显式 deadline：超时按失败收场（node:test 的 per-test timeout 只取消不计数）。 */
const within = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

test("latest-only: queues concurrent same-key calls keeping only the last one", async () => {
  const slot = createLatestOnly({ getKey: () => "k" });
  let opCalls = 0;
  const commits: string[] = [];
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const run = (): Promise<void> =>
    slot.run(
      async () => {
        opCalls += 1;
        if (opCalls === 1) await firstGate; // 仅首轮停在闸门上
        return `result-${opCalls}`;
      },
      (result) => commits.push(result),
    );
  const first = run();
  const second = run(); // 在飞：排队
  const third = run(); // 排队：覆盖前一个排队意图（keep-last）
  // 排队调用即刻返回，不等在飞请求完成（若实现阻塞等待，这两行会挂起超时）
  await second;
  await third;
  releaseFirst();
  await first;
  // 两次排队合并为一次出队补跑：op 恰好两轮，结果按序提交
  assert.equal(opCalls, 2);
  assert.deepEqual(commits, ["result-1", "result-2"]);
});

test("latest-only: latest wins — a stale result never overwrites the state committed for the new key", async () => {
    // 微型 model：token 即 key，load 以后台取数落状态（模拟 detail-model reload 的切线程竞态）
    const state = { token: "t1", data: "init" };
    let releaseOld: () => void = () => undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let releaseNew: () => void = () => undefined;
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const fetchTokens: string[] = [];
    let newFetchStarted: () => void = () => undefined;
    const newFetch = new Promise<void>((resolve) => {
      newFetchStarted = resolve;
    });
    const fetchData = async (token: string): Promise<string> => {
      fetchTokens.push(token);
      if (token === "t1") {
        await oldGate;
        return "data-of-t1";
      }
      newFetchStarted(); // t2 补跑发起即兑现的哨兵
      await newGate;
      return "data-of-t2";
    };
    const slot = createLatestOnly<string>({
      getKey: () => state.token,
      // rescue 已内化（晨析 10-25）：丢弃早退后的排队意图由原语自身补跑，无需调用方自救重入队
    });
    const load = (): Promise<void> =>
      slot.run(
        async (token) => ({ token, data: await fetchData(token) }),
        (result) => {
          state.data = result.data;
        },
      );

    const first = load(); // t1 在飞
    state.token = "t2"; // 切 key
    const second = load(); // 排队（keep-last）
    await second; // 排队调用即刻返回
    releaseOld(); // 旧请求返回：t1 结果过期丢弃 → 原语在首轮 promise 内部继续补跑 t2
    // 没有任何手动补跑：丢弃后的排队意图必须由原语内部自救执行（无自救则哨兵超时失败）
    await within(newFetch, 1_000, "internal rescue did not re-run the queued load for the new key");
    releaseNew();
    await first; // 内化补跑随首轮 promise 一并收尾（commit 先于结算落地）
    assert.deepEqual(fetchTokens, ["t1", "t2"]);
    assert.equal(state.data, "data-of-t2"); // 旧结果不得覆盖新状态
});

test("latest-only: discards the result when the key changed while the request was in flight", async () => {
  let key = "a";
  const slot = createLatestOnly({ getKey: () => key });
  const commits: unknown[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = slot.run(
    async () => {
      await gate;
      return "stale-result";
    },
    (result) => commits.push(result),
  );
  key = "b"; // 在飞期间 key 变化：结果返回时已过期
  release();
  await done;
  // key 变化丢弃：过期结果不得经 commit 落状态
  assert.deepEqual(commits, []);
});

test("latest-only: onAcquire throwing does not wedge the slot — error flows to onError and the slot resets", async () => {
  // ocr 复审修复的钉子：onAcquire 若在 try 外执行（旧实现同位缺陷），抛错会让 inFlight
  // 永久停留 true，此后所有 run 只置 pending 且无人消费——槽位静默吞掉全部拉取。
  const errors: unknown[] = [];
  const slot = createLatestOnly({
    getKey: () => "k",
    onAcquire: () => {
      if (errors.length === 0) throw new Error("listener boom");
    },
    onError: (error) => errors.push(error),
  });
  const commits: string[] = [];
  // 第一次 run：onAcquire 抛错 → 经 onError 收场吞掉，op 未执行
  await slot.run(async () => "first", (result) => commits.push(result));
  assert.equal(errors.length, 1);
  assert.deepEqual(commits, []);
  // 槽位必须已复位：第二次 run 正常走完（若槽位卡死，此调用只置 pending 即刻返回，commit 永远不落）
  await slot.run(async () => "second", (result) => commits.push(result));
  assert.deepEqual(commits, ["second"]);
});

test("latest-only: dispose 后在飞结果不落状态、后续 run 空转（组件卸载守卫的 primitives 面）", async () => {
  const slot = createLatestOnly({ getKey: () => "k" });
  const commits: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlightRun = slot.run(
    async () => {
      await gate;
      return "late-result";
    },
    (result) => commits.push(result),
  );
  slot.dispose(); // 在飞期间卸载
  release();
  await inFlightRun;
  assert.deepEqual(commits, [], "dispose 后在飞结果不得 commit（卸载后 setState 的替代守卫）");
  await slot.run(async () => "after-dispose", (result) => commits.push(result));
  assert.deepEqual(commits, [], "dispose 后的 run 直接空转，不发起 op");
});
