# ADR-0010：Jev 只选不写——输出永远只进 proposal

日期：2026-10-21｜状态：已接受

## Context

rollout 与证据内容是不可信数据；概率模型直接改状态机会被注入文本与幻觉劫持。

## Decision

- Jev 是选择与语义判断层，不是状态存储、读取器或执行器：通过 driver 的一次性 ephemeral 调用执行，不写原 thread、不改会话状态，用 Codex 自身凭据。
- 输入按不可信数据处理；输出必须是结构化 JSON（needs_attention、progress、summary_short、候选数组、recommended、confidence），候选限定固定枚举：continue_thread、retry_run、create_child_task、annotate、ask_user、mark_blocked、mark_done、no_op。
- 非法输出、选项越界、超时、连接错误都按失败处理：只保存失败提案，不自动推进。
- 输出永远只进 proposal，不直接进状态机；confidence 不是正确率，自动执行阈值由 shadow 数据校准。
- 自动执行的 continue_thread 只允许固定模板，变量白名单仅 taskboard 自有字段；Jev 输出与 rollout 文本不得进入外发消息。

## Consequences

- 状态机可完全确定性测试；Jev 故障的最坏后果是多一条失败提案。
- 自动消息带 taskboard 来源标记并可完整审计。
