# Taskboard — 代理工作指南

独立任务看板 daemon：任务 + cron 调度 + 多 Harness thread 观察。零运行时依赖（只用 Node 内置模块），不依赖 DSH、ZCode 或 CodexHost 的运行时。V2 为重写、不做兼容，V1 历史语义查 git 历史。

## 文档地图

- **字段级稳定契约**：以 `test/tool-contract.test.ts` 快照断言为可执行真相源；运行时真相源是 `taskboard help`。
- **Phase 1 观察型 Kanban**：产品名词与领域语义见 `GLOSSARY.md`，行为与验收见 `docs/spec/phase1-observation-mvp.md`；它是 Taskboard V2 的只读 MVP 切片，不是独立产品或独立数据库。Kanban 只是 WebUI 名称。
- **硬决策与依据**：查 `docs/adr/`——每条不变量的 context/consequences 都在那里；改不变量先写新 ADR 再改代码。
- **判断一个能力该做、该封装还是该补充**：先查 `docs/adr/0013-complete-codex-not-reimplement.md` 与它引用的能力对照表；Harness 已有的一律封装，不重造。
- **领域措辞有分歧、或要引入新名词**：查 `GLOSSARY.md`（唯一词汇表）；新词条在那里定，不在需求或注释里现造。
- **实现票据**：由 `to-tickets` 派生到 GitHub Issues，triage 绑定见 `docs/agents/issue-tracker.md`。
- **MEA 多 Agent 开发**：编排、精确 SHA 审计和无人值守入口见 `$HOME/.codex/skills/MEA/SKILL.md`；角色正文只存在于 `$HOME/.codex/agents/{manager,executor,auditor}.toml`。
- **开发拓扑**：写严格串行，任一时刻至多一个写者，只读侦察与审计可并行；批次分支、产物路径和交付边界由 MEA project profile 决定，不在本文件重复。
- **代码审查**：Auditor 或任何 Agent 对本仓 diff/domain 做审查时，先读 `docs/agents/review-standards.md`；通用方法使用 `code-review`，异源复审使用 `ocr`。
- **issue-worker / ZCode issue-to-pr**：跑一张 issue、状态机与崩溃恢复见 `tools/issue-worker/README.md`；架构、DWF 契约与幂等设计见 `docs/research/2026-10-30-zcode-issue-to-pr-daemon.md`。
- **daemon 会话的 hook 与权限面**：hook 覆盖矩阵（含 `.git` 边界与 `dwf-` 排除门两条推论）与 headless 权限面四件套契约见 `docs/architecture/daemon-hooks-and-permission.md`；daemon 实现不得绕开该契约各自发挥。
- **外部运行时事实**：Codex app-server、写锁、sample、CodexHost 行为见 `docs/research/`；这类内容只进调研文档，不进需求正文。
- **快速上手 / 为什么这样架构**：`README.md` 与 `docs/research/` 下的调研报告。

## 命令

`package.json` 的 scripts 是命令真源，这里只记环境相关的坑：

- `pnpm test` 是单测（node:test + tsx），不依赖构建、浏览器与模型凭据。
- 本目录是**有意的独立 pnpm workspace 根**（`pnpm-workspace.yaml` 防止向上吸附外层 ZCode 仓）；在外层仓根跑 `pnpm install` 不会安装本目录依赖，必须在 `taskboard/` 内跑。

## 不变量（改动即破坏契约；依据与后果见 docs/adr/）

- **唯一写路径、多写进程**：一切状态变更经 repository/service 事务层落库，任何调用方（daemon、短命 CLI、视图、调度器）不绕过该层直写数据库文件；daemon 与短命 CLI 可多进程并发写库，纪律 = SQLite WAL + busy_timeout。daemon 单实例锁只保证 daemon 自身唯一运行，不承诺数据库文件级唯一写者。（ADR-0023，取代 ADR-0002）
- **终局判定只认原生 turn 终态**：Codex 以 `event_msg` 内的 `task_complete` 为成功终局，`turn_aborted` 是 interrupted 而非 failed；item 完成事件和任意带 thread id 的事件行都不作终局。（ADR-0005）
- **不碰 Codex 的存储**：扫描只读；唯一例外是已绑定 Task 的线程经显式 resume/sample 接管写锁并可能 materialize 压缩文件，必须落审计。Inbox 线程永不 resume。（ADR-0003）
- **单条 Codex 写路径**：daemon 持有一个长驻 app-server 子进程；同一 thread 至多一个 in-flight 写操作。不得引入第二条并行 app-server 写路径（含 CodexHost）。（ADR-0004）
- **运行时零依赖**：新增依赖只能进 devDependencies；引入运行时依赖属架构变更，先改 ADR 说明理由。（ADR-0006）
- **HTTP 只绑 loopback、无认证**：必须有 CSRF 基线（JSON Content-Type + Origin/Host 校验）；跨机/反代能力只走可选代理栅栏——默认关、daemon 仍只绑 `127.0.0.1`。（ADR-0007）
- **Phase 1 只读边界**：Harness 源数据只读；Phase 1 不调用 send、resume、cancel、fork、goal、sample、compact，不暴露 Run、cron、proposal 执行与验收入口。人工 overlay 只写 Taskboard 自有表。（ADR-0017、ADR-0018）
- **跨 Harness 身份**：使用 `(harness_id, native_session_id)` 作为唯一身份，经 `SourceLocator` 回源；不得假设不同 Harness 的 id 天然不冲突。（ADR-0018）
- **SystemOne 只判断不驱动**：默认经 Magpie 产生 `ProgressVerdict`，只进入徽标、原因和审计，不进入 Task、Run、Proposal 或自动化决策；原生摘要优先，SystemOne 不生成 native summary。（ADR-0019）
- **Issue 不是需求或契约**：产品语义以 `GLOSSARY.md` 为准，行为与验收以需求/规格为准，硬决策以 ADR 为准。GitHub issue 只承载可执行切片、依赖、验收命令和沟通记录。

## 协作断点

一条工作流的第一个 PR 合并进 `main` 之后，主线程只保留决策、状态与验收；实现、修复和独立复审交给独立线程，任务必须带可独立交付的边界与证据要求。此后继续在主线程写代码视为跑偏，而不是勤奋。

多线程并行时用 `pnpm watch:threads <thread>...` 一条命令盯到全部终态（退出码 0=全终态、2=有失败、124=仍在跑），它只报执行状态，不代表验收通过。

## 实现与验证

- 注释只写代码看不出的 why/why-not（中文），不写 what/how；改代码同提交更新或删除相关注释，过时注释按 bug 处理；每季度一次全仓注释审计（能编码成类型/测试/lint 则编码并删注释），依据见 `docs/research/2026-10-20-comments-mislead-agents.md` 与 `docs/research/2026-10-20-prevent-comment-imitation.md`。
