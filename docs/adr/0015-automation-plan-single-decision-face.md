# ADR-0015：自治执行决策面——plan 纯函数与门快照单点

日期：2026-10-23｜状态：已接受

## Context

V2 合流后，Jev 自动执行路径（`executeAutoProposal`）把五件事混在一条编排里：门状态读取（settings、live 配额、证据门资格三处各自捞）、决策调用（`decideAutoExecution`）、执行授权口径构造（authorizedBy/requestId/confidence）、needs_attention 标注与分派执行。评估收口先生成半份 autoPlan、执行时再二次决策，同一决定分裂两处。2026-10-22 一天内三个 fix（7311ad7、26e224e、a5e3df）全部打在这个接缝上；晨析条目 1（高）/条目 3（中）与复查均确认未解。

判定函数本身已是纯函数（进 live 门 `evaluateShadowGateVerdict`、live 动作门 `decideAutoExecution`），散的是状态快照的组装与调用点：store 落 shadow 数据、jev 执行路径自己读、actions 的 `automation.live.enter` 又一套。

## Decision

- **决策与执行分离**：automation.ts 提供 `planAutoExecution(gateSnapshot, proposal)` 纯函数，一次成型输出 **执行计划**（判别联合）：放行形态含 action、authorizedBy、requestId、confidence、risk；拒绝形态含 reason。执行面（jev）瘦成"取计划 → 分派"，不再自组状态、不再就地拼授权口径。
- **门快照单点**：`automationGateSnapshot(store, taskId)` 薄读取层组装判定所需全部状态（门模式、全局 pause、live 配额、证据门资格）。**执行起跑时读取**——评估落提案到执行之间的窗口里人工 halted/pause 仍能生效。
- **两层门判定函数保留不合并**：进 live 门与 live 动作门语义不同（前者是一次性准入判定，后者是每动作放行判定），各自维持纯函数。
- **`automation.plan` 动作行**：放行与拒绝都落审计（trigger=auto，detail 含 execute 真假与 reason）——"每次自动执行为何放行/拦下"有单点流水，与词汇表「动作执行」的审计语义一致。
- **needs_attention 标注移到评估收口**：它是评估结论的展示面（A16 徽标），不是执行步骤。
- **计划落点在 automation.ts**：与 `decideAutoExecution`/`evaluateShadowGateVerdict` 同居，automation 成为完整的"自治执行决策面"，jev 回归纯评估+执行。

## Consequences

- 授权裁决表可直钉测试（纯函数入参出参），26e224e 一类的 fix 不再需要进执行路径找口径。
- deny 留痕带来动作行噪声增量，接受（只在自动路径落，人工路径不受影响）。
- 契约快照只增：新增 `automation.plan` 动作类型与 detail 字段，不删旧。
- store 拆分（晨析条目 2：聚类 3+1 文件、TransactionHost 保 write() 深缝、Store 门面转发、渐进四步搬迁）在 1+3 合并后另立 lane 实施，届时另立 ADR；本 ADR 的决策面模块将来住在自治族拆分文件中。

## 执行面 ProposalExecutor 落位（2026-10-24 追补，issue #34）

决策面与执行分离落地后，执行侧三类职责仍同居于 JevService（1113 行）。按词汇表「提案执行面」口径收位：

- **执行三兄弟归宿 `ProposalExecutor`（src/jev-executor.ts）**：人工 accept（proposal.accept）、continue_thread（唯一出站写路径：单飞 + 按需 resume + 固定模板 + 全程审计）、本地三动作（mark_done/annotate/no_op）成一个类，共享依赖构造注入（store 写面 beginActionExecution/finishActionExecution/decideProposal、driver、singleFlight）。人工授权（authorizedBy="user"）与自动放行（trigger="auto"，口径来自执行计划）走同一执行面，仅授权来源与审计不同。
- **JevService 只留评估编排**：ephemeral 评估、提案落表、评估状态收口、needs_attention 标注，以及 `executeAutoProposal` 的分派（取计划 → 分派，服务级 closed 守卫留在转发处）。纯函数区另下沉 jev-answer（答案契约/prompt/模板）与 jev-gate（证据门判定），re-export 保持 import 路径零变化。
- **与门快照/执行计划的分工**：门快照（本 ADR 单点薄读取层）在执行起跑时晚读 store 当下门状态；`planAutoExecution` 把快照与提案结论一次成型为执行计划；执行面只消费计划分派，不二次决策、不重读门状态、不就地拼授权口径。评估收口生成自动执行待办时只带评估结论，不含任何门判定。
- **决策面单源收尾**：可执行动作枚举 `EXECUTABLE_PROPOSAL_ACTIONS` 落 types.ts（`as const` + typeof 派生，同 SETTINGS_KEY_MAP/AUTOMATION_GATE_MODES 先例），执行面守卫与 `AutoExecutionDecision`/执行计划的 action 联合同源派生——新增可执行动作只改一处，删项即编译错；types.ts 无依赖，automation 反向引用不成环。
