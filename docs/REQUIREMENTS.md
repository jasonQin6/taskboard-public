# Taskboard V2 产品与工程规格

> 状态：V2 唯一需求真相源。2026-10-21 由 `spec2.md` 转正，替代 `docs/archive/REQUIREMENTS-v1.md`。
> 本文只管 What / Why 与可验证的验收；实现自由交给 agent。票据由 `to-tickets` 从本文档派生并发布到 GitHub Issues（`jasonQin6/taskboard`，private）。用户故事 1–95 的编号与验收场景 A1–A33 是票据锚点。
> 字段级稳定契约的可执行真相源是 `test/tool-contract.test.ts` 快照；运行时真相源是 `taskboard help`。
> 已探明的外部事实（app-server 协议、写锁、sample 前置、0.163.0 现状）在 `docs/research/2026-10-21-codex-app-server-runtime-facts.md`，本文只引用结论。
> 架构硬决策与依据见 docs/adr/；本文不含实现决策。

## Problem Statement

当多个编码 Agent 并行工作时，任务进度分散在大量 Codex thread、终端和桌面窗口中。用户需要逐个打开对话才能判断哪个任务在推进、哪个已经阻塞、哪个等待输入，注意力成本远高于实际做决策的成本。

现有 taskboard 已经能创建任务、定时执行、读取终态并展示看板，但架构边界逐渐模糊：它自行实现 goal 判定、workflow 路由、多执行器协议、自改进运行器和 JSON 账本，开始重复 harness 已提供的能力；同时它又缺少真正观察 Codex 原生 thread 历史、低成本总结和自动选择下一步的能力。

用户希望保留 DSH task-board 的人类看板体验，但产品必须是一个独立进程，而不是 DSH 插件。DSH 只提供界面和交互参考，不作为运行依赖。

用户还需要同时满足两个约束：

- Codex 已有的 goal、recap、compaction、workflow、approval 等能力必须优先尊重，不重复实现。
- CodexHost 是当前多 harness 调度的重要基础，但不是运行时依赖，也不是领域层协议。它已具备的进程管理、会话发现与能力探测可以作为 driver 的实现细节复用；协议客户端与写路径由 taskboard 自己掌握，不允许形成第二条并行写路径。

## Solution

构建独立的 Taskboard V2 daemon。它使用 SQLite 保存任务、运行、线程关联、摘要、下一步提案和执行审计；使用 Codex JSONL 作为会话观察的事实源；使用 taskboard 自有的 Codex app-server driver 执行线程创建、发消息、取消、等待、native goal 和 sample。CodexHost 不进入 V2 主链；未来接入其他 harness 时，Harness Driver 接口就是接入面，等第二个 harness 真正出现再抽共享层。

产品主面是五列看板（backlog / todo / running / done / failed）与独立的 Inbox。Task 表示要做的工作，Run 表示 taskboard 发起的一次写调用，Thread 表示 harness 中真实存在的会话。Inbox 收纳本机扫描到但尚未绑定任务的 codex thread，可忽略，默认只显示最近 30 天有活动者。人可以从 Inbox 将 thread 绑定到任务，也可以从看板直接创建、运行、取消、归档、删除和验收任务。

系统持续增量读取本机 Codex rollout JSONL，提取 turn、可见消息、reasoning summary、工具状态、文件变更路径、token 使用和 harness 自写的压缩摘要等最小证据。数据库只保存看板和分析所需的派生数据与脱敏短摘录，不复制完整 transcript。

摘要的执行者永远是 harness 本身，taskboard 不引入任何替代摘要模型。第一层摘要是 reader 直接提取 rollout 内 harness 自写的压缩摘要（compacted 记录），零模型成本、零锁；第二层是原生 `thread/sample`（experimental，按能力探测可用）：仅对已绑定 Task 且当前无其他进程持有的线程试探性加载后采样，加载冲突即回落第一层。Inbox 未绑定线程永不 resume。

当线程完成一个 turn 后，不立即自动推进。若任务未完成且线程达到可配置空闲阈值，默认十分钟，则进入一次事件驱动评估。Jev 从受限候选动作中选择下一步并给出风险；低风险动作可在用户启用的任务上自动执行，其他动作只形成提案等待人工确认。

V2 第一版只支持 Codex。它不实现 workflow catalog 或 workflow runner，因为当前 Codex 没有稳定、可执行、带 run identity 的通用 workflow API。未来接入确有 workflow 能力的 harness 时再增加 registry。

自改进不再是常驻的每日循环或专用 runner，而是看板中的一个普通 issue。任务可以使用通用隔离 worktree 模式；taskboard 负责准备隔离目录，Codex 在其中工作，checks、commit 和审查要求由 issue 内容与验收标准承载。

## 核心对象与状态

- Task 是工作单元，状态固定为 backlog、todo、running、done、failed。archived 与状态正交。列由显式人工动作、Run 生命周期和 thread 原生观察共同决定，优先级为：人工动作 > Run 终态 > thread 观察。
- Run 是 taskboard 经 Harness Driver 发起的一次写调用（创建线程或发送消息），从写调用开始到该次 turn 到达终态为止。状态固定为 queued、running、completed、failed、cancelled；trigger 为 manual、cron、cascade 或 auto。goal 的后续续跑属于 Codex 内部行为，不延长 Run。
- Run 之外的写操作（goal set/pause/clear、sample、取消、提案确认）记为 Action Execution，不产生 Run。
- Thread 是 harness 中真实存在的会话。第一版只支持 Codex thread。
- Inbox 是未绑定 Task 的 Thread 集合，不是第六列。
- Thread 的原生状态与语义状态分开。原生状态包括 running、idle、completed、failed、interrupted、held（写锁被其他进程持有）、unknown；语义状态由评估层产生，例如 progressing、waiting_user、blocked、complete、needs_attention、unknown。
- Summary、Recap、Next Action 和 Action Execution 是不同产物，必须分别记录 provenance。
- Human message、Agent message、Reasoning summary、Tool 状态、File change、Turn error 和 Annotation 都是 Evidence，不把 Evidence 当 Task 或 Run。

### Run 终态与看板列映射

| 事件 | Task 列 | 附加规则 |
|---|---|---|
| 人工移动 / 删除 | 目标列 / 移除 | 人工动作优先，直到下一次 Run 终态或 thread 观察事件 |
| Run queued 或 running | running | |
| Run completed，acceptance=human 未验收 | todo | |
| Run completed，人工验收通过 | done | |
| Run completed，acceptance=agent 且确定性证据门通过 | done | 见“验收与 mark_done 证据门” |
| Run failed（driver 错误、turn failed、硬执行失败） | failed | 保留 thread 锚点供续跑 |
| Run cancelled | todo | thread 仍 running 时只亮“外部活动中”徽标，不改列 |
| 无活跃 Run，主绑定 thread 原生 running，且最近 Run 为 completed/failed 或不存在 Run | running | 观察驱动；cancelled 之后不触发此分支 |
| 主绑定 thread interrupted | todo | 亮 interrupted 徽标并触发一次 Jev 评估 |
| 主绑定 thread failed | failed | 视为硬失败 |
| 语义 waiting_user / blocked | 不改列 | 只作卡片徽标 |

- 一个 Task 同时最多一个活跃 Run；全局有可配置并发上限，默认 2，超限 queued。
- cancelled 的优先级高于 thread 观察：取消表示“taskboard 不再管这条 Run”，thread 仍在跑只作证据，不把任务重新拉回 running。
- interrupted 不算 Run 硬失败；hard failure 仅指 Run failed、driver 错误或明确验收失败。

## Task 最小模型

Task 持久化以下字段：

- 稳定 ID、标题、描述或 prompt。
- 绝对 workspace。
- backlog、todo、running、done、failed 状态。
- archived。
- 标签（≤8，服务端归一化）。
- 来源：manual、scan、self_improvement、external_issue（后者第一版无写入路径）。
- 验收标准。
- acceptance 模式：human、agent，默认 human。
- automation 模式：off、suggest、auto。
- workspace 模式：current、isolated_worktree。
- 可选 parent_id。
- 可选空闲阈值（毫秒）；缺省取全局 settings。
- 可选 cron 调度（5 段表达式与时区）。
- 可选 native goal 配置。
- 创建时间与更新时间。

第一版不加入负责人、优先级、截止日期、估算、依赖图、评论线程、多人协作或双向 issue 状态同步。Annotation 只作为轻量审计证据存在。

## Task 与 Thread 关系

- 一个 Task 可关联多个 Thread。
- 一个 Thread 最多一个 primary Task（数据库部分唯一索引强制）。
- 未绑定 Thread 进入 Inbox。
- 允许附加 derived-from、evidence-for 等从属关系，但不得据此让多个 Task 共同控制同一 Thread 的自动化。
- Thread 不属于五个状态列；它在任务详情、Inbox 和独立观察区中展示。
- Thread 身份以 `session_meta.id` 为准。一个 thread 可以有多个 source unit（resume 或文件移动）；fork 产生新的 session id，作为独立 thread，只通过 lineage 证据关联；rollback 是同一 source unit 的重写，不产生新 thread。
- source unit 以 inode 为主键（path 只是属性），并保存 prefix hash、session id、parser version；文件在 `sessions/` 与 `archived_sessions/` 之间移动不得导致幂等失效。

## V1 功能处置

V2 是重写而非兼容升级。下表逐条给出 V1 R1–R29 的去向；标注“保留”的条目必须在本文档有需求正文与验收场景，不能只引用归档文档。

| V1 | 处置 | V2 落点 |
|---|---|---|
| R1 任务生命周期 | 保留并补充删除 | 五列、归档正交、显式删除；见“核心对象”“保留的 V1 语义” |
| R2 标签与执行提示 | 标签保留，labelHint 删除 | 标签仍 ≤8 归一化；V2 的 Task prompt 就是执行指令，不再做前缀注入 |
| R3 看板 Web UI | 保留，React 重写 | 见“UI 与交互” |
| R4 跳转链接 | 删除 | V1 的 ZCode deeplink 随 zcode executor 删除；Codex thread 深链作为后续可选需求 |
| R5 单次执行 | 保留为 Run | 见“核心对象” |
| R6 会话复用 | 保留为显式续跑与 continue_thread | 外部进程持有写锁时拒绝并提示，不并行 |
| R7 目标驱动多轮 | 改为 Codex native goal | 删除 taskboard goal judge 与轮次预算 runner |
| R8 只等终态 | 保留，语义改为“静止” | 见“保留的 V1 语义 / wait” |
| R9 模型质检门 | 删除 | 不引入打分模型；`acceptance=agent` 用确定性证据门替代 |
| R10 人工确认门 | 改造并入提案确认 | 不再有执行前确认席；cron 不做二次确认 |
| R11 定时调度 | 保留并补正文 | 见“保留的 V1 语义 / cron” |
| R12 重启对账 | 保留 | 重启对账行为见 ADR-0002；验收 A24 |
| R13 单实例锁 | 保留 | daemon 单实例锁语义见 ADR-0023（取代 ADR-0002）；验收 A25 |
| R14 账本迁移与损坏隔离 | 改造为 SQLite 策略 | `quick_check` 失败隔离拒启；迁移全程事务；绝不空库重建 |
| R15 防休眠 | 保留并补正文 | 见“保留的 V1 语义 / 防休眠” |
| R16 粘贴成草稿 | 删除 | V2 不提供模型草稿入口 |
| R17 冻结块续接 | 删除 | V2 不提供冻结块导入 |
| R18 外部 issue 导入 | 延后 | 不在 V2 第一版；`source=external_issue` 值保留但不产生写入路径 |
| R19 子任务与级联 | 保留并补正文 | 见“保留的 V1 语义 / 子任务与级联” |
| R20 多智能体协作 | 删除 | V2 不做 team 会合段 |
| R21–R23 workflow 目录/路由/绑定 | 删除 | 见 ADR-0009 |
| R24 CLI 与输出契约 | 保留并重建 | V2 契约从零重建，不承诺兼容 V1 字段 |
| R25 能力播报 | 保留并更新 | `.agents/skills/taskboard/SKILL.md` 随 V2 CLI 更新 |
| R26 全局约束 | 保留并扩展 | 终局判定、单一写者、回环绑定、CSRF 与可选代理栅栏 |
| R27 明确不做 | 保留 | 见“Out of Scope” |
| R28 按任务选择 Codex | 被 V2 driver 取代 | V2 只有 Codex，不再有执行器二选一 |
| R29 每日自改进闭环 | 删除专用 runner | 自改进是普通 issue + `isolated_worktree` |

## User Stories

1. As a 用户，I want 在一个独立 daemon 中运行 taskboard，so that 我不需要安装或依赖 DSH 插件运行时。
2. As a 用户，I want 看板继续提供五列视图（backlog、todo、running、done、failed），so that 我能快速看清任务阶段。
3. As a 用户，I want archived 状态与五列正交，so that 归档任务不会占用第六列或干扰调度。
4. As a 用户，I want 看板支持 workspace 分区，so that 不同项目的任务不会混在一起。
5. As a 用户，I want 卡片展示最近活动、绑定线程、摘要状态和待处理动作，so that 我不必打开原会话就能判断是否需要介入。
6. As a 用户，I want 在卡片详情中查看 turn 时间线、摘要、证据和动作审计，so that 我能追溯系统为什么给出建议。
7. As a 用户，I want 搜索标题、标签、摘要和线程标题，so that 我能快速定位某个任务或会话。
8. As a 用户，I want 手动拖动或修改任务状态、删除误建任务，so that 我能纠正自动判断和清理错误数据。
9. As a 用户，I want task 默认只经人工验收进入 done，仅在任务显式授权 acceptance=agent 且满足确定性证据门后才允许 mark_done 提案自动执行，so that 完成判定不被 agent 自述劫持。
10. As a 用户，I want failed 只在硬执行失败或明确验收失败时出现，so that 临时空闲或等待输入不会被误判为失败。
11. As a 用户，I want Inbox 自动出现本机新发现的 Codex thread，so that 新开的对话不会因为忘记登记而脱离视野。
12. As a 用户，I want 从 Inbox 把 thread 绑定到一个任务，so that 会话历史成为任务证据而不是另一个任务。
13. As a 用户，I want 忽略 Inbox 中不关心的线程并可随时恢复，so that 无关会话不堆积在看板入口。
14. As a 用户，I want Inbox 默认只显示最近 30 天有活动且未忽略的线程，so that 历史会话仍可搜索但不淹没入口。
15. As a 用户，I want 一个任务可关联多个 thread，so that 重试、fork 和不同尝试可以共同服务于同一工作项。
16. As a 用户，I want 一个 thread 最多只有一个主绑定任务，so that 不会出现两个任务争抢同一会话状态。
17. As a 用户，I want 子任务或其他派生关系作为附加证据链存在，so that 新任务可以引用来源 thread 而不篡改主绑定。
18. As a 用户，I want 扫描本机全部 Codex thread，而不只扫描 taskboard 创建的线程，so that 我在其他入口启动的工作也能被跟进。
19. As a 用户，I want 扫描路径只读执行，且只有已绑定 Task 的线程允许显式 resume/sample 这一写邻接例外，so that taskboard 不会在未授权时修改 Codex 自身存储。
20. As a 用户，I want thread 发现支持 sessions 与 archived_sessions，so that 历史或归档对话仍可检索。
21. As a 用户，I want reader 正确处理 fork、rollback、subagent 和 history lineage，so that 会话边界不会被错误合并。
22. As a 用户，I want reader 只处理完整换行记录，so that 正在写入的半截 JSON 不会造成错误状态。
23. As a 用户，I want reader 使用 byte offset、prefix hash、inode、mtime 和 parser version 检测追加、截断与重写，so that 增量扫描不会漏读或重复读取。
24. As a 用户，I want 压缩后的 rollout 文件也能读取，so that 旧会话仍可见。
25. As a 用户，I want JSONL 是 Codex 历史的权威来源，SQLite 只做加速索引，so that 即使 Codex UI 投影数据库重建也不会丢失事实。
26. As a 用户，I want 原生 turn 事件决定 running、completed、failed 和 interrupted，so that 硬状态不依赖模型判断。
27. As a 用户，I want Jev 只判断语义状态和下一步，so that 概率模型不会越过状态机直接改账。
28. As a 用户，I want 未知 Codex item 类型降级为 opaque 证据，so that Codex 升级不会让整条线程卡死。
29. As a 用户，I want 坏行记录 anomaly 后继续读取后续记录，so that 一行损坏不会永久阻塞扫描。
30. As a 用户，I want 数据库保存 source locator 和记录 hash，so that 每条摘要和证据都能回到原始 rollout 核对。
31. As a 用户，I want 数据库只保存脱敏短摘录，so that 看板不成为完整私密 transcript 的副本。
32. As a 用户，I want reasoning 只展示 summary 或是否存在，so that 产品不会假装拥有完整 chain of thought。
33. As a 用户，I want tool trace 只保存工具名、状态、退出码、耗时和文件路径摘要，so that 我可以判断发生了什么而不用复制 stdout/stderr。
34. As a 用户，I want system/developer 指令、encrypted reasoning 和完整工具输出默认不入库，so that 私密材料不长期扩散。
35. As a 用户，I want 每个 thread 有多轮结构化摘要，so that 长会话不会只有一段会过期的总述。
36. As a 用户，I want summary 明确标注来源是 compacted 提取、native sample 还是缺失，so that 我不会混淆不同可信度的产物。
37. As a 用户，I want 已绑定 Task 且可在 taskboard 自己的 app-server 实例中加载的线程优先使用 Codex 原生 sample，so that 摘要复用 harness 自己的上下文能力。
38. As a 用户，I want 未绑定 Task 的线程永远不为了摘要而 resume，so that 外部会话不会被 taskboard 写路径触碰。
39. As a 用户，I want sample 能力缺失或线程被其他进程持有时，摘要回落到 rollout 内 harness 自写的 compacted 摘要，so that 不引入替代模型也能低成本跟进。
40. As a 用户，I want 摘要的执行者永远是 harness 本身，so that taskboard 不维护任何摘要模型与摘要运行时。
41. As a 用户，I want 一次评估返回 summary、progress、evidence 和候选动作，so that 摘要与下一步共享同一份上下文。
42. As a 用户，I want 候选动作限制在固定枚举中，so that 模型不能发明任意 shell 或任意状态变更。
43. As a 用户，I want 候选动作包含 continue_thread、retry_run、create_child_task、annotate、ask_user、mark_blocked、mark_done 和 no_op，so that 常见工作流都有明确出口。
44. As a 用户，I want Jev 一次请求同时回答多个问题，so that 注意力、进度、动作和风险可以在一次低成本调用中完成。
45. As a 用户，I want 线程空闲达到阈值且任务未完成时触发评估，so that 我不需要持续盯住每个对话框。
46. As a 用户，I want 空闲阈值可按任务覆盖，so that 不同项目和任务可以使用不同节奏。
47. As a 用户，I want 没有新证据时不重复调用模型（涵盖 sample 与 Jev），so that “不设置生命周期次数上限”不会退化为无意义的定时烧钱。
48. As a 用户，I want 新 turn、刚执行动作或手动刷新可以触发重新评估，so that 有意义的进展能及时被处理。
49. As a 用户，I want taskboard 创建并绑定主线程的任务默认 automation=auto，其他来源默认 suggest，off 由用户显式设置，so that 我的主要工作流无需逐次确认而未知来源仍安全。
50. As a 用户，I want 从外部扫描进入 Inbox 的线程默认只给建议，so that 未知来源的会话不会被自动发消息。
51. As a 用户，I want 每个任务支持 automation off、suggest 和 auto，so that 我可以按任务控制自治程度。
52. As a 用户，I want 全局暂停开关并持久化，so that 我可以立即停止所有自动评估和动作，且重启后不会意外复活。
53. As a 用户，I want 第一版自动执行默认只允许低风险 continue_thread 和 annotate，so that 自治能力先在最可逆的动作上验证。
54. As a 用户，I want retry、create task、ask user、mark blocked 等动作默认需要确认，so that 系统不会自行扩大工作范围或掩盖失败。
55. As a 用户，I want 自驱任务遇到需要审批的动作时停下并转为待关注，so that 审批由我在 Desktop/TUI 完成而不是 daemon 代答。
56. As a 用户，I want mark_done 默认只能人工确认，仅在任务显式设置 acceptance=agent 且满足确定性证据门时自动执行，so that 完成仍由验收证据或授权的人决定。
57. As a 用户，I want 每个提案记录候选、Jev 选择、置信度、风险、依据和执行结果，so that 自动推进可以完整审计。
58. As a 用户，I want CodexHost 作为可选 driver 实现细节保留其进程管理能力，so that 未来接入其他 harness 时不必重写全部外围。
59. As a 用户，I want 协议客户端与写路径由 taskboard 自己掌握，so that CodexHost 不成为领域层协议或第二条写路径。
60. As a 用户，I want 直连 Codex app-server 的能力通过独立接口封装，so that 以后可以整体替换 driver 而不改领域层。
61. As a 用户，I want 第一版使用 Codex 原生 goal，so that 长时间目标由 Codex 自己管理，而不是 taskboard 重写 goal judge。
62. As a 用户，I want goal 的 enable、set、get、pause、resume、clear 和 status 映射到 Codex 原生 API，so that taskboard 与 Codex 的 goal 状态保持一致。
63. As a 用户，I want goal completion 不自动等于任务 done，so that Codex 的目标完成仍需经过任务验收。
64. As a 用户，I want 原生 goal 不可用时明确报能力错误，so that 系统不会静默退回 taskboard 自造 goal loop。
65. As a 用户，I want 第一版跳过没有稳定 API 的 Codex workflow，so that 产品不会把 skill 或 prompt 约定包装成 deterministic workflow。
66. As a 用户，I want capability registry 只登记实际可调用的 harness、model、thinking 和 permission 能力，so that Jev 不会选择不存在的路线。
67. As a 用户，I want 未来接入 ZCode 或其他 harness 时可以增加 workflow registry，so that 真正的 workflow 能力出现时无需推翻任务模型。
68. As a 用户，I want 自改进以普通 issue 出现在看板，so that 它和其他工作使用同一套任务、证据和验收语义。
69. As a 用户，I want 每日 self-improve 循环默认不存在，so that taskboard 不会自带一个长期自我修改后台。
70. As a 用户，I want 任务可选择 current workspace 或 isolated worktree，so that 需要隔离的改动可以安全执行。
71. As a 用户，I want taskboard 为 isolated worktree 创建 branch 和目录并把 cwd 交给 harness，so that agent 不直接修改主工作区。
72. As a 用户，I want taskboard 不内置 RSI、setup/checks/commit/report 专用流程，so that 自改进要求由 issue 内容和验收标准表达。
73. As a 用户，I want 任务完成后保留 branch、commit、checks 和报告证据，so that 我可以人工审查和合并。
74. As a 用户，I want 第一版任务字段保持最小，so that 产品先解决注意力问题而不是先做完整项目管理套件。
75. As a 用户，I want 任务包含标题、描述、workspace、状态、标签、来源、验收标准、acceptance 模式、automation 模式、workspace 模式、可选 parent、可选空闲阈值、可选 cron 调度和归档位，so that 看板和自动跟进所需信息完整。
76. As a 用户，I want 任务保留可选的 cron 定时调度，so that 周期性工作照旧自动执行。
77. As a 用户，I want 暂不引入负责人、优先级、截止日期、估算、依赖图和多人协作，so that 第一版范围可控。
78. As a 用户，I want taskboard JSON 账本从运行时移除，so that SQLite 成为唯一事实源。
79. As a 用户，I want V2 空库初始化、不做旧 JSON 迁移，so that 不为不存在的生产数据维护迁移与双写路径。
80. As a 用户，I want HTTP API 和 CLI 输出稳定 JSON，so that agent 和其他工具可以可靠驱动 taskboard。
81. As a 用户，I want CLI 覆盖创建、列表、查看、移动、归档、删除、运行、取消、等待、绑定/解绑线程、忽略/恢复线程、刷新扫描、查看摘要、提案确认/拒绝、暂停/恢复自动化和查看数据库路径，so that 我不依赖浏览器完成管理。
82. As a 用户，I want HTTP 仍只绑定 loopback，并具备 CSRF 基线防护，so that 本机信任模型不被任意网页利用。
83. As a 用户，I want 看板采用 DSH task-board 的信息架构和交互语义，so that 界面符合我已习惯的工作方式。
84. As a 用户，I want 前端允许 React/Vite 构建但 daemon 保持零运行时依赖，so that UI 可以复用成熟组件而不污染守护进程。
85. As a 用户，I want 服务重启后自动恢复扫描游标和未完成 run 的对账，so that 不会出现永久卡住或重复证据。
86. As a 用户，I want Reader、Thread、Summary 和 Action 的 provenance 清楚分开，so that 系统不会把“观察”“总结”“建议”和“执行”混成同一种事实。
87. As a 用户，I want 自动推进前先用真实历史做 shadow 对比，so that 我可以先验证 Jev 选择是否优于 no-op。
88. As a 用户，I want shadow 阶段人工标注有帮助、无效和有害，so that 进入 live 自动动作前有明确证据。
89. As a 用户，I want 出现任何有害自动动作时停止扩大自治范围，so that 安全门优先于覆盖率。
90. As a 用户，I want 未来可增加 Claude、Pi 和 ZCode reader，so that 多 Agent 观察能力可以扩展而无需重写任务模型。
91. As a 用户，I want 未来可用 ACP 或自研 driver 替换 Codex driver，so that 当前技术选择不会变成永久耦合。
92. As a 用户，I want 保留 cron、wait、子任务级联、防休眠与可选代理栅栏，so that V1 用真实 bug 换来的语义不会在重写中丢失。
93. As a 用户，I want 保留单实例锁与重启对账，so that 双启和崩溃不会损坏数据库或留下永久卡住的状态。
94. As a 用户，I want 数据库有明确保留策略，so that 证据与运行历史不会无限增长。
95. As a 用户，I want 任务可以显式删除，so that 误建任务不会永久占用看板。

## Codex Reader

Reader 的主输入是本机 `CODEX_HOME` 下的 `sessions` 与 `archived_sessions` rollout JSONL。

- 支持普通 `.jsonl` 和 `.jsonl.zst`。
- turn boundary 以 `event_msg` 记录内的变体为准：`task_started` → running，`task_complete` → completed，`turn_aborted` → interrupted，error 事件 → failed。顶层记录类型和 item 完成事件永不作 turn 终态。
- 用户输入优先读取 Codex 的可见 user message 事件；模型上下文中的 developer/system message 不进入看板。
- agent 文本读取可见 agent message 事件。
- reasoning 只保存 summary 或 presence，不保存 encrypted content。
- tool 证据只保存工具名、类型、状态、退出码、耗时和路径摘要。
- file change 只保存路径、变更类型和统计摘要，不保存 patch 全文。
- compacted 记录的 `payload.message` 是 harness 自写摘要，reader 提取最近一次 compaction 的文本作为第一层摘要来源；replacement history 等内部结构不入库，按记录 hash 幂等提取。
- 未知 item 保存为 opaque 元数据，不作为 turn 终态。
- subagent 的 turn/item 必须按 subagent history start ordinal 隔离归属，不并入主 thread turn 序列，避免 goal 轮数与 sample 的 expected_turn_id 校验错位。
- 处理 fork、rollback、history base 和多 rollout lineage；fork 是独立 thread，rollback 是同一 source 重写。
- thread 的“最近活动”取最后一条事件的 timestamp，不使用文件 mtime。

## 增量与恢复

每个 source unit 保存：

- source_id（由 inode + prefix hash + session id 稳定派生）。
- source path（属性，不是键）。
- thread ID。
- inode、size、mtime。
- consumed bytes。
- prefix hash 与 tail hash。
- next ordinal，若存在。
- parser version。

读取时先冻结当轮可见 EOF，只提交完整换行记录。未结束尾行留到下一轮。

当检测到文件截断、inode 替换、前缀 hash 变化或无增长重写时：

- 将该 source 标记为 rewritten。
- 按稳定键幂等 upsert，并把被取代的派生证据标记为 superseded，不先删后建。
- 从头重扫并重建；崩溃后重跑同一操作必须收敛到相同结果。

扫描默认在 daemon 启动时异步做一次全量对账，daemon 就绪不等待扫描完成；之后每 30 秒增量扫描，并支持手动立即刷新。第一版不使用文件系统 watcher 作为正确性依赖。压缩文件仅在 size 或 mtime 变化时重新解压读取。

损坏行、未知类型和 ordinal 缺口写入 `reader_anomalies`，同时推进字节游标，防止单条异常永久阻塞后续内容。

## 证据持久化边界

数据库只保存看板、摘要和审计所需的最小数据：

- Thread、Turn 和 Item 的稳定 ID、类型、状态和时间。
- model、effort、cwd 的本地映射。
- token usage。
- source path、byte start、记录 hash。
- 脱敏后的短 message 摘要。
- reasoning summary。
- tool 名、状态、退出码和耗时。
- file path 与变更类型。
- 异常类型和可读错误。

不保存完整 user/agent transcript、完整 reasoning、developer/system 指令、工具完整参数、stdout/stderr、MCP 结果、patch 全文、compaction replacement history 或世界状态。compacted 摘要入库前同样做长度截断与脱敏；出站标准 = 入库标准。

## Summary 与 Next Action

摘要的执行者永远是 harness 本身（第一阶段为 Codex）；taskboard 不引入任何替代摘要模型。摘要分两层：

1. **compacted 基线**：reader 从 rollout 的 compacted 记录提取 harness 自写的摘要文本（`payload.message`），零模型成本、零锁，覆盖所有发生过 compaction 的线程。
2. **sample 增强**：原生 `thread/sample`（experimental），经 capability registry 探测可用才启用，并标记 `[未实现·外部依赖]`，验收前置为 codex 版本包含该 method。仅对已绑定 Task 的线程执行：试探性 resume（接管唯一写者）→ 校验 latest completed turn 与请求一致 → ephemeral fork 采样（不写原 rollout）→ close 释放锁。resume 遇 `Conflict` 即“线程被其他进程持有”，本轮回落基线层并如实记录。

Inbox 未绑定 Task 的线程永不 resume。Summary 的 provenance 固定为 `compacted | sample | none`。

`thread/resume` 是写邻接操作：接管写锁，可能把 `.jsonl.zst` materialize 为 `.jsonl`。这是“扫描只读”的唯一例外，仅允许发生在已绑定 Task 的显式 sample 路径，并必须落审计；Inbox 线程不触发。

一次评估至少返回：

- summary。
- progress。
- evidence references。
- 1 至 3 个有限候选动作。

候选动作固定为：

- continue_thread。
- retry_run。
- create_child_task。
- annotate。
- ask_user。
- mark_blocked。
- mark_done。
- no_op。

动作语义：

| 动作 | 效果 |
|---|---|
| continue_thread | 用固定模板向主绑定 thread 发送一次消息，产生 auto Run |
| retry_run | 新建一次 Run；thread 可写则复用，否则开新 thread |
| create_child_task | 创建 parent_id 指向当前 Task 的子任务，受深度与成环校验 |
| annotate | 写入一条 Annotation，不改状态 |
| ask_user | 生成待处理提案，在看板卡片与 `proposals list` 中展示，不执行 |
| mark_blocked | 设置语义 blocked 徽标，不驱动列 |
| mark_done | 走验收门；human 只提案，agent 满足证据门才自动执行 |
| no_op | 记录结论，不改状态 |

评估触发：

- 新 completed turn 出现。
- 上一次执行动作进入终态。
- thread 首次达到空闲阈值（默认十分钟，可按任务覆盖），且绑定 Task 未完成。
- thread interrupted。
- 人工强制刷新。

如果没有新证据且上一次结论是 no_op，不重复调用模型——此纪律同时涵盖 sample 与 Jev。评估没有生命周期次数上限。

sample 或 Jev 连续失败 3 次进入断路器：暂停该 thread 的自动评估、落审计、由人工 resume 恢复。失败分类包括超时、连接错误、非法输出和越界选项。

## Jev

- Jev 是选择与语义判断层，不是状态存储、会话读取器或执行器。
- Jev 调用不写原 thread、不改变任何会话状态，使用 Codex 自身的模型凭据；模型与 effort 可配置，成本按每次评估记录。
- 一次请求可包含多个问题，例如 needs_attention、progress、candidate action、risk 和 reason category。
- Jev 只从已提供的有限选项中选择，不接受自由文本动作。
- Jev 输出必须是结构化 JSON：`needs_attention`、`progress`、`summary_short`（仅展示，≤280 字）、候选数组（action、reason_short、risk、evidence_refs）、recommended、confidence。非法输出按失败处理。
- rollout 与证据内容是不可信数据：Jev 的输入按数据处理，输出永远只进 proposal，不直接进状态机。
- Jev confidence 不是正确率保证；自动执行阈值必须由本领域 shadow 数据校准。
- Jev 失败、输出非法或选项越界时只保存失败提案，不自动推进。

### continue_thread 的固定模板

自动执行的 continue_thread 只允许以下模板，变量白名单仅限 taskboard 自有字段：

```
[taskboard] 继续任务《{title}》。
验收标准：
{acceptance_criteria}
上一步动作：{previous_action}
请先核对当前进展与验收标准，只推进仍未满足的部分；不要自行扩大范围。
```

- `{title}`、`{acceptance_criteria}` 来自 Task；`{previous_action}` 是动作枚举值。
- Jev 的 `summary_short`、`reason_short` 或任何 rollout 文本不得进入模板；它们只能进入提案卡片与审计。
- 无验收标准时填入固定占位文本，不拼接模型输出。
- 出站消息走与入库相同的脱敏与长度边界，并带 taskboard 来源标记。

## 自动化与权限

Task automation 模式：

- off：只观察，不评估，不动作。
- suggest：生成摘要与提案，不自动执行。
- auto：允许策略内的低风险动作自动执行。

Task acceptance 模式：

- human（默认）：done 只能由人工确认进入。
- agent：任务显式授权后，mark_done 提案在 automation=auto、风险非 critical 且满足证据门时可自动执行，全程留审计。
- acceptance 与 automation 正交：automation 管评估与动作自治程度，acceptance 管验收权归属。

默认策略：

- taskboard 创建并绑定主线程的 Task 默认 automation=auto。
- 扫描进入 Inbox 的外部 thread 及其绑定任务默认 suggest。
- off 由用户显式设置。
- 全局 pause 持久化在 settings，立即停止新评估和新自动动作；cron 定时执行属于用户显式调度，不受 pause 影响。
- V2 live 第一版自动动作默认只有 continue_thread 和 annotate；acceptance=agent 的任务是唯一例外（mark_done，见证据门）。
- retry_run、create_child_task、ask_user、mark_blocked 默认只生成提案。
- critical 风险一律拒绝。
- 自动消息必须带 taskboard 来源标记，记录 proposal、Jev answer、risk、authorization、request identity 和 execution result。

### 验收与 mark_done 证据门

acceptance=agent 的 mark_done 自动执行必须同时满足：

- 任务显式设置 acceptance=agent。
- automation=auto。
- 验收标准非空。
- 主绑定 thread 的最新 turn 为 completed。
- 该 thread 没有未收敛的 anomaly。
- 提案至少引用一条与验收标准对应的证据（file change、tool 结果或人工标注）。
- 风险非 critical，且通过单飞与幂等校验。

任一条件不满足时只生成提案。V2 不引入 V1 的模型打分质检门。

## Codex 调度与原生能力

领域层定义 Harness Driver 接口，至少覆盖：

- capability inspection。
- create thread。
- send message。
- cancel。
- wait 或 observe。
- native goal。
- native sample 或 recap。
- resume/fork，若未来实现。

- 每次写操作使用稳定 request ID，避免重复创建 thread 或重复发送。
- 错误、busy 或超时不得静默切换为另一条写路径；必须记录明确错误或等待人工重试。

单飞规则：同一 thread 至多一个 in-flight 写操作。send、cancel、goal set/pause/clear、sample、提案执行全部计入。进程内互斥是主规则；app-server 写锁用于探测外部持有，返回 Conflict 时排队或明确拒绝并记录，绝不并行，也不做跨进程队列。

自驱 turn 的审批策略：taskboard 自驱的 turn 一律 `approval_policy=never` 加 sandbox。Codex 遇需审批的动作会停下来并在 turn 终态体现，taskboard 把它归为 waiting_user/needs_attention，不提供任何审批应答面；人工介入出口是用户在 Desktop/TUI 打开该线程。

Native goal：

- Task 可请求 goal 执行模式。
- goal 创建、查询、暂停、恢复、替换和清除映射到 Codex `thread/goal/*`，记为 Action Execution。
- goal 文本来自 Task 的目标与验收描述。
- 只有用户显式启用 goal 或任务由用户明确配置 goal 时，才以用户授权来源设置；Jev 不得自行把普通任务升级为 goal。
- goal token budget 可选。
- goal status complete、budget limited 等只作证据，不直接决定 Task done。
- goal continuation 不延长 Run；goal 运行期间 Task 是否显示 running 由 thread 原生观察规则决定。
- native goal 不可使用时必须报明确能力错误，不回退到 taskboard 自造 goal judge。

## 保留的 V1 语义

### cron

- 支持 5 段 cron，到点触发与手动同一条 Run 创建路径。
- 触发后立刻计算下一次；错过不补跑。
- 有活跃 Run、已归档或缺少 workspace 的任务跳过本次触发，并记录跳过原因。
- 可选 IANA 时区名按该时区墙钟解释，缺省为本机时区；spring-forward 不存在的墙钟时刻在拨快边界补触发，fall-back 重复时刻取严格大于上次触发时刻的最早一次出现。
- 更换 cron 或时区作废 nextRunAt 并重新计算。
- 全局 pause 不停止 cron；它只停止 Jev 评估与自动动作。

### wait

- `taskboard wait <taskId>` 是只读等待，不写数据库、不改状态、不推 revision。
- 判定“静止”：该任务没有活跃 Run、主绑定 thread 不是原生 running、且没有 in-flight 写操作。
- 静止后返回最近一次 Run 的终态摘要与任务当前状态；无活跃 Run 且 thread 空闲时立即返回。
- 该语义同时覆盖 once 与 goal 模式：goal 续跑期间 thread 仍 running，wait 继续阻塞。
- 默认超时 600 秒；超时返回人话提示并以退出码 1 结束。

### 子任务与级联

- Task 可设 parent_id；深度为到根任务的父子跳数，默认上限 1，可配置到 3。
- 创建或改挂时校验父任务存在、未归档、深度不越限、不成环（含间接环）。
- 子任务仍有独立的 prompt、workspace、thread 与 Run 历史，可独立手动或 cron 执行。
- 删除父任务不级联删除子任务；悬空子任务保留并在删除响应中提示。
- 父任务可设 `subtasks_policy=cascade`：父 Run completed 后按创建顺序逐个驱动未归档子任务，每个子任务产生 trigger=cascade 的独立 Run。
- 任一子任务 Run 非 completed 即停：failed → 父 Run 翻转为 failed；cancelled → 父 Run 翻转为 cancelled，父任务回 todo。
- 级联是进程内运行时状态，不跨 daemon 重启恢复。
- create_child_task 动作受同一深度与成环校验；子任务默认 acceptance=human、automation 继承父任务。

### 防休眠

- daemon 配置 `preventIdleSleep` 默认关；开启后，存在活跃 Run 或 taskboard 发起的 native goal 续跑时持有平台级防休眠。
- 排队、待确认提案和纯外部 Desktop 活动不计入窗口。
- 最后一个 Run 终态且没有 taskboard 发起的 goal 续跑时释放。
- 平台不支持或工具缺失时静默降级，并在 state 中暴露 off/idle/active/unavailable；保护态不入库、不推 revision。

### 可选代理栅栏

- `trustedProxyHosts` 非空即开启，默认关；daemon 恒绑 `127.0.0.1`，不因栅栏放开监听地址。
- 写面（POST action）一律要求受信来源 + 正确 `x-taskboard-token`；读面（GET state/events/静态）本机回环无条件放行。
- 只认 socket 远端地址，不解析 `X-Forwarded-For`；令牌值取环境变量，不落库、不打日志，比较使用常量时间。
- 栅栏关闭时，CSRF 基线仍生效（见“安全边界”）。

### 标签与删除

- 每任务最多 8 个标签，超量服务端截断而非拒绝；空项与重复归一化；标签只做展示分组。
- 任务可显式删除；删除不级联删除子任务；删除任务不删除其 thread 与证据，thread 回到 Inbox。

## UI 与交互

- 前端采用 React + Vite 构建，构建产物作为静态资源由 daemon 提供。
- daemon 不引入 React 或 Vite 运行时依赖。
- 主视图包含五列看板、Inbox、archive 折叠区、搜索、紧凑模式和 workspace 分区。
- Inbox 支持忽略/恢复，默认只显示最近 30 天有活动且未忽略的线程。
- Thread 详情展示 turn 时间线、摘要、证据、候选动作、Jev 选择和动作执行链；证据与 turn 分页加载。
- 卡片详情支持提案确认/拒绝、绑定/解绑线程、归档、删除和手动移动。
- 所有动态文本安全转义；Markdown 使用白名单渲染；响应头设置 CSP。
- 视图状态只保存于浏览器本地，不写数据库。

## API 与 CLI

- GET `/api/state` 返回卡片级数据：domains 的 revision、tasks、threads 摘要、inbox、待处理提案、自动化状态；不内联完整证据。
- GET `/api/tasks/:id` 返回任务详情与关联 thread。
- GET `/api/threads/:id` 返回线程详情；`/api/threads/:id/turns` 与 `/api/threads/:id/evidence` 支持 cursor 分页。
- GET `/api/proposals`、`/api/annotations`、`/api/db/path`。
- SSE `/api/events` 广播 `{domain, revision, ids[]}`；客户端按域重拉，不推全量快照。第一版不做事件日志表；断线重连按域重拉，revision 追上即收敛。
- POST `/api/actions` 统一写入入口，所有变更带 request ID 幂等。
- CLI 至少覆盖：start、status、list、get、create、move、archive、unarchive、delete、run、cancel、wait、bind-thread、unbind-thread、ignore-thread、unignore-thread、refresh、inspect-thread、summaries、proposals、accept-proposal、reject-proposal、pause-automation、resume-automation、db path。
- 机器集成只认稳定 JSON 与退出码：0 成功、1 语义失败/超时、2 用法错误、3 服务不可达。成功输出带 `ok` 标记（历史列表除外）；错误走 stderr 且为一行人话，无栈回溯。
- V2 契约从零重建，不承诺兼容 V1 字段；字段集合在 V2 内只增不删，消费方必须容忍未知字段。
- 第一版仍只绑定 127.0.0.1，不提供认证。

## 安全边界

- HTTP 只绑 loopback；无认证，但必须有 CSRF 基线：POST 只接受 `Content-Type: application/json`，校验 `Origin`/`Host` 为回环或显式允许的来源，拒绝跨站请求。
- 读接口不得返回完整 transcript、工具输出、system/developer 指令或 encrypted reasoning。
- 数据库与日志不得出现 token、密钥、完整 prompt 或完整工具输出；compacted 摘要入库前脱敏与截断。
- UI 对不可信 rollout 内容按文本处理；Markdown 白名单；CSP 限制脚本来源。
- 可选代理栅栏是跨机/反代的唯一授权例外，且语义见“保留的 V1 语义”。

## 配置与默认值

持久化在 `settings` 表，支持 CLI 读取与修改：

- 全局 automation 暂停（默认关）。
- 默认空闲阈值（默认 600000 ms，可按任务覆盖）。
- 全局并发上限（默认 2）。
- `preventIdleSleep`（默认关）。
- 保留策略：每任务最多保留 20 条 Run；幂等键环形表保留最近 256 条；未绑定 thread 的派生证据默认保留 90 天，已绑定 thread 保留到任务归档后 90 天，摘要与 anomaly 跟随 thread；阈值可配置。
- Jev 模型与 effort。
- sample 开关（默认关，按能力探测）。
- 代理栅栏配置（默认关）。

## Testing Decisions

测试只验证外部可观察行为。主测试缝、假 app-server 契约与 fixture 矩阵见 docs/adr/0012-testing-seams.md；各票面的验收标准承载具体矩阵。

## 验收场景

- A1 空库启动：删除数据库文件后启动 daemon，自动初始化 schema，五列为空，`db path` 可读。
- A2 新 rollout 在 30 秒内出现在 Inbox；数据库不保存完整 transcript。
- A3 Inbox 默认只显示最近 30 天有活动且未忽略的线程；忽略与恢复立即生效。
- A4 将 thread 绑定到 Task 后，卡片显示最近 turn、摘要和证据入口；一个 thread 不能成为两个 Task 的 primary。
- A5 追加一个完整 turn 后只新增对应证据；追加半行时本轮不产生证据。
- A6 JSONL 被截断或重写后，reader 重建该 source，不重复生成相同证据，旧证据标记 superseded。
- A7 rollout 文件在 `sessions/` 与 `archived_sessions/` 之间移动后，增量游标与证据幂等不失效。
- A8 发生过 compaction 的线程被扫描后，摘要来自最近一次 compacted 记录且 provenance=compacted。
- A9 已绑定 Task 的线程在 taskboard 实例中试探性加载成功后，用假 app-server 的 `thread/sample` 生成摘要并释放写锁。
- A10 Inbox 未绑定线程从不 resume；sample 能力缺失或写锁 Conflict 时，摘要回落 compacted 基线并记录线程 held。
- A11 同一线程的 send 在飞时，goal/sample/第二个 send 被单飞规则排队或拒绝，绝不并行。
- A12 空闲十分钟且无新证据的 no_op 不会重复调用 Jev；出现新 turn 后再次评估。
- A13 sample/Jev 连续失败 3 次后，该线程自动评估暂停并落审计；人工 resume 后恢复。
- A14 Jev 选择 continue_thread 且策略允许时，外发消息只包含固定模板白名单字段；rollout 中的注入文本不出现在消息里。
- A15 Jev 选择 mark_done 时：acceptance=human 只生成提案；acceptance=agent 且证据门通过时自动执行并留完整审计；缺少证据时只提案。
- A16 自驱 turn 遇到需审批动作而停止后，任务语义状态为 needs_attention，系统内不存在任何自动批准路径。
- A17 native goal 通过 app-server driver 设置成功，goal 状态进入任务详情；goal 续跑期间 wait 继续阻塞；app-server 不支持时明确失败。
- A18 isolated worktree 任务使用独立 branch 和 cwd，主工作区分支保持不变。
- A19 Run 被取消后任务回 todo；thread 仍在 Desktop 运行只亮“外部活动中”徽标，不把任务拉回 running。
- A20 interrupted turn 使任务回 todo、亮 interrupted 徽标并触发一次 Jev 评估，不进入 failed。
- A21 cron 到点起单、错过不补、活跃 Run 跳过、IANA 时区与夏令时边界正确。
- A22 wait 在 once 模式下等 Run 终态；在 goal 模式下等 thread 静止；超时给人话并以退出码 1 结束。
- A23 级联成功时父子各有独立 Run；子失败父翻失败；深度越界与成环被拒绝；重启不恢复半截级联。
- A24 构造遗留 running/queued Run 重启：running 变 failed(orphaned) 保留 thread，queued 变 cancelled，任务回 todo。
- A25 双启第二个 daemon 失败并报持有者 pid；杀掉第一个后可接管。
- A26 数据库损坏时隔离为 `.corrupt-<时间戳>` 并拒启，不空库重建。
- A27 跨站网页向 localhost 发简单 POST 被拒绝；合法 JSON 同源请求通过。
- A28 代理栅栏关闭时行为与裸 loopback 一致；开启后写面缺令牌被拒，读面回环放行。
- A29 长单执行期间防休眠持有、结束后释放；平台不支持时状态显示 unavailable 且执行不受影响。
- A30 删除误建任务后看板移除，子任务保留并提示悬空，相关 thread 回到 Inbox。
- A31 SSE 只广播 domain/revision/ids；客户端按域重拉后收敛；断线重连不丢状态。
- A32 保留策略生效：每任务最多 20 条 Run，未绑定 thread 证据按配置过期，已绑定 thread 证据保留到归档后。
- A33 前端在桌面和移动宽度下完成五列、Inbox、详情、搜索、绑定线程、删除和提案确认流程。

### 自治上线门

1. Shadow 阶段收集至少 20 个真实 thread 快照。
2. 对每份快照比较 no_op、Codex 原生建议和 Jev 选择。
3. 人工标注有帮助、无效和有害。
4. 只有在没有有害动作且 Jev 至少优于 no_op 后，进入 5 个 live 任务。
5. live 阶段只允许低风险 continue_thread 和 annotate（acceptance=agent 的 mark_done 例外，见“验收与 mark_done 证据门”）。
6. 出现有害自动动作时立即关闭自动执行并保留审计证据。

## Out of Scope

- 第一版支持 Codex 之外的其他 harness。
- Codex workflow catalog、workflow selection 或 workflow runner。
- taskboard 自造 goal judge、native goal 的本地替代实现或自动完成判断。
- V1 的模型质检门、team 会合段、粘贴草稿、冻结块导入和专用 self-improve runner。
- 外部 issue 导入与双向 issue 状态同步（延后）。
- 重写 compaction、recap、approval、tool execution 或 continuation 机制。
- 替代摘要模型（本地或远端）与自研 recap 生成。
- 为摘要 resume 未绑定 Task 的线程。
- 未授权任务上的自动 mark_done、自动 merge、自动 push 或自动扩大工作范围。
- 常驻每日 self-improve、RSI 候选搜索、benchmark archive 或自动改进改进器。
- 旧 JSON 数据迁移、双写兼容与 migrate-json 工具。
- `db dump` 之类的数据库导出/备份子命令（SQLite 文件本身即可用标准工具拷贝与转储）。
- 复制 DSH Host、Cordis、插件生命周期或认证系统。
- 完整保存 Codex transcript、reasoning 原文、工具输出或 patch 到 taskboard 数据库。
- 多用户、远程访问、认证、权限系统和跨机部署。
- 负责人、优先级、截止日期、估算、依赖图、工时和复杂项目管理字段。
- 把 CodexHost 作为领域层协议或第二条运行时写路径。
- 第一版 SSE 事件日志表。
