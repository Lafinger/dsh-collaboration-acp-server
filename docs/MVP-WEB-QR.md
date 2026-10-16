# 网页扫码MVP：实现、升级与验收边界

用户已最终确认“确认，按网页扫码最小改版方案开始实施”。范围见[已确认方案](<MVP-网页扫码登录改版方案.md>)；本文件记录实现与操作门槛，不代表已上线或真人扫码已通过。当前正式服务仍为PC版，升级须先固定双平台成功CI及真实扫码验证，不撤销现有设备或再次清库。

## 一、配套双端入口

客户端默认设置页点击“钉钉扫码登录”后，Host只向系统默认浏览器打开**当前请求的同源HTTPS页面**；原设备proof不进浏览器。页面用严格同源JSON POST绑定Secure／HttpOnly／SameSite=Lax cookie，随后重定向到钉钉官方托管OAuth页。手机扫码并完成官方授权后，电脑浏览器回调统一HTTPS入口，服务器交换一次性网页授权码、核验组织／内部有效员工并自动登记稳定身份。原DSH轮询自动领取，不手输核对码、不点“我已扫码”、不增加应用第二次确认。页面、日志和URL不包含本服务7天token；回调成功／失败均303到无参数结果页。

- 新客户端要求发现信息`mvpHttpsVersion:2, loginMethod:dingtalk-qr`和初始化能力一致，向服务端声明`webQrLogin:1`。协作协议仍v3，附件扩展及业务协议不改。
- [扫码专用服务](<../src/qr-service.mjs>)不开放PC、SSH、旧预绑定账号或公开业务；旧PC客户端收到明确版本不兼容，而不是悄悄转去另一登录。
- 原业务、7天固定设备期限、5分钟组织复核、稳定成员／固定管理员和会话私密性不变。实际授权者是登录者，误扫退出本机重扫，不能按电脑主人猜身份。

## 二、请求恢复与取消

[扫码状态机](<../src/qr-login.mjs>)每设备只容纳一个进行中的请求，最长5分钟。原设备在Windows系统密文中保存待完成proof／到期／取消意图，重启不会自动打开浏览器。发起结果未知时用**只查询、不创建**的`collaboration/login/resume`恢复原请求；不存在则明确失败，不自动重建。

一次官方code先提交占用再外部交换，过程中崩溃标记失败，不再次交换。领取响应丢失时，在原5分钟内用原proof返回同一token／固定到期，不颁第二个设备登录或续7天。token由原256位proof做域隔离HMAC派生，服务器始终只保存token／proof／浏览器能力哈希，不保留可解密token副本；客户端安全落盘后ack关闭短暂领取恢复。浏览器能力与设备token采用不同域，不能由二维码链接推导设备token。

取消在服务端原子判定。取消成功则迟到回调／领取无效；若领取先完成，明确显示已经完成并可退出，不伪报取消了既有登录。取消结果未知保留加密取消意图，刷新／重启先核对取消，不偷偷领取。浏览器关闭不等同取消。

## 三、服务器配置与保留切换

新鲜隔离验证使用[空配置模板](<../examples/mvp-qr.example.json>)中的`mode:mvp-qr`，无需PC AgentId。原配置的组织／应用秘密、serviceId、workspace、stateRoot、provider／model不因升级改变。新模式启动**拒绝自动采用**旧PC数据库，避免“只升级包就让人退出”。

只有真实链路、固定成功CI、准确只读现况和无正在执行写入全部满足，维护停服并持有原内核锁后才调用[显式认证升级CLI](<../src/qr-upgrade-cli.mjs>)：

```sh
node /verified/package/src/qr-upgrade-cli.mjs /absolute/private/config.json REVOKE_PC_DEVICES_PRESERVE_MEMBERS_AND_SESSIONS
```

它校验原组织／应用／服务／固定管理员，事务内仅撤销原PC设备登录、作废PC未完成请求并记录新认证模式。**不轮换会话epoch，不改成员revision，不删库、不重建成员、不改项目角色或方案状态。** 重复对已升级数据库执行不再撤销扫码设备。命令没有业务／模型／Host启动，不改变配置或网络；不能替代准确部署和现场无业务检查。

正式部署原后台仍为127.0.0.1:19481；配置仅切mode，原固定scope与数据位置保留。必要HTTP路径由[精确代理渲染](<../deploy/ubuntu/qr-ingress.mjs>)改为网页扫码，PC路径404。不启用长期双登录、旧SSH回退或备用公共服务。

## 四、真实验证：不影响现用PC业务

[临时验证profile](<../deploy/ubuntu/qr-probe-profile.mjs>)使用**单独的**home／state／workspace／serviceId，原秘密在服务器内按既有受保护配置读取，不输出、不提交、不复制CPA key。只借用已固定官方Host组合，配置`authenticationOnly:true`：RPC拒绝项目、会话和管理员业务；[模型门禁](<../deploy/ubuntu/qr-probe-gate.mjs>)同时拒绝Agent请求和LLM。

[临时service](<../deploy/ubuntu/qr-probe.service>)不随开机启用、不自动重启，唯一后端127.0.0.1:19483。代理只新增新网页认证路径及`/collaboration/qr-probe/info`、`/collaboration/qr-probe/socket`；现用`/collaboration/info`、`/collaboration/socket`及PC路径仍去19481，当前PC设备不撤销。认证探针只供本人扫码核验，不是另一业务环境。

手机普通网络、A／B原电脑网络必须实测，不新增公网域名／监听／隧道或手机ZeroTier要求。临时与正式代理都关闭访问及错误细节日志，不记录code／cookie／body。无法满足则停下重议，不以关闭TLS验证或公开整个DSH替代。

## 五、已执行本地证据与尚未验证

本地已用真实SQLite、HTTP/WSS、官方DSH Host／Agent持久化、客户端Host RPC／浏览器模块、受信测试证书跑通：自动登记、实际显示名、固定管理员、原设备绑定／防抢领、回放拒绝、取消并发、响应丢失恢复、待扫码重启及不自动弹窗。真实Host停服后PC→QR升级验证同成员／同会话恢复，另人仍拒绝，旧token不可用，原请求不重放；不是把库计数等同完整保留证明。

完整本地检查、GitHub固定CI、打包一致性、临时认证部署与本人扫码、正式切换和A／B业务验收依次留证；**未完成的不标PASS**。原PC真实测试、纯自动替身和普通网络连通均不能冒充真实扫码。上线前以固定SHA／CI产物及本次精确保留清单为准，不从浮动main或仅凭0.6.0版本号安装。
