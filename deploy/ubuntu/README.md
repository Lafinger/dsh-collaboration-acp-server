# Ubuntu DSH 自定义模型 API（外部 CPA，0.5.0，仅固定提交）

目标仅现有Ubuntu `192.168.2.20`，沿用DSH0.2.0-rc.2、原数据、profile、钉钉登录、成员SSH与HTTPS。不是Docker或替换服务器，不另建DSH服务。设计与用户授权见[确认记录](<../../docs/设计确认-CPA切换与本地模拟退役.md>)。

本轮已上线的固定成功SHA、来源摘要、数据保留及门禁验证见[0.5.0上线验收](<../../docs/CPA-UBUNTU-VERIFY.md>)。下述脚本是严格原路线预检的一次性切换流程；已经成功切换后不要重复执行录入／激活命令，也不要把文档补记后的main当新部署来源。

## 跨局域网成员入口

B在ZeroTier内的地址为10.242.66.179；保留A现有LAN入口，只追加B单源/32的成员19482网络许可，未核对本人账号／公钥前保持身份拒绝。先GitHub双平台CI再同步固定SHA的公开维护脚本，不重启业务后端或切换其运行版本。范围及分阶段验证见[B成员ZeroTier接入](<../../docs/MEMBER-ZEROTIER.md>)。这不是CPA配置变更，也不开放通用SSH／端口转发。

## 外部 CPA 是自定义 API，不是本机服务

CPA由用户在外部维护，Ubuntu仅通过ZeroTier访问`http://10.242.66.179:8317/v1`；本仓不部署CPA，不启动8317端口，不修改DSH源码。DSH标准模型插件`@deepseek-ai/dsh-llm-pi-ai`直接配置`providers.cpa`，对应Web“新增自定义模型API”；用户明确协议为OpenAI Responses（不是截图中的Chat Completions）。`cpa`只是自定义provider标识，`deepseek-v4.1-flash`只是当前配置模型名，不保证上游来源。此前额外的host-cpa包装已移除；门禁、附件和协作装配是独立安全功能，不是CPA实现。更正范围与核验见[标准API修正](<../../docs/EXTERNAL-CPA-CUSTOM-API.md>)。

```json
{"id":"llm-pi-ai","name":"@deepseek-ai/dsh-llm-pi-ai","config":{"providers":{"cpa":{"displayName":"CPA","apiKeyEnv":"CPA_API_KEY","api":"openai-responses","baseURL":"http://10.242.66.179:8317/v1","models":[{"id":"deepseek-v4.1-flash","name":"deepseek-v4.1-flash","input":["text","image"]}]}}}}
```

以上为核心配置摘录；完整渲染还保留原有不重试与图片字节限额。密钥沿用服务器原私有凭据引用，不重新录入或复制。网络可达与模型协议兼容需分别验证，不用仅配置完成冒充ZeroTier可达或真实模型验收。

## 发布与准备

服务端不创建0.5.0标签或Release。先提交现用基线，再提交CPA／图片增量；main的Windows／Ubuntu检查及打包全部成功后，管理员记录完整40位SHA，下载该次CI的`verified-plugin-<SHA>`，核对包清单、SHA256与源文件。不得盲目git pull或从浮动main部署。

将核验包和本目录公开脚本放进`/opt/dsh-collaboration-test/releases/<SHA>`；此目录root所有、代码只读，数据仍在`/srv/dsh-collaboration-test`。沿用已部署DSH精确依赖和未启用的受控IM原件；[运行清单](<runtime-package.json>)新增官方持久附件服务，以原部署锁文件为种子，只按新运行清单和该次CI精确tarball生成本次私有部署锁，记录锁哈希，再执行冻结安装且禁用生命周期脚本；tarball的完整性由CI清单和SHA256双重核对，不以浮动Git来源解析替代。准备阶段不改活动配置、不停原服务、不读取旧模型key、不请求CPA。

[模型配置](<model-config.mjs>)当前固定`cpa / deepseek-v4.1-flash`、`http://10.242.66.179:8317/v1`、OpenAI Responses，保留text／image声明。用户停止Node统一计划后仅要求[调整默认模型](<../../docs/CPA-DEFAULT-MODEL.md>)，不改Node或开放门禁；旧模型gpt-6.1-sol此前单独授权的最小文本Responses请求曾返回200／CPA_OK，证据与限制见[历史标准API修正验收](<../../docs/EXTERNAL-CPA-CUSTOM-API.md>)，这不能当作新默认模型已实测；这不证明真实图片效果或上游模型来源，也不自动开放业务门禁。上下两层重试均为0，不挂载请求错误重试插件、不回退Codego、不强制High；固定官方适配器内部已将pi-ai传输maxRetries设为0，部署配置使用受支持的retryPolicy而非已移除的旧字段。

## 用户隐藏录入（不会切换服务）

在Ubuntu自己的交互终端运行，替换下列SHA占位符；勿把key写在命令、聊天、环境变量、重定向或终端录制中：

```sh
sudo -u dsh-collab-test python3 /opt/dsh-collaboration-test/releases/<SHA>/set-cpa-key.py
```

[录入脚本](<set-cpa-key.py>)两次隐藏输入，只向私有服务home的`.cpa-key-staged.json`原子暂存，权限0600，要求模型门禁仍关闭。取消／不一致／路径或权限错误不改变活动服务。只检查本地格式和存储，不能据此声称key有效；管理员不得打印该文件或复制到Git、参数或日志；脚本将终端无法关闭回显视为错误，不退回明文输入。重新运行仅替换本轮待切换key。

## 维护窗口

用户确认录入完成后才执行[切换脚本](<activate-release.py>)，要求精确SHA目录、静态清单、原配置及门禁预检通过。先停后端，记录数据字节摘要，保留全部库／资料／会话及身份字段，替换仅provider/model、公开profile和后端代码路径。活动凭据保持现有非模型秘密，仅删除CODEGO_API_KEY引用并加入CPA_API_KEY；不输出旧凭据、不生成旧key备份。旧安装代码保留但不自动回退供应商。就绪失败保留关闭门禁并明确停止后端，不反复重启、不自动尝试Codego。

[profile生成器](<render-profile.mjs>)使用官方插件和原生图片存储，不启用受控IM、GUI、terminal／fs、MCP或委派。[门禁](<model-gate.mjs>)在agent/request与llm/stream两处检查严格boolean策略：false继续阻断，用户显式授权后true仅放行固定CPA路线；错误／缺失策略fail-closed。[本次授权](<../../docs/CPA-MODEL-AUTHORIZATION.md>)允许开启供用户手动发新消息，不能只改旧版本false为true（旧挂载会拒绝），须同步成功CI的门禁与挂载代码。首次迁移仍默认false。升级不重放业务、不启动任何真实模型测试；未单独授权的其他环境不得自行开启。

确认就绪要核对代码固定SHA／包哈希、运行账号、配置0600、socket、HTTPS／成员SSH、模型路线与关闭门禁，并说明SQLite只增加图片引用表及原有启动维护可能写入接入状态。模型字节组装／权限／归一化与历史预算通过离线测试，不等于真实视觉分析或CPA网关已验收。
