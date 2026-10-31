# ADR-0022：审计通过后只对低风险切片执行受控自动合并

日期：2026-10-31｜状态：已接受

## Context

issue-worker 现行契约把 PR 交付视为终态：daemon 不 approve、不 merge，人工合并后由 GitHub 关闭 issue。这个边界降低了自动写入风险，但把每个低风险 issue 的最后一步都留给人工。

放开自动合并会改变硬不变量。审计通过只证明语义审查给出过 `approved`，不能证明 base/head 未变化、构建检查仍为绿、GitHub 侧存在真正阻止合并的规则，也不能证明变更处于可接受风险范围。调研 `$HOME/Documents/ObsidianVault/raw/research/agent-issue-to-pr-merge-gates-2026-10-30.md` 给出的 M0-M7 结论是：自动合并必须是绑定精确 SHA 的合取条件，而不是 auditor verdict 的直接延伸。

当前 taskboard 是私有个人仓，GitHub branch protection 与 rulesets API 受套餐限制返回 403。这个事实意味着自动合并能力必须实现为默认关闭、读不到规则即拒绝的产品路径，不能把本地检查当成平台强制。

## Decision

- 自动合并采用显式 opt-in。配置缺失或 `autoMerge.enabled=false` 时保持现状：只交付 PR，并转 `ready-for-human`。
- 两路审计必须独立。ZCode auditor 保留，OCR 作为第二源；两路都必须审查同一个 `base_sha/head_sha`，任一命令失败、结果缺失、会话未完成、JSON 损坏或 reviewed SHA 不一致都按审计不通过处理。
- OCR 必须从 manifest 证明实际审过的范围。`resolved_base` 与 `resolved_head` 必须同时存在，并分别精确等于待合并的 `base_sha/head_sha`；`exact_range` 只在存在时作为额外一致性检查，不能替代 resolved SHAs。缺失或互相矛盾时不得复用该结果。OCR 子进程不继承 GitHub token 与 GitHub Actions 凭据。
- OCR 还必须证明覆盖率没有缺口。`coverage.selected` 中的每个 item 都要以相同 fingerprint 出现在 `coverage.completed` 或 `coverage.reused`，且 `failed/waived` 为空。所有变更的 `src/**` 文件都必须出现在 selected；OCR 默认不审 docs/tests，这两层仍由 ZCode 审计、路径策略、确定性门与平台 required checks 约束。OCR 在预算耗尽时可能发布部分结果并以 0 退出，这种结果不能授权合并。
- OCR 的 429、provider 与网络类失败按 `timeouts.infraBackoffMs` 退避重跑，耗尽后转 `needs-info`；其他命令、解析或证据错误立即转人工。
- critical、high、medium finding 阻断自动合并；low 可放行但必须进入证据。dismissal 必须按 finding id，或按 file 与 pattern 同时匹配，并记录原始 finding 与驳回理由。
- 合并授权绑定 `repo`、`issue`、`pr_number`、issue 快照、branch、`base_sha`、`head_sha`、两路 verdict、finding、确定性门命令与退出码、GitHub Actions 在该 head 的 checks/statuses。任一输入在合并前变化，授权作废，不沿用旧结论。
- 合并前必须通过 GitHub API 确认目标分支有可读且生效的 branch protection 或 ruleset，并包含 required status checks、strict freshness 且没有 bypass actor。两层是 OR 关系；任一层有效即可，两层都有效时取 required check 的并集。
- ruleset 的 `~DEFAULT_BRANCH` 必须使用 `GET repos/{owner}/{repo}` 返回的真实默认分支，不得把配置的 `baseBranch` 冒充默认分支。仓库元数据读取失败或缺失时，ruleset 覆盖范围不可判定，不得放行。
- daemon 读取 head SHA 的 check runs 与 commit statuses 是“合并输入校验”，不是“平台强制”。只检查强制层声明的 required check contexts；required check 的 `success` 才通过，失败结论立即阻断。两个来源各自可读时独立判定，一个来源不可读不得跳过另一个来源的失败。未注册、`queued`、`in_progress`、PR `mergeable=null` 属于等待；非 required 的 `skipped`、`neutral` 不阻断。
- 临时网络、429、5xx 读取失败进入等待，保留 `accepting` 并受 `timeouts.mergeMs` 限制。硬错误立即转人工；等待超时也不得把缺失证据补成成功。
- 路径策略采用硬拒绝优先。`.github/`、`.zcode/`、`tools/issue-worker/`、`src/store/`、`docs/adr/`、数据库迁移、lockfile、`.env*`、依赖/权限/密钥相关文件永不自合并。默认只允许 `docs/**` 与 `test/**`；配置可显式加入 `src/**`。
- merge 使用 GitHub merge API 并传审过的 `head_sha`。409 或 422 视为 head 已变，不重试、不改成当前 head。`merge_pr` outbox 的幂等键包含 branch 与 head SHA；重放前先探测 PR 与 outbox。
- 审计通过后、任何 push/edit/create 或 merge 之前，controller 必须在同一 head SHA 重跑最终门；红门不得产生远端写。
- 合并成功后保留完整证据、写 `merge-started` 与 `merged` 事件、将 issue 转 `ready-for-human`，不调用 approve、不 close issue，也不把 merged 宣称为 production-safe。证据评论或 label 收口失败时保持 `accepting`，按精确评论文本查重并在后续扫描补齐；同一 `timeouts.mergeMs` 墙钟期限耗尽后转人工，全部成功后才写 `merged` stage。

## Consequences

- 默认行为仍停在人工合并，但配置显式开启且所有门通过时，低风险变更可以自动落地。
- 当前私有仓套餐下 branch protection/rulesets API 很可能返回 403，因此实际运行会稳定转入人工路径。这是预期结果，不是降级失败。
- 自动合并吞吐受 OCR、GitHub API 与规则可读性限制；拿不到证据时宁可停。
- 等待中的 required checks 不消耗新的实现轮次；`mergeMs` 到期后转人工，避免永久占用唯一的 active job。
- 已确认成功或远端已合并的同一 head SHA 重放不会再次调用 merge API。若响应丢失但远端已合并，以远端 PR 状态收敛；结果仍未知时保留 pending，并用同一 SHA 重试。
- 合并已经发生而评论或 label 失败时，重入只补齐收口，不重复 merge，也不重复已发布评论；重试受 `mergeMs` 限制，失败不会永久占用 active job。
- 合并结果只证明受控合入，不证明部署或生产健康。M7 的上线后验证仍需由发布链路另行提供。

## 明确拒绝

- 不因 auditor 返回 `approved` 就合并。
- 不在 base 或 head 变化后复用旧审计、旧检查或旧授权。
- 不在 branch protection/rulesets 不可读时降级为“本地检查已绿”。
- 不把 `~DEFAULT_BRANCH` 等同于配置的 `baseBranch`，也不在仓库默认分支不可读取时猜测 ruleset 覆盖范围。
- 不把 required check 的 `skipped`、`neutral` 或缺失当成成功。
- 不自动合并受保护路径、依赖声明或 lockfile、数据库迁移、密钥与权限文件。
- 不让 merge API 省略 `sha`，不因 409/422 自动重试为最新 head。
- 不在审计后复用旧 controller 门结果，也不在最终门为红时继续 push、edit、create PR 或 merge。
- 不自动 approve，不 close issue，不把 merged 状态当成 production-safe。
