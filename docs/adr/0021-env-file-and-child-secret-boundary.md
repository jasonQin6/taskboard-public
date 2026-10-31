# ADR-0021：项目 .env 加载与子进程凭据边界

日期：2026-10-28｜状态：已接受

## Context

本地开发和 PStack 实验需要把 Magpie 地址、SystemOne token 等配置放进项目 `.env`，避免每次启动手动 export。Node 不会自动读取 `.env`，而 daemon 启动 Codex app-server 时会把 `process.env` 复制给子进程。

只增加 `.env` 加载会把 SystemOne token 带进 Codex app-server，扩大凭据暴露面；只用外部 shell 注入则无法解决项目内配置的可重复性。

## Decision

- CLI 入口显式加载项目 `.env`：默认当前工作目录下的 `.env`，可用 `TASKBOARD_ENV_FILE` 指定。
- 已存在的进程环境变量优先；`.env` 缺失视为未配置；不递归查找父目录。
- `.env` 不提交，仓库提供 `.env.example`；`.gitignore` 忽略 `.env`。
- Codex app-server 子进程启动前剔除 SystemOne token 环境变量：默认 `TASKBOARD_SYSTEMONE_TOKEN`、`MAGPIE_CALLER_KEY`，以及调用方显式登记的额外 token 变量名；额外名单在每次 spawn 前重新求值，设置变更对新子进程生效。
- token 仍只由 SystemOne provider 读取，不进入数据库、日志、错误消息或子进程环境。

## Consequences

- 本地启动只需维护一个不提交的 `.env`，进程环境仍可临时覆盖。
- `.env` 是明文密钥文件，必须限制权限；项目目录被共享或复制时仍可能泄露。
- launchd 等不经过 CLI 的启动方式必须使用 wrapper 或 plist 的 `EnvironmentVariables`，不能假设 `.env` 会自动生效。
- 新增 provider 或子进程时必须登记其 token 环境变量，否则隔离不完整。
