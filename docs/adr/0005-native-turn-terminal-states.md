# ADR-0005：终局判定只认原生 turn 终态

日期：2026-10-21｜状态：已接受

## Context

用模型判断"任务是否完成"会被自述劫持；任意带 thread id 的事件行或 item 完成事件也不能当作 turn 终局，否则状态机被协议噪音驱动。

## Decision

- Codex 终局只认 `event_msg` 记录内的变体：`task_started` → running、`task_complete` → completed、`turn_aborted` → interrupted、error 事件 → failed。
- 顶层记录类型与 item 完成事件永不作 turn 终态。
- `turn_aborted` 是 interrupted 而非 failed；interrupted 不算 Run 硬失败。
- goal completion、语义状态（waiting_user/blocked/needs_attention 等）只作证据或徽标，不直接驱动列。

## Consequences

- 硬状态可确定性测试，不依赖模型判断。
- Codex 升级新增 item 类型时只需扩展 parser 归类（未知 item 降级 opaque 证据），不推翻状态机。
