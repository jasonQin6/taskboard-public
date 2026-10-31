# 自改进、Harness² 与 taskboard 编排层研究

> 归档说明（2026-10-21）：本文写作时 V1 仍是需求真相源，文中 R 编号与 `docs/REQUIREMENTS.md` 链接指 V1 需求。V1 已归档到 [`docs/archive/REQUIREMENTS-v1.md`](../archive/REQUIREMENTS-v1.md)；V2 需求见 [`docs/REQUIREMENTS.md`](../REQUIREMENTS.md)，V2 不再使用 R 编号。本文保留为调研记录，不代表 V2 的现行语义。

- 研究日期：2026-10-21
- 研究对象仓库：`$HOME/Documents/workspace/taskboard`
- 证据口径：优先论文、项目源码、官方文档和本仓库实现；每条关键事实尽量就近给出链接。
- 标记约定：
  - **一手证据**：论文、项目仓库、产品官方文档或本仓库源码直接说明。
  - **推断**：本文基于一手证据做的工程判断，不把推断写成事实。
  - **未确认 / 未验证**：没有找到足够的一手来源，或尚未在本项目数据上验证。

## 结论

### 1. RSI 不应按“会改 prompt”来定义

本文采用一个较严格、可操作的 RSI 工作定义：**系统自主地对自身做持久修改，而且这些修改会继续影响后续改进如何被生成、评估和保留**。这是 Harness² 论文直接给出的定义：系统把执行结果和内部反思转成对自身的持久改变，并让这些改变影响未来的生成、评价与保留（[Harness² 论文](https://arxiv.org/html/2610.14224v1)）。按这个标准，一次性的自我批评、单轮 review-repair、或只在当前上下文里记一条笔记，都不能自动称为递归自我改进。

历史上的 RSI 线索来自 I.J. Good 1965 年关于“超智能机器”的论述：设计机器本身也是智力活动，因此超智能机器可能设计出更好的机器（[Virginia Tech 的论文条目与摘要](https://vtechworks.lib.vt.edu/items/5085379d-b24c-424e-8861-e70a47b4b2fb/full)）。MIRI 的 FAQ 进一步把这条路线概括为“seed AI”递归增强自身，并把它与 intelligence explosion 的猜想联系起来（[MIRI Intelligence Explosion FAQ](https://intelligence.org/ie-faq/)）。这是历史与问题背景，不是“今天某个 coding agent 已经实现无界 RSI”的证据。

### 2. 三类对象要分开

| 类别 | 被持久修改的对象 | 代表工作 | 能说明什么 | 不能自动外推什么 |
|---|---|---|---|---|
| 模型权重自改进 | 参数或训练信号 | STaR、Self-Rewarding LMs、Absolute Zero | 模型可以用自生成 rationale、LLM-as-a-Judge、自动提议任务等方式形成训练闭环 | 不代表会自主改仓库，也不代表反馈一定真实 |
| prompt / agent scaffold 自改进 | prompt、memory、工具说明、工作流、agent 代码 | Promptbreeder、Reflexion、ADAS、AFlow、GEPA、SICA | 冻结权重时，外壳层也能被搜索、反思或重写 | 很多方法依赖固定 benchmark；一次反思不等于持久递归 |
| 软件仓库自改进 | 仓库源码、测试、构建和 agent 运行代码 | Darwin Gödel Machine、SICA | 可以让 agent 修改自己的实现并用 coding benchmark 验证 | benchmark 提升不等于开放世界正确，也不等于可安全自动合并 |

SICA 同时跨 scaffold 与 repository 两类：它让 agent 系统编辑自己的代码；Darwin Gödel Machine（DGM）则明确维护自修改 agent 档案，并用 coding benchmark 选择后代（[SICA](https://arxiv.org/abs/2504.15228)、[DGM](https://arxiv.org/abs/2505.22954)）。分类是**改动对象**的分类，不是智能等级分类，也不表示三者组成一条必经升级路线。

### 3. “Google harness2”可以消歧，但不能说成正式 Google 产品

在公开一手来源里，最吻合的名称是 **Harness²: Recursive Agent Harnessing for an Open World**：

- 论文：<https://arxiv.org/abs/2610.14224>
- Google Research 仓库：<https://github.com/google-research/harness2>
- 项目页：<https://harness2.github.io>

论文作者页标注 Google Cloud AI Research 与 Northwestern University；仓库由 `google-research` 组织维护。但仓库 README 明确写着：**“This is not an officially supported Google product.”**（[仓库 README](https://github.com/google-research/harness2)）。因此应表述为“Google Research 发布的实验性研究框架”，不能表述为 Google 正式产品、内部服务或已经产品化的 self-improving agent。

目前没有找到另一个同样有第一方证据支持的 Google `harness2` 产品。如果用户最初听到的是某个内部项目或社区同名工具，公开材料无法确认；这一点应标为**未确认**，不能猜测。

### 4. Harness² 的关键不是“模型自己变聪明”，而是“冻结模型，改进 harness”

Harness² 把 harness 定义为模型周围的执行系统，并列出八个可编辑组件：system prompt、guardrails、memory、tool guidance、subagents、skills、scripts、plugins。摘要和仓库都明确说 model weights 保持冻结（[论文摘要](https://arxiv.org/abs/2610.14224)、[仓库](https://github.com/google-research/harness2)）。

它有两层递归：

1. **任务级递归**：对当前任务执行 reference，提出 invariant 与 domain-specific 候选 harness，在同一任务上 probe，再依据行为对比 compose 后继 harness；不依赖 ground-truth verifier。
2. **harnessing 级递归**：把被采纳的 harness 和有证据的经验写入持续改进库，供未来任务的选择与组合使用。项目页把它概括为 execution harness 与 improvement harness 的双层结构（[项目页](https://harness2.github.io)）。

论文报告了在三个专业 benchmark、四种 model-harness 配置上的单步提升，最高为 WorkBuddy-Bench 11.5 分、JobBench 4.5 分、LAB partial pass 11.8 个百分点（[论文摘要](https://arxiv.org/abs/2610.14224)）。这些是**该论文实验设置下的结果**，不是对任意仓库、任意 harness 或 taskboard 的保证。

论文还列出两个限制：递归改进需要额外执行和编辑计算；没有 ground truth 时，行为对比和模型判断会受执行随机性和共享偏差影响，不保证正确，也不保证迁移到其他任务（[论文 Limitations](https://arxiv.org/html/2610.14224v1)）。失败分析明确提到候选选择可能挑到更弱结果、错误前提会跨候选传播，以及缺少 judge verdict、输出随机性会造成归因困难（[论文 Failure Analysis](https://arxiv.org/html/2610.14224v1)）。

另外，仓库说明默认 executor 网络无限制，并且 Codex executor 的 sandbox 被禁用（[仓库 README](https://github.com/google-research/harness2)）。这说明它是研究代码，不应把其运行默认值直接搬到 taskboard 的生产编排。

### 5. taskboard 当前更接近“有 checks 的自治仓库改进”，还不是强 RSI

本仓库 R29 的真实流程是：从 `baseRef` 解析 base SHA，新建独立 worktree/branch，跑 setup 与基线 checks，把仓库状态、近期提交、check 结果和最近失败/取消 run 摘要注入 Codex，要求每轮只做一个边界改动，再重跑 setup/checks，有 diff 就 commit，写报告；成功后保留 branch/report、删除 worktree，失败保留 worktree，不 push、不 merge（[`docs/archive/REQUIREMENTS-v1.md`](../archive/REQUIREMENTS-v1.md)、[`src/self-improve.ts`](../../src/self-improve.ts)、[`src/runner.ts`](../../src/runner.ts)）。

这是一种**软件仓库自改进 + 确定性验证 + 人工合并门**。在本文的工程光谱里，它大致位于“定时自治候选变更”层，不属于模型权重自改进，也不属于在线 harness 自改写。

它目前没有形成强递归闭环，原因是：

- checks 证明“没有破坏已编码的约束”，不等于证明“这轮确实比 baseline 更好”；
- 没有把 baseline 与 candidate 放进同一套任务/评分器做行为对照；
- 没有独立 reviewer 或候选选择档案；
- 最近运行证据只取最近 10 个 failed/cancelled run（[`src/runner.ts`](../../src/runner.ts)），成功经验、适用条件和已拒绝方案不会自动沉淀；
- 每次运行是隔离的 one-shot，报告和 branch 留下来了，但下一步的“如何改进改进过程”没有自动更新。

因此可以说它是 **self-improvement pipeline 的雏形**，不能把它夸大为“taskboard 已经实现递归自我改进”。

### 6. Codex “预测下一步”和 Jev 只是部分同构

OpenAI 官方文档把 Composer Predictions 定义为：Codex 回复后，基于当前 thread 建议下一条**用户消息**；按 Tab 接受后只是可编辑草稿，不会自动发送；预测不会自行检索 memory 或 connected app，而只使用当前 thread 已有上下文；功能仍处于 beta 且受计划、地区和模型限制（[Composer Predictions](https://learn.chatgpt.com/docs/features/composer-predictions.md)）。

开源 app-server 协议的类型也只表达：请求携带 `thread_id` 和 `source_turn_id`，结果是可选的 `completed { text }` 或 `failed`（[`thread_prediction.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_prediction.rs)）。这足以支持“给用户一条候选文本”，但**没有一手证据证明存在一个通用的“预测任务动作并自动推进看板/执行”的 Codex API**。

Jev/TypeSafe 的接口则是：`choice` 返回选项、概率分布和 confidence；`noul` 返回 yes 概率；`score` 返回序数位置（[TypeSafe primitives](https://docs.typesafe.ai/primitives.md)）。TypeSafe 的官方文档还说明，`confidence` 是由概率分布计算出的集中度，不是“正确率保证”；阈值应随风险变化，并用本领域数据测试（[TypeSafe confidence](https://docs.typesafe.ai/confidence.md)）。Jev 本身不负责读取会话、维护状态机或执行动作；这些都必须由编排层提供。

所以结论是：

- **同构部分**：都从当前状态产生候选下一步，并把“建议”与“执行”分开；
- **不同构部分**：Codex 产出自由文本、只面向当前 thread 的下一条用户输入；Jev 产出受限枚举/概率，但仍需外部事件输入和编排器；两者都不天然拥有 taskboard 的状态转换权；
- **不能假设**：Codex 可自动执行预测、Jev 可自行扫描任意 Codex/ZCode 会话，或存在一个跨 provider 的统一“下一步任务”协议。

### 7. 最值得做的编排改进

**推断**：对 taskboard，优先级最高的不是“让 Jev 更大胆地自动推进”，而是补上一层可回放的 **proposal → review → apply → verify** 管线：

1. 用公开 CLI JSONL 或显式 hook 建立 taskboard 自己的 append-only 事件流；
2. 用规则先做硬门，再用 Jev 做窄分类/打分；
3. 预测器只生成有限动作提案，不直接写 Ledger；
4. 所有状态变更经 Ledger revision/CAS 和幂等键；
5. 高风险动作永远人工确认，先 shadow、再 suggest-only、最后才开启低风险自动推进；
6. 用历史事件离线回放校准阈值，不把 Jev confidence 当成现成的正确率。

这比“定时扫描会话并自动推看板”更接近可验证的持续改进，也能把 taskboard 从“每轮一个 commit”推进到“每轮留下可比较、可复用、可回滚的实验”。

## 证据

### 1. RSI 的历史线索与当代工作定义

#### 1.1 历史概念

I.J. Good 1965 年的论文摘要写道，第一台超智能机器最可能由人工神经网络构成，而“later machines will all be designed by ultra-intelligent machines”（[Virginia Tech 条目](https://vtechworks.lib.vt.edu/items/5085379d-b24c-424e-8861-e70a47b4b2fb/full)）。MIRI FAQ 引用并解释了“ultraintelligent machine”与 intelligence explosion，同时把“递归自我改进的 seed AI”作为一种可能的路径（[MIRI FAQ](https://intelligence.org/ie-faq/)）。

**边界**：这些材料说明的是思想史和假设空间，不是现代 agent benchmark 的实证结果。把它们直接外推为“今天的 self-improve cron 正在制造 intelligence explosion”是夸大。

#### 1.2 本文采用的现代定义

Harness² 的定义更适合工程讨论：RSI 是系统把执行结果和内部反思转成对自身的持久修改，使这些修改影响未来改进的生成、评估和保留（[论文 2.1 节](https://arxiv.org/html/2610.14224v1)）。这给出四个可检查条件：

1. **自主性**：不是人逐步手写每一步；
2. **持久性**：改动不止存在于一次回答的 transient context；
3. **反馈性**：先前结果会改变后续候选的生成；
4. **二阶性**：改动还能影响“如何评价和改进”的机制，而不只是改变一次输出。

这四条件可作为审查任何“self-improving agent”宣称的尺子。

#### 1.3 三类代表性工作

##### A. 模型权重自改进

- **STaR**：生成 chain-of-thought，失败时在给定正确答案的提示下再生成 rationale，再把最终正确的 rationale 用于微调，循环迭代。摘要明确说模型“improve itself by learning from its own generated reasoning”（[STaR](https://arxiv.org/abs/2203.14465)）。
- **Self-Rewarding Language Models**：模型通过 LLM-as-a-Judge 给自己提供 reward，在 iterative DPO 中同时改善指令跟随和自评能力（[Self-Rewarding LMs](https://arxiv.org/abs/2401.10020)）。
- **Absolute Zero / AZR**：单一模型提出最大化自身学习进度的任务并求解，用 code executor 作为可验证 reward，不依赖外部数据（[Absolute Zero](https://arxiv.org/abs/2505.03335)）。

这些工作的共同点是**训练信号会改变参数**。它们并不自动解决仓库维护、工具使用或人类审查；而且自评、代理 reward、代码 executor 都可能被错误利用。不要把“权重更新”与“更强的通用工程判断”画等号。

##### B. prompt / agent scaffold 自改进

- **Promptbreeder**：同时进化 task prompt 和 mutation prompt，后者负责改进前者，形成 self-referential prompt evolution（[Promptbreeder](https://arxiv.org/abs/2309.16797)）。
- **Reflexion**：不更新权重，把自然语言反思写进 episodic memory，在后续 trial 中使用（[Reflexion](https://arxiv.org/abs/2303.11366)）。
- **ADAS / Meta Agent Search**：meta agent 用代码不断编写新的 agent，基于已有发现档案继续搜索（[ADAS](https://arxiv.org/abs/2408.08435)）。
- **AFlow**：把 workflow 搜索为带 LLM 调用节点的代码图，用 Monte Carlo Tree Search 和执行反馈迭代（[AFlow](https://arxiv.org/abs/2410.10762)）。
- **GEPA**：采样 reasoning/tool-call/tool-output trajectories，用自然语言反思提出 prompt 更新，并保留 Pareto frontier 的互补经验（[GEPA](https://arxiv.org/abs/2507.19457)）。
- **SICA**：让带基本 coding tools 的 agent 编辑自身代码，并在 SWE-bench Verified 随机子集等 benchmark 上验证提升（[SICA](https://arxiv.org/abs/2504.15228)）。

这里的“持久”程度差异很大：Reflexion 的反思可能在任务/试验之间保留，但不一定改变模型；Promptbreeder、ADAS、AFlow 和 GEPA 通常有一个搜索/评价循环；SICA 已经进入代码仓库层面。不能因为论文标题含 self-improvement，就跳过“是否有持久对象、评价信号和二阶反馈”的检查。

##### C. 软件仓库自改进

- **Darwin Gödel Machine**：agent 迭代修改自己的代码，维护生成 agent 的 archive，并用 coding benchmark 做经验验证；论文报告 SWE-bench 从 20.0% 到 50.0%、Polyglot 从 14.2% 到 30.7%，同时强调 sandboxing 和 human oversight（[DGM](https://arxiv.org/abs/2505.22954)）。
- **SICA**：不仅能改 prompt/流程，也能改自身系统代码，以 benchmark 验证性能变化（[SICA](https://arxiv.org/abs/2504.15228)）。

DGM 是“仓库层面的自修改 + archive + benchmark selection”的代表，但它仍然是 benchmark-bound。论文中的安全措施与有限评测范围不应被省略；它不能证明任意仓库、任意真实需求下的自动合并是安全的。

#### 1.4 一个用于工程判断的光谱（本文推断）

以下分级不是学术标准，只是帮助 taskboard 定位：

| 级别 | 行为 | 典型机制 | 是否已是强 RSI |
|---|---|---|---|
| R0 | 人给需求，agent 单次实现 | 单轮 coding | 否 |
| R1 | review → repair → validate 的有界循环 | evaluator loop、structured feedback | 否 |
| R2 | 定时在隔离环境做候选仓库改动，checks 通过后留给人合并 | taskboard 当前 self-improve | 否，最多是 RSI 的入口 |
| R3 | 多候选/多次实验，baseline-vs-candidate 评分，保留经验库并选择后代 | eval + experiment archive + memory | 可能是开放式的，但仍需验证 |
| R4 | 改进“改进机制”本身，且经验会影响未来候选生成/评价/保留 | Harness² 的 improvement harness、DGM archive | 更接近 Harness²/DGM 所说的递归 |

**推断**：taskboard 当前主要在 R2。它已有“隔离、证据、checks、manual merge”的良好骨架，但缺 R3 的比较、选择和经验复用，更没有 R4 的二阶闭环。

### 2. “Google harness2”消歧与 Harness² 机制

#### 2.1 证据链

公开检索得到的精确匹配是：

1. arXiv 标题 `Harness^2: Recursive Agent Harnessing for an Open World`，编号 `2610.14224`，摘要日期为 2026-10-09（[arXiv 摘要页](https://arxiv.org/abs/2610.14224)）。
2. `google-research/harness2` 仓库，Apache-2.0，README 直链同一论文和项目页（[GitHub 仓库](https://github.com/google-research/harness2)）。
3. 项目页显示 Google Cloud AI Research 与 Northwestern University 作者信息，并描述两层递归（[项目页](https://harness2.github.io)）。
4. 仓库 README 的 disclaimer 明确说不是官方支持产品。

**结论**：用户说的 “Google harness2” 在当前公开证据下最可能指 Harness² 研究项目。若原意是别的内部/社区项目，则需要新的第一方材料，当前无法确认。

#### 2.2 它到底改什么

Harness² 把 harness 当作 agent 的可编辑运行外壳，而不是改模型参数。八个组件是：

| 组件 | 运行角色（按论文/项目页） |
|---|---|
| system prompt | persona 与顶层流程 |
| guardrails | 约束与安全检查 |
| memory | 运行时可用的持久上下文 |
| tool guidance | 何时、如何调用工具 |
| subagents | 任务委派与并行组织 |
| skills | 可复用能力/流程说明 |
| scripts | 工具接口或确定性执行 |
| plugins | middleware / 运行时扩展 |

来源：[仓库 Harness components](https://github.com/google-research/harness2)、[项目页](https://harness2.github.io)。

#### 2.3 两层递归的具体流程

**任务级 recursion**：

- 先用当前 harness 对任务做一次 execution，得到 reference trajectory 和 deliverable；
- 基于任务、当前 harness、reference 和已有 library，提出一个 invariant candidate（跨域问题）和一个 domain-specific candidate（当前域知识/约束）；
- 两个候选都在同一任务、同一模型/环境下 probe；
- 比较 reference 与候选的行为差异，compose 时可以选择合并、改写、采用一个或保留原 harness；
- 结果不是由 ground-truth verifier 判定，而是由 behavior contrast 和模型判断支持。

**harnessing 级 recursion**：

- 把 adopted harness 和 refinement 过程中的经验写入 improvement library；
- 下一任务仍从基础 execution harness 开始，improvement harness 带着“之前怎样改进、何时有效”的经验来指导下一次 propose/compose；
- 因此保存的是“改进能力”，而不是把上一任务的高度定制 harness 直接当默认。

以上见论文 2.1–2.3 节、项目页流程图和仓库 README。项目页特别画出每个新任务从 H₀ 开始，而 improvement harness 由 library 更新（[项目页](https://harness2.github.io)）。

#### 2.4 一手结果与限制

论文报告：单步在三个 benchmark、四种 model-harness 配置上有一致提升，最大为 WorkBuddy-Bench +11.5、JobBench +4.5、LAB partial +11.8 个百分点；并行/顺序 recursion 的预算增加还能继续提升（[摘要](https://arxiv.org/abs/2610.14224)）。

但同一论文的 Limitations 和 Failure Analysis 必须与结果同时引用：

- 额外 executions/editor sessions 增加推理成本；
- 没有 ground truth 时，行为对比和模型判断受 stochasticity 与 shared model biases 影响；
- 不保证正确，也不保证跨任务迁移；
- 会选到 weaker candidate、传播错误前提、缺少 judge verdict 或无法归因；
- repository README 还警告 executor 网络无限制、Codex sandbox disabled，研究默认值不适合直接生产。

来源：[论文 Limitations](https://arxiv.org/html/2610.14224v1)、[论文 Failure Analysis](https://arxiv.org/html/2610.14224v1)、[仓库 README](https://github.com/google-research/harness2)。

**未确认**：截至本文写作日期，未找到独立第三方复现或正式的 Google 产品化公告。上述提升只能按论文作者的实验报告理解。

### 3. 主流 coding agents 的持续改进机制

下面把“产品已有能力”和“研究原型”分开。产品文档通常描述辅助、记忆、隔离和自动化；它们并不等于产品已经实现了无界 RSI。

#### 3.1 已部署产品中的一手证据

| 机制 | 一手来源 | 实际自动化到什么程度 | 可迁移到 taskboard 的部分 |
|---|---|---|---|
| evaluator / iterative repair | [OpenAI Cookbook: Build iterative repair loops with Codex](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex) | Review 产结构化 findings，Repair 改副本，Validate 运行 checks；剩余问题成为下一轮输入 | 把 validation failure 变成结构化输入，而不是只拼接自然语言报错 |
| trace-based evals | [OpenAI: Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills) | 捕获 `codex exec --json` 的 JSONL trace/artifacts，跑 deterministic checks，再用 `--output-schema` 做 rubric grading；文章建议 10–20 个定向 prompt，包含反例 | 每个候选改动保留 trace、文件产物、命令事件和分数，才能做前后对比 |
| 长任务状态管理 | [OpenAI: Run long-horizon tasks with Codex](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) | spec/plan/implement/documentation 文件承载目标、里程碑、运行手册、当前状态；每个里程碑跑验证并修复 | taskboard 需要显式 milestone、acceptance、status log，不要依赖一条长 prompt |
| scheduled tasks + worktree | [OpenAI Scheduled tasks](https://learn.chatgpt.com/docs/automations) | 可在本地项目或隔离 worktree 运行；官方建议先手动测试并审查前几次运行；CLI 不提供 Scheduled 管理界面 | 隔离是必要的，但“定时”本身不是 self-improvement；必须有候选评价和合并门 |
| 项目记忆 | [Claude Code memory](https://code.claude.com/docs/en/memory.md) | `CLAUDE.md`/auto memory 跨 session；每轮加载 auto memory 的前 200 行或 25KB；同一 repo 的 worktree 共享 memory；文档明确说 memory 是上下文，不是强制配置 | 记忆应该短、带范围、可审计；硬约束放 hooks/checks，不靠“请记住” |
| 记忆审计 | [Claude Code memory: prompt-audit](https://code.claude.com/docs/en/memory.md) | `/doctor prompt-audit` 给出过期/冲突指令的发现和提案，文件在用户要求前不被改写 | 自动扫描应默认“只提案”，把修改作为单独审批事件 |
| 经验记忆 + 整理 | [Devin Memory and Dreaming](https://docs.devin.ai/product-guides/memory.md) | memory 是 Git Markdown；条目链接回 source/session；并行写有 stale-write 拒绝与重试；新记忆只影响未来 session；Dreaming 约每日整理、删过时项 | 经验必须有 provenance、冲突处理、过期/清理策略；“写入成功”不等于“未来一定遵守” |
| event automation | [Devin Automations](https://docs.devin.ai/product-guides/automations.md) | trigger、conditions、LLM/script preflight、action；item id 去重；`LAST_RUN_FILE` 提供上次状态；失败项释放，不会自动盲目重试；有 ACU/频率/队列限制 | 事件驱动、幂等、状态文件、失败回退、预算与 kill switch 应成为 taskboard 的一等设计 |

**推断**：这些产品能力大多停留在“辅助人更快地做 bounded improvement”。它们没有公开声称具备 Harness²/DGM 那种开放世界递归自改进，也没有证明自动合并是安全的。

#### 3.2 研究原型的对应关系

- **benchmark-driven improvement**：DGM/SICA 用 coding benchmark 选择和验证自修改；Codex evals 则把同一思想缩小为 skill 的 10–20 个定向案例与 deterministic/rubric checks（[DGM](https://arxiv.org/abs/2505.22954)、[SICA](https://arxiv.org/abs/2504.15228)、[eval skills](https://developers.openai.com/blog/eval-skills)）。
- **trajectory / memory reflection**：Reflexion 用语言反思记忆改后续 trial；GEPA 从实际 trajectories 学习自然语言规则；Devin Dreaming 对长期记忆做整理与遗忘（[Reflexion](https://arxiv.org/abs/2303.11366)、[GEPA](https://arxiv.org/abs/2507.19457)、[Devin Memory](https://docs.devin.ai/product-guides/memory.md)）。
- **self-play / self-generated tasks**：Absolute Zero 让模型提出任务并用 code executor 验证答案；它适合作为“可验证 curriculum”参考，不是 taskboard 现状（[Absolute Zero](https://arxiv.org/abs/2505.03335)）。
- **workflow synthesis**：ADAS/AFlow 搜索 agent 代码/工作流；它们说明编排结构本身可以被候选化，但固定 benchmark 与搜索成本仍是边界（[ADAS](https://arxiv.org/abs/2408.08435)、[AFlow](https://arxiv.org/abs/2410.10762)）。
- **automatic prompt optimization**：Promptbreeder/GEPA 用变异、反思和 Pareto 选择改 prompt；真正可迁移的是“候选—评价—选择”流程，不是某个 prompt 文本（[Promptbreeder](https://arxiv.org/abs/2309.16797)、[GEPA](https://arxiv.org/abs/2507.19457)）。

### 4. taskboard 现有 self-improve 的定位、风险与提升点

#### 4.1 已实现的事实

R29 规定：

- 同一 workspace 同时最多一个未归档 self-improve；
- 必须使用 Codex，从 base branch 新建独立 worktree/branch；
- prompt 含仓库状态、近期提交、基线 checks、最近失败/取消运行的脱敏摘要；
- 执行后重跑 setup/checks，有 diff 则 commit；无改动可 no-op；
- 不 push、不 merge、不自动重试；
- 失败保留 worktree、diff、日志和报告供人工审查。

来源：[V1 需求 R29](../archive/REQUIREMENTS-v1.md)、[`README.md`](../../README.md)。默认 cron、baseRef、setup、checks 也在 README 中说明（[README](../../README.md)）。

实现上，`prepareSelfImprovement` 负责 worktree、setup 和 baseline checks；`finalizeSelfImprovement` 运行 after-agent setup/checks、commit、报告，并在成功路径删除 worktree（[`src/self-improve.ts`](../../src/self-improve.ts)）。`selfImproveEvidence` 只收集最近 10 个 failed/cancelled run（[`src/runner.ts`](../../src/runner.ts)）。这比“随便写一段 prompt 再自动 push”安全得多，但它不是候选实验系统。

#### 4.2 在 RSI 光谱中的位置

**推断**：它属于 R2，而不是 R4：

- 改的对象是 repository source，符合“软件仓库自改进”；
- 有持久 branch、commit、report；
- 有确定性 checks；
- 没有 candidate archive、baseline-vs-candidate benchmark、独立 judge、经验库回灌或改进机制的自我修改。

更准确的说法是：**taskboard 现在具备 RSI 所需的执行隔离与证据地基，但还没有递归选择回路。**

#### 4.3 主要风险

1. **checks 全绿但语义错误**：测试覆盖不到的需求、误改文档语义、过拟合现有断言都可能通过。代码事实：checks 是按命令退出码运行，`firstFailure` 只认 exit code（[`src/self-improve.ts`](../../src/self-improve.ts)）。
2. **baseline 与 candidate 没有行为对照**：基线 checks 和最终 checks 是同一套静态命令，不能回答“同样任务下候选是否更好”。
3. **作者与评审同源**：同一 Codex 既提议修改又写最终总结；没有独立 reviewer，容易产生自我确认。
4. **经验不累积**：成功报告没有结构化回灌；失败摘要也只是最近 10 条。长期会重复踩坑，无法学习“哪类改动在哪种条件下有效”。
5. **分支长期漂移**：成功只留本地 branch，base branch 继续前进；人工合并时可能遇到语义冲突，而 checks 是在旧 base 上跑的。
6. **aut commit 产生错误的安全感**：commit 只表示 Git 写入成功，不表示变更值得合并。成功路径删除 worktree 后，人工审查必须依赖 report/branch，而不是当场实验。
7. **成本与存储无上限**：每个失败 worktree 保留，长期会积累；每次执行都有 Codex 与全量 checks 成本。
8. **证据面仍不全**：Codex adapter 只保留 sessionId、最后 `agent_message`、有限 tail；README 还明确不扫描 Codex/ZCode 会话存储（[`src/codex-adapter.ts`](../../src/codex-adapter.ts)、[`README.md`](../../README.md)）。这会限制事后反思和因果归因。

#### 4.4 可提升点，按优先级

**P0：把一次 run 变成可比较的 experiment record**

至少记录：

- base SHA、candidate commit、base ref 的当前 SHA；
- setup/checks 的完整命令、exit code、耗时、日志 artifact 路径；
- candidate 的 diff 统计、涉及文件、测试新增/修改；
- 变更意图、预期收益、已知风险；
- 后续人工 accept/reject、合并结果、7/30 天回归情况。

**P1：增加 baseline-vs-candidate 行为对照**

不要只看“候选仍通过原有 checks”。为自改进任务准备一个小型、可回放的任务集：同类 issue/bug、同一 CLI 请求、同一文件的修复案例。baseline 与 candidate 在相同模型、相同环境、相同输入下运行；对比成功率、命令数、token、人工 review 时间和回归。

这直接借鉴 Harness² 的 `Propose–Probe–Compose`，但必须把其“无 ground truth 时依赖行为对比”的局限写进实验记录。

**P2：独立评价器与证据分级**

- 确定性 checks 是硬证据；
- 同一 Codex 的自我总结只能算 soft evidence；
- 高风险的语义改动应由不同模型/独立 reviewer 或人工复核；
- checks 失败、超时、权限异常作为一等事件，不要让模型在总结里重述成“已修复”。

**P3：轻量经验库**

用 JSONL/Markdown 记录“问题类型、证据、候选动作、适用条件、结果、拒绝原因、过期时间”。这比把整段 agent 回答塞进下一轮 prompt 更可检索，也能防止错误经验无限传播。Devin 的 source/session 链接、stale-write 拒绝和 Dreaming 清理提供了产品级参考（[Devin Memory](https://docs.devin.ai/product-guides/memory.md)）。

**P4：合并门与回滚**

保持“不 push、不 merge”的默认策略。人工审查应看到 diff、check 证据、baseline/candidate 对照、风险说明和撤销方法。合并后若回归，以新的 Git commit 回滚或修正，不重写历史；事件与报告保留。

### 5. Codex Predictions 与 Jev 的同构性

#### 5.1 Codex 侧的一手事实

- Composer Predictions 基于当前 thread 建议下一条用户消息；
- Tab 只是接受为可编辑 draft，不发送；
- 不主动查 memory 或 connected app；
- 当前为 beta，受计划、地区和模型限制；
- 官方文档没有承诺任务状态机、动作概率或自动执行。

来源：[Composer Predictions](https://learn.chatgpt.com/docs/features/composer-predictions.md)。

开源 app-server 协议的请求只有 `thread_id`、`source_turn_id`，结果只有 `completed` 的可选 `text` 或 `failed`（[协议源码](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_prediction.rs)）。协议存在不等于所有桌面/CLI 用户都能获得一个稳定的任务编排 API；不要把类型定义当成产品承诺。

#### 5.2 Jev 侧的一手事实

TypeSafe/Jev 的 `choice` 适合从固定选项中选择，返回 `choice`、`probabilities`、`confidence`；`noul` 返回 yes 概率；`score` 返回有序位置。官方文档强调：

- 一个判断应该窄、具体，复杂判断拆成多个问题后在代码里组合；
- `confidence` 是概率分布的集中度，不是跨领域的正确率；
- 阈值要按风险与领域数据调整；
- 只有当你自己验证过，才能把某个阈值当成可自动执行的依据。

来源：[TypeSafe primitives](https://docs.typesafe.ai/primitives.md)、[TypeSafe confidence](https://docs.typesafe.ai/confidence.md)。本仓库的 Jev wrapper 目前用 `pick` 在 workflow 选项中做路由，固定 `--min-confidence 0.7`、30 秒超时，并且只是建议、不落账（[`src/workflow-pick.ts`](../../src/workflow-pick.ts)、[V1 需求 R22](../archive/REQUIREMENTS-v1.md)）。

Jev 不会自行读取“harness 会话”或写 taskboard；它是一个可被编排器调用的 typed judgment CLI。所谓“定期扫描”必须由 taskboard 的事件采集/摘要层提供输入。

#### 5.3 同构性判定

| 维度 | Codex Composer Predictions | Jev/小模型编排放 | 是否同构 |
|---|---|---|---|
| 输入 | 当前 thread 已有上下文 | 编排层提供的 bounded state（事件、状态、候选） | 部分同构 |
| 输出 | 自由文本候选用户消息 | 受限 choice/noul/score 及概率 | 否 |
| 概率/置信度 | 文档未提供任务动作概率 | 可返回 probabilities/confidence | 否 |
| 接受方式 | Tab 生成 draft，人再发送 | 编排器可把选中项转 proposal，仍可人工确认 | 部分同构 |
| 执行 | 不自动执行 | CLI 只返回判断，执行需外部 orchestrator | 否 |
| 状态写入 | 无 | 可设计 proposal，不能直接写 Ledger | 否 |
| 适用范围 | 当前 thread 的下一输入 | 可喂任意选定事件摘要 | 不同 |

**最终判定**：它们是“候选生成接口”层面的弱同构，不是“Codex 预测下一步”与“Jev 自动推进看板”的同一机制。若想让 Jev 接近后者，需要自己实现事件采集、状态机、风险门、幂等、证据和回滚；这不是调用一个 Jev 命令就能获得的产品能力。

## 编排层设计建议

### 1. 设计原则

1. **事件先于预测**：没有稳定事件输入，就没有可复核的“下一步”。
2. **预测器无写权限**：Jev、Codex 或小模型只能生成 proposal；只有 Ledger 可以改变账本。
3. **动作空间有限**：动作是带参数的小枚举，不允许自由文本直接触发状态变更。
4. **接受与执行分离**：人工确认 proposal，不等于授权 agent 改代码；执行仍走 taskboard 现有 run 权限。
5. **默认保守**：低置信、冲突、过期、信息不足一律 abstain 或请求人工。
6. **不读私有会话存储**：只用公开 CLI JSONL、显式 hook、导出事件或 taskboard 自己产生的 run 记录；遵守 README 的“不扫描 Codex/ZCode 会话存储”边界（[README](../../README.md)）。
7. **可回放**：预测输入、模型版本、prompt/spec 版本、阈值、人工决定和结果都要留证。

### 2. 事件层：从 harness 会话到规范化事件

**当前事实**：Codex adapter 解析 JSONL，但只返回 sessionId、最后一条 agent message 和有限 tail；runner 落账的是 response/sessionId/error/checks 等字段，并没有完整的 provider event stream（[`src/codex-adapter.ts`](../../src/codex-adapter.ts)、[`src/runner.ts`](../../src/runner.ts)）。因此“扫描会话”不能假设为已存在能力。

建议新增一个 taskboard-owned append-only 事件日志（可以是 per-run JSONL，避免把高频事件直接塞进 Ledger JSON）：

```text
event_id = sha256(source | thread_id | source_turn_id | seq | kind | payload_hash)
schema_version
source: codex | zcode | taskboard | human
workspace_id
task_id
run_id
thread_id / session_id
source_turn_id
seq
kind:
  turn.started | turn.completed | turn.failed
  command.started | command.completed
  file.changed | test.completed
  agent.message | approval.requested | context.compacted
observed_at
payload_summary (redacted, bounded)
payload_hash
artifact_uri
ledger_revision_at_observation
```

实现顺序：

1. 在 adapter 收到公开 CLI JSONL 时，先把原始行写入 run artifact；
2. 对敏感字段做 redaction，事件日志只保留摘要和 artifact 引用；
3. 从 run 结束事件生成 `turn.completed`/`turn.failed`，让 taskboard 不依赖 provider 私有 sqlite；
4. 对事件做 hash-chain 或链式 `previous_event_hash`，检测缺失和重复；
5. 只在事件完整、状态 revision 已知时进入分类。

不要用定时器去“猜”中间状态。定时器可以负责 **sweep/remind**，但事件本身应尽量由明确的 CLI 输出、hook 或 taskboard 内部状态转换驱动。

### 3. 状态机

建议把 proposal 作为独立对象，宁愿多一层，也不要把预测逻辑塞进 runner：

```text
OBSERVED
  -> CLASSIFIED
  -> PROPOSED
       -> ABSTAINED（证据不足/低置信）
       -> AWAITING_REVIEW（中/高风险或阈值不足）
       -> AUTO_ELIGIBLE（仅低风险策略允许）
  -> ACCEPTED / REJECTED / EXPIRED
  -> APPLIED（Ledger.mutate + revision/CAS 通过）
  -> DISPATCHED（需要创建/重试任务时）
  -> VERIFIED / FAILED
  -> COMPENSATED（必要时写补偿事件，不删除历史）
```

关键规则：

- `PROPOSED` 只是派生状态，不修改任务状态；
- `AUTO_ELIGIBLE` 仍要经过确定性 hard gates，不等于直接执行；
- `APPLIED` 必须在一个 `Ledger.mutate` 内检查 `base_revision`、当前 task/run 状态和幂等键；
- `DISPATCHED` 之后的新 run 仍然走现有 `TaskPermission=confirm`/`run.confirm`；不要用一个 proposal 绕过 run 权限（[`src/runner.ts`](../../src/runner.ts)、[V1 需求](../archive/REQUIREMENTS-v1.md)）；
- `EXPIRED` 用于 base revision 变化、proposal TTL 到期或同一任务已有新事件；
- 所有拒绝、过期、失败都保留原因和证据引用。

### 4. 动作枚举与风险分级

不要让 Jev 生成“任意下一步文本”。建议使用可执行、可审计的动作：

| 动作 | 语义 | 初始风险策略 |
|---|---|---|
| `no_op` | 记录已观察，不推进 | 可自动记录 |
| `ask_user` | 生成待确认问题 | 可自动 propose，默认需人看 |
| `annotate` | 在任务/run 上附加结构化备注 | 可自动 apply 到独立 audit 字段 |
| `mark_blocked` | 标记为 blocked，并附证据 | 需 hard evidence；首版人工确认 |
| `create_child_task` | 早拆子任务 | 人工确认；必须设置 parent/幂等键 |
| `retry_run` | 重跑同一任务 | 人工确认；限制次数/预算 |
| `close_task` / `cancel_task` | 关闭/取消 | 默认禁止自动；高影响 |
| `change_code` / `merge` | 改代码或合并 | 完全不纳入本层；继续走 self-improve + code review |

这个分层与 taskboard 当前语义一致：Ledger 仍然负责 task/run 状态，`confirm` 仍然负责执行放行。不要把 `mark_blocked` 直接写成文件变更，也不要把 `create_child_task` 做成绕过父/子任务策略的旁路。

### 5. 置信度门：两段式，不是单一 0.7

Jev 的 `confidence` 可以作为信号，但不能直接拿一个全局阈值决定自动推进。TypeSafe 文档明确说 confidence 是概率分布集中度，阈值必须按风险和领域数据调整（[confidence](https://docs.typesafe.ai/confidence.md)）。建议用两段式门：

#### 5.1 先过确定性 hard gates

以下任一条不满足，直接 `ABSTAINED` 或 `AWAITING_REVIEW`：

- event 完整且 hash/顺序可验证；
- `base_ledger_revision` 仍是当前 revision，或明确标记为 stale；
- 没有未解决的人工提问/确认；
- 没有 active run，或动作明确要求 active run；
- 动作所需的证据存在（例如 timeout/exit code/check failure）；
- 同一目标没有已打开的同类 proposal；
- 预算、频率、并发限制未超；
- 输入未触发 secret/prompt-injection/quarantine 规则。

#### 5.2 再过统计门

用历史 replay 校准，不直接采用未经验证的 `0.7`：

- 为每个动作分别估计 precision、recall、abstain rate；
- 对自动推进使用保守的 precision 下界（例如 Wilson lower bound），而不是只看点估计；
- 高风险动作要求 `hard_evidence && calibrated_confidence`，且默认仍需人工；
- 低风险动作也必须先 shadow 一段时间；
- 校准数据不足时默认 `AWAITING_REVIEW`，而不是把低样本当高置信。

初始上线建议：

- Phase 0：只记录 proposal，所有 proposal 都 `ABSTAINED`/shadow，不改变账本；
- Phase 1：只允许 `no_op`、`annotate`、`ask_user` 进入人工审核；
- Phase 2：在历史 replay 和 shadow precision 达标后，允许极低风险备注自动落账；
- Phase 3：`mark_blocked`/`retry_run` 仍人工确认；在明确预算、回滚和 canary 后才考虑受限自动；
- 任何时候都不自动 merge code。

概率阈值应该由风险和损失决定，而不是把所有动作共用一个数字。`0.7` 可以作为 Jev 的调用参数起点，但不能作为 taskboard 的通用自动执行阈值；本仓库现有 `workflow-pick` 的 0.7 只是 workflow 选择建议阈值（[`src/workflow-pick.ts`](../../src/workflow-pick.ts)）。

### 6. 人工确认与权限

建议新增 proposal 级确认，而不是复用 `run.confirm`：

- `run.confirm` 的语义是“放行一个已创建、等待执行的 run”；
- proposal 可能有 `ask_user`、`annotate`、`mark_blocked` 等非 run 动作；
- 两者混用会让审计无法区分“同意看板建议”和“同意消耗模型执行”。

人工卡片至少展示：

- 观察到的原始事件及 hash；
- 当前 task/run 状态与 base revision；
- 建议动作、置信度、确定性证据；
- 预期变更（before/after）；
- 风险等级、撤销方法、有效期；
- 接受、拒绝、要求补充、稍后处理。

对“以后都自动接受”必须限定为具体动作、workspace、时间窗和条件，并生成审计记录；不能做成全局静默放行。

### 7. 幂等与并发

至少做四层幂等：

1. **event 去重**：同一个 `source + thread_id + source_turn_id + seq + kind + payload_hash` 只入库一次；
2. **proposal 去重**：
   `sha256(workspace_id | thread_id | source_turn_id | event_seq | action | policy_version | base_ledger_revision)`
   相同键返回已有 proposal，不重复调用模型；
3. **apply 去重**：接受请求带 `proposal_id + apply_key`，重复请求返回第一次结果；
4. **dispatch 去重**：一个 proposal 只允许生成一个 child/retry；重试需新 proposal 和新 key，并受 attempts 上限。

`Ledger` 已有单调 revision、串行 `mutate` 和 requestId 幂等表（[`src/ledger.ts`](../../src/ledger.ts)），但当前 `mutate` 本身不接收 expected revision。建议在 mutator 内检查 `snapshot().revision === base_revision`，不建议在 mutator 外先读后写；否则会出现 TOCTOU（检查后到写入前状态变化）。失败时返回 `stale_revision`，让 proposal 进入 `EXPIRED` 或重新分类。

### 8. 证据包

每个 proposal 保存一个可复核的 evidence bundle：

```json
{
  "proposal_id": "...",
  "event_ids": ["..."],
  "event_hashes": ["..."],
  "task_id": "...",
  "run_id": "...",
  "thread_id": "...",
  "source_turn_id": "...",
  "base_ledger_revision": 42,
  "observed_state": {"task": "doing", "run": "running"},
  "hard_gates": {"has_timeout": true, "active_run": false},
  "model": {"name": "jev", "version": "...", "spec_hash": "..."},
  "prediction": {"action": "mark_blocked", "confidence": 0.0},
  "human_decision": {"actor": "...", "decision": "reject", "reason": "..."},
  "application": {"status": "not_applied"},
  "outcome": {"check": "pending"}
}
```

证据要区分：

- **原始证据**：事件、CLI JSONL、退出码、check 输出、diff、Git object；
- **派生证据**：模型摘要、置信度、风险评分；
- **人的决定**：不是模型证据；
- **执行结果**：check 通过、后续回归、耗时、成本。

不要把未脱敏的 token、cookie、完整个人对话或凭据写入报告。taskboard 现有 self-improve 已对 checks/run evidence 做截断和 redaction（[`src/self-improve.ts`](../../src/self-improve.ts)），事件管线应沿用同样的边界。

### 9. 失败回退与运行保护

- **预测超时/解析失败**：记录 `ABSTAINED`，不改变 Ledger；
- **stale revision**：proposal 过期，重新读取事件再分类，不沿用旧判断；
- **dispatch 失败**：run 标 failed/blocked 并附操作错误；不自动循环重试；
- **apply 后发现错误**：写补偿事件并恢复状态，不删除历史事件或报告；
- **重复/乱序事件**：以 `seq + hash` 检查，缺失 watermark 的事件进入 quarantine，不能用不完整输入推进；
- **模型/提供商故障**：断路器 + 指数退避 + 告警，避免每个 tick 都调用 Jev；
- **预算耗尽**：停止自动 proposal，保留人工入口；
- **人工队列积压**：停止自动推进，防止审核变成橡皮图章；
- **危险输入**：session/tool output 里的 prompt injection 只作为数据，不进入策略控制平面；高风险动作永远要求人工确认；
- **紧急停止**：提供全局 kill switch、按 workspace 的暂停开关和单 proposal 撤销。

回滚不等于删除：taskboard 的 Ledger 已经以原子 rename、单调 revision 和审计字段保存状态（[`src/ledger.ts`](../../src/ledger.ts)）。补偿事件应保留 `source_proposal_id`、`reason` 和 `compensates_event_id`。

### 10. 与代码修改的关系

这个编排层不应该直接产生“自动改代码并合并”的能力。推荐两条独立管道：

```text
看板推进：事件 -> 规则/Jev proposal -> 人工确认 -> Ledger 状态 -> verify
代码改进：self-improve -> worktree + checks -> 人工 review -> merge
```

当预测器认为需要改代码时，只能创建 **self-improve/普通 coding task 的草案或子任务**，并明确走 `confirm` 或人工创建流程。这保持 taskboard 现有的安全边界：预测器可以提示“下一步值得做什么”，但不能自己拥有代码合并权。

## 风险与评估指标

### 1. 主要风险

| 风险 | 触发方式 | 控制 |
|---|---|---|
| 错误推进 | 小模型把“等待用户”误判成“失败可重试” | hard evidence、review、拒绝自由动作 |
| 自我确认 | 提议者、评价者、总结者是同一模型 | 独立 reviewer、deterministic checks、human gate |
| 过拟合测试 | 只让现有 checks 变绿，语义反而更差 | 定向任务集、behavior contrast、回归测试 |
| 反馈污染 | 错误经验写入 memory，再污染后续判断 | provenance、TTL、stale/冲突处理、定期整理 |
| prompt injection | tool output/仓库文本试图改变策略 | 将内容视为数据、隔离控制 prompt、拒绝高风险自动动作 |
| 证据泄漏 | 会话日志含 token、私密代码或个人数据 | 最小化采集、redaction、access control、保留期限 |
| stale 竞态 | 事件 A 生成 proposal，事件 B 已改变状态 | revision/CAS、TTL、重新分类 |
| 重复执行 | 同一事件被定时器/重放重复消费 | 四层幂等键、append-only event id、dispatch lease |
| 审核橡皮图章 | proposal 太多或默认“接受” | 限流、抽样复核、按动作统计 reject/override |
| 成本失控 | 每次 tick 都调用 Jev/Codex 或递归探索 | 事件驱动、预算、并发上限、断路器 |
| benchmark Goodhart | 优化分数而不优化真实任务 | 多任务、人工抽检、回归窗口、held-out cases |

### 2. 指标：编排层

建议先定义“什么算正确动作”，再定义指标：

- **高风险错误自动推进数**：目标为 0；任何自动 `retry/create/close` 的误推进都要单独审计。
- **按动作的 precision / recall / F1**：`no_op`、`ask_user`、`mark_blocked`、`retry_run` 分别统计，不能混成一个准确率。
- **abstain rate**：低置信放弃比例；太低可能是过度自信，太高则没有产品价值。
- **human override rate / reject rate**：人工推翻预测的比例；按动作和时间窗口看。
- **stale revision rejection rate**：说明事件/账本竞态是否频繁。
- **duplicate suppression rate**：重复事件/重复 proposal/重复 dispatch 的拦截量。
- **time-to-proposal / time-to-resolution**：从事件观察到建议、从建议到解决的时间。
- **review turnaround**：人工确认耗时；若持续上升，应暂停自动推进或减少 proposal 量。

### 3. 指标：预测质量与校准

- **Brier score** 与 **ECE**：评估概率预测；必须按动作、workspace、模型版本分组，不能只看全局。
- **reliability curve / calibration bins**：检查高置信区间是否真的更准确。
- **top-1 accuracy** 与 **top-to-second margin**：对 `choice` 尤其重要；不要只看 confidence。
- **false abstain rate**：本可安全推进却总是放弃，会降低收益。
- **分布漂移**：事件类型、任务域、模型版本改变时重新校准。

Jev/TypeSafe 文档明确指出 confidence 不等于正确率；因此指标必须来自 taskboard 自己的 replay 数据，而不是借用 workflow-pick 的 0.7（[confidence](https://docs.typesafe.ai/confidence.md)、[`src/workflow-pick.ts`](../../src/workflow-pick.ts)）。

### 4. 指标：taskboard self-improve

- **候选产出率**：每次 self-improve 是否产出有 diff 的候选；
- **no-op 比例**：没有安全改动时正确 abstain 的比例，不应被当成失败；
- **check 通过率**：setup、baseline、after 的分别统计；
- **baseline-vs-candidate 行为差**：同类任务成功率、失败恢复率、命令数、token、时延；
- **人工 merge acceptance rate**：候选被合并/拒绝的比例；
- **revert / regression rate**：合并后 7/30 天回滚、失败、回归的比例；
- **review time**：每个候选的人工审查时间；
- **重复问题率**：经验库是否降低了同类重复改动；
- **branch stale / conflict rate**：base 漂移和合并冲突；
- **cost per accepted improvement**：不是 cost per run；应以被采纳改动为单位。

### 5. 评估协议

1. **离线回放**：从历史 run/events 构造带标签样本；标签来自人工 accept/reject、check 结果、后续回归。
2. **时间切分**：训练/校准与测试按时间切开，不能随机打乱同一 run 的事件。
3. **按域切分**：仓库、任务类型、模型版本分别留出 held-out。
4. **shadow**：新 predictor 只产生 proposal，不影响 Ledger；至少观察一段有代表性的流量。
5. **suggest-only**：所有动作人工确认，衡量采纳率和 override。
6. **canary**：只对低风险动作、少量 workspace 开启自动；设回滚阈值。
7. **复核**：定期抽样原始事件，检查 redaction、事件丢失和标签错误。
8. **停止条件**：高风险误推进、连续 stale、review backlog、成本超预算、模型/供应商故障时自动降级到 `ABSTAINED`。

**推断**：没有离线回放和 shadow 的“高置信直接推进”会把产品的第一次上线变成数据收集实验，代价由真实任务承担；这不符合 taskboard 当前“证据优先、人工合并”的设计气质。

## 来源

### RSI / 历史与代表性论文

1. Irving John Good, *Speculations Concerning the First Ultraintelligent Machine*（Virginia Tech 记录与摘要）：<https://vtechworks.lib.vt.edu/items/5085379d-b24c-424e-8861-e70a47b4b2fb/full>
2. MIRI, *Intelligence Explosion FAQ*：<https://intelligence.org/ie-faq/>
3. Harness² 论文：<https://arxiv.org/abs/2610.14224>
4. Harness² HTML（定义、方法、Limitations、Failure Analysis）：<https://arxiv.org/html/2610.14224v1>
5. Harness² GitHub：<https://github.com/google-research/harness2>
6. Harness² 项目页：<https://harness2.github.io>
7. STaR：<https://arxiv.org/abs/2203.14465>
8. Self-Rewarding Language Models：<https://arxiv.org/abs/2401.10020>
9. Absolute Zero：<https://arxiv.org/abs/2505.03335>
10. Promptbreeder：<https://arxiv.org/abs/2309.16797>
11. Reflexion：<https://arxiv.org/abs/2303.11366>
12. ADAS：<https://arxiv.org/abs/2408.08435>
13. AFlow：<https://arxiv.org/abs/2410.10762>
14. GEPA：<https://arxiv.org/abs/2507.19457>
15. SICA：<https://arxiv.org/abs/2504.15228>
16. Darwin Gödel Machine：<https://arxiv.org/abs/2505.22954>

### Codex / OpenAI 一手资料

1. Iterative repair loops：<https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex>
2. Skill evals（trace、deterministic checks、rubric、10–20 个 case）：<https://developers.openai.com/blog/eval-skills>
3. Long-horizon Codex（spec/plan/implement/documentation）：<https://developers.openai.com/blog/run-long-horizon-tasks-with-codex>
4. Scheduled tasks（worktree、首次运行审查、CLI 无管理界面）：<https://learn.chatgpt.com/docs/automations>
5. Composer Predictions（文本、draft、不自动发送、当前 thread）：<https://learn.chatgpt.com/docs/features/composer-predictions.md>
6. Codex app-server prediction 协议：<https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_prediction.rs>

### 其他产品官方资料

1. Claude Code memory / auto memory / prompt-audit：<https://code.claude.com/docs/en/memory.md>
2. Devin Memory and Dreaming：<https://docs.devin.ai/product-guides/memory.md>
3. Devin Automations：<https://docs.devin.ai/product-guides/automations.md>
4. TypeSafe primitives：<https://docs.typesafe.ai/primitives.md>
5. TypeSafe confidence：<https://docs.typesafe.ai/confidence.md>

### taskboard 本地实现

1. 需求 R29：`docs/archive/REQUIREMENTS-v1.md`
2. self-improve 实现：`src/self-improve.ts`
3. runner 的 self-improve 调度与证据收集：`src/runner.ts`
4. Codex JSONL adapter：`src/codex-adapter.ts`
5. Jev workflow 路由：`src/workflow-pick.ts`
6. Ledger revision、mutation 和幂等：`src/ledger.ts`
7. 运行边界与不扫描会话存储：`README.md`、`AGENTS.md`
