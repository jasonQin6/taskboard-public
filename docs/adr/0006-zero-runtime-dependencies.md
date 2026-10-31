# ADR-0006：运行时零依赖

日期：2026-10-21｜状态：已接受

## Context

daemon 的可分发性与供应链暴露面要小；Node ≥ 24 已内置 `node:sqlite` 与 zstd，前端构建链（React/Vite）与测试链（Playwright）不属于运行时。

## Decision

- 运行时只用 Node 内置模块。
- 新增依赖只能进 devDependencies；React、Vite、Playwright 及一切构建/测试链依赖属此类，构建产物由 daemon 静态服务。
- 引入运行时依赖属架构变更：先写新 ADR 说明理由，再改代码。

## Consequences

- `pnpm install` 只为开发与测试；生产部署只依赖 Node 版本。
- Node 大版本升级（如依赖新的内置 API）是显式决策，需求文档标注最低版本。
