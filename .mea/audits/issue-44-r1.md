# 审计报告：issue #44「[Phase 1][S3] ZCode 只读 adapter 与同屏展示」(r1)

- **issue**: https://github.com/jasonQin6/taskboard/issues/44
- **base_sha**: `477bcc53280b75ead4e6889421bdd5294d487b11`
- **target_sha**: `e304043f8862fa4a19fb7e630741447aacfa6780`（被审 head）
- **被审 head 复核（Stop 条件）**: 提交报告前 `git -C ../taskboard-zcode rev-parse harness/zcode` = `e304043f8862fa4a19fb7e630741447aacfa6780` ✓
- **审计 worktree**: `git worktree add --detach ../mea-audit-r1 e304043f8862fa4a19fb7e630741447aacfa6780` → `HEAD is now at e304043`；`git -C ../mea-audit-r1 rev-parse HEAD` = `e304043f8862fa4a19fb7e630741447aacfa6780`（逐字一致），报告前 `git status --short` 为空。
- **审计日期**: 2026-10-27；**角色**: auditor-r1（独立于实现者）；worktree 内先执行 `pnpm install`（exit 0）。
- **范围构成**: `git log 477bcc5..e304043 --oneline` = `e304043`(返工实现) ← `e8336e6`(merge，第二父 `45ffa34`) ← codex 基线系列(`45ffa34`,`b6e97dc`,`1acfee2`,`b5e7dd2`,`c98fa31`,`aab8f36`,`9e5e6f0`,`c47d479`,`fc485b1`,`5d7051e`)。合并为 CHANGES REQUESTED 明确要求（"返工 rebase/merge 目标请以 origin/harness/codex@45ffa34 为准"），非夹带。
- **过程偏差声明**: `code-review` skill 的两轴要求并行子代理执行；本 harness 无 Agent/Task 子代理工具，Standards/Spec 两轴由本 auditor 在会话内分别执行、分别报告、不交叉重排（内容与范围遵 skill）。OCR 独立执行。

## 一、验收（逐条：命令 + exit code + 通过/失败数 + 证据）

环境：worktree `../mea-audit-r1`（HEAD=target），`pnpm install` exit 0；node v26.9.0（测试日志中 driver 路径 `/opt/homebrew/Cellar/node/26.9.0/bin/node`）。

| # | 验收条目（来源） | 命令 | 结果 |
|---|---|---|---|
| A1 | worktree HEAD == target（Auditor contract） | `git worktree add --detach ../mea-audit-r1 e304043…`；`git -C ../mea-audit-r1 rev-parse HEAD` | `e304043f8862fa4a19fb7e630741447aacfa6780` ✓ PASS |
| A2 | `pnpm typecheck`（issue 验收：根 + scripts + web） | `pnpm typecheck`（= `tsc --noEmit && tsc -p tsconfig.scripts.json --noEmit && tsc -p web/tsconfig.json --noEmit`） | exit 0，零诊断 ✓ PASS |
| A3 | `pnpm test`（issue 验收） | `pnpm test`（= `tsx --test test/*.test.ts`） | exit 0：**tests 438 / pass 437 / fail 0 / skipped 1** ✓ PASS（与声明逐字一致） |
| A4 | adapter fixture 测试（issue 验收） | `npx tsx --test test/zcode-adapter.test.ts` | exit 0：**tests 11 / pass 11 / fail 0** ✓ PASS（原 7 + 新 4，与声明一致） |
| A5 | `pnpm test:ui`（issue 验收「页面变化时」；本切片自身 0 web 改动，范围内唯一 web 差异 `web/src/lib/latest-only.ts` 为合并带入的纯注释改动，仍无条件补跑） | `pnpm test:ui`（= `pnpm build:web && tsx scripts/ui-smoke.ts`） | exit 0：**`test:ui PASS (29 checks)`** ✓ PASS |
| A6 | fixture 能在同一列表显示会话 + provenance（issue 验收） | A4 内测试 `zcode adapter: registry merges zcode and codex sessions onto one board`（断言 `merged.sessions` 双 harness 同列表、`provenance.length > 0`、`ZCODE_HARNESS_ID === "zcode"`） | ✓ PASS（issue 已声明的代偿方案：registry 合并测试 + 真实库探针记录；daemon 装配合规缺口归 Codex，见 Spec 轴） |
| A7 | 重复扫描幂等（issue 验收 + spec §10.1） | A4 内测试 `repeated scans stay idempotent and never touch the source db bytes`；`progress` 测试内水位跳过断言（`skipped:true`、sessions 仍 1） | ✓ PASS |
| A8 | 未知 schema/字段降级可展示（issue 验收 + spec §5.7、§10.8） | A4 内测试 `schema drift degrades to a structured failure…`（列缺失 → `source_unreadable`/`retryable:false`，failures 可展示）与 `unmapped turn status degrades to an anomaly…`（值域未知 → anomaly 可展示）均 PASS；**补充探针**（本 auditor 构造）：fixture 落库后 `UPDATE message SET data='{not-json'` 再 `scanNow()` | 两个子项 PASS；**第三子项 FAIL**：`scanNow threw: Error: malformed JSON`、`observe().failures: []`、`progress: {phase:"idle",filesTotal:1,filesDone:0,lastCompletedAt:null}`、`sessions: 0` —— 无法解析的字段**静默杀死整轮且不可展示**（详见 F1）。该条目整体判 **FAIL（部分）** |
| A9 | 读取期间源 SQLite、WAL、tasks-index、memory 不被修改（issue 验收 + spec §10.9） | A4 内测试 `repeated scans…source db bytes`（db 字节 deepEqual）、`WAL-mode source is scanned without modifying db/wal/shm`（db/-wal 字节 deepEqual + -shm stat 存在）；`grep -rniE "tasks-index\|memory" src/harness/zcode/` | ✓ PASS：db/wal/shm 由字节断言覆盖（PASS）；tasks-index 与 memory **全仓 zcode 代码不打开**（grep 仅命中 `fixture.ts:105` 关于 `:memory:` 的注释），以代码检视为证、无直接字节断言（如实记录） |
| A10 | adapter 无共享层条件分支、无驱动入口（issue 验收） | `grep -rniI "zcode" src web scripts -l \| grep -v src/harness/zcode` → 无命中；`grep -rniE "\bresume\b\|\bsample\b\|\bsend\b\|\bcompact\b\|goal\|app-server\|acp" src/harness/zcode/*.ts` → 无命中 | ✓ PASS（共享层 src/web/scripts 零 `zcode` 引用；zcode 目录零驱动动词；`cancel`/`compacting` 命中为状态词与列名，非驱动入口） |
| A11 | 返工：按 fix-B1 契约实现 `start/stop/progress/scanNow` 四成员且 progress 如实（CHANGES REQUESTED） | A2 typecheck（契约实现性）+ A4 四项生命周期测试（idle→running→done 计数/时间戳、start 立即扫+stop 等在飞、scanNow 单飞、缺源降级计 done）+ 本 auditor 读码 `src/harness/zcode/adapter.ts:139-199` | ✓ PASS（非写死常量：`progress()` 返回实例字段；`stop(): Promise<void>`；`scanNow(): Promise<ZcodeScanSummary>` ⊂ `Promise<unknown>`） |
| A12 | 返工：fixture 参数类型修 `any` 绕过（CHANGES REQUESTED） | `grep -rn "any" src/harness/zcode/*.ts` → 无 `: any`/`as any`；`fixture.ts:135` `Array<string \| number \| null>`；A2 通过 | ✓ PASS（但其注释事实性错误，见 F7） |
| A13 | 返工：未触碰 `src/daemon.ts`、`contract.ts`、`src/harness/codex/**`（CHANGES REQUESTED） | `git show --stat e304043` → 仅 `src/harness/zcode/adapter.ts`(+99)、`fixture.ts`(+3)、`test/zcode-adapter.test.ts`(+162)；`git diff 45ffa34 e8336e6 -- src/daemon.ts src/harness/contract.ts src/harness/codex src/store src/views.ts src/harness/registry.ts src/harness/ids.ts` → **空**；`git diff 477bcc5 e8336e6 -- src/harness/zcode test/zcode-adapter.test.ts` → **空** | ✓ PASS：返工提交仅 3 文件；merge 相对 codex tip 仅新增 zcode 4 文件（985 行），共享层字节 = `45ffa34` 原样；zcode 文件经 merge 未被改动。base..target 范围内 `src/daemon.ts` 等共享层差异**全部**来自被要求合并的 codex 基线（`b6e97dc`/`45ffa34` 系列，author jason/codex 车道） |
| A14 | 返工：push 后在 issue 评论新的 base + commit 完整 SHA（CHANGES REQUESTED 明列） | `git -C ../taskboard-zcode ls-remote origin harness/zcode`（审计初与复核各一次）；`gh issue view 44 --json comments,labels` | ✗ **FAIL**：origin 仍 `477bcc5…refs/heads/harness/zcode`（target 未推送；本地 `harness/zcode` 领先 e8336e6+e304043）；issue 评论数 **6**，末条仍为审核方「补充…45ffa34」，无任何携带 `477bcc5`/`e304043` 完整 SHA 的新评论；标签 `mea:ready-for-audit`。详见 F2 |

小结：**13 PASS / 1 FAIL（A8 部分）+ 1 FAIL（A14）**。所有命令均在本次审计中实际执行，未跑过的检查不列为通过。

## 二、Standards 轴（code-review，Standards：仓库成文规范）

成文标准来源：`docs/agents/review-standards.md`（本审计侧 AGENTS.md 指定；该文件存在于文档分支 `ebba344`，**不在 target 树内**——以 `git show ebba344:docs/agents/review-standards.md` 读取）、target 树 `AGENTS.md`（注释 why-only、过时注释按 bug）、`docs/agents/harness-development.md`、`GLOSSARY.md`、`docs/adr/*`，叠加 code-review skill 的 Fowler smell 基线（仓库成文规范优先）。

**in-diff（返工提交 e304043 实际改动行）硬违规：0。** judgement-call 发现：

1. **（low，成文规范硬条款但属存量、非 in-diff）Record 动态键分发无 `Object.hasOwn` 守卫**：`src/harness/zcode/adapter.ts:386` `if (!(turn.status in TURN_STATUS_MAP))` 与 `:427`、`:450` `TURN_STATUS_MAP[...]` 直接索引——外部值（源库 `turn_usage.status`）经 `in`/索引分发，命中原型链键。实测：`node -e 'const m=Object.freeze({completed:…}); console.log("constructor" in m, typeof m["constructor"])'` → `true function`。违反 review-standards「Record 动态键分发」（必须 `Object.hasOwn` 或 `Object.create(null)`）。行存在于 base 477bcc5、rework 未触碰（范围外存量），归入本 issue 交付物。建议：`Object.hasOwn(TURN_STATUS_MAP, turn.status)` 守卫 + 对齐测试。
2. **（low，存量重复债，语义已核对）状态词表第二份手写清单**：`adapter.ts:331-338` 手写 `=== "running" || … === "held"` 枚举；`contract.ts:109` 已导出单源 `isThreadNativeStatus`（base 即存在字面版，target 为 `THREAD_NATIVE_STATUSES` 派生版）。按 review-standards「镜像与重复先核对语义」：两处语义核对**相同**（集合恰为 `THREAD_NATIVE_STATUSES`，表外值均落 `unknown`），确认为重复债而非有意子集。OCR 亦独立命中同点（low）。建议改用 `isThreadNativeStatus()`。
3. **（low，in-diff 注释事实性错误）** `fixture.ts:135` 注释「node:sqlite 未导出 SQLInputValue 类型」**不成立**：worktree 与实现者仓同为 `@types/node 24.19.1`；`.tmp-sqlipv.ts` `import type { SQLInputValue } from "node:sqlite"` + 合法赋值 → `tsc --noEmit … .tmp-sqlipv.ts` **exit 0**；负例（`{a:1}`）→ `error TS2353: … 'a' does not exist in type 'ArrayBufferView'` **exit 2**（证明导入解析到真实约束类型）。等价窄化本身是评审允许的写法（「显式 SQLInputValue[] 或等价窄化」），仅理由与注释错误——按 AGENTS.md「误导性注释按 bug 处理」。
4. **（low，存量文档错误）** `adapter.ts:2` 头注释源路径 `~/.zcode/cli/db/db/db.sqlite` 多一段 `db/`，与 `adapter.ts:37` `ZCODE_DEFAULT_DB_PATH = ~/.zcode/cli/db/db.sqlite`、`capabilityManifest().readPaths` 及 issue 探针记录不一致（存量，rework 未触碰）。
5. **（low，judgement，in-diff 邻域）** `adapter.ts:214/226/239` 三处相同零摘要字面量 `{ sessions: 0, turns: 0, anomalies: 0, skipped: false }`（Fowler Duplicated Code，judgement call）：可提取常量。
6. **（pass 项）补测试能红**（review-standards「补测试要证明能红」的反向验证，见第五节 TDD 红复现）：4 项新生命周期测试在实现前状态**全部变红**，满足可红要求。

合计：Standards 轴 **0 hard（in-diff）/ 5 low（3 存量 + 1 in-diff 注释 + 1 judgement）+ 1 测试可红 pass 项**；最严重者为 #3（in-diff 事实性错误注释，同时污染 claim）。

## 三、Spec 轴（code-review，Spec：brief/issue 要求 vs 实际）

Spec 源：issue #44 正文（目标/交付/验收）、其 CHANGES REQUESTED 与「补充 45ffa34」评论、`docs/spec/phase1-observation-mvp.md` §4/§6/§8/§10.1/§10.2/§10.3/§10.8/§10.9（issue 点名）、`ADR-0018`。

**(a) 要求了但缺失/部分缺失：**

1. **返工要求「push 后在 issue 评论新的 base + commit 完整 SHA」未完成**（A14/F2，medium）：目标提交只存在于本地两仓（`../taskboard`、`../taskboard-zcode`），origin/harness/zcode 仍停在 base；issue 证据链仍指向旧 SHA，外部按 issue 无法取得被审 head。
2. **验收「未知 schema/字段降级可展示」部分失败**（A8/F1，high）：spec §5 规则 7「无法解析的 Harness 字段降级为 `unknown` 或 opaque evidence，不阻塞其它会话」与 issue 验收「未知 schema/字段降级可展示」在 `message.data` 非法 JSON 路径上不成立——整轮静默死亡且 `observe().failures` 为空（复现见 F1）。注意：issue「风险与未覆盖」曾自估该风险为「状态回退 idle/unknown，不会误报 running（宁保守）」，实际失败面比自估更重（整轮不执行、无任何可展示失败）。此行为在 base 477bcc5 已存在，rework 的 `start()` 内新增 `.catch(() => undefined)`（`adapter.ts:141,143`，in-diff）使周期路径从「unhandled rejection 警告」变为完全静默。

**(b) 未要求的行为（scope creep）：** 未发现。e304043 仅落评审要求的生命周期面与 fixture 类型；合并提交内容 = 被要求的 `45ffa34` 基线，且共享层与其逐字节相同（A13）。`ZcodeScanSummary` 导出为 zcode 目录内类型，不进共享层。

**(c) 看似实现但可能不对：**

3. **`stop()` 契约注释 vs `scanNow()` 无守卫**（F4，medium）：`adapter.ts:148` 注释承诺「daemon 关停返回后，不允许再有本 adapter 的落库写入在途」，但 `scanNow()`（:168）不检查 `stopped`——stop 后调用会开全新整库 pass 并 `commitSourceScan` 写入。Codex reader 有部分缓解（`runPass` 逐文件 `if (this.stopped) break`），zcode 无等价物。当前 zcode 未装配进 daemon（显式缺口），但对象 API 公开、`RunningDaemon.harnesses` 暴露 registry 句柄，属可达契约违反。
4. **合并带入的 codex 基线缺陷（非本 issue 实现，范围内如实上报）**：`registry.stop()` 串行无失败隔离、codex adapter/reader stop 后 start/scanNow 可复触发并跑 store 写尾部、`daemon.ts` scan 门仍按 `codex === null` 分支（zcode 装配后会静默丢 scan 端点）等——OCR 命中，本 auditor 读码复核（见 findings F8-F10 与 OCR 段）。
5. **已核对为合理、不判缺陷的语义差异**：issue 正文「schema 不匹配降级为 unknown」vs 实现「整 harness `source_unreadable` 结构化 failure（retryable:false）」——issue S3 交付评论明确设计为整体降级不部分读取，前轮 CHANGES REQUESTED 明列保留通过；`capabilityManifest.schemaVersion` 在漂移时落 `zcode-sqlite/unknown`（`probe.ts:28`），与 ADR-0018「版本或结构不匹配时降级为 unknown」相容；spec §10.2/§10.3（原生摘要）因真实库无摘要记录而以 `capabilities` 只列 `session.list`+`turn.read`、`summaries: []` 如实呈现（前轮已 pass，本轮复核仍成立）。单飞不排队补扫（vs reader 的 `queued`）有领域注释依据（整库单快照读），OCR 对其有 low 级 staleness 质疑，本轴记为 judgement 备注。

小结：Spec 轴 **不通过**：返工代码项全部达成，但 1 项流程要求（push+评论）未达 + 1 项验收（降级可展示）在真实失败面上未达。

## 四、OCR（open-code-review）

- **状态：可用并跑完**。命令：`ocr review --audience agent --background "<issue #44 返工背景>" --from 477bcc53280b75ead4e6889421bdd5294d487b11 --to e304043f8862fa4a19fb7e630741447aacfa6780 --output /tmp/ocr_issue44.txt`（worktree 内）
- **结果：exit 0**；`18 file(s) reviewed, 11 comment(s), ~3311382 token(s), 28m53s`；session `72456ee2-d2aa-490f-bb99-bcce85257cfd`。
- **运行警告（覆盖度折扣）**：3 条内部工具错误——`code_search failed: git grep … 'upsertThread(': missing closing parenthesis` ×1、`file_read failed: invalid line range` ×2；可能存在个别取证盲区，如实记录。
- **发现分布**：medium×3、low×8。按 review-standards「审查工具建议不照抄」，逐条读码核对后并入 findings：zcode×3（F1 静默 pass 失败——本 auditor 独立构造复现并升级为 high；F4 post-stop 写入；F12 单飞 staleness 注释）、codex 基线/共享层×7（F8 registry.stop 无失败隔离、F9 codex stop 后可复触发写入、F10 daemon scan 门 `codex===null`、F11 其余 4 条 low：ui-smoke 字面量、registry phase 聚合、harness_id 仅首插、`latestReaderSourceByThread` 幻影 `""` 键）、contract.ts×1（并入 Standards#2）。
- OCR 仅为发现来源，不作为审计结论；本报告 verdict 独立于 OCR。

## 五、claim_integrity：**suspect**

**声明（dispatch summary/evidence）逐条比对已提交 diff 与本次记录输出：**

| 声明 | 复核命令/证据 | 判定 |
|---|---|---|
| e304043 仅 3 文件（adapter +99/-、fixture +3/-、test +162/-），历史 477bcc5→e8336e6(merge 45ffa34)→e304043，e8336e6 为 477bcc5 直接子提交、推送无需 force | `git show --stat e304043`（3 files，+242/-22，逐文件 99/3/162 总变更行）；`git log --format='%H %P'` → `e8336e6 477bcc5 45ffa34`；首父链 `e304043←e8336e6←477bcc5` 保证 ff | ✓ 真 |
| 未触碰 `src/daemon.ts`、contract.ts、`src/harness/codex/**` | A13 三条 diff 全空/仅 3 文件 | ✓ 真（结构性证明） |
| `pnpm typecheck` 三 tsconfig 干净退出 | A2：exit 0 | ✓ 真 |
| `pnpm test` = 438/437 pass/0 fail/1 skip | A3：逐字一致 | ✓ 真 |
| `npx tsx --test test/zcode-adapter.test.ts` 实现后 11/11 | A4：11/11，exit 0 | ✓ 真 |
| 评审红复现：merge 45ffa34 后 typecheck 精确复现两处（TS2416 adapter.ts:129、TS2345 fixture.ts:147），TS2420 被掩盖 | 一次性 worktree `../mea-audit-r1-red` @ `e8336e6` + `pnpm typecheck` → **exit 2**，输出恰为 `adapter.ts(129,3) TS2416 … Promise<void>` 与 `fixture.ts(147,25) TS2345 … SQLInputValue`，**无 TS2420** | ✓ 真（逐字复现） |
| TDD 红：4 项生命周期测试实现前「全部失败（progress/summary 为 undefined）」 | e8336e6 + `git checkout e304043 -- test/zcode-adapter.test.ts` + `npx tsx --test test/zcode-adapter.test.ts` → **tests 11 / pass 6 / fail 5**；4 项新测试**全部红**（`adapter.progress is not a function`、`Cannot read properties of undefined (reading 'skipped')`、AssertionError），另 1 项被增强的旧测试（schema drift 追加 progress 断言）同红，5 项旧测试绿 | ⚠ 部分：若「全部失败」指 4 项新测试→真；若指整文件→**不成立**（5/11 过）。记录实际数 |
| fixture 窄化「node:sqlite 未导出 SQLInputValue 类型」 | 同 @types/node 24.19.1：`import type { SQLInputValue } from "node:sqlite"` tsc exit 0；负例 TS2353 exit 2；`sqlite.d.ts:42` 声明该类型 | ✗ **假**（写法本身合规且评审允许，但理由为假，且已固化进 `fixture.ts:135` 注释） |
| 生命周期四成员语义（start 立即扫/stop 等在飞/progress 如实单源计数/scanNow 单飞摘要） | 读码 `adapter.ts:139-199` + A4 四项测试 | ✓ 真 |
| 「推送时无需 force」（描述性） | 首父链 ff 成立；**但实际未推送**（origin=477bcc5） | 描述本身真；交付未完成 push 见 F2 |

**判定 `suspect` 理由**：全部可验证的数字/结构/红复现声明逐字成立；但 (1) 一条事实性理由被实验证伪（SQLInputValue「未导出」）并写入仓库注释；(2) TDD 红的「全部失败」措辞超出实际（5 fail/6 pass）；(3) 声明未提及但返工评审明列的 push+issue 评论未完成（归 Spec/F2，不构成声明造假）。无任何声明的验证结果系伪造 → 不到 `violation`。

## 六、领域审查（Manager 指派：只读边界与 unknown 降级语义；私有 schema 是否泄漏进共享契约层）

**结论：只读边界 PASS；unknown 降级 PASS（一处高危例外 F1）；无私有 schema 泄漏 PASS。**

1. **只读边界**：
   - 唯一打开路径 `probe.ts:31-32` `new DatabaseSync(dbPath, { readOnly: true })`；adapter 全部语句为 `SELECT`/`PRAGMA table_info`（`grep -rniE "insert|update |delete|pragma|attach" src/harness/zcode/*.ts`：adapter/probe 内仅 `PRAGMA table_info`；`INSERT` 仅 fixture 构造测试库，非观察对象）。
   - 字节级证据：`WAL-mode source is scanned without modifying db/wal/shm`、`repeated scans…never touch the source db bytes` 两测试在本轮实际运行均 PASS（A9）。
   - 零驱动入口（A10 grep）；不消费 tasks-index/memory（A9）；与 ADR-0018「adapter 默认只读，不写 Harness 的 JSONL、SQLite、文件或配置」一致。
   - 唯一写入面是 `store.commitSourceScan`（Taskboard 自有库，ADR-0002 单写者合规——测试经 openStateDb，daemon 场景由单实例锁保证）。
2. **unknown 降级语义**：未知 turn 状态 → anomaly 不猜测（`adapter.ts:386-395`，测试 PASS）；schema 列缺失 → 整体 `source_unreadable`/`retryable:false` 结构化 failure 不部分读取（测试 PASS，`capabilityManifest` 落 `zcode-sqlite/unknown`）；缺源 → retryable failure 且轮次计 done（测试 PASS）；`title` 空串→null→`unknownFields`；`observe()` 表外状态→`unknown`（`adapter.ts:319-338`）；能力面不虚报 `summary.read`（真实库无摘要，前轮保留通过项复核成立）。**例外**：无法解析的 `message.data` JSON → 整轮静默失败不可展示（F1，违反 spec §5.7 与 ADR-0018「通过 unknown 降级暴露」的暴露性要求）。
3. **私有 schema 泄漏**：`session`/`turn_usage`/`message`/`schema_migration` 列名与私有 SQL 全部止步 `src/harness/zcode/**`；共享层零 `zcode` 引用（A10）；`grep -rniE "turn_usage|task_type|time_compacting|schema_migration|time_updated" src` 唯一命中 `src/schema.ts` 为 Taskboard 自有 `schema_migrations`（复数、自有迁移表），非泄漏；`web/`、`scripts/`、其他 `test/*` 零引用；共享层只见契约字段（`SourceScanPatch`/`SessionSnapshot`/`SourceLocator`），`zcode:` 前缀 id 与 `zcode-db:` sourceId 以不透明身份值经 ADR-0018 通道流动，属契约要求而非 schema 外泄。

## 七、Findings（severity / location / category / what / evidence / recommendation）

1. **high / `src/harness/zcode/adapter.ts:168-185, 201-296`（SELECT :252-259；`start()` 内 `.catch` :141,143）/ spec / 非法 `message.data` JSON 使整轮扫描静默失败且不可展示，违反「未知字段降级可展示」验收与 spec §5.7**
   - 证据：本 auditor 复现脚本（fixture + `UPDATE message SET data='{not-json'` 后 `scanNow()`）输出：`scanNow threw: Error: malformed JSON`、`observe().failures: []`、`progress: {"phase":"idle","filesTotal":1,"filesDone":0,"lastCompletedAt":null}`、`sessions: 0`；读码确认 `scanSource` 仅捕获 stat/open（:205-227），SELECT 抛错直达 `scanNow` catch（:176-179）仅回 idle 重抛、不落 `scanFailure`，`start()` 周期路径 `.catch(() => undefined)` 吞掉；OCR medium 独立命中同点。
   - 建议：pass 级意外异常在重抛前写入 `scanFailure`（retryable，OCR 给出等价建议代码——落地前须自行验证编译与行为，per review-standards「审查工具建议不照抄」）；可选：逐行解析失败降级为 anomaly 以满足「不阻塞其它会话」；补红测。
2. **medium / 流程（issue #44 + origin `harness/zcode`）/ spec / 返工评审明列的「push 后在 issue 评论新的 base + commit 完整 SHA」未完成，被审 head 只在本地**
   - 证据：`git ls-remote origin harness/zcode`（审计初、复核两次）→ `477bcc53280b75ead4e6889421bdd5294d487b11 refs/heads/harness/zcode`；`gh issue view 44 --json comments,labels` → `n:6`，末条为审核方「补充…45ffa34」，无新 SHA 评论；标签 `mea:ready-for-audit`；本地 `git log origin/harness/zcode..harness/zcode` 含 e8336e6、e304043。
   - 建议：`git push origin harness/zcode`（首父链 ff 自 477bcc5，无需 force）并在 issue 追加 base/target 完整 SHA + 测试证据评论，再过审计门。
3. **medium / `src/harness/zcode/adapter.ts:148` vs `:168-185` / bug / `scanNow()` 不检查 `stopped`，stop() 返回后仍可开新 pass 并写库，违反自身契约注释**
   - 证据：读码（`stop()` :149-156 仅置位+清 timer+等在飞；`scanNow()` :168 无 stopped 分支）；`grep` 显示无其他守卫；OCR medium 独立命中。当前 zcode 未入 registry（装配缺口归 Codex），但 API/registry 句柄路径可达。
   - 建议：`scanNow()` 顶部 `if (this.stopped)` 短路返回零摘要（或 `runPass` 前置守卫），与 `start()` 的 stopped 守卫对称；补 stop 后 scanNow 的红测。
4. **medium / `src/harness/registry.ts:45-47`（合并基线 codex 车道）/ bug / `stop()` 串行 await 无失败隔离：任一 `adapter.stop()` 拒绝将中止后续 adapter 停止并中断 `daemon.close()` 收口链**
   - 证据：`git diff 477bcc5 e8336e6` 中 registry 新增段（`for … await adapter.stop()` 无 catch）；OCR medium；本 auditor 读码复核。当前实现恰好自吞拒绝，属契约级隐患。
   - 建议：`Promise.all(adapters.map(a => a.stop().catch(…)))` 聚合并记录；归 codex 车道修复。
5. **medium / `src/harness/codex/adapter.ts:65-80` + `src/reader/scanner.ts:95-160`（合并基线 codex 车道）/ bug / codex 侧 stop 后 `start()` 可重新武装 timer（`stopped` 仍 true），每 tick 空转 discover + `runPass` 尾部无条件 store 写；`scanNow()` 同样可 post-stop 写入**
   - 证据：读码 `scanner.ts:95-104`（start 仅守 `timer !== null`）、`:106-114`（stop 置 stopped）、`runPass` 循环 break 后尾部仍执行 `expireUnboundEvidence` 等；OCR medium（建议 adapter 层 stopped 守卫）；本 auditor 读码复核。与 zcode F3 语义不对称。
   - 建议：adapter/reader 统一 stopped 守卫，两 adapter 语义对齐；归 codex 车道。
6. **low / `src/harness/zcode/adapter.ts:386,427,450`（存量，base 已在）/ standards / `Record` 动态键分发未按成文标准用 `Object.hasOwn` 守卫，原型链键可穿透为「有效状态」**
   - 证据：`docs/agents/review-standards.md`「Record 动态键分发」（`git show ebba344:…`）；`node -e` 实测 `constructor in m → true`、`typeof m["constructor"] → function`。
   - 建议：`Object.hasOwn(TURN_STATUS_MAP, status)` 守卫（或 `Object.create(null)` 构建）+ 对齐测试。
7. **low / `src/harness/zcode/fixture.ts:135`（in-diff）+ claim evidence / standards-claim / 「node:sqlite 未导出 SQLInputValue 类型」为假陈述，固化进仓库注释**
   - 证据：`@types/node 24.19.1`（两仓一致）；`tsc … .tmp-sqlipv.ts` 合法导入 exit 0、负例 TS2353 exit 2；`node_modules/@types/node/sqlite.d.ts:42` 声明该类型。
   - 建议：改注释为「评审允许的等价窄化，保持 node:sqlite 未文档化导出面的解耦」（或直接用 `SQLInputValue[]`）；claim 措辞同步。
8. **low / `src/harness/zcode/adapter.ts:331-338`（存量） / standards / 手写状态词表与 `contract.ts:109 isThreadNativeStatus` 重复（语义已核对相同），未来加词表时两 adapter 降级行为将分叉**
   - 证据：读码对比（集合一致：表外→unknown）；OCR low 独立命中。
   - 建议：改用 `isThreadNativeStatus(record.nativeStatus) ? record.nativeStatus : "unknown"`。
9. **low / `src/harness/zcode/adapter.ts:2`（存量） / standards / 头注释源路径 `~/.zcode/cli/db/db/db.sqlite` 与真实默认值 `~/.zcode/cli/db/db.sqlite`（:37）不一致（错误注释）**
   - 证据：读码对比 `:2`、`:37`、`:133` readPaths、issue 探针记录。
   - 建议：修正注释路径（AGENTS.md：过时/错误注释按 bug 处理）。
10. **low / `src/daemon.ts:236-241`（合并基线） / maintainability / scan 端点仍按 `codex === null` 分支而非 registry 内容：zcode 装配进 registry 但 codexHome 为 null 时 scan/scanNow 会静默消失——与本 issue 已知装配缺口叠加**
    - 证据：`git diff 477bcc5 e8336e6 -- src/daemon.ts` 该 hunk；OCR low；读码复核。
    - 建议：改按 registry 是否非空门控（codex 车道，装配切片时处理）。
11. **low / `scripts/ui-smoke.ts:13`、`src/harness/registry.ts:62-63`、`src/store/thread-store.ts:304-305`、`src/store/thread-store.ts:610-618`（合并基线，OCR 4 项 low） / maintainability / 分别为：`"codex"` 字面量绕过 ids 单源、registry phase 聚合 done+idle→done 高估完成、`harness_id` 冲突时仅首插静默丢弃传入身份、`latestReaderSourceByThread` 泄露 `""` 幻影键**
    - 证据：OCR low 原文（/tmp/ocr_issue44.txt）+ 本 auditor 对应代码段读码复核（均与 OCR 引文一致）。
    - 建议：按 OCR 建议逐项处理前先自行验证（review-standards「审查工具建议不照抄」）；归 codex/store 车道。
12. **low / `src/harness/zcode/adapter.ts:167` / spec-note（OCR low，judgement） / 单飞注释「没有扫到一半新增文件要补扫」对「pass 在飞期间源库被并发写」不成立：`scan.refresh` 在飞期间到达返回旧摘要且 `scanIntervalMs:0` 下无补扫**
    - 证据：读码 :167-185（无 reader 的 `queued` 补扫）；OCR low。域内可接受（整库下轮幂等追上），属注释措辞/有界陈旧性问题。
    - 建议：补扫排队（对齐 reader）或改注释明示周期扫描下的有界陈旧性。
13. **low / `src/harness/zcode/adapter.ts:214,226,239` / standards(smell) / 相同零摘要字面量三连（Duplicated Code，judgement call）**
    - 证据：读码三处逐字相同。
    - 建议：提取 `const EMPTY_SUMMARY`。

## 八、Uncovered risks（本次审计未覆盖）

1. **真实库（876MB WAL、939 会话）探针记录未复跑**：issue 内探针脚本未入库，本审计只在 fixture 库上执行全部测试与失败复现；真实值域分布、字节不变、性能数字（首轮 <1s、77ms 跳过）为实现者记录，未独立重现（避免审计期触碰活跃生产库；只读打开亦可能撞 WAL checkpoint 竞态）。
2. **`pnpm test:ui` 29 项全绿但不含 ZCode 场景**：ui-smoke fixture 仅 codex 卡片；「ZCode 会话同屏显示」在页面层仍由 registry 合并测试 + 探针证据代偿（issue 自述的代偿安排），daemon 装配合并后仍需目视终验。
3. **OCR 覆盖度折扣**：3 条内部工具错误（code_search/file_read），个别行号定位可能失准；且合并基线 32 文件中仅 18 进入 OCR 评审，codex 车道文件可能有遗漏发现。
4. **网络窗口**：审计中段 GitHub 连接一度 `Connection reset by peer`（ls-remote/gh 失败一次）；push/评论状态以恢复后复核结果为准（两次成功查询一致），不排除查询间隙的极短窗口变化。
5. **post-stop 写入路径的实际可利用性**：F3/F5 依赖 embedder/测试在 stop 后调用 scanNow/start；daemon 正常关停顺序（先 `http.shutdown()` 再 `harnesses.stop()`）下 HTTP 路径不可达，未做运行时注入验证。
6. **`held` 状态、fork lineage 跨库清理、归档库 sessions.db / tasks-index.sqlite**：维持 issue 自述的未验证状态，本审计未新增覆盖。

## 九、verdict_inputs：**not-green**

- **依据**：(1) 返工评审明列的交付步骤（push + issue 完整 SHA 评论，A14/F2）未完成——目标提交目前仅存于本地，证据链不可达，MEA「commit 与 issue 是持久证据」的门不成立；(2) issue 验收「未知 schema/字段降级可展示」在可复现的真实失败面上部分失败（F1，high）。两者任一即不可绿。
- **绿的部分（如实记录）**：A2/A3/A4/A5/A6/A7/A9/A10/A11/A12/A13 全部 PASS 且与实现声明数字逐字一致；Standards 轴 in-diff 零硬违规；领域审查只读边界与私有 schema 泄漏两项 PASS。
- **claim_integrity = suspect**（详见第五节：数字全真、一条理由为假、一处措辞过宽）。
- **回环建议**：修复 F1（pass 级失败落 `scanFailure` + 红测）与 F3（stopped 守卫）；push 并在 issue 评论 base/target 完整 SHA；F7 注释更正。上述完成后可复审放行 `mea:audit-passed`。
