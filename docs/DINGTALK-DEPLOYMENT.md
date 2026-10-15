# 钉钉实施后的隔离部署与操作指南

**仅操作模板，本次没有变更现用容器、插件配置、远端发布或生产数据。** 实施进度见[记录](<DINGTALK-IMPLEMENTATION.md>)，两端使用[协议v3](<PROTOCOL-v3.json>)，拒绝旧v2，不允许SSH-only回退。

## 1. 必须先准备的真实条件

1. 一个钉钉组织、企业内部应用及机器人；登录与机器人须同 `corpId/clientId`，管理员提供明确内部员工userId与作用域unionId映射。必要权限包括内部应用token、个人登录授权、员工转换、成员信息读权限（详情active及unionid校验）、机器人私聊／群发送、合格群成员查询。不要把秘密发到聊天。
2. HTTPS登录origin及官方后台授权回调，同源使用 `/collaboration/oauth/callback`；HTTPS代理只映射专属三类GET路由到127.0.0.1。参考[代理模板](<../examples/dingtalk-login.nginx.example.conf>)，回调查询参数不要写访问日志。origin含非默认端口时代理须保持完整Host。
3. 客户端可信SSH主机指纹／账号密钥、trusted loginOrigin；真实成员必须匹配管理员配置的SSH入口。身份转换或私聊可信字段不足均为上线停止条件。
4. 如启用公开群沟通，须群模板或群聊酷应用、群成员API权限及完整成员名单；所有成员须同组织、已开通、具备对应项目参与资格。普通群／API失败只保持不发送受保护内容，不改投私聊。

## 2. 同Host专属装配（最小依赖收敛）

本地fork为 [Lafinger/dsh-im](https://github.com/Lafinger/dsh-im)，固定上游v4.39.0提交。专属子入口 `@xmanrui/dsh-im/controlled-dingtalk` 不使用上游默认Host控制器，因而不用补入默认IM管理链要求的connection／Typert／工作区会话管理服务。服务端业务继续借用现有Agent/LLM/session/tools/persistence，一个Host、一个业务库。

这是为了实现已经确认的“只走专属受控链路”，不是更换普通问答替代方案：专属路径没有默认管理RPC、delivery HTTP、审批、文件、模型切换或会话同步。默认IM Host与受控组件在协作profile内互斥；同平台应用也不得在另一个Host运行第二消费者。

参考[profile片段](<../examples/dingtalk-profile.patch.example.yml>)，**两个组件默认disabled**。先分别安装本地验证产物，明确停用dsh-im默认bundle，再由管理员启用；此模板未覆盖现用profile。服务端[私有配置模板](<../examples/server-config.example.json>)、[机器人配置模板](<../examples/dingtalk-controlled.example.json>)须服务账号mode0600保存。组织资格缓存默认5分钟，设备登录12小时，通信正文90天；只能配置更短，不能无限沿用。模型route保持显式固定，无自动fallback。

## 3. 本地管理员开通（非模型工具／公网RPC）

只在服务器服务账号或受信任OS管理员环境运行，两个参数是私有文件的绝对路径，不把凭据放参数或shell历史。

```sh
node /absolute/server/src/admin-cli.mjs /absolute/private/server-config.json /absolute/private/command.json
```

若通过pnpm的软链接路径调用，上述原CLI入口判断在当前包版本可能跳过执行而退出0且无输出。隔离Ubuntu部署已以空库只读检查及路径差分确认此现象，实际操作使用先解析的canonical realpath（例如`readlink -f`解析入口）再运行同一CLI；不要把无输出当成功，更不要盲重绑或清库。该批次属于部署规避，通用CLI源码尚未在此修正。

命令JSON模板：

```json
{"action":"bind","account":"alice","userId":"OFFICIAL_INTERNAL_USER_ID","unionId":"SCOPED_UNION_ID","administrator":true}
```

```json
{"action":"create","key":"DEMO","name":"隔离项目","participants":["alice","bob"]}
```

```json
{"action":"role","projectId":"PROJECT_ID","role":"product","account":"alice"}
```

```json
{"action":"target","id":"bob-private","projectId":"PROJECT_ID","kind":"private","account":"bob","botId":"BOT_ID","corpId":"CORP_ID","clientId":"CLIENT_ID","robotCode":"ROBOT_CODE","route":{"userId":"BOB_USER_ID"}}
```

```json
{"action":"target","id":"project-group","projectId":"PROJECT_ID","kind":"group","account":null,"botId":"BOT_ID","corpId":"CORP_ID","clientId":"CLIENT_ID","robotCode":"ROBOT_CODE","publicEnabled":true,"route":{"openConversationId":"GROUP_ID","groupKind":"template"}}
```

群聊酷应用使用 `groupKind: "cool-app"` 并明确 `coolAppCode`；不可省略后假设有群能力。同一路由不要配置到多个项目，以免入站归属不明确。

```json
{"action":"subscription","id":"alice-reminders","projectId":"PROJECT_ID","account":"alice","targetId":"alice-private","kinds":["todo","notice","communication"],"enabled":true}
```

支持 `enable`全局停用／开通、`participate`项目资格、`members`成员概要、`inspect`项目角色／名单、`communications`状态计数／目标和订阅概要。管理概要不读取私人正文。没有管理员自动pm或自动私人历史读取；role必须现有参与者。换人使受影响待生效方案暂停，保留旧决定，人明确修订后重收确认。资格／角色修订号停用旧上下文，不因重新授权复活。

## 4. 成员用法

客户端配置填 `loginOrigin`，重新启用后在“协作服务”页面发起扫码，打开可信HTTPS页，扫码后点“完成登录”。服务token只在客户端Host内存，到期／Host重启需重新扫码；不保存于浏览器localStorage或聊天。先新建本地会话，再选项目和协作模型。已有远端映射不能切项目；旧无项目会话只允许本人认证后查看历史。

钉钉私聊示例：

```text
/项目 DEMO /待办
/项目 DEMO /通知
/项目 DEMO /资料
/项目 DEMO /状态
/项目 DEMO /请求 bob-private private 请澄清某处含义
/项目 DEMO /答复 REQUEST_UUID 这里的“同意”只是沟通文本
/项目 DEMO /收悉 REQUEST_UUID
/项目 DEMO /记录 REQUEST_UUID
/项目 DEMO 我目前需要处理什么？
```

自然语言只在私聊明确项目后触发窄化只读模型，沿用服务器固定路线；每成员每小时最多10次主动IM模型问答。固定命令／提醒不调模型，不自动推进业务。群只允许显式公开到当前目标的 `/请求 TARGET_ID public 文本`、已公开原请求的 `/答复 REQUEST_UUID 文本` 和不含私人资料的引导，不能把群问的本人待办回答到群里。私聊的`/帮助`、`/项目列表`只有管理员已明确配置可唯一识别的本人私聊路由时回复，不猜接收人。

## 5. 可靠性、停用与人工核对

- 入站先持久再ACK，稳定机器人／messageId去重；reject也记录结果。保存后崩溃／处理中断不自动重跑模型或通信效果，标unknown留给人工核对。
- 出站intent和每段先存库；pending仅表示尚未确证出站，platform-accepted不代表送达／已读；partial／unknown不得把整条重发。平台processQueryKey不是消息ID。确认结果未知时检查实际聊天与通信历史，必要时用新的显式请求ID发起新通信，不能承诺恰好一次。
- 订阅从已提交事实派生，每60秒检查；每段发送前重核资格、订阅、目标revision、当前待办版本，停用订阅不会继续旧pending提醒。不自动改投其他人或群。
- 官方确认员工失效／身份映射改变时递增成员revision、撤销旧设备并暂停受影响待生效方案；重新具备资格也不复活旧上下文。临时网络故障／缺权限则过期即拒绝访问，不冒充正式离职事实。
- 资格变化当次工具／提交／出站检查立即生效；后台最多1秒检测本地命令变化并中止仍在运行模型。组织缓存到期阻断继续输出，重新请求时主动复核。外部群成员变化和本库不是一个事务，已发送副本无法收回。
- 断线不承诺平台完整补投；目前由管理员重新启用专属组件，不对unknown结果盲重放。

正文保留期限后须管理员明确执行停服维护；用户已选择**同时覆盖本插件拥有的钉钉模型会话日志**。新命令见[日志保留维护](<DINGTALK-RETENTION.md>)：先停机器人与整个协作Host，以服务账号、实际Host JSONL根目录进行dry-run，审核精确会话清单和`planHash`，再用相同hash明确apply。运行中服务／会话内核锁、非法路径、符号链接、未知文件、其他会话或改动过的清单都会拒绝，不尝试接管活跃写入；只清到期且登记的IM日志，保留metadata/dedup/epoch／审计与旧ID tombstone。正式项目、资料、决定、DSH会话、其他宿主会话和备份不删。

旧的本地`{"action":"purge","confirmation":"PURGE_EXPIRED_COMMUNICATION_BODIES"}`仍仅清数据库正文，其结果明确提示未清模型日志，不能当作完整90天维护。待处理／发送中的正文保留并须人工核对。无自动定时删除，需管理员安排维护窗口；保留期上限90天，模型上下文达到保留期会换新ID，不从过期日志继续问答。**本次仅以临时合成数据验收，没有清理实际数据或平台副本。**

关联答复的出站目标在原请求保存时固定：原目标缺失、停用、改址或revision变化只记录答复且显示 `recorded-not-sent`，不寻找新的目标。本人私聊路由多义时拒绝自动选择。

## 6. 新测试批次与旧重置脚本

```json
{"action":"epoch","confirmation":"REVOKE_ALL_DEVICE_LOGINS"}
```

该命令只撤销设备、推进测试epoch、拒绝旧上下文／旧IM关联，不清库。实际重置必须先停机器人和协作服务、冻结队列、另行核对备份和路径、客户端映射及保留去重／epoch。**现有旧清库脚本禁止用于新认证／通信库**，不能删除认证tombstone再重建冒充新批次；本次没有授权或执行重置。真实平台验收未完成时不得双向上线。
