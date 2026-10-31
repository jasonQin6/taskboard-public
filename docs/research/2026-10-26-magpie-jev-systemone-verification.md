# Magpie Jev SystemOne 接线验证（2026-10-26）

对应词汇：`GLOSSARY.md` 的 SystemOne 条（默认 provider 为 Magpie，Jev 是 provider 候选）。
本报告只记录外部运行时事实与接线方式，不改需求与词汇；后续代码真正接入时再按规矩改
`docs/REQUIREMENTS.md` 并补单测。

## 背景

- opencode 托管的免费 Jev（`jev-1.13-free`）经实测不可用：无 key 与 OpenCode Go 订阅 key
  直调 `https://opencode.ai/inference/systemone/v1/systemone` 均为 `HTTP 429 FreeUsageLimitError`
  （免费模型要求 OpenCode 客户端）；且 Go 订阅目录（刚刷新，38 个模型）里根本没有 Jev 模型。
- 用户随后在 vol-server 的 Magpie 里添加了 TypeSafe key（`typesafe` provider），本报告验证
  Magpie 提供的 Jev 是否可用、以及项目里的 SystemOne 调用应如何经 Magpie 发起。

## 验证环境

- 主机：vol-server（`klein@vol-server`，SSH 直连；禁止用 root，见项目记忆）。
- Magpie `v0.1.1292-54-g83a75e6`；网关由 `magpie serve` 提供，`http://127.0.0.1:3425`
  （`magpie daemon` 未安装，网关随 app/serve 常驻；只绑 loopback，跨机访问走 ADR-0007 的代理栅栏）。
- Provider：`TypeSafe Jev`（`typesafe`），2 个模型：`typesafe/jev-latest`、`typesafe/jev-preview`。

## 验证结果（全部通过）

1. `magpie provider test typesafe`：decide 通道正常（约 2.7s，`jev-latest`）。
2. 网关 `GET /v1/models` 共 29 个模型，无 Jev、无 free：符合预期，决策模型不进 chat 列表。
3. `POST /v1/systemone`，`model: typesafe/jev-latest`，noul 单题：
   `HTTP 200`（约 1.8s），serving 版本为 `jev-1.14.0`（比 opencode 文档的 `jev-1.13` 新），
   `is_urgent.noul = 0.96`，附 `usage.input_tokens/output_tokens`。
4. `POST /v1/systemone`，`model: typesafe/jev-preview`，choice + score 双题：
   `HTTP 200`（约 1.6s），`department.choice = returns`（confidence 1.0，带完整概率分布），
   `frustration.score = 1.14`（confidence 0.7，带 legend 与概率分布）。
5. 反向确认：`POST /v1/chat/completions` 用 `typesafe/jev-latest` 返回 `HTTP 400`
  （"only decides ... it holds no conversation"）：Jev 不能当聊天模型用，误用会被网关明确拒绝。

验证时用的网关 caller key 只在服务端读取、未落盘未打印；TypeSafe 侧 key 由 Magpie 保管，
Taskboard 不直接持有。

## 后续代码接线规范

- Endpoint：`http://127.0.0.1:3425/v1/systemone`（本机网关；地址与端口随部署而异，不得硬编码，
  建议经环境变量注入，缺省指向 loopback 网关）。
- Model：`typesafe/jev-latest`（稳定默认）；尝鲜用 `typesafe/jev-preview`。
  注意网关实际 serving 的是 TypeSafe 原厂版本（如 `jev-1.14.0`），与 opencode 文档版本号无关。
- 认证：HTTP `Authorization: Bearer <网关 caller key>`；key 经环境变量注入，不进仓库、不打日志。
- 请求体（SystemOne 协议）：`{model, state, questions}`，题型仅 `noul` / `choice` / `score`，
  question 内只带 `type` / `instructions` / `criteria`，多余字段会被拒（与 jev skill 的约束一致）。
- 失败语义：超时、连接错误、非法输出一律按既有断路器处理（连续失败 3 次暂停该 thread 自动评估，
  见词汇表断路器条），与 Codex driver 失败同口径。
- 计费：走用户自己的 TypeSafe key 按量（约 $0.00002/次量级），与 opencode 免费额度无关，
  之前 `jev-1.13-free` 的 429 卡点在此通路上不存在。
- 运行时零依赖不变量不变：客户端只用 Node 内置模块（`fetch`/`http`），不新增运行时依赖。
- 术语区分：项目内的 Jev 指提案判断层（走 Codex driver，见 `src/jev.ts` 头注）；这里的 Jev 是
  SystemOne 层的外部决策模型 provider 候选。两者同名不同物，GLOSSARY 已有定义，不新增词条。

## 参考

- OpenCode Console 模型文档（含 Jev 节）：<https://opencode.ai/v2/docs/console/models/#jev>
- TypeSafe primitives / confidence：<https://docs.typesafe.ai/primitives.md>、
  <https://docs.typesafe.ai/confidence.md>
- 本仓旧研报（Jev 语义与阈值讨论）：`docs/research/2026-10-21-self-improvement-rsi-harness2.md`
