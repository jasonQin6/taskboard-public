# daemon 会话的 hook 覆盖矩阵与会话权限面契约

日期：2026-10-31｜状态：已接受（issue→PR daemon 设计文档的组成节，#68 固化）

来源：2026-10-31 daemon×DWF 只读审查 + 拷问定案。父文档是 `docs/research/2026-10-30-zcode-issue-to-pr-daemon.md`（启动面见其第二节，YOLO 残余风险见其第八节）；本文件把其中散落的 hook 与权限结论收敛成契约，后续 daemon 实现票据以本文件为准，不得各自发挥。hook 的注册与脚本资产不在本文件（#66 一族）；写路径纪律引用 ADR-0023。

文中 ZCode file:line 均已于 2026-10-31 在 `$HOME/Documents/workspace/ZCode` 逐条核对；路径相对该根（`packages/shared/…` 在仓根，`core/…` 等其余在 `apps/zcode-cli/packages/` 下）。源码会漂，判定以各格的契约句为准，行号只作定位。

## 一、hook 覆盖矩阵

ZCode workspace hook 分两级（`packages/shared/src/workspace-hook-config.ts:10-16`）：

- **工具级**：PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure，随每次工具调用派发；
- **会话级**：SessionStart / UserPromptSubmit / Stop，随回合/会话生命周期派发。

| hook 事件级 \ 执行面 | 主代理工具调用¹ | DWF 子代理工具调用² | world.run³ | 会话生命周期⁴ |
|---|---|---|---|---|
| **工具级** | 覆盖（契约）⁵ | 覆盖 | **不覆盖**（ZCode 契约） | 不适用 |
| **会话级** | 不适用 | 不适用 | 不适用 | 覆盖（父会话与子代理会话均触发）⁶ |

1. daemon 的 headless 启动器 / app-server 直启会话里的真实工具调用。管控手段 = 权限面四件套之二（PreToolUse deny hook，见 §2）。
2. DWF actor 会话里的真实工具调用（`CreateWorkflow` / `AmendWorkflow` 及普通工具）。子代理会话由 app 会话工厂创建、与父会话同 cwd，加载同一套 hook，deny hook 对其同等生效。注意：DWF 工作流的 facade op（`files.*` / `git.*` / `world.run`）全部经 workflow driver 端口执行、不进工具执行器（`apps/zcode-cli/packages/bootstrap/src/app/workflow-world-read.ts:40-43、66-94`），不属于本列——它们与本列的区分就是矩阵第 3 列存在的原因。
3. `world.run` 直连 executionPort（同文件 `:311`），不经权限系统与任何 hook，这是 ZCode 写死的契约（同文件 `:294`「授权只在编译期：cmd 必须是字面量（9003）」）。管控手段 = 四件套之三、之四（字面量白名单静态审计 + env 无凭据化，见 §2），全部在启动前，运行期没有第二道闸。
4. 回合/会话边界事件（SessionStart / UserPromptSubmit / Stop）。
5. deny 在权限判定之前生效：`runPreToolUseHooks` 与 deny 短路（`apps/zcode-cli/packages/core/src/tool/executor/impl.ts:112-121`）先于 `resolveToolPermission`（同文件 `:126`），模式不参与该短路，任何 mode 含 yolo 均拦得住——这是 §2 敢在 yolo 会话上靠 deny hook 收窄权限面的全部依据。
6. 会话级 hook 按会话 cwd 加载，DWF 父会话与子代理会话同 cwd、加载同一套，Stop 对两者都会派发。

**部署现状（2026-10-31，安装版 zcode.cjs 0.17.0）**：workspace hook 派发受 `workspaceHookTrustEnabled` 门控，CLI host（`-p` 路径）从不置位，两级 hook 在 `-p` 会话均不派发（decisive 证据：`~/.zcode/cli/log/zcode-2026-10-31.jsonl` 的 `workspace_hook.feature_disabled`，见 `docs/retros/2026-10-31-issue66.md`）；派发面 = app 会话工厂，含 app-server `createSession` 主路径与 DWF 子代理路径（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:3550` 置 `true`）。设计推论：deny hook 与 Stop retro 的可用性绑定在 app-server 主路径上；`-p` 只是 fallback，其权限管控退回「启动 prompt 只调 `CreateWorkflow`」+ headless deny broker（headless 下除 `CreateWorkflow` / `AmendWorkflow` 外需权限的工具全拒，`apps/zcode-cli/packages/cli/src/headless-workflow.ts:15-46`），其会话不产 retro/combo 行是已知缺口而非设计。

### 推论一：`.git` 边界——detach worktree 天然不在 hook 管控面内

hook 发现从会话 cwd 向上到第一个含 `.git` 的目录为止，只收集沿途的 `zcode.json` / `.zcode/config.json`（`packages/shared/src/workspace-hook-config.ts:174-178、299-312`）；worktree 的 `.git` 标记**文件**同样命中边界。因此 auditor 等角色的 detach worktree 会话不加载主仓的项目 hook：worktree 内的管控靠 MEA 批次纪律与门禁复核，不靠 hook；也不要往 worktree 里复制 hook 注册来「补全」，那会制造第二套会漂移的注册面。

### 推论二：`dwf-` 排除门——会话级 hook 脚本的强制自防

Stop hook 无 session-type 门：DWF 子代理会话（session id 前缀 `dwf-`，形如 `dwf-<runId>-<site>@<ord>`）与父会话同 cwd、加载同套 hook，一次 DWF run 的每个子代理收尾都会触发 Stop。落在仓库 `.zcode/config.json` 的一切会话级 hook 脚本因此必须自带 `dwf-` 前缀退出门（已落：`scripts/stop-retro.sh`），否则一次 run 会注入 N 次 retro 收尾、写 N 行脏数据。配套纪律：hook 落库必经 `taskboard` 短命 CLI 的事务层，不自开连接直写库（ADR-0023），并用 `ZCODE_HOOK_GUARD` 防环。

## 二、会话权限面契约

daemon 的 headless 会话（app-server 直启为主，`-p` fallback 为辅）权限面 = 下面四件套，缺一即视为破坏契约：

1. **yolo（headless 缺省）**。`-p` 缺省 mode = yolo（`apps/zcode-cli/packages/cli/src/run.ts:52`）；app-server 路径显式 `createSession.config.mode = "yolo"`。why：headless 无人值守，turn 不能挂在权限请求上；不显式传则 workspace 默认模式可能把 subagent 降成 build/guarded，在权限请求上永久卡死。残余风险（yolo = 完整本机权限）由 2/3/4 收窄，父文档第八节。
2. **PreToolUse deny hook**。deny 清单：`gh` / `git push` / `curl` / `wget` / `sudo` / `rm -rf` / 越界与敏感路径 Read（`~/.zcode/cli/config.json`、`~/.config/gh/hosts.yml`、`~/.ssh/` 等）。依据矩阵第 1 列第 5 格：deny 先于权限判定、任何 mode 均拦得住，是 yolo 会话唯一的运行期拦截层。
3. **saved 工作流 `world.run` 字面量白名单**。编译期 9003 已保证 cmd 是字面量、脚本能跑的命令在提交前全部可枚举；daemon 在启动前对 saved 工作流做静态审计，白名单只放行 `git` / `pnpm` 等固定命令，issue 文本只进 subagent prompt、不进命令名（父文档四道边界之 1、4）。why：`world.run` 对权限系统与 hook 双盲（矩阵第 3 列），启动前审计是唯一管控点，运行期没有补救手段。
4. **env 无凭据化**。启动子进程时置空 `GH_CONFIG_DIR`，剥除 `SSH_AUTH_SOCK` / `GIT_ASKPASS` / `GH_TOKEN` 等凭据变量。why：daemon 独占全部远端写操作（父文档已确认决策 3），ZCode 子进程的合法凭据需求为零，env 是权限面中成本最低的收窄点。注：这挡不住主动读本机凭据文件的 subagent（父文档第八节残余风险），首版明确接受。

四件套中 2 的可用性受部署现状约束（见 §1）：在安装版 0.17.0 上它只保护 app-server 主路径；`-p` fallback 靠件 1 的启动纪律与 headless deny broker 兜底。upgrade 后应复跑 #66 复盘建议的前置探测（`grep workspace_hook ~/.zcode/cli/log/<当日>.jsonl`）确认派发面变化，再调整兜底叙述。

## 三、交互会话与 yolo 解耦

retro 触发不再依赖 yolo 门：#66 已删 `permission_mode == yolo` 门（交互会话也要 retro），`scripts/stop-retro.sh` 中 mode 只作 source 标注（headless / interactive），不作门。契约推论：**yolo 只出现在 daemon 的 headless 会话**；任何新代码不得把 `permission_mode == yolo` 当「daemon 会话」的判别式。判别 daemon 会话的依据是启动来源（app-server `createSession` / `-p`），hook 侧判别 DWF 子代理用 `dwf-` 前缀（推论二）。

## 事实源

- hook 事件枚举与两级分类：`packages/shared/src/workspace-hook-config.ts:10-16`
- hook 发现边界（`.git` 目录与 worktree 标记文件均命中；候选文件 `zcode.json` / `.zcode/config.json`）：同文件 `:174-178`、`:299-312`
- PreToolUse deny 先于权限判定：`apps/zcode-cli/packages/core/src/tool/executor/impl.ts:112-121`（deny 短路 `:121`，`resolveToolPermission` `:126`）
- headless `-p` 缺省 yolo：`apps/zcode-cli/packages/cli/src/run.ts:52`
- `world.run` 直连 executionPort、授权只在编译期（9003 字面量）：`apps/zcode-cli/packages/bootstrap/src/app/workflow-world-read.ts:294`、`:311`
- DWF facade op 走 driver 端口、不进工具执行器：同文件 `:40-43`、`:66-94`
- app 会话工厂的 hook 派发面（`workspaceHookTrustEnabled: true`）：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:3550`
- headless deny broker：`apps/zcode-cli/packages/cli/src/headless-workflow.ts:15-46`
- 部署缺口（`-p` 不派发 workspace hook）：`~/.zcode/cli/log/zcode-2026-10-31.jsonl`（`workspace_hook.feature_disabled`），复盘 `docs/retros/2026-10-31-issue66.md`
