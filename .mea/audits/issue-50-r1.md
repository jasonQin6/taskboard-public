# MEA audit — issue #50 r1

- Issue: original-repository issue #50
- Dispatch: `.mea/dispatches/issue-50-r1.md`
- base_sha: `d48277ddb8e301dfc3e2148398480e02d5ae34f4`
- target_sha（dispatch 指定）: `91d0b4c4d5a7712be88acb36f58f2e6aafa61d91`
- 实际审计的 target SHA: `91d0b4c4d5a7712be88acb36f58f2e6aafa61d91`（`git rev-parse HEAD` 相等；分支 `codex/issue-batch`；worktree 干净）
- implementation_sha: `91d0b4c4d5a7712be88acb36f58f2e6aafa61d91`

## 验收

| Command | Exit | Result | Evidence |
|---|---|---|---|
| `pnpm test` | 0 | pass | tests 522 / pass 521 / fail 0 / skipped 1（node:test 输出） |
| `pnpm typecheck` | 0 | pass | tsc 三段（root / scripts / web）全部通过 |
| `pnpm test:ui` | 0 | pass | PASS (36 checks)；WebUI 文件有变化，按 issue/dispatch 要求执行 |
| `git diff --check d48277d..91d0b4c` | 0 | pass | 无空白错误 |

变更文件 13 个（`git diff --name-only base..target`），全部落在 dispatch 允许 scope（reader/store/schema/HTTP 与 WebUI locator 投影/test）。无 scope 越界。实现含两个 commit：`f23f821` 复现测试、`91d0b4c` 修复。

## Standards 轴

硬违规：未发现。未新增外部值驱动的 Record 动态键分发；`SUMMARY_KEYS` 工具契约已同步 `superseded`（test/tool-contract.test.ts:167）；F10 走真实 V7→V8 迁移路径而非插入 post-V8 行（test/db.test.ts:355）。

判断性 smell（全部 low，经源码核验后收录 findings）：upsert CASE 重复、`recordHash ?? sourceRef` 隐式身份、locator 四元组多文件重复、测试相似用例可参数化。仓库 review-standards（Object.hasOwn、清单对齐、镜像语义核对）均满足。

## Spec 轴

按 issue 四项交付与 dispatch 五条必需失败模式逐条核对：

1. F6 匹配 compaction 刷新 locator 四元组与 coverage：`thread-store.ts` 用 `(thread_id, source_id, record_hash)` 定位既有行并单条 UPDATE 全量刷新（`superseded` 复位为 0），直测 reader.test.ts F6 rewrite 用例（byteStart 移动、coverage 重算、text/hash 稳定）。
2. F6 删除 compaction 置 `superseded=1`：latestThreadSummary/latestThreadSummaries 过滤 superseded，HTTP detail summary 为 null、summaries 列表 locator 为 null；直测覆盖删除路径与两条 API 投影。
3. F7 增量窗口用持久化同 source ordinal 播种 `coveredThroughTurnOrdinalByThread`；compaction 顺序消费不混入同窗后置 turn；两 source 双窗口直测覆盖。边缘缺口见 F50-A1。
4. F9 start/terminal 显式 kind 持久化（V10 迁移新增列 + CHECK），parse 播种 start/terminal，legacy 无 kind 行不重标；HTTP turn 投影与 WebUI kind 标签各有直测。
5. F10 真实迁移路径回填 compacted 的 record_hash、sample 保持 null、正文与关联字段不丢（test/db.test.ts V7→V8 fixture）。

无 scope creep；V10 迁移与 `superseded` 列是 F6 所需持久化，在允许 scope 内。

两轴独立性说明：按 code-review skill 以两个全新并行子代理执行（standards_review、spec_review），各自直接读取固定点 diff 与标准/规格来源；本审计只做核验与定级，未合并或重排两轴结论。

## Domain review

domain-review: pass

- GLOSSARY `SourceLocator`/Thread/原生摘要语义被增强而非改写；`superseded` 与「空值不伪装成功、局部失败不静默」一致。
- ADR-0002 单一写者（状态变更全部经 store core.write 事务）；ADR-0003 扫描只读未变；ADR-0005/0018 终态与跨 Harness 身份未触碰；ADR-0017 Phase 1 只读边界未破；HTTP 仍 loopback + CSRF 基线。

## OCR

命令模板：`ocr review --audience agent --effort medium --timeout 5 --max-tools 50 --background-file /tmp/mea-50-<pass>.md --from d48277ddb8e301dfc3e2148398480e02d5ae34f4 --to 91d0b4c4d5a7712be88acb36f58f2e6aafa61d91 --exclude <complementary> --output /tmp/mea-50-91d0b4c-<pass>.txt`

| Pass | Excludes | Session | Exit | Selected/Comments | Findings | Unreviewed |
|---|---|---|---|---|---|---|
| backend | `web/** test/**` | 2e218ed1-9089-45b9-9cf5-51c7110e3f0a | 0 | 8 / 11 | 11（bug-medium 3、maint-medium 2、perf-low 1、其余 low） | none |
| webui | `src/** test/**` | 89e9e1a4-f422-4fba-9687-9eb76a4e9654 | 0 | 8 / 6 | 6（bug-medium 3、maint-low 3）；round 2 对 `src/http.ts,src/store/index.ts,src/store/thread-store.ts` LLM 超时（见 uncovered） | 该 round 核心请求 |
| tests | `src/** web/**` | ab02de38-5c7f-44c2-9985-3e99ae9a1c71 | 0 | 6 / 5 | 5（bug-medium 2、low 3） | none |

两组 pass 内部出现 2 次 `file_read` 行区间错误（scanner.ts:444、parse.ts:790>120），为工具读文件失败，findings 仍产出且这些文件由其它发现与人工核验覆盖。OCR 全部发现均对照源码与仓库标准核验后定级，未照抄建议代码。

## Claim integrity

claim_integrity: clean

- IMPLEMENTATION_SHA/BASE_SHA 与 git 完全一致；VERIFY 命令逐条重跑且计数一致（tests 522/521/1 skip、typecheck exit 0、ui 36 checks、diff --check exit 0、worktree clean）。
- SCOPE 与 `git diff --name-only` 一致；无未声明文件。
- 8 条 mutation checks：executor 逐条记录变异接线与期望红结果；本审计核验最终 diff 已恢复（worktree 干净）且对应测试真实覆盖该接线。mutation 红色态未独立复现，作为残余风险记录。
- 未发现与证据矛盾的声明。

## Findings

严重度汇总：critical 0 / high 0 / medium 1 / low 9。

### Medium

- **F50-A1** `src/reader/scanner.ts:428-494`（bug，F7 完整性）— coverage 种子只给 `known.threadId`；`mergeKnownTurnState` 合并同文件 resume 链上的其它 session 时补 knownTurns/openTurns 但不补 `coveredThroughTurnOrdinalByThread`。该 session 在增量窗口内无 turn 而库内存在同 source 可证明 ordinal 时，新 compaction 仍写 null，未达 dispatch 失败模式 3 的「有可证明 ordinal 就不得 null」。核心 F7 路径（两 source 同 thread）已覆盖并通过。建议：merge 时对每个合并 session 计算并播种同 source 的 max ordinal。
  - 接受理由：边缘切片窄（同文件中途切 session、该 session 无窗口 turn、库内已有同 source 覆盖），不破坏任何已测失败模式与既有行为；可作后续小票，不阻塞本票。

### Low

- **F50-A2** `src/store/thread-store.ts:1039-1049`（contract）— `latestThreadSummaries` 外层 SELECT 漏 `superseded` 列，靠内层 `WHERE superseded=0` 与 `undefined===1` 碰巧安全；建议补列对齐 SummaryRow 契约。
- **F50-A3** `src/http.ts:406-417`（projection）— superseded 行 `locator:null` 但 `...summary` 顶层仍携带 sourceRef/sourceId/byteStart/recordHash 等旧定位字段，与「显式不可回源」投影不一致（locator 为消费方主形态，现无消费方读顶层）。建议 superseded 时顶层字段一并置 null。
- **F50-A4** `web/src/components/ThreadDetailView.tsx`（UX）— superseded 摘要仅显示「来源不可用」，无 superseded 标识；API 已显式（locator null + superseded true）。建议 UI 增加 superseded 徽标。
- **F50-A5** `web/src/lib/detail-model.ts:57` 与 `ThreadDetailView.tsx:40-44`（types）— `ClientThreadSummary.superseded?` 可选与 detail 的必填不一致；`locatorLabel` 内联 locator 类型与 `ClientTurn['locator']` 平行维护，有漂移风险。
- **F50-A6** `ThreadDetailView.tsx:53`（style）— 嵌套三元且每次渲染重建 label map；建议提为模块级查表常量。
- **F50-A7** `src/reader/scanner.ts:443-477`（perf）— `maxTurnOrdinalForSource` 与 `threadTurnState` 各自 `listThreadTurns` 同一 thread，每 source 每轮多一次全列表遍历；建议单次遍历合并产出。
- **F50-A8** parse/store/http/web（Data Clumps）— locator 四元组多处以平行结构重复；建议共享 SourceLocator 形状。
- **F50-A9** `src/store/thread-store.ts:807-830`（standards）— upsert 的 source_ref/kind 优先级规则在三条 CASE 中重复；建议提取 CTE 或集中为单一规则表达。
- **F50-A10** `src/store/thread-store.ts:905-911`（SSE）— rewritten 导致的 supersede 未对不在本轮 threads/summaries 的受影响 thread 发 touch()；现状无行为回归（HTTP 均为即时查询），建议后续补齐 revision 通知。

## Uncovered risks

- OCR webui 组 round 2 核心请求（`src/http.ts,src/store/index.ts,src/store/thread-store.ts`）超时失败：三文件由 backend 组完整评审加本审计人工核验覆盖，按 partial 记录。
- 8 条 mutation checks 的红色态未由本审计独立复现；依据 executor 逐条记录加最终态核验。
- F50-A1 的合并 session 覆盖边缘为已识别未修复的行为缺口（medium，接受理由已记录）。
- V8 之前 legacy 行 kind 保持 null（executor 已声明）：旧混合定位不可靠标注，属诚实保留；同 source terminal 重扫不升级 legacy 行 kind，行为无回归。
- V8 之前 `source_id=null` 的 compacted summary 持续不可回源投影（executor 已声明）。
- `.jsonl.zst` 沿用逻辑字节偏移语义（executor 已声明）。

## verdict_inputs

green — 全部验收通过、两轴完成、domain-review pass、OCR 覆盖已记录（partial 项已入 uncovered）、claim_integrity clean、无 critical/high、唯一 medium 带记录理由。
