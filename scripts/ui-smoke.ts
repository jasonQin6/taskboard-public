/**
 * Playwright 冒烟（issue #6 / A33 板级半边）：对真实 daemon（临时 SQLite + 公开 API 缝构造状态）
 * 驱动真浏览器。不模拟 React 内部；断言全部走用户可见行为与 data-testid。
 * 独立 script（pnpm test:ui），不进 pnpm test；本地缺浏览器时明示跳过并以 0 退出，
 * 但 CI（或 TASKBOARD_REQUIRE_BROWSER=1）下缺浏览器是硬失败——否则 CI 会假绿。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { CODEX_HARNESS_ID } from "../src/harness/ids.js";

// reader 隔离：daemon 装配默认扫 $CODEX_HOME，冒烟指到空目录（与单测同款约定），
// 否则真机 ~/.codex 的持续落库会让 SSE revision 风暴干扰收敛断言。
// 路径提出来：main 的 finally 一并清理，避免 os.tmpdir() 里积累孤儿目录
const codexHomeDir = mkdtempSync(join(tmpdir(), "tb-codexhome-ui-"));
process.env.CODEX_HOME = codexHomeDir;

let passed = 0;
const ok = (name: string): void => {
  passed += 1;
  console.log(`  ✔ ${name}`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeMagpie {
  url: string;
  calls: () => number;
  close: () => Promise<void>;
}

/** loopback fake Magpie：从 wire state 的编号证据里取第一条 ref，验证引用子集校验不是空集旁路。 */
const startFakeMagpie = async (): Promise<FakeMagpie> => {
  let calls = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      calls += 1;
      let ref: string | null = null;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { state?: unknown };
        const match = /\[1\] (\S+)/.exec(typeof body.state === "string" ? body.state : "");
        ref = match?.[1] ?? null;
      } catch {
        // 请求体不可解析也要应答：让断言落在调用次数与页面投影上，不在这里抛
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          answers: {
            progress_status: {
              choice: "progressing",
              confidence: 0.9,
              evidence_refs: ref === null ? [] : [ref],
              usage: { input_tokens: 5, output_tokens: 2 },
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
    calls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const taskIdOf = (payload: Record<string, unknown>): string =>
  ((payload as { task: { id: string } }).task).id;

const createTask = async (base: string, fields: Record<string, unknown>): Promise<string> => {
  const res = await fetch(`${base}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "task.create", requestId: crypto.randomUUID(), workspace: "/tmp/ws", ...fields }),
  });
  if (res.status !== 201) throw new Error(`create failed: ${res.status} ${await res.text()}`);
  return taskIdOf((await res.json()) as Record<string, unknown>);
};

const runAction = async (base: string, type: string, fields: Record<string, unknown>): Promise<void> => {
  const res = await fetch(`${base}/api/actions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, requestId: crypto.randomUUID(), ...fields }),
  });
  if (!res.ok) throw new Error(`${type} failed: ${res.status} ${await res.text()}`);
};

const main = async (): Promise<number> => {
  const webDir = fileURLToPath(new URL("../web/dist", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "tb-ui-"));
  const magpie = await startFakeMagpie();
  let daemon: RunningDaemon | null = null;
  try {
    daemon = await startDaemon({
      port: 0,
      dbPath: join(dir, "taskboard.sqlite"),
      webDir,
      env: {
        ...process.env,
        TASKBOARD_SYSTEMONE_URL: magpie.url,
        TASKBOARD_SYSTEMONE_TOKEN: "ui-smoke-token",
      },
    });
    const base = `http://127.0.0.1:${daemon.port}`;

    // ---- 公开 API 缝构造状态（不模拟 React 内部）----
    const backlogId = await createTask(base, { title: "编写登录页", labels: ["auth"], prompt: "实现 **登录表单**", status: "backlog" });
    const todoId = await createTask(base, { title: "修复搜索分词", labels: ["search"] });
    const runningId = await createTask(base, { title: "重构看板布局", workspace: "/repo/beta" });
    const doneId = await createTask(base, { title: "初始化仓库" });
    const failedId = await createTask(base, { title: "坏掉的迁移" });
    const archivedId = await createTask(base, { title: "旧版主页", status: "backlog" });
    const xssId = await createTask(base, {
      title: "<img src=x onerror=window.__xss=1>",
      prompt: "<script>window.__xss=1</script>",
      status: "backlog",
    });
    await runAction(base, "task.move", { taskId: runningId, status: "running" });
    await runAction(base, "task.move", { taskId: doneId, status: "done" });
    await runAction(base, "task.move", { taskId: failedId, status: "failed" });
    await runAction(base, "task.move", { taskId: todoId, status: "todo" });
    await runAction(base, "task.archive", { taskId: archivedId });

    // ---- 详情/分页/提案样例（issue #12）：经公开 store 缝构造线程、turns、证据、摘要、提案 ----
    // turns/证据/lineage 一律走 commitSourceScan 单一写通道（同生产 reader 落库：域广播随事务发生，
    // 无需事后手动补 touch）；摘要走 addThreadSummary 公开缝
    const daemonStore = daemon!.store;
    const now = daemonStore.now();
    const detailTaskId = await createTask(base, { title: "详情样例", status: "todo" });
    const detailSourceId = "src_ui";
    // lastOrdinal 之后各轮 completed，最后一轮携带 lastStatus；再次调用（追加 turn）即生产同款增量补扫
    const commitDetailScan = (lastOrdinal: number, lastStatus: "completed" | "running"): void => {
      daemonStore.commitSourceScan({
        source: {
          sourceId: detailSourceId,
          path: "/tmp/ui-fixture/rollout-th_detail_ui.jsonl",
          threadId: "th_detail_ui",
          inode: 900_001,
          size: 1024 + lastOrdinal,
          mtime: now,
          consumedBytes: 4096 + lastOrdinal * 16,
          prefixHash: "ui-fixture-prefix",
          tailHash: `ui-fixture-tail-${lastOrdinal}`,
          nextOrdinal: lastOrdinal + 1,
          parserVersion: 1,
          rewritten: false,
        },
        threads: [{
          id: "th_detail_ui",
          harnessId: "codex",
          nativeSessionId: "th_detail_ui",
          nativeStatus: lastStatus,
          title: "详情样例线程",
          workspace: "/tmp/ws",
          nativeGroup: "user",
          sourcePath: "/tmp/ui-fixture/rollout-th_detail_ui.jsonl",
          sourceByteStart: 0,
          sourceRecordHash: "a".repeat(64),
          lastActivityAt: now,
        }],
        turns: Array.from({ length: lastOrdinal + 1 }, (_, ordinal) => ({
          id: `turn_ui_${ordinal}`,
          threadId: "th_detail_ui",
          ordinal,
          nativeStatus: ordinal === lastOrdinal ? lastStatus : "completed",
          startedAt: now - 1000 + ordinal,
          endedAt: now - 900 + ordinal,
          sourceRef: detailSourceId,
          sourceByteStart: ordinal * 16,
          sourceRecordHash: `turn-hash-${ordinal}`,
        })),
        evidence: [0, 1, 2].map((n) => ({
          threadId: "th_detail_ui",
          sourceId: detailSourceId,
          byteStart: n * 10,
          recordHash: `h_${n}`,
          turnOrdinal: 0,
          kind: "message",
          summary: `证据摘录 ${n}`,
          props: null,
        })),
        supersedeEvidence: false,
        rebuildTurns: false,
        anomalies: [],
        resolveAnomalies: false,
        summaries: [],
        lineage: [],
      });
    };
    commitDetailScan(51, "running");
    daemonStore.bindThread(detailTaskId, "th_detail_ui");
    daemonStore.addThreadSummary({
      threadId: "th_detail_ui",
      provenance: "compacted",
      text: "压缩基线：前 40 轮摘要",
      sourceRef: "compacted-record-hash",
      byteStart: 2048,
      recordHash: "compacted-record-hash",
    });
    daemonStore.commitSourceScan({
      source: {
        sourceId: "src_ui_lineage",
        path: "/tmp/ui-fixture/rollout-lineage.jsonl",
        threadId: "th_detail_ui",
        inode: 900_002,
        size: 512,
        mtime: now,
        consumedBytes: 256,
        prefixHash: "ui-fixture-lineage",
        tailHash: null,
        nextOrdinal: null,
        parserVersion: 1,
        rewritten: false,
      },
      threads: [{ id: "th_parent_ui", harnessId: CODEX_HARNESS_ID, nativeStatus: "completed", title: "父线程", lastActivityAt: now - 5000 }],
      turns: [],
      evidence: [],
      supersedeEvidence: false,
      rebuildTurns: false,
      anomalies: [],
      resolveAnomalies: false,
      summaries: [],
      lineage: [{ threadId: "th_detail_ui", parentThreadId: "th_parent_ui", relation: "fork" }],
    });
    const answer = (recommended: string, confidence: number): Record<string, unknown> => ({
      ok: true,
      answer: {
        needsAttention: false,
        progress: "第 52 轮执行中",
        summaryShort: recommended === "mark_done" ? "验收标准已满足，建议标记完成" : "仍在推进，无需动作",
        candidates: [
          { action: recommended, reasonShort: "评估摘因", risk: "low", evidenceRefs: ["ev_ui_0"] },
          { action: "no_op", reasonShort: "保持现状", risk: "low", evidenceRefs: [] },
        ],
        recommended,
        confidence,
      },
      model: null,
      effort: null,
    });
    const acceptTarget = daemonStore.addProposal({
      threadId: "th_detail_ui",
      taskId: detailTaskId,
      evidenceFingerprint: "t0:ui-",
      payload: answer("mark_done", 0.7),
    });
    const rejectTarget = daemonStore.addProposal({
      threadId: "th_detail_ui",
      taskId: detailTaskId,
      evidenceFingerprint: "t0:ui-",
      payload: answer("no_op", 0.6),
    });
    // Inbox 待绑定线程（无绑定 → 进 Inbox；移动宽度里完成绑定流程）
    daemonStore.upsertThread({ id: "th_inbox_ui", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", title: "待绑定线程", lastActivityAt: now });
    // 删除确认展示样例：带子任务与绑定线程的任务
    const doomedParentId = await createTask(base, { title: "待删除父任务", status: "backlog" });
    const doomedChildId = await createTask(base, { title: "悬空子任务", status: "backlog" });
    await runAction(base, "task.update", { taskId: doomedChildId, parentId: doomedParentId });
    daemonStore.upsertThread({ id: "th_doomed_ui", harnessId: CODEX_HARNESS_ID, nativeStatus: "idle", title: "待删样例线程", lastActivityAt: now });
    daemonStore.bindThread(doomedParentId, "th_doomed_ui");

    let browser;
    try {
      browser = await chromium.launch();
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      if (process.env["CI"] === "true" || process.env["TASKBOARD_REQUIRE_BROWSER"] === "1") {
        throw new Error(
          `Playwright 浏览器不可用，而当前环境要求真跑（CI / TASKBOARD_REQUIRE_BROWSER=1）：${detail}。` +
            "CI 里请先 `pnpm exec playwright install --with-deps chromium`。",
        );
      }
      console.log(`SKIP: Playwright 浏览器不可用（${detail}）`);
      console.log("      可运行 `pnpm exec playwright install chromium` 后重试。");
      return 0;
    }
    try {
      // 页面运行时错误收进数组、检查点统一断言：监听器内 throw 不会让主流失败，
      // 只会变成无关报错或被 Playwright 吞掉（XSS 回归正是要靠这里兜住）
      const pageErrors: string[] = [];
      const page = await browser.newPage();
      page.on("dialog", (dialog) => void dialog.accept());
      page.on("pageerror", (error) => {
        pageErrors.push(String(error));
      });

      // ---- 桌面宽度：五列、卡片、CSP ----
      const response = await page.goto(base, { waitUntil: "domcontentloaded" });
      const csp = response?.headers()["content-security-policy"] ?? "";
      if (!csp.includes("script-src 'self'")) throw new Error(`CSP missing script-src 'self': ${csp}`);
      ok("静态入口带 CSP（script-src 'self'）");

      await page.getByTestId("board").waitFor();
      for (const status of ["backlog", "todo", "running", "done", "failed"]) {
        await page.getByTestId(`column-${status}`).waitFor();
      }
      ok("五列齐备");
      if ((await page.getByTestId(`column-backlog`).getAttribute("data-count")) !== "4") {
        throw new Error("backlog 应有 4 张卡片（含 XSS 样本与删除样例）");
      }
      ok("五列计数正确（API 构造的未归档任务各就各位）");

      const observedSession = page.getByTestId("observed-session-th_detail_ui");
      await observedSession.waitFor();
      const observedText = (await observedSession.textContent()) ?? "";
      for (const expected of ["codex", "详情样例线程", "/tmp/ws", "rollout-th_detail_ui.jsonl", "codex:rollout-jsonl@"]) {
        if (!observedText.includes(expected)) throw new Error(`观察会话卡片缺少 ${expected}: ${observedText}`);
      }
      ok("Codex 固定 fixture 显示为只读观察卡片（workspace/status/provenance/source）");

      // 看板可见即自动登记判定（非 force）；chip/原因/置信度都来自 SSE 收敛后的 state
      const semanticChip = observedSession.getByTestId("semantic-status-th_detail_ui");
      await semanticChip.filter({ hasText: "进行中" }).waitFor();
      const sessionVerdict = observedSession.getByTestId("session-verdict-th_detail_ui");
      const sessionVerdictText = (await sessionVerdict.textContent()) ?? "";
      for (const expected of ["条证据", "置信 90%"]) {
        if (!sessionVerdictText.includes(expected)) throw new Error(`观察卡判定行缺少 ${expected}: ${sessionVerdictText}`);
      }
      ok("观察卡显示 SystemOne 语义 chip、原因与置信度");

      // F5（#43 r1 返工）：从观察卡打开的详情是 Phase 1 只读切片——不得渲染提案执行入口
      // （th_detail_ui 挂有 pending 提案；manage 路径下该区渲染，readOnly 路径整段隐藏）
      await observedSession.getByTestId("open-observed-session-th_detail_ui").click();
      const detailPanel = page.getByTestId("thread-detail-panel");
      await detailPanel.waitFor();
      await detailPanel.getByTestId("thread-summaries").waitFor();
      const observedSourceRow = detailPanel.getByTestId("thread-source-row");
      await observedSourceRow.waitFor();
      if (((await observedSourceRow.textContent()) ?? "").includes("rollout-th_detail_ui.jsonl") === false) {
        throw new Error("观察详情应先证明打开的是 th_detail_ui，再断言无提案");
      }
      ok("观察详情正确锚定 th_detail_ui");
      const verdictPanel = detailPanel.getByTestId("thread-verdict");
      await verdictPanel.waitFor();
      await verdictPanel.getByTestId("verdict-status").filter({ hasText: "进行中" }).waitFor();
      const verdictText = (await verdictPanel.textContent()) ?? "";
      for (const expected of [
        "systemone:magpie/typesafe/jev-latest@progress-p1.0",
        "置信 90%",
        "证据引用 1",
        "条证据",
      ]) {
        if (!verdictText.includes(expected)) throw new Error(`语义判断面板缺少 ${expected}: ${verdictText}`);
      }
      ok("详情语义判断面板：状态/原因/置信度/provenance/证据引用");

      const callsBeforeRefresh = magpie.calls();
      await verdictPanel.getByTestId("verdict-refresh").click();
      let refreshed = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (magpie.calls() > callsBeforeRefresh) {
          refreshed = true;
          break;
        }
        await sleep(50);
      }
      if (!refreshed) throw new Error("刷新判断未触发 Magpie 调用");
      ok("刷新判断强制绕过缓存调用 Magpie");
      if ((await detailPanel.getByTestId("thread-proposals").count()) !== 0) {
        throw new Error("Phase 1 观察详情不得渲染提案区（含 proposal.accept 执行入口）");
      }
      if ((await detailPanel.getByTestId("proposal-accept").count()) !== 0) {
        throw new Error("Phase 1 观察详情不得暴露 proposal.accept");
      }
      ok("观察卡详情为只读：摘要/证据可见，无提案执行入口");
      await detailPanel.getByTestId("detail-close").click();
      await detailPanel.waitFor({ state: "detached" });

      // 卡片信息：绑定线程占位、摘要状态、最近活动、Markdown 白名单渲染
      const loginCard = page.getByTestId(`card-${backlogId}`);
      await loginCard.getByTestId("thread-info").filter({ hasText: "未绑定线程" }).waitFor();
      if (((await loginCard.textContent()) ?? "").includes("无摘要") === false) throw new Error("卡片应显示摘要状态");
      await loginCard.locator("details.card-prompt > summary").click();
      await loginCard.locator(".markdown strong").filter({ hasText: "登录表单" }).waitFor();
      ok("卡片展示最近活动、绑定线程、摘要状态与白名单 Markdown");

      // 动态文本转义：XSS 样本不得执行，只以文本出现（payload 写 1，检测侧按 ===1 对齐）
      const xssCard = page.getByTestId(`card-${xssId}`);
      await xssCard.waitFor();
      const xssFired = await page.evaluate(() => (window as { __xss?: number }).__xss === 1);
      if (xssFired) throw new Error("XSS 样本被执行：转义失效");
      ok("动态文本安全转义（onerror/script 未执行）");

      // ---- 搜索 ----
      await page.getByTestId("search-input").fill("登录页");
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid^="card-t_"]').length === 1,
      );
      ok("搜索过滤（标题命中唯一卡片）");
      await page.getByTestId("search-input").fill("auth");
      await page.waitForFunction(() => {
        const cards = document.querySelectorAll('[data-testid^="card-t_"]');
        return cards.length === 1 && cards[0]?.textContent?.includes("编写登录页");
      });
      ok("搜索命中标签");
      await page.getByTestId("search-input").fill("");

      // ---- workspace 分区 ----
      await page.getByTestId("workspace-filter").selectOption("/repo/beta");
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid^="card-t_"]').length === 1,
      );
      await page.getByTestId("workspace-group").waitFor();
      await page.getByTestId("workspace-filter").selectOption("");
      ok("workspace 过滤命中唯一卡片（过滤后恢复全部）");

      // ---- 紧凑模式持久化（视图状态只存浏览器本地）----
      const compactToggle = page.getByTestId("compact-toggle");
      await compactToggle.click();
      if ((await compactToggle.getAttribute("aria-pressed")) !== "true") throw new Error("紧凑模式未生效");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("board").waitFor();
      if ((await page.getByTestId("compact-toggle").getAttribute("aria-pressed")) !== "true") {
        throw new Error("紧凑模式重载后丢失（应存 localStorage）");
      }
      ok("紧凑模式切换且重载后保持（localStorage）");
      await page.getByTestId("compact-toggle").click();

      // ---- 手动移动（经 SSE 收敛回看板）----
      await page.getByTestId(`card-${todoId}`).getByTestId("move-select").selectOption("done");
      await page.getByTestId(`column-done`).getByTestId(`card-${todoId}`).waitFor();
      ok("手动移动经 SSE 更新落列");

      // ---- 归档折叠区（与五列正交）----
      await page.getByTestId(`card-${todoId}`).getByTestId("archive-button").click();
      await page.getByTestId("archive-toggle").click();
      await page.getByTestId("archive-section").getByTestId(`card-${todoId}`).waitFor();
      ok("归档进入折叠区，不占列");
      await page.getByTestId("archive-section").getByTestId(`card-${todoId}`).getByTestId("archive-button").click();
      // unarchive 保持归档前列（done），不重置状态
      await page.getByTestId(`column-done`).getByTestId(`card-${todoId}`).waitFor();
      ok("取消归档回到原列");

      // ---- 删除（确认对话自动接受）----
      await page.getByTestId(`card-${todoId}`).getByTestId("delete-button").click();
      await page.getByTestId(`card-${todoId}`).waitFor({ state: "detached" });
      ok("删除流程（确认后移除）");

      // ---- SSE 实时收敛：页面开着，外部写库任务自动出现 ----
      const liveId = await createTask(base, { title: "外部新建的任务" });
      await page.getByTestId(`card-${liveId}`).waitFor();
      ok("SSE 按域重拉：外部变更即时出现");

      // ---- 线程详情：turn 时间线分页、摘要 provenance、证据、lineage（A4/A31/故事 10/57）----
      await page.getByTestId(`card-${detailTaskId}`).getByTestId(`open-thread-th_detail_ui`).click();
      await page.getByTestId("thread-detail-panel").waitFor();
      const statusRow = page.getByTestId("thread-status-row");
      if (((await statusRow.textContent()) ?? "").includes("原生 运行中") === false) {
        throw new Error("线程详情应显示原生状态（running）");
      }
      await page.getByTestId("thread-semantic-status").filter({ hasText: "进行中" }).waitFor();
      const sourceRow = page.getByTestId("thread-source-row");
      await sourceRow.waitFor();
      if (((await sourceRow.textContent()) ?? "").includes("rollout-th_detail_ui.jsonl") === false) {
        throw new Error("线程详情应显示 source locator");
      }
      ok("线程详情显示跨 Harness 身份与 source locator");
      // 首页 50/52：cursor 分页载荷的直接消费
      const timelineHead = page.getByTestId("turn-timeline").locator("h3");
      await timelineHead.filter({ hasText: "已载 50/52" }).waitFor();
      ok("线程详情打开：turn 时间线首页 50/52（契约分页载荷）");
      await page.getByTestId("thread-detail-panel").getByText("摘要:compacted").waitFor();
      await page.getByTestId("thread-detail-panel").getByText("压缩基线：前 40 轮摘要").waitFor();
      if (((await page.getByTestId("thread-summaries").textContent()) ?? "").includes("#compacted-re") === false) {
        throw new Error("原生摘要应显示 record hash 来源");
      }
      ok("多轮摘要带 provenance 与来源定位（compacted）");
      const evidenceSection = page.getByTestId("thread-evidence");
      if ((await evidenceSection.getByTestId("evidence-item").count()) !== 3) {
        throw new Error("证据应装满 3 条（少于页大小，无翻页）");
      }
      if ((await evidenceSection.getByTestId("load-more-evidence").count()) !== 0) {
        throw new Error("证据全部装载后不应还有加载更多按钮");
      }
      ok("证据列表装载且无多余翻页");

      // 分页加载更多：52/52 后按钮消失
      await page.getByTestId("load-more-turns").click();
      await timelineHead.filter({ hasText: "已载 52/52" }).waitFor();
      if ((await page.getByTestId("load-more-turns").count()) !== 0) {
        throw new Error("turn 全部装载后不应还有加载更多按钮");
      }
      ok("turn 分页加载更多直至耗尽");

      // A31：详情开着，reader 侧新 turn 落库 → threads 域 revision → 详情自动重拉收敛
      // （同生产写路径的增量补扫：commitSourceScan 事务内自带 threads 域 touch 触发广播）
      commitDetailScan(52, "completed");
      // 重拉窗口覆盖用户已翻页的 52 条，新 turn 顺带取入：52/52 → 53/53 全程无需用户操作
      await timelineHead.filter({ hasText: "已载 53/53" }).waitFor();
      if ((await page.getByTestId("load-more-turns").count()) !== 0) {
        throw new Error("新 turn 取入后不应还有加载更多按钮");
      }
      ok("SSE 按域重拉下详情收敛（新 turn 计数即时反映）");

      // Jev 提案：置信度/风险/原因 + 接受链路（mark_done → 任务进 done + 执行链展示）
      await page.getByTestId(`proposal-${acceptTarget.id}`).getByTestId("proposal-confidence").filter({ hasText: "70%" }).waitFor();
      await page.getByTestId(`proposal-${acceptTarget.id}`).getByTestId("candidate-mark_done").waitFor();
      await page.getByTestId(`proposal-${acceptTarget.id}`).getByTestId("proposal-accept").click();
      await page.getByTestId(`proposal-${acceptTarget.id}`).getByTestId("proposal-execution").waitFor();
      await page.getByTestId("thread-detail-panel").getByText("已接受").waitFor();
      ok("提案接受：执行链展示（mark_done）");
      await page.getByTestId("detail-close").click();
      await page.getByTestId(`column-done`).getByTestId(`card-${detailTaskId}`).waitFor();
      ok("接受 mark_done 提案经 SSE 把任务移入 done 列");

      // lineage fork 关联：点击跳父线程（放最后：抽屉会被替换）
      await page.getByTestId(`card-${detailTaskId}`).getByTestId(`open-thread-th_detail_ui`).click();
      await page.getByTestId("thread-detail-panel").waitFor();
      await page.getByTestId("lineage-parents").getByTestId("lineage-link").filter({ hasText: "fork" }).click();
      await page.getByTestId("thread-detail-panel").getByText("父线程").waitFor();
      ok("lineage fork 关联可点击跳转父线程");
      await page.getByTestId("detail-close").click();

      // ---- 任务详情：提案拒绝、绑定/解绑、删除确认展示（故事 5/6/8/55）----
      const dialogMessages: string[] = [];
      page.on("dialog", (dialog) => {
        dialogMessages.push(dialog.message());
        // 顶部已有全局 accept 处理：谁先处理都行，重复 accept 容错
        void dialog.accept().catch(() => undefined);
      });
      await page.getByTestId(`card-${detailTaskId}`).getByTestId(`open-detail-${detailTaskId}`).click();
      await page.getByTestId("task-detail-panel").waitFor();
      await page.getByTestId(`proposal-${rejectTarget.id}`).getByTestId("proposal-reject").click();
      await page.getByTestId(`proposal-${rejectTarget.id}`).getByText("已拒绝").waitFor();
      ok("任务详情：提案拒绝落终态");

      // 绑定 Inbox 线程 → 卡片线程入口更新；再解绑回 Inbox
      await page.getByTestId("bind-thread-select").selectOption("th_inbox_ui");
      await page.getByTestId("bind-thread-button").click();
      await page.getByTestId("task-threads").getByTestId("bound-thread").filter({ hasText: "待绑定线程" }).waitFor();
      ok("绑定线程（从 Inbox 选择）即时出现在详情");
      await page.getByTestId("task-threads").getByTestId("bound-thread").filter({ hasText: "待绑定线程" }).getByTestId("unbind-thread").click();
      await page.getByTestId("task-threads").getByTestId("bound-thread").filter({ hasText: "待绑定线程" }).waitFor({ state: "detached" });
      ok("解绑线程即时从详情移除");

      // 删除确认展示：悬空子任务 + 回 Inbox 提示进确认对话
      await page.getByTestId("task-detail-panel").getByTestId("detail-close").click();
      await page.getByTestId(`card-${doomedParentId}`).getByTestId(`open-detail-${doomedParentId}`).click();
      const doomedTaskPanel = page.getByTestId("task-detail-panel");
      await doomedTaskPanel.waitFor();
      await doomedTaskPanel.getByTestId("task-threads").getByTestId("bound-thread").filter({ hasText: "待删样例线程" }).getByText("待删样例线程").click();
      const noSummaryPanel = page.getByTestId("thread-detail-panel");
      await noSummaryPanel.waitFor();
      await noSummaryPanel.getByTestId("summary-none").filter({ hasText: "原生摘要：none（Harness 未产出 compacted 记录）" }).waitFor();
      ok("无压缩记录线程详情显示 summary-none");
      await noSummaryPanel.getByTestId("detail-close").click();
      await noSummaryPanel.waitFor({ state: "detached" });
      await page.getByTestId(`card-${doomedParentId}`).getByTestId(`open-detail-${doomedParentId}`).click();
      await doomedTaskPanel.waitFor();
      await page.getByTestId("detail-delete").click();
      await page.getByTestId(`card-${doomedParentId}`).waitFor({ state: "detached" });
      const deleteConfirm = dialogMessages.find((message) => message.includes("待删除父任务"));
      if (deleteConfirm === undefined) throw new Error("删除未弹确认对话");
      if (!deleteConfirm.includes("悬空") || !deleteConfirm.includes("Inbox")) {
        throw new Error(`删除确认应展示悬空子任务与回 Inbox 提示：${deleteConfirm}`);
      }
      ok("删除确认展示悬空子任务与回 Inbox 提示（A33 删除流程）");

      // ---- 移动宽度：五列仍可用，搜索可用 ----
      const mobilePageErrors: string[] = [];
      const mobile = await browser.newPage({ viewport: { width: 375, height: 720 } });
      mobile.on("dialog", (dialog) => void dialog.accept());
      // 移动页同样挂 pageerror 监听：此前运行时错误在该页完全不可观测
      mobile.on("pageerror", (error) => {
        mobilePageErrors.push(String(error));
      });
      await mobile.goto(base, { waitUntil: "domcontentloaded" });
      await mobile.getByTestId("board").waitFor();
      for (const status of ["backlog", "todo", "running", "done", "failed"]) {
        await mobile.getByTestId(`column-${status}`).waitFor();
      }
      await mobile.getByTestId("search-input").fill("外部新建");
      await mobile.waitForFunction(
        () => document.querySelectorAll('[data-testid^="card-t_"]').length === 1,
      );
      ok("移动宽度：五列横向可达，搜索可用");

      // ---- 移动宽度：详情抽屉全屏可用，提案确认流程可达（A33）----
      await mobile.getByTestId(`card-${liveId}`).getByTestId(`open-detail-${liveId}`).click();
      await mobile.getByTestId("task-detail-panel").waitFor();
      const panelBox = await mobile.getByTestId("task-detail-panel").boundingBox();
      if (panelBox === null || panelBox.width < 370) {
        throw new Error(`移动宽度下详情抽屉应占满视口（实际 ${panelBox?.width ?? "null"}px）`);
      }
      await mobile.getByTestId("detail-move-select").selectOption("todo");
      await mobile.getByTestId("detail-close").click();
      await mobile.getByTestId(`column-todo`).getByTestId(`card-${liveId}`).waitFor();
      ok("移动宽度：详情抽屉全屏，手动移动生效");
      await mobile.close();

      // 检查点：两页运行时错误必须为空（含 XSS payload 执行类错误）
      if (pageErrors.length > 0 || mobilePageErrors.length > 0) {
        throw new Error(`页面运行时错误：${[...pageErrors, ...mobilePageErrors].join(" | ")}`);
      }
    } finally {
      await browser.close();
    }
    console.log(`test:ui PASS (${passed} checks)`);
    return 0;
  } finally {
    await daemon?.close();
    await magpie.close();
    await rm(dir, { recursive: true, force: true });
    await rm(codexHomeDir, { recursive: true, force: true });
  }
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`test:ui FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
