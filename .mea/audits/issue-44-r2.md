# 审计报告：issue #44「[Phase 1][S3] ZCode 只读 adapter 与同屏展示」(r2)

- **issue**: https://github.com/jasonQin6/taskboard/issues/44
- **base_sha**: `477bcc53280b75ead4e6889421bdd5294d487b11`
- **target_sha**: `683d000307d9c86ad437832905f7f32d9691547d`（被审 head）
- **被审 head 复核（Stop 条件）**: 建报告前 `git -C ../taskboard-zcode rev-parse harness/zcode` = `683d000307d9c86ad437832905f7f32d9691547d` ✓（审计全程两次确认一致）
- **审计 worktree**: `git worktree add --detach ../mea-audit-r2 683d000…` → `HEAD is now at 683d000`；`git rev-parse HEAD` 与 target 逐字一致；worktree 内 `pnpm install` exit 0。红复现另建一次性 worktree `../mea-audit-r2-red` @ `39d70d7`（fix 前一提交）。
- **审计日期**: 2026-10-27；**角色**: auditor-r2（独立于实现者）。
- **范围构成**: `git log --first-parent 477bcc5..683d000` = `683d000`(r2 返工实现) ← `39d70d7`(r1 审计报告，docs) ← `e304043`(r1 返工) ← `e8336e6`(merge，第二父 `45ffa34`，codex 生命周期基线，CHANGES REQUESTED 明确要求) ← `477bcc5`。r1 已审 `477bcc5..e304043`（见 `.mea/audits/issue-44-r1.md`）；**本轮独立审计重心为 r2 增量 `39d70d7..683d000`（3 文件 +142/-8），并对全范围重跑全部命令级验收**。
- **过程偏差声明**: `code-review` skill 两轴要求并行子代理；本 harness 无子代理工具，Standards/Spec 两轴由本 auditor 在会话内分别执行、分别报告。OCR 对 r2 增量独立执行（结果见第四节）。

## 一、验收（逐条：命令 + exit code + 通过/失败数 + 证据）

环境：worktree `../mea-audit-r2`（HEAD=target），`pnpm install` exit 0；node v26.9.0。

| # | 验收条目（来源） | 命令 | 结果 |
|---|---|---|---|
| A1 | worktree HEAD == target（Auditor contract） | `git worktree add --detach ../mea-audit-r2 683d000…`；`git -C ../mea-audit-r2 rev-parse HEAD` | `683d000307d9c86ad437832905f7f32d9691547d` ✓ PASS |
| A2 | `pnpm typecheck`（issue 验收：根 + scripts + web） | `pnpm typecheck`（= `tsc --noEmit && tsc -p tsconfig.scripts.json --noEmit && tsc -p web/tsconfig.json --noEmit`） | exit 0，零诊断 ✓ PASS（同时实证 `fixture.ts:9` `import { DatabaseSync, type SQLInputValue } from "node:sqlite"` 可编译——F3 修复的类型导入为真） |
| A3 | `pnpm test`（issue 验收 + 声明数字） | `pnpm test`（= `tsx --test test/*.test.ts`） | exit 0：**tests 441 / pass 440 / fail 0 / skipped 1** ✓ PASS（与实现者声明逐字一致） |
| A4 | adapter fixture 测试（声明 14/14） | `pnpm exec tsx --test test/zcode-adapter.test.ts` | exit 0：**tests 14 / pass 14 / fail 0** ✓ PASS（原 11 + 新 3） |
| A5 | **红→绿复验（F1b/F1a/F2，审计复现口径）** | 一次性 worktree `../mea-audit-r2-red` @ `39d70d7` + `pnpm install` + `git checkout 683d000 -- test/zcode-adapter.test.ts` + `pnpm exec tsx --test test/zcode-adapter.test.ts` | **tests 14 / pass 11 / fail 3**，三项新测试全红，失败签名与声明逐字一致：(1) `Error: malformed JSON at ZcodeAdapter.scanSource (adapter.ts:259)`（`ERR_SQLITE_ERROR`）；(2) `AssertionError … 0 !== 1`（`observe().failures.length`，test:365）；(3) `AssertionError … strictly deep-equal`（`{sessions:1,turns:1,…}` vs 期望全零，test:394）✓ PASS——三项修复**能红**，满足 review-standards「补测试要证明能红」 |
| A6 | `pnpm test:ui`（r1 同口径补跑） | `pnpm test:ui`（= `pnpm build:web && tsx scripts/ui-smoke.ts`） | exit 0：**`test:ui PASS (29 checks)`** ✓ PASS |
| A7 | F1-high 修复在位且语义正确（r1 F1） | 读码 `src/harness/zcode/adapter.ts:265-274`（`json_valid` 守卫，非法行 `valid=0` 时 `role`/`completed` 不再执行 `json_extract`）、`:419-429`（`malformed_message_data` anomaly 降级）、`:180-191`（pass 级意外异常重抛前落 `adapter_failed`/`retryable` scanFailure）；A5 红 + A3/A4 绿 | ✓ PASS。边界探针（本 auditor）：标量 JSON（`123`/`"hello"`/`null`/`true`/`[]`）→ `valid=1` 但 `role=null`，`sessionStatusOf` 回落 turn 终态，无误报 running；`json_valid(NULL)` 返回 NULL（→ 见 uncovered #6，fixture `data TEXT NOT NULL` 挡住该路径） |
| A8 | F2-medium 修复在位（r1 F3） | 读码 `adapter.ts:171-172` stopped 短路；A5 红（deep-equal 失败）+ A4 绿 | ✓ PASS（注：与 inFlight 共享的顺序问题见 N2） |
| A9 | F3-low 修复在位（r1 F7 假注释） | 读码 `fixture.ts:9,135`：`import { DatabaseSync, type SQLInputValue } from "node:sqlite"`，`const args: SQLInputValue[]`；假注释已删；A2 编译通过 | ✓ PASS |
| A10 | F4-low 修复在位（r1 F9 路径注释） | 读码 `adapter.ts:2`：`~/.zcode/cli/db/db.sqlite`，与 `:37` `ZCODE_DEFAULT_DB_PATH` 一致 | ✓ PASS |
| A11 | r2 提交无 scope creep、未触碰共享层 | `git show --stat 683d000` → 仅 `src/harness/zcode/adapter.ts`(+37/−8 内)、`fixture.ts`(+5/−2 内)、`test/zcode-adapter.test.ts`(+108)；`git diff 39d70d7..683d000 --stat` 同 3 文件 +142/−8 | ✓ PASS（共享契约/迁移/daemon/codex/WebUI 零改动） |
| A12 | git 结构与声明（ff、干净、链） | `git log --format='%h %p'`：`683d000 39d70d7`、`39d70d7 e304043`、`e304043 e8336e6`、`e8336e6 477bcc5 45ffa34`；`git -C ../taskboard-zcode status --short` 空 | ✓ PASS（首父链 `477bcc5←e8336e6←e304043←39d70d7←683d000`，push 无需 force，与声明一致） |
| A13 | push / issue SHA 评论（r1 F2 流程项） | `git -C ../mea-audit-r2 ls-remote origin harness/zcode` → `477bcc5… refs/heads/harness/zcode`；`gh issue view 44 --json comments` → 仍 6 条，末条为 r1 审计方补充，无携带 `683d000` 的新评论 | ✗ **未完成（如实记录）**：target 仅存本地。声明已如实披露「未 push（发布归 Manager）」；MEA workflow.md step 8 将 deliver/pr-delivery 归 Manager（audit 之后步骤），故不判实现缺陷，作为交付前置条件记录（见 findings N6 与 verdict 说明） |

小结：**12 PASS / 1 未完成（A13，流程归属 Manager 且已被声明如实披露）**。所有命令均在本次审计中实际执行。

## 二、Standards 轴（code-review，Standards：仓库成文规范）

标准来源：`docs/agents/review-standards.md`（审计侧 AGENTS.md 指定；该文件不在 target 树内——`ls ../mea-audit-r2/docs/agents/review-standards.md` 不存在，以 `git show ebba344:docs/agents/review-standards.md` 读取，含「Record 动态键分发 / 清单对齐测试 / 补测试要证明能红 / 镜像与重复先核对语义 / 审查工具建议不照抄」）、target 树 `AGENTS.md`（注释 why-only、过时注释按 bug）、`docs/agents/harness-development.md`、`GLOSSARY.md`、`docs/adr/*`，叠加 Fowler smell 基线。

**r2 增量（683d000 实际改动行）硬违规：0。** 逐项：

1. **（pass 项）补测试能红**：A5 修复前红复现已场执行，三项新测试全红且失败签名精确对应该修复的行为差异（malformed JSON 整轮 reject / failures 空 / stop 后仍落库）。
2. **（pass 项）注释纪律**：新增注释（`adapter.ts:171-172,182-183,264,421`；test 内红测口径注释）均为 why/why-not 中文注释，无 what/how 复述；r1 F7 假注释已删除而非改写为另一假话。
3. **（low，OCR 命中，in-diff 邻域）零摘要字面量第 4 份拷贝**：`adapter.ts:172` stopped 短路新增 `{ sessions: 0, turns: 0, anomalies: 0, skipped: false }`，与 `:226/:238/:251` 三处逐字相同（r1 F13 已标 triple，本轮 +1）。judgement-call smell（Duplicated Code）。建议 `const emptySummary = (skipped: boolean) => ({…})`。
4. **（low，存量、base 已在、r1 F6 未修）Record 动态键分发无 `Object.hasOwn` 守卫**：`adapter.ts:401` `!(turn.status in TURN_STATUS_MAP)`、`:454/:477` 索引——外部值经 `in`/索引分发可命中原型链键。违反 review-standards「Record 动态键分发」。r1 已报，本轮范围外存量，未新增。
5. **（low，存量、r1 F8 未修）状态词表第二份手写清单**：`adapter.ts:346-353` 手写六值枚举 vs `contract.ts:109 isThreadNativeStatus` 单源（r1 已核对语义相同，判重复债）。未新增。
6. **（low，OCR 命中，in-diff）capabilityManifest degradations 未列 `adapter_failed`**：`adapter.ts:136` 声明 `["source_unreadable", "unknown_native_status"]`，但本 diff 使 adapter 自产 `adapter_failed`（`:185`；`FAILURE_CODES` 含该值，`contract.ts:16-21`）。codex 侧无此问题（`codex/adapter.ts:61` 不自产 adapter_failed，仅 registry 包装）。建议补列使 manifest 与可观测降级面对齐。
7. **（low，OCR 命中，in-diff 注释邻域）stopped 检查先于 inFlight 共享**：`adapter.ts:171-173`——stop() `await inFlight` 窗口内 `stopped` 已置 true，并发 `scanNow` 返回零摘要而非共享在飞 pass，与 `:169` 单飞注释「并发调用共享在飞 pass」字面冲突。swap 两检查即可保持 post-stop 行为不变（OCR 建议代码经本 auditor 读码验证等价；per review-standards「审查工具建议不照抄」已核对）。行为影响：仅 shutdown 窗口语义，无 stop-后写库。

合计：Standards 轴 **0 hard（in-diff）/ 5 low（2 in-diff 新增 + 1 in-diff 注释邻域 + 2 存量）+ 2 pass 项**。

## 三、Spec 轴（code-review，Spec：brief/返工反馈要求 vs 实际）

Spec 源：issue #44 正文与全部评论（含 CHANGES REQUESTED、「补充 45ffa34」）、r1 审计报告 findings（本仓 `.mea/audits/issue-44-r1.md`）、Manager r2 返工指派四项（F1-high 非法 message.data、F2-medium scanNow stopped 守卫、F3-low fixture 假注释、F4-low 头注释路径）、`docs/spec/phase1-observation-mvp.md` §5/§10、ADR-0018。

**(a) 要求了但缺失/部分缺失：**

1. **（medium，流程）push + issue base/target 完整 SHA 评论仍未完成**（r1 F2 延续，A13）：origin/harness/zcode 仍停在 base `477bcc5`，issue 无新 SHA 评论，外部按 issue 无法取得被审 head。缓解：声明如实披露且按 Manager 指派归发布环节（MEA workflow deliver 属 Manager）；**交付（PR/push）前必须补上**。注意本项与 r1 的差别：r1 时该要求直接约束实现者且未披露；本轮 Manager 重新划定发布归属并已在本地复核 target（「Reviewed target 683d000」），故降级为交付前置条件而非返工失败。

**(b) 未要求的行为（scope creep）：** 未发现。683d000 仅落四项反馈对应修复与三项红测；无共享层、契约、迁移、daemon 改动（A11）。

**(c) 看似实现但可能不对：**

2. **（medium，perf，OCR 命中）`json_valid` 全表逐行求值先于水位跳过**：`adapter.ts:265-274` 的 latestMessages 查询在水位指纹跳过判断（`:281-289`）**之前**执行，且 `json_valid(data)` 位于窗口子查询 select-list——每行求值（旧查询 `json_extract` 只在 `rn=1` 幸存行求值）。后果：默认 30s 周期 tick 即使最终 skipped，也完整校验整张 message 表。本 auditor 探针：2000 行 fixture 库 skip-pass ~2.0-2.6ms；真实 876MB 库未实测（uncovered #1）。另 OCR 指出该查询本就只被 `buildPatch` 消费、可整体移到指纹跳过之后——与 r1 既有的「sessions/turns 查询也在跳过前」存量债同向，但本 diff 新增了每行 JSON 解析，放大了存量问题。建议：`json_valid` 移到 `rn=1` 过滤之后（外层再套一跳），并将整个 latestMessages 查询移到 fingerprint skip return 之后。
3. **（low，bug，OCR 命中）malformed anomaly 生命周期不覆盖「原地修复」**：`:419-429` anomaly 在 commit 时插入、由 `resolveAnomalies` 在下次非跳过 commit 清算；水位指纹（`sessions.length|turns.length|max(time_updated)`，`:276-280`）不含 message 表内容——上游原地修复/新增坏行而不动 `session.time_updated` 时 pass 跳过，anomaly 滞留或新损坏不可见，直到无关会话/turn 变化触发重放。有界陈旧（新消息通常 bump time_updated）。建议：把 message 行数（或 max(id)）折进指纹。
4. **（low，OCR 命中）NULL data 边界**：`json_valid(NULL)` 返回 NULL，`:420` `message.valid === 0` 不捕获 → 无 anomaly；但 `role=null` 使状态回落 turn 终态，宁保守、不误报 running（fixture `data TEXT NOT NULL`（`fixture.ts:80`）挡住该路径；真实库 NOT NULL 未验证，见 uncovered #6）。不判缺陷，记录边界行为。
5. **已核对为合理、不判缺陷**：anomaly 通道 vs failures 通道分工——非法行降级走 anomaly（可展示：`reader_anomalies` 表 + `views.ts:89,259` 游标计数入 state；测试断言 `failures` 空、`summary.anomalies>=1`），pass 级意外异常走 `adapter_failed` failure——与 r1 建议的两层修复一致，无伪造 source 级失败。`skipped` 语义、`byteOffset:0` 与 `unknown_turn_status` 同口径。

小结：Spec 轴 **四项 r2 返工反馈全部达成并经红→绿复验；残留 1 项流程前置（push/评论，归属 Manager）+ 1 项 medium perf + 2 项 low**。

## 四、OCR（open-code-review）

- **状态：可用并跑完（对 r2 增量）**。命令：`ocr review --audience agent --background "<r2 返工背景>" --from 39d70d780927f6e90bdeed35fb8bb1a55ddd3547 --to 683d000307d9c86ad437832905f7f32d9691547d --output /tmp/ocr_issue44_r2.txt`（worktree 内；首次尝试因 auditor 传入 padded 无效 SHA 报 `not a valid commit ref`，更正后重跑成功——如实记录）。
- **结果：exit 0**；`2 file(s) reviewed, 5 comment(s), ~1082715 token(s), 30m0s`；session `20cba865-f5f9-4773-a9cf-d6fa9cf9b702`。
- **运行警告（覆盖度折扣）**：`Core review (1 request): adapter.ts+fixture.ts timed out -> failed`（round 2 LLM deadline exceeded）+ 1 条 `file_read failed: invalid line range`。5 条 comment 均落在 adapter.ts；**fixture.ts 与 adapter.ts 部分行段可能未被 OCR 完整覆盖**，本轮 Standards/Spec 结论以本 auditor 独立读码为主、OCR 为辅。
- **发现分布**：medium×1（N1 perf）、low×4（N2 stopped/inFlight 顺序、N3 anomaly 生命周期、N4 degradations 缺列、N5 零摘要第 4 拷贝）。逐条经本 auditor 读码核对后并入 findings（未照抄建议代码，N2 建议已验证等价）。
- OCR 仅为发现来源，不作为审计结论；本报告 verdict 独立于 OCR。

## 五、claim_integrity：**clean**

**声明（dispatch summary/evidence）逐条比对已提交 diff 与本次记录输出：**

| 声明 | 复核命令/证据 | 判定 |
|---|---|---|
| F1-high：json_valid 守卫 + malformed_message_data anomaly + pass 级异常落 adapter_failed/retryable | A7 读码三处 + A5 红 + A3/A4 绿 | ✓ 真 |
| F1b 红：修复前 `scanNow` 整轮 reject「malformed JSON」且 failures 空 | A5 红复现：`Error: malformed JSON at adapter.ts:259`（ERR_SQLITE_ERROR），测试在 `await adapter.scanNow()` 处中止（failures 断言未及执行即整轮 reject，与声明口径一致） | ✓ 真 |
| F1a 红：`AssertionError 0 !== 1`（observe().failures.length，crash 测试） | A5：test:365 `assert.equal(observation.failures.length, 1)` → `0 !== 1` | ✓ 真 |
| F2 红：`✖ scanNow after stop()…deep-equal 不匹配` | A5：test:394 deep-equal，actual `{sessions:1,turns:1,anomalies:0,skipped:false}` vs expected 全零 | ✓ 真 |
| 修复后 12/12 → 13/13 → 14/14 绿（三步红→绿序列） | 终态 14/14 绿（A4）+ 红态 11/14（A5）确证三项能红；12/12、13/13 中间态为开发过程声明，无法事后逐帧复验，但与终态/红态自洽 | ✓ 真（中间态按过程声明采信，终态与红态实证） |
| 全量 441 / 440 pass / 1 skip / 0 fail | A3 逐字一致 | ✓ 真 |
| `pnpm typecheck` exit 0（root+scripts+web，实证 SQLInputValue 可导入） | A2 exit 0；`fixture.ts:9` 导入 + `:135` 使用编译通过 | ✓ 真 |
| 提交 683d000、3 files +142/−8、git status 干净、首父链 ff 无需 force | A11/A12：`git show --stat` 3 文件 +142/−8；taskboard-zcode status 空；`683d000 39d70d7 … e8336e6 477bcc5 45ffa34` | ✓ 真 |
| 已提交到 harness/zcode、未 push（发布归 Manager） | `ls-remote origin harness/zcode` = `477bcc5`；本地分支 head = target | ✓ 真（如实披露，见 A13/N6） |
| 双轴自审符合 review-standards「补测试要证明能红」等 | A5 独立复现红；Standards 轴逐条核对 | ✓ 真 |

**判定 `clean`**：全部可验证声明与已提交 diff、本次实测输出一致；无夸大、无假理由（r1 的 SQLInputValue 假注释已删除并改为真实导入）；唯一未完成事项（push/评论）已在声明中如实披露且归属已变更。

## 六、领域审查（Manager 指派：只读边界与 unknown 降级语义；ZCode 私有 schema 是否泄漏进共享契约层）

**结论：只读边界 PASS；unknown 降级 PASS（r1 的 high 例外已闭合，残留低危边界如实记录）；无私有 schema 泄漏 PASS。**

1. **只读边界 PASS**：
   - 唯一打开路径仍为 `probe.ts:31-32` `new DatabaseSync(dbPath, { readOnly: true })`；`grep -rniE "insert|update |delete |pragma|attach|write" src/harness/zcode/*.ts`（排除 fixture）唯一命中 `probe.ts:35` `PRAGMA table_info`（只读）。r2 增量仅改 SELECT 语义（加 `json_valid`/`CASE` 守卫），无新写路径。
   - 字节级证据（本轮实际运行）：`WAL-mode source is scanned without modifying db/wal/shm`、`repeated scans stay idempotent and never touch the source db bytes` 均 PASS（A3 全量内）。
   - 零驱动入口维持 r1 结论（A11 零共享层改动 + r1 A10 grep）；测试内的 corruptor `UPDATE message SET data=…` 只写 fixture 临时库（`test/zcode-adapter.test.ts:310-313`），非观察对象。唯一落库面仍是 `store.commitSourceScan`（Taskboard 自有库，ADR-0002 单写者）。
2. **unknown 降级语义 PASS（r1 F1 例外闭合）**：
   - 非法 `message.data` → `malformed_message_data` anomaly + running 判定保守回落 turn 终态，**不阻塞其它会话**（A5 红 → A3/A4 绿；A7 边界探针确认标量 JSON 亦不误报 running）；
   - pass 级意外异常 → 重抛前落 `adapter_failed`/`retryable` scanFailure，`observe().failures` 可展示（新测试 crash 桩实证）；
   - 未知 turn 状态 → anomaly 不猜测（存量测试绿）；schema 列缺失 → 整体 `source_unreadable`/`retryable:false`（存量测试绿）；缺源 → retryable 且轮次计 done（存量测试绿）；能力面不虚报 `summary.read`（r1 保留通过项，本轮复核 `adapter.ts:126-138` 未变）。
   - 残留低危边界：NULL data 不产 anomaly 但保守降级（N4）；anomaly 生命周期对「原地修复」有界陈旧（N3）。
3. **私有 schema 泄漏 PASS**：
   - `session`/`turn_usage`/`message`/`schema_migration` 列名与私有 SQL（含新增 `json_valid`）全部止步 `src/harness/zcode/**`；`grep -rniI "zcode" src web scripts -l | grep -v src/harness/zcode` → 无命中；`test/` 内除 `zcode-adapter.test.ts` 外零引用；`grep -rn "zcode" src/harness/contract.ts src/harness/registry.ts src/harness/ids.ts src/daemon.ts src/views.ts src/http.ts` → 无命中。
   - `grep -rniE "turn_usage|task_type|time_compacting|schema_migration|json_valid" src -l | grep -v src/harness/zcode` 唯一命中 `src/schema.ts` 的 `schema_migrations`（Taskboard 自有迁移表，复数、非 ZCode 表）——非泄漏。
   - 新类型面：`LatestMessageRow.valid` 为 adapter 模块私有 interface（未导出）；anomaly `kind: "malformed_message_data"` 经共享契约自由字符串通道（`thread-store.ts:240` `kind: string`）流动，属数据而非 schema 外泄；`zcode:` 前缀 id 维持 ADR-0018 不透明身份值。

## 七、r1 findings 状态复核（逐条）

| r1 | 状态 | 证据 |
|---|---|---|
| F1 high 非法 message.data 静默杀死整轮 | **FIXED（683d000）** | A5 红 + A7 读码 + A3/A4 绿 |
| F2 medium push + issue SHA 评论 | **OPEN（流程，归属 Manager 交付）** | A13；声明已披露 |
| F3 medium scanNow 无 stopped 守卫 | **FIXED（683d000）** | A5 红 + A8 |
| F4 medium registry.stop 无失败隔离（codex 车道） | OPEN，范围外存量（`registry.ts:45-47` 本轮读码复核未变） | 读码 |
| F5 medium codex stop 后可复触发写入（codex 车道） | OPEN，范围外存量 | r1 读码结论沿用，本轮未重审 codex 细节 |
| F6 low Object.hasOwn 守卫缺失 | OPEN，存量 | `adapter.ts:401` |
| F7 low fixture 假注释 | **FIXED（683d000）** | A9 |
| F8 low 状态词表重复 | OPEN，存量 | `adapter.ts:346-353` |
| F9 low 头注释路径错误 | **FIXED（683d000）** | A10 |
| F10 low daemon scan 门 codex===null（codex 车道） | OPEN（`daemon.ts:236` 复核未变） | 读码 |
| F11 low OCR 4 项（codex/store 车道） | OPEN，范围外 | r1 记录沿用 |
| F12 low 单飞 staleness 注释 | OPEN（judgement） | `adapter.ts:169` |
| F13 low 零摘要字面量三连 | OPEN 且 +1（现四连） | N5 |

## 八、Findings（severity / location / category / what / evidence / recommendation）

1. **medium / 流程（issue #44 + origin `harness/zcode`）/ acceptance / push 与 issue base/target 完整 SHA 评论仍未完成，被审 head 仅在本地（r1 F2 延续）**
   - 证据：`git ls-remote origin harness/zcode` → `477bcc53280b75ead4e6889421bdd5294d487b11 refs/heads/harness/zcode`；`gh issue view 44 --json comments` → 6 条，无 `683d000` 评论。
   - 建议：Manager 交付步骤（workflow step 8 `pr-delivery`）前 `git push origin harness/zcode`（首父链 ff）并在 issue 追加 base/target 完整 SHA + 测试证据评论。
2. **medium / `src/harness/zcode/adapter.ts:265-274`（先于 :281-289 水位跳过）/ spec-perf / `json_valid` 在窗口子查询 select-list 对整张 message 表逐行求值，且整个 latestMessages 查询在 skipped 判定前执行——每个周期 tick 即使跳过也全表解析 JSON**
   - 证据：读码 SQL 结构；本 auditor fixture 探针（2000 行）skip-pass ~2.0-2.6ms/轮，成本随 message 行数线性；OCR medium 独立命中。
   - 建议：`json_valid` 移到 `rn=1` 过滤之后，并把 latestMessages 查询整体移到 fingerprint skip return 之后（仅 `buildPatch` 消费）。
3. **low / `src/harness/zcode/adapter.ts:171-173` vs `:169` / bug / stopped 检查先于 inFlight 共享：stop() await 在飞窗口内并发 scanNow 返回零摘要而非共享在飞 pass，与单飞注释字面冲突**
   - 证据：读码 stop():151-158（先置 stopped 再 await inFlight）与 scanNow():170-173；OCR low。无 stop-后写库（短路在前反而保证）。
   - 建议：两检查顺序对调（先 `inFlight` 共享、后 `stopped` 短路），OCR 建议代码已验证 post-stop 行为等价。
4. **low / `src/harness/zcode/adapter.ts:419-429` + `:276-280` / bug / malformed anomaly 生命周期不覆盖 message 表原地变更：指纹不含 message 内容，原地修复/损坏在下次无关重放前不可见或滞留**
   - 证据：读码指纹构成与 `resolveAnomalies` 语义；OCR low。
   - 建议：指纹折入 message 行数或 max(id)。
5. **low / `src/harness/zcode/adapter.ts:136` / standards / capabilityManifest.degradations 未列自产的 `adapter_failed`**
   - 证据：读码 `:136` vs `:185` + `contract.ts:16-21` FAILURE_CODES；OCR low。
   - 建议：补列 `adapter_failed`（codex 侧不自产，无需对齐）。
6. **low / `src/harness/zcode/adapter.ts:172,226,238,251` / standards(smell) / 零摘要字面量四连（r1 triple +1）**
   - 证据：四处逐字相同。
   - 建议：提取 `emptySummary(skipped)` 工厂。
7. **low / `src/harness/zcode/adapter.ts:401,454,477`（存量）/ standards / Record 动态键分发仍无 `Object.hasOwn` 守卫（r1 F6 沿袭）**
   - 证据：读码 + review-standards 条款。
   - 建议：`Object.hasOwn(TURN_STATUS_MAP, status)` + 对齐测试。
8. **low / `src/harness/zcode/adapter.ts:346-353`（存量）/ standards / 手写状态词表与 `contract.ts:109 isThreadNativeStatus` 重复（r1 F8 沿袭）**
   - 建议：改用 `isThreadNativeStatus()`。
9. **low / `src/harness/registry.ts:45-47`、`src/daemon.ts:236`、codex adapter/reader（合并基线，codex 车道）/ bug-maintainability / r1 F4/F5/F10/F11 全部沿袭未修**——本轮范围外（CHANGES REQUESTED 明确共享层归 Codex），如实记录待 codex 车道处理。

## 九、Uncovered risks（本次审计未覆盖）

1. **真实库（876MB WAL、939 会话、message 表未知行数）未实测**：N2 perf 的真实影响、字节不变、性能数字为 fixture 级实测 + 实现者记录；审计未触碰生产库。
2. **`pnpm test:ui` 29 项全绿但不含 ZCode 场景**：同屏显示仍由 registry 合并测试 + 探针证据代偿（issue 自述安排），daemon 装配合并后需目视终验。
3. **OCR 覆盖度折扣**：core review round 超时失败 + 1 file_read 错误；fixture.ts 与 adapter.ts 部分行段可能未经 OCR 完整覆盖（本轮以独立读码补足）。
4. **红→绿中间态（12/12、13/13）按过程声明采信**：仅终态与三项红态经 auditor 独立复验。
5. **r1 F5/F11 codex 基线细节未在本轮重审**：沿用 r1 读码结论，codex 车道修复时需其 Auditor 复核。
6. **NULL `message.data` 真实库约束未验证**：fixture `NOT NULL`；若真实库允许 NULL，`json_valid(NULL)=NULL` 不产 anomaly（保守降级成立，见 N4）。
7. **`held` 状态、fork lineage 跨库清理、归档库 sessions.db / tasks-index.sqlite**：维持 issue 自述未验证状态。

## 十、verdict_inputs：**green**

- **依据**：(1) r1 两个 not-green 阻断项中，代码项 F1（high，未知字段降级可展示）已修复并经 auditor 独立红→绿复验（A5/A7）；(2) 流程项 F2（push+评论）本轮由 Manager 重新划定归属（声明如实披露「发布归 Manager」，MEA workflow.md deliver/pr-delivery 属 Manager 且位于 audit 之后），Manager 已在本地复核 target 后派发审计——降级为交付前置条件（finding 1），不再是实现返工失败；(3) 全量验收 A2-A12 全 PASS，声明数字逐字一致；(4) Standards 轴 in-diff 零硬违规；(5) 领域审查三项全 PASS；(6) claim_integrity = clean。
- **绿的边界（Manager 决策输入）**：**放行 `mea:audit-passed` 前提是交付步骤补齐 finding 1（push + issue SHA 评论）**；N2（perf）建议在 daemon 装配切片或下轮顺手处理，不阻塞本切片。
- **回环建议（非阻断）**：N2/N3/N4/N5 与存量 F6/F8 可合并进后续 zcode 切片一次处理；F4/F5/F10/F11 归 codex 车道。
