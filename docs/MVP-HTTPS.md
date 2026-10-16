# 0.6.0 MVP：统一HTTPS＋电脑钉钉身份

状态：代码实现与离线验证中，**尚未部署、未完成真实PC钉钉或A/B闭环验收**。产品范围以[用户最终确认](<MVP-账号与电脑钉钉登录方案.md>)为准，取舍见[ADR](<adr/0003-mvp-https-pc-identity.md>)。

## 服务边界

- 服务仍是DSH 0.2.0-rc.2插件，借用宿主Agent／模型／持久化，不创建第二套DSH。
- 私有配置显式设置 `mode: "mvp-https"`，使用[新空模板](<../examples/mvp-https.example.json>)；没有accounts、个人SSH、socket或项目访问名单。仅监听127.0.0.1的配置端口，由专属TLS代理承载同一origin下的HTTP与WSS。
- 同一组织有效内部成员首次PC确认后自动登记。固定管理员按 `administratorUserId` 匹配官方员工标识，而非昵称、钉钉管理员标志或首登者。
- 所有成员可见全部未归档项目及当前项目共享业务；会话仍固定项目、私人聊天和附件凭证仍按成员／会话隔离。
- 管理入口仅支持只读项目／角色候选、建项目、角色分配。没有成员增删／停用／恢复、动态管理员、设备后台、项目ACL或机器人。旧本机成员管理CLI在MVP配置下拒绝执行。
- 新库带固定认证模式和管理员作用域标记，拒绝采用旧成员／旧项目数据库；不能通过把旧配置mode改名来迁移。

## 官方PC认证

使用官方[网页应用免登](https://open.dingtalk.com/document/orgapp/enterprise-internal-application-logon-free)、[requestAuthCode](https://open.dingtalk.com/document/orgapp/jsapi-request-auth-code)与[配置网页应用](https://open.dingtalk.com/document/orgapp/configure-web-application)。PC Windows／Mac最低7.0.50；当前实际Windows电脑已只读观察到9.0.1，**版本符合不代表认证通过**。

1. DSH用随机设备标识和256位秘密proof发起5分钟请求，无账号前置。proof只驻本机Host内存，不进浏览器／URL／日志。
2. 原DSH显示电脑钉钉跳转和16位核对码。跳转携带的是短期浏览器绑定随机值，放URL fragment，不是设备proof或7天服务token。自动唤起不可靠时，可从已发布应用的PC工作台入口输入本机核对码；不是手工抄授权码，也不列出公共待登录请求。
3. 端内页面向同源后端绑定HttpOnly浏览器cookie，核对组织／服务／本次请求；官方SDK取得一次性PC免登码。
4. 服务器用应用token调用 `topapi/v2/user/getuserinfo`，再查组织内UnionID转换和员工详情，核验内部、在职、员工ID与UnionID一致，从官方详情取显示名。它与旧OAuth的userAccessToken交换不同。
5. 页面先展示实际官方身份，再由本人确认。仅原DSH持proof可领取一次服务token，自动完成登录。已处理／重放／跨设备领取失败关闭。

官方SDK固定 `dingtalk-jsapi@3.2.9`，仅打包PC免登API，通过[同源产物](<../assets/dingtalk-pc.js>)提供；不从未核验旧CDN版本加载。其API文件为CommonJS，构建入口须取明确的可调用导出 `requestAuthCode$`，不能把namespace默认对象当函数。[实际SDK运行回归](<../test/pc-sdk-runtime.test.mjs>)执行已提交产物，并用离线原生桥验证 `runtime.permission.requestAuthCodeV2` 请求／成功回调，而不仅替换一个手写 `dd`。修改依赖后运行 `node scripts/build-pc-sdk.mjs`，CI重构建比对。SDK含MIT授权原生桥标识，应保留而非按本插件名称改写。离线原生桥仍不等同真实电脑用户完成认证。

PC官方SDK可能经钉钉顶层容器桥接；登录页CSP只允许官方钉钉域名容器嵌入，拒绝其他frame，脚本nonce限定。cookie使用Secure／HttpOnly／SameSite=None以支持该跨站容器，写操作仍严格校验**本应用origin＋JSON自定义头＋一次请求cookie**，不接受来自钉钉父页面origin的直接POST。真实客户端第三方cookie策略仍须实测，禁止为排障开放任意frame或关闭origin检查。

## 7天登录与故障

- 7天是固定最长有效期，不滑动延长；多设备独立。本机Windows使用CurrentUser DPAPI加密，JSON／SQLite只存配置、映射与密文，不存token明文。当前A/B MVP为Windows；其他系统无已验收安全存储时明确拒绝持久登录，不降级明文。
- 组织身份最多缓存5分钟。暂时无法复核时业务暂停、旧token不自动作废；官方明确资格被撤销则旧token失效，相关未生效计划暂停。重登不是离线绕过。
- 角色换人复用已有业务暂停规则；管理员版本令牌单调变化，A→B→A不接受旧页面提交。普通角色变化不额外废弃整个项目的私人会话。
- 断网恢复只取已保存记录，从不重发prompt／管理员操作。管理请求带稳定commandId，服务端幂等只返同一结果；界面结果不明应刷新实际项目／角色，不自动提交第二次。
- 本机退出清除加密登录，在线时撤销当前设备；离线撤销失败明确显示，其他设备不受影响。不提供远程设备管理。

## TLS代理最低要求

新服务与旧服务可暂时隔离部署，必须新stateRoot／workspace／serviceId／宿主持久化命名空间，不复制旧业务库。模板见[代理片段](<../examples/mvp-https.nginx.example.conf>)。

- 使用域名匹配且有效的HTTPS证书，转发固定Host／正确origin；WSS路径完整支持Upgrade、长连接、不缓存。
- 仅绑定现有LAN／ZeroTier可路由地址，以子网网络边界限制，不按个人/32放行；不新增公网监听、不开放shell或整个DSH管理。
- 为A／B统一DNS一次配置。当前域名解析LAN地址，B旧hosts方案不作为MVP通过。必须确认两个真实路径均可解析和TLS连接，不能用TCP22替代443验收。
- proxy只转发本协作路径，不记录Cookie、请求体或凭据；服务端帧1MiB、消息／并发／待登录总量均有界。

## 本轮可证与未证

已执行合成身份、真实HTTP／WebSocket、真实DSH宿主和双插件TLS代理测试：自动登记／仅管理员写／全员项目可见／私人隔离／官方码一次性／并发领取／角色版本／设备撤销／7天边界／5分钟资格／不自动重发。Windows DPAPI使用合成秘密完成真实系统往返。

只读官方接口已确认 `manager7701` 对应有效员工陈锦鸿；原服务端应用信息缺AgentId，应用列表查询403，未猜测或增加权限。用户随后提供真实数字AgentId，明确PC应用“未配置”；应用标识只进服务器私有配置，不提交源码。真实应用PC首页／发布范围／端内免登地址仍需管理员按[官方文档](https://open.dingtalk.com/document/orgapp/enterprise-internal-application-logon-free)配置。**测试模型和平台身份替身不是钉钉实际认证、付费模型或A/B真实业务验收。**

## 临时真实PC可行性实例（不是切换）

[隔离profile生成器](<../deploy/ubuntu/mvp-probe-profile.mjs>)复用官方宿主组合和既有CPA配置，但使用全新专属home／持久化／workspace／stateRoot／serviceId和127.0.0.1:19483；不读旧业务库，不复制旧会话或模型key。[验证门禁](<../deploy/ubuntu/mvp-probe-gate.mjs>)同时阻止Agent请求和直接LLM，避免把认证核查变成第二套付费业务。仅临时复用同一官方DSH宿主版本的独立profile进程用于先验认证，不创建另一实现或替代当前服务。

[增量代理渲染器](<../deploy/ubuntu/mvp-probe-ingress.mjs>)只增新MVP exact路径，旧OAuth仍去19481；不改变证书、现有监听／网络源限制、DNS或防火墙。新增路径必须保留后端nonce CSP而不是继承旧页禁脚本策略，并开启WSS Upgrade。[临时service模板](<../deploy/ubuntu/mvp-probe.service>)不随开机启用、无自动重启，只有探针目录可写。

所有公开脚本先提交并通过固定双平台CI，下载精确产物再按摘要同步；部署前验证目标路径不存在、旧进程与配置未变。真实本人确认前只做发现／页面／SDK／握手检查，不代点确认、不捕获授权码或token到日志。旧网络个人/32仅暂时原样保留作非破坏性探针；正式MVP仍需统一DNS和LAN／ZeroTier子网网络边界，不能把此临时入口称为新MVP接入已完成。

旧数据清理、旧dt_账号退役及B本地清理只可在真实PC链路＋固定成功Windows/Ubuntu CI＋准确清单后执行。用户明确不备份，保留排除项，不提前删库。
