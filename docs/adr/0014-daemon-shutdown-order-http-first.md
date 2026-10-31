# ADR-0014：daemon 关闭顺序——先停 HTTP 排空，再收服务，最后 db 与锁

日期：2026-10-23｜状态：已接受

## Context

daemon `close()` 的原顺序是 ticker→scheduler→reader→goals→jev→power→runs/driver→http→db→锁：HTTP 监听最后才停，整个服务拆除期间仍在收新请求——新动作与关闭中的服务赛跑，大多落成 409 而非「正在关闭」；且不被任何 service close 排空的慢 handler（如 worktree fs 操作、scan.refresh）可能在 `db.close()` 之后仍在 executeAction 里，碰已关闭的 SQLite 句柄。此前的顺序约定只存在于 daemon.ts 头注释（「关闭顺序相反」）与 goals.ts 注释（「in-flight 动作在 runs/driver close 前收敛」），从未进 ADR。

## Decision

关闭固定三段，顺序不得再调换：

1. **先停 HTTP**：结束 SSE 长流、断空闲 keep-alive 连接、`server.close()` 停收新连接并**排空在飞处理器**（应答仍可送达；其 store/driver 调用发生在一切仍全开时），全部排空后再 `closeAllConnections()` 兜底断连。
2. **再收服务**：ticker/scheduler/reader/goals/jev/power/driver/runs 逐级收敛。
3. **最后 `db.close()`，锁最后释放**。这两条是底层不变量（ADR-0002）：db 只能在一切写者停止之后关闭；锁释放之后才允许下一个 daemon 接管同一数据库。

## Consequences

- 拆除期间不可能有任何 handler 存活去触碰正在关闭的资源；新连接在关闭开始的瞬间即被拒（连接拒绝），不再产生 409 噪声。
- 在飞请求的应答可以正常送达，调用方（CLI/测试）不会把优雅关闭误判为网络失败。
- 关闭耗时受最慢在飞 handler 支配：loopback-only 面（ADR-0007）下这是亚秒级常态；挂死 handler 会挂住 close，由 CLI 信号路径的 `process.exit` 兜底。
- 不 supersede 任何既有 ADR：旧顺序只在代码注释里，本 ADR 取而代之成为唯一出处，注释同步改写。
