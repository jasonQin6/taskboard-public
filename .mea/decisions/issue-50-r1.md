# MEA decision — issue #50 r1

- issue: https://github.com/jasonQin6/taskboard/issues/50
- profile: `$HOME/.codex/skills/MEA/projects/jasonQin6-taskboard.md`
- branch: `codex/issue-batch`
- base_sha: `d48277ddb8e301dfc3e2148398480e02d5ae34f4`
- implementation_sha: `91d0b4c4d5a7712be88acb36f58f2e6aafa61d91`
- target_sha: `91d0b4c4d5a7712be88acb36f58f2e6aafa61d91`
- audit_commit: `01280b4c556869ac8b0891206337b1861f2d2cd7`

## decision

`changes-requested`

## gate

| Gate | Result | Evidence |
|---|---|---|
| report 的 issue/base/target 与 dispatch 一致 | pass | 报告头与 `.mea/dispatches/issue-50-r1.md` 一致 |
| target 仍是 reviewed head | pass | `git rev-parse HEAD` = target，worktree clean |
| 验收命令有退出码与结果 | pass | `pnpm test` 522/521/1skip、`pnpm typecheck` 0、`pnpm test:ui` 36 |
| diff 在 scope 内 | pass | 13 文件全在 dispatch 允许范围 |
| claim_integrity clean | fail | 控制台回执与落盘报告结论相反 |
| 无未关闭 critical/high | pass | 0 critical / 0 high |
| medium 有接受理由或关闭 | fail | 回执列 4 条 medium 未关闭 |
| Standards/Spec 两轴完成 | pass | 报告两节 + 独立性说明 |
| OCR 覆盖与 uncovered 记录 | pass | 3 组 pass，partial 已入 uncovered |
| domain review | pass | 报告 `domain-review: pass` |
| audit 与 decision 证据可定位 | pass | 两个 commit 均可解析 |

## 为什么不 approve

报告正文判 `green`，但审计员回执写 `not-green`、`claim_integrity=suspect`、4 条 medium 未关闭。两者严重度定级不一致；回执里的 F-M1..F-M4 与报告里的 F50-A1/A2/A3/A10 是同一组问题。

按报告字面可以放行，但那等于用"回执不算证据"的条款掩盖一个真实的结论冲突。已逐条对照源码核实，四条都成立：

- `src/store/thread-store.ts:1039` `latestThreadSummaries` 外层 SELECT 漏 `superseded`；
- `src/http.ts:406` `locator:null` 时顶层仍携带旧定位字段；
- `src/reader/scanner.ts:469` `mergeKnownTurnState` 不补 `coveredThroughTurnOrdinalByThread`；
- `src/store/thread-store.ts:905` rewritten supersede 未对受影响 thread 发 `touch()`。

## next

新一轮从 `in-progress` 开始，用新的 executor 修 4 条并补测试，再交给新的 Auditor 审计新的 target SHA。
