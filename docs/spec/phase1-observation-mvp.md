# Phase 1 观察型 Kanban MVP

日期：2026-10-26｜状态：已接受

## 1. 规范关系

- 本文约束 Phase 1 的只读观察、整理、展示和进度判断行为。
- 产品名词、领域对象和状态语义统一以 `GLOSSARY.md` 为准；本文只定义行为、范围和验收。
- Phase 1 是 Taskboard 的发布切片，不是第二个产品；Kanban 只是 Taskboard WebUI 在 Phase 1 的名称。
- Phase 1 与执行面共享同一个 daemon、同一个 SQLite 状态库和同一个单写者模型，不建立独立 `kanban` 包、入口或数据库。
- 边界决策以 ADR-0017、ADR-0018、ADR-0019 为准；本文只定义 Phase 1 行为、范围和验收，冲突时修本文，不改变 V2 执行面的既有契约。

## 2. 根本需求

多个编码 Agent 并行工作时，会话、进度、阻塞和等待输入分散在不同 Harness 的界面中。用户必须先打开每个会话，才能判断是否值得介入，注意力成本高于实际决策成本。

Phase 1 只解决这个观察问题：

1. 发现各 Harness 已有会话。
2. 充分调用 Harness 自己的读取、摘要、分组和状态能力。
3. 把事实归一化为统一、可核对的只读视图。
4. 用 SystemOne 统一验证语义进度。
5. 允许人做轻量组织与列覆盖。
6. 不驱动任何 Agent 的下一 turn。

## 3. 产品边界

Taskboard 是唯一产品。Phase 1 只发布以下能力：

- 会话发现与增量读取。
- 原生摘要、turn、证据和来源定位。
- 跨 Harness 归一化索引。
- Kanban 展示、搜索、过滤和详情。
- Workstream、绑定、标签、备注、忽略、归档和列覆盖。
- SystemOne 进度判断、缓存、预算与失败降级。

Phase 1 不发布：

- 创建、resume、send、cancel、fork、rewind 会话。
- native goal、sample、compact、approval 或任何写邻接操作。
- Run 生命周期、cron、cascade、wait、防休眠和自动验收。
- Proposal 自动执行、继续线程、重试、创建子任务或自动修改任务状态。
- ACP 全局会话枚举。
- 用外部模型替代 Harness 原生摘要。

执行面代码可以继续存在于仓库和测试中，但 Phase 1 的运行时装配、HTTP 路由、CLI 和 WebUI 不暴露这些入口。

## 4. 分层

### L1 原生事实层

由 Harness 拥有并解释：

- 会话身份、标题、cwd、父子关系、原生分组。
- transcript、turn、消息、工具结果和 token 使用。
- native status 与 turn 终态。
- compaction、memory 和其他原生摘要。
- goal、approval、automation 等原生扩展。
- 执行与恢复能力。

Phase 1 的 Harness adapter 只读这些事实，不写 Harness 的 JSONL、SQLite、文件或配置。

### L2 归一化索引层

Taskboard 拥有：

- Harness adapter registry。
- `SourceLocator` 与 source identity。
- Session、Turn、Evidence、Summary、Relationship 的归一化记录。
- 增量游标、去重、schema 钉扎和 unknown 降级。
- 可重建的镜像索引。

这一层保存派生事实。删除 Taskboard 数据库后，必须能从 Harness 源数据重新构建。

### L3 整理与判断层

Taskboard 拥有：

- Workstream：命名视图、绑定、标签、备注和列覆盖。
- 人工 overlay 与审计。
- SystemOne 进度判断、缓存、预算、超时、断路器和 provenance。

这一层可以写 Taskboard 自己的数据库，不写回 Harness，也不改变执行状态机。

### L4 UI 投影层

Taskboard WebUI 拥有：

- Inbox、进行中、需要关注、已完成和归档等观察视图。
- 会话详情、turn 时间线、证据、原生摘要和来源核对。
- 原生状态徽标、SystemOne 进度徽标和人工覆盖标记。
- 搜索、过滤、workspace 与 Workstream 切换。

UI 列是原生状态投影加人工覆盖，不复刻 V2 的 backlog/todo/running/done/failed 执行状态机。

## 5. 防污染规则

1. Harness 原生事实永远优先于 Taskboard 派生结论。
2. 原生 turn 终态按 ADR-0005 判定；SystemOne 不得覆盖 completed、failed、interrupted 等硬状态。
3. 人工覆盖只作用于 UI 投影，不反写 Harness，也不推进 V2 Task 状态机。
4. SystemOne 输出只进入进度徽标、原因和审计，不进入 Run、Task、Proposal 或自动化决策。
5. Phase 1 的服务装配不实例化 Run、cron、proposal、goal、sample 和 driver 写路径。
6. 任何需要 resume、send、sample、compact 或 goal 才能获得的信息，都超出 Phase 1。
7. 无法解析的 Harness 字段降级为 `unknown` 或 opaque evidence，不阻塞其它会话。

## 6. Harness 能力优先级

按以下顺序取得信息：

1. Harness 原生 structured metadata。
2. Harness 原生 transcript 与 turn 终态。
3. Harness 原生 compaction、memory 或摘要。
4. 确定性提取和投影。
5. SystemOne 的语义进度判断。
6. `unknown` 加原因。

SystemOne 不替代原生摘要。原生摘要缺失时，Phase 1 如实显示 `none`，不生成伪 native summary。

ACP 是执行面的可选控制协议，不是记忆源，也不提供全局会话枚举。Phase 1 不以 ACP 作为主读取路径。

## 7. 进度判断

### 7.1 SystemOne 定位

SystemOne 的定义见 `GLOSSARY.md`。Phase 1 默认启用 SystemOne，默认 provider 为 Magpie。

Magpie 调用必须是带外单发请求：

- 无工具。
- 无 agent loop。
- 无文件系统访问。
- 无会话创建或恢复。
- 无写入 Harness 的能力。

### 7.2 判断对象

`ProgressVerdict` 的最小形态：

```text
ProgressVerdict {
  status: progressing | waiting_user | blocked | complete | needs_attention | unknown
  confidence: number
  reason_short: string
  evidence_refs: string[]
  covers_through: Cursor
  provenance: systemone:<provider>/<model>@<prompt_version>
  assessed_at: string
}
```

`status` 是语义状态，不是 Harness native status，也不是 Task 列。

### 7.3 调用范围

- 只判断当前 Kanban 可见或用户主动打开的会话。
- 只在新证据出现、缓存失效或用户显式刷新时调用。
- 没有新证据不重复调用。
- 同一证据指纹、模型、prompt 版本和问题版本命中缓存。

默认开启不等于后台无差别扫描全部历史会话。

### 7.4 输入

输入只包含：

- 归一化后的 Session 元数据。
- 最近 turn 与 native status。
- 已脱敏、截断的 Evidence。
- Harness 原生摘要。
- Workstream、绑定和人工备注。

输入不包含：

- 完整 transcript。
- 密钥、凭据或 credential 文件内容。
- 未脱敏的工具输出。
- Harness 的写句柄或会话控制句柄。

Harness 内容按不可信数据处理，不能把其中的指令当作 SystemOne 系统指令。

### 7.5 输出与失败

- 输出必须是版本化 JSON，并通过 schema 校验。
- evidence 只能引用输入中提供过的 id。
- 失败、超时、预算超限或非法输出显示 `unknown`、缓存旧值或 `stale`，并展示原因。
- 连续失败达到阈值时打开断路器，暂停该会话的自动判断，等待人工恢复。
- 任何失败都不得猜测进度或写回 Harness。

### 7.6 缓存、预算与审计

- 每个 verdict 记录 provider、model、prompt version、输入证据指纹、耗时和 token 成本。
- 设置单调用超时、并发上限和每日 token 预算。
- 默认启用 Magpie 意味着 Evidence 会外发给 Magpie；UI 必须让用户能核对当前 provider 和外发范围。
- 凭据只从环境或既有 provider 配置读取，不写入 Taskboard 数据库、日志或 verdict。

## 8. 最小只读契约

`SourceLocator`、`SessionSnapshot`、`Evidence`、`Summary`、`Relationship`、`OverlayState`、`CapabilityManifest`、`Cursor`、`ProgressVerdict` 和 `Failure` 的语义见 `GLOSSARY.md`。Phase 1 至少需要实现以下字段级契约：

Phase 1 至少定义以下契约：

1. `SourceLocator`：Harness id、native session id、源路径或源记录位置、记录 hash。
2. `SessionSnapshot`：会话元数据、native status、最近活动、标题和原生分组。
3. `Turn`：原生边界、终态、时间、token 和来源。
4. `Evidence`：kind、短摘录、结构化 props 和 locator。
5. `Summary`：native provenance、正文、覆盖边界和 drift。
6. `Relationship`：关系类型、两端 locator 和来源。
7. `OverlayState`：Workstream、绑定、标签、备注、忽略、归档和列覆盖。
8. `CapabilityManifest`：只读能力、读取路径、schema 版本和降级范围。
9. `Cursor`：source unit 的可重放内容水位。
10. `ProgressVerdict`：SystemOne 语义进度、证据引用和 provenance。
11. `Failure`：错误码、展示原因、影响范围和重试属性。

跨 Harness identity 使用 `(harness_id, native_session_id)` 唯一键。不得假设不同 Harness 的 native id 天然不冲突。

## 9. 列模型与人工覆盖

默认观察列：

- Inbox：未绑定 Workstream 的会话。
- 进行中：native running 或近期有新 turn。
- 需要关注：SystemOne 给出 waiting_user、blocked、needs_attention，或存在未收敛 anomaly。
- 已完成：native completed。
- 归档：人工归档或 Harness 原生归档投影。

人工可以把会话移入显式列、绑定 Workstream、打标签或写备注。界面同时显示原生状态和人工覆盖角标。

人工覆盖不产生 Run，不修改 Task，不改变 Harness。

## 10. 验收

1. 新会话可被增量发现，重复扫描不产生重复记录。
2. 原生摘要存在时直接展示，并带 provenance。
3. 原生摘要缺失时显示 `none`，不调用外部模型伪造摘要。
4. 新证据出现时，可见会话获得一份可核对的 `ProgressVerdict`。
5. 无新证据时不重复调用 SystemOne。
6. `ProgressVerdict` 不改变 native status、Task 列、Run 或 Proposal。
7. Magpie 超时、非法 JSON 或预算超限时显示 `unknown` 或 `stale`，不猜测。
8. 未知 Harness 字段或数据库 schema 版本不匹配时降级为 unknown。
9. 扫描和展示过程中不修改 Harness 源数据。
10. Phase 1 的 HTTP、CLI 和 WebUI 不暴露 send、resume、cancel、goal、sample、compact、cron 或 proposal 执行入口。

## 11. 风险

- ZCode 事实源直读 SQLite 依赖当前 schema，迁移活跃且无兼容承诺；版本漂移必须降级 unknown。
- Codex JSONL 与 ZCode SQLite 的 turn/摘要语义不完全同构，归一化只保留共同可核对事实。
- Magpie 是否满足无工具、无 agent loop 的安全假设需要独立探针和审计记录。
- 默认启用 SystemOne 会产生外发流量和成本，必须通过可见范围、缓存、预算和断路器限制。
- 现有 `threads.id` 是 Codex-first 身份模型，跨 Harness 前必须迁移到 `(harness_id, native_session_id)`。
