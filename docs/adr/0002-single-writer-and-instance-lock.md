# ADR-0002：数据库单一写者与单实例锁

日期：2026-10-21｜状态：已被 ADR-0023 取代

## Context

多个 daemon 并行、或视图/CLI 绕过事务直写数据库文件，会破坏事务边界、revision 单调性与 SSE 一致性。

## Decision

- 一切状态变更经 Store（唯一写入面）事务落库；视图、CLI、调度器都不直写数据库文件。
- 同一数据库同时只允许一个 daemon 持有：锁文件与数据库同目录，写入持有者 pid 与启动时间，持有期按心跳刷新 mtime；第二个 daemon 遇新鲜锁立即失败并报持有者 pid，心跳陈旧可自动接管，正常退出（含 SIGTERM）释放锁。
- 重启对账收敛规则：running Run → failed(orphaned) 并保留 thread 锚点；queued Run → cancelled；pending/running Action Execution → failed(orphaned)；任务回可重跑态；进程内单飞状态与级联状态清空，不恢复半截级联。

## Consequences

- 双启是显式错误而非静默竞争；对账幂等，可重复执行。
- 孤儿 Run 的失败不删除 thread、证据或摘要。
