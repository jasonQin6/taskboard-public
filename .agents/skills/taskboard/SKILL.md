---
name: taskboard
description: "Drive the taskboard V2 daemon through its CLI: create and manage tasks on the five-column board (backlog/todo/running/done/failed), run and cancel them through the Codex app-server driver, schedule them with cron, observe Codex threads (Inbox, bind, summaries), judge Jev proposals, wait until a task is quiet, pause/resume automation, and read board state as stable JSON. Use when the user asks to create/list/move/run/cancel/archive/delete/schedule/check taskboard tasks or work with Codex thread summaries and proposals."
---

# Taskboard CLI（面向 agent 的工具面）

Taskboard V2 是独立任务看板 daemon：SQLite 状态库 + cron 调度 + Codex thread 观察
（rollout 扫描进 Inbox → 绑定任务 → 摘要/证据 → Jev 提案裁决）。
你（agent）通过 `taskboard` 命令使用它。运行时真相源是 `taskboard help`——子命令用法与输出以它为准。

## 前提

- daemon 已在本机运行（默认 `http://127.0.0.1:47830`）。先 `taskboard status --json` 探测；
  exit 3 表示不可达，告知用户启动（`taskboard start`），**不要自己抢着起 daemon**（单实例锁，可能有别人在跑）。

## 铁律

1. **只解析 `--json` 输出**；不带 `--json` 的人读格式不保证稳定。成功输出带 `"ok":true`。
2. **只信退出码**：`0` 成功；`1` 语义失败/超时/能力未实现（stderr 一行人话）；
   `2` 用法错误（你的参数错了，先改参数再重试）；`3` daemon 不可达。错误无栈回溯。
3. `create` 成功回包是 `{"ok":true,"task":{…}}`，**记下 `task.id`**，后续一切操作用它。
4. 字段集合只增不删：容忍未知字段，不要依赖字段顺序。
5. 写命令可带 `--request-id ID` 做幂等重试：同一 ID 重放返回首次结果，不重复建单。

## 典型用法

```bash
# 创建任务（workspace 必须是绝对路径；没有 workspace 的任务不能被 cron 触发）
taskboard create --title "…" --prompt "…" --workspace /abs/path \
  [--label NAME]... [--parent TASKID] [--cron "0 9 * * *" --tz Asia/Shanghai] \
  [--acceptance human|agent] [--automation off|suggest|auto] --json

# 读
taskboard list --json            # {ok, revision, tasks:[card…]}；默认不含已归档，--archived 含
taskboard get <taskId> --json    # {ok, task:{…card, runs, threads, children, annotations, inFlightWrite}}
taskboard status --json          # {ok, url, pid, revisions, tasks, inbox, proposals, runtime}

# 改
taskboard update <taskId> [--title T] [--prompt P] [--cron EXPR | --clear-cron] [--parent ID | --clear-parent] … --json
taskboard move <taskId> <backlog|todo|running|done|failed> --json
taskboard archive|unarchive|delete <taskId> --json   # delete 回包含 danglingChildren / unboundThreads

# 跑：起 Run（经 app-server driver 写 Codex）；cancel 中止并回 todo
taskboard run <taskId> --json      # {ok, run:{id, taskId, status, trigger}}
taskboard cancel <taskId> --json

# 原生 goal（Codex 侧续跑）：set/clear 后由 thread 原生状态驱动；wait 在 goal 模式等静止
taskboard goal <set|get|status|pause|resume|clear> <taskId> --json

# isolated worktree 清理（换绑新线程重跑前）；无 worktree 时回 cleaned:false
taskboard worktree-clean <taskId> --json

# 等静止：无活跃 Run、主线程非 running、无 in-flight 写；缺省 600s，超时 exit 1
taskboard wait <taskId> [--timeout S] --json   # {ok, quiet:true, taskId, status, lastRun}

# Codex thread 观察：Inbox 在 status 的 inbox 域；refresh 立即扫描（daemon 每 30s 自动发现）
taskboard refresh --json                             # {ok, scan:{phase, filesTotal, filesDone, lastCompletedAt}}
taskboard bind-thread <taskId> <threadId> --json     # 解绑 unbind-thread；忽略/恢复 ignore-thread/unignore-thread
taskboard inspect-thread <threadId> --json           # 原生状态、绑定、lineage、最近 turn
taskboard summaries <threadId> --json                # 摘要两层：compacted 基线 + sample 增强

# Jev 提案裁决：no_op/continue_thread/annotate/mark_done 可接受执行；其余动作只提案
taskboard proposals --json                            # {ok, items:[proposal…]}
taskboard accept-proposal <proposalId> --json         # 接受并执行；reject-proposal 拒绝留痕

# 自动化总开关（持久化；不影响 cron）
taskboard pause-automation --json / taskboard resume-automation --json

# 数据库路径（不需要 daemon）
taskboard db path --json
```

## 语义要点

- 五列 `backlog/todo/running/done/failed`，`archived` 与列正交；`move` 是人工动作，不产生 Run。
- 标签 ≤8，服务端归一化（去空白、去重、超量截断）。
- 父子任务：默认深度上限 1（可配到 3），禁止成环；删除父任务不级联删子任务。
- cron：5 段 + 可选 IANA 时区；到点与手动同一条 Run 创建路径（缺 workspace/归档/活跃 Run 跳过并记原因）；错过不补跑。
- Run 经 Codex app-server driver 执行：已绑定线程 resume 续写，未绑定新建并绑为主线程；同一 thread 至多一个在飞写操作。
- 提案执行面只覆盖确定性动作：`continue_thread`（固定模板白名单）、`annotate`、`mark_done`（人工确认即 done）、`no_op`；
  `retry_run`/`create_child_task`/`ask_user`/`mark_blocked` 只生成提案，接受时明确拒绝；critical 风险任何路径都不执行。

## 工具播报开关（announceToAgent）

本 skill 文件就是开关：把它放进 harness 的 skill 目录（用户级 `~/.agents/skills/taskboard/` 或
`~/.zcode/skills/taskboard/`，仓库级 `<repo>/.agents/skills/taskboard/`）即生效；移出即关闭。
没有 daemon 配置项、没有自动注入。
