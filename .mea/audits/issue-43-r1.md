# Issue #43 S2 独立审计（r1）

- Issue: original-repository issue #43
- Base SHA: `45ffa341ea07c397468178235921143d9e3f742c`
- Target SHA: `0c7134d30c31b3dd4d4f09964c7639eaca913d34`
- Reviewed HEAD: `0c7134d30c31b3dd4d4f09964c7639eaca913d34`
- Branch: `codex/audit-issue-43-0c7134d`
- Domain review: not-required

## 结论

`verdict_inputs: not-green`

目标 SHA 可构建、UI smoke 通过，核心 turn 终态路径和单 source fixture 正常；但精确 target 的 `pnpm test` 为红，且来源定位在多 source、跨 source 重放、sample 摘要和 source rewrite 下会给出错误或过期的 provenance。WebUI 从观察卡直接进入的详情仍保留提案接受入口，违反 Phase 1 的只读边界。交付声明中的全绿测试结果不成立于该精确 SHA。

## 验收命令

| # | 命令 | Exit | 结果 | 简证 |
|---|---|---:|---|---|
| A1 | `git -C /tmp/taskboard-audit-43 rev-parse HEAD` | 0 | PASS | 输出 `0c7134d30c31b3dd4d4f09964c7639eaca913d34`，与 target 一致 |
| A2 | `pnpm test` | 1 | FAIL | `tests 430 / pass 428 / fail 1 / skipped 1`；`test/tool-contract.test.ts:251` 的 runtime key 缺少 `manifests` |
| A3 | `pnpm typecheck` | 0 | PASS | 根、scripts、web 三个 tsc 配置均通过 |
| A4 | `pnpm test:ui` | 0 | PASS | `test:ui PASS (30 checks)` |
| A5 | `pnpm exec tsx --test test/codex-detail.test.ts` | 0 | PASS | `tests 3 / pass 3 / fail 0` |
| A6 | `pnpm exec tsx --test test/http.test.ts` | 0 | PASS | `tests 21 / pass 21 / fail 0` |
| A7 | `pnpm exec tsx --test test/tool-contract.test.ts` | 1 | FAIL | `tests 7 / pass 6 / fail 1`；与 A2 同一 `runtime.manifests` 缺项 |
| A8 | `git diff --check 45ffa341ea07c397468178235921143d9e3f742c..0c7134d30c31b3dd4d4f09964c7639eaca913d34` | 0 | PASS | 无 whitespace error |

### V8 迁移补充验证

用 V7 schema 手工建库，插入既有 thread、turn、compacted summary，再执行 `applyMigrations`：

- Exit 0，实际 applied versions 为 `[8]`。
- `thread_turns` 新增 `source_byte_start/source_record_hash`；既有 turn 两列均为 `null`，原行仍存在。
- `thread_summaries` 新增 `source_id/byte_start/record_hash/covered_through_turn_ordinal`；既有正文和 `source_ref` 保留，compacted 行的 `record_hash` 从 `source_ref` 回填，其余定位字段为 `null`。
- V8 本身是新增列和兼容回填，没有删除表或列。

### OCR

- 命令：`ocr review --audience agent --background "..." --from 45ffa34 --to 0c7134d --output /tmp/ocr_issue43.txt`
- Exit: 0，但状态为 **partial**。
- 输出：`Review partially complete: 14 finding(s); 6 of 12 selected item(s) failed.`
- WebUI 文件组在 core review 阶段 timed out；其余 OCR 发现已作为额外发现来源与人工审查交叉核对，未替代审计结论。

## Standards Review

`not-green`

- Record 动态键：本 diff 未新增以外部值动态分发的 `Record<string, ...>`，未发现该类原型链键问题。
- 清单对齐：`THREAD_DETAIL_KEYS/TURN_KEYS/SUMMARY_KEYS` 已同步；但 `RUNTIME_KEYS` 单边加入 `manifests`，实现没有同步，直接造成测试红。
- 补测试能红：坏行后置记录没有断言；summary `none` 只测 API，未测 WebUI；locator 只测类型，未核对字节与 hash 对应的实际记录。
- 镜像语义：turn 的 `sourceRef` 与 `byteStart/recordHash` 必须来自同一 source；当前 upsert 会把新 `sourceRef` 与旧字节/hash 拼在一起。`ReaderTurn.sourceByteStart` 注释也写“跨扫描只见终态时为 null”，与实际填终态记录位置矛盾。
- 可维护性：summary locator 六字段在详情和列表两处重复，且两处都携带错误的 fallback 语义；`sourcePathOf` 每摘要扫描一次全部 source，存在无效的 O(summaries × sources)。

## Spec Review

`not-green`

- PASS：turn 终态只从 `event_msg` 的 `task_complete/turn_aborted/error` 更新；`item_completed` 只产生证据。
- PASS：单 source fixture 中 completed/failed/interrupted、compacted 正文、缺摘要时 API `summary:null` 与空列表均成立。
- PASS：读取 Codex JSONL 前后内容一致；本 diff 未增加写 Codex JSONL、配置或历史数据库的代码路径。
- PASS：坏 JSON 行产生 anomaly，单 source fixture 的扫描可完成；健康会话不受坏 source 阻塞。
- FAIL：多 source 下 turn path 取 thread 最新 source path，而不是 turn 自己的 `sourceRef`。
- FAIL：跨 source 重放同一 turn id 时，`sourceRef` 更新为新 source，但 `byteStart/recordHash` 保留旧 source。
- FAIL：sample/legacy summary 的 `sourceId=null` 会回退到线程 rollout path，制造不属于该摘要的来源。
- FAIL：从观察卡打开的详情仍显示 Jev 提案接受按钮，接受入口可执行状态变更。
- FAIL：精确 target 的 `pnpm test` 不通过，交付声明与可执行现场不一致。

## Findings

### F1 — critical — 精确 target 的测试契约不自洽

- location: `test/tool-contract.test.ts:120`, `test/tool-contract.test.ts:251`, `src/views.ts:249`
- category: test / delivery contract
- evidence: commit 把 `manifests` 加入 `RUNTIME_KEYS` 并要求其为非空数组，但 committed `src/views.ts` 的 runtime projection 不含 `manifests`。`pnpm test` 与单独 `test/tool-contract.test.ts` 均 exit 1；实际 runtime keys 无 `manifests`。交付评论称 `429 pass / 0 fail`，精确 SHA 实际为 `428 pass / 1 fail / 1 skip`。
- recommendation: 将 `src/views.ts` 及所需 manifest 接线纳入 target，或从本切片契约移除未实现断言；重新在 clean target worktree 运行全量测试后再声明全绿。

### F2 — high — turn path 使用线程最新 source，跨 source 时 provenance 错误

- location: `src/http.ts:114`, `src/http.ts:145-149`
- category: bug / source provenance
- evidence: `turn.sourceRef` 已是 sourceId，但 `/turns` 对一页所有 turn 使用 `threadIdentity(threadId).sourcePath`；`latestTurn` 同样使用 identity path。构造 source A 的 `t1` 与 source B 的 `t2` 后，HTTP 返回 `t1.locator = {sourceRef:"srcA", sourcePath:"/tmp/B.jsonl", ...}`，即 sourceRef 与 path 不由同一 source 解析。
- recommendation: 按住 turn 的 `sourceRef` 查 source path；只有 `sourceRef=null` 时才允许显式降级 fallback，并为多 source 场景加 HTTP 回归测试。

### F3 — high — turn upsert 会让旧字节/hash冒充新 source 的定位

- location: `src/store/thread-store.ts:787-791`
- category: bug / source provenance
- evidence: conflict update 同时执行 `source_ref = excluded.source_ref` 和 `source_byte_start = COALESCE(source_byte_start, excluded.source_byte_start)`。构造同一 turn id 先来自 source A（byte 10 / hash-A），再来自 source B（byte 200 / hash-B），落库结果是 `{sourceRef:"srcB", sourceByteStart:10, sourceRecordHash:"hash-A"}`。这条 update 正是 resume/replay 的既有路径。
- recommendation: 当 `source_ref` 或 `thread_id` 改变时，三个定位列必须作为一个整体替换；仅在 source 不变的增量窗口里保留首次记录的定位。补 story 21 的 locator 断言。

### F4 — high — sample/legacy summary 被伪造为 rollout 文件来源

- location: `src/http.ts:71-74`, `src/http.ts:125`, `src/http.ts:384`
- category: bug / summary provenance
- evidence: `sourceId=null` 无条件回退到线程 `sourcePath`。生产 `sample` 摘要经 `addThreadSummary` 写入时 `source_id=null`，实测 `/summaries` 返回 `provenance:"sample"`、`sourceId:null`、`sourcePath:"/tmp/rollout.jsonl"`，但 sample 并非从该 rollout 记录解析而来；V8 前的 compacted 行也没有 `source_id`。
- recommendation: `sourceId=null` 时默认返回 `sourcePath:null`；只有有确定证据证明摘要记录来自该线程 source 时才做 fallback，并在 locator 上保留下降级原因。

### F5 — high — 观察详情仍暴露 Phase 1 禁止的提案执行入口

- location: `web/src/App.tsx:162-167`, `web/src/components/ThreadDetailView.tsx:244-250`, `web/src/components/ProposalPanel.tsx:113-132`
- category: boundary / read-only
- evidence: “观察中的会话”卡新增“查看详情”并打开同一 `ThreadDetailView`；该视图保留 Jev 提案区，`ProposalPanel` 的“接受提案”会调用 `proposal.accept`。`pnpm test:ui` 的后半段实际验证了接受提案产生执行链并把任务移入 done。该行为违反 Phase 1 “不暴露 proposal 执行/状态变更入口”的边界。
- recommendation: Phase 1 的观察详情只渲染只读 summary/turn/evidence；提案执行区和 accept/reject 控件必须由非 Phase 1 的显式运行时开关隐藏，并补 UI 负向断言。

### F6 — medium — source rewrite 后 summary locator 不会刷新或失效

- location: `src/reader/scanner.ts:371-381`, `src/store/thread-store.ts:859-885`
- category: bug / invalidation
- evidence: `rewritten` 会 supersede evidence、重建 turns、resolve anomalies，但 summary 命中 `(thread_id, provenance, source_ref)` 时直接跳过。rollout rewrite 后同一 compacted 记录 hash 可能保留而字节位置移动；该行仍返回旧 `byteStart`。若 rewrite 删除了该 compaction，旧 summary 也没有 supersede/失效路径。
- recommendation: rewrite 时刷新匹配 summary 的 `source_id/byteStart/recordHash/coveredThroughTurnOrdinal`，并对不再存在的记录标记 superseded 或显式不可回源。

### F7 — medium — 增量扫描时 summary 覆盖边界会为空或低估

- location: `src/reader/parse.ts:391-396`
- category: bug / summary coverage
- evidence: `coveredThroughTurnOrdinal` 只从当前 parse window 的 `turns` map 计算；先前已消费的 turn 只在 `state.knownTurns/ordinalsByThread`，不会进入 `turns`。因此“前一轮已读 turn，本轮追加 compacted”会写 `null`，部分跨窗口场景会低估。现有测试只覆盖单次全量 parse。
- recommendation: 从可证明属于同一 thread/source 已持久化 ordinal 计算覆盖边界，或明确返回不可验证状态；增加两窗口增量测试，避免 dedup 后错误值永久保留。

### F8 — medium — 新测试没有证明交付声称的降级和 none UI

- location: `test/codex-detail.test.ts:72-73`, `test/codex-detail.test.ts:108-119`, `test/codex-detail.test.ts:134-139`
- category: test / false confidence
- evidence: fixture 在坏行后放了 `"坏行之后仍可读"` 的 item，但测试只遍历已有 evidence、不断言该文本/记录存在；即使 parser 在坏行后停止也会通过。无摘要测试只断言 API `null` 与空数组，没有断言 WebUI `summary-none`。locator 测试只检查 `byteStart` 是 number、hash 是 string，没有核对对应文件的记录与 hash。
- recommendation: 断言坏行后 item 的数量/正文/anomaly；在 UI smoke 中验证无摘要有 `none`；直接按 byte slice 和 sha256 核对 turn/summary locator 指向的原记录。

### F9 — low — `sourceByteStart` 注释与实际语义矛盾，且可能被消费为 turn 起点

- location: `src/store/thread-store.ts:52-54`, `src/reader/parse.ts:84-86`, `src/reader/parse.ts:496-499`
- category: documentation / misleading contract
- evidence: store 注释称“跨扫描只见终态时为 null”，parser 实际在终态分支写入终态记录的 byte/hash；界面则把该值显示为来源位置。非空 locator 无法区分“task_started 起点”和“仅终态可定位”的降级值。
- recommendation: 统一字段语义，并增加明确的 locator kind/complete 标记；若 API 承诺 turn start，则终态 fallback 不能写入同名字段而不标记。

### F10 — low — V8 回填没有自动回归测试

- location: `src/schema.ts:342`, `test/db.test.ts:87-109`
- category: test / migration
- evidence: V4/V6/V7 均有数据回填测试；V8 的唯一数据 UPDATE（compacted `record_hash = source_ref`）只在 version 计数测试里被间接覆盖。手工迁移验证通过，但没有测试防止 WHERE/列名回归。
- recommendation: 增加 V7→V8 既有 compacted/sample 行 fixture，断言 compacted 回填 `record_hash`、sample 保持 null、旧正文与关联字段不丢。

## Claim Integrity

`violation`

- 交付评论声称 `pnpm test` 为 430 项、429 通过、1 跳过、0 失败；精确 target 实测 430 项、428 通过、1 跳过、1 失败。
- 失败不是环境波动：`src/views.ts` 缺少 committed 实现，而 `test/tool-contract.test.ts` 在该 commit 中已要求 `runtime.manifests`。这说明声明依赖了未提交工作区差异，target 自身不自包含。
- “坏行之后仍可读”和“无摘要 UI 显示 none”的自动化证据不足；前者测试不会在该接线被破坏时变红，后者没有 UI 断言。

## Uncovered Risks

- `.jsonl.zst` 的 byte offset 是解压后逻辑流位置；当前 locator 只给压缩文件 path 与逻辑 offset，没有测试消费方如何从该 path 正确定位记录。
- 只验证了 Codex JSONL 内容不变；未直接对 Codex 配置目录和历史数据库做前后 hash/内容审计。
- 未覆盖真实 resume 链的多 source HTTP 详情、source rewrite 后 summary 刷新、两窗口 compaction 增量。
- `coveredThroughTurnOrdinal` 的跨 source 合并语义没有单独类型/约束；简单取全线程最大 ordinal 可能高估。
- 终态记录位置与 `task_started` 起点共用 `sourceByteStart`，没有 degraded/origin 枚举供 UI 区分。

## Verdict Inputs

- `not-green`

Gate 理由：

1. 精确 target 的全量测试失败。
2. turn/summary source locator 存在可复现的错误 provenance。
3. Phase 1 观察详情暴露提案执行入口。
4. 完成声明中的测试与降级覆盖不成立。
