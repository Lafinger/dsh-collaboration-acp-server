# 协作命名统一与重新测试计划

状态：三轮设计及最终“确认执行”已获用户批准，已实施并核验；最终结果见[发行验收](RENAME-RELEASE-VERIFY.md)与[Docker验收](../deploy/docker-linux/VERIFY.md)。两台GUI由用户按计划自行重装重测。

## 已确认目标

- 客户端仓库dsh-collaboration-client、服务端仓库dsh-collaboration-acp-server保持名称和MIT/GitHub-only发布范围。
- 当前实现的旧命名及全部大小写/复合标识统一为collaboration/Collaboration/COLLABORATION；中文旧名称及显示名称统一为协作服务。
- 更新源码文件名/目录内引用、测试、脚本、配置、当前说明和构建产物。真实历史来源与旧发行版证据保留并明确标为例外，不伪造旧仓库名称或旧协议。
- 不移动现有宿主工作目录，不修改仓库外旧工程/Git历史/第三方依赖/真实业务文本；实际路径作为例外，部署脚本优先动态计算。
- 客户端v0.2.0、服务端v0.3.0。协作扩展协议v2，采用明确协作版本字段双向严格检查，ACP-shaped基础protocolVersion不冒充新版标准ACP。未知/缺失协作版本拒绝，旧接口不设别名，不自动降级或重放。
- 供应商collaboration-remote、模型server-agent保持；显示名协作服务。业务装配与身份绑定文件改名为collaboration-runtime.mjs及collaboration-binding.mjs。错误、事件、服务字段、环境变量及固定SSH命令同步新命名。
- 服务业务库默认collaboration.sqlite，Linuxconnector凭据目录/etc/collaboration-access/connectors，成员socket组collaboration-members（固定数字UID/GID不变）。这些不改变可信登录/会话归属/项目角色规则。

## 客户端配置与人工重装

- 默认读取当前用户home/.dsh/dsh-collaboration-client/collaboration-client.json；不读旧默认文件、不回退。
- 保留显式configFile、DSH_COLLABORATION_CLIENT_CONFIG和完整内联连接配置；配置缺失/格式错继续安全待配置，不猜身份、不建库/连接。
- 仍要求独立成员密钥/strict known_hosts与独立客户端状态库；不自动移动或轮换密钥。
- 用户自行停止组件、卸载重装两台客户端，按提供的精确步骤清理插件专用映射库/边车文件；普通DSH聊天历史、私钥和known_hosts保留。不得删除整个.dsh。
- 在新目录生成适配各自机器路径的配置，选collaboration-remote/协作服务，新建会话重新测试；旧本地会话的远端记录已删除，不能恢复。卸载插件本身不保证清除外置映射库。
- 实施者不修改现用desktop profile、不自动卸载或安装两台GUI插件、不操作Bob远程机器。

## 服务器数据清空：无备份

仅本次dsh-collaboration-linux-sim，专用卷dsh-collaboration-linux-sim-data挂载/srv/collaboration。删除前停容器并核验绝对路径、卷身份和内容，拒绝符号链接、越界或未知状态；不对运行中的SQLite删文件。

批准删除：
- /srv/collaboration/private-state中旧业务SQLite及其边车、新collaboration.sqlite及SQLite边车、access.sqlite及边车、业务资料/成果files（若存在），相关旧恢复快照与测试计数。
- /srv/collaboration/dsh-home/sessions下本次服务全部模型会话与工具记录。
- 当前为空的服务workspace如出现新增未知文件则停下核实，不扩大清理范围。
- 启用新版和无模型SSH验收产生的临时会话最后同样清空，保留空库结构交付。

明确保留：
- 专用卷本身及其他Docker资源。
- /srv/collaboration/dsh-home/.credentials.yaml、collaboration-acp-server.json（Codego与成员凭据不变）。
- /srv/collaboration/ssh整个身份/公钥目录，Windows专用私钥/known_hosts。
- 服务器profile及运行模式设置（daily）与其他工程/普通DSH历史。

不备份或导出被删数据，不加历史恢复别名。旧项目和服务端会话不可恢复；删除后可回退代码但不能回退业务数据。

## 正式构建、发布与Docker来源

1. 权限预检：Git远端读取可用不代表可推送；当前gh CLI未登录，实施时安全核验权限，必要时请用户本机登录，不索取或输出token。
2. 完成核心改名/版本检查/新默认配置与文档，在非现用环境构建、全回归、联合测试、打包/隔离官方宿主安装核验，工作树已有改动不得被覆盖。
3. 提交两个main并推送，等对应Windows+Linux CI成功；创建带注释的新标签，经既有Actions发布不可变GitHub Release及三附件，下载核对hash/commit/安装内容，不移动旧tag或覆盖附件，不发npm/市场。
4. 为避免部署依赖自身尚未发布标签导致lockfile无法冻结，服务端发行提交先完成插件改名；发行可用后再以独立正式提交更新deploy/docker-linux依赖为固定v0.3.0及精确lock，提交可复现部署/清理/检查脚本和必要自动化验证。新发行版不依赖本机部署目录。
5. Docker发布前先构建固定新发行版镜像、核对版本与内容；成功后再停现用容器、清空批准状态、重建启动。失败不使用主分支浮动源码或容器内临时覆盖替代正式包。
6. 部署更新可能有多笔正式提交（插件发行、固定版本部署、最终验收证据），全部推送验证，Release标签保持原发行提交不移动。

## 验证和交付

- 同步两仓库当前协议契约；测试新版互通与旧/缺失/错误版本拒绝，connector不能被client重新绑定身份、无自动重放。
- 命名残留审计明确区分当前代码与历史/宿主真实路径/拒绝旧协议的受控测试证据，禁止“用排除所有docs”隐藏残留。
- 新默认路径测试覆盖正确加载、旧路径不回退、override、BOM/非法JSON/缺项安全行为。
- 保持正式DSH0.2.0-rc.2、Node24.21.0/pnpm11.7.0、隔离Agent、权限/认证/成员归属、模型codego/deepseek-v4.1-flash及公开三地址22222、2CPU/2GiB/unless-stopped/no-new-privileges等既有约束，无来源网段限制不等于匿名。
- 本轮不调用真实Codego；自动业务测试用独立临时库/模型替身。真实SSH两成员/版本/伪造拒绝/forced-command/Linuxmode/健康探针不调用模型。
- 检查Codego/成员认证/SSH主机身份未变化（只输出是否一致，不输出secret）；最终项目/角色/计划/任务/会话/request为空、模型请求计数0、daily模式；明确外部Bob新版GUI由用户后续实际测试，不假称已验收。
- 交付新GitHub安装来源、客户端新目录配置范例与精确映射库清理说明、Docker启停、删除事实和无模型验证证据。
