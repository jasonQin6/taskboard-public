# ADR-0003：JSONL 为会话权威来源，扫描只读

日期：2026-10-21｜状态：已接受

## Context

Codex 自身维护 state/history SQLite 投影，但那是它的内部实现，可能随版本重建；会话事实必须锚定在 rollout JSONL 上，taskboard 不得成为 Codex 存储的第二个写者。

## Decision

- Reader 的主输入是 `CODEX_HOME` 下的 `sessions` 与 `archived_sessions` rollout JSONL（`.jsonl` 与 `.jsonl.zst`，解压用 Node 内置 zlib 的 zstd API）；`session_index.jsonl` 只作发现加速，正确性只依赖目录扫描。
- session 身份以 `session_meta.id` 为准；source unit 以 inode 为主键（path 只是属性），文件在两个目录间移动不破坏幂等。
- taskboard 的 SQLite 只保存派生数据与脱敏短摘录，不复制完整 transcript。
- 扫描对 Codex 存储只读。唯一写邻接例外：已绑定 Task 的线程经显式 resume/sample 接管写锁并可能把 `.jsonl.zst` materialize 为 `.jsonl`，必须落审计；Inbox 未绑定线程永不 resume。

## Consequences

- Codex 投影数据库重建不丢事实；跨版本兼容靠 parser version 管理增量游标。
- "taskboard 何时碰过 Codex 存储"完全可由审计表回答。
