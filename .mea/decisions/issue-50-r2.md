# MEA decision — issue #50 r2

- issue: https://github.com/jasonQin6/taskboard/issues/50
- profile: `$HOME/.codex/skills/MEA/projects/jasonQin6-taskboard.md`
- branch: `codex/issue-batch`
- base_sha: `fb45bbb447578d04bf17508ebc07d69ec2e5a20f`
- implementation_sha: `62bc0293986bb478e765a7f29db1a5c691ceb9b4`
- target_sha: `62bc0293986bb478e765a7f29db1a5c691ceb9b4`
- audit_commit: `f6cca4b486e1cbd0a67451c6c56058883c634a0c`

## decision

`changes-requested`

## gate

| Gate | Result | Evidence |
|---|---|---|
| report 的 issue/base/target 与 dispatch 一致 | pass | 报告头明确记录 r1 decision 的四项返工构成本轮 scope |
| target 仍是 reviewed head | pass | audit commit 的唯一 parent 是 `62bc0293986bb478e765a7f29db1a5c691ceb9b4` |
| 验收命令有退出码与结果 | pass | 两轮全量测试分别 524/525 pass，目标测试 90/90，typecheck 三段通过 |
| diff 在 scope 内 | pass | 6 个 changed files 全部位于 r1 允许范围 |
| claim_integrity clean | pass | implementation commits 与最终 diff 一致，未发现矛盾声明 |
| 无未关闭 critical/high | pass | 0 critical / 0 high |
| medium 有接受理由或关闭 | fail | F50-B1 是 r2 新引入的 medium，且修复边界明确 |
| Standards/Spec 两轴完成 | pass | 报告分别记录两轴；顺序执行造成的独立性降低已披露 |
| OCR 覆盖与 uncovered 记录 | pass | 两组均 exit 0、3/3 completed，无 unreviewed path |
| domain review | pass | 报告记录 `domain-review: pass` |
| audit 与 decision 证据可定位 | pass | 报告提交仅含报告文件，parent 精确等于 target |

## findings disposition

- `F50-B1`：不批准。`rewritten=true` 时本轮重放会先删除同 source 的旧 turn，之后不能再用这些旧 ordinal 为 merged session 播种 coverage。r3 必须增加 `rewritten` 门控，并用 rewritten + merged-session + 同窗 compaction 的测试证明不会写入失效 coverage。
- `F50-B2`：接受为不阻塞的 low。两种布尔转换在当前 `INTEGER NOT NULL DEFAULT 0` schema 下等价，纳入后续一致性清理。
- `F50-B3`：接受为测试强度说明，不是产品缺陷。A2 的端到端防退化已由 HTTP superseded 用例覆盖。

## next

从当前 audit commit 开始新开 r3 返工轮。新的 executor 只修 F50-B1 并补一个能证明重写门控的回归测试；随后由新的 Auditor 审计新的 target SHA。不得重新打开 r1 已关闭的四项。
