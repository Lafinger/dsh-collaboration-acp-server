# Docker Linux 模拟服务器实际验收

## 运行形态与状态

本机Docker Desktop4.94.0/Engine29.8.2，WSL2 Linux/amd64，Compose5.5.1。使用Node24.21.0 Debian bookworm-slim（digest锁定）、官方DSH CLI0.2.0-rc.2和GitHub固定插件v0.2.0（6680d812）。没有用test/helpers宿主替代正式DSH。

- 一个容器dsh-collaboration-linux-sim，专用卷dsh-collaboration-linux-sim-data；只此新资源，不清空未知数据。
- 正式进程为非root dshsvc运行官方DSH CLI，sshd root负责登录后降权到alice/bob；两成员service PID相同。
- 2CPU/2GiB/256PID、unless-stopped、init、no-new-privileges、非privileged、不挂Docker socket/现用profile。
- 镜像约1.24GB（1.16GiB）：官方CLI依赖含未加载Web/Office等可选包；“最小”指启动profile/OS服务，不是极小磁盘镜像。空闲实测约66MiB内存，CPU0.10%，仅瞬时值。
- final image ID sha256:64162452f68fdfd0ebbbdbcbb4bb6fcaf3dfe190ffad9adc69f71f0617b05c58。

## 真正执行并通过

1. Windows原生ssh，经127.0.0.1、192.168.2.27、10.242.14.211各自22222连接，同一个sshd/协作服务成功；strict known_hosts直接由Docker取容器host公钥。
2. alice/bob独立密钥登录，各自独立协作会话；跨成员history/load被拒；client workbench/connect不能重绑定伪造身份。
3. alice私钥登录bob被publickey拒绝；任意SSH_ORIGINAL_COMMAND如id/cat不会执行shell，仍进入forced connector的JSON-RPC。
4. sshd -T实际断言：仅publickey，no password/kbdinteractive/root/TTY/TCP或Unix socket forwarding/agent forwarding/X11/user env/user rc。AllowUsers仅alice/bob。
5. 实际Linux账号断言：自己connector root:独立gid0440可读不可写；他人connector不可读；服务Codego/JSON/业务库不可读；程序和SSH配置不可写。
6. 服务私有JSON/模型key服务账号0600，state0700；socket父目录服务:members2750、socket服务:members0660；独立HMAC凭据不相等，复制模型文件只含CODEGO_API_KEY refs，不含其他records。
7. 真实Codego openai-responses，固定deepseek-v4.1-flash：Alice project_create一次，Bob project_list两次（一次在重建后）；检查宿主持久化tool-call/result和真实SQLite，不只相信模型回复。
8. 保存opaque持久身份快照后stop/build/up重新创建容器，host key/Codego key/成员HMAC凭据不变；项目保留、两个原sessionId都可恢复，history保留，重复requestId被拒。
9. 仅恢复/history/重复请求测试不增加模型调用：恢复前后2轮/4请求。之后显式只读第三轮成功，累计3轮/6请求，仍在6轮/24次限内，三组持久化request/header均maxTokens2048。
10. 本地实际acceptance-policy三项回归：验收预算拒绝无额外I/O、daily不限制次数且移除旧2048上限、禁止模型回退，通过。
11. 验收后明确切daily，不清零计数，不加日请求/单轮请求/时长/输出限制；使用Codego/DSH默认，不加载llm-retry、后台标题模型，无自动业务重发。

唯一新增项目：key DOCKER-LINUX-SIM-TEST，id 7eba73e8c3fe4d11961b10b1bc43b44c，名称Docker Linux模拟服务器验收项目。无计划或其他写操作，未导入真实业务数据，测试项目保留。

## 接入材料

两位成员各local/lan/zerotier配置及专用私钥在仓库Git忽略 `.dsh/docker-linux-sim/`，ACL只授当前用户和SYSTEM读取；不要把完整目录给每个成员。客户端configFile选择对应成员/路线JSON，不修改现用desktop profile。跨设备文件路径必须改为该设备绝对路径。

## 最终网络策略与未验收边界

**用户最后明确取消来源IP/网段限制**：任意可达设备允许尝试连接，仍需匹配成员SSH密钥，不是匿名访问。Windows已有Docker Backend任意来源/全TCP端口Allow，本次未删改现有规则、未关闭防火墙/变更网络类别、未安装拟议的BlockOutside规则，不再需要管理员网段规则作为运行前提。[防火墙脚本](firewall.ps1)已改为可选的仅两IP/TCP22222任意来源Allow，当前未执行。保留明确三地址发布，不增加公网转发。已按新策略恢复容器，最终Status=running、Health=healthy；三个本机地址SSH、两原session恢复、重复请求拒绝及publickey/forced-command策略复验PASS，计数仍3轮/6请求，无额外模型调用；主机身份与凭据快照不变。

**后续人工GUI验收**：用户在本机Alice会话完成身份、project_list、连续上下文project_get和客户端重启恢复（用户提供回复，会话68b6f9ce-233b-472f-be34-d9280dd47b41不变）。用户在另一台Windows经ZeroTier测试端口通过并完成Bob身份查询；服务器持久化确认814bc102-8556-4e7c-a6c0-166fd18175ca归属bob，第一轮实际session_whoami完成。跨设备SSH与身份链路已有人机联合证据，不能再仅标记本机自连。Bob第二轮项目读取超时，保留失败记录；用户显式提交第三轮新的只读请求后成功，服务器持久化确认第三轮实际project_list、turn/end completed、请求completed且无写工具。另一设备经ZeroTier共享业务读取通过。用户随后在Bob原会话第四轮验证连续上下文（实际project_get、completed），正常退出并重启另一台Windows DSH后第五轮验证恢复（同一814bc102-8556-4e7c-a6c0-166fd18175ca，实际session_whoami+project_get、completed，无project_list/写工具），已确认原会话身份/上下文保留。第二轮unknown仍保留，没有自动重放。Bob恢复后，用户回到Alice原会话完成第五轮只读检查；服务器确认68b6f9ce-233b-472f-be34-d9280dd47b41仍属alice、实际session_whoami+project_get、completed，Alice五条请求均completed。两会话最后一轮均无写工具，SQLite仍只有原测试项目且background/goal为null，容器running/healthy、Restarts0。至此双主机身份、共享读取、连续上下文、各客户端重启恢复及顺序操作互不影响的只读人工验收结束；未做同时请求并发压力或双GUI写入测试。不代表先前超时根因已修复，详见下节。外部LAN尚未验收；没有公开Web管理或路由器公网转发。

日常成员可持续消耗现用Codego账号额度，用户明确选择无额外调用限额。容器root/Docker管理员为可信管理者，logical会话隔离和文件mode不构成对管理员/宿主的秘密边界。GUI测试为上述人工操作，不是完整自动GUI回归或公网生产安全认证。

## Bob跨设备读取失败诊断（未自动重发）

Bob会话814bc102-8556-4e7c-a6c0-166fd18175ca第二轮在2026-10-12T15:30:35.675Z开始，15:30:46.169Z（约10.5秒）结束。持久化assistant/attempt finish为error/TIMEOUT/Request timed out.，turn/end同错误；此轮没有assistant/message或任何tool/call，project_list未执行，业务项目未改变。第一轮为completed，第二轮access_requests记unknown以保留统一安全语义，不改写状态、不reset/replay。服务仍healthy、Restarts0，mode daily、9轮18实际请求；不是6轮验收限制或ZeroTier认证失败。

诊断用完全无凭据HEAD https://codegoai.com/v1当前得到HTTP404（Linux直连约3.5秒，宿主既有proxy约5.8秒），只证明当前DNS/TLS/HTTP可达，不证明模型生成可用或先前请求必能连接。用实际容器OpenAI6.40.0+发布服务，dummy key/mock fetch复现两项PASS：原生连接超时会被SDK转换为Request timed out.且丢失cause；服务将模型失败包装-32009/no automatic retry并把请求记unknown，重复ID拒绝且不增加调用。模型cause细节不在当前原始日志中，不能断言为某个IP/代理故障，无法离线复现原始外网瞬态。

此时未改网络代理/timeout/服务或客户端源码，未重启容器、未补发任何模型指令；诊断前后9轮18请求相同。随后用户显式发送一条新的只读查询成功；同一Bob会话第三轮project_list唯一tool/call，turn/end completed，access_requests依次completed/unknown/completed。原失败请求仍unknown、未清除或重放，服务healthy。只能确认新请求成功，不能宣称原始外网超时已根治；如再次timeout再采集受控底层连接原因，不启debug auth/body日志、不无限重试。

## 遇到的部署故障与验证修正

- Docker helper存在但未在PATH：只为构建进程加Docker程序目录，不改全局配置。
- auth.docker.io直连DNS/网络超时：只为构建读取既有Windows127.0.0.1:10808 HTTP代理，curl auth HTTP200；成功拉取原官方镜像，没有用不可信镜像。
- Debian HTTP下载proxy500/EOF：证书初始化后切官方HTTPS源，有限下载重试，构建通过。
- Desktop同一个target22三地址内部映射冲突：一个sshd内监听22/23/24，外部三个指定IP统一22222，inspect确认，无wildcard发布。
- initializer行尾注释遮住目录语句：修正为独立行，connector目录可创建；profiles中间root0700导致服务不可见：明确服务拥有父目录，非rootexists探针先red后PASS。
- native loader /tmp noexec导致failed to map segment：/tmp显式exec/nosuid/nodev，实际官方native binding探针先red后PASS，无编译脚本/privileged。
- Windows Electron Node程序直接调用异步启动：窄复制实际完成后再次确认再重启，后续首次配置wrapper显式Start-Process -Wait避免竞态。
- SSH AllowUsers检查初版以dict覆盖重复行：按sshd真实多行输出收集两账号，权限策略本身未放宽。

本轮本地部署文件和术语变更保留未提交，按确认未上传GitHub、不发新插件版本。现用Windows DSH profile/凭据库原文件/业务库及客户端代码不改。
