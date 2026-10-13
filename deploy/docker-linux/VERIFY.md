# 协作服务v0.3.0 Docker更新验收

状态：**实测完成**。正式插件v0.3.0、客户端v0.2.0、协作扩展v2（ACP-shaped基础版本1）；镜像构建完成后才停旧服务并按用户授权无备份清空。最终running/healthy、Restarts0、daily、业务/access/模型会话为空、模型请求0。

## 正式来源

- [发行验收](../../docs/RENAME-RELEASE-VERIFY.md)：GitHub main/tag Windows+Ubuntu CI、公开三附件、下载hash与安装PASS。
- Docker dependency固定github:Lafinger/dsh-collaboration-acp-server#v0.3.0，lock精确d61e073afee4d62259d289669906719daeb1704e。正式DSH0.2.0-rc.2、Node24.21.0/pnpm11.7.0，源lib自带，无lifecycle编译。
- 镜像dsh-collaboration-linux-sim:0.3.0，image ID sha256:ebeac52a43aa35a743e4e49c6504b3ade693b0f6c3a0122a00fe69e65e5f9f66。容器内版本0.3.0/protocol2、改名源码存在/旧源码不存在PASS。
- 新镜像未挂业务卷的Linux隔离reset dummy回归6/6 PASS，包括拒绝未知state/workspace、错误service、TOCTOU复核、删除目标symlink以及不误删保留host profile node_modules链接。

## 无备份清空事实

停止原容器；核验单一专用卷dsh-collaboration-linux-sim-data→/srv/collaboration且没有其他running容器使用。离线maintenance container network none，显式confirm参数、绝对路径/非symlink/完整允许列表先验证再删除。

第一轮实际删除：旧业务SQLite、access.sqlite、acceptance-counters.json、restore-snapshot.json、dsh-home/sessions。停服后旧SQLite边车已由正常close清理；脚本同样允许其存在时删除。旧业务files不存在，workspace仍空。没有备份/数据导出，没有删除卷、SSH目录、Codego凭据或Windows数据。

启动新版；Codego文件、服务配置（含独立成员签名凭据）、mode daily以及全部SSH主机/成员公钥文件前后字节hash在内存比较相等，仅输出一致结果、不显示secret/hash。Windows私钥/known_hosts未修改。主机指纹仍SHA256:cbJb7w9mffMKym1ECHp5oTV+X2RinPMf92D2u1s5ziM。

验收临时生成Alice/Bob无模型会话；结束后再次停服离线删除新collaboration.sqlite、access.sqlite、计数文件、dsh-home/sessions并重启，保留空库结构。此为批准范围内清空验收数据，不保留失败记录/旧业务备份。

## 真实SSH/权限验收（不调用真实模型）

- 两独立公钥Alice/Bob固定身份、同一服务PID、独立session；跨成员history/load拒绝。
- missing/old/future collaboration版本initialize均-32011，不能session/new；旧namespace Unsupported，不设alias。
- 客户端collaboration/connect不能重绑定身份；任意SSH_ORIGINAL_COMMAND仍进入connector，不执行shell。
- Alice私钥以Bob登录被publickey拒绝（预期负例）。严格已信任known_hosts未改变。
- 本机127.0.0.1、192.168.2.27、10.242.14.211三个22222入口新client身份握手PASS，**不是另一设备新版GUI证明**。
- 成员分别以UID/GID1102/1102、1103/1103验证：私有业务库/Codego/服务配置/他人connector不可读，自己connector可读但不能写程序/SSH配置。
- sshd publickey-only、no root/shell/forwarding；connector root:独立gid0440，state0700，secret0600，socket父2750服务:1100、socket0660 PASS。

## 最终状态

30业务表（含项目/角色/资料/分析/计划/任务/成果/进度/确认/已读/session_members）逐表count0；access_sessions/access_events/access_requests各0；模型sessions目录空，files无内容，旧业务库及边车不存在。计数turns/requests/completedTurns均0，daily。

容器healthy/Restarts0、2CPU/2147483648 bytes/256PID/unless-stopped/no-new-privileges，无docker.sock/privileged；/tmp exec/nosuid/nodev。端口精确127.0.0.1:22222→22、192.168.2.27:22222→23、10.242.14.211:22222→24，非wildcard，不加来源IP网段限制或公网转发；仍须成员SSH密钥。Codego路线deepseek-v4.1-flash/openai-responses保持，本轮实际requests0。

## 用户后续

两台客户端由用户自行卸载重装最终固定v0.2.1（补齐显式环境配置读取，仍协作v2），旧专用映射SQLite不由服务器reset清除；保留普通DSH聊天、SSH私钥和known_hosts。新默认home/.dsh/dsh-collaboration-client/collaboration-client.json，无旧默认回退，必须新建会话。详见[重装清单](CLIENT-REINSTALL.md)。

新版外部Bob GUI/真实模型业务未重新测试。旧版人工跨设备及超时证据只在[历史记录](VERIFY-LEGACY-v0.2.0.md)，不得冒充新版通过或超时根因修复。
