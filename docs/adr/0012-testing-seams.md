# ADR-0012：测试缝决策

日期：2026-10-21｜状态：已接受

## Context

单测不得依赖真实 Codex、模型凭据或浏览器；测试要验证外部可观察行为，不绑定私有函数、SQL 细节或 React 内部状态。

## Decision

- 主缝 = **daemon 公共 API 缝**：启动真实 HTTP daemon（临时 SQLite、临时 Codex home、假 app-server、假 Jev），经 HTTP/CLI 驱动完整用户流程。
- 兼容缝 = **原生来源兼容缝**：固定 rollout fixture 驱动真实 reader，覆盖 schema 演进、追加、半行、截断、重写、目录移动、zst、fork、rollback、subagent、未知 item、坏行与崩溃重跑收敛。
- 假 app-server 必须锁定协议版本与支持的 method 集合，作为测试契约维护；协议漂移在这里显式变红。
- 时间逻辑（空闲阈值、扫描周期、超时、断路器）一律注入时钟；重写与崩溃恢复有崩溃注入测试；HTTP 层测试收尾 `server.closeAllConnections()`（fetch keep-alive 会挂住进程）。
- UI 用 Playwright 对真实 daemon 冒烟（公开 API 缝构造状态，不模拟 React 内部）：独立 script（`test:ui`），不进 `pnpm test`；浏览器不可用明示跳过；Playwright 只进 devDependencies。
- 真实 Codex 烟雾门由环境变量启用，不进默认单测；macOS 真机防休眠属人工验证，不入 CI。

## Consequences

- `pnpm test` 无网络、无凭据、无浏览器即可全绿。
- 外部协议变化（app-server、rollout schema）的破坏面在兼容缝一次性暴露。
