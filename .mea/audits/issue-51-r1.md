# MEA Audit Report — Issue #51

- Issue: original-repository issue #51
- base_sha: `9e4b366d97f6deb36b001096600899bf8cc4fb4a`
- target_sha: `293ce9c1d4ccf8b10d52974d4ded6afb5e70b8df`
- reviewed target SHA: `293ce9c1d4ccf8b10d52974d4ded6afb5e70b8df`
- reviewed implementation commit: `ddfd3eeea83ef15bbd771554b1904ab6f246b3fe`
- report commit: target 的唯一直接子提交；除本报告外不携带其他变更

## 1. 结论

**verdict_inputs: green**

**claim_integrity: clean**

全部 issue 验收项与 brief 重点均通过；五项关键变异验证均按预期变红。发现 1 项 low 稳定性建议与 2 项 coverage/unavailable 风险，均不阻断本 target。

## 2. 审计前置与代码范围

- 主检出：`issue-51-test-hardening`，`git rev-parse HEAD` = `293ce9c1d4ccf8b10d52974d4ded6afb5e70b8df`；审计开始与报告前 `git status --porcelain=v1` 为空。
- `git merge-base --is-ancestor 9e4b366… 293ce9c…` exit 0。
- `base..target` 变更：`scripts/ui-smoke.ts`、`test/codex-detail.test.ts`、`test/thread-locator.test.ts`、`docs/retros/2026-10-29-1038-issue-51.md`。
- 实现提交 `ddfd3ee` 只改 issue 允许的 `test/` 与 `scripts/ui-smoke.ts`；target 增量提交 `293ce9c` 是 brief 中实现者自己产出的 retro 文档，属交付约定的 target 组成，不构成越界产品代码变更。

## 3. Acceptance 验证

环境：主 lane worktree；node v26.9.0，pnpm 11.21.0。变异验证均在 `/tmp/issue51-aud-target` 的 `git archive target` 只读副本中执行，只改动副本源码，不触碰 lane tracked files；副本用 `node_modules` symlink 并以 `pnpm --config.verify-deps-before-run=false` 运行。

| ID | 验收项 | 命令 | Exit | 结果 |
|---|---|---:|---:|---|
| A1 | 工作区前置 | `git rev-parse HEAD`; `git status --porcelain=v1` | 0 | PASS：HEAD 精确等于 target；clean |
| A2 | `pnpm test` | `pnpm test` | 0 | PASS：tests 515 / pass 514 / fail 0 / skipped 1；与声明一致 |
| A3 | `pnpm typecheck` | `pnpm typecheck` | 0 | PASS：root、scripts、web 三段通过 |
| A4 | `pnpm test:ui` | `pnpm test:ui` | 0 | PASS：浏览器实际执行，`test:ui PASS (36 checks)`；与声明一致 |
| A5 | targeted 回归 | `pnpm exec tsx --test test/thread-locator.test.ts test/codex-detail.test.ts` | 0 | PASS：tests 9 / pass 9 / fail 0 |
| A6 | M1 latestTurn 单独回退 identity | archive copy：`src/http.ts` `turnSourcePath` 改为恒回退 `fallback`；targeted tests | 1 | PASS：F2 红；`sourcePath /tmp/B.jsonl` vs expected `/tmp/A.jsonl`（thread-locator.test.ts:126） |
| A7 | M2 NULL-safe `IS NOT` 回退 `<>` | archive copy：thread-store 两处比较替换；targeted tests | 1 | PASS：`F3: a null old locator…` 红；`sourceRef=srcB` 配旧 `byteStart=10`、`recordHash=hashA`（thread-locator.test.ts:173） |
| A8 | M3 跨 source 目标 locator 回退旧值 | archive copy：`CASE ... THEN excluded.*` 改 `THEN thread_turns.*`；targeted tests | 1 | PASS：既有 F3 交叉 replay 红且两个新 F3 边界红 |
| A9 | M4 坏行后停止解析 | archive copy：`src/reader/parse.ts` bad-line `continue` 改 `break`；targeted tests | 1 | PASS：bad-line detail 测试红，缺 `坏行之后仍可读` |
| A10 | M5 观察卡打开错误线程 | archive copy：fixture 额外注册有 source 的 `th_inbox_ui`，打开按钮改为该线程；`pnpm test:ui` | 1 | PASS：在 proposal absence 前报 `观察详情应先证明打开的是 th_detail_ui` |
| A11 | diff 限界 | `git show --stat ddfd3ee`; `git diff --name-status base..target` | 0 | PASS：见第 2 节 |

补充口径：声明 targeted `9/9` 可由 target 文件的 6 个 locator tests + 3 个 detail tests 复现；issue 新增 test blocks 为 3 个 F3 边界，其余加强发生在既有 F2、F3、bad-line 与 UI smoke 中。

## 4. Standards review

方法声明：`code-review` 要求的并行子代理由本会话作为独立 Auditor 直接完成；以 `docs/agents/review-standards.md` 为标准源（目标树内该路径暂不存在，按 AGENTS.md 主集成分支文档执行）。本 diff 无 Record 动态键、清单镜像或既有行为直测之外的产品代码。

- PASS：补直测均配套“破坏目标接线”的红验证，满足 review-standards 的变异门；M3 额外恢复脚本已确认还原目标 `excluded.*` 语义。
- PASS：F2 fixture 拆开 latest turn 与 thread identity source，M1 失败点定位到 `latestTurn.locator`，不是宽泛页断言。
- PASS：F3 覆盖 NULL old、NULL new、同 source 增量与既有交叉 replay；SQL 的 `IS NOT` + cross-source unit replacement + same-source `COALESCE` 接线与测试语义一致。
- PASS：UI identity 正断言在 absence 前；proposal/accept absence 与 close 均限定 `detailPanel`，close 后等待 detached。
- PASS：bad-line 断言直接核对后置 item 的 summary/kind 顺序。
- PASS：runtime dependency、Phase 1 写路径、数据库写者、原生 turn 终态等 AGENTS.md 不变量未被 diff 破坏。

Low finding（非阻断）：

### F-low-1 task panel close 后可等待 detached

- severity/location/category: low；`scripts/ui-smoke.ts:541`；test stability
- evidence: OCR 指出 task detail close 后直接点击底层 card，没有像本 diff 中两处 thread panel close 一样等待 detached。读当前 UI 源码后判定其建议的 `waitFor({state:"detached"})` 依据不成立：`App.tsx` 用同一个 `detail` selection 渲染 task/thread panel，互斥且 close 后 state 为 null，不会存在旧 task panel 覆盖新 panel 或 stale `task-detail-panel` resolve。该行属于本 diff 的编辑邻域，但 issue 只要求 thread detail 面板的关闭/absence 纪律。
- recommendation: 后续 UI smoke 清理时按同 diff 已有 thread panel 模式补 detached wait，减少点击拦截类偶发；不需要作为本票返工。

## 5. Spec review

对照 issue body、agent brief、`GLOSSARY.md` 与 `docs/spec/phase1-observation-mvp.md`：

| 需求 | 结果 | 证据 |
|---|---|---|
| F2-r2 latestTurn 独立 sourceRef | PASS | A6 红；fixture B identity / A latest turn；A5 绿 |
| F3-r2 NULL 与增量边界 | PASS | 新增三个边界 test；A7、A8 红验证；A5 绿 |
| F5-r2 详情面板身份与 absence 限定 | PASS | A10 精确在 identity assertion 红；`thread-proposals`、`proposal-accept` 均在 `detailPanel` 内查询 |
| OCR-low UI 纪律：close 后 hidden/detached | PASS | observed detail close 后 `waitFor({state:"detached"})` |
| F8 坏 JSON 后置 item | PASS | A4 基线绿，A9 红；直接断言三项 summary/kind |
| F8 `summary-none` | PASS | UI smoke 打开 `th_doomed_ui`，在 thread panel 内等待 `summary-none` 的 exact 文案 |
| 全量验收命令 | PASS | A2-A4 |
| diff 限界 | PASS | A11 |
| scope creep | none | 只新增/收紧 issue 指定测试与 UI 检查；retro 为约定产物 |

Domain review: PASS。`SourceLocator` 按自身 ref 回源符合 glossary；bad line “记录后推进、不阻塞后续” 符合 `Reader anomaly`；summary 缺失如实显示 `none` 符合 Phase 1 验收。

## 6. OCR（open-code-review）

配置路由为 `group/smart-split`（Magpie OpenAI Responses），未覆盖 model/effort。OCR 计划两个互补 pass：

### Pass 1 — backend tests

- 状态：**skipped / unavailable（0 selected）**
- 命令：`ocr review --audience agent --effort medium --timeout 5 --max-tools 50 --background-file /tmp/issue51-ocr-tests-background.md --from 9e4b366... --to 293ce9c... --exclude 'docs/**,scripts/**' --output /tmp/issue51-ocr-tests.txt`
- 前置 preview 失败一次：背景文件尚未创建，ocr exit 1；创建后重跑。
- session id: `f7442a6b-96fe-44b2-aa49-3d0ac32d33e1`
- selected/completed/failed/comments: `0 / 0 / 0 / 0`; output `Review skipped: no items were selected.`
- 根因：OCR 内置 path filter 将 `**/*.test.ts` 排除为 `default_path`（二进制内置清单包含 `**/*.test.{js,jsx,ts,tsx}`）。未改全局或项目 OCR 配置，避免为审计留下持久规则变更。
- 处置：`test/thread-locator.test.ts` 与 `test/codex-detail.test.ts` 不因该 pass 视为已 OCR 审；由本 Auditor 独立读码 + A6/A7/A8/A9 变异反证补足，OCR 结果不作审计结论。

### Pass 2 — WebUI smoke

- 状态：**complete（1 selected / 1 completed / 0 failed / 1 comment）**
- 命令：`ocr review --audience agent --effort medium --timeout 5 --max-tools 50 --background-file /tmp/issue51-ocr-webui-background.md --from 9e4b366... --to 293ce9c... --exclude 'docs/**,test/**' --output /tmp/issue51-ocr-webui.txt`
- session id: `c71b1b8a-3c96-4090-b565-1db67d849933`
- 结果：`scripts/ui-smoke.ts:541` medium test finding，建议 task panel close 后 detached。经当前 UI source 复核降为 F-low-1；OCR 建议代码未照抄。
- unreviewed paths by this pass: none within assigned `scripts/ui-smoke.ts` scope.

## 7. claim_integrity

**clean**

逐字核对：

- `pnpm test`: 515/514/0/1，一致。
- `pnpm typecheck`: 通过，一致。
- `pnpm test:ui`: live browser `PASS (36 checks)`，一致。
- targeted `9/9`，一致。
- 声明六类变异均能红；本审计独立复现五类关键变异（M1、M2、M3、M4、M5D），其中 M2/M3 覆盖 NULL/增量声明，M5D 采用比原始描述更可执行的 `th_inbox_ui` 打开路径并精确命中 identity assertion。
- 未发现夸大、未实现验收或交付数字造假。executor 如实披露 Chromium 不可用时 `test:ui` 会 exit 0 的既有风险；本环境实际可用。

## 8. Findings

| ID | Severity | Location | Category | Evidence | Recommendation |
|---|---|---|---|---|---|
| F-low-1 | low | `scripts/ui-smoke.ts:541` | test stability | OCR 建议 task close 后 detached；当前 selection state 互斥使旧 panel 不会驻留，但统一等待可降低未来 UI 改动下的点击拦截风险 | 后续 UI smoke 清理时补齐 detached wait；非本票 blocker |

无 medium/high/critical finding。

## 9. Uncovered risks

1. **OCR tests pass unavailable**：`test/*.test.ts` 被 OCR 内置 default path filter 排除，session `f7442a6b...` selected 0。这两个测试文件未获得异源 OCR review；以独立读码、绿基线与五项变异反证代偿。
2. **OCR 初次 preview/setup 失败**：首个 backend 调用因背景文件不存在 exit 1，已重跑并记录；不影响 pass 2，但属过程噪声。
3. **`pnpm test:ui` 跳过风险延续**：浏览器不可用时仍可能 exit 0；本轮浏览器可用且跑完 36 checks，CI 门仍需单独保证浏览器。
4. **变异集边界**：未执行与 issue 无直接绑定关系的外加变异（例如 `summary-none` UI 断言删除）；不排除 UI 冒烟其他既有检查仍有假绿。

## 10. verdict_inputs

**green**

依据：A1-A11 全 PASS；Standards/Spec/Domain 通过；OCR pass 2 完成且其发现经复核为 low；OCR pass 1 unavailable 已如实列为 uncovered risk，并且回归红验证提供了独立反证；claim integrity clean。OCR unavailable 不升格为 not-green，因为审计结论不依赖 OCR，且对应文件有可直接复现的行为级红/绿证据。

## 11. Git evidence

提交前将复验并在此记录：

- parent = `293ce9c1d4ccf8b10d52974d4ded6afb5e70b8df`；
- report commit 的 files changed 仅 `.mea/audits/issue-51-r1.md`；
- commit 后 `git status --porcelain=v1` 为空。
