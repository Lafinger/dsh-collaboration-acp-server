# 运行与数据维护

## 数据职责

stateRoot 下 `access.sqlite` 保存会话 owner、请求提交状态、恢复事件；`workbench.sqlite` 是项目业务权威库；官方 JSONL sessions 保存模型对话和工具记录。它们不是跨存储分布式事务，不承诺未知副作用 exactly-once。

断线取消该会话当前一轮，保留已经提交数据，flush/关闭对应 live agent；共享服务与其他会话继续。恢复要同一账号和同一 sessionId；仅附加/读取历史，不自动 prompt。进程重启将未完成请求标 interrupted，重复 requestId 仍拒绝。

业务层 retained session identity 表是兼容桥：可信 setup 绑定账号，scoped session_declare_member 禁止重声明，submitted_by 由可信账号覆盖。原自我声明实现作为业务历史代码保留；本轮未执行旧库数据迁移。

## 安全维护

备份需要同时考虑业务 SQLite、access 状态与 JSONL 会话；先停止或使用各存储一致性备份方案。不得将密钥/数据库提交 Git；更换 account secret 后更新服务配置和该账号 root-owned connector 凭据。不在日志输出凭据或签名票据。

账号/组、root-owned parent directory、sshd forced command、可信 host key 是部署边界；模拟签名测试不证明它们已经正确配置。

## 限制

该运行时只装配工作台工具，不暴露本地 terminal/fs/MCP 给客户端。会话间是逻辑隔离而不是 OS sandbox 多租户隔离；服务器管理员与真实模型路线拥有可信执行能力。管理员权限与项目创建权限仍待后续设计。
