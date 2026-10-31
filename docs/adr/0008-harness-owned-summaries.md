# ADR-0008：原生摘要优先，SystemOne 只补充语义判断

日期：2026-10-21｜修订：2026-10-26｜状态：已修订

## Context

自建摘要模型等于引入第二个概率运行时：成本、漂移、越权面都扩大，而且重复 harness 已有的 compaction 能力。Phase 1 又需要一个统一层判断会话是否推进、阻塞或等待输入，仅靠可能缺失或 stale 的原生摘要不足。两者必须分离：摘要仍优先由 Harness 产生，语义进度判断由受约束的 SystemOne 产生。

## Decision

- 摘要优先使用 Harness 原生能力：**compacted 基线**来自 rollout 的 compacted 记录；**sample 增强**（experimental）经能力探测后仅对满足 ADR-0008 原条件的线程启用。
- Summary 的 provenance 固定为 `compacted | sample | none`。
- SystemOne 不生成 Summary，不伪装 native summary。它只生成独立的 `ProgressVerdict`，provenance 为 `systemone:<provider>/<model>@<prompt_version>`。
- Phase 1 默认启用 SystemOne 的进度判断，默认 provider 为 Magpie；调用边界、缓存、预算、断路器和失败降级见 ADR-0019。
- 原生摘要缺失时显示 `none`，不沿用“由外部模型生成替代摘要”的旧禁令。
- sample 或 Jev 连续失败 3 次进入断路器：暂停该 thread 自动评估、落审计、人工 resume 恢复。

## Consequences

- taskboard 的摘要仍无替代模型；摘要可信度可直接从 provenance 读出。
- 进度判断与摘要分离，SystemOne 故障的最坏后果是显示 unknown 或 stale，不会伪造原生摘要或推进状态。
- resume/materialize 的写邻接审计由 ADR-0003 约束。
