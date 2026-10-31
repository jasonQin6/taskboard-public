# Taskboard 领域词汇表

本文件统一定义 taskboard 的产品名词、领域对象和状态语义，供需求、规格、代码、票据与 agent 使用。行为与验收以 `docs/spec/` 为准；为什么这样取舍以 `docs/adr/` 为准；本表只统一「词是什么」，不承载实现步骤。

## 产品与协作边界

**Taskboard**:
本项目唯一的产品。V2 同时承载执行面和观察面；Phase 1 只装配观察面。Kanban、daemon、CLI、HTTP API 和 WebUI 都是 Taskboard 的组成部分，不是并列产品。
_Avoid_: 把 Kanban 当独立应用；为观察面另建数据库、入口或长期产品分支。

**Harness**:
拥有 native session、transcript、turn、summary、memory、分组和执行能力的 Agent 运行时。Taskboard 通过 adapter 读取 Harness 的事实，不把 Harness 的内部状态机复制进共享层。
_Avoid_: 把 Taskboard 当 Harness；让共享层按 Harness 名写条件分支。

**Phase 1 观察型 Kanban**:
Taskboard V2 的只读 MVP 发布切片。它发现、归一、展示和整理各 Harness 已有会话，并用 SystemOne 判断语义进度；不驱动下一 turn，不创建执行 Run。
_Avoid_: 把 Phase 1 当第二个产品或永久架构边界；在 Phase 1 暴露 send、resume、cancel、fork、goal、sample、compact 或 cron。

**Kanban**:
Phase 1 的 WebUI 名称。它读取 Taskboard 的归一化索引和人工 overlay，不是独立数据源。
_Avoid_: 把 Kanban 当独立数据库；让浏览器直接读取 Harness 源存储。

## 定位

**补全层（Completion layer）**:
taskboard 相对 Codex 的定位：Codex 已有的能力只做薄封装，Codex 没有且属于任务中心语义的能力才补充。边界与准入见 `docs/adr/0013-complete-codex-not-reimplement.md`。
_Avoid_: 把 taskboard 当第二个 harness；重写 compaction、goal、approval 或摘要模型。

**Harness adapter**:
只读接入一种 Agent Harness 的适配器，负责发现会话、解析原生记录、暴露 `CapabilityManifest` 并产出来源可核对的归一化事实。adapter 不解释 Task/Run 状态机，不写 Harness 源数据。
_Avoid_: 让 adapter 负责执行；按 Harness 名在共享层写条件分支。

**SourceLocator**:
指向 Harness 原生事实的稳定定位：`harness_id`、`native_session_id`、源路径或记录位置、记录 hash。用于跨 Harness 去重、增量游标和 UI 来源核对。
_Avoid_: 把路径当身份；假设不同 Harness 的 native id 不冲突。

**Harness 原生事实**:
由 Harness 自己产生并拥有解释权的事实：会话身份与元数据、transcript、turn 边界与终态、native status、compaction、memory、分组、goal 和 approval。Taskboard 只读取、归一和投影。
_Avoid_: 用 Taskboard 推断覆盖原生终态；写回 Harness 源数据。

**CapabilityManifest**:
一个 Harness adapter 对当前版本声明支持哪些只读能力、读取路径、对象类型、schema 版本和降级范围的清单。能力缺失必须显式声明，不能靠调用失败猜。
_Avoid_: 把未验证能力写成已支持；让 UI 绕过 manifest 直接探测源存储。

**SessionSnapshot**:
从 Harness 原生事实归一出的会话快照：原生身份、标题、workspace、原生状态、最近活动、原生分组和来源。它是可重建投影，不是 Harness 的权威记录。
_Avoid_: 把快照当 canonical session；把同一会话的多个 source unit 当多个会话。

**Relationship**:
会话之间的原生关系投影，例如 parent、fork、subagent、lineage 和原生分组。关系必须带来源，未知关系不猜。
_Avoid_: 用标题相似度推断血缘；把 fork 当同一会话。

**Cursor**:
每个 source unit 的可重放增量水位，用来保证重复扫描幂等并支持从 Harness 源数据重建索引。
_Avoid_: 用 mtime 代替内容水位；把路径当 source identity。

**OverlayState**:
只写 Taskboard 数据库的人工观察状态，包括 Workstream、绑定、标签、备注、忽略、归档和列覆盖。它不反写 Harness，也不推进 V2 Task 或 Run 状态机。
_Avoid_: 用 overlay 改写原生状态；把列覆盖当执行状态。

**Failure**:
adapter、reader 或 SystemOne 的结构化降级结果，至少包含错误码、可展示原因、影响范围和是否可重试。局部失败不得阻塞其它会话。
_Avoid_: 静默吞错；用空值伪装成功。

**Workstream**:
Phase 1 的人工观察视图，可绑定若干会话，并携带标签、备注和列覆盖。不是 Task，不产生 Run，不承载验收或调度。
_Avoid_: 把 Workstream 当执行任务；把列覆盖写回 Harness。

**ProgressVerdict**:
SystemOne 对会话语义进度的结构化判断，包含 status、confidence、原因、证据引用、覆盖边界和 provenance。只作展示，不写原生状态或 Task 列。
_Avoid_: 把语义进度当 native turn 终态；让 verdict 驱动自动动作。

**SystemOne**:
统一的外部模型调用层，用于 classify、label、group 和语义进度判断。默认 provider 为 Magpie。SystemOne 是带外单发调用，不是 Agent runtime；Jev 是其中一个 provider 候选。
_Avoid_: 把 SystemOne 当会话执行器；用 Harness 自己的 prompt 入口调用系统模型而创建真实会话。

## 核心对象

**任务（Task）**:
一次可执行的工作单元：标题 + 描述/prompt + 绝对 workspace，可附标签、来源、验收标准、acceptance/automation 模式、workspace 模式、可选 parent、可选 cron 与 goal 配置。状态列固定为 `backlog / todo / running / done / failed`；`archived` 与列正交。
_Avoid_: 把 Task 和 Run 混用；用标签承载状态；把外部 issue 本身当 Task 存储。

**列（Column）**:
Task 的五个状态位：backlog、todo、running、done、failed。列由人工动作、Run 终态和 thread 原生观察共同决定，优先级为：人工动作 > Run 终态 > thread 观察。列移动本身不产生 Run。
_Avoid_: 把 `waiting_user`、`blocked` 等语义状态当列；为归档单开第六列；用列移动伪造执行历史。

**运行（Run）**:
taskboard 经 Harness Driver 发起的一次写调用（创建 thread 或发送消息），从写调用开始到该次 turn 到达终态为止。状态 `queued → running → completed / failed / cancelled`；trigger 为 manual、cron、cascade、auto。goal 的后续续跑不延长 Run。
_Avoid_: 把外部观察到的 turn 说成 Run；把一次 goal 的多个内部 turn 说成多个 Run；把 goal 控制调用当 Run。

**线程（Thread）**:
harness 中真实存在的会话。跨 Harness 身份为 `(harness_id, native_session_id)`；Codex 的 native id 以 `session_meta.id` 为准。Thread 有原生状态（running/idle/completed/failed/interrupted/held/unknown）与语义状态（progressing/waiting_user/blocked/complete/needs_attention/unknown），两者分开。
_Avoid_: 把 thread 当任务；把语义状态写进原生状态；把同一条 thread 的多个 source unit 当多个 thread。

**主绑定（Primary binding）**:
一个 Thread 至多一个 primary Task 的关联；一个 Task 可关联多个 Thread。数据库部分唯一索引强制。
_Avoid_: 让两个任务共同控制同一 thread 的自动化；把 derived-from 关系当主绑定。

**Inbox**:
未绑定 Task 的 Thread 集合，不是第六列。默认只显示最近 30 天有活动且未忽略的线程。
_Avoid_: 把 Inbox 当任务池；把 30 天显示窗口当删除策略。

**轮（Turn）**:
Thread 内由原生事件界定的一段执行。边界只认 `event_msg` 变体：`task_started` → running，`task_complete` → completed，`turn_aborted` → interrupted，error → failed。item 完成事件永不作 turn 终态。
_Avoid_: 把 item.completed 或任意带 thread id 的事件当终态；把 interrupted 当 failed。

**证据（Evidence）**:
从 rollout 提取的最小事实：可见消息短摘录、reasoning summary、工具状态、文件变更路径、turn 错误、标注。不是 Task，也不是 Run。
_Avoid_: 保存完整 transcript、完整工具输出、encrypted reasoning 或 patch 全文；把证据当结论。

**摘要（Summary）**:
harness 自己产出的线程摘要。provenance 固定为 `compacted | sample | none`：compacted 来自 rollout 内 harness 自写的压缩记录，sample 来自原生 `thread/sample`。taskboard 不生成替代 native summary；语义进度另由 `ProgressVerdict` 表达。
_Avoid_: 用外部模型生成摘要；把 sample 缺失当错误；混用不同 provenance 的可信度。

**提案（Proposal）**:
Jev 的一次结构化判断：summary、progress、候选动作、推荐、置信度、风险、证据引用。提案只是建议，不直接改状态。
_Avoid_: 把提案当执行结果；让 Jev 自由发明动作；把 confidence 当正确率保证。

**动作执行（Action Execution）**:
提案被接受后的一次写操作记录（continue_thread、retry_run、create_child_task、annotate、ask_user、mark_blocked、mark_done、no_op，以及 goal/cancel/sample 等控制调用）。不等于 Run。
_Avoid_: 把控制调用记成 Run；执行了却不留审计。

**Jev**:
选择与语义判断层。通过 Codex driver 的一次性 ephemeral 调用执行，不写原 thread；输入按不可信数据处理，输出只进 Proposal。
_Avoid_: 把 Jev 当状态存储、会话读取器或执行器；让 Jev 输出直接进状态机；把 rollout 文本拼进外发消息。

**Source unit**:
一个 rollout 文件的读取单元，以 inode 为主键（path 只是属性），保存 prefix hash、session id、parser version、consumed bytes、tail hash。文件在 `sessions/` 与 `archived_sessions/` 间移动不得让幂等失效。
_Avoid_: 用 path 当主键；用 mtime 判断“最近活动”；在重写时先删后建。

**Reader anomaly**:
损坏行、未知类型或 ordinal 缺口的结构化记录。记录后推进字节游标，不永久阻塞后续内容。
_Avoid_: 遇到坏行停扫；静默跳过。

**Retro（复盘记录）**:
对一次 agent 会话或交付 attempt 的复盘记录，taskboard 的一个子功能。记录会话的结论、发现与未覆盖项，供后续改进；由会话收尾触发产生，不参与 Task/Run 状态机。
_Avoid_: 把 Retro 当验收或质量门；让 Retro 驱动自动化决策；为 Retro 另建独立账本或独立事实源。

**Combo（组合观察行）与同型（Same-type）**:
Combo 是一次会话的技能组合观察行（form、skills、outcome 等），存 taskboard `retro_combo` 表，同 session 幂等刷新。同型是 Combo 的归组键：两行的 form（取 actual.form，缺省 form_hint）相等，且 skills 归一化（小写、去 `pstack:` 前缀）、去重排序后的集合相等。成功组合信号 = 同型且 outcome.label=delivered 的行 ≥2；查询面是 `taskboard retro combo-same-type`，归一化口径唯一实现在 store 层。
_Avoid_: 消费方自算归组口径或另立归一化规则；拿 form_hint 机械信号充当 actual.form 终判。

## 状态与权限

**原生状态（Native status）**:
harness 自己给出的线程状态：running、idle、completed、failed、interrupted、held、unknown。`held` 表示写锁被其他进程持有。
_Avoid_: 用语义判断覆盖原生硬状态。

**语义状态（Semantic status）**:
Phase 1 由 SystemOne 的 `ProgressVerdict` 给出的状态：progressing、waiting_user、blocked、complete、needs_attention、unknown。只作卡片徽标，不驱动列（interrupted 等原生硬状态除外）。
_Avoid_: 把语义状态当列；让 SystemOne 或 Jev 改原生状态。

**acceptance**:
验收权归属。`human`（默认）只能人工进入 done；`agent` 在显式授权且满足证据门时允许 mark_done 自动执行。与 automation 正交。
_Avoid_: 把 acceptance 当 automation；让 agent 自述完成就进 done。

**automation**:
评估与动作自治程度：`off` 只观察不评估；`suggest` 生成摘要与提案；`auto` 允许策略内低风险动作自动执行。
_Avoid_: 把 automation=auto 解释为任意动作都可自动执行；把全局 pause 当 cron 开关。

**证据门（Evidence gate）**:
`acceptance=agent` 自动 mark_done 的确定性前置：验收标准非空、最新 turn completed、无未收敛 anomaly、提案引用至少一条验收证据、风险非 critical、单飞与幂等通过。
_Avoid_: 用模型打分替代证据；跳过单飞或幂等；没有证据也自动 mark_done。

**workspace 模式**:
`current` 直接使用任务 workspace；`isolated_worktree` 从基准分支创建独立 worktree/branch，把该目录作为 cwd 交给 harness。
_Avoid_: 在 isolated 任务里改主工作区；自动 push/merge。

**父任务与级联（parent / cascade）**:
Task 可设 parent_id；深度默认上限 1、最大 3，禁止成环。父任务可设 cascade：父 Run completed 后按创建顺序逐个驱动未归档子任务，每个子任务产生独立 Run；任一子任务非 completed 即停并翻转父 Run。级联不跨重启恢复。
_Avoid_: 级联删除子任务；并行轰炸子任务；重启后续跑半截级联。

## 数据与恢复

**state 数据库**:
SQLite（`node:sqlite`，Node ≥ 24），taskboard 的唯一事实源；Codex rollout JSONL 是 Codex 历史的权威来源，数据库只存派生数据。开启 WAL、busy timeout、外键；所有写操作走 repository/service 事务。
_Avoid_: 恢复 JSON 账本；把 Codex 自己的 state/history SQLite 当事实源；绕过 repository 直写。

**域 revision（domain revision）**:
按 `tasks`、`threads`、`config` 分域维护的单调写序号。SSE 广播 `{domain, revision, ids[]}`，客户端按域重拉。
_Avoid_: 单一全局 revision 被证据写入持续推高；SSE 推全量快照。

**latest-only 拉取（latest-only fetch）**:
域 revision 触发重拉的守护语义：请求发起时捕获当前 key，结果返回时 key 已变即丢弃；同 key 在飞时后续请求排队、只保留最后一次。任何时序下视图收敛到最新请求。
_Avoid_: 让过期窗口的结果覆盖新状态；每个视图各自手写守卫；把组件卸载竞态与数据过期竞态混为一谈。

**保留策略（Retention）**:
每任务最多 20 条 Run；幂等键最近 256 条；未绑定 thread 证据默认 90 天；已绑定 thread 证据保留到归档后 90 天；阈值可配置。
_Avoid_: 把 Inbox 30 天当删除策略；让证据无限增长。

**单实例锁（Single instance lock）**:
数据库同目录的锁文件，记录 pid 与启动时间，按心跳刷新 mtime。第二个 daemon 遇新鲜锁失败并报持有者；陈旧锁可接管；正常退出释放。
_Avoid_: 把锁当数据库状态；见锁就手删。

**重启对账（Restart reconciliation）**:
启动时把遗留 running Run 判 failed(orphaned) 并保留 thread，queued Run 判 cancelled，pending/running Action Execution 判 failed(orphaned)；任务回可重跑态；级联与进程内单飞状态清空。
_Avoid_: 让孤儿 Run 永远 running；把对账当常规取消；删除 thread/证据。

**损坏隔离（Corrupt isolation）**:
打开数据库时 `PRAGMA quick_check` 失败，就把库文件移为 `<db>.corrupt-<时间戳>` 并拒绝启动。只有文件不存在才初始化空库。
_Avoid_: 静默清空重建；把校验失败当首次初始化。

**迁移（Migration）**:
schema 迁移在事务内逐级执行，失败整体回滚；不使用 V1 的多份 `.bak-vN` 备份链。
_Avoid_: 跳级迁移；删字段式升级；事务外改 schema。

## Reader 与 Codex 运行时

**Rollout JSONL**:
`CODEX_HOME` 下 `sessions` / `archived_sessions` 的 Codex 会话文件；支持 `.jsonl` 与 `.jsonl.zst`。JSONL 是 Codex 历史的权威来源。
_Avoid_: 把 Codex UI 投影数据库当权威；解析未完整换行的尾行。

**compacted 摘要**:
rollout 内 `compacted` 记录的 `payload.message`，harness 自写。reader 取最近一次 compaction，按记录 hash 幂等提取。零模型成本、零锁。
_Avoid_: 解析 replacement history 等内部结构；取最旧一次；重复提取。

**sample**:
原生 `thread/sample`（experimental）。仅对已绑定 Task 的线程：试探性 resume 接管写锁 → 校验 expected_turn_id → ephemeral fork 采样 → close 释放。能力缺失或被占用时回落 compacted。状态标记 `[未实现·外部依赖]`，验收前置为 codex 版本包含该 method。
_Avoid_: 对 Inbox 线程 resume；把 sample 当必需能力；采样写原 rollout。

**写锁（Writer lock）**:
`CODEX_HOME/thread-writer-locks` 的跨进程 flock；“线程已加载”即“持有写锁”。`thread/resume` 可能 materialize `.jsonl.zst`，是扫描只读的唯一例外。
_Avoid_: 绕过写锁并发写同一 thread；把 held 当 failed。

**单飞（Single-flight）**:
同一 thread 至多一个 in-flight 写操作。进程内互斥为主，写锁只探测外部持有；Conflict 时排队或拒绝并记录，绝不并行。
_Avoid_: 跨进程队列；第二条 app-server 写路径；send 与 goal 并行。

**fork / rollback**:
fork 产生新 session id，是独立 thread，只用 lineage 证据关联；rollback 是同一 source unit 的重写，不产生新 thread。
_Avoid_: 把 fork 当同一条 thread；把 rollback 当新会话；合并父线程继承前缀。

**subagent history**:
子代理在 rollout 内的历史段。turn/item 按 start ordinal 隔离归属，不并入主 thread 序列。
_Avoid_: 把子代理内容算进主线程 turn；用主线程 ordinal 覆盖子代理。

**goal**:
Codex 原生长期目标。create/set/get/pause/resume/clear 映射到 `thread/goal/*`，记为 Action Execution。goal continuation 不延长 Run；goal complete 只是证据，不等于 Task done。
_Avoid_: taskboard 自造 goal judge；Jev 自行升级为 goal；goal 完成即 mark_done。

## 自动化与安全

**shadow**:
自动推进前的离线对比阶段：用真实 thread 快照比较 no_op、Codex 原生建议与 Jev 选择，人工标注有帮助、无效、有害。没有有害动作且 Jev 优于 no_op 才进入 live。
_Avoid_: 未 shadow 就开自动执行；用模型自评替代人工标注。

**断路器（Breaker）**:
sample 或 Jev 连续失败 3 次后暂停该 thread 的自动评估，落审计，人工 resume 后恢复。失败含超时、连接错误、非法输出、越界选项。
_Avoid_: 无限重试烧钱；把失败当 no_op；自动恢复。

**执行计划（Execution plan）**:
门快照与提案经 `planAutoExecution` 纯函数一次成型的自动执行决策（ADR-0015）。放行形态携带完整执行口径（动作、authorizedBy、requestId、confidence、风险）；拒绝形态携带原因。计划只是决策，不改变状态；执行面只消费计划分派。
_Avoid_: 执行路径就地拼授权口径；评估收口造半计划、执行时二次决策；把计划当执行结果。

**提案执行面（Proposal executor）**:
消费执行计划放行形态、分派提案动作并留审计的执行模块，与 Jev 评估编排分离。评估层只产计划与提案；执行面照计划执行，不再二次决策。
_Avoid_: 评估路径直接分派动作；执行面内重开裁决或重读门状态；把执行面当第二个决策面。

**门快照（Gate snapshot）**:
自治执行判定所需状态的单次读取面（门模式、全局 pause、live 配额、证据门资格）。执行起跑时读取，判定反映执行当下的门状态。
_Avoid_: 判定函数直接读 store；评估时取快照、执行时沿用旧值；三处各自捞门状态。

**no-op 指纹（Evidence fingerprint）**:
用于判断“没有新证据且上次结论是 no_op”的稳定键；命中则跳过 sample 与 Jev。
_Avoid_: 用时间戳当指纹；有新证据仍跳过。

**全局 pause**:
持久化在 settings 的自动化暂停开关：立即停止新评估与自动动作；cron 是用户显式调度，不受影响。
_Avoid_: 把 pause 当 cron 开关；只存内存导致重启复活。

**风险等级（Risk）**:
low / medium / high / critical。live 第一版只自动执行 low（continue_thread、annotate），critical 一律拒绝，其余只生成提案。
_Avoid_: 让 Jev 自评风险后直接放行；把 high 当 low。

**CSRF 基线**:
POST 只接受 `Content-Type: application/json`，校验 Origin/Host 为回环或显式允许来源，拒绝跨站请求。
_Avoid_: 只绑 loopback 就认为安全；接受表单 POST；跳过 Origin/Host。

**代理栅栏（Proxy Guard）**:
可选 HTTP 来源/令牌把门，默认关。`trustedProxyHosts` 非空即开启：写面要求受信 socket 来源 + `x-taskboard-token`，读面回环放行；只认 socket 地址，不解析 `X-Forwarded-For`；daemon 恒绑 `127.0.0.1`。
_Avoid_: 把它当认证系统；为跨机放开监听；把拒绝当 action 失败落库。

**防休眠（Power Guard）**:
可选 `preventIdleSleep`，默认关。存在活跃 Run 或 taskboard 发起的 goal 续跑时持有平台级防休眠；排队、提案和纯外部 Desktop 活动不计入。平台缺失时静默降级并暴露状态。
_Avoid_: 把窗口挂在入队上；为级联整体开特例；把不可用当错误。

## 保留的 V1 语义

**cron**:
5 段表达式，到点触发与手动同一条 Run 创建路径；错过不补；活跃 Run/归档/缺 workspace 跳过并记原因；可选 IANA 时区，处理夏令时边界；改 cron 或时区重算 nextRunAt。
_Avoid_: 为 cron 另造执行通道；补跑历史错过；忽略时区。

**wait / 静止（quiet）**:
`taskboard wait <taskId>` 只读阻塞到“静止”：无活跃 Run、主绑定 thread 非 running、无 in-flight 写操作；返回最近 Run 终态摘要。覆盖 once 与 goal；默认 600 秒，超时 exit 1。
_Avoid_: 把 wait 当调度或状态变更；只等 Run 账面终态而忽略 goal 续跑；在 daemon 里建 wait 状态。

**标签（Label）**:
每任务 ≤8 个，服务端归一化（去空白、丢空项、去重、超量截断）；只做展示分组。
_Avoid_: 把标签当权限/路由/执行参数；超量报 400。

**工具契约（Tool Contract）**:
`taskboard` CLI 对模型的稳定输出：每个子命令 `--json` 字段集合与类型、错误形态与退出码（0 成功、1 语义失败/超时、2 用法错误、3 不可达），由 `test/tool-contract.test.ts` 快照钉死。V2 契约从零重建，不兼容 V1 字段。
_Avoid_: 静默增删字段；让 agent 解析人读文本；承诺兼容 V1。

**工具播报（announceToAgent）**:
仓库内 skill 文件 `.agents/skills/taskboard/SKILL.md`，放入 harness skill 目录即生效、移除即关闭；daemon 无配置项。
_Avoid_: 把播报当 daemon 行为；直写宿主配置。

## 已退役词汇（V1 归档）

- **Ledger / JSON 账本**：被 SQLite state 数据库取代。
- **labelHint**：被执行 prompt 本体取代，不再做前缀注入。
- **Draft / 粘贴草稿**：V2 不提供。
- **Freeze block / 冻结块**：V2 不提供。
- **Workflow catalog / routing / binding**：V2 不实现。
- **Team / teammate / 会合段**：V2 不实现。
- **verifier / 模型质检门**：被 acceptance=agent 的确定性证据门取代。
- **permission gate / 执行前确认席**：并入提案确认。
- **self-improve 专用任务类型**：自改进是普通 issue + isolated worktree。
- **deeplink（zcode://）**：随 zcode executor 删除。
- **doing / review / blocked / cancelled 列**：V2 只有五列；blocked/waiting_user 是语义徽标。
- **全局 revision**：被 tasks/threads/config 域 revision 取代。
