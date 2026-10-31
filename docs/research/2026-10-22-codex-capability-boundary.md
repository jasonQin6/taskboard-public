# Codex 能力边界：taskboard 的补全清单（2026-10-22）

> 起因：评估 dsh-done 的 5 条需求时发现，其中多数能力 Codex 本身已经具备。为避免 taskboard 继续重复 harness，本文把“Codex 已有 / Codex 没有”整理成可执行的准入清单。
> 结论先行：**taskboard 的定位是 Codex 的补全层，不是第二个 harness。** Codex 已有的能力只做薄封装；Codex 没有、且属于任务中心语义的能力才补充；两者都不属于的直接不做。

## 1 判定规则

任何新能力先回答三个问题，顺序不能颠倒：

1. **Codex 有没有原生实现？** 以官方文档与运行时可探测的能力为准，不以“社区常见做法”为准。
2. **有 → 能否用薄封装暴露？** 封装只做能力探测、协议适配、provenance 与审计，不复制语义，不自造降级路径。
3. **没有 → 是 taskboard 的产品语义，还是 harness 该做的事？** 只有前者才进入补充清单；后者记录为不做，并写进 ADR。

判不出归属的能力不做。禁止用“先实现一个简单版”绕过这条规则——简单版最终会长成第二套语义。

## 2 逐层对照

| 层 | Codex 原生 | 对外可用面 | taskboard 处置 |
|---|---|---|---|
| 会话持久化与生命周期 | rollout JSONL（`sessions` / `archived_sessions`）；archive / unarchive / delete / queue | 本地文件 + CLI | 封装：只读扫描，不写会话库 |
| 会话读取与增量索引 | 无面向第三方的查询或增量索引 API，只提供原始 JSONL | 文件 | 封装：reader 把 JSONL 投影成 turn/evidence（ADR-0003、ADR-0005） |
| 摘要 | harness 压缩上下文时自写 compacted 记录 | rollout 内的记录 | 封装：只提取，不生成（ADR-0008） |
| 摘要增强 | 原生 `thread/sample`（experimental，按能力探测） | app-server method | 封装：调用、校验、释放；遇 held 回落 compacted |
| 目标驱动 | native goal（`thread/goal/*`） | app-server | 封装：映射控制调用；不实现本地 goal judge |
| 继续 / 恢复 | resume / continue thread | CLI 与 app-server | 封装：单飞与写锁校验，不并行 |
| 定时 | scheduled tasks；桌面 app 支持本地项目与隔离 worktree，CLI 不提供管理面 | 产品 UI | 补充任务级语义：cron、级联、wait；不复刻 Codex 的 scheduled tasks |
| 跨会话回忆 | Memories、Computer History（需开启、macOS 桌面、依赖 Memories） | 产品 | 不补充：个人记忆层，不是项目状态或未闭环清单 |
| 上下文压缩与审批 | compaction、approval policy 由 harness 掌控 | harness | 不重写：taskboard 不提供审批应答面 |

## 3 需要补充：Codex 没有，且属于 taskboard 的产品语义

- **任务账本与五列状态机**：Codex 以 session/thread 为中心，没有 Task 这个工作单元，也没有 backlog/todo/running/done/failed 与归档。
- **Task ↔ Thread 绑定与 Inbox**：Codex 有会话列表，但没有“一个任务的主线程”与未绑定线程的收纳区。
- **跨项目未闭环视图**：按 workspace 聚合任务状态、等待人工的事项与需要关注的线程；Codex 的会话列表不做项目级汇总。
- **提案、审计与动作执行链**：Jev 只选不写，动作必须经过提案、授权与执行记录；Codex 没有这层治理结构。
- **任务级编排语义**：cron 到点起单、错过不补、级联、wait、防休眠；这些建立在 Codex 的单次写调用之上，不是新原语。

补充项的共同点：都是“围绕工作单元的组织与治理”，不是“再实现一个模型或运行时”。

## 4 需要封装：Codex 已有，taskboard 只做薄适配

- **rollout 摄取**：文件布局、增量游标、尾部半行、截断/重写、损坏行隔离，全部以 ADR-0003 的只读扫描为边界。
- **摘要**：compacted 基线直接提取；sample 只在能力可用且线程已绑定时调用，provenance 固定为 `compacted | sample | none`。
- **native goal**：只映射 create/set/get/pause/resume/clear；goal complete 是证据，不等于 Task done。
- **resume / continue**：先过单飞与写锁；外部持有就明确拒绝或排队，不切第二条写路径。
- **定时原语**：Codex 桌面 app 已有 scheduled tasks；taskboard 的 cron 只在任务语义内使用，不宣称提供新的调度能力。

封装的验收标准只有两条：行为与 Codex 原生一致；失败时如实暴露，不静默降级为自造实现。

## 5 红线

- 不重写 compaction、recap、approval、tool execution 或 continuation。
- 不引入替代摘要模型，也不自研 recap。
- 不建立第二条 Codex 写路径，不并行写同一 thread。
- 不往用户工作区写状态文件，不复制完整 transcript。
- 不把 Memories / Computer History 当作项目状态或未闭环事实源。

## 6 新能力准入检查表

1. Codex 是否已有原生实现？依据是官方文档还是实际能力探测？
2. 如果有，封装后的接口是什么？provenance 与审计记在哪里？
3. 如果没有，它属于 taskboard 的产品语义，还是 harness 应该补的能力？
4. 它是否会产生第二事实源、第二写路径或第二个模型？
5. 它对应哪条 ADR？没有对应 ADR 的补充项，先写 ADR 再排期。

## 7 来源

- OpenAI Docs：[Developer commands](https://learn.chatgpt.com/docs/developer-commands.md)、[Scheduled tasks](https://learn.chatgpt.com/docs/automations.md)、[Memories](https://learn.chatgpt.com/docs/customization/memories.md)、[Computer History](https://learn.chatgpt.com/docs/customization/computer-history.md)。
- 仓库决策：`docs/adr/0003-jsonl-authoritative-read-only-scan.md`、`0005-native-turn-terminal-states.md`、`0008-harness-owned-summaries.md`、`0009-codex-only-no-speculative-frameworks.md`、`0010-jev-proposals-only.md`、`0011-self-improvement-as-plain-issue.md`。
