# ADR-0019：SystemOne 进度判断边界

日期：2026-10-26｜状态：已接受

## Context

Phase 1 的刚需是判断会话是否在推进、阻塞或等待输入。Harness 原生状态能回答 turn 是否结束，但不能统一回答语义进度。完全依赖 Harness 摘要会受摘要缺失和陈旧限制；让任意 Agent 读取会话又会产生成本和写路径风险。

## Decision

- Phase 1 默认启用 SystemOne，经统一 provider 接口调用；默认 provider 为 Magpie。
- SystemOne 是带外单发模型调用，不是 Agent runtime，无工具、无 agent loop、无文件系统访问、无会话控制能力。
- Jev 是 SystemOne 的 provider 候选和动作选择层，不单独定义进度判断语义。
- SystemOne 只产生 `ProgressVerdict`，provenance 固定为 `systemone:<provider>/<model>@<prompt_version>`。
- `ProgressVerdict` 只进入徽标、原因和审计，不进入 Task、Run、Proposal 或自动化决策。
- 原生摘要仍是摘要首选；SystemOne 不生成伪 native summary。
- 输入只包含脱敏、截断的归一化 Evidence、原生状态、原生摘要和 overlay 上下文。
- 调用按证据指纹、provider、model、prompt 版本和问题版本缓存；无新证据不重判。
- 必须有单调用超时、并发上限、每日预算、连续失败断路器和逐调用审计。
- 失败、超时、超预算或输出非法时降级为 unknown、stale 或缓存旧值，并显示原因。
- 默认只判断 Kanban 可见或用户打开的会话，不后台无差别扫描全部历史。

## Consequences

- 进度判断的成本和外部数据流可审计、可预算、可关闭。
- 默认启用 Magpie 会产生 Evidence 外发；UI 必须展示当前 provider 和外发范围。
- 执行面的 Jev 与 Phase 1 的 SystemOne 共用 provider 基础设施，但语义和输出契约分开。
- Magpie 是否真正做到无工具、无循环需要独立探针与持续审计。
