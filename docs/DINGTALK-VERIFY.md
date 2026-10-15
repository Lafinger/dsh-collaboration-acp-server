# 钉钉统一身份与受控通信：本地离线验收

## 范围与当前结论

**本地实现（含用户已选择的钉钉模型日志保留维护）、实际宿主装配与隔离回归通过；真实钉钉平台／现用GUI／Linux新版本部署未验收。** 本次没有推送、发布、生产升级、实际清库、真实平台登录或发消息、付费模型调用。全部平台与模型测试使用明确模拟源，真实Cordis、DSH Agent loop、工具、会话持久化及SQLite不作替身。

基线：DSH0.2.0-rc.2、Node24.21.0、pnpm11.7.0。服务端／客户端Cordis4.0.4；fork保留上游开发依赖Cordis4.0.1，但三仓库联合实际装配在服务端4.0.4宿主中。fork用户来源[Lafinger/dsh-im](https://github.com/Lafinger/dsh-im)，固定上游commit `f6a9dd0abbeae605e459a660a9922c9a703e6aa0`，保留MIT来源。

## 最新已收集证据

| 检查 | 已核对结果 | 不代表 |
|---|---|---|
| 服务端完整检查 | 285业务／70安全接入／18宿主集成全部通过；部署检查11项，9通过、2项POSIX条件skip | 真实OAuth、Stream、Linux新版部署通过 |
| 客户端完整检查 | 36单元／8集成、构建及审计全部通过；客户端侧协议联合1项通过 | 现用GUI已升级或真实扫码 |
| 三仓库联合 | 6项通过（含真实React页面），源码协议／helper字节一致；实际服务端+专属IM Cordis入口+独立MemberClient | 真实钉钉字段和权限可用 |
| 真实React页面 | 单项通过：扫码发起／领取、项目选择、历史／通信、登出；无token／隐藏prompt | 浏览器端到端、视觉或HMR验收 |
| fork完整回归 | 4146项，4139通过、7项上游既有平台条件skip、0失败，构建与包校验通过 | 被skip的条件已验证 |
| 本地打包 | 服务端、客户端tar脱离源码加载通过；fork专属tar真实Cordis加载和专属依赖闭包通过 | 已发布、已经安装、默认IM bundle适用于协作 |
| 日志保留维护 | 6单元＋3真实Host集成通过，含明文／zstd、精确路径拒绝、活动服务／会话内核锁、hash及中断tombstone | 已在真实数据执行、Linux原生锁分支已验收 |
| 安全补测 | 附件提交前授权回滚、官方明确失效、空缺角色逐角色确认、断线登出、晚到Stream关闭均通过 | 端到端恰好一次、能收回已发副本 |

### 2026-10-14独立Ubuntu测试后端批次（不替代真实扫码验收）

- 上述完整服务端／客户端结果为原离线批次；本轮未声称重跑全部服务端／客户端检查。
- 钉钉fork发送字段修正后，最新完整回归4150项：4143通过、7项既有条件skip、0失败；10项定向测试及6项三仓库联合通过。修正私聊官方 `invalidStaffIdList/flowControlledStaffIdList` 与群酷应用 `coolAppCode`；真实发送未执行。
- Ubuntu192.168.2.20在全新专属账号／目录／业务库下启动官方DSH0.2.0-rc.2 CLI profile，固定Codego deepseek-v4.1-flash，模型请求门禁启用；仅loopback19481与Unixsocket。没有默认IM、机器人Stream、管理HTTP、另一个业务运行时或付费请求。
- 官方API只读验证两位内部成员userId／unionId及active；用户明确管理员对应关系后绑定成员并创建仅两人参与的DEMO，未分配项目职责。AppSecret及模型密钥留在服务器私有0600配置，未导出聊天。
- Windows默认可信TLS验证10条实际后端边界；两成员在同一真实Host的登录发起302、组织／应用／scope／回调、Secure HttpOnly SameSite cookie、扫码前项目访问拒绝、错误设备／换浏览器拒绝、未扫码claim=pending均通过。没有跟随授权跳转扫码；只退休本轮临时pending请求，未清库／推进全局epoch。
- 服务优雅重启后业务库integrity=ok、FK检查0异常、成员／DEMO仍在、无设备登录与inbox／outbox。实际Linux native flock独占分支及离线实际Cordis／LLM模型门禁测试通过，但完整日志维护删除流程未在Linux重验。
- 既有Nginx主配置、专用HTTPS配置／service／续签hook指纹未变；新代码root拥有不可由服务改写，状态0700、配置0600、socket0660；专用后端active/running并开机启用。
- **现用GUI未安装新版客户端、成员SSH入口／设备密钥尚未部署，实际扫码／客户端领取、机器人接收发送仍未验收。** 不应将后台登录发起探针当成成员SSH或端到端登录。

### 关键安全覆盖

- SSH账号与扫码用户、组织／应用、设备proof／state／浏览器cookie／一次性code严格绑定，不回退senderId／昵称／isAdmin。
- 登录token哈希、12小时到期、组织缓存最多5分钟；全局停用／项目撤销／角色变化／官方明确失效递增范围修订，旧上下文不因重授恢复。
- 管理资格、项目参与、九职责分开；新项目初始名单明确，管理CLI只在OS本地。待生效方案暂停且保留旧拒绝／确认，明确修订后逐角色重收；空缺角色不替其他合格角色决定，也不自动通过。
- 关联资料／分析／方案／任务／成果和成果文件的实际归属递归核对；本人todo/notice由服务器当前角色派生，群不借私聊工具。
- 同Host借现有Agent/session/LLM，不另起业务运行时；默认IM管理、卡片审批、文件、同步和Host工具隔离，组件启动失败／卸载清理。
- ACK前同步FULL SQLite提交，去重与epoch保存；出站逐段accepted／unknown／partial，不重跑未知效果，不伪造消息ID或已读。
- 发送前复核目标／作者／受众／订阅／当前对象版本；目标变更不改投，全部群成员校验不足停止受保护内容，承认外部竞态。
- IM只发布成功turn最后已提交助手消息，无思考流、工具前中间文本、取消或失败片段；自然语言模型每成员10次／小时，固定命令／订阅不调用模型。
- 附件接收／归档提交前授权失败回滚文件及SQLite；旧reset拒绝新配置或含安全表的新库，不能抹掉tombstone。

## 复现（仅隔离环境）

```sh
# server: installed independent pinned dependencies
node scripts/check.mjs
DSH_COLLABORATION_CLIENT_ROOT=/absolute/client DSH_COLLABORATION_IM_ROOT=/absolute/im node --import ./scripts/official-loader.mjs --test --test-concurrency=1 --test-timeout=20000 test/joint/*.joint.mjs
# client
node scripts/check.mjs
DSH_COLLABORATION_SERVER_ROOT=/absolute/server node --test test/joint/*.joint.mjs
# fork
node plugin-src/client/build.mjs
node plugin-src/host/build.mjs
node --test --test-concurrency=1 --test-timeout=15000 test/*.test.mjs test/channels/*/*.test.mjs
node scripts/verify-package.mjs
# locally pack; never publish or enable default bundle
pnpm pack --out .dsh/local.tgz
node scripts/check-controlled-package.mjs .dsh/local.tgz
```

完整测试采用有界串行模式以避免Windows Node并行test子进程偶发不能退出。旧的两个非钉钉挂起文件单独复验通过。三个上游Windows测试断言修正仅为CRLF解析、JSON路径反转义、复用已有POSIX/Windows权限辅助，不改变普通IM运行时、不新增skip。

## 已确认的保留范围及真实平台停止条件

用户已选择覆盖本插件拥有的钉钉模型会话日志；已实现并通过6单元＋3真实Host集成验证。以服务／会话内核锁、精确登记目录／header、dry-run清单hash、先提交tombstone再逐文件删除实现停服维护，保留DSH会话、其他Host会话、formal数据及去重／epoch。90天过期或purged上下文不resume，使用新ID。操作及中断恢复见[日志保留维护](<DINGTALK-RETENTION.md>)。没有实际清理或自动删除；备份／平台副本不包括在删除结果内。

真实验收仍需[部署指南](<DINGTALK-DEPLOYMENT.md>)中的组织、内部应用、HTTPS、员工转换／详情权限、私聊必要可信字段、群模板或酷应用完整成员API、Stream ACK、真实平台发送结果与断线崩溃演练。任一可信身份、权限、独占消费或持久门槛不足，不开启双向链路；不降级到SSH-only、普通默认IM或另一接收目标。
