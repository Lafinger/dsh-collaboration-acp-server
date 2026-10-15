# Ubuntu CPA默认模型：deepseek-v4.1-flash

> 本文是默认模型调整时的阶段验收（当时门禁关闭）。随后用户排查“你好”失败并明确回复“允许”，业务门禁已另按固定成功CI开启；当前状态见[模型授权上线](<CPA-MODEL-AUTHORIZATION.md>)。本文历史测试边界不改写。

## 当前用户要求

用户明确停止Node统一／清理计划，先测试协作服务，并要求服务器DSH的CPA默认模型设为`deepseek-v4.1-flash`。本次只调整模型，**不实施Node／NVM／Claude切换或删除**；也不把这句话解释为开放业务模型门禁或授权额外模型调用。

保留provider=`cpa`、外部baseURL=`http://10.242.66.179:8317/v1`、协议`openai-responses`、原`CPA_API_KEY`引用、重试0、无供应商回退及原图片权限／限额。`deepseek-v4.1-flash`是CPA网关配置模型名，不代表恢复旧Codego provider，不依据名称保证真实上游身份或视觉能力。

## 配置一致性

[模型配置](<../deploy/ubuntu/model-config.mjs>)的默认模型、标准模型插件的首个模型条目、服务私有JSON的model、关闭门禁的model必须一致；[门禁](<../deploy/ubuntu/model-gate.mjs>)仍要求modelRequestsAllowed=false并在agent/request与llm/stream阻断。仅改Web显示名或服务JSON会导致模型未注册／门禁预检失败，不能算完成。

[默认模型回归](<../test/cpa-default-model.test.mjs>)修正前明确检测到旧gpt-6.1-sol而失败；修正后验证模型、CPA provider／地址／Responses／凭据引用和关闭门禁条目。现有离线实际适配器回归随配置使用新模型名，仍只用fetch替身、不请求外部服务。首次Codego→CPA的隐藏录入／激活脚本也保持新默认模型一致，但**本次不能重复运行这些历史一次性迁移脚本或重新录入密钥**。

## 同步和验收边界

本次先提交GitHub、通过Windows／Ubuntu及打包CI，再核验固定完整SHA构件并同步Ubuntu。窄范围更新活动profile／服务模型／门禁模型及必要固定代码路径，保留gate=false、credentials原字节、业务库／资料／原件／会话、钉钉、HTTPS及成员SSH；后端仅为加载新配置受控重启，系统Node不变，不移动宝塔或NVM。

## 已完成同步与验收

- 实际部署固定提交 **`f1223dcecf17399cc5c6dc0b92d7494ca8e5a275`**；先push，等待[双平台／打包CI 38712431084](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38712431084)全部success，再下载并核验该次公开构件。包382666字节，SHA256 `3717442610cee7aa63ae2fbc85ef3652ed750c9824a43c828bf44a1061236ded`；依赖种子来自原部署锁，生成新锁后冻结安装且禁生命周期脚本，新锁SHA256 `d097b9710e7a26650c84c30aa7efa88de2feaebbc3af977756631652801b6226`。
- 本地完整285业务＋78单元／安全（1项POSIX在Windows显式跳过）＋19宿主集成、599导入／260链接审计通过；Ubuntu另执行6项Python策略和新模型注册／旧模型门禁拒绝／开放门禁拒绝离线预检通过，没有外部模型HTTP。
- 活动标准模型插件首模型、服务JSON默认模型和门禁模型均为 **deepseek-v4.1-flash**；provider／地址／OpenAI Responses／凭据引用和其他profile内容未变，必要公开模块路径同步到上述固定提交。129份业务／运行源码与原部署逐字节一致，同时匹配新CI包；不是服务逻辑升级。
- 后端PID526605，active／running，NRestarts0；仅为加载新配置受控重启。HTTPS PID131607、成员SSH PID181471未变，Ubuntu回环及公网HTTPS登录完成页200／no-store；Windows真实既有成员SSH19482握手取得0.5.0／协议v3，钉钉设备认证要求与扫码前项目拒绝保持，未新扫码。
- 切换前后53张业务库表（含sqlite_sequence）及3张接入表schema／行摘要相同；资料、原件、全部会话及SSH／入口配置未变，停服配置替换期间数据字节不变。credentials原字节未变，服务JSON及门禁JSON**仅model字段变更**，modelRequestsAllowed仍false；私有文件继续0600。
- 实际部署标准模型条目及门禁重新做隔离Context验收：新模型注册存在，agent/request与llm/stream均拒绝，0委派／0网络。系统运行Node仍`/usr/bin/node` v24.15.0；系统Node、宝塔Node、NVM及Claude目录／配置身份对比未变，Node统一／清理计划没有继续执行。

之前唯一真实文本请求验证的是**旧gpt-6.1-sol**，见[历史外部API实测](<EXTERNAL-CPA-CUSTOM-API.md>)，不能当作此新模型已经实测。**此轮真实模型请求0，业务门禁仍关闭，发送业务对话会被拦截**；用户自行测试前仍需另行明确是否开放门禁。文档补记不再重启服务、不移动上述运行SHA、不发新模型请求。
