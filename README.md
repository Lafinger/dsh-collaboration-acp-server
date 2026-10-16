# dsh-collaboration-acp-server

**服务器 DSH 的协作 ACP 服务端插件**：安装、配置并启用后，复用宿主运行时，为多个可信登录成员提供独立 Agent 会话与共享工作台业务库。插件不创建第二套 DSH，不改宿主模型注册，不在卸载时关闭宿主。

0.5.0精确支持 **DSH0.2.0-rc.2 / Cordis4.0.4 / Schemastery3.18.4 / Node>=24**。不兼容旧0.1.5独立服务入口，旧CLI明确拒绝启动，不自动迁移旧数据。服务器管理员可信；成员会话逻辑隔离不等于OS多租户隔离。

> 来源：原工作台提交3e0b76c，历史独立服务提交dac24aa。当前代码无需原仓或客户端源码；保留有限ACP-shaped接口与collaboration扩展，不宣称完整ACP兼容。

## 网页扫码最小改版（正式保留切换完成，双人验收进行中）

已按用户最终确认改为默认浏览器官方扫码＋原DSH自动领取，无电脑钉钉／核对码／“我已扫码”。双仓固定Windows／Ubuntu及打包CI成功、本人普通网络手机扫码通过后，服务端已用固定提交`5209fa1eaf4b8f2d568148c487bb8771a78dda22`切换至`mode:mvp-qr`：保留原成员／业务／会话epoch，仅一次撤销旧PC设备并关闭PC及临时入口，不清库、不新增公网。A随后确认手机及现用DSH重启自动保持本人登录通过；B本人扫码／设备隔离与最小业务闭环仍待验收，不冒称全部完成。见[正式部署记录与剩余门槛](<docs/MVP-QR-DEPLOYMENT-2026-10-16.md>)、[实现说明](<docs/MVP-WEB-QR.md>)和[已批准方案](<docs/MVP-网页扫码登录改版方案.md>)。以下PC证据仅为历史。

## 历史0.6.0 PC MVP（已被网页扫码替代）

本轮已获用户“确认，开始实施”：统一HTTPS/WSS、电脑钉钉官方身份自动登记、全员项目可见、固定陈锦鸿管理员仅创建项目／分配职责。不建设成员管理／项目ACL／机器人；不再要求个人SSH、密钥或hosts。保留7天Windows系统加密设备登录、5分钟组织复核、职责本人决定、私人／项目会话隔离和不自动重发。

使用[新MVP说明](<docs/MVP-HTTPS.md>)与[新私有配置空模板](<examples/mvp-https.example.json>)，产品范围见[最终确认](<docs/MVP-账号与电脑钉钉登录方案.md>)。代码已覆盖离线HTTP/WSS、真实DSH宿主与双插件TLS测试；A在隔离实例完成真实电脑钉钉本人确认、原客户端领取与Windows加密保存／恢复／退出，A／B实际统一ZeroTier网络通过。2026-10-16按固定成功Windows/Ubuntu CI提交完成原服务正式切换，精确无备份退役旧业务／账号／SSH及验证实例，保留应用秘密、CPA和排除项；**不代表B本人认证、现用GUI后台重启或A/B业务验收**。固定运行版本及剩余门槛见[部署记录](<docs/MVP-DEPLOYMENT-2026-10-16.md>)，不把文档提交或包版本号当作新运行版本。

以下0.5.x及个人SSH配置／扫码／逐项目资格内容保留历史，不是新版部署入口，也不是MVP的兼容回退。CPA及业务／附件能力继续复用，现有外部模型路线不变。

## 历史0.5.0：Ubuntu CPA与授权图片输入

保留现用Ubuntu已部署的钉钉扫码、项目权限及[日志保留维护](<docs/DINGTALK-RETENTION.md>)基线；本轮只新增CPA配置、PNG／JPEG／WebP原生工具图片、历史预算和GIF双端禁传。现用基线与本轮增量分开提交；服务端不另发tag／Release，必须按双平台CI成功的固定SHA部署。[Ubuntu步骤与隐藏key录入](<deploy/ubuntu/README.md>)、[设计确认](<docs/设计确认-CPA切换与本地模拟退役.md>)。

CPA是用户通过ZeroTier访问的**外部服务**，DSH只用标准模型插件的`providers.cpa`自定义API配置连接，不在Ubuntu部署CPA或修改DSH源码；[标准API修正](<docs/EXTERNAL-CPA-CUSTOM-API.md>)。当前配置默认模型deepseek-v4.1-flash／OpenAI Responses，保留原图片输入声明（非新模型视觉能力的真实验收）；[默认模型调整](<docs/CPA-DEFAULT-MODEL.md>)。不强制High、不重试、不回退Codego。**协作业务模型请求现支持用户显式授权开启；缺失／错误策略仍关闭**，本次用户已允许解除临时门禁，实施与部署验收见[模型授权](<docs/CPA-MODEL-AUTHORIZATION.md>)。此前用户另行授权的一次最小文本Responses请求以旧模型gpt-6.1-sol通过ZeroTier返回200／CPA_OK，见上述历史修正验收；不能当作deepseek-v4.1-flash已实测。原生图片及权限链路仍仅离线验证，不冒充真实视觉效果或上游身份验收。升级不代装现用GUI、不启用机器人、不清库或重放。当前协作协议v3拒绝旧v2和SSH-only业务回退；既有0.4.2标签早于现用钉钉基线，不能作为本轮升级源。

## 安装与启用

DSH插件管理器安装来源：

```text
github:Lafinger/dsh-collaboration-acp-server
```

旧公开固定入口为`github:Lafinger/dsh-collaboration-acp-server#v0.4.2`；本轮0.5.0只按成功CI的完整commit SHA安装，不创建新tag／Release，也不从浮动main部署。无版本入口读取main，不自动选择最新Release。GitHub自动检查/打包与发布见[发布说明](docs/RELEASE.md)，当前发行证据见[项目详情v0.4.2验收](docs/PROJECT-DETAILS-RELEASE-VERIFY.md)，此前[改名验收](docs/RENAME-RELEASE-VERIFY.md)，旧版本首发证据保留[历史记录](docs/GITHUB-RELEASE-VERIFY.md)。当前Ubuntu部署及实测边界见[0.5.0 CPA上线验收](<docs/CPA-UBUNTU-VERIFY.md>)与[固定提交运维](<deploy/ubuntu/README.md>)；[旧Docker目录](<deploy/docker-linux/README.md>)仅保留历史，不作为后备服务。只发布GitHub，不发布npm或DSH插件市场。

安装后默认disabled；空配置启用为安全待配置，不建库、不监听、不调用模型。复制[空模板](examples/server-config.example.json)到服务账号自己的私有配置文件，填写部署路径、账号独立凭据与宿主已有provider/model，按[部署说明](docs/DEPLOYMENT.md)检查后启用。没有GUI配置表单，也不自动修改sshd或创建系统账号。

模型对话持久化由宿主提供；工作台业务库和接入元数据由插件管理。成员只有工作台工具，不能继承宿主文件、终端、MCP、subagent等能力；本地普通会话没有本插件业务工具。服务器当前聊天窗口切模型不改变协作服务明确选定的模型路线。

## 实现目录

- [插件入口](src/server-plugin.mjs)、[配置校验](src/configuration.mjs)、[bundle patch](cordis.patch.yml)
- [宿主运行时适配](src/dsh-runtime.mjs)、[业务装配](src/collaboration-runtime.mjs)、[接入服务](src/service.mjs)、[可信身份绑定](src/collaboration-binding.mjs)
- [轻量SSH connector](src/connector-cli.mjs)：无模型、不另起DSH
- [业务源码](business/src/)、[核验编译产物](business/lib/)、[历史业务文档](business/docs/协作服务需求文档MVP/README.md)
- [运维](docs/OPERATIONS.md)、[当前契约](docs/PROTOCOL-v3.json)、[验证](docs/VERIFY.md)、[架构决定](docs/adr/0001-hosted-collaboration-runtime.md)、[术语](GLOSSARY.md)

## 开发与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm pack --out .dsh/dsh-collaboration-acp-server.tgz
node scripts/check-package.mjs .dsh/dsh-collaboration-acp-server.tgz
```

check验证业务源码与已提交编译产物一致，再运行285项业务回归和接入/真实宿主接口测试，不静默重建后掩盖陈旧产物。业务源码变更后显式`pnpm run build`并提交生成内容。没有prepare/install/prepack构建，GitHub安装无需执行脚本。测试宿主只位于测试目录，不提供独立生产启动路径。

联合检查显式选择另一仓库：

```sh
DSH_COLLABORATION_CLIENT_ROOT=/absolute/client-checkout pnpm run check:joint
```

测试使用本地固定模型替身，官方DSH Agent loop、工具执行、会话持久化与SQLite是真实实现。不调用付费模型；真实Linux SSH/权限与GUI端到端仍需部署验收。新增受限客户端附件工具传输与DOCX/MD/TXT解析，PNG/JPEG/WebP授权原生图片输入及限额，禁止GIF；不增加独立OCR工具或多客户端共编，不扩大项目/管理员权限规则；见[附件用法与边界](<docs/ATTACHMENTS.md>)。

## 跨局域网成员接入

两台成员电脑可分别经LAN与ZeroTier连接同一个协作服务。保持A入口、只增加B单源/32的专属成员SSH网络许可；B本人账号、公钥、钉钉及项目资格独立核验，不因TCP放通自动授权。实施边界与固定SHA维护流程见[ZeroTier成员入口](<docs/MEMBER-ZEROTIER.md>)。

## 项目背景与目标编辑

v0.4.2新增`project_update_details`，只编辑已存在项目中明确提供的background／goal；未提供字段不变，空白／null拒绝，归档项目与附件turn拒写，不改角色或任何资料／分析／计划／任务。无需重建项目或客户端升版。用法和用户授权模板见[项目详情编辑](<docs/PROJECT-DETAILS.md>)；正式发布与生产保留核验PASS，见[本次发行证据](<docs/PROJECT-DETAILS-RELEASE-VERIFY.md>)。

## 许可证

[MIT License](LICENSE)，Copyright (c) 2026 Lafinger。第三方依赖遵循各自许可证；保留private:true防止意外npm发布。
