# ADR-0016：store 按族拆分——聚类边界、TransactionHost 与门面转发

日期：2026-10-23｜状态：已接受

## Context

state 数据库的 Store 是 2585 行单类、16 个域分节同居，多数方法为 SQL 透传；任何域改动都要打开同一文件（晨析条目 2，复查确认更重）。全仓唯一的深缝是 `write()`：一个事务 + 按域递增 revision 并广播。跨域事务真实存在（一个动作常同时 touch tasks 与 threads）。12 个消费文件、254 处 `store.` 调用。

曾考虑的替代：16 域全拆成 16 个小 repository（族内耦合变跨文件跳转，locality 反而变差）；一次性大挪（中途红窗口长，违背 lane 纪律）；消费面注入式改造（254 处调用点全动，diff 与行为变化混审）。

## Decision

- **聚类 3+1 文件**（`src/store/` 目录）：**TaskStore**（tasks/runs/cron 调度面/annotations/action executions/worktrees）｜**ThreadStore**（threads 读取面/绑定/reader 游标/reader 写面/评估状态）｜**AutomationStore**（proposals/shadow 回放）｜**StoreCore**（事务与域 revision/幂等键/newId 等底盘；schema 迁移启动在 db.js）。settings 域于晨析 2026-10-25 外挪为第五族 **SettingsStore**（`settings-store.ts`，merge/validate 纯函数可直测），写路径仍经 core 的事务缝——core 收窄为纯底盘。`store/index.ts` 承接原 `store.js` 的 import 路径，消费面零改动。
- **TransactionHost**：`write()` 小接口大实现原样落 StoreCore（开事务、Touch 跨域收集、commit+revision 广播）；三个族 store 的写方法经 core 的事务缝进库，跨域事务边界不变。
- **Store 门面转发**：Store 类保留为组合门面，全部公共方法签名不变、转发到族 store；不做接口收窄、不删方法（留给将来独立提案）。
- **渐进四步**，每步全量测试绿 + typecheck 三配置为可合并状态：① Core+Host 落位（域方法暂留原类，Store 委托 core）→ ② 任务族挪出 → ③ 线程族挪出 → ④ 自治族挪出 + 门面收口（store.ts 退位为 index.ts）。
- 行为零变化：不新写行为测试，既有全量（377 条）做等价性哨兵；schema 与迁移逻辑零变更。

## Consequences

- 每族文件量级（2026-10-25 实测约数，settings 外挪后）：core / settings-store 百行级、automation-store 近 400 行、task-store / thread-store 千行级（另门面 index.ts 约 600 行、rows.ts 数十行）——原表述「400-800 行」与拆分结果不符：两个大族含大量 SQL 透传体量超出预估，再外挪不立项、留观察（#37）；域改动 locality 收敛到单文件；族间协作经 Store 门面（与消费面同一接口）。re-export 垫片 store.ts 已由 #32 删除，`src/store/` 目录是唯一定义处。
- `write()` 深缝形状原样保住：小接口（事务+Touch）、大实现（revision 广播）不因分家而摊薄。
- 短期多一层门面转发（微小的运行时开销，可忽略）；将来若收窄接口，门面是唯一要动的面。
- 与 ADR-0001（SQLite 唯一事实源、单写者）、ADR-0002（实例锁）完全一致：拆的是代码分家，不是写路径。
