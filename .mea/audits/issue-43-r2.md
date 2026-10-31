# Issue #43 S2 独立审计（r2）

- Issue: https://github.com/jasonQin6/taskboard/issues/43
- Base SHA: `379505ba35e454f8bdf638427d24092a20bb7c8e`
- Target SHA: `d368df6f353e313043ca87c7c4df4510ce59954a`
- Reviewed HEAD: `d368df6f353e313043ca87c7c4df4510ce59954a`
- Branch: `harness/codex`
- Domain review: `not-required`

## 结论

`verdict_inputs: green`

F1、F4、F5 已闭合；F2、F3 的实现行为已闭合，但新增测试仍留下可证实的盲点。未发现新的 Critical/High，精确 target 的全部必跑验收通过，r2 交付中的数字与当前现场一致。F6–F10 仍按 r1 的 Medium/Low 分流保留，没有改判为阻塞项。

## 现场与范围

- 开工时 `git status --porcelain=v1` 为空，`git rev-parse HEAD` 为 target，branch 为 `harness/codex`。
- `base..target` 只有一个 commit：`fix(harness): close issue 43 audit blockers (#43)`。
- 修复 diff 为 6 个文件：`scripts/ui-smoke.ts`、`src/http.ts`、`src/store/thread-store.ts`、`test/thread-locator.test.ts`、`web/src/App.tsx`、`web/src/components/ThreadDetailView.tsx`；与 r2 声明的范围一致，`src/views.ts` 的 `runtime.manifests` 已由 base 带入，target 未再次修改。

## 验收命令

| # | 命令 | Exit | 结果 | 证据 |
|---|---|---:|---|---|
| A1 | `git rev-parse HEAD` + `git status --porcelain=v1` | 0 | PASS | HEAD 精确为 target；tracked worktree clean |
| A2 | `pnpm exec tsx --test test/thread-locator.test.ts test/tool-contract.test.ts` | 0 | PASS | tests 10 / pass 10 / fail 0 / skipped 0 |
| A3 | `pnpm test` | 0 | PASS | tests 435 / pass 434 / fail 0 / skipped 1 |
| A4 | `pnpm typecheck` | 0 | PASS | 根、scripts、web 三套 `tsc --noEmit` 均通过 |
| A5 | `pnpm test:ui` | 0 | PASS | `test:ui PASS (31 checks)` |
| A6 | `git diff --check 379505ba35e454f8bdf638427d24092a20bb7c8e..d368df6f353e313043ca87c7c4df4510ce59954a` | 0 | PASS | 无 whitespace error |

## 变异与反证

所有变异均在 `/tmp/taskboard-audit43-r2-work.25gNip` 的 target `git archive` 副本中执行，未修改 lane 的 tracked 文件。

| # | 变异/反证 | Exit | 结果 | 判断 |
|---|---|---:|---|---|
| M1 | 把分页 turn path 全部改回线程 identity fallback | 1 | F2 测试失败，`t-a.sourcePath` 从 A 变成 B | 分页路径断言有效 |
| M2 | 只把 `latestTurn` 改回 identity fallback | 0 | F2 测试仍通过，因为 fixture 的 latest turn 与线程最新 source 同为 B | **测试盲点** |
| M3 | 把 F3 的 CASE 整体退回 `COALESCE(old, excluded)` | 1 | F3 测试失败，实际仍为 A 的 byte/hash | 主重放回归可被捕获 |
| M4 | 把 F3 的 `IS NOT` 改成 NULL 不安全的 `<>` | 0 | F3 测试仍通过；A→B 两列均非空，未覆盖 NULL 旧行 | **边界测试盲点** |
| M5 | 额外执行三条临时边界断言：旧 locator 为 NULL、目标 locator 为 NULL、同 source 增量窗口 | 0 | 3/3 PASS | 当前 SQL 行为正确 |
| M6 | 把 summary NULL 分支改为回退首个 rollout path | 1 | F4 测试失败，实际返回 `/tmp/rollout.jsonl` | F4 断言有效 |
| M7 | 移除 Phase 1 只读保护，使提案区始终渲染 | 1 | UI 在 `thread-proposals` 负向断言处失败 | F5 主保护断言有效 |
| M8 | 让观察卡始终打开错误的无提案线程 | 0 | 完整 UI 仍 `PASS (31 checks)` | **F5 负向断言未锚定正确线程** |

## F1–F5 处置

| Finding | 状态 | 证据 |
|---|---|---|
| F1 Critical：`runtime.manifests` 契约 | 已闭合 | `src/views.ts:286` 注入 `capabilityManifests()`；精确 target 契约测试 10/10 通过 |
| F2 High：多 source turn path | 行为已闭合，测试有 Medium 盲点 | `src/http.ts:128` 与 `src/http.ts:164` 均按 `sourceRef` 解析；M1 会红，M2 证明 `latestTurn` 单独回退仍绿 |
| F3 High：跨 source 重放三元组 | 行为已闭合，边界测试有 Medium 盲点 | `src/store/thread-store.ts:786` 使用 NULL-safe `IS NOT` 并在 source 变化时整体替换；M3 会红，M4 证明 NULL 旧行回归仍绿 |
| F4 High：`sourceId=null` 的 summary path | 已闭合 | `src/http.ts:83` 对 NULL 恒返回 NULL；detail/list 都被 M6 的回归打红 |
| F5 High：Phase 1 观察详情提案入口 | 行为已闭合，负向断言有 Medium 盲点 | `web/src/App.tsx:168` 传 `readOnly`，`ThreadDetailView.tsx:246` 隐藏整段 proposal UI；M7 会红，任务详情既有 accept/reject 在后续 UI 流程仍通过 |

## F6–F10 状态

| Finding | r2 状态 | 说明 |
|---|---|---|
| F6 Medium：source rewrite 后 summary locator 过期 | 仍存在 | 本 diff 未改 summary upsert/失效路径 |
| F7 Medium：增量窗口的 summary 覆盖边界可能为空/低估 | 仍存在 | 本 diff 未改 `parse.ts` 覆盖计算 |
| F8 Medium：新测试未证明坏行后仍可读、无摘要 UI `none` | 部分改善但仍存在 | 新增 locator 测试有效；坏行后置记录和 UI `none` 仍未直接断言 |
| F9 Low：`sourceByteStart` 起点/终态降级语义混杂 | 仍存在 | 本 diff 未改字段语义 |
| F10 Low：V8 回填没有自动回归测试 | 仍存在 | 本 diff 未改迁移测试 |

## Standards Review

结论：`pass-with-follow-ups`

- 硬标准“补测试要证明能红”仍有缺口：F2 的 `latestTurn` 分支、F3 的 NULL/旧行/增量边界、F5 的“打开正确观察线程”均存在已复现的假绿。
- 未新增 `Record<string, ...>` 动态键分发；`ReadonlyMap` 用法安全。
- `src/http.ts` 的 summary locator 字段仍在 detail/list 两处重复，属于低优先级 Duplicated Code，不是本次阻塞。
- 任务卡和任务详情的既有 manage 入口继续显示 proposal 属于明确保留的非 Phase 1 路径，不计 F5 回归。
- 用户指定的 `docs/agents/review-standards.md` 在 exact target 中不存在；审查依据主整合 worktree 同文件副本执行，规则版本差异列为残余风险。

## Spec Review

结论：`pass-with-follow-ups`

- PASS：Phase 1 turn locator、summary NULL 降级、观察详情零 proposal，以及非 Phase 1 manage 路径不回归。
- PASS：本修复未增加 Codex JSONL、配置或历史数据库写入路径。
- PASS：ADR-0005 的终态判定未被本 diff 改变。
- PASS：交付声明的测试数量、UI 数量、typecheck 与 F5 主变异结果均可复现。
- FOLLOW-UP：F2/F3/F5 的测试没有覆盖各自最容易单独回归的接线；属于 Medium 测试证据缺口，不是当前实现缺陷。

## OCR

- 命令：`ocr review --audience agent --background-file /tmp/issue43-r2-ocr-background.md --from 379505ba35e454f8bdf638427d24092a20bb7c8e --to d368df6f353e313043ca87c7c4df4510ce59954a`
- Exit: 0；状态 complete；5 个文件、3 条 finding、约 744870 tokens、3m20s。
- Medium：`scripts/ui-smoke.ts:258-259` 只等摘要区出现就做否定断言，未先核对面板属于 `th_detail_ui`；这与 M8 的独立反证一致。
- Low：`scripts/ui-smoke.ts:260-265` 的 absence 查询作用于整页而非 `thread-detail-panel`。
- Low：`scripts/ui-smoke.ts:266-267` 关闭详情后未等待面板 hidden，存在后续步骤偶发遮挡风险。
- OCR 仅作为额外发现源，未作为唯一结论依据。

## Claim Integrity

`clean`

- r2 声明 10/10、435/434/0/1、typecheck 0、UI 31 与精确 target 实测一致。
- F5 主保护变异确实会打红 UI；本轮又独立发现“打开错误线程仍绿”，这是测试覆盖缺口，不是交付数字或测试结果造假。
- F6–F10 未处理、`src/views.ts` 的 manifests 来自既有 lane 状态，均如实披露。

## Findings

### F2-r2 — medium — `latestTurn` 回归不会被新增测试发现

- location: `test/thread-locator.test.ts:130`, `src/http.ts:128`
- category: test / false green
- evidence: fixture 的 latest turn 来自 B，线程最新 source 也是 B；只把 `latestTurn` 回退到 identity path，F2 测试仍 1/1 通过。
- recommendation: 构造 latest turn 位于 A、线程 identity 已指向 B 的场景，或在现有 fixture 中让 latest turn 的来源与线程最新 source 分离。

### F3-r2 — medium — F3 未锁住 NULL/旧行/增量边界

- location: `test/thread-locator.test.ts:142`, `src/store/thread-store.ts:786`
- category: test / false green
- evidence: 现有用例只有 A→B 且两端 locator 非空；把 NULL-safe `IS NOT` 改成 `<>` 后测试仍通过。额外临时断言确认当前实现在三种边界上行为正确。
- recommendation: 增加旧 `source_ref=NULL`、新 locator 为 NULL、同 source 增量窗口三条断言。

### F5-r2 — medium — 只读负向断言可被“打开错误线程”假绿

- location: `scripts/ui-smoke.ts:257`, `web/src/App.tsx:168`
- category: test / false green
- evidence: 变异为观察卡始终打开 `th_inbox_ui` 后，完整 UI 仍 `PASS (31 checks)`；该线程没有 proposals，因此 absence 断言不能证明打开的是 `th_detail_ui`。
- recommendation: 在否定断言前核对 `thread-source-row` 含 `rollout-th_detail_ui.jsonl` 或固定线程 identity。

### OCR-r2 — low — 只读 absence 查询未限定面板

- location: `scripts/ui-smoke.ts:260`
- category: test precision
- evidence: `page.getByTestId("thread-proposals")` / `proposal-accept` 查询整页，而非刚打开的 `thread-detail-panel`。
- recommendation: 先保存面板 locator，再在面板内做两个 `.count()` 断言。

### OCR-r2 — low — 关闭详情后未等待 hidden

- location: `scripts/ui-smoke.ts:267`
- category: test flake
- evidence: 点击 `detail-close` 后立即继续操作底层卡片。
- recommendation: 等待 `thread-detail-panel` 状态为 hidden/detached。

## Uncovered Risks

- 同一 source unit 内 `thread_id` 改变但 `source_ref` 不变时，现有 CASE 不会替换 byte/hash；未找到确定的真实可达链，但也没有测试封锁该边界。
- `.jsonl.zst` 的逻辑字节 offset 与消费者如何从压缩文件回源仍未覆盖。
- F6–F10 的 source rewrite、增量 summary 覆盖、坏行后置记录、字段语义与 V8 回填风险仍在。
- `pnpm test:ui` 在 Playwright 浏览器不可用时会 `return 0`；本轮浏览器可用且实跑 31 checks，但 CI 配置若不保证浏览器，仍可能跳过。
- exact target 缺少 `docs/agents/review-standards.md`；本轮使用主整合 worktree 副本，不能证明两条 lane 的审查规则逐字一致。

## Verdict Inputs

- `green`

Gate 理由：

1. 必跑验收全部 exit 0。
2. F1–F5 的实现行为均正确，F4/F5 主回归可被测试打红。
3. 未发现新的 Critical/High；剩余项为 Medium/Low 测试质量与已知分流风险。
4. 交付声明与实际命令结果一致，`claim_integrity` 为 clean。
