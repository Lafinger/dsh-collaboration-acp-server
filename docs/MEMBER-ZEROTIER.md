# B 成员通过 ZeroTier 接入：网络入口与身份开通分开

## 用户授权及范围

用户明确授权“仅放行B、保留A入口”，B的ZeroTierIPv4为`10.242.66.179`。服务器现有ZeroTierIPv4为`10.242.169.184`，接口`ztfl6kpbcz`，成员端口19482。原A入口`192.168.2.20:19482`保留；不桥接局域网、不改默认路由、不开放公网、不碰管理SSH22或CPA8317。B地址恰为外部CPA地址并不冲突：CPA仍由服务器按原路线访问，该成员网络维护不触发任何模型请求。

本变更先提交GitHub，经Windows／Ubuntu CI与打包成功后，按该次固定完整SHA同步**公开维护脚本**。它不是协作插件升级，不改当前后端运行SHA或profile，不替用户开新项目、不清库、不启用IM、不迁移客户端映射。

## 第一阶段：仅网络，身份失败保持关闭

[网络维护脚本](<../deploy/ubuntu/member-zerotier.py>)只做两项增量：

1. 保留LAN监听，在专属成员sshd追加`10.242.169.184:19482`监听；现有账号AllowUsers、公钥、固定命令、禁转发／shell／密码边界完全不改。
2. UFW新增只经`ztfl6kpbcz`、来源`10.242.66.179/32`、目标`10.242.169.184:19482/TCP`的permit。

没有B已验证账号和本人公钥时，不扩大账号来源或写入任何key。**TCP可连接不等于SSH认证成功，更不等于钉钉登录、项目参与资格或角色已开通。** 当前预置第二成员已enabled但无设备公钥，不能仅凭排序就认定它是用户B。

维护脚本核对现有配置、精确网卡地址、active防火墙，并只读确认access_requests没有running业务；拒绝wildcard／Include／Match／边界漂移，不自动接管异常配置。已登录客户端会保有空闲SSH连接，不能把它误判为正在执行业务并强行断开；专属sshd的HUP重载保留既有连接子进程。先`sshd -t`，再新增精确规则／原子修改配置，重载专属SSH服务（不重启后端）。重载或探针失败时只回滚本次新增监听和规则；既有公钥／账号／业务库不变。不得在活跃成员业务中运行。

运行须管理员root环境，脚本为已核验固定SHA的文件，替换真实绝对路径：

```sh
python3 /absolute/verified-network-release/member-zerotier.py --apply --confirmation ADD_B_ZERO_TIER_MEMBER_NETWORK_ONLY
```

脚本不接受任意IP参数，避免误放整个网段；预期环境或地址变化须重新审查。未显式传入准确确认字符串不执行。

## 第二阶段：本人账号、公钥与配置

用户／B先提供现有成员配置中的`ssh.account`标识以及B本机生成的Ed25519 `.pub`公钥（不提供私钥）。管理员通过可信记录验证账号与钉钉映射，必要时索取官方userId／scoped unionId并进行明确开通；不根据昵称或客户端自报替换旧身份。

B在本机生成密钥，私钥不离开本机，不复制A私钥。管理员将经核验公钥限定`from="10.242.66.179/32",restrict`并仅为该真实B账号增加来源许可。必须另行核对和测试，**第一阶段脚本不做这一步**。

B客户端资料需要：

- `serviceId`沿用`dingtalk-lan-test`；本人SSH账号／本人密钥／独立本地SQLite映射路径。
- `ssh.host=10.242.169.184`，`ssh.port=19482`，不是B自己的10.242.66.179。
- `loginOrigin=https://login.lafinger.us.ci`，截图缺的就是此字段；必须为可信HTTPSorigin，不用裸IP或降级HTTP。
- `knownHostsFile`有`[10.242.169.184]:19482`的经核验完整主机公钥条目；指纹文本不是完整公钥行。StrictHostKeyChecking保留，不盲信扫描结果、不删除旧记录。
- 密钥、known_hosts、databasePath用B电脑实际绝对路径，不能套用A的用户名。使用设置导入／选择；已登录先退出，配置指纹改变不绕过保护。

### 已核对身份后的公钥登记

当客户端旧配置自报A账号时，不能把B设备公钥登记到A名下。须用用户提供的钉钉后台员工UserID，在服务器已有corpId／clientId作用域内精确比对；保留开头0，以字符串匹配，账号必须唯一、已启用且为预置非管理员B账号。只读匹配不等于代替本人扫码。

[公钥登记脚本](<../deploy/ubuntu/enroll-member-zerotier.py>)读取root-owned0600的有界登记manifest，字段为version、account、employeeUserId、source、publicKey、publicKeyFingerprint。实际员工标识及本人公钥只进私有运维manifest，不提交Git。脚本拒绝A账号、错误作用域／员工ID、A公钥复用、非Ed25519／附带选项／多行公钥、非单源/32以及覆盖其他已登记密钥。

完成第一阶段并确认业务空闲后，只追加B账号的`@10.242.66.179`到AllowUsers，仅在B公钥文件登记`from="10.242.66.179/32",restrict`的准确公钥；A文件和原LAN授权不改。先语法检查，再重载专属成员SSH，不重启业务后端、不写身份／项目库；重载或校验失败撤回本次新key并恢复来源规则。重复执行仅在完全相同manifest／边界下幂等，不自动覆盖未知状态。

```sh
python3 /absolute/verified-member-release/enroll-member-zerotier.py --manifest /absolute/root-owned-0600-manifest.json --confirmation ENROLL_VERIFIED_B_SINGLE_ZERO_TIER_KEY
```

仍按GitHub双平台CI成功固定SHA核验产物后同步。本脚本依赖同目录已核验的第一阶段模块；第一阶段脚本此后因AllowUsers已扩展会有意拒绝，不把它当可重新初始化全服务的入口。[8项合成登记测试](<../deploy/ubuntu/test_member_enrollment.py>)覆盖作用域及前导0、A身份／公钥拒绝、来源／key约束、成功幂等及失败回滚。最后由B在实际电脑验证TCP、公钥握手、本人钉钉扫码和项目访问，不用本机伪造B来源或复制B私钥代测。

## 第三阶段：浏览器HTTPS与域名解析不可遗漏

真实B报`ERR_TIMED_OUT`时，只开放成员SSH19482并不完整。现场只读复现：login域名解析192.168.2.20；LAN443证书验证通过，ZeroTier443拒绝连接；现用专属nginx仅LAN监听且geo／allow只含LAN，B无法打开登录页。登录请求属于B但在排查时已过期，过期会造成HTTP应用错误，不能解释TCP超时。**根因是跨网接入只改SSH，漏改浏览器HTTPS及B解析路径。**

[HTTPS维护脚本](<../deploy/ubuntu/login-zerotier.py>)对[精确已审查LAN基线](<../deploy/ubuntu/login-lan.baseline.conf>)作增量：保留两个LAN443的default／域名server监听，为二者追加服务器ZeroTier443；geo及allow仅增加B/32；目的地址为ZeroTier时通过server_addr/remote_addr双变量map额外拒绝所有非B来源。未知SNI继续握手拒绝，域名／Host／证书及仅OAuth三路由、方法限制、no-store／no-referrer、不写访问日志与不重试全部保留。现有UFW443已允许入站，本次不改这条无关的既有策略，也不开放新的公网入口；应用层精确来源限制不可删除。

先固定SHA的GitHub成功CI和服务器合成回归，再语法检查后只reload专属登录nginx；不重启业务、SSH、不改身份／登录请求／token或公网DNS。验证LAN静态完成页200、非B源访问ZeroTier443得到合法TLS+403、未知SNI仍失败。任何检查失败只回滚本次nginx配置，不重发登录。使用静态`/collaboration/login-complete`不会领取／完成设备登录，不能拿它的200冒充已认证。

```sh
python3 /absolute/verified-login-release/login-zerotier.py --confirmation ADD_VERIFIED_B_ZERO_TIER_HTTPS_ONLY
```

B电脑还需将**原域名**login.lafinger.us.ci仅在本机解析为10.242.169.184（受控hosts条目或已有管理员内网DNS），HTTPS网址不变以保留证书、SNI、cookie和OAuth callback origin。不给A改解析、不改公网DNS，不用裸IP/HTTP，不忽略证书或关闭防火墙。DNS-over-HTTPS／浏览器代理仍须实际浏览器验证，curl的`--resolve`只作诊断，不是最终浏览器修复。手机不在虚拟网络时不能据B修复宣称手机可访问此origin。

[6项HTTPS合成测试](<../deploy/ubuntu/test_login_zerotier.py>)覆盖原始安全路由/TLS/来源不变、单B源、漂移拒绝、幂等和重载／就绪失败回滚。修复后B先验证DNS／TCP／HTTPS静态页，再手动从原客户端明确重新发起一次新登录，旧过期链接不点重试、不由助手访问其起始页或回调。

## 验证与限制

离线回归[测试](<../deploy/ubuntu/test_member_zerotier.py>)覆盖仅一条监听增量、单源/32及网卡、漂移拒绝、运行中业务拒绝、成功幂等及重载失败回滚；[CI入口](<../test/member-zerotier.test.mjs>)在两平台执行。测试不触发真实模型或服务。

部署前后核对成员监听、UFW精确规则、账号／公钥不变、系统SSH不变、后端PID与模型策略／配置未动。A从原入口真实SSH握手，校验固定命令、协议v3、钉钉设备认证仍必须、未扫码项目拒绝。B实际测试必须在B电脑完成，不以A的网络探测冒充B可用。

B在PowerShell执行：

```powershell
Test-NetConnection -ComputerName 10.242.169.184 -Port 19482 -InformationLevel Detailed
Test-NetConnection -ComputerName login.lafinger.us.ci -Port 443 -InformationLevel Detailed
```

TCP成功后还需B本人密钥认证、本人钉钉扫码、项目选择与角色确认。业务测试手册应明确标注当前阶段；未完成的身份链不称“B已能登录”。不通过改AllowManaged、添加物理LAN路由、共享A身份或重放业务绕过问题。
