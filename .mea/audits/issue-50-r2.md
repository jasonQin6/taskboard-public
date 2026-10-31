# MEA audit — issue #50 r2

- Issue: original-repository issue #50
- Dispatch: `.mea/dispatches/issue-50-r1.md`（r2 无新 dispatch；r1 decision 的四项返工即本轮 scope）
- r1 audit: `.mea/audits/issue-50-r1.md`
- r1 decision: `.mea/decisions/issue-50-r1.md`
- base_sha: `fb45bbb447578d04bf17508ebc07d69ec2e5a20f`
- target_sha（dispatch 指定）: `62bc0293986bb478e765a7f29db1a5c691ceb9b4`
- 实际审计的 target SHA: `62bc0293986bb478e765a7f29db1a5c691ceb9b4`（`git rev-parse HEAD` 相等；分支 `codex/issue-batch`；worktree 干净）
- implementation_sha: `489d6e8`（r2 复测）+ `62bc029`（r2 修复）两个 commit

## 验收

| Command | Exit | Result | Evidence |
|---|---|---|---|
| `pnpm test`（第 1 轮） | 1 | fail（偶发，已定位） | tests 526 / pass 524 / fail 1 / skipped 1；唯一失败是 `test/goals.test.ts:340`「goal.set on a bound external thread takes the writer lock」（A17，`condition not met within 3000ms`）；该文件不在本轮 diff 内，本轮未动 writer/audit 逻辑 |
| `pnpm test`（第 2 轮，干净重跑） | 0 | pass | tests 526 / pass 525 / fail 0 / skipped 1（node:test 输出） |
| `npx tsx --test test/goals.test.ts`（隔离复核） | 0 | pass | tests 15 / pass 15 / fail 0；确认第 1 轮失败为偶发抖动（与审计员首轮并行后台会话资源争用有关），非产品信号 |
| `npx tsx --test test/reader.test.ts test/store.test.ts test/http.test.ts`（焦点复核） | 0 | pass | tests 90 / pass 90 / fail 0；含 4 个 r2 新增测试全部通过，且 r1 的 F6/F7/F9 用例无回归 |
| `pnpm typecheck` | 0 | pass | `tsc --noEmit` + scripts + web 三段全部通过 |
| `pnpm test:ui` | skip（授权） | not-green 不计入 | diff 无任何 WebUI 文件变更；按 issue/dispatch「页面变化时运行」条款授权跳过 |
| `git diff --check base..target` | 0 | pass | 无空白错误 |

变更文件 6 个（`git diff --name-only base..target`）：`src/http.ts`、`src/reader/scanner.ts`、`src/store/thread-store.ts`、`test/http.test.ts`、`test/reader.test.ts`、`test/store.test.ts`，全部落在 dispatch 允许 scope（`src/reader/**`、`src/store/**`、HTTP locator 投影、`test/`）内。无 scope 越界。实现含两个 commit：`489d6e8` 复测、`62bc029` 修复。

## Standards 轴

来源：`AGENTS.md`、本仓 `docs/agents/review-standards.md`（仓内无 `CODING_STANDARDS.md`/`CONTRIBUTING.md`），加 code-review smell 基线。子代理容量不可用（本审计上下文无派生工具），改为两次显式独立的顺序审查，独立性降低已在此记录；两轴结论未合并互排。

硬违规：未发现。无新增运行时依赖（ADR-0006）；状态变更全部经 `core.write` 事务 + Touch 收集广播（ADR-0002，`touch("threads",…)` 在同一事务回调内，与既有 `rebuildTurns` 的 touch 模式一致）；无新增路由/认证/CORS 逻辑（ADR-0007）；无 `Record<string,…>` 外部值动态分发（`Object.hasOwn` 条款不触发）；新增代码无注释，所加逻辑自解释，符合「注释只写 why」条款。

判断性 smell（全部经源码核验后收录为 findings，低）：`summaryFromRow`（`!== 0`）与 `evidenceFromRow`（`=== 1`）转换写法不一致（schema 两处均为 `INTEGER NOT NULL DEFAULT 0`，语义等价，见 F50-B2）。

`docs/agents/review-standards.md`「补测试要证明能红」条款：r2 执行人未留下 mutation-check 记录（亦无 r2 claim 文档，见 claim_integrity）；本审计以静态红分析逐条确认 4 个新测试的灵敏度（3 个在无修复时必红；A2 用例锁定转换器配对，端到端由 HTTP 用例覆盖），未独立执行红色态（Auditor 不修改受跟踪实现文件），记入 uncovered。

## Spec 轴

来源：issue #50 四项交付 + dispatch 五条必需失败模式 + r1 decision 四项返工。逐条核对：

- **F50-A1（merged-session coverage seeding）已关闭**：`mergeKnownTurnState` 新增 `sourceId` 参数，对每个合并 session 用同 source 持久化 max ordinal 播种 `coveredThroughTurnOrdinalByThread`（与既有值取 max）；直测 `reader.test.ts`「merged session without window turns」断言 coverage 为持久化值 0 而非 null。
- **F50-A2（latestThreadSummaries.superseded）已关闭**：外层 SELECT 补 `superseded` 列，与 `SummaryRow` 契约对齐；直测 `store.test.ts` 断言 active 摘要 `superseded === false`。
- **F50-A3（superseded HTTP 顶层定位字段）已关闭**：superseded 分支显式置 `sourceRef/sourceId/byteStart/recordHash/coveredThroughTurnOrdinal` 全 null + `locator: null`；直测 `http.test.ts` 逐字段断言。客户端类型（`ClientThreadSummary` 顶层字段均 optional/nullable，`locator` 为主形态）与新投影一致；superseded 行缺顶层 `sourcePath` 与 r1 形状相同，无回归（消费方只读 `locator.sourcePath`，且有 null 守卫）。
- **F50-A10（rewritten supersede touches）已关闭**：UPDATE 前先 `SELECT DISTINCT thread_id … superseded = 0`，UPDATE 后对受影响 thread 逐个 `touch("threads", …)`；直测 `store.test.ts` 断言 revision 精确推进一批且 `ids` 恰为受影响 thread。touch 在 `core.write` 事务内收集、提交后广播，无顺序 hazard。
- Issue 四项验收（F6/F7/F9/F10）与 dispatch 五条失败模式：r1 已验证的路径本轮焦点复核全部仍绿；r2 未改动其语义。
- 无 scope creep：6 个文件全部在允许 scope 内。

两轴独立性说明：按 code-review skill 应以两个全新并行子代理执行；因子代理容量不可用，改为本审计内两次显式独立的顺序审查（先 Standards 后 Spec，中间无结论互引），独立性降低如实记录。

## Domain review

domain-review: pass

- GLOSSARY `SourceLocator`/Thread/原生摘要语义未被改写；`superseded` 显式不可回源与「空值不伪装成功」一致。
- ADR-0002（单一写者：变更经 `core.write` 事务）、ADR-0003（扫描只读）、ADR-0005/0018（终态与跨 Harness 身份）、ADR-0017（Phase 1 只读边界）均未触碰；HTTP 仍 loopback + CSRF 基线。
- `summaryFromRow` 的 `!== 0` 在 `NOT NULL DEFAULT 0` 下与旧 `=== 1` 语义等价，无投影行为变化。

## OCR

命令模板：`ocr review --audience agent --effort medium --timeout 5 --max-tools 50 --background-file /tmp/mea-50-<target>-<pass>.md --from <base_sha> --to <target_sha> --exclude <complementary> --output /tmp/mea-50-<target>-<pass>.txt`

| Pass | Excludes | Session | Exit | Selected/Completed/Failed | Findings | Unreviewed |
|---|---|---|---|---|---|---|
| backend | `test/** web/**` | c99dda5c-b6c6-4f9e-80b3-66e5966eca2c | 0 | 3 / 3 / 0 | 1（bug-medium，见 F50-B1，已逐行源码核验成立） | none |
| tests | `src/** web/**` | a59d9c0e-e2dd-445f-9d3d-64f0bed4ffec | 0 | 3 / 3 / 0 | 0 | none |

`web/**` 在两组均被排除：本轮 range 内无 WebUI 变更，排除项为空集，不计入 uncovered。后端组耗时约 10 分钟预算上限内完成（非 partial）。OCR 全部发现均对照源码与仓库标准核验后定级，未照抄建议代码。

## Claim integrity

claim_integrity: clean

- r2 无独立 executor 完成 claim 文档（仅有两个 terse 提交信息）；无任何与证据矛盾的声明。
- `489d6e8`（149 行测试）+ `62bc029`（46+/15- 实现）与 `git diff` 完全一致；验收命令全部由本审计重跑并记录计数。
- r1 dispatch 要求的 mutation-check 在 r2 无执行记录；已用静态红分析替代核验（见 Standards 节与 F50-B3），红色态未独立复现，记入 uncovered。

## Findings

严重度汇总：critical 0 / high 0 / medium 1 / low 2。

r1 四项（F50-A1/A2/A3/A10）全部验证关闭，不再列为 findings；r1 残余风险（V8 前 legacy kind 保持 null、sample `record_hash` 保持 null、`.jsonl.zst` 逻辑字节偏移语义）本轮未复现也未恶化，仍为已接受残余，不重列为 blocker。

### Medium

- **F50-B1** `src/reader/scanner.ts:493-501`（bug，F7 完整性，本轮新引入）— `mergeKnownTurnState` 对合并 session 播种 coverage 时未设 rewritten 门控，与 30 行上方 `parseStateFor` 的刻意规则（`rewritten ? null`）直接矛盾。调用点 321 行在 `rewritten=true` 且 `knownState` 非空（同路径内容重写）时仍传入有效 `sourceId`；而 `commitSourceScan` 在 `rebuildTurns` 时会 `DELETE FROM thread_turns WHERE source_ref = ?`（thread-store.ts:795-797）删掉该 source 全量 turn 后重放——播种所读的旧行正是同一提交内即将删除的行。若本轮窗口含该合并 session 的 compaction，新 summary 的 `coveredThroughTurnOrdinal` 将断言一个提交后已不存在（或内容已变）的 ordinal，违反 dispatch 失败模式 3 的「可证明 ordinal」要求。触发面窄（重写 + 多 session + 同窗 compaction），但属于本轮 diff 新造的 dishonest-claim（r1 在此路径写 null，诚实），且修复为一行（调用点传 `rewritten ? null : knownState?.sourceId` 或加 `rewritten` 参数 + 一个重写多 session fixture 直测）。

### Low

- **F50-B2** `src/store/thread-store.ts:208` vs `:325`（standards 一致性）— `summaryFromRow` 用 `!== 0`，`evidenceFromRow` 仍用 `=== 1`；schema 两处均为 `INTEGER NOT NULL DEFAULT 0`，语义等价，无行为差异。建议对齐写法（任选其一），不阻塞。
- **F50-B3** `test/store.test.ts`（测试强度备注，非缺陷）— A2 用例（`superseded === false`）在旧 SELECT + 旧转换器下同样通过（`undefined === 1 → false`）；它锁定的是「列存在 + 转换器配对」，真正的端到端防退化由 HTTP superseded 用例承担（旧代码走 active 分支、`locator` 非 null，必红）。已静态确认三处新测试在无修复时必红（A1/A3/A10），A2 的配对由本条记录。无需动作。

## Uncovered risks

- 首轮全量测试的 1 例偶发失败（`goals.test.ts:340` A17，writer-lock 3000ms 超时）：隔离复核 15/15 通过，干净重跑 526  tests 0 fail；判定为审计员首轮并行后台会话资源争用所致，非产品信号。
- mutation 红色态未由本审计独立复现（Auditor 不修改受跟踪实现文件）；已用逐用例静态红分析替代，见 Standards 节与 F50-B3。
- r1 已接受残余（V8 前 legacy 行 kind 保持 null、V8 前 `source_id=null` 的 compacted 行持续不可回源投影、`.jsonl.zst` 逻辑字节偏移语义）本轮未触碰，延续接受状态。
- 后端 OCR 组消耗了完整 10 分钟预算但正常完成（exit 0，非 partial）；无未评审路径。

## verdict_inputs

not-green — 验收命令通过、两轴完成、domain-review pass、OCR 覆盖完整、claim_integrity clean、无 critical/high；但存在 1 条本轮新引入的 medium（F50-B1，重写路径 merged-session coverage 播种与模块自身 `rewritten ? null` 不变量矛盾，属新造 dishonest-claim 且有一行修复），按 r1 decision「medium 返工」先例应返工，不宜作为残余接受。r1 四项返工要求本身已全部验证关闭，r3 scope 可收敛为 F50-B1 一项。
