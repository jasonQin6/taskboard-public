# ADR-0009：第一版只接 Codex，不预造扩展框架

日期：2026-10-21｜修订：2026-10-26｜状态：已修订

## Context

workflow catalog/runner、多 harness 抽象、动态插件系统在只有 Codex 一个实现时是假想负载；Codex 当前也没有稳定的、带 run identity 的通用 workflow API，skills/subagent 约定不能伪装成 deterministic workflow。

## Decision

- 不实现 workflow registry、catalog、选择器或 runner；Codex skills、subagents、slash commands 不当作 workflow 能力。
- capability registry 只登记经 app-server 实际探测到的 harness/model/thinking/permission 能力，探测不到就明确不可用。
- 不建立动态插件系统；Reader 层与 Harness Driver 层各定义生命周期/接口。
- 第二个 harness 已经出现，Phase 1 开始抽共享只读契约；Harness adapter 是读取接入面，Driver 是执行接入面。
- workflow catalog/runner 仍不实现。

## Consequences

- Phase 1 的跨 Harness 共享面只限读取、归一化、overlay 和展示；执行面继续保持 Codex-only。
- 接入新 harness 是“adapter 实现 + 能力清单”，执行能力接入仍另立 ADR。
- 未来 harness 具备稳定 workflow ID/参数 schema/invoke/run identity 时，再增加 harness-scoped workflow descriptor。
