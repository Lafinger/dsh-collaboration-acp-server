# Ubuntu CPA默认模型：deepseek-v4.1-flash

## 当前用户要求

用户明确停止Node统一／清理计划，先测试协作服务，并要求服务器DSH的CPA默认模型设为`deepseek-v4.1-flash`。本次只调整模型，**不实施Node／NVM／Claude切换或删除**；也不把这句话解释为开放业务模型门禁或授权额外模型调用。

保留provider=`cpa`、外部baseURL=`http://10.242.66.179:8317/v1`、协议`openai-responses`、原`CPA_API_KEY`引用、重试0、无供应商回退及原图片权限／限额。`deepseek-v4.1-flash`是CPA网关配置模型名，不代表恢复旧Codego provider，不依据名称保证真实上游身份或视觉能力。

## 配置一致性

[模型配置](<../deploy/ubuntu/model-config.mjs>)的默认模型、标准模型插件的首个模型条目、服务私有JSON的model、关闭门禁的model必须一致；[门禁](<../deploy/ubuntu/model-gate.mjs>)仍要求modelRequestsAllowed=false并在agent/request与llm/stream阻断。仅改Web显示名或服务JSON会导致模型未注册／门禁预检失败，不能算完成。

[默认模型回归](<../test/cpa-default-model.test.mjs>)修正前明确检测到旧gpt-6.1-sol而失败；修正后验证模型、CPA provider／地址／Responses／凭据引用和关闭门禁条目。现有离线实际适配器回归随配置使用新模型名，仍只用fetch替身、不请求外部服务。首次Codego→CPA的隐藏录入／激活脚本也保持新默认模型一致，但**本次不能重复运行这些历史一次性迁移脚本或重新录入密钥**。

## 同步和验收边界

本次先提交GitHub、通过Windows／Ubuntu及打包CI，再核验固定完整SHA构件并同步Ubuntu。窄范围更新活动profile／服务模型／门禁模型及必要固定代码路径，保留gate=false、credentials原字节、业务库／资料／原件／会话、钉钉、HTTPS及成员SSH；后端仅为加载新配置受控重启，系统Node不变，不移动宝塔或NVM。

当前条目是实施前范围说明，CI与Ubuntu切换结果尚待后续补记。之前唯一真实文本请求验证的是**旧gpt-6.1-sol**，见[历史外部API实测](<EXTERNAL-CPA-CUSTOM-API.md>)，不能当作此新模型已经实测。此轮不发送真实模型请求；用户自行测试前仍需另行决定是否开放协作业务门禁。
