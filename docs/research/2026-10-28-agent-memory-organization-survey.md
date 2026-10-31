# 开源项目如何组织 Agent 的记忆与会话历史

核验日期：2026-10-28。本文只回答一个问题：**已有项目把 Agent 的记忆和会话历史组织成什么结构**（单位、分区键、分层、载体、检索、维护、时间），不讨论 UI 风格。

依据限于一手资料：论文原文、官方文档、官方仓库源码快照。快照版本随文标注；凡版本漂移或已归档的项目都写明，避免把不同代实现混成一套架构。

## 结论速览

1. **先分清三个平面**，否则所有讨论都会混：[源记录](#口径先分清三个平面)（原始消息/turn/episode）、派生记忆（抽取的事实、画像、摘要、关系）、会话续接状态（history、checkpoint、thread state）。多数项目只实现其中一到两层，却共用“memory”这个词。
2. **只有四种主流组织结构**：会话日志 + 层叠摘要、分层记忆块（OS 换页式）、抽取事实/知识图谱、文件即记忆。它们不是演进关系，而是针对不同失败模式的选择。
3. **分层的事实标准是「原始层保真 + 派生层可检索」**。Zep/Graphiti 的 episode→fact edge→community、Cognee 的 Data→DataPoint→summary、Basic Memory 的 Markdown→索引都遵循这一点。
4. **写入是转换而不是追加**：抽取、去重、合并、失效、反思都发生在写入期；只有会话续接层才是纯 append。
5. **作用域键是一等约束**，不是检索参数：`namespace` 元组、Dataset+ACL、Project、`group_id`、`(project_id, user_id)` 复合主键，决定删除、授权、索引隔离和迁移边界。
6. **记忆正在从同步响应路径迁到后台整理**（Letta dreaming、LangMem reflection、Memobase buffer flush），代价是延迟、重放与幂等设计。
7. **可观测性领域已经给出跨 Harness 的标准词汇**：OTel GenAI semconv 用 `gen_ai.conversation.id` 关联会话，并把记忆建模成独立的 `gen_ai.memory.client` span（store 生命周期 + record 增删改查）。
8. **编码 Agent 的落地形态高度一致**：原始 transcript 不删、压缩只换模型可见视图、跨会话记忆靠“小型常驻索引 + 按需读正文”，作用域按项目目录切。
9. **指令不是记忆**：`AGENTS.md` / `CLAUDE.md` / rules 是人写的规则层，和 agent 从会话里学到的内容必须分开建模、分开更新。

## 口径：先分清三个平面

| 平面 | 是什么 | 代表实现 | 不该被误称为 |
|---|---|---|---|
| 源记录 | 不可再生的原始输入/事件：message、turn、episode、工具调用 | Codex rollout JSONL、OpenHands EventStream、Graphiti Episode、Langfuse observation | 长期记忆 |
| 派生记忆 | 从源记录抽取/归并/摘要出的产物：事实、画像、事件、关系、规则、社区摘要 | Mem0 事实条目、Graphiti fact edge、Memobase profile、Codex stage1 摘要 | 原始记录 |
| 会话/检查点状态 | 为继续对话或恢复执行而保存的 history、channel state、thread 状态 | OpenAI Agents SDK Session、LangGraph Checkpoint | 长期记忆 |

这条边界直接影响数据建模：OpenAI Agents SDK 的 Session 只有会话输入层，没有实体、关系、画像或冲突合并层（[官方 Sessions](https://openai.github.io/openai-agents-python/sessions/)、[sqlite_session.py](https://github.com/openai/openai-agents-python/blob/cd26bbbc5284/src/agents/memory/sqlite_session.py)）；LangGraph 的 Checkpoint 按 `thread_id/checkpoint_ns/checkpoint_id` 保存运行时 channel state 用于恢复，跨 thread 的长期记忆在 Store 里（[持久化概念](https://langchain-ai.github.io/langgraph/concepts/persistence/)）。

## 四种组织结构范式

### 范式 A：会话日志 + 层叠摘要

一条 append-only 的原始流水，加上若干层由模型生成的摘要；层数决定上下文成本。

- OpenAI Agents SDK Session 保存原始 conversation input items，以 `session_id` 隔离，`agent_sessions` + `agent_messages(message_data JSON)` 两表，检索就是“最近 N 条”，无语义检索（[官方 Sessions](https://openai.github.io/openai-agents-python/sessions/)）。
- Agent 侧典型做法是“原始 turn → 会话摘要 → 全局摘要”三层：MemoryBank 保存每轮对话、日摘要、全局摘要与 user portrait，并在命中时增强记忆强度（[arXiv 2305.10250](https://arxiv.org/abs/2305.10250)）。
- Codex 自身就是这一范式的工业实现，见下节[本地实测](#taskboard-侧的本地实测事实)。

这一范式的失败模式是**摘要不可追溯**：一旦派生层没有保留指回源记录的键，读者只能相信摘要。

### 范式 B：分层记忆块（OS 换页式）

把上下文当成内存、把外部存储当成磁盘，由模型或运行时在两者间换页。

- MemGPT：`main context`（system instructions + 定长 working context + FIFO 消息队列）与 `external context`（recall / archival）分离；token 压力触发驱逐与递归摘要，但外部记录不删除（[arXiv 2310.08560](https://arxiv.org/abs/2310.08560)）。
- Letta V1 是它的具体化：Core block（固定注入，含 `label/description/value/limit/read_only/version/block_history`）、Archival passage（带 embedding 与 tags 的归档片段）、Recall（直接搜索原始 message，不另建“回忆表”）；默认 SQLite，可切 Postgres/pgvector（[Block ORM](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/orm/block.py)、[Passage ORM](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/orm/passage.py)）。
- CoALA 给出的是认知侧的分层：working / episodic / semantic / procedural memory，检索把长期记忆取入 working memory，learning 再写回（[arXiv 2309.02427](https://arxiv.org/abs/2309.02427)）。

### 范式 C：抽取事实与知识图谱

写入期把对话转成事实、实体或关系，检索走图或混合检索。

- Mem0 当前 OSS：LLM 抽取带 hash/文本/embedding/作用域/metadata 的事实条目，作用域由 `user_id/agent_id/run_id` 组成，混合检索 semantic + BM25 + entity overlap，维护历史落在 SQLite `history` 表（`old_memory/new_memory/event/is_deleted`），并保留最近一段原始消息（[how-it-works](https://github.com/mem0ai/mem0/blob/26cdefb46600/docs/core-concepts/how-it-works.mdx)、[storage.py](https://github.com/mem0ai/mem0/blob/26cdefb46600/mem0/memory/storage.py)）。注意：经典 v1.0.11 的 Neo4j 图记忆已不在 OSS 主流程里（旧实现关系软失效 `valid=false`，见 [graph_memory.py](https://github.com/mem0ai/mem0/blob/144627c4ce5b/mem0/memory/graph_memory.py)）。
- Zep / Graphiti：`Episode`（源）→ `Entity`/`EntityEdge`（事实，含 `fact/fact_embedding/episodes/valid_at/invalid_at/reference_time`）→ `Community`（聚合摘要）；双时间轴区分现实有效期与系统写入/失效时间；冲突时旧边置 `invalid_at` 而不硬删；检索是 BM25 + cosine + BFS 生成候选再组合 RRF/MMR/cross-encoder（[edges.py](https://github.com/getzep/graphiti/blob/efc40d21b0af/graphiti_core/edges.py)、[arXiv 2501.13956](https://arxiv.org/abs/2501.13956)）。
- Cognee：typed `DataPoint` + `Edge` + Dataset 边界（`owner_id/tenant_id/ACL`），阶段是 remember → cognify → improve → forget（[DataPoint.py](https://github.com/topoteretes/cognee/blob/37f788bd2877/cognee/infrastructure/engine/models/DataPoint.py)、[arXiv 2505.24478](https://arxiv.org/abs/2505.24478)）。
- A-MEM 走 Zettelkasten 路线：原子笔记含原文、时间、关键词、标签、上下文描述、embedding、链接集合，新笔记先向量召回近邻再用 LLM 建链（[arXiv 2502.12110](https://arxiv.org/abs/2502.12110)）。

### 范式 D：文件即记忆

记忆是可读、可 diff、可提交的文件；数据库只是索引。

- Letta 当前 MemFS：每 Agent 一个 Git 仓库，记忆单位是 Markdown(+frontmatter) 文件；根级文件进入系统提示，子目录由 `MEMORY.md` 做目录索引按需读取；并发写入用 Git worktree 隔离；版本由提交历史表达（[MemFS 文档](https://docs.letta.com/concepts/memfs/)）。
- Basic Memory：Markdown 中的 Entity / Observation / 有向 Relation（支持未解析 `[[wikilink]]`）是知识单位，Project 是同步边界，内部 `id`、稳定 `external_id`、project-scoped `permalink` 与可变的 `file_path` 分离；SQLite 用 sqlite-vec、Postgres 用 pgvector 重建索引（[DOMAIN_MODEL](https://github.com/basicmachines-co/basic-memory/blob/0884e204d84a/docs/DOMAIN_MODEL.md)）。
- 编码 Agent 的 `AGENTS.md` / `CLAUDE.md` 与 Memory Bank 文件属于同一范式，见下一节。

### 附加范式 E：遥测/可观测性数据模型

当目标不是“让 Agent 记住”，而是**跨来源读会话**时，业界用的是追踪模型：

- Langfuse：`session 1..n trace 1..n observation`；observation 是 LLM 调用、工具调用、检索步骤等单步并支持嵌套，trace 是“一次请求/操作”的逻辑分组，会话是可选的 trace 分组；实现上只有一张 observations 表，每行带一份 trace 级属性拷贝（`user_id`、`session_id`、`tags`、`metadata`）以便查询聚合（[Observability Data Model](https://langfuse.com/docs/observability/data-model)）。
- OpenTelemetry GenAI 语义约定把同一模型标准化：`gen_ai.conversation.id` 是“会话（session、thread）的唯一标识，用于关联该会话内的消息”，且明确要求**只在客户端框架本来就管理会话历史时才写**，不要用新 UUID 或 trace id 伪造（[gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)）；agent span 体系含 `create_agent`、`invoke_agent`(client/internal)、`invoke_workflow`、`plan`、`execute_tool`、`load_skill`/`read_skill_resource`、`command_execution`，属性含 `gen_ai.agent.id/name/version`、`gen_ai.system_instructions`、`gen_ai.input.messages`/`gen_ai.output.messages`（[gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)）。
- **记忆被正式建模为独立 span 家族**：`gen_ai.memory.client`，操作为 `create_memory_store`、`delete_memory_store`、`create_memory`、`update_memory`、`upsert_memory`、`search_memory`、`delete_memory`；属性含 `gen_ai.memory.store.id`、`gen_ai.memory.record.id`、`gen_ai.memory.record.count`、`gen_ai.memory.query.text`、`gen_ai.memory.records`（[memory span 定义](https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-spans.md)）。其中 `upsert_memory` 的定义是“调用方无法选择是创建还是更新，由记忆系统自行决定或合并”——这与 Mem0/LangMem/Memobase 的写入语义完全对应。

**这条范式对本仓最重要**：跨 Harness 读会话时，主流做法不是发明新的会话表，而是“会话/线程作为分组键 + 步骤作为条目 + 记忆操作作为独立条目类型”。

## 编码类 Agent 工具的组织方式

这类工具最能回答本仓的问题，因为它们每天面对“上下文装不下 + 下次还要接着干”。十个产品的共同结构是**三层 + 一个索引**：

1. **原始 transcript**（不删）：Claude Code 的 `~/.claude/projects/<project>/<session>.jsonl`（大型工具输出另落 `tool-results/`，子代理落 `subagents/`）；Codex 的 `$CODEX_HOME/sessions/YYYY/MM/DD/*.jsonl`；OpenHands 的 `events/event-NNNNN-<id>.json` + `base_state.json`；Aider 的 `.aider.chat.history.md`；Cline/Roo 的 per-task JSON。
2. **压缩摘要**（只替换模型可见视图）：Claude Code 的 `/compact`、Codex 的 `compacted.replacement_history`、OpenHands 的 `Condensation` 事件、Aider 的异步旧消息摘要、Roo 的 `condenseParent`。**原始日志都不删除**；OpenHands/Roo 用 `forgotten_event_ids` / 父指针把旧事件对模型隐藏。
3. **跨会话记忆**：Claude Code 的 auto memory 主题文件 + `MEMORY.md` 索引；Codex 的 Stage 1 rollout 摘要 → Stage 2 全局整理 → `memory_summary.md`；Kilo 的 session digest + project memory；Windsurf legacy Cascade memories。Aider、Continue 未找到官方内建自动语义记忆。
4. **常驻索引 + 懒加载**：启动只注入很小的入口，正文按需读。Claude Code 只读 `MEMORY.md` 前 200 行或 25 KB；Codex 注入 `memory_summary.md`（源码上限 2500 tokens），再按索引读 `MEMORY.md` 与 1–2 个证据文件；OpenHands 合并两层 `MEMORY.md` 上限 6000 字符，daily log 从不自动注入。

| 产品 | 原始历史 | 压缩 | 跨会话记忆 | 常驻入口 |
|---|---|---|---|---|
| Claude Code | 项目 JSONL | `/compact` 摘要 | auto memory 主题文件 | `CLAUDE.md` + `MEMORY.md` 头部 |
| Codex | sessions JSONL | `compacted` 行 | Stage 1 摘要 → Stage 2 全局 | `AGENTS.md` + `memory_summary.md` |
| OpenHands | typed EventLog（可分支） | `Condensation` + hidden IDs | opt-in daily log + 两层 `MEMORY.md` | AGENTS/仓库 skill + memory 索引 |
| Aider | Markdown chat log | 旧消息异步摘要 | 无官方内建 | 显式 read 的文件 |
| Cline / Roo | per-task JSON | auto compact / condense | 无官方内建自动抽取 | rules / Memory Bank（非统一内建） |
| Cursor / Windsurf | 私有存储（未公开格式） | 未公开 | Windsurf legacy Cascade memories | rules |
| Continue / Kilo | session JSON / SQLite | session summary / compact | Kilo 有 digest + project memory | rules + memory index |

三条容易被忽略的结论：

- **指令层与记忆层是两回事**。`AGENTS.md`、`CLAUDE.md`、rules 是人写给所有 agent 的规则，按目录层级拼接并受字节上限约束（Codex 默认 32 KiB 截断，Claude Code 按 managed → user → project 到 cwd 的优先级加载，子目录规则首次访问才加载）；它们不能替代 agent 自己学到的记忆，反过来记忆也不该改写指令。
- **压缩只改视图，不改事实**。这条约定让“历史可回放”成立，也解释了为什么 Codex 的 `thread_history` 需要保留 `rollout_byte_offset`——派生索引必须能指回原始行。
- **作用域按项目目录切**。Claude Code 的 transcript 与 auto memory 都以 project 为目录边界；OpenHands 分 user / project 两层并以项目层获得更多注意力；Codex 的长期记忆则按 Codex home 统一整理，项目信息靠正文与索引表达。三种做法都说明：**项目不是必选的数据库维度，而是一个可选的分区策略**。

来源：[Claude Code memory](https://code.claude.com/docs/en/memory.md)、[Claude Code 工作原理](https://code.claude.com/docs/en/how-claude-code-works.md)、[Codex memories](https://developers.openai.com/codex/memories)、[Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)、[OpenHands 持久化](https://docs.openhands.dev/sdk/guides/convo-persistence)、[Aider repomap](https://aider.chat/docs/repomap.html)、[Aider conventions](https://aider.chat/docs/usage/conventions.html)。

## 横向对照

单位 / 分区键 / 分层：

| 项目 | 源记录 | 派生记忆单位 | 主要作用域键 |
|---|---|---|---|
| Letta 当前 | Git 文件与提交历史 | Markdown 文件/目录索引 | Agent（可共享仓库） |
| Letta V1 | message/conversation | Core block / archival passage | Agent |
| Mem0 当前 | 作用域内最近消息 | 事实条目 + embedding/hash | `user_id/agent_id/run_id` |
| Graphiti | Episode | Entity/EntityEdge/Community | `group_id`（租户/权限需自建） |
| LangMem | thread state 或应用输入 | Store Item（语义/情景/程序） | `namespace` 元组 |
| OpenAI Session | input items | 无抽取层 | `session_id` |
| Cognee | Data 与文档 chunk | DataPoint/Edge/Dataset 图 | Dataset + ACL |
| Basic Memory | Markdown 文件 | Entity/Observation/Relation | Project |
| Memobase | blob/buffer/event | profile + event + gist | Project + User |

写入时机 / 载体 / 冲突策略 / 时序强度：

| 项目 | 写入时机 | 主要载体 | 冲突或删除 | 时序强度 |
|---|---|---|---|---|
| Letta 当前 | Agent 编辑 + dreaming | Git + 文件（可选搜索索引） | 新提交覆盖/合并 | 提交历史 |
| Mem0 当前 | `add` 抽取 + 显式维护 | SQLite + 向量后端 | ADD-only 主流程；history 审计 | created/updated |
| Graphiti | 增量 ingest | 图数据库 | 旧 fact 置 `invalid_at` | 事实双时间 |
| LangMem | hot path 或 background reflection | `BaseStore`（如 Postgres JSONB） | insert/update/delete/consolidate（默认禁删） | item created/updated |
| OpenAI Session | run 前后同步 | SQLite JSON / server conversation | pop/clear/compaction | 消息顺序 |
| Basic Memory | 文件编辑 + 增量同步 | Markdown + SQL/向量索引 | 索引重建 | checksum/partition |
| Memobase | buffer flush 后抽取 | Postgres/pgvector + Redis | ADD/APPEND/UPDATE/ABORT、重组 | event 时间线 |

检索信号：纯顺序读取（OpenAI Session、Aider）、向量 top-k（Mem0、A-MEM）、多信号加权（Generative Agents 的 `recency + importance + relevance`，见 [arXiv 2304.03442](https://arxiv.org/abs/2304.03442)）、图 + 混合重排（Graphiti：BM25 + cosine + BFS + RRF/MMR/cross-encoder）、前缀 + metadata filter（LangMem Store）。

## Taskboard 侧的本地实测事实

本机 `~/.codex` 的实测（口径见[前一节](#口径先分清三个平面)，均为只读查询）：

| 平面 | 载体 | 实测 |
|---|---|---|
| 源记录 | `sessions/**`、`archived_sessions/**` 的 rollout JSONL/zst | 521 + 11 个文件，约 457MB |
| 源记录（派生索引） | `thread_history_1.sqlite`: `thread_turns` / `thread_items` | 核验时约 1.8k 回合、34.8k 条目（随使用增长），覆盖 462 个 thread；`item_json` 按 `item_type` 分型（userMessage/agentMessage/reasoning/commandExecution/fileChange/contextCompaction…），带 `rollout_byte_offset` 可回源 |
| 线程元数据 | `state_5.sqlite`: `threads` | 507 行；`project_id` 全部为 NULL（`projects` 表有 14 行但未关联任何线程） |
| 派生记忆 | `memories_v2_1.sqlite`: `stage1_outputs` | 51 行（50 行 `selected_for_phase2`），字段 `rollout_summary/raw_memory/rollout_slug/source_updated_at`；`jobs` 显示 50 done / 6 error |
| 派生记忆（呈现） | `memories_v2/memory_summary.md`、`rollout_summaries/*.md` | 全局摘要 + 每 thread 一份 Markdown |

结论：Codex 本身是**范式 A（会话日志 + 层叠摘要）+ 范式 B 的弱形式**（thread 元数据/上下文压缩），没有向量、没有 FTS、没有事实层；而它的 `threads → turns → items` 与遥测范式 E 的三层结构同形。

## 对 Taskboard 的建模含义（待你确认）

1. **主干用 thread → turn → item 三层**（对应 OTel 的 conversation → span，对应 Langfuse 的 session → trace → observation），身份用 `(harness_id, native_session_id)`（ADR-0018），回源用 `rollout_byte_offset` 这类 locator，而不是复制正文。
2. **记忆作为派生视图，而不是新的实体层级**：`stage1_outputs.rollout_summary` 与 `memory_summary.md` 直接呈现，不重造摘要（对应[架构图](../architecture/2026-10-25-harness-functional-map.html)里“原生摘要优先”）。
3. **项目维度先不要建模**：本机 507 个线程 `project_id` 全空，Codex 的 project 机制尚未使用；弱分组用 `cwd` / `git_origin_url`，等真有数据再升格（避免为一个空字段引入外键和迁移）。
4. **不要急着引入向量**：现有四个平面都没有 embedding/FTS；检索可以先用「SQL 索引 + 时间窗 + item_type 过滤」。若要做语义检索，那是一次架构变更（需 ADR，且运行时零依赖约束下需要 Node 侧实现或外部服务）。
5. **记忆维护动作只观察不驱动**：consolidate/stage1 属于 Harness 自身管线，Taskboard 只读结果与 job 状态（与 ADR-0019「只判断不驱动」一致）。
6. **把“能力声明”做成 adapter 显式字段**：本文里 Mem0 移除 OSS 图、OpenMemory 归档、Letta V1 与 MemFS 分叉都说明同一项目的“记忆能力”会代际漂移；adapter 应声明自己是否能读派生摘要、是否有事实层、是否有 byte-level locator，而不是让上层猜测。

## 待验证与风险

- Cursor、Windsurf/Devin 的桌面端 transcript 与 compaction 落盘格式未公开，只能确认“存在持久记忆”，不能声明其表结构。
- Roo Code 当前未找到官方的固定 Memory Bank 六文件定义；网上流传的版本不能当作产品内建能力。
- `memories_v2` 的 stage1 与全局 consolidate 是否只在 Codex Desktop 侧运行、CLI 是否同样产出，尚未验证。
- OTel GenAI 的 agent/memory 语义约定状态仍是 Development，属性名可能变化。

## 来源清单

论文：CoALA [2309.02427](https://arxiv.org/abs/2309.02427)、MemGPT [2310.08560](https://arxiv.org/abs/2310.08560)、Generative Agents [2304.03442](https://arxiv.org/abs/2304.03442)、MemoryBank [2305.10250](https://arxiv.org/abs/2305.10250)、Mem0 [2504.19413](https://arxiv.org/abs/2504.19413)、A-MEM [2502.12110](https://arxiv.org/abs/2502.12110)、Zep [2501.13956](https://arxiv.org/abs/2501.13956)、Sleep-time Compute [2504.13171](https://arxiv.org/abs/2504.13171)、Cognee [2505.24478](https://arxiv.org/abs/2505.24478)、LongMemEval [2410.10813](https://arxiv.org/abs/2410.10813)、LoCoMo [2402.17753](https://arxiv.org/abs/2402.17753)。

文档与源码：Letta [MemFS](https://docs.letta.com/concepts/memfs/)、[v1 Block ORM](https://github.com/letta-ai/letta/blob/56ba9c25552605eec89de8ed3dc6394b625c1993/letta/orm/block.py)；Mem0 [how it works](https://github.com/mem0ai/mem0/blob/26cdefb46600/docs/core-concepts/how-it-works.mdx)、[storage.py](https://github.com/mem0ai/mem0/blob/26cdefb46600/mem0/memory/storage.py)、[经典 graph_memory.py](https://github.com/mem0ai/mem0/blob/144627c4ce5b/mem0/memory/graph_memory.py)；Graphiti [edges.py](https://github.com/getzep/graphiti/blob/efc40d21b0af/graphiti_core/edges.py)；LangMem [概念指南](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/)；LangGraph [持久化](https://langchain-ai.github.io/langgraph/concepts/persistence/)；OpenAI Agents SDK [Sessions](https://openai.github.io/openai-agents-python/sessions/)；Cognee [DataPoint.py](https://github.com/topoteretes/cognee/blob/37f788bd2877/cognee/infrastructure/engine/models/DataPoint.py)；Basic Memory [DOMAIN_MODEL](https://github.com/basicmachines-co/basic-memory/blob/0884e204d84a/docs/DOMAIN_MODEL.md)；Memobase [Profile](https://docs.memobase.io/features/profile/profile)；Langfuse [Data Model](https://langfuse.com/docs/observability/data-model)；OTel [gen-ai-spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)、[gen-ai-agent-spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)。
