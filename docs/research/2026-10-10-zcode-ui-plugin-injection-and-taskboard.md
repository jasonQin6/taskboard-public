# ZCode UI 注入式插件调研：codex/dashi/DSH 对照与 ZCode 落地方案

**日期**：2026-10-10
**问题**：如何为 ZCode desktop app 开发注入式插件（类似 codex 的 dashi-taskboard、DSH 的 dsh-task-board）；功能目标是 DSH task-board 同款「任务看板 + 定时调度」。
**信息来源**：GitHub 一手源码/README、OpenAI 官方文档与 changelog、本仓库源码摸底（file:line 均已核验）。

---

## 1. 宿主对照：三家各自的插件/注入模型

### 1.1 Codex（OpenAI）：官方插件系统没有 UI 面板 API → 催生注入生态

- **官方插件系统**（2026-03-25 发布，[changelog](https://developers.openai.com/codex/changelog)、[Build plugins](https://developers.openai.com/codex/plugins/build)）：插件 = `plugin.json` + `skills/` + `mcp.json`（MCP server）+ `.app.json`（Apps SDK 连接器，可带 UI）+ `hooks/` + `agents/` + `commands/`。分发走官方 Plugin Directory（[openai/plugins](https://github.com/openai/plugins)，58 个官方插件）或 `marketplace.json`（仓库级/个人级，`codex plugin marketplace add owner/repo`），缓存 `~/.codex/plugins/cache/$MARKETPLACE/$PLUGIN/$VERSION/`。与 Claude Code 插件格式兼容。
- **关键限制**：官方模型**没有「在桌面 app 外壳注册 UI 面板」的 API**（UI 能力仅限 MCP/Apps SDK 路线）。这正是注入式项目存在的理由。首个版本 rust-v0.110.0（2026-03-05），此后高频演进至 v0.162（2026-10-08）。
- 独立 Codex.app 已于 ~2026-08-20 并入 ChatGPT 桌面应用，注入目标自此是 ChatGPT.app。

### 1.2 dashi-taskboard（3.3k stars）：CDP 外部注入派

仓库 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（用户所指 "dashi-dashboard" 的实名项目；派生品曾用名 "Dashi Taskboard Launcher"，即 [sperictao/codex-pro-max](https://github.com/sperictao/codex-pro-max)）。

**完整注入链路**（源码实证：[codex-injector.mjs](https://github.com/chuspeeism/dashi-taskboard/blob/main/scripts/codex-injector.mjs)、[codex-taskboard.user.js](https://github.com/chuspeeism/dashi-taskboard/blob/main/inject/codex-taskboard.user.js)）：

1. 以调试端口启动独立 profile 的 Codex：`--user-data-dir=<独立> --remote-debugging-port=9231`（不改 app.asar）。
2. CDP 附着后 `Page.setBypassCSP` 绕过 renderer 严格 CSP。
3. `Page.addScriptToEvaluateOnNewDocument` 在 document-start 注入 userscript。
4. userscript 克隆原生侧栏（`nav[data-app-navigation-rail]` + 复用 app 内 SVG 图标与选中态 CSS）插入入口；创建覆盖主工作区的 sandbox iframe（`src="about:blank"`）。
5. 启动器经 CDP `Page.setDocumentContent` 把本地 Web 服务（`http://127.0.0.1:47823`）的文档**灌进 iframe**——绕过 CSP `frame-src` 的关键。
6. 宿主↔注入层用 `window.postMessage` + 一次性 capability token + 心跳；启动器可代理原生 composer 发起会话并把 thread id 回写看板。
7. 边界声明：不 patch React、不换 fetch、不读改 Codex 数据文件；安全代价 = 调试端口对本机其他进程无认证。

### 1.3 Codex++：asar 补丁派（能力最强、代价最高）

[b-nnett/codex-plusplus](https://github.com/b-nnett/codex-plusplus)（3743 stars）：备份原文件 → patch `app.asar` 使自家 loader 最先运行 → runtime 常驻用户数据目录 → 支持 renderer 与 main 进程两级注入 → watcher 检测更新自动重打补丁（必要时重签名）。

### 1.4 DSH（DeepSeek Harness）：有官方 Web GUI 插件 API，无需注入

`dsh plugin --profile web add <pkg>` 即装。dsh-task-board 的挂载方式（[README.zh.md](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/README.zh.md)）：

- `cordis.patch.yml` + profile 机制，零修改侵入官方源码；官方 SDK（`@deepseek-ai/dsh-api-gateway/workspace/host-webserver`）挂载 Host 服务。
- UI：向 shell `sidebar.panellist` 注册侧栏行 + 中栏 keyed 页面座位（看板是 shell 自己的中栏面板）。
- 模型侧：`SystemPrompt.section` 注册系统提示段 + 8 个面向模型的 Agent 工具（`task_board_list/get/create/update/set_parent/run/manage/schedule`），进程内直达 Host 账本。
- 浏览器侧：同源 `GET /api/task-board/state`、`GET /api/task-board/events`（SSE 只推 revision 变化，重连拉全量 snapshot）、`POST /api/task-board/action`；same-origin/cookie 栅栏，动作上限 64 KiB。
- **Host 是权威**：账本 `ledger-v2.json`（串行动作 + 临时文件原子 rename + 单 Host 锁 + 256 条请求指纹幂等）；cron 用一次性定时器武装、错过跳过不补跑；重启对账。「浏览器只是异步视图，关页面不停调度」。

**dsh-task-board 功能分解**（这是用户真正想要的能力，值得拆开看）：

| 能力 | 本质 | ZCode 现有对应物 |
| --- | --- | --- |
| 五列看板 + 归档/历史 | 状态视图 | 无（需新建） |
| 任务账本（权威存储、原子写、幂等） | 事实源 | CLI 进程即事实源的既有惯例（pluginManagementService 模式） |
| Cron 调度（时区、错过跳过） | 触发器 | 无 |
| Runner（手动/定时统一，queue 模式发 Prompt） | 执行器 | CLI 会话 + `CommandInbox` 串行 admission |
| 目标驱动多轮续跑（/goal） | 执行语义 | 本工作区 to-goal 契约 + PBV 循环同构 |
| 完成验收门（LLM verifier、0.65 阈值） | 质检 | verify agent + `.pbv/verdicts.jsonl` 同构 |
| 权限确认门、来源声明、防注入 | 安全 | hooks 人工审查流、CommandInbox |
| 防休眠电源保护 | 平台细节 | 需按平台新做（caffeinate/PowerShell/systemd-inhibit） |

## 2. ZCode 现状摸底（本仓库）

### 2.1 插件体系：只覆盖 agent 能力面，渲染层零扩展点

- Manifest 契约 `PluginManifest`（`apps/zcode-cli/packages/contracts/src/plugins/index.ts:141-161`）：`commands/agents/skills/hooks/mcpServers/lspServers/outputStyles/settings/userConfig/dependencies/channels`——**没有任何 UI/视图字段**。
- 事实源在 zcode-cli 进程：`packages/services/src/plugins/pluginManagementService.ts:1-56`（desktop 侧纯协议透传）；编排层 `apps/zcode-cli/packages/bootstrap/src/plugins.ts`（安装/卸载/更新/内置恢复 + `withPluginStorageLock`）；adapter 层 `apps/zcode-cli/packages/adapters/src/plugins/`（市场、zip+sha256、组件枚举）。
- 存储布局：`<cli storage>/plugins/cache/zcode-plugins-official/<name>/<version>/`；启用态在 user config `enabledPlugins`，内置卸载走 `suppressedBuiltins`。
- 实物样例见 `~/.zcode/cli/plugins/cache/zcode-plugins-official/`；browser-use 插件已带 JS 运行时（MCP server + `@zcode/node-repl-host`），是「插件携带可执行代码」的先例。
- Desktop 端对插件只有安装管理 UI（`packages/ui/src/settings/PluginStorePage.tsx` 等，store 在 `packages/ui/src/store/pluginManagementStore.ts:11-13`）。

### 2.2 渲染层基建：注入所需的原料大半已备好

- 主窗口已开 `webviewTag`（`packages/desktop/src/main/desktopWindowChrome.ts:587`），且有 `will-attach-webview` 按 URL 切专用 preload 的先例（`:56-61`）；CodingPlan 内嵌官网完整演示「容器组件 + contextBridge 小桥 + dom-ready 后 executeJavaScript」（`packages/ui/src/settings/CodingPlanEmbeddedWebviewDialog.tsx:90`、`packages/desktop/src/preload/codingPlanWebview.ts:78`）。
- 自定义协议模板：`zcode://` deep link（`packages/desktop/src/main/desktopOAuthDeepLink.ts:405-426`）、`protocol.handle` 两例（`localMediaPreviewProtocol.ts:154`、`browserView/browserRestoreBootstrapProtocol.ts:21`）。
- 集中注册表模式（可动态化）：设置分区 `packages/ui/src/settings/settingsPageConfig.ts:59-154`、tab/side-pane `packages/ui/src/store/tabStore.ts`、灰度入口 `dynamicWorkflowAvailabilityStore.ts:13-30`（Host 决策 → renderer 显隐）。
- preload bridge 集中治理：`contextBridge.exposeInMainWorld("zcode", …)`（`packages/desktop/src/preload/index.ts:247`），文件头注释（`:6`）明确 bridge 集中便于审计权限边界。
- 安全现状：contextIsolation on / nodeIntegration off（`desktopWindowChrome.ts:584-587`）；zip sha256 强制（`adapters/src/plugins/zip-source.ts:92-159`）；路径越界防护 `resolveInside`（`plugin-components.ts:9`）；**无插件权限模型、无进程级沙箱**（信任模型 = 市场完整性校验，非运行时隔离）。
- web 与 desktop 共享渲染层（都挂 `@zcode/ui` 的 App，`packages/desktop/src/renderer/src/main.tsx`），renderer 无本地 HTTP 服务、无 devtools 扩展机制。

### 2.3 结论

ZCode 渲染层完全没有第三方 UI 扩展点，但注入所需的四类原料——webview 基建、自定义协议、集中注册表、CLI-事实源透传模式——都已存在。最自然的原生路径：

1. **manifest 增 UI 契约**（如 `ui.panels`）→ 2. **`zcode-plugin://` 自定义协议**服务已装插件的静态资源（复用 `resolveInside` 防路径逃逸）→ 3. **`<webview>` 面板容器 + 专用 preload 桥**（仿 CodingPlanEmbeddedWebviewDialog）→ 4. **renderer 面板注册表**（仿 settingsPageConfig/tabStore），host 透传已装插件 UI 清单（仿 pluginManagementService 模式）→ 5. 插件↔宿主消息边界用 MessagePort RPC（`src/host/electronPort.ts`）。

不推荐 CDP 外挂/asar 补丁派路线：ZCode 是自己的产品，能走一等公民路径，无需承担调试端口暴露或升级重打补丁的代价。

## 3. 方向决策：原生实现 vs 服务器看板反控本机

**方向 2（dsh-task-board 反控本机 ZCode）的真实成本**：

- dsh-task-board 的 runner 与 DSH 官方 SDK 深耦合（新建 DSH 会话、应用 workspace/agent 预设、权限钉住、queue 模式）；要驱动 ZCode 需给它新增一个「ZCode provider」后端（如经 SSH 调本机 `zcode` CLI headless / stream-json，multica 集成已验证该驱动方式可行），goal 续跑与验收门也要换成 ZCode 侧语义——这是移植项目，不是配置变更。
- 跨机安全面：服务器 → 本机的执行通道要自己设计鉴权（README 的 trustedProxyHosts/proxyToken 只覆盖反代场景）。
- 定时调度在服务器上跑，但执行依赖本机开机在线，「关页面不停调度」的保证对本机执行不成立。
- **完全绕开 ZCode app**：与最初「注入到 ZCode app」的目标相悖；看板和 ZCode 会话是两个割裂的世界。
- 剩余价值：若任务要在「离开本机」时跑在服务器上，它已有现成账本——但那是「服务器上的 DSH 任务」，与 ZCode 无关。

**方向 1（原生实现）的顺风**：

- 架构惯例吻合：ZCode 本来就是「CLI 进程 = 事实源，desktop/web = 视图」——task ledger + scheduler 放 CLI 进程，UI 面板放 renderer，与 pluginManagementService 同构。
- 执行与验收语义已有同构物：to-goal 契约 + verify agent + `.pbv/verdicts.jsonl` ≙ dsh-task-board 的 goal 续跑 + verifier 门；CommandInbox ≙ queue 模式发 Prompt；hooks 审查流 ≙ 权限确认门。
- 手机远控链路（web-remote-replayable）免费复用：看板可从手机看——这是方向 2 给不了的。
- 缺的只有三块：看板账本与 cron 调度器（CLI 侧）、UI 面板注入基建（2.3 的五步）、防休眠（平台细节）。

**推荐**：方向 1，分两期。一期做 UI 插件基建（上面五步，是所有未来 UI 插件的地基）+ 把任务看板做成第一个官方 UI 插件 dogfood（先做账本/手动执行/看板视图，验收门直接接 verify agent）；二期补 cron 调度器（CLI 侧常驻问题：桌面不开时调度不跑，短期接受「app 开着才调度」，长期可评估 launchd 用户代理拉起 CLI 调度器）+ 防休眠。方向 2 不作为主路线；若急需过渡，服务器看板继续管服务器上的 DSH 任务即可，两条线不冲突。

## 4. 独立 taskboard（loopx 式）架构与会话注入可行性（2026-10-10 补充）

**提议**：taskboard 独立于任何 harness（loopx 式：文件型控制平面 + CLI + host-surface 适配），自带 daemon（ledger + cron + runner），ZCode 只是其中一个 adapter；daemon 以 headless 方式调 `zcode` CLI，不碰 ZCode app；同时给 ZCode agent 提供 CLI/skill 集成。**问题**：外部创建的 CLI 会话能否注入 ZCode app？

### 4.1 会话存储事实（摸底结论，file:line 已核验）

- **CLI 与 app 共享同一会话库** `~/.zcode/cli/db/db.sqlite`（单文件 SQLite，`SqliteSessionStore`）：`adapters/src/storage/session-store/paths.ts:6-8`、`contracts/src/config/index.ts:303`；desktop spawn 的 agent 子进程没有注入 `ZCODE_SESSION_DB_PATH` 覆盖，走同一默认值。
- **app 侧栏列表不是 app 扫文件**，而是 agent 子进程经 v4 协议 `sessions-index` 推送：订阅基线 = 冷枚举 sqlite（`loadStoredSessionSummaries`：`directory == workspacePath`、`workspaceID` NULL、taskType ∈ {interactive, fork, workflow_parent}、未归档、limit 200）——`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts:1352-1428`、种子逻辑 `v4-gateway.ts:1225-1249`；host services 落 `~/.zcode/v2/tasks-index.sqlite`（`packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts:1-49`）。
- **打开历史会话 = 冷恢复**，非只读回放：`resumePersistedSession` + conversation hydrate（`v4-bridge.ts:1449-1478`、`v4-gateway.ts:2928-2988`）。CLI 侧 `--resume <id>` 同语义（`cli/src/resume.ts:9-29`）。
- 已有外部会话导入先例：Claude Code JSONL 导入（`packages/services/src/session/claude-native/claudeNativeSessionImportService.ts:31-50`）。
- 重启恢复路径（app 崩溃后由 sqlite 重新种子列表）就是现成的「外部会话注入」通道。

### 4.2 注入可行性判定

| 路径 | 改动 | 效果 |
| --- | --- | --- |
| daemon 直接 `zcode -p` 跑会话 | **零改动** | 会话已入共享库；app 在**下次 reseed**（重启 app / agent 进程重启 / workspace 重连）时出现在侧栏，点开可继续对话。运行中的 app 不会实时看到（无跨进程失效通知，`v4-bridge.ts:1568-1571` 的 refresh 分支仅限 legacy claim） |
| 实时可见 | 小改 CLI（非 Electron app） | `mergeMissingStoredSummaries` 已存在（`v4-gateway.ts:1226`），放宽 `v4-bridge.ts:1568-1571` 的触发条件（订阅时总是 refresh / timer / fs watch db.sqlite），改动集中在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/` 两文件 |
| 正式导入通道 | 中改 | 仿 `claude-native/` 导入服务，在 `packages/services` 加 zcode-CLI-session 导入器，复用 `persistImportedClaudeTask` + `TaskIndexRepo` 模式 |

**打开/继续对话零改动**（cold-resume 已支持任意 store 内会话）。**避免**：外部进程直写 sqlite/tasks-index schema（内部实现无公开契约，跨版本脆弱）；daemon 起常驻 agent server 与 app 双 runtime 同抢一个 session（CommandInbox 只在单 runtime 内串行 admission，跨 runtime 并发 turn 无保护——taskboard 应按 turn 粒度 spawn 子进程，执行中任务在 app 里只读观看）。

### 4.3 独立 taskboard 架构（所有者与事件顺序）

```
┌─ taskboard daemon（本机权威）───────────────────────────┐
│ ledger（任务/执行，原子写+单写锁）   scheduler（cron/时区）│
│ runner ─► ZCode adapter ─► zcode -p / --resume <id>     │
│        └► DSH adapter ─► DSH 会话（服务器场景）           │
│ verifier 门（harness 无关或 per-adapter）                │
│ HTTP: GET /state · /events(SSE) · POST /action（dsh 同款）│
└──────┬───────────────────────────────────────────────────┘
       │ 会话落 ~/.zcode/cli/db/db.sqlite（WAL+busy_timeout 并发安全）
┌─ ZCode app（零改动）────────────────────────────────────┐
│ agent 子进程 reseed 时外部会话进侧栏；点开 cold-resume； │
│ （可选）CLI 小改 → 实时可见                              │
└─────────────────────────────────────────────────────────┘
视图 ×3：board Web UI（daemon 本地服务）· taskboard CLI · ZCode 内 skill
```

事件顺序：创建（用户/cron）→ ledger 落账 → runner 经 adapter spawn CLI 会话（stream-json 事件回流 runner）→ session_id 回写 ledger → 会话入共享库 → app 侧异步可见/resume → 完成过 verifier 门 → ledger 结算。关 board 页面不停调度（daemon 是权威，同 dsh 语义）。

### 4.4 与前两方向的取舍

此方案 = 方向 2 的解耦改造版，吸收了方向 2 的所有顾虑并逐一化解：runner 不再 DSH 深耦合（adapter 层）；执行与调度同在本机 daemon（不再跨机鉴权）；不碰 app 但会话仍进 app（共享存储红利）。相比方向 1（原生实现）：放弃「app 内一等公民面板」，换取 taskboard 可服务多 harness、独立演进；app 内实时可见性退化为「reseed 时出现 + 可选 CLI 小改」。loopx 已验证该模式可行（`~/.codex/loopx` 控制平面 + host-surface 含 zcode），且两者是互补关系（loopx 管目标/循环，taskboard 管看板/cron/多 harness 执行账本）。

## 5. v1 实现落地（2026-10-10）

§4.3 的独立 taskboard 已按 spec 实现为 `taskboard/`（独立于 pnpm workspace，零运行时依赖）：
ledger（JSON 原子写 + 互斥 + 幂等指纹）/ runner（并发 2、每任务单飞、取消语义）/ zcode
adapter（stream-json 解析，终局只认 `type:"result"`）/ scheduler（30s tick、宽限触发、错过
跳过）/ HTTP API（state + SSE revision + action）/ CLI（`taskboard` 薄客户端）。
32 项单测 + 真实 e2e（`test/e2e-zcode.mjs`）覆盖验收场景 1。摸底修正一处：共享库表名是
**`session`**（单数），不是 `sessions`（那是 repository 文件名）。

## 6. 附：本报告的三份原始调研纪要

- codex/dashi 注入机制与官方插件系统：见 §1.1–1.2（后台调研员 2026-10-10 完成，全部结论有一手 URL）。
- ZCode 仓库摸底：见 §2（file:line 已核验于当日工作区）。
- dsh-task-board 功能与机制：[README.zh.md](https://github.com/zhu1090093659/dsh-web/blob/main/packages/dsh-task-board/README.zh.md)。
