# Codex Goal、Workflow、ACP 与 CodexHost 研究

> 归档说明（2026-10-21）：本文写作时 V1 仍是需求真相源，文中 R 编号与 `docs/REQUIREMENTS.md` 链接指 V1 需求。V1 已归档到 [`docs/archive/REQUIREMENTS-v1.md`](../archive/REQUIREMENTS-v1.md)；V2 需求见 [`docs/REQUIREMENTS.md`](../REQUIREMENTS.md)，V2 不再使用 R 编号。本文保留为调研记录，不代表 V2 的现行语义。

> 调研日期：2026-10-21（Asia/Shanghai）
>
> 范围：Codex 官方能力、Agent Client Protocol、`BytePioneer-AI/codex-host`、`@linxin666/dsh-client-ui-task-board`，以及它们对 taskboard 的架构启示。
>
> 证据标记：**一手**指 OpenAI/ACP 官方文档或规范，或项目自身源码；**推断**指基于已读材料作出的架构判断；**未验证**指尚未经过真实运行或协议探针确认。

## 结论

1. **Codex 已有正式的原生 goal 能力，但它不是 taskboard goal loop 的现成替代品。** `/goal` 能跨多轮持续工作，并有 pause/resume/clear/edit；app-server 也暴露 `thread/goal/*` 持久状态。但当前 taskboard Codex adapter 走 `codex exec --json`，官方文档没有给出在该命令上直接设置 native goal 的 flag，必须另行验证或迁移到 app-server。taskboard 仍需保留总墙钟、token/轮次、取消、验收和审计边界。
2. **“Dynamic workflow”不是当前 OpenAI 官方文档中的具名产品能力。** 官方已有 skills、plugins、subagents、Goal mode 和 Scheduled tasks；官方把 skill 称为“可复用 workflow 的 authoring format”，但没有公开一套 deterministic saved-workflow catalog/invoke/run API。`DannyMac180/skills` 的 `codex-dynamic-workflows` 是社区 skill，只指导 agent 生成 orchestration artifact、调用 goal/subagent（若可用）并验证，不是 daemon 或 workflow runner。
3. **Scheduled tasks 是正式能力，但不能取代 taskboard cron。** Desktop scheduled task 依赖 ChatGPT/Codex app 持续运行和本机项目，Web 任务又不能直接使用本地目录；CLI/IDE 没有 Scheduled 管理面。事件触发仅在 Web/mobile 的 Gmail、Slack、GitHub 场景提供。已读 app-server 文档也没有公开 scheduled-task CRUD 协议。
4. **ACP 适合作为 session/turn/stream/tool/permission 的统一传输层之一，不适合作为 taskboard 的完整领域协议。** ACP 是 JSON-RPC 2.0 的 editor/client 与 coding-agent 互操作标准，定义了 initialize、session、prompt、update、tool call、permission、cancel、resume/close 等；但不定义 goal、workflow catalog/invoke、schedule、run budget、task ledger、验收结论或证据充分性。
5. **CodexHost 是第一方之外的第三方 Desktop 编排层，不是 OpenAI 项目。** 它通过 CDP/Electron Inspector 扩展 Codex Desktop，在官方 app-server 前加 CLI Shim；每个 Harness 优先走原生 SDK/RPC，必要时才 fallback 到 ACP。其 `HarnessAdapter/HarnessSession`、Host 独占身份映射、交互生命周期和 delegation 语义值得借鉴，但 Desktop 绑定、Cordis/Renderer、大型 host-runtime 和 LGPL-3.0-only 代码不适合直接并入 taskboard。
6. **`@linxin666/dsh-client-ui-task-board` 是 DSH Web/Desktop 的单 Harness 看板插件，和 codexhost、taskboard 都没有代码复用关系。** 它自己实现 Host 权威账本、cron、DSH session 执行和 goal 验收门，架构上与 taskboard 平行，适合借鉴“运行前校验 composition”“只复用 idle session”“拦截 goal complete 并要求证据”等做法。
7. **建议 taskboard 把领域层和 harness transport 层分开。** taskboard 保留 ledger、cron、run 状态机、预算、取消、审计、验收和策略；adapter 负责 inspect、session create/resume、turn、stream、tool/approval、native goal 和 native workflow invocation；ACP 只作为可选 transport，不能把所有差异塞进 `_meta` 后宣称“ACP 统一完成”。
8. **“taskboard 下发任务时让 harness 使用自己的 workflow；jev 只按 harness/workflow registry 预选”方向可行，但不是当前结构的直接改名。** 需要把现在的 `TaskWorkflow {name,args}` 扩展为带 `harnessId/workflowId/version-or-digest/invocationMode/capabilities` 的 descriptor，并在 createRun 时冻结。若 harness 仍靠 prompt 要求模型自行调用工具，应标记为 `prompt-mediated`，不能和原生 workflow API 视为同一确定性级别。

## 证据

### 1. Codex 当前官方能力

#### 1.1 Goal、续跑和 loop

**一手：`/goal` 是正式产品能力。** 官方文档说明，`/goal <objective>` 会设置一个 durable objective，Codex 可跨 turns、连续工作数小时；`/goal` 可查看状态，`/goal pause|resume|clear|edit` 可控制目标。目标文本同时是第一轮 prompt 和完成标准。[Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals.md)

官方明确说 goal 不扩大权限：“Starting a goal doesn't grant ChatGPT broader access”，仍沿用 sandbox/approval policy，遇到需要决策会暂停。[Long-running work](https://learn.chatgpt.com/docs/long-running-work.md) 因此 native goal 是**执行连续性**能力，不是授权提升机制。

`/goal` 已覆盖 Desktop app、CLI 和 IDE；若命令未出现，可通过 `features.goals = true` 或 `codex features enable goals` 启用。[Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals.md)、[Developer commands](https://learn.chatgpt.com/docs/developer-commands.md)

**一手：app-server 暴露持久 goal API。**

| 方法/字段 | 已确认行为 |
|---|---|
| `thread/goal/set` | 设置 thread goal，并发出 `thread/goal/updated` |
| `thread/goal/get` | 读取当前 goal |
| `thread/goal/clear` | 清除 goal，并发出 `thread/goal/cleared` |
| `objective` | 非空，最多 4,000 字符 |
| `status`、`tokenBudget` | 可更新 |
| `tokensUsed`、`timeUsedSeconds` | 随 goal 返回 |

来源：[Codex app-server](https://learn.chatgpt.com/docs/app-server.md)

上述 API 明确说明管理的是“与 TUI `/goal` 相同的持久 goal state”。但已读 app-server 文档只说明状态管理，没有完整定义“set goal 后是否自动开启下一 turn、哪些状态构成业务成功”的客户端契约。**未验证：** app-server 接入下的 continuation 时序、终态事件、pause/block 语义，应以真实 JSON-RPC 探针确认。

**一手：loop 也可以由调用方驱动，而不是 native goal。**

- `codex exec --json` 输出 JSONL；事件包括 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.*`、`error`。[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)
- `codex exec resume <SESSION_ID>` 可继续已有非交互会话；`codex exec fork` 可从保存的 session 派生新 session；`--worktree` 可创建 managed Git worktree。[Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)、[Developer commands](https://learn.chatgpt.com/docs/developer-commands.md)
- TypeScript SDK 的 `thread.run()` 可重复调用，也可 `resumeThread(threadId)`；Python SDK 控制本地 Codex app-server。[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk.md)

这说明“多轮 loop”至少有两种层级：

1. **harness-native continuation**：`/goal` / app-server goal，由 Codex 自己决定继续。
2. **caller-controlled continuation**：taskboard 或 SDK 根据外部判断发下一次 `resume`，与 taskboard 当前 goal loop 同类。

两者不能混称。当前 taskboard Codex adapter 是第二种：`codex exec --json` + `codex exec resume`，不是 native goal。[`src/codex-adapter.ts`](../../src/codex-adapter.ts)、[V1 R28](../archive/REQUIREMENTS-v1.md)

#### 1.2 Dynamic workflow、skills 和 subagents

**一手，负向证据：** 截至 2026-10-21 抓取的官方文档索引中，有 Goal、Subagents、Scheduled tasks、Skills & Plugins，但没有名为 “Dynamic Workflows” 的 Codex 产品页。[ChatGPT/Codex docs index](https://learn.chatgpt.com/llms.txt)

官方确实使用 “workflow” 一词，但含义主要是：

- **Skill**：“A skill is a reusable workflow that gives ChatGPT or Codex task-specific guidance”；打包 `SKILL.md`、资源、可选脚本；可按描述隐式触发或用 `$skill` 显式选择。[Skills & Plugins](https://learn.chatgpt.com/docs/skills-and-plugins.md)、[Build skills](https://learn.chatgpt.com/docs/build-skills.md)
- **Subagent workflow**：Codex 派生并行 agents，等待并汇总结果；本地客户端默认可在直接请求或适用 `AGENTS.md`/skill 指令下触发。[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)
- **Scheduled task + skill**：用 skill 固化重复动作，由 schedule 触发。[Scheduled tasks](https://learn.chatgpt.com/docs/automations.md)

这些能力可组合出 workflow，但已读官方文档没有提供“注册一个保存的 workflow，再由客户端按稳定 workflow ID 调用并读取 run ID”的公开核心协议。**推断：** “官方支持 workflow”只能按上述组合能力表述，不能据此宣称存在 ZCode `CreateWorkflow` 的 Codex 等价物。

**源码证据：社区 `codex-dynamic-workflows` 不是 runner。** 该 MIT skill 要求 agent：

1. 起草 `.workflow/<slug>/plan.md`、`state.json`、`orchestration.md`；
2. 仅在用户明确请求且当前工具支持时创建 goal；
3. 环境允许时才 spawn subagent，否则本地分 pass；
4. 汇总、验证并保存 recipe。

它还明确要求：“Do not claim that a local script can call subagent tools unless the current environment exposes such a runner.” 来源：[SKILL.md](https://raw.githubusercontent.com/DannyMac180/skills/main/codex-dynamic-workflows/SKILL.md)、[README](https://raw.githubusercontent.com/DannyMac180/skills/main/README.md)

**结论边界：** “官方没有 Dynamic Workflows 产品”是基于官方索引和页面的负向检索，不应写成绝对不存在；更准确的表述是“截至调研日，未在官方资料中发现该具名能力”。

#### 1.3 Scheduled tasks / automation

**一手：** OpenAI 当前正式名称是 Scheduled tasks，归在 Automations 文档下。

| 界面 | 已确认边界 |
|---|---|
| Desktop app | 可跑本地项目或隔离 worktree；要求电脑开机、app 运行、项目仍在磁盘 |
| Web | 可用上传文件、连接器、skills/plugins；不能直接使用本机文件夹 |
| CLI | 没有 Scheduled 管理界面 |
| IDE extension | 没有 Scheduled 管理界面 |
| Event trigger | Gmail、Slack、GitHub 事件仅 Web/mobile；不在 Desktop、CLI、IDE |

来源：[Scheduled tasks](https://learn.chatgpt.com/docs/automations.md)

Scheduled tasks 支持 standalone run（每次新 chat）或回到已有 chat；时间计划允许 RRULE。无人值守运行若组织策略允许，使用 `approval_policy = "never"`；管理员可禁止该策略，届时回退到所选权限模式的 approval 行为。[Scheduled tasks](https://learn.chatgpt.com/docs/automations.md)

**负向证据：** 已读 app-server 方法列表覆盖 thread/turn/item、auth、MCP、skills、account 等，但没有发现 scheduled-task 的创建/列表/暂停/删除 API。[Codex app-server](https://learn.chatgpt.com/docs/app-server.md)

**推断：** Scheduled tasks 是 ChatGPT/Codex 产品面的调度能力，不是可嵌入 taskboard 的 programmatic scheduler API；且它只调度 OpenAI surface，不提供跨 ZCode/Codex/其他 harness 的统一调度。

#### 1.4 官方能力边界与缺口

| 问题 | 当前证据 |
|---|---|
| Goal 是否自行验收？ | 否。目标文本兼作完成标准，Codex 达到 stopping condition 后停止；没有证明外部证据被强制校验 |
| Goal 是否获额外权限？ | 否，沿用 sandbox/approval，必要时暂停 |
| `codex exec` 是否支持 native `/goal`？ | 未验证；官方 non-interactive 文档只列出 JSON/ resume/fork/worktree/output schema，没有 goal flag |
| Dynamic workflow 是否有 deterministic runner？ | 官方资料未发现；社区 skill 只指导 agent |
| Scheduled tasks 是否可跨 harness/本地 CLI 管理？ | 未见；CLI/IDE 无管理面，app-server 无公开 CRUD |
| Skills 是否等于 saved workflow？ | 否。Skill 是可复用指令包，可包含脚本；不等于稳定 ID、参数 schema、run ID、终态协议均已定义的 workflow API |

### 2. Agent Client Protocol

#### 2.1 解决的问题与角色

ACP 的官方定位是标准化“code editor”和“coding agent”之间的通信。Agent 通常是 client 启动的子进程；Client 管理环境、用户交互和资源访问。[ACP README](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/README.md)、[ACP overview](https://agentclientprotocol.com/protocol/overview.md)

核心角色：

- **Client**：UI、driver、文件/终端能力宿主、权限审批、elicitation。
- **Agent**：执行模型和工具调用；可通过 Client 提供的 `fs/*`、`terminal/*` 读取/修改/运行，但也可自行执行。

ACP 使用 JSON-RPC 2.0：

- methods：请求/响应；
- notifications：无响应事件；
- 文件路径必须绝对，行号 1-based。

来源：[ACP overview](https://agentclientprotocol.com/protocol/overview.md)

#### 2.2 消息流

**一手：典型 v1 流程。**

1. `initialize`：协商 `protocolVersion` 和双方 capabilities，可返回 auth methods。
2. 必要时 `authenticate`。
3. `session/new` 创建 session；或按能力使用：
   - `session/load` 恢复并 replay 历史；
   - `session/resume` 恢复但不 replay；
   - `session/close` 取消活动工作并释放资源。
4. `session/prompt` 发送 user message。
5. Agent 持续发 `session/update`：message chunks、thought、plan、tool_call/tool_call_update、usage、compaction、config/mode changes 等。
6. 工具需要审批时，Agent 调 Client 的 `session/request_permission`。
7. Client 可发 `session/cancel`。
8. `session/prompt` 最终以 stop reason 返回。

来源：[Initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)、[Session setup](https://agentclientprotocol.com/protocol/v1/session-setup.md)、[Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)

**会话与工具模型：**

- Session 是独立 conversation/history/state 边界；`session/new` 必须返回唯一 `sessionId`。
- Tool call 由 Agent 执行并报告；Client 主要显示、跟随文件位置、提供环境和审批。
- Tool call 有 `pending/in_progress/completed/failed`，内容可含 text、diff、terminal；可带 `rawInput/rawOutput`。
- `session/request_permission` 返回 `selected(optionId)` 或 `cancelled`；选项语义包括 allow once/always、reject once/always。

来源：[Session setup](https://agentclientprotocol.com/protocol/v1/session-setup.md)、[Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls.md)

#### 2.3 版本和兼容性

**一手：** 当前稳定 ACP 协议 major version 是 `1`；wire compatibility 由 `initialize.protocolVersion` 决定，能力通过 capabilities 协商。省略能力一律按不支持处理。[ACP README](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/README.md)、[Initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)

ACP v2 于 2026-07-20 发布为 **Draft**。v2 想要允许 turn 之外的持续更新、稳定 ID patch、结构化 file changes 和更灵活的 permission subject；规范方明确要求 version negotiation + feature flag，不应默认上生产，并建议同时支持 v1。[ACP v2 draft](https://agentclientprotocol.com/announcements/acp-v2-draft.md)

#### 2.4 ACP 能否成为 taskboard 的统一 harness adapter 协议？

**可以统一的部分：**

- 版本/能力协商；
- session create/load/resume/close；
- prompt 和流式 update；
- tool call/update；
- approval/question/elicitation；
- cancel；
- 可选 history、model/session config、usage、compaction。

**ACP 没有统一的部分：**

| taskboard 领域概念 | ACP 现状 |
|---|---|
| 持久 goal 与自动 continuation | 无标准 goal method |
| workflow catalog、invoke、run ID | 无标准 workflow 概念 |
| cron / automation | 无标准 schedule 方法 |
| task/run 状态机与幂等 | 无 |
| 总 wall-clock/token budget | usage update 不是执行预算契约 |
| 验收策略与证据充分性 | 无 |
| 业务成功不等于 prompt stopReason | ACP 的 prompt 完成只代表该 turn 结束 |
| taskboard ledger 与人工确认策略 | 无 |

**推断：** taskboard 应定义自己的领域 `HarnessAdapter`，ACP 只是 `acp-v1` implementation/transport。若把 taskboard 自有语义塞入 `_meta` 或 `_` methods，技术上可行，但只是私有扩展，不能据此宣称其他 ACP peer 兼容。

**一手：Codex 的 ACP 接入不是 OpenAI 第一方协议实现。** ACP 官方 Agent 列表把 Codex CLI 标为通过 `agentclientprotocol/codex-acp` adapter 接入。[ACP Agents](https://agentclientprotocol.com/overview/agents.md)、[codex-acp](https://github.com/agentclientprotocol/codex-acp)

而 Codex 自身有更丰富的第一方 app-server。CodexHost 也明确采用“原生优先，ACP fallback”的策略。因此对 Codex，优先 app-server 比先套 ACP adapter 更有保真度。

### 3. CodexHost

#### 3.1 身份、版本与许可证

**源码/发布证据：**

- canonical repository：`BytePioneer-AI/codex-host`，不是 `openai/codex` 子项目。
- npm canonical CLI：`@codexhost/cli@0.13.3`。
- Node：22 或 24；需要官方 Codex Desktop。
- repository `package.json`：`LGPL-3.0-only`。
- 本文审阅源码 commit：`a8adb78b519a81795fc05b787811f20a9738d7f0`（2026-10-17）。

来源：[GitHub repository](https://github.com/BytePioneer-AI/codex-host)、[npm package](https://www.npmjs.com/package/@codexhost/cli)、[LICENSE](https://raw.githubusercontent.com/BytePioneer-AI/codex-host/main/LICENSE)、[package.json](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/package.json)

注意：npm 上的 `codexhost@0.0.1` 是无仓库、无描述的空壳包，不是本项目。

#### 3.2 架构

CodexHost README 和源码给出的分层：

1. **Desktop 扩展层**：通过 CDP / Electron Inspector 扩展官方 Codex Desktop，不重建聊天 UI。
2. **协议 shim**：CLI Shim 位于官方 app-server 前，原样透传原生 Codex 请求。
3. **Harness 层**：每个 Harness 优先使用原生 SDK/RPC/服务；没有原生接口或确有理由时才 fallback 到 ACP。
4. **Delegation 层**：每次委派创建独立 native session；caller 可 wait 或 background。

来源：[CodexHost README](https://github.com/BytePioneer-AI/codex-host#how-it-works)

核心公共接口：

- `HarnessAdapter.inspect/open/close`
- `HarnessSession.capabilities/initialState/outputs/execute/readSnapshot/close`
- Host 独占 `HostThreadId/HostTurnId/HostItemId` 与 native refs 的映射
- 统一 Item：`agentMessage`、`reasoning`、`contextCompaction`、`commandExecution`、`toolExecution`、`fileChange`、`subagentDelegation`
- 统一 `approval/question` interaction 生命周期
- optional：resume/fork/rollback、commands、usage、subagent、session import、web UI

来源：[`text-session.ts`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/packages/harness-adapter/src/text-session.ts)、[`plugin.ts`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/packages/harness-adapter/src/plugin.ts)

输出不变量：

```text
turn.start accepted
  -> turn.started
  -> item.started/updated/completed
  -> interactions closed
  -> exactly one turn.completed
```

不是“底层 RPC 返回”或“SDK 文本结束”就代表 Agent/工具全部完成。取消请求成功只表示受理，旧 turn 仍需唯一终态。[`output-and-interactions.md`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/.agents/skills/codexhost-add-harness/references/output-and-interactions.md)

Delegation API：

- `delegate start`
- `thread send/cancel/read/wait/list`
- `thread watch`：注册后立即返回，被观察 thread 停止时向另一个 thread 发一次通知

`read/wait/list` 只读，不消费 adapter outputs；busy 明确拒绝，不隐式排队；普通 cancel 保留可 resume 的 session。`thread watch` 对 caller 是事件驱动，但实现内部每轮完成后 2 秒轮询。[`delegation-types.ts`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/packages/host-runtime/src/delegation-types.ts)、[`cross-harness-delegation.md`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/.agents/skills/codexhost-add-harness/references/cross-harness-delegation.md)、[`thread-watch.md`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/docs/architecture/thread-watch.md)

#### 3.3 值得复用的“轮子”

| 设计 | 复用建议 |
|---|---|
| `HarnessAdapter` / `HarnessSession` 职责分离 | 直接借鉴接口边界；taskboard 可做更小的零依赖版本 |
| Host 独占 Thread/Turn/Item ID | 必须借鉴；adapter 只给 native ref，不让原生 ID 泄漏为账本主键 |
| 统一 Item/Update/Outcome | 很适合 taskboard 的日志、UI 和 evidence |
| unique terminal + interaction close | 必须借鉴；比单纯解析 stdout 更完整 |
| capability-gated resume/fork/rollback | 借鉴；不支持时明确 `unsupported`，不伪造 |
| approval/question 生命周期 | 借鉴；适合 taskboard 的人工确认与 agent 提问 |
| delegation `read/wait/watch` | 借鉴语义；watch 内部轮询不是关键，API 对未来终态友好 |
| native-first, ACP-fallback | 强烈建议采用；避免把 ACP 当作所有 Harness 的最低公分母 |

#### 3.4 不宜直接复用的部分

| 部分 | 原因 |
|---|---|
| CDP / Electron Inspector / Renderer 注入 | 绑定 Codex Desktop 和 Electron 内部结构，更新脆弱，不适合 headless daemon |
| Cordis 插件加载器与 Desktop UI 投影 | 与 taskboard 零运行时依赖、小型 daemon 目标冲突 |
| host-runtime、mapping-store、external-thread runtime 整包 | 体量和职责远超 taskboard 当前需求，会和 ledger 形成第二套持久化权威 |
| `CODEXHOST_RUNTIME_ENDPOINT/TOKEN/THREAD_ID` 运行环境 | 服务于 Desktop/远程 Harness 委派，不是 taskboard 当前 CLI adapter 模型 |
| 源码直接拷贝 | LGPL-3.0-only，直接并入/修改会触发许可证和分发审查；先借鉴接口和测试设计 |

**推断：** 最现实的复用方式是把 CodexHost 当成可选的“人类可见 Desktop delegation backend”，而不是 taskboard 的默认 adapter 运行时。如果接入，taskboard 仍应是 task/run 的 system of record，CodexHost 只拥有 native thread/session。

### 4. `@linxin666/dsh-client-ui-task-board`

#### 4.1 身份与职责

**一手/源码：**

- npm：`@linxin666/dsh-client-ui-task-board@0.4.8`
- license：Apache-2.0
- peer：`@deepseek-ai/dsh >=0.2.1-rc.2`
- repository：`zhu1090093659/dsh-web`
- 它是 DeepSeek Harness Web GUI 的 Cordis profile 插件，不是 DSH core、不是 codexhost、不是 taskboard。

来源：[npm](https://www.npmjs.com/package/@linxin666/dsh-client-ui-task-board)、[README.zh](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/README.zh.md)、[package.json](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/package.json)

主要职责：

- Host 权威任务/调度/execution 账本：`$DSH_HOME/task-board/ledger-v2.json`；浏览器只是异步视图。
- Host cron：浏览器关闭后仍执行；错过的触发点不补跑。
- 真实 DSH session：运行前应用 workspace、agent preset、permission、model、thinking。
- 可选 session reuse：只在上一 session 真正 idle 时复用，否则新建。
- 可选 subtasks、cascade、Agent Teams、防 idle sleep。
- 可选 native `/goal`：全局开关和卡片 opt-in 都存在；源码默认关闭，且 `armGoal` 只有 `goalEnabled && task.goalRun === true` 才会武装。
- goal verification：通过 `tools/pre-execute` 拦截 `update_goal(action=complete)`，没有匹配的验收通过记录就不让 complete 生效。

来源：[`host-runner.ts`](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host-runner.ts)、[`host-ledger.ts`](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host-ledger.ts)、[`verification-gate.ts`](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host/verification-gate.ts)

**文档风险：** 该包 README 顶部曾说默认每次武装 `/goal`，但配置表和 `host-runner.ts` 明确默认全局关闭、卡片还需显式 opt-in。本文以源码和配置表为准；这也说明依赖 README 摘要做执行结论是危险的。

#### 4.2 与 CodexHost、taskboard 的关系

| 项目 | 运行位置 | 主要 Harness | 权威状态 | 目的 |
|---|---|---|---|---|
| taskboard | 独立本机 daemon | ZCode、Codex，可扩展 | 自有 ledger | headless 任务调度、自改进、CLI |
| CodexHost | Codex Desktop 扩展 | Codex + 多外部 Harness | Host mapping + native session | 在 Desktop 内统一人类可见 sessions/delegation |
| DSH task board | DSH Web/Desktop 插件 | DSH 单 Harness | `ledger-v2.json` | DSH 内的任务看板与自动化 |

三者没有直接依赖。CodexHost 可以接 DSH 作为 Harness，但 DSH task board 仍是另一个 DSH 插件，不会因此成为 CodexHost 组件。

#### 4.3 值得借鉴、不可直接搬的部分

值得借鉴：

- **运行前 fixture 校验**：workspace/preset/permission 不可用时不发 prompt。
- **idle-only session reuse**：忙或名册未知则新 session，避免把任务发进正在工作的会话。
- **completion gate**：agent 自述不算完成；验收通过前拒绝 `update_goal(complete)`。
- **证据面**：验收读取 agent trajectory、tool output、assistant text，并在可用时加入 Host 侧 workspace changes。
- **异常与质量判定分离**：裁判超时/鉴权失败不应等同工作失败。
- **外部结果记录**：非本 Host 完成的工作可登记 execution outcome，避免“只改列不留记录”。

不能直接搬：

- 依赖 `@deepseek-ai/dsh-*` SDK、Cordis、React、DSH gateway/projection。
- 账本 schema、DSH session 地址、命令派发器和 `update_goal` 工具名都是 DSH 特有。
- `tools/pre-execute` 拦截依赖 DSH 的工具生命周期；Codex app-server 的 goal 不是同一个工具，不能照搬。

### 5. taskboard 当前实现事实

**源码：执行器与运行快照。**

- `ExecutorId = "zcode" | "codex"`；run 创建时读取并冻结 executor。[`src/types.ts`](../../src/types.ts)、[`src/ledger.ts`](../../src/ledger.ts)
- `RunInvocationSnapshot` 冻结 prompt、workspace、executor、execution、maxTurns、verification、team、workflow、resumeSessionId。[`src/ledger.ts`](../../src/ledger.ts)
- Codex adapter 只认 `turn.completed` 为成功终局，`thread.started.thread_id` 为 session anchor，最后 `agent_message` 为 response。[`src/codex-adapter.ts`](../../src/codex-adapter.ts)、[V1 R28](../archive/REQUIREMENTS-v1.md)

**源码：goal 是 daemon loop。**

- Runner 每轮调用 adapter；成功后单独调用 goal judge。
- 默认最多 5 轮，另有总 wall-clock budget；任一触顶则 failed。
- 续跑需要上一轮 sessionId；无 anchor 明确失败。
- 判定器只接收 goal 和上一轮 response 的 8,000 字符摘要。

来源：[`src/runner.ts`](../../src/runner.ts)、[`src/goal-judge.ts`](../../src/goal-judge.ts)

**源码：验收证据也不完整。**

- Verifier 输入同样只有 prompt + response 摘要（8,000 字符），没有结构化 command exit code、file diff、tool output 或 workspace changes。
- verifier transport 异常时当前策略是放行并标 `skipped(transport)`，与 DSH 的“异常不等于质量判定、保持待人工”不同。

来源：[`src/verifier.ts`](../../src/verifier.ts)、[`src/runner.ts`](../../src/runner.ts)

**源码：workflow 是 ZCode 特定。**

- Catalog 只扫 `~/.zcode/workflows/*.dwf.ts`。
- jev 从 catalog descriptions + `plain` 选择，阈值 0.7，结果只是建议。
- `TaskWorkflow` 只有 `{name,args}`；绑定与 `execution`、`team`、`maxTurns` 互斥。
- 执行时 taskboard 生成固定 prompt，要求 agent 使用 `CreateWorkflow`，首行回写 `taskboard:workflow run_id=`。
- Codex × workflow 当前明确拒绝。

来源：[`src/workflow-catalog.ts`](../../src/workflow-catalog.ts)、[`src/workflow-pick.ts`](../../src/workflow-pick.ts)、[`src/workflow-invoke.ts`](../../src/workflow-invoke.ts)、[V1 R21-R23](../archive/REQUIREMENTS-v1.md)、[V1 R28](../archive/REQUIREMENTS-v1.md)

**推断：** 当前 `TaskWorkflow` 不能被称为 harness-neutral。它是“ZCode saved workflow + prompt-mediated invocation”，只是 workflow 名和 args 看起来通用。

## 对 taskboard 的映射

### 1. 建议的职责分界

| 层 | taskboard 应保留 | 应下沉给 harness |
|---|---|---|
| 调度 | cron、手动/cascade trigger、排队、并发、幂等、错过后策略 | 无 |
| 账本 | task/run/turn、状态机、单一写者、审计、取消、确认门 | 无 |
| 预算 | 总 wall-clock、总 token/轮次、超时与最终失败策略 | 单 turn 内连续 reasoning/compaction |
| 策略 | 哪些任务需要 goal、native goal 或 plain | native continuation、pause/resume、goal state |
| Session | 跨 run 的 session anchor 记录与 resume 决策 | create/resume/fork/rollback 的真实实现 |
| Workflow | 注册表聚合、选择、冻结、审计、跨 harness 路由 | workflow 定义、参数校验、实际调用和 run ID |
| 验收 | 何时验、阈值、人工复核、证据保留 | 工具轨迹、command exit、diff、usage 等原始事实 |
| 交互 | 确认门与人工队列 | approval/question 的原生呈现和响应协议 |

原则：**taskboard 拥有业务 truth，harness 拥有 execution truth。**

### 2. Adapter 层应长成什么样

不建议直接把 `zcode-adapter.ts`、`codex-adapter.ts` 改成“ACP adapter”。建议先提取一个更像 CodexHost、但更小的领域接口：

```ts
interface HarnessAdapter {
  readonly id: "zcode" | "codex" | string;
  inspect(input: InspectInput): Promise<HarnessInspection>;
  open(input: Create|Resume|ForkInput): Promise<HarnessSession>;
  close(): Promise<void>;
  workflows?: WorkflowCatalogCapability;
}

interface HarnessSession {
  readonly capabilities: HarnessCapabilities;
  readonly outputs: AsyncIterable<HarnessEvent>;
  startTurn(input: TurnInput): Promise<TurnAccepted>;
  cancelTurn(turnId: string): Promise<void>;
  respondInteraction(input: InteractionResponse): Promise<void>;
  readSnapshot(): Promise<HarnessSnapshot>;
  close(): Promise<void>;
}
```

最小 capability 建议：

- `session.create/resume/fork`
- `turn.start/cancel/steer`
- `interaction.approval/question`
- `goal.native`（set/get/pause/clear，是否支持 continuation）
- `workflow.native`（list/inspect/invoke/status，是否有稳定 run ID）
- `usage.report`
- `compaction`
- `subagents`
- `autonomousTurns`

不支持就返回 `unsupported`，不要伪装成 plain 成功。

### 3. Goal 的建议

**短期：保留当前 daemon goal loop，作为所有 harness 的兼容路径。** 它已有跨 executor 的稳定性、预算和 fail-closed judge，不能在没有 native goal 验证前删除。

**中期：Codex adapter 增加可选 `goal.native` capability。**

- 评估从 `codex exec` 迁到一个长期 app-server adapter；
- 用 `thread/goal/set/get/clear` 管理 goal；
- 订阅 goal update/turn/item/tool events；
- 用 taskboard 的总 wall-clock/token/取消作为外层 fence；
- 完成任务后仍由 taskboard 做最终验收，不能仅凭 goal status=`complete` 判业务成功；
- 如果验收失败，明确记录 harness native goal 已完成但 taskboard run 未通过，并决定 pause/clear/重试策略。

**不要现在断言：** 当前 `codex exec` 能把 `/goal` 当普通文本可靠武装 native goal。这是一个必须实测的协议问题。

**Codex 与 DSH 的关键差异：** DSH task board 能在 `update_goal(action=complete)` 之前拦截；Codex app-server 文档目前没有公开等价的 goal-completion pre-hook。taskboard 能拒绝“把 run 落成 completed”，但是否能阻止 native goal 自己先完成，尚未验证。[Codex app-server](https://learn.chatgpt.com/docs/app-server.md)、[`verification-gate.ts`](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host/verification-gate.ts)

### 4. Workflow registry 与 jev 的建议

建议把 workflow 从“全局 ZCode 名”改为“harness-scoped descriptor”。概念字段：

```ts
interface WorkflowDescriptor {
  harnessId: string;
  workflowId: string;
  displayName: string;
  description: string;
  argsSchema: JsonSchema;
  invocationMode: "native-api" | "native-command" | "prompt-mediated";
  capabilities: {
    stableRunId: boolean;
    cancel: boolean;
    goalCompatible: boolean;
    resume: boolean;
  };
  sourceDigest: string;
}
```

创建 run 时冻结：

- full descriptor digest；
- normalized args；
- harness version/capability snapshot；
- invocation mode；
- plain fallback policy。

这能防止“选的时候是一个 workflow，执行时本地文件已换版本”。

jev 的职责应收窄为：

1. 接收 task summary（通过 state，不拼进 problem text）；
2. 接收 registry 提供的 `harnessId/workflowId + displayName + description`；
3. 输出 opaque registry key 或 `plain`；
4. 不理解 workflow 文件格式、不解析 args、不执行。

**可行性判断：方向可行，但必须分阶段。**

当前就能做：

- 把 `TaskWorkflow` 改成 namespaced key；
- 让 catalog provider 按 executor 聚合；
- 增加 descriptor digest 和 capability；
- jev 只选择候选 ID；
- workflow 与 executor 不兼容时 fail fast。

不能马上宣称完成：

- Codex 官方没有 saved-workflow catalog/invoke API；
- skills/subagents 不能自动映射成 deterministic workflow；
- DSH 的 agent preset/composition 也不是 workflow；
- 如果 invocation 仍是“把 `CreateWorkflow` 指令塞进 prompt”，它仍是 `prompt-mediated`，模型可能不调用、调用错、丢 run ID；
- 不同 harness 的 `plain`、cancel、resume、goal compatibility 语义不同。

### 5. 验收证据应先升级

在当前 judge/verifier 只看 8k response 的情况下，即使换成 native goal，taskboard 仍容易被“回复写得好但工作没做”欺骗。优先做这个升级比立即接 ACP 或 CodexHost 更有价值。

建议 adapter 保留有界事件证据：

| 证据 | 用途 |
|---|---|
| command + cwd + exit code + bounded output | 判断测试/构建是否真的运行并通过 |
| fileChange + unified diff | 判断是否改了目标文件和范围 |
| tool name/args/result | 判断检索/执行步骤是否发生 |
| workspace diff/status | 补足 agent 未正确投影的文件变化 |
| usage/time | 预算与成本 |
| final agent message | 只是结论，不是唯一证据 |

judge/verifier 应接受“目标 + 证据包”，而不是“目标 + response”。证据不足与工作失败应分开记录；验收 transport 异常不应无声放行。

### 6. ACP、CodexHost、DSH 的具体取舍

| 候选 | 建议 |
|---|---|
| ACP | 作为未来通用 adapter 的 transport capability；先做 v1，不默认 v2 Draft；不让 ACP 类型进入 ledger/domain |
| Codex app-server | Codex 的优先 native adapter 方向；先验证 goal/approval/resume 时序 |
| codexhost | 借鉴接口与不变量；如接入，作为可选 Desktop delegation backend，不作为 headless 核心 |
| DSH task board | 借鉴验收门、preflight、idle-only reuse；不搬 DSH SDK/ledger/Cordis |
| 社区 dynamic-workflows skill | 可作为 taskboard 生成“编排 artifact”的 prompt 模板参考；不是执行内核 |

## 风险与未决问题

1. **native goal 的 app-server 语义未实测。** 需要验证：set active 后是否自动开下一 turn；pause/block/complete 如何投影；取消是否保留 goal；tokenBudget 触顶后的终态；进程重启是否恢复 continuation。
2. **`codex exec` 与 native goal 的关系未验证。** 在确认前，不能把 `/goal ...` 字符串当作稳定 API，也不能把 `turn.completed` 直接等价为 goal complete。
3. **Codex 没有公开的 workflow invoke API。** Skills 是 authoring format，不是带 run ID 的 deterministic runner。若 taskboard 自行用 prompt 驱动 skill/subagent，必须标 `prompt-mediated`。
4. **ACP v2 是 Draft。** 生产先支持 v1；若需要 v2 的结构化 file changes/长生命周期 session，必须双版本协商与 feature gate。
5. **ACP 事件不足以直接作为验收证据。** tool call 是否带完整 diff、稳定 turn identity、usage 和 workspace 变更依赖具体 harness；要逐 adapter 建 identity/evidence gate。
6. **codex-acp 是社区 adapter。** 它可能丢 Codex app-server 的原生能力或映射差异；对 Codex native goal，优先 app-server。
7. **CodexHost 是第三方且 LGPL-3.0-only。** Desktop/CDP 耦合、Node 22/24、官方 app 版本依赖、运行环境和服务端协议都不适合直接塞进 taskboard。需要法务/许可证审查后才能复用代码。
8. **CodexHost 的 watch 不是底层事件源。** 对外是一次性通知，内部仍轮询 read；taskboard 不能因此假定所有 harness 有原生 push 终态。
9. **DSH 验收门不可移植。** 它依赖 DSH 的 `tools/pre-execute` 和 `update_goal`；Codex 没有已公开的相同 hook。
10. **Workflow registry 是新的信任边界。** 描述会被送进 jev/模型；需要长度上限、控制字符处理、prompt-injection 提示、descriptor digest 和来源可信声明，不能让任意本地文件伪装成高置信候选。
11. **Workflow 版本漂移。** 仅有 name 无法证明执行的是选择时的定义；至少要 digest，最好有 harness 提供的 stable workflow version/run ID。
12. **Scheduled tasks 不可作为 taskboard scheduler 的通用底层。** 没有公开跨 harness CRUD API，Desktop 需 app 在线，Web 不能访问本地文件夹。
13. **zero-runtime-dependency 约束。** 引入 ACP SDK、Codex SDK、CodexHost runtime 或 DSH SDK 都是架构变化；至少要作为 devDependency、外置可执行，或先改需求并说明理由。
14. **验收策略需产品决定。** 当前 verifier transport failure 会放行；DSH 则保持待人工。两者风险取向不同，不能只改代码不写需求。

## 建议的落地顺序

1. **先做证据层**：adapter 产生结构化 command/file/tool evidence，judge/verifier 接收证据包；补“自述通过但无命令/无 diff”测试。
2. **再抽 HarnessAdapter capability**：保留现有 `zcode|codex` 行为，先把 inspect/open/turn/events/snapshot/interaction 的不变量定清。
3. **做 Codex app-server native-goal spike**：不替换现有 adapter，先验证 continuation、approval、resume、goal terminal 和 budget。
4. **把 workflow catalog 改成 harness-scoped registry**：先适配现有 ZCode catalog，再让 jev 只选 opaque key；Codex 只暴露真实支持的 skills/commands，未证实 workflow 时保持 plain。
5. **最后评估 ACP transport**：至少用两个真实 harness 证明相同语义，再抽共享 ACP client。不要让 ACP 先于领域模型。
6. **CodexHost 仅做可选集成评估**：若目标包含“人类在 Desktop 中查看并接管 session”，再设计 task/run ↔ codexhost thread/delegation 映射；否则不引入。

## 来源

### OpenAI 官方

- [Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals.md)
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work.md)
- [Developer commands / slash commands](https://learn.chatgpt.com/docs/developer-commands.md)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server.md)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode.md)
- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk.md)
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations.md)
- [ChatGPT/Codex documentation index](https://learn.chatgpt.com/llms.txt)
- [Build skills](https://learn.chatgpt.com/docs/build-skills.md)
- [Skills & Plugins](https://learn.chatgpt.com/docs/skills-and-plugins.md)
- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)

### ACP

- [ACP README / stable version](https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/README.md)
- [ACP overview](https://agentclientprotocol.com/protocol/overview.md)
- [Initialization](https://agentclientprotocol.com/protocol/v1/initialization.md)
- [Session setup](https://agentclientprotocol.com/protocol/v1/session-setup.md)
- [Prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn.md)
- [Tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls.md)
- [ACP Agents: Codex via codex-acp](https://agentclientprotocol.com/overview/agents.md)
- [codex-acp](https://github.com/agentclientprotocol/codex-acp)
- [ACP v2 Draft](https://agentclientprotocol.com/announcements/acp-v2-draft.md)

### CodexHost

- [Repository and architecture](https://github.com/BytePioneer-AI/codex-host)
- [npm `@codexhost/cli`](https://www.npmjs.com/package/@codexhost/cli)
- [LICENSE](https://raw.githubusercontent.com/BytePioneer-AI/codex-host/main/LICENSE)
- [`packages/harness-adapter/src/text-session.ts`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/packages/harness-adapter/src/text-session.ts)
- [`packages/harness-adapter/src/plugin.ts`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/packages/harness-adapter/src/plugin.ts)
- [`packages/host-runtime/src/delegation-types.ts`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/packages/host-runtime/src/delegation-types.ts)
- [`packages/host-runtime/src/harness-delegation-coordinator.ts`](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/packages/host-runtime/src/harness-delegation-coordinator.ts)
- [Harness plugin runtime](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/docs/architecture/harness-plugin-runtime.md)
- [Cross-harness delegation](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/.agents/skills/codexhost-add-harness/references/cross-harness-delegation.md)
- [Output and interactions](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/.agents/skills/codexhost-add-harness/references/output-and-interactions.md)
- [Thread watch](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/docs/architecture/thread-watch.md)
- [ACP layer follow-up](https://github.com/BytePioneer-AI/codex-host/blob/a8adb78b519a81795fc05b787811f20a9738d7f0/docs/architecture/acp-layer-follow-up.md)

### DSH task board

- [npm `@linxin666/dsh-client-ui-task-board@0.4.8`](https://www.npmjs.com/package/@linxin666/dsh-client-ui-task-board)
- [README.zh](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/README.zh.md)
- [package.json](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/package.json)
- [`host-runner.ts`](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host-runner.ts)
- [`host-ledger.ts`](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host-ledger.ts)
- [`verification-gate.ts`](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/src/host/verification-gate.ts)

### 社区 skill

- [`codex-dynamic-workflows/SKILL.md`](https://raw.githubusercontent.com/DannyMac180/skills/main/codex-dynamic-workflows/SKILL.md)
- [`DannyMac180/skills` README](https://raw.githubusercontent.com/DannyMac180/skills/main/README.md)

### taskboard 本地源码

- [`package.json`](../../package.json)
- [`src/types.ts`](../../src/types.ts)
- [`src/ledger.ts`](../../src/ledger.ts)
- [`src/runner.ts`](../../src/runner.ts)
- [`src/codex-adapter.ts`](../../src/codex-adapter.ts)
- [`src/goal-judge.ts`](../../src/goal-judge.ts)
- [`src/verifier.ts`](../../src/verifier.ts)
- [`src/workflow-catalog.ts`](../../src/workflow-catalog.ts)
- [`src/workflow-pick.ts`](../../src/workflow-pick.ts)
- [`src/workflow-invoke.ts`](../../src/workflow-invoke.ts)
- [`docs/REQUIREMENTS.md`](../../docs/REQUIREMENTS.md)（V2 现行需求）与 [`docs/archive/REQUIREMENTS-v1.md`](../archive/REQUIREMENTS-v1.md)（V1 as-built）
- [`CONTEXT.md`](../../CONTEXT.md)
