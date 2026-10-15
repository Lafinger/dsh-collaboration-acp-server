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

## 已完成上线与保留核验

- 用户授权之后先提交源码 **9a15430c91d9accde0495c2bc411891a5f6b7323**，等待[双平台／打包CI 38720653881](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38720653881)全部success，再核验该次包386067字节，SHA256 `c245a28d940e79d985f6002d7041f2958661e98b6c6b1510a0e5d65538d6d2dc`；新部署锁SHA256 `50cad3f734d21c8844b0ff1834f57d979a36eeaf5e338a3798fc93d503ff7816`，禁生命周期脚本、锁文件生成后冻结安装。活动运行固定为上述完整SHA，不从浮动main启动、不发新tag／Release。
- 本地285业务＋80单元／安全通过，2项POSIX明确交UbuntuCI；20项真实宿主集成通过，609导入／268链接审计通过。Ubuntu本轮实际预检执行私有文件与实际部署模块／运行时离线探针，关闭时同样问候失败且0模型调用，开启后新合成控制消息才调用本地fixture；原requestId仍拒绝，恢复没有自动执行旧inbox。
- 真实策略现为 **modelRequestsAllowed=true**，provider／model仍cpa／deepseek-v4.1-flash。实际部署gate.apply在隔离Context读取真实策略，agent/request与llm/stream均到达终端sentinel（2次），不是适配器调用；外部网络0、生产会话未触碰。严格错误文件／路线拒绝与重新关闭仍通过，不是删除门禁。
- 后端受控重启后PID559249，active／running，NRestarts0、退出状态0；HTTPS PID131607和成员SSH PID181471未变。回环及公网HTTPS200／no-store，Windows既有成员SSH19482实际握手0.5.0／协议v3通过；钉钉设备认证仍必须，未扫码项目仍拒绝，未新扫码或代装GUI。
- 129份业务／运行源码与上个部署逐字节相同，变化仅部署门禁／挂载代码。credentials与服务模型JSON原字节不变，私有门禁JSON**仅modelRequestsAllowed从false改true**，profile仅固定模块路径变化。私有文件继续0600，SSH／入口配置不变。
- 切换前后即时快照的53张业务表（含sqlite_sequence）、3张接入表schema／行摘要相同，资料／原件／全部会话文件相同；原失败请求unknown记录相同。随后客户端自行重连恢复，原失败会话从7条记录增加一条session/end-seed恢复元数据，现8条；只有原来一个turn/start与turn/end且原门禁错误保留，没有新模型／工具执行。不能把恢复元数据误算为字节完全未变或业务重放；停服配置替换期间保护数据字节不变。
- 当前Node仍/usr/bin/node v24.15.0；系统／宝塔Node、NVM及Claude目录／配置身份对比未变，停止的统一清理没有执行。不启用机器人、不自动重试、不回退供应商。

**用户现在可手动发送新消息，勿点击原失败消息重试。** 本轮助手实际模型请求仍0，不代表新模型实际CPA可用性、真实视觉或上游身份已通过；这些由用户后续测试确认。若后端重连后提示登录失效，再从设置完成钉钉认证即可，不能借此绕过项目权限。上线后文档补记不再重启／迁移运行SHA，也不启动真实模型测试。
