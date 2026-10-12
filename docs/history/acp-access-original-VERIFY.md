# 隔离原型验证记录

## 当前结论

原型实现与本机自动化验证完成；**未宣称真实 SSH 登录或现用 GUI 已接通**。

在一个独立启动的 Node 进程中真实挂载官方 DSH AgentLoop/AgentRegistry/ToolRuntime/LlmRuntime 与 JSONL persistence，两名模拟已认证账号同时接入，返回同一服务器 runtime PID。模型使用确定性本地替身，未调用真实模型、未消耗配额。

## 正向验收

运行 `scripts/verify.ps1`，全部出口 0：

| 验证 | 结果 |
|---|---|
| 原有业务 TypeScript 类型检查 | PASS |
| 原有业务测试 | 282 tests / 64 suites，0 failures |
| 原有业务构建 | PASS |
| 接入/连接器测试 | 19 tests，0 failures |
| 真实官方 DSH 集成测试 | 8 tests，0 failures |

主要验收点：

- 账号独立密钥、短期签名、serviceId 与一次性 nonce 验证，拒绝伪造/过期/复用。
- 无可信连接器身份时不能进入 ACP；客户端不能重协商成员身份。
- 共享 runtime PID、多独立成员会话、服务器固定 cwd。
- 他人 sessionId 无法读取/恢复/提交/取消/关闭。
- requestId/messageId 阻止重复提交；映射恢复失败不新建、不重放。
- 自动重连恢复保存记录，不调用业务 prompt。
- disconnect 只取消对应成员当前一轮，不回滚替身已提交记录、不影响另一成员。
- 真实 DSH error 不报 completed；取消后保存 partial text，使用同一个 sessionId 恢复。
- 真实 business `plan_confirm` 执行身份来自登录绑定；伪造 `submitted_by` 被可信账号覆盖。
- scoped `session_declare_member` 不可替换可信身份；旧实现原封保留。
- 插件 apply/LLM adapter 真实挂载；恢复通知 source=plugin，不变成业务用户输入；辅助模型调用不触发远端业务。
- stdio 连接器 + deployment-local socket + 真实官方 DSH 服务完整内存/本机链路通过。
- 独立 `server-cli` 子进程只起一套 DSH，两个账号连接同一个 PID；测试结束收集子进程退出。

## 反向验证（内存 mutation，不修改原型源码）

四个有意破坏版本均使对应测试退出 1；外层验证程序确认这些失败后退出 0：

| 破坏项 | 被测试发现 |
|---|---|
| 去掉业务操作的 owner 检查 | YES（所有权错误契约变化；连接归属仍独立阻挡操作） |
| 允许相同 requestId 再执行 | YES（重复提交未拒绝） |
| 不覆盖模型伪造的 submitted_by | YES（真实业务库提交者记录错误） |
| 允许声明工具改变登录绑定身份 | YES（不可变身份断言失败） |

源码由 `scripts/mutation-hook.mjs` 在单个测试进程的 import hook 中临时转换，退出即失效；没有覆盖生产源码或数据库。

## 测试发现并修复的问题

不是把非零出口忽略掉：

1. Cordis 4 没有 Context.start/stop：改用 fiber.await/dispose；确认真实 loop 输出和 resume。
2. 不同会话通过未隔离 service slot 提供身份会冲突：将该 slot 明确 isolation，并以持久会话绑定作为实际业务身份来源。
3. 官方 assistant stream 事件是一个 `{agent,frame}` payload，不是两个参数：补上真实 text 断言并修正。
4. 现有工作台 submitted_by 仍接受字面量：原型 scoped tool 包装从可信 account 覆盖，不更改旧业务源码。
5. 恢复 notice 必须使用支持的 user/message + plugin source 与字符串 surfaceOp；真实 event 契约测试锁定。
6. Windows 子进程 --import 需要 file URL：修正并独立 launcher 验证。
7. activation 期间断线与消费者背压的清理顺序：回归覆盖 opening/draining，不发布泄漏 handle。

## 验证边界

| 层次 | 状态 |
|---|---|
| 自动化模拟账号/协议和请求重发防护 | 已通过 |
| 真实官方 DSH loop、工具与持久化 | 已通过（0.1.5-rc.2 family） |
| 独立 server process + 本地 socket + stdio connector | 已通过 |
| Linux SSH 公钥登录与文件权限/成员组隔离 | 未验证；本机没有 sshd/外部测试服务器 |
| 真实 SSH host key mismatch | 未验证；仅参数保护断言 |
| 现用 DSH Web GUI（0.2 family）端到端 | 未验证，未安装/重建现用配置 |
| 真实模型业务对话 | 未验证；只用本地确定性替身 |
| 文件上传/下载、管理员授权、现用库迁移 | 不在本轮范围 |

模拟签名账号不等于真实已认证人类。该原型的服务器身份可信性最终仍取决于 root provisioned forced-command connector、凭据权限和 sshd 部署。这三项未通过真实环境验收前不可用于正式多成员业务。

## 证据

测试日志保存在仓库忽略目录 `.dsh/acp-access-evidence/`，不进入版本控制、不含真实凭据。可通过 `scripts/verify.ps1` 重建。README 列出对应命令。

本輪没有改动现用 DSH profile/桌面插件或业务数据库；仅新增 `prototypes/acp-access/`、补记目标术语表，并重建忽略的原有业务编译产物用于测试。
