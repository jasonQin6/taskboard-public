# ADR-0001：SQLite 为唯一事实源，空库初始化、不做旧数据迁移

日期：2026-10-21（V2 spec 定稿）｜状态：已接受

## Context

V1 用自研 JSON 账本加多份 `.bak-vN` 备份链，损坏恢复与并发写语义靠约定自律。V2 需要事务、外键与可审计的单库事实源。当前没有生产数据——迁移路径是为不存在的数据付复杂度。

## Decision

- 唯一事实源是 SQLite（Node 内置 `node:sqlite`，要求 Node ≥ 24），开启 WAL、busy timeout 与外键，一切写入经 repository/service 事务。
- 打开库执行 `PRAGMA quick_check`；失败把库文件隔离为 `<db>.corrupt-<时间戳>` 并拒绝启动；只有库文件不存在时才初始化空库，任何解析/校验失败不得静默重建。
- schema 迁移在事务内逐级执行，失败整批回滚；不用 V1 的备份链。
- 不提供 V1 JSON 迁移、双写、回读或双向兼容；V1 as-built 在 git 历史。

## Consequences

- 状态查询即 SQL 读；崩溃恢复靠 WAL 与事务，而非备份文件。
- 孤儿与遗留状态的收敛靠重启对账（见 ADR-0002），不靠数据修补工具。
- 若未来出现真实生产数据需要迁移，另行新写 ADR，不复活 V1 路径。
