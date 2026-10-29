# 0.7.2-rc.4 候选：QR 模式资格巡检不再中止运行中的轮次

## 候选状态与授权边界

本文件描述**拟议预发布候选**。本轮授权为：创建修复分支、提交推送、通过草稿 PR 运行双平台 CI 与打包。合并 main、创建 tag／Release、部署服务器均需用户单独明确授权。

- 分支 `fix/qualification-monitor-qr-project-link-20261029`，从 `bbb7462`（已部署的 0.7.2-rc.3）继续。
- 包版本 `0.7.2-rc.3` → `0.7.2-rc.4`；不发布 npm／插件市场，`private: true` 不变。
- 保留业务数据、成员身份、设备登录、会话历史与未知请求，不回滚数据库、不重放旧请求。

## 修复的问题

**症状**：协作服务每一轮对话都在 1 秒内结束，客户端收到 `Remote turn cancelled; committed data remains`；服务端 `turn/end` 为 `{kind:"aborted",reason:{kind:"user"}}`，`assistant/attempt` 的 `stream` 为空数组，模型未产出任何 token。

**根因**：`src/service.mjs` 的 `authorizationMonitor` 每秒对每个运行中会话调用 `requireQualification()`，后者使用**稳定资格**变体 `requireProjectLink()`。但 `QrIdentityStore extends MvpIdentityStore` 只覆盖了 `requireProject`，**未覆盖 `requireProjectLink`**，于是回落到 `IdentityStore` 基类实现，去查 `collaboration_participants` 表。QR／MVP 模式下成员在所有项目可见、从不写入该表，`collaboration_participants` 恒为 0 行，因此 `requireProjectLink` 每次必抛 `-32003`，巡检每秒 `abort()` 一次运行中的轮次。

由 `6bea40d`（「keep long turns alive when the organization re-verification lease lapses」）引入：该修复为避开组织复验租约的误判，把 `requireMember` 换成 `requireMemberLink`，同时把 `requireProject` 换成了 `requireProjectLink`，而 QR 模式没有对应实现。

**实证**（可写数据库副本，直接调用线上 store）：

```
requireProject      OK    {"enabled":1,"revision":1}
requireProjectLink  THROW -32003 | Member authentication or authorization unavailable
collaboration_participants rows: 0    projects rows: 7
```

## 修复内容

`src/mvp-identities.mjs` 为 `MvpIdentityStore` 补 `requireProjectLink(account, projectId)`：项目可见性判断与 `requireProject` 完全一致（成员已启用、corp/client 匹配、项目存在），但使用 `requireMemberLink` 从而**不施加组织复验租约**，与该方法的稳定资格语义相符。

`QrIdentityStore` 继承该实现，无需改动。

不修改巡检频率、不修改 `requireQualification` 的检查项、不放宽任何真实撤销路径（账号禁用、组织主体变更、成员／参与方版本、epoch 轮换、登录撤销与过期仍会中止）。

## 验证

- **单元测试**：服务端 259/265 通过，3 项失败为 Windows 环境 `python` 存根的既有 `member-zerotier` 用例，与本次改动无关；`test/mvp-identity.test.mjs` 新增 `requireProjectLink` 正向断言与不存在项目时的拒绝断言。
- **线上等效验证**：按巡检逻辑遍历全部 13 个会话，修复后 `ok=13 wouldAbort=0`（修复前全部会被中止）。
- **真实模型请求**：`POST https://cpa.lafinger.us.ci:8343/v1/responses`、模型 `deepseek-v4.1-flash` → HTTP 200、`status=completed`、耗时 10.95 s、正常返回文本。超过 1 秒仍完整跑完，正是修复前必然被掐断的场景。
- **客户端确认**：用户在协作服务会话中已能正常收到回复。

本候选必须重新运行本地完整门禁与双平台 CI，不拿上述工作树结果冒充本候选固定提交已通过；实际结果以对应草稿 PR 的检查及工件为准。

## 部署注意

该修复此前以热补丁形式直接写在线上 `releases/bbb7462…` 的解包目录内（备份在 `private-state/config-backups/20261029-requireprojectlink-fix/`）。正式部署 0.7.2-rc.4 时该目录整体替换，热补丁自然失效且被正式修复取代；不需要、也不应再单独还原热补丁。

## 遗留风险

- 3 个既有会话文件仍记录旧模型 id（`deepseek-v4.1-flash-1017`）与 `replayState api: openai-responses`；续接这些老会话的行为未验证。
- 本次未做完整业务验收（材料分析、方案确认、评审、验收全链路），仅验证到「真实轮次可正常完成」。
