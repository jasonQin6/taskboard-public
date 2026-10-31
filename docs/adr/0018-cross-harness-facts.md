# ADR-0018：跨 Harness 事实源与 source identity

日期：2026-10-26｜状态：已接受

## Context

Taskboard 当前以 Codex thread 为身份和事实模型。Phase 1 要观察多个 Harness，但各 Harness 的存储、schema 和更新节奏不同：Codex 以 rollout JSONL 为权威，ZCode 以本地 SQLite 为权威。强行统一到 app-server 或 ACP 会引入额外运行时，且 ACP 不提供全局会话枚举。

## Decision

- Harness 是 native session、transcript、turn、summary、memory、分组和执行能力的权威源。
- adapter 默认只读，不写 Harness 的 JSONL、SQLite、文件或配置。
- 跨 Harness 身份使用 `(harness_id, native_session_id)` 唯一键；外部统一通过 `SourceLocator` 引用。
- Codex 继续以 rollout JSONL 为权威事实源，按 ADR-0003 只读扫描。
- ZCode Phase 1 允许以 `sqlite3 -readonly` 读取权威 SQLite，但必须 schema 钉扎；版本或结构不匹配时降级为 unknown。
- 不为统一读取强行引入 app-server 或 ACP。ACP 只属于执行控制面，不是记忆源。
- 归一化索引必须可从 Harness 源数据重建；每条证据保留可回源的 locator。
- 未知字段、未知 item 类型和 schema 漂移只影响对应记录，不阻塞整个 Harness。

## Consequences

- 跨 Harness 的 adapter 可以独立演进，但共享 identity、cursor 和 provenance 契约。
- ZCode 的 schema 风险被限制在 adapter 内，并通过 unknown 降级暴露。
- 现有 Codex-first 的 `threads.id` 在接入第二个 Harness 前必须迁移。
- 未来 app-server payload 有稳定文档后，可作为优先读路径；另立 ADR 决定替换 SQLite。
