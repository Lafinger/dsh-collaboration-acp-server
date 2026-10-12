# 服务端验证

`pnpm run check` 独立安装依赖后类型检查/编译业务模块，执行原 282 项业务回归、服务端协议/身份测试与官方 DSH loop 集成；运行时与检查不读取原仓库或客户端源码。

覆盖独立账号签名/过期/nonce、未认证拒绝、固定 cwd、他人会话拒绝、稳定请求 ID 去重、断线取消与保留已提交记录、opening/draining 生命周期、真实 DSH 取消/错误和同 sessionId 持久化恢复、业务 plan_confirm 的可信账号快照、socket+stdio connector 与独立双成员单 PID 启动。

联合测试单独执行：`DSH_COLLABORATION_CLIENT_ROOT` 必须显式选择客户端目录；检查契约/protocol helper byte equality，并用客户端 adapter 与真实服务端替身运行时进行两轮与恢复验证。不是服务端常规运行依赖。

打包检查抽取 tarball，核验所有 entry/import 存在并启动其中的 fixture runtime；不从旧仓读取业务 lib。真实 Linux SSH/权限隔离、现用 GUI 0.2、真实模型尚未验收。服务器固定替身不调用模型网络、不消耗配额。

## 拆分后实测结果

Windows、Node 24.21.0、pnpm 11.7.0、服务端独立 fresh node_modules 和 lockfile：

- 类型检查、业务 build **PASS**。
- 业务回归 **282/282 PASS（64 suites）**。
- 接入/connector 单元测试 **14/14 PASS**。
- 官方真实 DSH 集成 **6/6 PASS**。
- 四项内存 mutation（owner-check、request-replay、forged-snapshot、mutable-identity）均被测试断言检出。
- tarball 内部 entry/import 与抽取后的 fixture runtime 启动 **PASS**。
- 新文档和迁入业务文档的相对链接审计 **PASS**。

迁入文件仅移除六处原有 EOF 空行、修复旧原型相对链接；正文与业务逻辑未改。新仓设置 CRLF-aware whitespace check 以保留原文换行。打包检查增加 PAX/GNU Unicode 长路径支持后，包含业务中文文档的 tarball 再次通过。

本仓现有 check 和包 smoke 都使用本仓依赖，不需缓存 hook 或原仓。服务端显式联合测试 **3/3 PASS**：契约一致、adapter 双轮与恢复、真实本地+远端 DSH loop 和辅助调用拒绝；客户端联合契约 **1/1 PASS**。

原型历史结果在[归档记录](history/acp-access-original-VERIFY.md)，不代替拆分后检查。检查日志位于忽略的 `.dsh/evidence`，不提交密钥/数据库/生成文件。全程没有使用 subagent，原仓库与现用 profile 保留不变。
