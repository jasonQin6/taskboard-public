# MEA audit — issue #50 r3

- Issue: original-repository issue #50
- Dispatch: `.mea/dispatches/issue-50-r3.md`
- r2 audit: `.mea/audits/issue-50-r2.md`
- r2 decision（本轮唯一返工项 F50-B1）: `.mea/decisions/issue-50-r2.md`
- base_sha: `4a76064c289c7baa718a8bd4e3c2824b6f24fceb`
- target_sha（dispatch 指定）: `280a61cc64475da2989655ac227d8a218eba1339`
- 实际审计的 target SHA: `280a61cc64475da2989655ac227d8a218eba1339`（`git rev-parse HEAD` 相等；分支 `codex/issue-batch`；`git status --porcelain=v1` 为空）
- implementation_sha: `280a61cc64475da2989655ac227d8a218eba1339`（单 commit，`fix(reader): skip rewritten merged coverage seeding (#50)`）

## 验收

| Command | Exit | Result | Evidence |
|---|---|---|---|
| `pnpm test` | 0 | pass | tests 527 / pass 526 / fail 0 / skipped 1（node:test 输出，含新增回归测试） |
| `pnpm typecheck` | 0 | pass | `tsc --noEmit` + scripts + web 三段全部通过 |
| `npx tsx --test test/reader.test.ts`（焦点复核） | 0 | pass | tests 34 / pass 34 / fail 0；r2 的 merged-session 播种用例（非 rewritten 路径）无回归 |
| `pnpm test:ui` | skip（授权） | not-green 不计入 | diff 无任何 WebUI 文件变更；按 dispatch「only if a WebUI file changes」条款授权跳过 |
| `git diff --check base..target` | 0 | pass | 无空白错误 |
| 沙盒变异复检（auditor 独立执行，非工作区修改） | 红/绿确认 | pass | 见 Claim integrity 与 Uncovered risks：base 版 `scanner.ts` + 新测试在隔离沙盒中 1 fail（`0 !== null`，正好是被删 turn 的旧 ordinal）；target 版全绿 |

变更文件 2 个（`git diff --name-only base..target`）：`src/reader/scanner.ts`、`test/reader.test.ts`，与 dispatch Allowed files 完全一致，无 scope 越界。实现为单个 commit。

## Standards 轴

来源：`AGENTS.md`（含 project-doc）、`docs/agents/review-standards.md`；仓内无 `CODING_STANDARDS.md`/`CONTRIBUTING.md`（已核实不存在），加 code-review smell 基线。子代理容量不可用（本审计上下文无派生工具），改为两次显式独立的顺序审查（先 Standards 后 Spec，中间无结论互引），独立性降低如实记录；两轴结论未合并互排。

逐条核验：

- 无新增运行时依赖（ADR-0006）；单行调用点修改不涉及依赖。
- 状态变更路径未动（仍经 `commitSourceScan` 事务；ADR-0002 不受影响）。
- 无新增路由/认证/CORS 逻辑（ADR-0007 不触发）；无 `Record<string,…>` 外部值动态分发（`Object.hasOwn` 条款不触发）。
- 注释规则：本轮未新增任何注释；被改行上方的既有 why 注释（UNIQUE 冲突卡死说明）依然准确，无需更新，无过时注释。
- 「补测试要证明能红」条款：executor 未留下 mutation-check 记录（仅一行 terse 提交信息，无 claim 文档）；本审计在 `/tmp` 隔离沙盒（`git archive target` + base 版 `scanner.ts` 覆盖 + symlink node_modules，未触碰工作区受跟踪文件）中独立复现红色态：旧代码下新测试以 `0 !== null` 失败（`coveredThroughTurnOrdinal` 被播种为已删除 turn 的 ordinal 0），target 下通过。红色态已独立验证，非静态推断。
- smell 基线：`rewritten ? null : knownState?.sourceId ?? null` 与 110 行下方 `parseStateFor` 的 `rewritten ? null` 规则同形，无重复代码、命名清晰、无类型债。`??` 与三元混用的优先级经核验符合预期（`rewritten ? null : (knownState?.sourceId ?? null)`，与 `mergeKnownTurnState` 的 `sourceId: string | null` 签名一致）。

硬违规：未发现。判断性 smell：无新增。

## Spec 轴

来源：issue #50 验收 + dispatch r3 三项必需行为 + r2 decision F50-B1 定义。逐条核对：

1. **非 rewritten merged-session 播种仍保留**：`rewritten=false` 时调用点仍传入 `knownState?.sourceId`，`mergeKnownTurnState` 播种逻辑逐行未动；r2 回归用例「merged session without window turns」在焦点复核 34/34 中通过。满足。
2. **rewritten 时禁用播种，与 `parseStateFor` 的 `rewritten ? null` 一致**：`scanner.ts:321` 改为 `rewritten ? null : knownState?.sourceId ?? null`；而 `parseStateFor`（`:434`）对同一 `rewritten` 变量同样返回 `persistedCoverage = null`。两者由同一局部变量驱动，不存在判断分叉。满足。
3. **回归 fixture 覆盖 rewrite + 多 session + 同窗 compaction，并证明不认领已删 turn 的 coverage**：新测试先写双 session 文件并扫描（session A 落 turn ordinal 0），再重写同一文件为「A 的 compacted summary + B 的空 meta」并扫描；断言 A 的 turn 已被同轮删除（length 0）、summary 正文为重写后文本、`coveredThroughTurnOrdinal === null`。沙盒红态证明：无修复时该断言以 `0 !== null` 失败，即旧代码确实会把已删 turn 的 ordinal 写入新 summary（F50-B1 的 dishonest-claim 如实成立）；有修复时为 null。满足。

r1 四项（F50-A1/A2/A3/A10）与 r2 接受的 low（F50-B2/B3）均未重开：本轮 diff 不触碰 `src/store/thread-store.ts`、`src/http.ts` 及 r2 其他测试文件，r1/r2 已关闭项的语义保持原样；全量测试绿即无回归证据。

两轴独立性说明：按 code-review skill 应以两个全新并行子代理执行；因子代理容量不可用，改为本审计内两次显式独立的顺序审查，独立性降低如实记录。

## Domain review

domain-review: pass

- GLOSSARY `SourceLocator`/Thread/原生摘要语义未被改写；rewritten 后 coverage 置 null 与「空值不伪装成功」一致，且正是 dispatch 失败模式 3「可证明 ordinal」要求的诚实行为。
- ADR-0002（单一写者）、ADR-0003（扫描只读）、ADR-0005/0018（终态与跨 Harness 身份）、ADR-0017（Phase 1 只读边界）均未触碰；HTTP 仍 loopback + CSRF 基线。
- 与 `parseStateFor` 的 `rewritten ? null` 规则对齐后，同一模块内不再存在互相矛盾的重写语义（关闭 r2 F50-B1 指出的模块内矛盾）。

## OCR

命令模板：`ocr review --audience agent --effort medium --timeout 5 --max-tools 50 --background-file /tmp/mea-50-<target>-<pass>.md --from <base_sha> --to <target_sha> --exclude <complementary> --output /tmp/mea-50-<target>-<pass>.txt`

| Pass | Excludes | Session | Exit | Selected/Completed/Failed | Findings | Unreviewed |
|---|---|---|---|---|---|---|
| backend | `test/** web/**` | 未 surfacing（CLI `--output` 模式） | 0（输出文件含 `Review complete` 完成标记，无错误文本） | 1 / 1 / 0 | 0 | none |
| tests | `src/** web/**` | 未 surfacing（CLI `--output` 模式） | 0（输出文件含 `Review complete` 完成标记，无错误文本） | 1 / 1 / 0 | 0 | none |

`web/**` 在两组均被排除：本轮 range 内无 WebUI 变更，排除项为空集，不计入 uncovered。两组输出文件均只有一行完成汇总（`Review complete: 0 finding(s) across 1 selected item(s)`），未给出 session id；exit code 由完成标记推断，见 Uncovered risks 如实记录。OCR 无发现，无需对照源码核验。

## Claim integrity

claim_integrity: clean

- executor 无独立完成 claim 文档，仅有单行提交信息「A rewritten source deletes its old turns before replay, so those ordinals cannot seed a merged-session summary in the same scan」；该陈述与 diff（调用点传 null + 回归测试）及审计员独立复现的红/绿行为完全一致，无矛盾声明。
- 提交信息中未声称执行过 mutation check，实际也无记录；不构成虚假声明，缺失部分由本审计在沙盒中补足验证（见验收表与 Standards 节）。
- `280a61c` 的 diff（1 行实现 + 41 行测试）与 `git diff base..target` 完全一致；验收命令全部由本审计重跑并记录计数。

## Findings

严重度汇总：critical 0 / high 0 / medium 0 / low 0。

- F50-B1（r2 medium）已验证关闭：rewritten 门控已加，红/绿双态均有执行证据（沙盒红 + 工作区绿），模块内 `rewritten ? null` 语义恢复一致。
- r1 四项（F50-A1/A2/A3/A10）维持关闭；r2 接受的 F50-B2/B3 维持接受为不阻塞 low，不重列为 blocker。
- 本轮无新增 findings（含 OCR 0 发现）。

## Uncovered risks

- OCR 两组 exit code 由输出文件完成标记推断为 0（CLI `--output` 模式未向审计员 surfacing session id 与数字退出码）；输出文件内容完整（非 partial），无未评审路径，但严格意义上的退出码证据为间接证据。
- 变异红色态由审计员在 `/tmp` 隔离沙盒中复现，而非 executor 按 dispatch 要求在交付前执行并记录；executor 侧的 mutation-check 证据缺失（但红色态本身已获独立执行证据，非静态分析）。
- r1 已接受残余（V8 前 legacy 行 kind 保持 null、V8 前 `source_id=null` 的 compacted 行持续不可回源投影、`.jsonl.zst` 逻辑字节偏移语义）本轮未触碰，延续接受状态。
- 全量测试含 1 例 skipped（与 r2 同口径的既有 skip，非本轮引入；本轮 fail 为 0，无偶发失败）。

## verdict_inputs

green — 验收命令全部通过（含焦点复核与独立沙盒红/绿验证）、两轴完成、domain-review pass、OCR 两组完成且 0 发现、claim_integrity clean、diff 严格落在 dispatch 允许的 2 个文件内、无未关闭 critical/high/medium。F50-B1 关闭有执行证据支撑；r1/r2 已关闭项未重开。
