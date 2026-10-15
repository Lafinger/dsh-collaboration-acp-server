# 0.5.0 CPA／图片与Ubuntu上线验收

本记录针对现有Ubuntu `192.168.2.20`，不是本机Docker、替换服务器或新DSH实例。用户已确认整体执行范围，亲自完成GitHub浏览器授权和CPA隐藏录入，并确认继续切换。全过程独立执行，无subagent／workflow。

## GitHub先行与固定来源

| 项目 | 结果 |
| --- | --- |
| 已部署钉钉／权限基线 | `9ad7b158809f5be910235ce1d02c680457d6e6a7`，128份已部署源码摘要一致后单独提交 |
| CPA／图片增量 | `c84401cb5bc4c9542de71590cf44ecf89169d4c8`，与基线分开 |
| 实际部署完整SHA | `af3cba92249b9c9eb53cd613c98a5bafdb92fb1a` |
| 成功CI | [38681913422](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38681913422)，Windows＋Ubuntu＋打包全部success |
| CI包SHA256 | `84d900199d4f2928fadbcda655e5eb4049c80e730532bde50c703ea48fea9816`，372551字节 |
| Ubuntu私有冻结依赖锁SHA256 | `dbae5c2fec8f2964ed41405c0c76e30ce6a07e1a6fa6155fad7c0ea767753676` |
| 服务端发行形式 | 仅commit与成功CI产物；没有创建0.5.0标签或Release |

公开源代码和部署脚本逐字节比对固定提交；新release目录root所有、不可由服务账号改写，依赖冻结安装禁用生命周期脚本；原公开受控IM包保持原摘要且没有挂载启动。运行目录为`/opt/dsh-collaboration-test/releases/af3cba92249b9c9eb53cd613c98a5bafdb92fb1a`，没有从浮动main拉取部署。**本验收文档是上线后的文档补记，不移动已验证的部署SHA，也不重打或替换该次CI包。**

## 检查与CI故障收敛

- 最终本地完整检查：285项业务、76项单元／安全通过（1项POSIX策略在Windows显式跳过）、19项真实宿主集成；594个内部导入及238个文档链接无失败，命名审计通过，历史部署9通过／2项Windows POSIX跳过。Ubuntu CI执行77项单元和6项Python策略，全部通过。
- 图片回归覆盖原件保留、GIF双端拒绝、单帧PNG／JPEG／WebP、等比2048px／实际编码1MiB、5附件／原件20MiB、历史Base64 20MiB、最早图片持久offload、当前成员／设备／会话／项目权限、跨会话及撤权拒绝、旧回执需当前人类明确重看。
- 真实Agent工具循环覆盖反向transfer→inspect→原生tool/result image、持久恢复无需重读客户端、图片不自动归档。固定官方Responses适配器用完全替换的fetch离线验证input_image、图片省略占位、503只请求一次且不强制推理等级；没有真实模型socket。
- 初次CI发现历史文档依赖相邻客户端仓库，以及Windows TEMP的`RUNNER~1`短名与异步realpath返回长名不一致。已改固定公开历史链接、测试fixture使用native长名、检查启动器为全部子进程提供规范临时根；没有放宽生产路径、符号链接或内核互斥校验，也没有提高超时掩盖故障。
- Ubuntu隔离临时home中再次执行6项合成策略测试，官方CPA／附件组合、合成2400×1200图片归一化为2048×1024通过；fetch封锁，未读取模型key，不接触业务会话。

## 实际切换与保留核验

用户在Ubuntu交互终端两次隐藏输入；[脚本](<../deploy/ubuntu/set-cpa-key.py>)只0600私密暂存，不验证key有效性。用户确认后，[切换脚本](<../deploy/ubuntu/activate-release.py>)预检固定SHA、代码摘要、原路线、门禁和私有文件身份，再短暂停后端。数据在停服配置切换前后字节一致；门禁始终false，失败不自动Codego回退。

切换结果及随后只读检查：

- 后端0.5.0实际进程PID `384486`、账号`dsh-collab-test`、active／running、ExecMainStatus0、NRestarts0，Restart=no。进程入口和profile依赖均指向固定release，129份已安装业务／服务源码逐字节匹配CI包。
- 活动路线为`cpa / gpt-6.1-sol`，端点`http://10.242.66.179:8317/v1`、OpenAI Responses。图片能力声明已挂载；没有错误重试插件、旧模型provider或受控IM机器人挂载。
- 原51张业务表的全部行及schema摘要未变，仅新增`collaboration_vision_refs`；3张接入表全部行及schema未变。资料文件、已收原件与全部会话文件未变；非模型服务配置不变，没有清库、重放、重新归档或机器人激活。
- HTTPS服务PID `131607`、成员SSH服务PID `181471`保持不变且active／NRestarts0；成员shell、connector配置、authorized_keys、两项入口unit及SSH配置摘要未变。成员shell仍用已部署兼容的协议v3 connector，不为更换版本标识而改写成员入口。
- 本机用已有成员私钥和严格known_hosts真实握手19482成功，initialize返回0.5.0／协议v3；仍要求钉钉设备认证，扫码前查询项目返回拒绝。未启动扫码、建立业务会话或发送prompt。原22端口管理SSH亦在切换后正常使用。
- Ubuntu回环及公网HTTPS登录完成页均200／no-store；Windows请求同一HTTPS亦200。这里只验证静态完成页，不冒充新一轮OAuth真实扫码验收。
- 活动credentials、门禁、服务配置和profile均0600、服务账号所有；CPA引用存在，CODEGO_API_KEY引用已移除，非模型凭据保留。暂存key文件已删除；key只由服务器脚本在内存处理，未进入聊天、argv、Git、日志或备份。
- 关闭门禁在隔离Context加载**实际已部署门禁文件**，分别触发agent/request和llm/stream，均明确拒绝、未委派、网络调用0。没有给活动业务会话注入探针请求。

## 客户端及本地模拟退役

客户端[正式v0.5.3](https://github.com/Lafinger/dsh-collaboration-client/releases/tag/v0.5.3)源提交`2bca2ed97e548459da36300c0ade2e268128e811`，main和tag双平台CI成功。正式包SHA256 `69423b2060c2aa3cd3eb3a9451a885cd0bda6f1644aaf0fec4a7072f9300d5b9`，下载后106文件匹配源提交、121项独立抽取回归全部通过。原0.5.2本地包未覆盖；本轮没有代装或刷新现用GUI。

用户接受专用卷删除不可恢复；检查精确Compose来源、挂载和无其他使用者后，已删除本机模拟容器`13402d4401d3`、专用卷`dsh-collaboration-linux-sim-data`、网络`5376f51e8614`及0.4.2镜像`7d6605fbc17b`。其他0.4.1／0.3.0／0.2.0历史镜像、本机成员私钥／DSH状态及Ubuntu数据不受此操作影响，没有启用本机后备服务。

## 明确未验收／仍禁止

**真实模型请求始终为0，modelRequestsAllowed始终false。** 未接触CPA端点，不验证key真实有效性、网关Responses兼容性或视觉答案效果。没有现用GUI像素／实际菜单升级验收，没有新扫码和机器人消息验收。若需要真实文本／图片模型测试或开放门禁，须另行明确授权；本次部署就绪不构成开放授权。
