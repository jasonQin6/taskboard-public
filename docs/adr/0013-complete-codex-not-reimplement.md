# ADR-0013：taskboard 是 Codex 的补全层，先封装再补充

日期：2026-10-22｜修订：2026-10-26｜状态：已修订

## Context

V1 曾自行实现 goal judge、workflow 路由、多执行器协议与专用自改进 runner，重复了 harness 已有能力，也让架构边界变模糊。V2 已经删除这些实现，但还缺一条显式规则：后续需求凭什么判断该做、该封装还是该拒绝。没有这条规则，同样的重复会以新功能的名义长回来。

## Decision

- **定位**：taskboard 是各 Agent Harness 的观察与任务补全层，不是第二个 harness。
- **优先级**：Harness 已有 → 只做封装；Harness 没有且属于任务中心或观察语义 → 才补充；两者都不属于 → 不做。
- **封装**只做能力探测、协议适配、provenance 与审计，不复制语义，不自造降级实现。行为必须与 Codex 原生一致，失败时如实暴露。
- **补充**仅限任务账本、五列状态机、Task↔Thread 绑定与 Inbox、提案与审计、任务级编排（cron/cascade/wait/防休眠），以及 Phase 1 的跨 Harness 归一化、人工 overlay 和语义进度判断。
- **准入依据**：新能力先按 `docs/research/2026-10-22-codex-capability-boundary.md` 的检查表判定归属；判不出归属的能力不做。
- **红线**：不重写 compaction、recap、approval、continuation；不生成替代 native summary；不建第二条 Harness 写路径；不往用户工作区写状态文件。

## Consequences

- 摘要与定时不再作为 taskboard 的自建能力：前者只使用 native compacted、sample 或 none，后者只定义任务级语义。
- 语义进度判断是独立补充能力，受 ADR-0019 约束；它不替代摘要，也不进入执行状态机。
- “夜间离线整理 + 补算”这类需求被判定为重复，不进入实现。
- 每次需求评审多一步：标注它属于封装栏还是补充栏；没有 ADR 支撑的补充项先补 ADR。
- Codex 能力演进时只需更新封装层，taskboard 的产品语义保持稳定。
- 本 ADR 与 ADR-0008、0009、0010、0011 一致，不新增相反结论。
