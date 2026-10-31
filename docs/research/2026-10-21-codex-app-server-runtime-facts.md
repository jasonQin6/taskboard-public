# Codex app-server 运行时事实（2026-10-21）

> 本文记录 V2 需求评审时确认的外部行为，供实现与测试参考。它是证据，不是需求；Codex 版本变化后先更新本文，再改需求。

## CodexHost

- CodexHost shim 自 spawn 新的 app-server（包装 Desktop 自带 stock codex 二进制），不是共享实例代理。
- CodexHost CLI 已支持 delegate、send、cancel、read、wait、watch 和 list；没有 goal 与 workflow CLI。
- 因此它不能作为 taskboard 的第二条并行写路径；V2 主链直接使用自持 app-server 子进程。

## 写锁与 resume

- 线程“已加载”等于“持有该线程的跨进程写锁”（`CODEX_HOME/thread-writer-locks` flock），持至 unload/close。
- sample 的 loaded + idle 前置只对 taskboard 自己实例加载的线程成立。
- `thread/resume` 是写邻接操作：接管写锁，可能把 `.jsonl.zst` materialize 为 `.jsonl`；被其他进程持有时返回 Conflict。
- goal 与 send 若分属两个 app-server 实例，只能由写锁加单飞规则仲裁；V2 通过单实例避免该问题。

## thread/sample

- 本机 codex 0.163.0 无 `thread/sample`，仅 main 有。
- experimental 门控要求 initialize 携带 `capabilities.experimentalApi=true`。
- 请求为 thread_id + expected_turn_id + prompt（≤4000B），30 秒超时，返回纯 text。
- 线程必须加载在本实例且 idle，expected_turn_id 与最新完成 turn 一致。
- 采样在 ephemeral fork 中运行，不写原 rollout。

## 审批

- 自驱 turn 使用 `approval_policy=never` 加 sandbox；Codex 遇需审批动作会在 turn 终态停下。
- taskboard 不提供审批应答面；人工介入出口是 Desktop/TUI。

## 其他已确认

- Codex rollout JSONL 是权威历史；state SQLite 与 thread history SQLite 是投影或索引。
- compacted 记录的 `payload.message` 是 harness 自写摘要，auto/manual compact 均落盘，可零成本提取。
- goal API 已存在，但 continuation 时序、暂停和重启行为仍需真实探针验收。
- reader 设计参考：Recall 的跨 Agent 事件模型、Pixel 的字节增量与重写检测、sessions 的 Codex 真人消息判定、claudecodeui 的 fork/rollback turn 语义。
