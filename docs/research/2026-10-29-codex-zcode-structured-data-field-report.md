# Codex 结构化数据实测报告（附 ZCode 源库字段对照）

**日期**：2026-10-29
**目的**：把一次真实会话的 Codex 数据逐字段拆开，再对照本机 ZCode 源库的真实结构，作为后续开发「ZCode 读取」功能的施工依据。
**性质**：实测报告。Codex 与 ZCode 两侧的数字都来自本机只读查询；未测到的内容明确标为「未验证」，不写推测结论。
**相关材料**：`docs/research/2026-10-28-agent-memory-organization-survey.md`（记忆组织方式调研）。单会话看板原型包含个人会话快照，只保留在本机被忽略的 `web/prototype/`。

---

## 1. 结论摘要

1. Codex 一条会话可以稳定拆成 **5 层**：会话元数据、回合、条目（item）、事件/用量记录、上下文快照。前 3 层有稳定的 SQLite 投影；事件/用量与上下文快照需从 rollout 补齐，后者只存在于 `world_state`。
2. 本机 ZCode 源库比现有 adapter 假设的丰富得多：24 张业务表，除 `session` / `turn_usage` / `message` 外，还有 `part`（19.6 万行）、`tool_usage`（2.9 万）、`model_usage`（2.4 万）、`session_target`、`session_task_link`、`session_entry`、`session_input`、`todo`。
3. 现有 ZCode adapter 只读了 3 张表：`session` 9 列、`turn_usage` 5 列，`message` 仅取最新一条的 `role/completed`（另有 id/time 排序字段；`src/harness/zcode/adapter.ts:256`）。**条目正文、工具调用、token 用量、目标、子代理树全部没读**。
4. ZCode 有 9 条 `compaction` part，带 `auto/trigger/phase/reason/preCompactTokenCount`，但 `session.time_compacting` 全空、没有摘要正文。能力声明应区分「compaction 元数据」与「compaction 摘要文本」。
5. ZCode 有 `session.project_id`（1021 个会话全有值），与 Codex 的 `threads.project_id` 全空形成对照——项目维度在 ZCode 侧是可用的一等分组键。

**组织方式**：主轴应是「harness → 项目/工作区 → 会话/线程 → 回合 → 条目/part」，而不是把整段会话塞进一张表。项目是可选分组维度（ZCode 本机 96 个项目、Codex 样本未关联项目），`cwd`、git 信息、agent/工作流树是正交维度。会话日志与派生记忆必须分层：Codex 的 `stage1_outputs`/`memory_summary.md` 是摘要视图，不是会话主表；本机两侧样本都没有把向量字段当作会话组织主键，语义检索应作为后续派生索引，不应先改变 `(harness_id, native_session_id)` 身份。

---

## 2. 实测环境与方法

- 只读访问：Codex 用 `sqlite3 -readonly` / `DatabaseSync({readOnly:true})`；ZCode 同样只读，未打开写事务。
- 两条数据链同时读取：SQLite 投影（`state_5`、`thread_history_1`、`memories_v2_1`、`goals_1`）+ 原始 rollout JSONL（字节级回源）。
- Codex 样本：thread `01a18149-38ba-70a3-87ab-c87cc5079670`（cwd `~/Documents/workspace/ops`，主题为 One Memory 调查），6 回合、144 条目、545 行 rollout。
- ZCode 样本：`~/.zcode/cli/db/db.sqlite`，913,649,664 字节；同目录 WAL 4,692,712 字节；`journal_mode=wal`；最近迁移 `0024_session_database_identity`，`app_version=0.16.9`；会话时间跨度 2026-06-15 → 2026-10-28。
- 注意：两个库都在使用中，行数会增长；下文数字为核验时点快照。

---

## 3. Codex 侧实测

### 3.1 五个数据层

| 层 | 载体 | 本样本规模 | 说明 |
|---|---|---|---|
| 会话 | `state_5.threads` | 1 行 / 43 列 | 标题、cwd、模型、来源、权限、token 总数 |
| 回合 | `thread_history_1.thread_turns` | 6 行 / 14 列 | 状态、时长、字节区间、首尾 item |
| 条目 | `thread_history_1.thread_items` | 144 行 / 10 列 | `item_json` 按类型分型 |
| 事件与用量 | rollout `event_msg` / `token_usage_record` | 237 + 75 行 | 事件流 + 逐请求用量 |
| 上下文快照 | rollout `world_state` / `thread_settings_applied` | 1 份 / 23.7KB，18 键 | 当时生效的 AGENTS.md、技能、权限、环境 |

原始文件：545 行 / 3,358,422 字节，`compacted` 行 0 条。

### 3.2 会话级（`threads`）

分组列出可提取字段（本样本的取值只列关键项）：

| 组 | 字段 |
|---|---|
| 身份 | `id`、`rollout_path`、`source=vscode`、`thread_source=user`、`originator=Codex Desktop`、`cli_version`、`creator_user_id`、`creator_account_id` |
| 展示 | `title`、`name`、`first_user_message`、`preview` |
| 时间 | `created_at(_ms)`、`updated_at(_ms)`、`recency_at(_ms)`、`archived_at`(空) |
| 执行 | `model_provider=magpie`、`model=group/gpt-6-luna`、`reasoning_effort=high`、`sandbox_policy`、`approval_mode=never`、`memory_mode=enabled`、`history_mode=paginated` |
| 统计 | `tokens_used=4,030,282`、`has_user_event`、`is_pinned`、`archived` |
| 工作区 | `cwd`、`git_sha`/`git_branch`/`git_origin_url`（三者本样本为空：ops 非 git 仓） |
| 归属 | `project_id`(空)、`thread_section_id`(空)、`section_position`(空) |
| 代理 | `agent_nickname`/`agent_role`/`agent_path`（空）、`attached_thread_parent_id`（空） |

### 3.3 回合级（`thread_turns` + task 事件）

- 表字段：`thread_id`、`turn_id`、`root_turn_id`、`rollout_ordinal`、`status`、`error_json`、`started_at`、`completed_at`、`duration_ms`、`first_user_item_id`、`final_agent_item_id`、`rollout_byte_offset`、`rollout_end_ordinal`、`rollout_end_byte_offset`。
- rollout `task_started` 加：`turn_attribution.turn_trigger`（本样本全为 `composer`）、`model_context_window=996,147`、`collaboration_mode_kind=default`。
- rollout `task_complete` 加：`time_to_first_token_ms`、`last_agent_message`。
- 本样本 6 回合全部 completed；时长 80.1s / 62.2s / 15.8s / **1428.3s** / 71.9s / 244.1s；TTFT 9.4s / 10.5s / 15.1s / 30.4s / **71.1s** / 35.0s。
- `rollout_byte_offset → rollout_end_byte_offset` 可以按回合切出原始 JSONL 片段（本样本 171KB / 58KB / 1.35MB / 425KB / 1.07MB / 119KB）。

### 3.4 条目级（`thread_items.item_json`）

信封字段：`thread_id`、`turn_id`、`item_id`、`rollout_ordinal`、`created_at_ms`、`item_type`、`item_json`、`updated_at_ordinal`、`started_at_ms`、`completed_at_ms`。

本样本 144 条：`commandExecution` 66、`reasoning` 42、`agentMessage` 30、`userMessage` 6。

| 类型 | 字段 | 实测注意 |
|---|---|---|
| `userMessage` | `id, clientId, content[]` | `content` 是 part 数组：`text` / `image`；本样本 2 条含 `image`，且消息里混有 ambient UI state、browser comment、appshot 文本块 |
| `agentMessage` | `id, text, phase, memoryCitation, delivery, questions` | 后三个字段可能为 null；本样本 `phase=commentary` |
| `reasoning` | `id, summary[], content[]` | 本样本 42 条：31 条有明文 `summary`，11 条 `summary`/`content` 均为空（只剩加密内容），展示时不能把后者当解析失败 |
| `commandExecution` | `id, command, cwd, source, status, commandActions, aggregatedOutput, exitCode, durationMs, processId, pluginId, scriptPath` | 66 条命令 64 条 exit 0、2 条 exit 1；总耗时 316.5s；输出最大 34KB |

### 3.5 事件与用量

- rollout 行长类型：`event_msg` 237、`response_item` 225、`token_usage_record` 75、`turn_context` 6、`session_meta` 1、`world_state` 1。
- `response_item`：`function_call` 71、`function_call_output` 71、`reasoning` 42、`message` 41。
- 工具名：`exec_command` 66、`write_stdin` 5。
- `event_msg`：`item_completed` 144、`token_count` 75、`task_started` 6、`thread_settings_applied` 6、`task_complete` 6。
- `token_usage_record` 字段：`thread_id, turn_id, session_id, root_turn_id, response_id, usage, turn_token_usage, thread_token_usage`。
- 本样本合计：input 4,009,728；cached input 3,710,066（92.5%）；cache write 0；output 20,554；reasoning 8,378；total 4,030,282；`model_context_window` 996,147。

### 3.6 上下文快照（最容易被漏掉）

`world_state.state` 的 18 个键：`agents_md`、`apps_instructions`、`collaboration_mode`、`context_window_guidance`、`environments`、`environments_instructions`、`git_attribution`、`host_skills`、`managed_developer_instructions`、`model`、`model_catalog`、`multi_agent_mode`、`multi_agent_usage_hint`、`permissions`、`persistent_mode`、`plugins_instructions`、`realtime`、`skills`。

其中：`agents_md` 是本会话实际生效的 AGENTS.md 全文；`host_skills` 21.5KB（技能清单正文）；`permissions.approved_command_prefixes=[["ego-browser"]]`；`environments` 含 `cwd/shell/current_date/timezone/filesystem roots`。

`thread_settings_applied` 另给：`service_tier`、`approvals_reviewer`、`permission_profile`、`active_permission_profile`、`runtime_workspace_roots`、`reasoning_summary`、`personality`、`collaboration_mode`。

### 3.7 本样本的空值与缺失（同样是字段信息）

`git_sha`/`git_branch`/`git_origin_url` 空；`project_id` 空；`thread_section_id` 空；`agent_*` 空；`attached_thread_parent_id` 空；`thread_attachments` 0 条（图片在消息 content 里）；`thread_spawn_edges` 0；`thread_goals` 无记录；`stage1_outputs` 无行（`memory_mode=enabled` 但记忆管线尚未处理）；`compacted` 行 0。

### 3.8 读 Codex 数据的三个坑

1. **图片是 base64 data URL**：两条消息分别是 702,614 / 891,878 字符的 `data:image/png;base64,...`，直接入库会撑爆存储；必须先解出二进制、按大小设上限，再存引用。
2. **推理可能只有密文**：`reasoning` 的 `summary`/`content` 为空不代表解析失败，UI 要能区分「无明文」与「缺数据」。
3. **`item_json` 是条件 schema**：同一 `item_type` 的字段集合会随功能演进（本样本 `agentMessage` 多出 `delivery`/`questions`），不能按固定列建模。

---

## 4. ZCode 侧实测

### 4.1 库规模与表清单

24 张业务表（另有 `sqlite_sequence` 内部表）；关键表行数（核验时点）：

| 表 | 行数 | 作用 |
|---|---:|---|
| `session` | 1,021 | 会话主表 |
| `message` | 50,733 | 消息（`data` 为 JSON 文本） |
| `part` | 196,040 | 消息分段正文/工具/推理/文件/压缩 |
| `turn_usage` | 1,349 | 回合状态、时长、TTFT、token、工具计数 |
| `tool_usage` | 28,776 | 单次工具调用与结果元数据 |
| `model_usage` | 24,290 | 单次模型请求的 provider/model/usage |
| `session_entry` | 11,625 | 运行时事件（checkpoint、权限、目标校验、命令事实） |
| `session_input` | 1,802 | 用户输入队列（startNow/guide/queue） |
| `todo` | 1,990 | 会话级待办 |
| `session_target` | 31 | 目标（objective/budget/进度） |
| `session_task_link` | 140 | 子代理/工作流会话树 |
| `permission` | 0 | 空表；权限实际在 `session.permission` JSON |
| `input_history` | 100 | 输入历史 |

### 4.2 `session`（会话主表，27 列）

除 fixture 已知的 `id/project_id/workspace_id/parent_id/slug/directory/path/title/version/time_*` 外，实测还有：

`share_url`、`summary_additions`、`summary_deletions`、`summary_files`、`summary_diffs`、`revert`、`permission`（JSON，如 `{"mode":"yolo"}`）、`task_type`（interactive / fork）、`title_source`（default/first_input/generated/custom）、`title_message_id`、`time_title_updated`、`trace_id`、`time_deleted`、`last_outcome`（本样本 `completed`）。

**与 Codex 的关键差异**：`project_id` 非空（本机 1021 个会话均有项目归属），可直接做项目维度分组；`summary_diffs` 在本机全空，不能当文件改动来源。

### 4.3 `turn_usage`（回合，26 列）

`turn_id`、`trace_id`、`user_message_id`、`status`（running/completed/error/cancelled）、`started_at`、`first_model_start_at`、`first_token_at`、`completed_at`、`duration_ms`、`time_to_first_token_ms`、`model_request_count`、`model_retry_count`、`tool_call_count`、`tool_error_count`、`input_tokens`、`output_tokens`、`reasoning_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`computed_total_tokens`、`retryable`、`cancelled_by_user`、`context_exceeded`、`error_type`、`error_code`。

实测分布：completed 1,209 / cancelled 65 / error 75（running 0）。

### 4.4 `message`（消息）与 `part`（分段）

`message.data` 实测字段：`role`、`time.created/completed`、`parentID`、`modelId`、`providerId`、`mode`、`planEnabled`、`agent`、`path.cwd/root`、`cost`、`tokens.{total,input,output,reasoning,cache.read/write}`、`finish`、`semantics.{origin,kind,uiVisibility}`、`contextSnapshot`、`tools`、`modelSelection`。

角色分布：assistant 44,182 / user 6,551（没有 developer 角色，系统指令在 `contextSnapshot` 里）。

`part.data` 按 `type` 分型，实测分布与字段：

| `part.type` | 行数 | 字段 |
|---|---:|---|
| `tool` | 51,989 | `callID, tool, state` |
| `step-start` | 43,475 | `type` |
| `step-finish` | 43,154 | `reason, cost, tokens` |
| `text` | 28,562 | `text, time` |
| `reasoning` | 28,114 | `text, time` |
| `timeline` | 707 | `timelineType, display, status, fromModel, toModel, fromModelSelection, toModelSelection, time` |
| `file` | 30 | `mime, filename, url, source, metadata` |
| `compaction` | 9 | `auto, trigger, phase, compactReason, operationId, timelineStatus, timelineDisplay, replace, reason, attempt, preCompactTokenCount, time` |

`compaction` 实测样例：`auto=false/true`、`trigger=manual|auto`、`phase=standalone_turn|pre_request|mid_turn`、`preCompactTokenCount` 12.7 万–35.8 万、`replace=true`。但 **`session.time_compacting` 全空，且 part 里只有元数据、没有摘要正文**。

### 4.5 工具、模型用量、输入、待办、目标、子代理

- `tool_usage`：`tool_name`、`tool_call_id`、`status`、`exit_code`、`output_bytes/stdout_bytes/stderr_bytes`、`truncated`、`duration_ms`、`time_to_first_output_ms`、`approval_status`、`read_only`、`destructive`、`retry_count`、`error_type/error_code/error_message`。工具分布：Bash 15,777 / Edit 4,904 / Read 4,340 / Write 1,108 / TodoWrite 1,023 / WebFetch 348 / Agent 286 / Skill 234 / `mcp__node_repl__js` 226。
- `model_usage`：`logical_request_id`、`attempt_index`、`provider_id`、`model_id`、`variant`、`agent`、`mode`、`task_type`、`status`、`finish_reason`、token 四件套、`duration_ms`、`time_to_first_token_ms`、`tool_call_count`。provider 分布：bigmodel 系列合计约 2.4 万。
- `session_input`：`kind`（sendText 1,702 / backgroundNotification 81 / sendGoalCommand 17 / compact 2）、`delivery`（startNow/guide/queue）、`status`（admitted/promoted/cancelled/discarded/failed）、`payload`。
- `todo`：completed 1,797 / in_progress 77 / pending 116，按 `position` 排序。
- `session_target`：`objective`（长文本目标）、`status`、`token_budget`、`tokens_used`、`time_used_seconds`、`summary_title`、`active_input_id`。
- `session_task_link`：`role`（本机 140 条全为 `workflow_actor`）、`depth`、`path`、`phase`、`label`、`agent_type`、`model`、`status`，用于子代理/工作流树。
- `session_entry`：`type` 含 `runtime/workspace_checkpoint`(8,966)、`runtime/model_selection`(1,021)、`runtime/execution_state`(783)、`runtime/bash_shell_selection`(666)、`runtime/user_input_auto_resolution`(74)、`target_completion_verification`(70)、`v4/command_fact`(30)、`runtime/permission_full_access`(14)。

---

## 5. Codex ↔ ZCode 字段对照

| 层 | Codex | ZCode 对应 | 状态 |
|---|---|---|---|
| 会话 | `threads`（43 列） | `session`（27 列） | ZCode 多 `project_id`、`permission`、`last_outcome`、`summary_*`；少 `tokens_used`（在 turn 上） |
| 回合 | `thread_turns` + task 事件 | `turn_usage`（26 列） | ZCode 已含 TTFT、token、工具计数、error 分类 |
| 条目 | `thread_items.item_json` | `message` + `part` | ZCode 拆成两层，part 类型更细（step-start/step-finish/timeline/file/compaction） |
| 工具调用 | `commandExecution` / `mcpToolCall` | `tool_usage` + `part.type='tool'` | ZCode 有独立表，含 exit/bytes/approval/truncated |
| 用量 | `token_usage_record` / `token_count` | `model_usage` + `turn_usage` token 列 | 两边都有逐请求与逐回合 |
| 上下文快照 | `rollout.world_state` | `message.contextSnapshot` + `session_entry(runtime/*)` | ZCode 存在消息级 JSON 里，需要抽取 |
| 记忆摘要 | `memories_v2.stage1_outputs` | 无对应表；只有 `compaction` part 元数据 | ZCode 无 stage1 式摘要 |
| 目标 | `goals_1.thread_goals` | `session_target` | ZCode 字段更全（budget/进度/active_input） |
| 子代理 | `thread_spawn_edges` + `source` 里的 subagent | `session_task_link` + `session.parent_id` | ZCode 有显式树与 role/depth |
| 项目 | `threads.project_id`（本机全空） | `session.project_id`（全有值） | ZCode 可直接按项目分组 |
| 压缩 | `compacted` 行 / replacement_history | `part.type='compaction'`（9 条，仅元数据） | 两边都没有可展示的摘要正文 |

---

## 6. 现有 ZCode adapter 的覆盖与缺口

现状（`src/harness/zcode/adapter.ts`）：

- 能力清单只有 `session.list`、`turn.read`（`:128`），明确不声明 summary/evidence。
- 只查询三处：`session` 9 列（`:256`）、`turn_usage` 5 列（`:261`）、`message` 取每会话最新一条的 `role/completed`（`:265-273`）。
- 映射输出：thread 的 `title/workspace/nativeGroup(task_type)/status`、turn 的 `status/startedAt/endedAt`、`task_type='fork'` 的 lineage（`:455-505`）。
- 对非法 `message.data` 已有 anomaly 降级（`:419`），对未知 turn status 也降级（`:419-430`）。

缺口（按开发顺序）：

1. **会话字段**：`project_id`、`workspace_id`、`path`、`permission`、`title_source`、`last_outcome`、`time_deleted`、`summary_*`、`share_url`、`trace_id`。
2. **回合字段**：`duration_ms`、`time_to_first_token_ms`、`input/output/reasoning/cache_* tokens`、`tool_call_count`、`tool_error_count`、`model_request_count`、`retry/error` 分类。
3. **条目**：`message` + `part` 全量（text/reasoning/tool/file/timeline/compaction），按 `message.sequence`、`part.sequence` 排序。
4. **工具与模型用量**：`tool_usage`、`model_usage` 直接建读面，不必再从 part 反推。
5. **目标与子代理**：`session_target`、`session_task_link`（含 depth/role/agent_type/model）。
6. **运行时事件**：`session_entry` 的 checkpoint / execution_state / permission / target_completion_verification。
7. **输入队列**：`session_input`（引导、排队、后台通知），对应 Codex 的 `queued_items`。

---

## 7. 开发建议

### 7.1 读面分层（每层独立 capability）

- `session.list`（已有）：session 表。
- `turn.read`（已有）：turn_usage 表，补全计数字段。
- `item.read`（新增）：message + part，支持按 turn 聚合。
- `tool.read`（新增）：tool_usage。
- `usage.read`（新增）：model_usage + turn_usage token 列。
- `goal.read`（新增）：session_target。
- `lineage.read`（新增）：session_task_link + session.parent_id。
- `context.read`（新增）：message.data.contextSnapshot、session_entry 的 runtime/*。
- `summary.read`（**不新增**）：没有摘要正文；只可声明 `compaction.metadata`。

### 7.2 增量扫描

现有 watermark 取 `max(session.time_updated)`，而正文追加发生在 `message`/`part`。建议把指纹扩展为多个水位：

```
watermark = max(
  max(session.time_updated),
  max(turn_usage.completed_at),
  max(message.time_updated),
  max(part.time_updated),
  max(tool_usage.completed_at),
  max(model_usage.completed_at)
)
```

否则「会话更新时间未变、但新 part 落库」的窗口会漏读。指纹仍用 `sessions|turns|parts|watermark` 组合，避免仅靠时间戳。

### 7.3 性能与安全

- `part` 已 19.6 万行、库 913MB；避免每次全表 `ROW_NUMBER()`。可先按 `(session_id, time_created)` 取每会话最新 message，再对该会话拉 part。
- 所有 JSON 列（`message.data`、`part.data`、`session_input.payload`）继续用 `json_valid` 守卫，坏行降级为 anomaly，不中断整轮。
- `part.type='file'` 的 `url` 可能是内嵌数据（与 Codex 图片同类）；按大小上限截断或只存引用。
- 914MB 库 + 4.7MB WAL：只读连接下 WAL 仍会增长；扫描用短连接、结束即 `close()`（现有实现已如此）。

### 7.4 状态映射

`turn_usage.status` 四值可直接映射：`completed → completed`、`error → failed`、`cancelled → interrupted`、`running → inProgress`。未知值保持现有 anomaly 策略，不猜测。

---

## 8. 验收清单（可直接落 issue）

- [ ] `probe.ts` 增加 `part`、`tool_usage`、`model_usage`、`session_target`、`session_task_link` 的存在性与关键列检查；缺表时按能力降级而不是整源失败。
- [ ] `ZCODE_MAPPER_VERSION` 升级；旧水位数据触发一次全量重建。
- [ ] fixture 扩展上述表，覆盖：坏 JSON、未知 status、compaction 元数据、工具错误、目标、子代理链。
- [ ] 单测：同一会话 message+part 顺序稳定；增量只读新增 part；`part.type='file'` 大字段截断。
- [ ] 实测脚本：对真实库跑一次只读扫描，输出 `sessions/turns/items/tools/usage` 计数，与本文第 4 节数字同量级。
- [ ] 文档：更新 adapter capability manifest 与 `docs/architecture/2026-10-25-harness-functional-map.html` 中 ZCode 能力项。

验证命令（只读）：

```bash
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.HOME+"/.zcode/cli/db/db.sqlite",{readOnly:true});console.log(db.prepare("select count(*) n from part").get());'
pnpm test && pnpm typecheck
```

---

## 9. 待验证

- `session.permission` 与空表 `permission` 的关系（谁写、何时写）未确认。
- `session_task_link` 本机 140 条全是 `workflow_actor`，其他 role 是否会出现未验证。
- `compaction` part 的 `replace=true` 是否意味着上下文替换语义（对应 Codex 的 `compacted.replacement_history`）未验证。
- `session_entry` 的 `runtime/workspace_checkpoint` 指向 `zcode-artifact://` 快照，其取用方式未验证。
- ZCode 是否有类似 `memories_v2` 的跨会话记忆管线，本次未在库内找到对应表。

---

## 附：本次会话产出的本地资产

`web/prototype/` 是包含个人会话内容的本地原型目录，已加入 `.gitignore`，不纳入版本控制。

| 资产 | 路径 |
|---|---|
| 单会话全量看板（A/B/C 三态） | `web/prototype/2026-10-28-session-kanban.html` |
| 快照刷新脚本（只读） | `web/prototype/export-session-snapshot.mjs` |
| 对话截图资产 | `web/prototype/assets/01a18149-img-*.png` |
| 记忆组织方式调研 | `docs/research/2026-10-28-agent-memory-organization-survey.md` |
