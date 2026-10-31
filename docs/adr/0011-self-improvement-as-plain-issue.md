# ADR-0011：自改进是普通 issue，无常驻 runner

日期：2026-10-21｜状态：已接受

## Context

V1 的常驻每日 self-improve 循环与专用 RSI runner 重复了 harness 已提供的能力，且构成一个长期自我修改的后台风险面。

## Decision

- 删除常驻自改进循环与专用任务类型语义；"自改进"表现为目标 workspace 为 taskboard 本身的普通 issue（source=self_improvement）。
- 隔离由通用 `isolated_worktree` 模式提供：从基准分支创建 worktree 与 branch，把该目录作为 cwd 交给 harness；主工作区不被直接修改。
- setup、checks、commit、报告与人工审查要求由 issue 内容和验收标准表达；taskboard 不内置专用流程。
- 不自动 push、不自动 merge、不自动重试；worktree/branch 保留到任务验收后的显式清理，失败时保留证据。

## Consequences

- 自改进与其他任务共用同一套验收、证据与审计语义，专用 runner 代码全部删除。
- 每日循环不存在（用户故事 69），无后台自我修改通道。
