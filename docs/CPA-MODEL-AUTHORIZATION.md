# CPA业务模型请求：用户显式授权开启

## 授权与根因

用户在“协作服务”发送“你好”后要求排查。已对同一映射远端会话的持久turn/end确认错误`MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE`：请求经过SSH、设备登录和会话创建后，在模型门禁被拒绝，尚未到达CPA；前次[默认模型调整](<CPA-DEFAULT-MODEL.md>)明确保留了关闭状态，不是模型配置未同步。客户端使用通用COLLABORATION_NO_REPLAY提示，没有展示门禁的结构化cause，不能将其当作CPA供应商报错。

助手询问“是否现在允许我开启协作服务的真实模型请求，让你开始对话测试”，并声明不自动重放旧“你好”或替用户调用模型；用户明确回复“允许”。此次授权仅用于解除该临时业务模型门禁，仍保留cpa／deepseek-v4.1-flash、原外部地址、OpenAI Responses、原密钥、重试0／无回退，钉钉设备认证、成员／项目／附件权限与全部数据不变。不启用机器人，不执行已停止的Node／NVM／Claude统一清理。

## 可控门禁，而非删除门禁

[模型门禁](<../deploy/ubuntu/model-gate.mjs>)保留agent/request与llm/stream两处检查。只接受服务账号私有0600常规单链接文件中，provider／model与固定CPA配置相同且modelRequestsAllowed是**严格boolean**的策略；缺失、语法错误、链接、所有者／权限异常、字符串true或路线漂移均拒绝。

- false：保留原关闭错误，0模型委派。
- true：只放行同一固定CPA路线；agent/request在下游配置返回后再检查一次，llm/stream在接触适配器前同步检查。
- 每次读取当前策略，不缓存开启状态；重新关闭后后续步骤被阻断。既有已进入网络的流不会被此文件翻转自动取消，紧急停服／撤销仍由管理员控制。
- [挂载](<../deploy/ubuntu/mount-server.mjs>)要求有效的collaborationModelPolicy服务，接受合法true或false；缺少或伪造／无效策略不挂载。旧collaborationLoginOnlyPolicy不再作为永久关闭的隐含契约。
- 文件名暂保留login-only-policy.json以避免无关迁移，但内容现支持显式授权。首次Codego→CPA的隐藏录入／一次性激活流程依旧默认false，不能为开启而重新录入密钥或重跑。

## 回归与部署要求

[单元回归](<../test/model-authorization.test.mjs>)在旧实现下先失败，覆盖严格文件策略、真实Cordis两处瀑布与LLM、重新关闭／配置异常拒绝以及挂载校验。[真实宿主集成](<../test/model-authorization.integration.mjs>)使用实际DshRuntime／AccessService／持久化与离线fixture，复现“你好”失败、unknown状态；显式授权后恢复相同合成会话时模型调用仍0，旧requestId仍拒绝，仅一条全新合成指令可完成，随后关闭再次阻断。测试无外部HTTP、无真实密钥。

部署必须先GitHub提交、双平台及打包CI成功，核验完整固定SHA构件后再同步Ubuntu。仅换固定公开模块／profile路径并把已核对的门禁false改为true，服务模型JSON与credentials原字节保持；只受控重启后端，HTTPS／成员SSH不重启。切换前后核对数据库schema／行摘要、原件／资料／会话与旧unknown请求，禁止清除记录、自动重试或历史重放。上线验收只做隔离零网络委派探针，不由助手调用真实模型；用户随后可手动发送**新消息**，而不是点击重试原失败消息。

当前条目记录授权与实现范围，上线固定SHA／CI及保留结果在完成后补记。新模型的实际CPA可用性、真实视觉或上游身份不因放开门禁被视为已验收。
