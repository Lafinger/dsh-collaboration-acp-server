# 本机 Linux 模拟协作服务器

此目录是本次确认的本地部署，不是第二套独立生产运行时。使用正式DSH CLI加载显式最小profile以及GitHub固定v0.4.1插件（协作扩展协议v2＋附件扩展1）；一套非root DSH宿主与一个sshd。Docker Desktop容器验证Linux/SSH，不等于公网独立主机或完整VM。

**本次附件升级必须保留已有项目、会话、业务库、资料、映射与凭据；禁止按下文历史清空步骤操作。** 附件用法见[附件指南](<../../docs/ATTACHMENTS.md>)；此前改名清空是历史单次授权，不能复用到本次升级。

## 已确认配置

- Debian bookworm slim，Node24.21.0/pnpm11.7.0/DSH0.2.0-rc.2；官方Node镜像固定digest，插件锁到v0.4.1提交。
- 容器 `dsh-collaboration-linux-sim`，专用持久卷 `dsh-collaboration-linux-sim-data`，2CPU/2GiB/256PID，unless-stopped。
- SSH只发布127.0.0.1、192.168.2.27、10.242.14.211的22222。为避免本机Docker Desktop同target多地址映射冲突，一个sshd在容器内分别监听22/23/24；外部统一22222，成员无需知道内部端口。换IP前显式修改[Compose](compose.yaml)和[防火墙脚本](firewall.ps1)，不自动暴露全部网卡。
- 模型固定codego/deepseek-v4.1-flash，openai-responses接口https://codegoai.com/v1；只有CODEGO_API_KEY单项复制到私有文件，无镜像/命令行/environment secret，不复制整个Windows凭据库。
- 不设置来源IP/网段限制；任何可达设备仍须匹配成员SSH私钥。成员alice/bob均publickey+forced connector，无shell/SFTP/SCP/转发/root登录；Docker管理员仍为可信管理者。
- 正式日常使用按用户选择不设额外每日/单轮请求/时长/输出限制。成员共用现用Codego额度，没有自动费用隔离。
- 旧轮次真实模型验收模式6轮/24请求/2048token/次/4分钟/轮；此前改名更新清空旧数据后交付空状态是历史事实；之后用户已有新项目/真实GUI会话，本次附件升级不清空且不自动调用真实模型，保持daily。真实模型失败不自动重发业务请求。无自动模型回退、未加载llm-retry或后台标题模型。

## 命令

Windows PowerShell在本目录运行[控制脚本](control.ps1)（其他目录请给脚本实际完整路径）：

```powershell
./control.ps1 Build
./control.ps1 Start
./control.ps1 Status
./control.ps1 Stop
./control.ps1 Restart
```

程序安装路径从LOCALAPPDATA计算，卷内绝对路径仍固定；不改宿主工作目录。Start等待healthy（最多120秒），失败不假称启动通过。

Build仅给该进程加入Docker安装路径并读取已有Windows本地HTTP代理；不修改全局PATH或Docker设置。无Docker Hub直连时不要禁TLS或改不可信镜像。Build上下文由[白名单](.dockerignore)限定，无私钥/模型secret。依赖安装--ignore-scripts，业务JS是发布包自带产物，不在安装时编译。

## 首次配置与数据保留

初始化无凭据时仅等待bootstrap，不启动sshd/模型。首次用[初始化命令](provision.ps1)创建本机私有目录并限制ACL，再运行[窄复制脚本](provision-windows.cjs)；用桌面应用Electron Node模式读取其YAML parser，显式等待进程结束后才重启，避免Windows GUI子进程异步完成造成启动竞态。已有私有目录或凭据时拒绝覆盖。Codego密钥只在内存中提取，经stdin写容器0600文件，拒绝覆盖已有凭据。不要把凭据库或API Key贴进聊天、复制进Dockerfile/Compose环境变量或docker exec参数。

本机私钥与六份成员/网络入口JSON位于仓库被忽略的 `.dsh/docker-linux-sim/`。known_hosts直接从容器host公钥生成，不盲信ssh-keyscan。只分发对应成员的私钥；私钥无口令，仅用于此测试环境。不要把完整目录同时分发给不同成员。

容器的workspace、业务private-state、DSH会话/Codego凭据、SSH主机密钥在专用卷中。`/tmp`明确挂载exec/nosuid/nodev，因官方DSH native loader需要从临时缓存映射预编译模块；否则会出现failed to map segment。此选项不提供shell接入、提权或额外工具权限。正常停止或重建保留数据；没有启动时自动清空。此前无备份清空只适用于上一轮旧数据，**本次保留数据，禁止执行reset**；下节仅保留历史步骤。不要使用docker system prune --volumes、compose down -v或volume rm，删除须另行明确确认。容器/tmp及/run为临时存储，重建会消失。

## 历史单次离线清空（本次禁止执行）

以下仅为上一轮改名授权的历史步骤，不适用于已有新项目与会话的附件升级。不能因为脚本存在就重复删除。此前曾按明确授权执行：

```powershell
./control.ps1 Stop
./reset.ps1 -ConfirmDeleteWithoutBackup
./control.ps1 Start
```

[离线维护](reset.ps1)验证容器已停止、专用卷身份、没有其他运行容器使用卷；[清空程序](reset-state.mjs)先检查完整允许列表、拒绝symlink/路径越界/陌生workspace或state对象，再删除业务SQLite/边车、业务files、access状态、旧测试计数/快照和宿主服务端sessions。不删整个卷，不改Codego/HMAC/SSH身份；mode daily保留。此操作不可恢复，代码回退也不能恢复数据。

验收可创建临时无模型会话，最终再次按批准范围清理并[检查空状态](verify-empty-state.mjs)。不是每次启动自动删除。Windows普通DSH历史、两台客户端的映射库与私钥不由该脚本操作。

## 跨设备网络

用户最后确认取消来源IP/网段白名单：任意能路由到上述LAN/ZeroTier入口的设备都可尝试连接，但必须持有匹配alice/bob的SSH私钥。仍非匿名接入、不提供shell，不增加公网转发或全部网卡发布。

当前Windows已有Docker Backend任意来源TCP允许规则，本次不关闭防火墙、不删改这些规则、不改变Public网络类别，也未安装之前拟议的BlockOutside规则，因此不再把管理员安装网段限制作为启动前提。只恢复本次容器。

如以后Docker应用允许规则被移除或更换机器，可在管理员PowerShell安装仅针对本服务两IP/TCP22222的任意来源允许规则：

```powershell
./firewall.ps1 Install
```

此为可选排障步骤，当前未执行，不是开放所有Docker端口。检查/撤销将Install改为Inspect/Remove，操作仅限本次命名规则；若以前已装旧网段规则，脚本拒绝直接覆盖，先检查再显式Remove。网络路由、ZeroTier控制器策略和其他防火墙仍可能影响跨设备接入。

其他设备：安装客户端插件，提供匹配成员配置，改identityFile/knownHostsFile/databasePath为该设备自己的绝对路径，LAN用192.168.2.27，ZeroTier用10.242.14.211，port22222。serviceId固定docker-linux-sim。Windows本机的路径不能直接用于另一台设备。

只开SSH，不公开DSH Web管理。直接ssh得到的是JSON-RPC connector，不是交互式shell；“没有命令提示符”是预期行为。先用专用客户端测试配置，不修改当前桌面profile。

## 日常客户端使用

- 当前主机Alice使用127.0.0.1:22222，另一台Windows Bob使用ZeroTier 10.242.14.211:22222；各用自己的密钥、客户端配置及本地状态库，不用轮流覆盖当前主机配置。
- 服务器Windows必须保持开机且Docker Desktop运行；Bob接入时两端ZeroTier应在线、网络已授权可达。另一台客户端不需要Docker或Codego凭据。
- 每次需要使用协作服务，在DSH会话模型选择collaboration-remote / 协作服务（server-agent），而非本机Codego。实际模型由服务器固定选择。
- 同一段工作继续打开原本地会话，可保持原远端会话/上下文；新建本地会话会得到独立远端会话，但查询同一份项目数据。共享项目不等于共享聊天记录，也不是所有项目工具都有项目级授权。
- 正常退出再打开DSH即可恢复，不删除本地映射数据库或密钥，不点旧消息重试来触发恢复。不把恢复notice复制成新业务指令。
- GUI工作区是本机工作区，插件不自动把整个工作区上传给服务器；当前远端入口接收有稳定ID的用户指令与当前消息明确授权附件，执行的是服务器限定业务工具，不是通用远端shell/文件Agent。
- 写操作必须由用户明确提出，不能把这次只读接入验收当作双GUI写入/并发或业务规则全覆盖验收。本次已有测试项目及南航项目和服务端会话保留，不清空；升级前后用opaque hash/事实计数验证，不备份数据库或输出秘密。
- 若TIMEOUT/COLLABORATION_NO_REPLAY，先看原会话已保存记录/服务端工具提交事实；不要自动重试写入或重置状态库。未确认结果前错误信息不能证明操作未提交。已有一次Bob模型超时但随后显式新只读请求成功，不代表根因已根治。
- 日常不加额外调用限额，成员共用Codego额度。无来源网段白名单不等于匿名访问；接入仍需服务器已有成员的SSH私钥。

旧版人工双主机只读验收及一次超时证据见[历史验收记录](VERIFY-LEGACY-v0.2.0.md)，不是新版本部署通过的证明。当前更新结果见[验收记录](VERIFY.md)，两台客户端步骤见[重装清单](CLIENT-REINSTALL.md)。

## 验收与检查

[Windows测试](verify-windows.mjs)显式使用DSH_COLLABORATION_CLIENT_ROOT选择客户端仓库；protocol/addresses/negative-key/restore不调用模型，model-create/model-read/model-restored会消费Codego额度。工具调用是否真的发生必须核对持久化事件与SQLite，不能仅相信模型文字。

[内部只读检查](inspect-state.mjs)检查权限、仅Codego凭据、计数和测试项目，不输出秘密。Linux服务配置0600/服务属主，state0700；账号connector凭据root:独立主组0440；socket setgid父目录2750、socket服务:members0660。成员无权读取服务私有凭据或他人connector凭据，且不能修改程序/SSH配置。

模型配置不跟随WindowsGUI变化；Windows更新Codego密钥后须显式重新配置容器。复制出来的credential仍可消耗原账号额度；Docker/Windows管理员能读容器数据，文件权限不对可信管理员提供保密。

本机经三个网卡地址通过不代表另一设备已经连接。最终验收记录如实区分；容器运行与实际SSH权限通过也不是公网部署安全认证。
