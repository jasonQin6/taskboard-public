# ADR-0004：单条 Codex 写路径与单飞

日期：2026-10-21｜状态：已接受

## Context

两条并行写路径（例如 CodexHost 与 taskboard 各持一个 app-server）会在 Codex 写锁层互相破坏，错误难以归属，重复创建风险不可控。

## Decision

- daemon 持有一个长驻 Codex app-server 子进程，承担全部写操作（create/send/cancel/goal/sample）；直连必须走 experimental API opt-in 的 initialize 并做能力探测（capability registry 只登记实际可调用的能力）。
- 每次写操作使用稳定 request ID 幂等；错误、busy 或超时不得静默切换为另一条写路径，必须记录明确错误或等待人工重试。
- 同一 thread 至多一个 in-flight 写操作，send、cancel、goal set/pause/clear、sample、提案执行全部计入：进程内 SingleFlightRegistry 是主规则；app-server 写锁返回 Conflict 表示外部持有——排队或明确拒绝并记录，绝不并行、不做跨进程队列。
- CodexHost 不进入运行时主链；未来复用其进程管理的前提是不产生第二条 app-server 写路径。
- 自驱 turn 一律 `approval_policy=never` 加 sandbox；审批出口是用户在 Desktop/TUI 打开线程，daemon 不提供审批应答面。

## Consequences

- Conflict 是显式状态（held），不是隐式失败；单飞语义可用假 app-server 确定性测试。
- 接入第二个 harness 时，Harness Driver 接口是唯一接入面。
