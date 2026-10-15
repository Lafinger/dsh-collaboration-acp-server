# Ubuntu DSH连接外部CPA：标准自定义模型API修正

## 用户最新明确范围

只修改Ubuntu `192.168.2.20`上的DSH，协议**OpenAI Responses**，不是截图展示的Chat Completions；外部CPA地址`http://10.242.66.179:8317/v1`、配置模型`gpt-6.1-sol`。CPA由用户在其他主机维护，通过ZeroTier连接；本仓不部署CPA、不修改DSH源码、不碰本机GUI和客户端。沿用服务器已保存的密钥；modelRequestsAllowed继续false，不调用真实模型、不启用机器人、不重放业务。

## 已确认根因及最小修正

此前profile的llm-pi-ai条目指向专用命名的host-cpa包装，包装只调用DSH自带的`@deepseek-ai/dsh-llm-pi-ai`并检查图片能力，**并没有运行CPA服务**。但这种专用装配没有必要，也造成“官方CPA”的错误表述。CPA并非本仓或DSH的官方服务。

- [profile生成器](<../deploy/ubuntu/render-profile.mjs>)现在直接挂载`@deepseek-ai/dsh-llm-pi-ai`，在标准config.providers.cpa中指定baseURL、api、apiKeyEnv、models，对应DSH“新增自定义模型API”。
- 移除多余host-cpa模块及collaborationCpaReady注入依赖；[协作装配](<../deploy/ubuntu/mount-server.mjs>)依赖现有DSH服务，不实现模型适配器。标准插件同步注册provider，协作runtime本身仍验证路由是否存在。
- 保留原image输入声明、图片限额／权限／历史offload、无重试／无自动供应商回退和关闭门禁；不借修正配置改Node、升级DSH、删除业务数据或移除授权防线。
- [真实协议回归](<../test/cpa-adapter.test.mjs>)改为加载profile中**同一标准插件配置**，离线fetch替身核对`/responses`、tool-result原生image、省略占位及503只请求一次；不靠另造包装通过测试。
- [配置回归](<../test/custom-model-api.test.mjs>)修正前明确失败：实际是release下host-cpa，期望DSH标准模型插件；修正后通过。

## 网络与可用性边界

修正前只读检查：Ubuntu的zerotier-one服务active，但ZeroTier接口没有IPv4地址；`ip route get 10.242.66.179`走普通eno1／192.168.2.1网关，不是ZeroTier；至8317仅TCP握手超时（无HTTP／鉴权／模型字节）。进一步只读查明网络已授权、节点在线，控制端已分配10.242.169.184/16，但allowManaged=false导致地址和路由未应用。用户要求“ZeroTier使用默认的安装设置”后，按[ZeroTier默认配置](https://docs.zerotier.com/config/)仅将此已加入网络的allowManaged恢复true，allowGlobal／allowDefault／allowDNS继续false；已应用10.242.169.184，CPA路由走ztfl6kpbcz，物理默认路由不变，未重启ZeroTier或协作服务。但随后仅TCP握手仍超时。因此“DSH自定义API配置正确”与“外部CPA可达”是两个独立问题；未加入网络、改控制端授权或读取认证令牌，也不擅自改对端服务／防火墙。

## 执行及验收状态

标准模型配置的定向回归通过；完整CI、固定SHA同步与实际运行保留核验仍在本轮执行，不能把目标当完成。运行数据、当前密钥、钉钉和成员SSH需保留。首次Codego→CPA的隐藏录入／激活脚本仅用于原路线迁移，不能用于此次已为cpa路线的标准API修正；此次不再录入密钥。
