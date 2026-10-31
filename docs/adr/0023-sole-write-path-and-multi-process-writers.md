# ADR-0023：唯一写路径与多写进程

日期：2026-10-31｜状态：已接受（取代 ADR-0002）

## Context

retro 子功能会带来第二个写进程：`taskboard retro record` / `combo-record` 短命 CLI 由 ZCode Stop hook 调用（#65、#66），hook 与 daemon 生命周期无关，交互会话收尾时 daemon 可能不在运行。ADR-0002 按字面禁止此形态：「视图、CLI、调度器都不直写数据库文件。daemon 由单实例锁保证唯一写者」。

数据库层早已具备多进程并发写的条件：state 库打开即 `PRAGMA journal_mode = WAL`，读写连接都带 `BUSY_TIMEOUT_MS`（`src/db.ts`）。ADR-0002 真正要禁的从来不是「多个进程写」，而是「绕过事务层写」。

## Decision

- 一切状态变更仍必经 repository/service 事务层（`src/store/` 的 StoreCore `write()` 事务缝）落库；任何调用方（daemon、短命 CLI、视图、调度器）不得绕过该层直写数据库文件。这是原不变量的真意，保留不变。
- 允许 daemon 与短命 CLI 多进程并发写库。纪律 = SQLite WAL + busy_timeout：写锁竞争表现为等待或 SQLITE_BUSY 超时，不引入应用级跨进程写锁。
- daemon 单实例锁语义收窄为「保证 daemon 自身唯一运行」：锁机制照旧（锁文件、持有者 pid 与心跳、陈旧接管、退出释放，见 ADR-0002），但它只防第二个 daemon，不承诺数据库文件级唯一写者，也不阻止 CLI 在 daemon 运行期间写库。
- ADR-0002 的重启对账收敛规则继续有效、原文不动：对账只收敛 daemon 自有的 Run / Action Execution 状态，不回收短命 CLI 的写入。

## 被否决的替代方案

- outbox 文件 + daemon 单写收编：CLI 只落 outbox 文件，daemon 保持唯一写进程，上线后收编入库。不采用：hook 触发时 daemon 可离线，记录会无限期悬置；多一跳文件就多一类失败模式（outbox 损坏、重复收编、daemon 离线时的背压）；且收编仍要处理并发与幂等，问题没有消失，只是从数据库搬到了文件。

## 范围外

- 开发拓扑「写严格串行，任一时刻至多一个写者」（AGENTS.md「开发拓扑」条）不在本 ADR 范围，保持不动：那是多 Agent 开发对代码工作区与分支的批次纪律，不是对数据库写进程的约束。
- 删除、清空与重建数据库的边界不在本 ADR 放行范围，损坏隔离（ADR-0001）不变。

## Consequences

- 短命 CLI 获得合法写身份，retro record 类 hook 场景不再与不变量冲突；retro 两表与 CLI 实现在 #65 立项，本 ADR 只放行形态。
- 事务层成为唯一护栏：任何进程里绕过 `src/store/` 的直写都是违规，评审按此判。
- 新写进程必须复用同一事务层，并容忍 SQLITE_BUSY（重试或失败可见），不得自开旁路连接写库。
- AGENTS.md 不变量行同步改写并引用本 ADR。
