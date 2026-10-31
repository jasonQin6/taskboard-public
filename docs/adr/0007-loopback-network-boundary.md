# ADR-0007：网络边界——恒绑 loopback、无认证、CSRF 基线与可选代理栅栏

日期：2026-10-21｜状态：已接受

## Context

本机单用户信任模型，没有账号体系；但任意跨站网页都可以向 `localhost` 发请求，DNS rebinding 可改写 Host。

## Decision

- HTTP 恒绑 `127.0.0.1`，第一版无认证。
- CSRF 基线：POST 只接受 `Content-Type: application/json`；校验 `Origin`/`Host` 为回环或显式允许的来源，拒绝跨站请求。
- 跨机/反代能力只走可选代理栅栏：`trustedProxyHosts` 非空才开启，默认关；开启后 daemon 仍只绑 `127.0.0.1`。写面（POST action）要求受信来源 + 正确 `x-taskboard-token`；读面本机回环无条件放行。
- 只认 socket 远端地址，不解析 `X-Forwarded-For`；令牌取环境变量，不落库、不打日志，比较用常量时间。
- 栅栏关闭时 CSRF 基线仍然生效。

## Consequences

- 无需账号/权限系统即可安全暴露在本机。
- 远程访问是显式配置行为，且不因配置放开监听地址。
