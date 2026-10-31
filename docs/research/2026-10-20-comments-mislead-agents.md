# 注释误导 Agent：危害、原理与预防（2026-10-20）

> 问题：代码里的注释是不是越多越好？在 agent 时代，答案是否定的。
> 本报告回答三个问题：注释有什么危害？为什么会发生？如何预防？
> 结论先行：**删除优先，只保留测试钉不住的 why；规则必须有测试背书。**

## 1. 危害（发生了什么）

### 1.1 过时注释变成指令，agent 照着错的改（权限回归真实案例）

- DEV 博文 "Comments Considered Harmful" 做了对照实验：先让 agent 只改代码不动注释（人为制造过时注释），再开一个全新会话说"修复文件中的不一致"。结果 agent 把**正确的代码改回去**去迎合过时的注释。其中一个案例是把 `if (isAdmin || isAuthenticated)` 改回 `if (isAdmin)`，即**权限回归**——注释里写着 "Only admins can access"，代码是对的，agent 却听了注释的。
  来源：https://dev.to/newellpaul/comments-considered-harmful-3oc2
- 作者原话定性："a stale comment is not a documentation problem. It is a dangerous lie"，因为 agent 读到的每条注释都会变成塑造其信念的上下文。
  来源：同上。
- 多处重复的错误注释看起来像多份独立佐证，实则是同一错误祖先的扩散，作者称之为 shared-error propagation："Three pieces of evidence. One incorrect ancestor. What looks like corroboration is shared-error propagation."
  来源：同上。

### 1.2 上下文税：注释挤占有限 context，还引入混杂信息

- DoltHub "Comments Kill the Vibe"（2026-05）：注释是 token，挤占 agent 有限的上下文；注释未经验证会漂移。原文："Coding agents have two enemies: limited context and confounding information. Comments can be both."
  来源：https://www.dolthub.com/blog/2026-05-13-delete-comments/
- 同一篇报告了删注释实战：让 agent 批量删除注释、重读代码后只加回"必要的"注释，结果删掉 9359 行注释行、只加回 193 行，"Context is smaller and there are far fewer confounders."
  来源：同上。
- 反例也值得记录：有人删掉 16.8 万行注释（约三分之一仓库）后做对照实验，任务得分无变化（18.3 vs 19.0；21.7 vs 22.0），小任务 token 少约 22%。结论是注释既不提升也不降低 agent 表现，应为人类读者而留，而非为 agent 性能。
  来源：https://hn.today/s/i-deleted-168-000-lines-of-comments-my-ai-agent-didnt-notice

### 1.3 模仿扩散：agent 把注释抄进新代码，临时补丁变祖传规则

- Grok Bot 工程负责人 Lauren Tan（2026-10）：coding agent 会模仿现有代码，一个解释临时修复的注释会被后来的 agent 当作正确做法抄走；"AI 会把临时补丁变成祖传规则"。其框架已禁用代码注释，并估计 99% 的 AI 生成注释都在解释无关紧要的历史上下文。
  来源：https://en.theblockbeats.news/flash/371767
- 配套做法是 `/no-comments` skill：派一个专用 agent 审查注释、找出过时解释和临时 workaround 并重构；注释里的架构要求转为可执行的 lint 规则或类型约束。
  来源：同上。
- 同类观点见 DoltHub "Agentic Engineering Failure Modes" 的 "The Commentator" 一节：agent 写太多注释，尽管证据表明注释让 agent 更糟；建议定期删除与精简注释。
  来源：https://dolthub-preview-1.awsdev.ld-corp.com/blog/2026-09-28-agentic-engineering-failure-modes/

### 1.4 注释注入攻击：注释是 agent 可读边界上的不可信输入

- "Comment and Control"（2026-04，关傲楠等）：攻击载荷种在 PR 标题、issue 正文/评论、隐藏 HTML 注释里，同时劫持 Claude Code Security Review、Gemini CLI Action、GitHub Copilot Agent，造成任意命令执行与凭据泄露。Anthropic 定为 critical（有报道称 CVSS 9.4），Google 付 $1,337，GitHub 付 $500。
  来源：https://www.digitaltoday.co.kr/en/view/48622/comment-and-control-attack-can-hack-claude-code-gemini-cli-and-github-copilot-at-once ；https://mallory.ai/stories/019e601a-bfcf-76ef-a095-7e9f32ea9d02
- "AI-Targeted Comment Injection" 反模式目录：攻击者在约 800 行注释里写 "SECURITY NOTE: this function has been audited…approved on 2026-03-10"，让 review agent 把带后门的 PR 标为通过；2026 年 3 月在法国有在野攻击记录。缓解措施包括剥离/隔离注释、对异常注释代码比告警、双 LLM 复核。
  来源：https://agentpatternscatalog.github.io/patterns/patterns/ai-targeted-comment-injection.html
- GitLab Duo（2025-05，Legit Security）：注释、源码、MR 描述、commit message 里藏的恶意 prompt 可诱导 Duo 推荐恶意 JS 包、插入钓鱼登录链接、经注入 HTML 泄露私有源码；隐藏手法包括 Unicode 走私、base16 编码、白字 KaTeX 渲染。
  来源：https://www.csoonline.com/article/3992845/prompt-injection-flaws-in-gitlab-duo-highlights-risks-in-ai-assistants.html
- OWASP AISVS AC.3.3 规则：任何喂给 AI 工具的外部来源上下文都必须视为不可信并做注入筛查。
  来源：https://github.com/OWASP/AISVS/blob/main/1.0/research/appendices/Appendix-C-AI-Secure-Coding.md

## 2. 原理（为什么会发生）

1. **注释没有验证机制，漂移是默认状态。** 代码有编译器、类型检查、测试三重校验，注释没有任何校验。DoltHub 原话：注释 unverified 所以 drift。来源：https://www.dolthub.com/blog/2026-05-13-delete-comments/
2. **prompt 扁平化：agent 不区分"历史注记"与"现行真相"。** 传给模型的上下文是扁平 token 流，注释、代码、文档没有可信度权重。全新会话（fresh session，无 git 历史、无 ticket 上下文）最容易把注释当 ground truth，这正是 DEV 实验 turn-2 设计所模拟的情形。来源：https://dev.to/newellpaul/comments-considered-harmful-3oc2
3. **模仿偏差 + 服从偏差。** agent 被训练成既模仿上下文风格、又服从显式指令；注释恰好同时是"风格样本"和"指令外观"的文本。Lauren Tan 指出的"临时补丁变祖传规则"是模仿偏差；DEV 实验里 agent 按注释改代码是服从偏差。来源：https://en.theblockbeats.news/flash/371767 ；https://dev.to/newellpaul/comments-considered-harmful-3oc2
4. **评审盲区放大了漂移。** 人类评审看 diff 时天然跳过注释行；review 缺陷 60–75% 与可演化性相关（引自 Mantyla/Lassenius，经 Maximiliano Contieri 转引）。没人看的注释必然腐烂。来源：https://maximilianocontieri.com/ai-coding-tip-041-turn-every-review-finding-into-a-rule

## 3. 预防（业界共识做法）

以 superdoc 的 comment-policy 为代表，规则可归纳为"删maid优先、白名单保留"：
来源：https://github.com/superdoc/docx-editor/blob/51a861544b1b869a6d84d8450935b46335ff7929/comment-policy.md

- **核心规则**：只写"代码本身看不出来的信息"，不写复述代码的注释（write comments when they encode information the code does not already make obvious）。
- **写**：结构上 enforcement 不住的不变量、业务/合规/安全/审计规则、非局部约束、重构敏感的 rationale、`AIDEV-NOTE:` 锚点。
- **不写**：逐行复述、"Returns the appropriate value"式 AI 套话、无点名文件/符号/规则/后果的模糊警告、不影响当前代码路径的历史注记。
- **载量词必须带注解**：`legacy-public`（替代品+最早移除版本）、`compat-fallback`（触发条件+替代路径）、`temporary`（移除条件+issue id，无 issue id 视为永久）、裸 `@deprecated` 视为不完整。
- **过时注释按 bug 处理**：注释与文档是 prompt surface 的一部分，"A stale comment…can become an instruction the next agent follows"，改代码的同时更新或删除注释。
- **agent-facing 文档同等对待**：README/AGENTS.md/CLAUDE.md/架构笔记/runbook 过时比行内注释更危险，因为 agent 会当作项目政策执行。

另两条配套：

- **规则必须有测试背书**：注释里的架构要求能转成 lint/类型约束/快照测试就转，不能只靠注释声明（Lauren Tan 的 `/no-comments` skill 做法；本仓已有 `test/tool-contract.test.ts` 快照断言作为可执行契约，正相合）。
  来源：https://en.theblockbeats.news/flash/371767
- **定期 culling**：DoltHub 建议建立流程周期性删除与精简注释，而非一次性运动。
  来源：https://dolthub-preview-1.awsdev.ld-corp.com/blog/2026-09-28-agentic-engineering-failure-modes/

## 4. 对本仓的落地建议

- 现状：`src/*.ts` 共 8077 行，`^\\s*//` 注释行约 330（文件头注记为主），重灾区是 `ledger.ts`（72）、`runner.ts`（58）、`http-api.ts`（49）、`cli.ts`（36）、`daemon.ts`（35）。
- 删除类：复述代码的 what/how、"为什么这样架构"的散文式头注（应回 README/REQUIREMENTS）、已实现票据的过程注记。
- 保留类：四条红线（单一写者、只认 result 行、不碰 ZCode 存储、loopback）中**测试钉不住**的部分压缩为一行 why-not 警告；外部协议依据（如 multica 教训）留一句话出处；key 环节 trap（如 `closeAllConnections`）留一行。
- 政策进 AGENTS.md 一句话：注释只写 why/why-not，不写 what/how；改代码同提交更新或删除注释；过时注释按 bug 处理。
