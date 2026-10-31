# taskboard

> **V2（2026-10-21 起）**：功能面（Codex reader、app-server driver、摘要/Jev、自动化、React 看板）已全部落地。票据走 GitHub Issues，triage 绑定见 [`docs/agents/issue-tracker.md`](./docs/agents/issue-tracker.md)，生命周期与批次交付见 `$HOME/.codex/skills/MEA/SKILL.md`。V1 不做兼容，历史语义查 git 历史。

独立任务看板 daemon（V2）：SQLite 状态库 + 五列看板（backlog/todo/running/done/failed，
archived 正交）+ cron 调度 + `wait` 静止判定 + Codex thread 观察（Inbox/绑定/摘要/提案）。
零运行时依赖（只用 Node 内置模块，要求 Node ≥ 24），HTTP 只绑 `127.0.0.1`。

行为与验收场景见 [docs/spec/](./docs/spec/)；
领域词汇表见 [GLOSSARY.md](./GLOSSARY.md)；给 agent 的工作指南见 [AGENTS.md](./AGENTS.md)；
给 agent 的工具面见 [.agents/skills/taskboard/SKILL.md](.agents/skills/taskboard/SKILL.md)。

## Quickstart

```bash
pnpm install && pnpm build && pnpm test   # 单测全绿（不需要模型凭据）

# 起 daemon（前台；Ctrl-C / SIGTERM 优雅关闭并释放单实例锁）
node dist/cli.js start           # 或：pnpm dev start
node dist/cli.js start --port 47999 --db /tmp/tb/taskboard.sqlite

# 另开终端：任务全链路（CLI 是 daemon 的薄客户端，默认 http://127.0.0.1:47830）
node dist/cli.js create --title "smoke" --prompt "…" --workspace /abs/path --json
node dist/cli.js list --json
node dist/cli.js get <taskId> --json
node dist/cli.js run <taskId> --json     # 起 Run（经 app-server driver 写 Codex）；cancel 中止并回 todo
node dist/cli.js cancel <taskId> --json
node dist/cli.js move <taskId> done --json
node dist/cli.js wait <taskId>          # 阻塞到静止（无活跃 Run、主线程非 running、无 in-flight 写）
node dist/cli.js archive <taskId> && node dist/cli.js delete <taskId>

# cron 定时（5 段 + 可选 IANA 时区；错过不补跑）
node dist/cli.js create --title "nightly" --cron "0 9 * * *" --tz Asia/Shanghai \
  --workspace /abs/path --json

node dist/cli.js status --json          # 概览：revision/任务数/运行态
node dist/cli.js db path                # 数据库文件路径（不需要 daemon 在跑）

# Codex thread：扫描进 Inbox → 绑定 → 摘要/证据 → Jev 提案裁决
node dist/cli.js status --json          # inbox 域即待绑定线程；refresh 立即扫描，ignore-thread/unignore-thread 忽略与恢复
node dist/cli.js bind-thread <taskId> <threadId> --json
node dist/cli.js inspect-thread <threadId> --json
node dist/cli.js summaries <threadId> --json
node dist/cli.js proposals --json
node dist/cli.js accept-proposal <proposalId> --json

# 看板 UI（React；构建产物由 daemon 同端口伺服）
pnpm build:web && node dist/cli.js start   # 浏览器打开 http://127.0.0.1:47830
```

子命令全集以 `node dist/cli.js help` 为准（运行时真相源）。退出码契约：0 成功、
1 语义失败/超时、2 用法错误、3 daemon 不可达；机器集成只认 `--json` 输出
（字段集合见 `test/tool-contract.test.ts` 快照）。

## 配置与环境变量

CLI 启动时读取当前目录的 `.env`；可用 `TASKBOARD_ENV_FILE` 指定其他文件。已存在的进程环境变量优先，`.env` 缺失不会报错。模板见 `.env.example`，`.env` 已被忽略，不能提交。

launchd 等不经过 CLI 的启动方式不会自动读 `.env`，请用 wrapper 或 plist 的 `EnvironmentVariables`。

## 数据与文件位置

| 文件 | 说明 |
| --- | --- |
| `~/.taskboard/taskboard.sqlite` | 状态数据库（唯一事实源）。可用 `--db PATH` 或环境变量 `TASKBOARD_DB_PATH` 覆盖；只读查询路径：`taskboard db path` |
| `<db>.lock` | 单实例锁（与数据库同目录，内容为持有者 pid 与启动时间，按心跳刷新） |
| `<db>.corrupt-<时间戳>` | `PRAGMA quick_check` 失败时被隔离的库文件——daemon 拒绝启动，绝不空库重建 |

数据库开启 WAL、busy timeout 与外键；一切状态变更经 repository/service 事务落库，
revision 按 `tasks`/`threads`/`config` 分域单调推进，SSE 只广播
`{domain, revision, ids[]}`。不做 V1 JSON 账本迁移（查历史回 git：main 分支保留 V1 全部实现）。

## HTTP API（本机）

`GET /api/state`（卡片级看板状态）、`GET /api/tasks/:id`、`GET /api/threads/:id(/turns|/evidence|/summaries)`、
`GET /api/proposals`、`GET /api/annotations`、`GET /api/db/path`、SSE `GET /api/events`、
`POST /api/actions`（统一写入口，`requestId` 幂等）；`web/dist` 存在时同端口伺服看板页面。
安全基线：POST 只收
`Content-Type: application/json` 且 Origin/Host 须为回环或显式允许来源；
可选代理栅栏（`--trusted-proxy-host` + `--proxy-token-env`，默认关）是跨机/反代的唯一授权例外，
daemon 恒绑 `127.0.0.1`。

## 边界（诚实声明）

- 验收证据只落 GitHub Issues（关票评论、label 状态机）与测试，不回写 spec——spec 是派生源，不是验收簿。
- 不迁移 V1 JSON 账本；V2 空库起步（历史语义查 git 历史）。
- 平台范围：macOS 开发与真机验证（防休眠 caffeinate 已真机实测）；Windows/Linux 未真机验证，
  失败一律静默降级并在 state 如实暴露。

## 许可证

本项目以 source-available 方式公开，采用 [PolyForm Noncommercial License 1.0.0](./LICENSE)。
这不是 OSI 认可的开源许可证；仅允许许可证定义的非商业用途。商业使用需版权人另行书面授权。
