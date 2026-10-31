# ADR-0024：retro 并入 taskboard 主库与 legacy 账本退役映射

日期：2026-10-31｜状态：已接受（2026-10-31 #67 修订存量迁移决策，见下）

## Context

retro 此前有两套各自为政的持久化：触发账本 `~/.zcode/hooks/retro-ledger.sqlite`（stop-retro hook 的状态机），组合观察账本 `~/.retro/combos.jsonl`（combo-extract 的 backfill 产物）。两者都在 taskboard 主库之外，与「SQLite 作为唯一事实源」（ADR-0001）相悖；且三个全局 hook 从未生效（ZCode 只发现项目根配置），账本数据全部是 backfill 产物。#65 起 retro 并入 taskboard 子功能（ADR-0023 已放行 daemon 与短命 CLI 多进程并发写），需要定义两套 legacy 数据到主库 `retro` / `retro_combo` 两表的语义映射。

## Decision

- retro 数据落 taskboard 主库（迁移 v11 两表），写入必经 repository 层（`src/store/retro-store.ts`），遵守 ADR-0023 纪律。
- **retro-ledger.sqlite 状态机映射**（只定义映射，不迁移存量数据）：

  | legacy（retro-ledger.sqlite） | 主库 `retro` 表 |
  | --- | --- |
  | `session_id` PRIMARY KEY | 身份键之一：`(source, session_id)`；另有 `(source, attempt_id)`（ZCode dwf runId），二者至少其一 |
  | `status = 'continuation_open'`（未处理） | `status = 'open'` |
  | `status = 'done' / 'failed' / 'skipped'` | 同名：`done / failed / skipped` |
  | `trigger` | `source ∈ ('interactive','headless','attempt')`（触发面即来源分类） |
  | `attempts`（failed 且 <3 可重试） | 同名列、同语义：重试预算由触发面声明，`record` 重放同载荷不消耗（`attempts` 只增不减） |
  | `opened_at / updated_at / verified_at / last_error` | `created_at / updated_at / last_error`；`verified_at` 不保留——旧库用「文件出现」作完成证据，新库的记录本身即产物载荷（`conclusion / findings / not_covered`），无需二次核验时间 |
  | `output_path` | 不迁移：产物内容进库（`findings_json`），路径只是 legacy 的间接寻址 |
  | `prompt_version / hook_version / session_date / cwd` | 同名列保留 |

- **combos.jsonl 映射**：`retro_combo` 表按 schema v1 字段建列（session_id 为幂等键，同 session 刷新、`first_seen` 首见冻结；`verdict / actual / outcome` 整体存 JSON，`form / form_hint / skills` 自 `actual` 提升为列）。
- **combos.jsonl 存量迁移（#67 修订，取代本 ADR 初版「存量不迁移」）**：组合提取的 sink 已收编 taskboard CLI（`taskboard retro combo-record --stdin`），生产者输出定形，迁移顾虑消除。`scripts/retro-combo-backfill.ts` 一次性全量导入（行数对账一致后把原文件改名 `.retired` 归档，不删除）；同型判据查询面 `taskboard retro combo-same-type` 随之下沉，skill 归一化（小写、去 `pstack:` 前缀）唯一实现在 store 层，消费方不得自算。
- legacy 两账本文件不删除、不再写：retro 账本停更即为退役，历史可查文件本身（combos.jsonl 以 `.retired` 副本形式保全原文）。

## 被否决的替代方案

- ~~存量数据迁移进主库：不采用。retro-ledger 存量可由 session 日志重建，combos.jsonl 全部是 backfill 产物且组合提取逻辑改造是后续票；本片迁移只会把未定型的生产者输出固化进 schema。~~（#67 修订：combos.jsonl 部分撤销——sink 收编后生产者输出已定形，迁移+对账+归档；retro-ledger.sqlite 部分维持不迁移，存量可由 session 日志重建。）
- `verified_at` 语义并入新表：不采用。旧状态机「open → 等文件 → verify 判 done」是 hook 无法直接拿到产物时的间接判定；新 CLI 载荷直接携带产物，间接层失去存在理由。

## Consequences

- `status` 词汇变为 `open | done | failed | skipped`，`continuation_open` 只存在于映射文档与 legacy 文件中。
- 「未处理/failed 且 attempts<3 可重试」的触发门判定改在主库上做（触发面是后续票），判据 = 无行，或行 `status='failed' AND attempts<3`。
- 两表写入不推动域 revision：retro 是账本不是看板状态，Phase 1 UI 不消费；「唯一写路径」约束的是事务层而非 revision。
