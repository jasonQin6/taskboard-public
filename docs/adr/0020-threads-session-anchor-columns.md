# ADR-0020：threads 保留会话行级锚点三列，豁免去规范化

日期：2026-10-26｜状态：已接受

## Context

`threads` 表带有 `source_path` / `source_byte_start` / `source_record_hash` 三列，取自扫描时该会话 `session_meta` 行的字节偏移与行内容 hash（`commitSourceScan` 按 session 传入）。曾有去规范化提案（B5）：删除三列，locator 改由 JOIN `reader_sources` 派生。逐字段等价性分析（B5a）结论：

- `source_path` 与 `reader_sources.path` 同值，勉强可经 `thread_turns.source_ref` 关联派生；但无 turn 的纯 meta 会话没有关联键，需要 fallback 兜底。
- `source_byte_start` 不可派生：它是 session_meta 行在文件中的起点（会话级锚点），而 `reader_sources.consumed_bytes` 是整个 source unit 的消费游标（unit 级）。单会话文件里两者位置不同；resume/fork 多会话共存一个文件时毫无对应。
- `source_record_hash` 不可派生：它是 session_meta 行的身份 hash，`reader_sources.prefix_hash` / `tail_hash` 是文件块级增量判定指纹，语义不同。

即：三列不是 `reader_sources` 的冗余副本，而是不同粒度锚点在库里的唯一存储。删除或改定义为 unit 游标都会改变 `SourceLocator` 的回源精度。

## Decision

- 保留 `threads.source_path` / `source_byte_start` / `source_record_hash` 三列，不做 schema v8 迁移；B5 按「不迁移」关闭。
- 三列语义固定为**会话行级锚点**（该会话 session_meta 行的出处）；`reader_sources` 语义固定为 **unit 级游标与指纹**。两者粒度不同、并存是有意设计，豁免去规范化。

## Consequences

- `SourceLocator`（ADR-0018）的 `sourcePath` / `byteStart` / `recordHash` 保持行级回源精度，detail 与 observe 载荷的 locator 契约不变。
- 第二个 Harness 落地时仍走此语义：归一化索引里的会话锚点进 `threads` 同构列，unit 级游标进各自 reader 的 source 表；不把 unit 游标冒充会话锚点。
- threads 表持续多带三个来源列；若未来确需收敛，须另立 ADR 并先证明存在与会话行级锚点等价的替代存储。
