# 阻止“临时补丁变祖传规则”：别人怎么解决的（2026-10-20）

> 起因：Grok Bot 负责人 Lauren Tan 的观点——coding agent 会模仿上下文，
> 解释临时修复的注释会被后来的 agent 当作正确做法抄走，“AI 会把临时补丁变成祖传规则”。
> 本报告回答：业界用什么机制阻止这件事。
> 结论先行：**注释删不干净，靠人会复发；只有把约束编码进结构（类型/lint/测试/CI）才能根治。**

## 1. 问题确认：这不是个例

- Lauren Tan（前 Cursor，现 SpaceX Grok Bot 工程负责人）呼吁删除绝大多数代码注释，估计她见到的
  AI 生成注释 99% 在解释无关紧要的历史上下文。例：工程师只要求某 PR 别用某种风格，
  agent 却把这条要求写进注释，留给后续 agent 当永久规则执行。
  来源：https://en.theblockbeats.news/flash/371767
- 她用的开发框架 Dune 已禁用代码注释；例外只有三类：解不掉的外部约束（浏览器兼容、
  第三方依赖）、公开 API 文档、license 声明。
  来源：https://desty.github.io/en/blog/81-pstack-merge-without-review/
- 她在公开分享里给“让 agent 可信的东西”排了序（强到弱）：代码库本身 > 静态分析
  （lint/编译器/CI）> 规则 > bot review 与 skill > 靠人工在 review 里执行的风格指南。
  来源：同上。

## 2. 核心解法：把教训编码进结构（pstack）

Tan 开源工具箱 pstack 的原则 `encode-lessons-in-structure` 是这套做法的完整表述：
“把重复出现的修复编码进机制（工具、代码、元数据、自动化），而不是写成文字指令。
文字指令容易被忽略；结构机制不需要配合就能强制执行。”
来源：https://github.com/hyudryu/plugins/blob/feature/pstack-zcode-migration/pstack/skills/principle-encode-lessons-in-structure/SKILL.md

### 2.1 三步模式（第二次写同样的指令时触发）

1. 问：这能做成 lint 规则、元数据标记、运行时检查或脚本吗？
2. 能 → 编码它，删掉文字指令。
3. 不能（真的需要判断力）→ 让指令更醒目，并附上失败模式的例子。
来源：同上。

### 2.2 强度排序（选最强的一档）

不可编译的非法状态（类型/联合类型）> 失败 CI 的 lint 或禁用 API >
 canonical helper（唯一正统写法）> 运行时检查。
理由原文：“因为 agent 会复制周围代码已有的做法，弱一档的守卫会成为下一个模板。”
（该理由是 6 月 4 日提交专门加进去的。）
来源：同上；https://desty.github.io/en/blog/81-pstack-merge-without-review/

### 2.3 推论

“如果修复是结构性的，就只用结构性修复。指令本身就是症状。”（The instruction IS the symptom.）
来源：https://skillsmp.com/creators/edheltzel/do-pstack/skills-do-principle-encode-lessons-in-structure

## 3. 执行机制：删注释的子代理（/no-comments + Comment Sicko）

- `/no-comments` 派一个只读的专用审查子代理（Comment Sicko），它只标记、从不写应用代码，
  真正的修复由 skill 另做。
  来源：https://pmackay.github.io/sdlc-wiki/capability/pstack-no-comments
- 约束类注释（do not remove、改前先问 X）走“编码提议”而非直接删除：按当前最便宜的
  类型/运行时/测试/CI lint 把约束变为可执行，等待批准后编码并删除注释；
  无批准则注释照样删除，约束记为 open 上报。
  来源：同上。
- 自己代码里的“意外行为”注释一律不保留：删注释，并把对应符号标 MUST KILL，
  要求改名或重构让代码自解释。
  来源：https://pmackay.github.io/sdlc-wiki/capability/pstack-comment-sicko
- 社区复刻版（lauren-poteto-rules）总结成两句：“把代码库当记忆，agent 会连坏模式一起抄”；
  “用架构、类型、lint、CI 代替重复的 review 意见。”
  来源：https://github.com/unicodef1wn/lauren-poteto-rules

## 4. 同类工具：把守卫放到 prompt 之下

共同判断：prompt 层的指令（CLAUDE.md、注释、system prompt）拦不住，
守卫必须活在 prompt 之下的层（工具调用路径、commit 钩子、CI）。

- agent-guard 的 Comment-slop guard：给新增注释打分（注释里的死代码、复述、
  changelog、道歉、emoji、空洞 docstring），超阈值拦截，或 `decomment --fix` 一次清掉。
  原话：“prompt 层指令阻止不了这个，guardrail 必须活在工具调用路径里。”
  来源：https://devpost.com/software/agent-guard-behavior-guardrail-hooks-for-coding-agents
- ai-guardrails：配置带 SHA-256 头，绕过工具改规则即判篡改，“agent 不能削弱自己的规则”；
  三环：agent hook + commit hook + CI 门。
  来源：https://www.npmjs.com/package/@questi0nm4rk/ai-guardrails
- archdrift：agent 可读、人可改、CI 强制的 `ARCHITECTURE.md`，`archdrift check`
  在现实偏离文档契约时 exit 1，“文档烂不掉，因为烂了构建就红”。
  来源：https://pypi.org/project/archdrift/
- guardrails（Rust）：`banned-import / banned-pattern / ratchet` 等规则；
  ratchet 只收紧（如 legacy 调用上限 47 → 40），新增旧调用即 CI 失败。
  来源：https://docs.rs/crate/guardrails/0.1.1
- 反例（为什么只靠文档不行）：auto-mobile #11875 显示 CLAUDE.md 30 天改 24 次、
  手抄的工具列表与 BATS 测试数（913 vs 实际 2102 个 @test）腐烂；提议的修复正是
  “测试/lint 断言文档里的每个工具名真实存在，否则删掉该节”。
  来源：https://github.com/kaeawc/auto-mobile/issues/11875

## 5. 对本仓的落地建议（按强度排序）

本仓已有雏形：`test/tool-contract.test.ts` 快照断言 = 可执行契约（强度第 2 档），
AGENTS.md 红线 + REQUIREMENTS 需求真相源（第 3 档以下）。缺的是闭环。

1. **类型档（最强，缺什么补什么）**：把注释里的“只认 X”收成字面量联合类型，
   让非法值编译不过。本仓 `types.ts` 的 `baseline|confirm`、`manual|cascade` 多数字段
   已是联合类型——保持，新增约束优先用这档。
2. **测试档（已有）**：注释里但凡出现行为断言（“X 时返回 Y”、“绝不 Z”），
   对应在单测里找断言；找不到就补测试再删注释。本仓 snapshot 契约是范例，可扩大到
   红线语义（如 loopback 绑定、单一写者）。
3. **定期 culling（/no-comments 平替）**：无子代理可派，改用固定流程——每次改行为的
   提交顺手删相关注释（AGENTS.md 已立规矩）；每季度跑一次全仓注释审计，
   问每个块“这是第几档？能编码吗？”
4. **文档防腐**：REQUIREMENTS 是唯一真相源已经立住；下一步是 archdrift 式断言——
   需求条目编号（如 R26）在测试名里引用，需求删改时测试先红。
   注意 Tan 的排序：需求文档属于弱档，它之所以有效是因为有测试（第 2 档）在托底。

不建议做的：引入外部 guardrail 工具链（本仓零运行时依赖红线，commit hook/CI 门
属于重武器，当前体量下人工 review + 测试托底已够）。
