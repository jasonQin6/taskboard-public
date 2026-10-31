# issue-worker

GitHub issue → PR 无人值守 daemon：确定性控制面（Node，只用内置模块）驱动
ZCode saved Dynamic Workflow（`issue-to-pr` / `auditor`，由 `.zcode/workflows/` 提供）。

契约：`docs/research/2026-10-30-zcode-issue-to-pr-daemon.md` + `cli.ts --help`。
本目录只实现 daemon 侧；`.zcode/workflows/*.dwf.ts` 由另一 worker 拥有，不要碰。

首版边界：一个 active job、YOLO 执行。默认以 PR 为交付终态并转 `ready-for-human`；
显式开启 `autoMerge` 后，只有双路审计、GitHub 强制规则、检查输入和路径策略同时满足才会自动合并。
进程在 `accepting` 阶段重启会校验并重放交付；更早阶段重启会保留现场并转人工，避免重复 run。
人工返工会重置轮次并复用原分支/PR；已推送分支对齐主干用 merge，未推送分支才用 rebase。
PR 正文和交付评论会写入实现摘要与改动清单、审计 verdict、非阻断 findings、审计证据和未覆盖项；列表超过发布上限时明确标出省略数量。

## 受控自动合并

自动合并默认关闭。开启后，ZCode auditor 与 `ocr review` 必须在同一 `baseSha/headSha`
分别通过；OCR 命令非 0、输出缺失、JSON 损坏、`status != complete` 都按失败处理。
OCR manifest 必须同时声明 `resolved_base` 与 `resolved_head`，并分别精确匹配待合并
的 base/head。`exact_range` 只作为额外一致性检查，不能替代 resolved SHAs。
`coverage.selected` 的每一项还必须以相同 fingerprint 出现在 `coverage.completed`
或 `coverage.reused`，且 `failed/waived` 为空；变更涉及 `src/**` 时，每个文件都必须
出现在 selected 覆盖中。部分结果即使以 0 退出也不能放行。
OCR 的 429、provider 与网络类失败按 `timeouts.infraBackoffMs` 退避重跑；耗尽后转
`needs-info`，provider 配置或权限类硬错误直接转人工。
OCR 子进程会移除 GitHub 与 GitHub Actions 凭据，避免第二审计源继承控制面的远端写权限；
OCR 自身凭据保留。
critical/high/medium finding 阻断，low 只记录不阻断；dismissal 可按 finding id，或按
file glob 加正则 pattern 匹配，并保留原 finding 与驳回理由。

合并前还要通过 GitHub API 读取目标分支的 branch protection、rulesets 与仓库默认分支。
branch protection 或 ruleset 任一提供 required status checks、strict freshness 且没有
bypass actor 即可；`~DEFAULT_BRANCH` 绑定仓库真实默认分支，不绑定配置的 `baseBranch`。
只检查强制层声明的 required check contexts，可选 check 的 `skipped/neutral` 不阻断。
check 未注册、`queued/in_progress`、PR `mergeable=null` 或临时 API 读取失败会保持
`accepting`，按 `timeouts.mergeMs` 等待后重试；超时才转 `ready-for-human`。
check runs 与 commit statuses 各自可读时独立判定；一个来源不可读不会跳过另一个来源的失败。
规则缺失、永久不可读、SHA/base 漂移、required check 失败、合并 API 409/422 等硬错误立即拒绝。
branch protection/rulesets API 返回 403 时不会降级为“本地检查已绿”。当前私有个人仓受套餐
限制，预期会走人工路径。

merge API 始终传审过的 `sha`；409/422 视为 head 已变，不重试。`merge_pr` outbox 以
`branch:head_sha` 为幂等键。已确认成功或远端已合并的重放不会再次调用 merge；结果未知时
outbox 保持 pending，下轮先重读 PR，必要时用同一 SHA 重试。合并成功后写 `merged` 事件、保留证据、
issue 转 `ready-for-human`，不 approve、不 close issue。审计之后、任何 push/edit/create
或 merge 之前，controller 会在同一 head SHA 重跑最终门；红门不会产生远端写。
合并后的证据评论与 label 收口失败时 job 保持 `accepting`，下次扫描按精确评论查重并补齐。
重试共享 `mergeMs` 墙钟期限；超时后转 `ready-for-human`，不会永久占用 active job。
全部成功后才写 `merged` stage。

## 运行

```sh
# 单张 issue 跑到终局（首张 E2E 用法）
node --experimental-strip-types tools/issue-worker/cli.ts run --issue 49 --once

# 常驻（默认每 5 分钟扫 ready-for-agent）
node --experimental-strip-types tools/issue-worker/cli.ts daemon

# 只看状态 / 释放卡住的 job
node --experimental-strip-types tools/issue-worker/cli.ts status
node --experimental-strip-types tools/issue-worker/cli.ts release --issue 49
```

生产不依赖 tsx：所有文件只用可擦除 TS（无枚举/命名空间/参数属性），直接跑在
Node >= 24 类型剥离下。新增文件后先跑
`node --experimental-strip-types --check` 自证。
`daemon --help`、`run --help` 等帮助路径不加载配置，也不访问 GitHub。

ZCode 0.17.0 已用非法参数完成两个 saved workflow 的无模型实机烟测：`createSession` →
`conversation/subscribe` → `startSavedWorkflow` → `dwf_run` 结算均通过。带模型 subagent 的
真实 issue → PR 仍以首张 E2E 为准。

## 配置

`--config PATH`，否则 `<stateDir>/config.json`，否则内置默认。
校验 fail closed：未知键、相对路径、非法值直接拒绝启动；
repo 目录、ZCode 二进制与 ZCode DB 不存在也拒绝启动。

```json
{
  "autoMerge": {
    "enabled": true,
    "allowedScopes": ["docs", "test"],
    "dismissals": [
      { "id": "0123456789abcdef", "reason": "已确认的上游误报" },
      { "file": "test/**", "pattern": "generated fixture", "reason": "稳定 fixture" }
    ]
  },
  "timeouts": { "ocrMs": 1800000, "mergeMs": 1800000 }
}
```

`allowedScopes` 只接受 `docs`、`test`、`src`。默认只放开 docs+tests；显式加入 `src`
才会考虑非受保护的 `src/**`。`.github/`、`.zcode/`、`tools/issue-worker/`、`src/store/`、
`docs/adr/`、迁移文件、lockfile、`.env*` 与密钥/权限相关文件始终禁止自动合并。
启用自动合并时 `allowedScopes` 不能为空；dismissal 的 `id` 与 `file/pattern` 不能混用。

运行时状态（仓库外，避免跟随分支切换）：

- macOS：`~/Library/Application Support/zcode-issue-worker/state.sqlite3`
- 日志：`<stateDir>/runs/<issue>/attempt-implement-<n>-exec-<n>/` 等

## 文件

- `cli.ts` — daemon/run/status/release，help 即契约
- `config.ts` — 配置加载与校验
- `store.ts` — node:sqlite（job/run/outbox/event）+ BEGIN IMMEDIATE + 单例锁
- `github.ts` — gh CLI 确定性调用 + 选票/摘要/label/幂等键纯函数
- `git.ts` — 分支/slug/SHA 校验 + 无 shell git 封装
- `zcode.ts` — v4 帧/commandId/重试分类/64KiB 截断/DB 只读兜底
- `merge-gate.ts` — OCR 第二审计、finding dismissal、路径策略、GitHub 强制门与 merge API
- `daemon.ts` — reconcile、选票、状态机、交付序列、accepting 幂等恢复
