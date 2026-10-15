# Ubuntu DSH连接外部CPA：标准自定义模型API修正

## 用户最新明确范围

只修改Ubuntu `192.168.2.20`上的DSH，协议**OpenAI Responses**，不是截图展示的Chat Completions；外部CPA地址`http://10.242.66.179:8317/v1`、配置模型`gpt-6.1-sol`。CPA由用户在其他主机维护，通过ZeroTier连接；本仓不部署CPA、不修改DSH源码、不碰本机GUI和客户端。沿用服务器已保存的密钥；modelRequestsAllowed继续false，不启用机器人、不重放业务。用户随后明确授权验证ZeroTier连通并测试gpt-6.1-sol，本轮仅隔离执行一次最小文本Responses请求，不打开协作业务门禁。

## 已确认根因及最小修正

此前profile的llm-pi-ai条目指向专用命名的host-cpa包装，包装只调用DSH自带的`@deepseek-ai/dsh-llm-pi-ai`并检查图片能力，**并没有运行CPA服务**。但这种专用装配没有必要，也造成“官方CPA”的错误表述。CPA并非本仓或DSH的官方服务。

- [profile生成器](<../deploy/ubuntu/render-profile.mjs>)现在直接挂载`@deepseek-ai/dsh-llm-pi-ai`，在标准config.providers.cpa中指定baseURL、api、apiKeyEnv、models，对应DSH“新增自定义模型API”。
- 移除多余host-cpa模块及collaborationCpaReady注入依赖；[协作装配](<../deploy/ubuntu/mount-server.mjs>)依赖现有DSH服务，不实现模型适配器。标准插件同步注册provider，协作runtime本身仍验证路由是否存在。
- 保留原image输入声明、图片限额／权限／历史offload、无重试／无自动供应商回退和关闭门禁；不借修正配置改Node、升级DSH、删除业务数据或移除授权防线。
- [真实协议回归](<../test/cpa-adapter.test.mjs>)改为加载profile中**同一标准插件配置**，离线fetch替身核对`/responses`、tool-result原生image、省略占位及503只请求一次；不靠另造包装通过测试。
- [配置回归](<../test/custom-model-api.test.mjs>)修正前明确失败：实际是release下host-cpa，期望DSH标准模型插件；修正后通过。

## 网络与可用性边界

修正前只读检查：Ubuntu的zerotier-one服务active，但ZeroTier接口没有IPv4地址；`ip route get 10.242.66.179`走普通eno1／192.168.2.1网关，不是ZeroTier；至8317仅TCP握手超时（无HTTP／鉴权／模型字节）。进一步只读查明网络已授权、节点在线，控制端已分配10.242.169.184/16，但allowManaged=false导致地址和路由未应用。用户要求“ZeroTier使用默认的安装设置”后，按[ZeroTier默认配置](https://docs.zerotier.com/config/)仅将此已加入网络的allowManaged恢复true，allowGlobal／allowDefault／allowDNS继续false；已应用10.242.169.184，CPA路由走ztfl6kpbcz，物理默认路由不变，未重启ZeroTier或协作服务。地址应用后的初次TCP仍超时；随后定向诊断确认邻居已解析、经ztfl6kpbcz的ping两发两收／0丢包，8317 TCP连接成功（约0.33秒）。本机UFW允许出站；未改防火墙或对端服务，未加入新网络、更改控制端授权或读取认证令牌。因此配置、overlay链路收敛及API请求分别核验，不用其中一层成功代替其他层。

## 执行及验收状态

- 标准模型配置回归先失败后通过；完整本地285业务＋77单元／安全（1项POSIX在Windows跳过）＋19宿主集成、597导入／251链接和命名审计通过；抽取包219文件通过。Ubuntu另执行6项Python策略和标准插件／图片组合离线烟测通过。
- 源提交及实际部署固定SHA **`03ad8841ed3a66d83faa93bc816e27b7dd36364e`**，先push GitHub，再等待[双平台与打包CI 38702656502](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38702656502)全部success；核验CI包378941字节，SHA256 `db9da01892b801866283abbc2dc269f75c674aafcf3b697b1c2cdee5211dc3b9`。Ubuntu依赖冻结安装禁用生命周期脚本，部署锁SHA256 `92a092d29b92c10fe8f98ba06baa9e9a46eadd4bfe69bfc715d6f377f8e2e706`。不新建服务端tag／Release。
- Ubuntu活动profile的llm-pi-ai条目直接为DSH标准插件，完整config.providers.cpa含Responses／外部baseURL／原凭据引用／模型及image声明。旧包装不再挂载，新release不含该文件；没有部署CPA服务或修改DSH代码。
- 实际后端PID495679、active／running、NRestarts0，129份已安装运行源码匹配该CI包。系统Node仍`/usr/bin/node`／v24.15.0，本轮未变更运行时；不把宝塔v24.22.0误称为当前运行版本。
- 切换前后53张业务库表（含sqlite_sequence）与3张接入表schema／行摘要一致；停服配置替换期间业务／session／workspace文件字节不变。资料、已收原件和全部会话文件未变；credentials、collaboration服务JSON、关闭门禁文件逐字节不变，均保留0600；没有重录／复制密钥。
- HTTPS PID131607、成员SSH PID181471未更换，配置摘要不变；Ubuntu回环／公网HTTPS与Windows HTTPS登录完成页200。现有本机私钥严格known_hosts真实SSH19482握手取得0.5.0／协议v3，钉钉设备认证要求与扫码前项目访问拒绝保持；未新扫码或业务prompt。
- 重新加载**实际部署的标准模型条目及门禁文件**做隔离Context检查，agent/request和llm/stream均拒绝、0委派／0网络。更新只改变模型装配公开profile、固定release模块链接和后端启动路径；原密钥、身份、库、SSH、HTTPS和业务模型门禁不变。

## 用户授权的一次真实模型验收

通过新release中与活动profile**同一标准模型插件和配置**，在Ubuntu隔离Context、临时HOME执行一次性文本请求；沿用实际私有凭据服务只读解析密钥，内存处理、未输出。没有业务会话、历史、tools、机器人或重试插件，也没有改变活动门禁。

| 验收项 | 实际结果 |
| --- | --- |
| 网络 | ZeroTier接口ztfl6kpbcz，源10.242.169.184，至10.242.66.179:8317 |
| 请求 | POST `http://10.242.66.179:8317/v1/responses`，model=`gpt-6.1-sol`，stream=true |
| 最小输入 | Reply with exactly CPA_OK and no other text. |
| 输出／协议 | HTTP **200**，text/event-stream，finish=stop，正文 **CPA_OK** |
| 网关报告模型 | `gpt-6.1-sol`；这是网关返回标识，不据此证明真实上游来源 |
| 实际HTTP请求数 | **1**；未重试、未回退、未追加图片／工具测试 |
| 用量 | inputTokens312／outputTokens6／totalTokens318，以网关返回统计为准 |
| 耗时 | 4197ms |
| 业务门禁 | 仍false；原文件字节未变 |

最初一次测试脚本因把class型凭据插件当namespace装载，在网络前退出（networkRequests=0）；用隔离合成凭据复现导入差异并验证default类后，才执行上表唯一实际HTTP请求。因此不是模型失败后的自动重试，也没有重复计费请求。

**本次已证明该时点Ubuntu经ZeroTier使用现有key、标准DSH配置可以得到指定模型名的文本响应。** 未验证真实图像识别、工具调用或业务全链路，也不保证网关后续持续在线和上游身份真实性。本次测试授权不等于开放协作模型门禁。首次Codego→CPA的隐藏录入／激活脚本仍仅用于原路线迁移，不能重复运行用于此次修正。

本记录为上线后补记；文档提交不移动上述已验证的运行SHA，不追浮动main部署或重发模型请求。
