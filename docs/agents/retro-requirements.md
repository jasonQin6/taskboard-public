# retro 载荷的仓库额外要求

Stop hook（`scripts/stop-retro.sh`）注入的收尾 retro 除通用要求外，按本仓库语境遵守：

- findings 只收环境/流程类改进（七类：navigation / checks / standards / steering / tool-economy / no-op / info-access）；业务代码风格意见写进 conclusion 一笔带过或不写。
- 与 `docs/adr/` 不变量冲突的改进（如绕过事务层直写库、新增运行时依赖）不写成 improvement，写入 notCovered——改不变量先写新 ADR。
- 每条 evidence 必须可定位：轮次号或命令/文件路径 + 一行原文摘录，不得转述。
- findings ≤ 5 条：只保留本会话有证据支撑、下一次会话可直接执行的改进。
