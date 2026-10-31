# ADR-0017：Phase 1 是单产品内的只读观察切片

日期：2026-10-26｜状态：已接受

## Context

Taskboard V2 已经具备 Task、Run、cron、proposal、验收和 Harness 写路径。Phase 1 要解决的是并行 Agent 的注意力成本，而不是再建一套执行产品。过强的隔离会带来独立包、入口和数据库，形成双产品；过弱的隔离又会让执行语义顺着共用数据模型和 UI 长回来。

## Decision

- Taskboard 是唯一产品。Kanban 是 Phase 1 WebUI 的名称，不是独立产品或数据源。
- Phase 1 与 V2 共享仓库、daemon、SQLite 状态库、单写者、迁移和 WebUI 基础设施。
- Phase 1 只发布观察、整理、展示和语义进度判断；执行面代码保留但不在 Phase 1 运行时装配或接口中暴露。
- Phase 1 不创建独立 `kanban` 包、入口或数据库，不维护长期产品分支。
- Harness 原生事实优先。归一化索引可重建；人工 overlay 只写 Taskboard 自有表。
- SystemOne 输出只进入展示徽标、原因和审计，不进入 Task 或 Run 状态机。
- 任何需要 resume、send、sample、compact、goal 或 ACP 写调用才能取得的信息都不属于 Phase 1。

## Consequences

- 不需要为 Phase 1 另建部署、锁和迁移体系。
- 执行面与观察面必须通过运行时装配、路由和测试明确切开，不能只靠命名约定。
- Phase 1 功能扩展时，先判断它是否观察、整理或展示；不是则留给后续阶段。
- 未来若需要把观察面拆成独立部署单元，另立 ADR，不把当前决定当作永久边界。
