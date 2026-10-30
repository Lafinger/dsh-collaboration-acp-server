# dsh-collaboration-acp-server

**服务器 DSH 的协作 ACP 服务端插件**：安装、配置并启用后，复用宿主运行时，为多个可信登录成员提供独立 Agent 会话与共享工作台业务库。插件不创建第二套 DSH，不改宿主模型注册，不在卸载时关闭宿主。

当前候选0.7.2-rc.2精确支持 **DSH0.2.0-rc.2 / Cordis4.0.4 / Schemastery3.18.4 / Node>=24**，没有随客户端升级宿主。不兼容旧0.1.5独立服务入口，旧CLI明确拒绝启动，不自动迁移旧数据。服务器管理员可信；成员会话逻辑隔离不等于OS多租户隔离。

## 候选0.7.2-rc.3（2026-10-28，术语地图补索引）

`GLOSSARY-MAP.md` 是"本仓有多个语境、每个语境在哪"的索引。新增的[自然语言授权语境](GLOSSARY.md#自然语言授权语境)当初只写进了 `GLOSSARY.md`，地图里没有条目，等于承认了第四个语境却没说它在哪——只读地图的人不会知道授权语境存在。

本版把它加进 Contexts，并补五条 Relationships：授权语境只约束"这一次能调哪些写工具"、不重定义业务事实；本人确认属于业务语境且对模型不可见，IM 渠道按 ADR 0008 走确认码旁路，两条通道的判定不能互相引用；上传／归档／成果提交／开放接收四个动作不可互换；资格巡检的复核期限是新鲜度信号而非中止理由（ADR 0007）。

只有文档变化，无代码改动，协议与权限语义未变（`collaboration 3` / `humanAuthorization 2`），不需要为此重新部署。

## 候选0.7.2-rc.2（2026-10-28，附件词表与服务端同步）

`src/human-intent.mjs` 是客户端与服务端共用的"当前人类指令"判定模块：客户端用它决定这条消息要不要发起附件操作，服务端用它校验这次归档有没有被授权。两侧字节不一致时就会出现"客户端认定已授权、服务端判定未授权"的假拒绝，因此本版把"存档"纳入归档词表（与"归档"同义），并补上"存为／存成资料"的说法；"上传"仍只表示传输，不单独构成归档授权。

同一份字节已同步到客户端0.6.3-rc.1，`test/joint/client-server.joint.mjs` 现在断言两侧 `src/human-intent.mjs` 逐字节相同——之前它不在契约里，靠人记。

协议与权限语义未变（`collaboration 3` / `humanAuthorization 2`）。

## 自然语言授权候选0.7.2-rc.1（2026-10-28，自然语言授权体验）

旧实现把授权当成暗号匹配：带“如果／以后”就整句作废，一条消息里出现两个明确指令就一个都不授权，未授权的写工具还会直接从模型可见工具表里消失。结果是模型既做不了事，也说不出该请人补哪句话，只能回一句“未授权”。

本版三处改动。授权按子句判定并取并集：假设、延后、否定、提问的子句各自不贡献授权，但不再作废其他子句，“提交需求分析，然后提交成果”同时得到两项。业务写工具常驻可见，被拒绝的是调用而不是可见性。拒绝文本指名操作并给出可照抄的一句话，例如“当前人类消息未授权「提交成果」，所以没有执行；草稿不能登记业务，模型不能代本人确认。要现在做的话，请单独发一句：提交成果。”

`plan_confirm`、`result_review`、`result_accept` 仍对模型完全不可见、不可调用；附件工具仍只在有有效授权时可见（它们吃的是模型拿不到的不透明句柄）。协议未变（`collaboration 3` / `humanAuthorization 2`），客户端不需要改行为。词表见 GLOSSARY.md 的“自然语言授权语境”，取舍见 docs/adr/0006～0008。回归见 test/human-policy.test.mjs 的整句矩阵与 test/human-authorization.integration.test.mjs 的可见性/拒绝断言。

## 自然语言MVP候选0.7.1-rc.4（2026-10-28，扫码MVP路径复核租约修正）

0.7.1-rc.3把宿主配置路径的组织复核租约默认值从5分钟提到15分钟，但扫码MVP路径（`mode`为`mvp-qr`或`mvp-https`，也是本部署实际使用的路径）仍硬编码5分钟并把该字段列为不支持项。因此rc.3部署后实际生效的租约仍是5分钟：巡检不再中止长轮次，但租约长度没有变。

本版让扫码MVP路径使用同一套取值与上下限：默认15分钟、上限60分钟，允许显式配置`organizationTtlMs`，越界即拒绝配置。协议、权限、模型、登录方式不变。回归见test/configuration.test.mjs中"QR and MVP organization re-verification lease…"用例。

## 自然语言MVP候选0.7.1-rc.3（2026-10-28，长轮次误中止修复）

0.7.1-rc.3修复0.7.1-rc.2的实际缺陷：资格巡检每秒遍历会话，任一校验失败即中止正在执行的一轮；而被校验的钉钉组织资格复核租约默认只有5分钟，且`collaboration/login/status`在续期语句之前就返回，因此一轮只要超过租约，就会被当成"资格被撤销"而中止，客户端表现为`Remote turn cancelled; committed data remains`——即便当时并未提交任何数据。

本版把巡检收窄到稳定资格（账号启用、组织主体、epoch、成员与参与修订号、登录撤销与过期），租约新鲜度改由每次业务提交前复核；`collaboration/login/status`对过期租约续期；`organizationTtlMs`默认5分钟改为15分钟、上限5分钟改为60分钟。真实撤销路径与逐操作新鲜度校验不变。不改基础协议3、附件传输1、humanAuthorization 2、登录方式、权限或模型。回归见test/authorization-monitor.test.mjs，已用旧代码复验该用例失败、新代码通过。

## 自然语言MVP候选0.7.1-rc.2（2026-10-26，QR入口授权协商修复）

0.7.1-rc.2修复0.7.1-rc.1的实际缺陷：HTTPS/网页扫码入口的MVP初始化覆写了基础服务初始化，只协商附件能力，遗漏humanAuthorization v2的校验、连接状态保存与回告。结果是真实扫码客户端在发送业务前即被拒绝。本版在该初始化分支同步基础服务既有规则（未提供则不声明也不隐式升级；提供时仅接受v2并保存；按已保存状态回告），不改基础协议3、附件传输1、登录方式、权限或模型。回归见test/qr-human-authorization.integration.mjs，经真实HTTP/WSS经QrAccessService/MVP入口验证。

本轮开发目标为自然语言处理**项目资料库**和项目推进，日常不要求手填内部项目ID或附件授权模板。例如“请归档这份附件并整理要点”“先阅读，不要归档”“把刚才那份归档”；泛称“推进/做方案”只整理对话草稿，明确提交才按原业务规则登记。职责本人确认/评审/验收入口不改。

须新客户端与服务端协商humanAuthorization 2；基础协议3、附件传输1不变，未协商不使用新自然授权，已协商不得降级。旧模板说明仅供legacy技术兼容，不是本轮日常操作前提。先阅读不归档；历史内容恢复需新的有效真人确认；未知结果只读核对，不自动重发。详见[自然语言交互与开发边界](<docs/NATURAL-LANGUAGE-MVP.md>)。

此候选按用户授权进入受保护PR、真实双平台CI和普通合入main流程；不创建本服务端tag/Release，部署只能另取main完整成功CI的固定包。**以下发行、部署、真人验收文字保留历史，不能证明0.7.1-rc.3已部署、重启或通过真实模型/钉钉/业务验收。** 提交与CI结果需核对固定commit和run，包版本号不能证明当前运行实例已加载本轮改动。

## 历史0.7.0-rc.1候选准备记录

以下是该版本准备时的边界说明，不是0.7.1-rc.1当前部署状态：包含独立机器人本人文本决定及analysis_submit参数错误分类的最小修复，见[候选说明与验证边界](<docs/RELEASE-0.7.0-rc.1.md>)。当前只准备独立分支与CI，不合并main、不创建tag／Release、不替换线上；机器人仍须受保护显式启用。下文各阶段的“本轮”“未启用”“已部署”及旧安装版本保留历史，不能当成此候选的发行或安装状态。

> 来源：原工作台提交3e0b76c，历史独立服务提交dac24aa。当前代码无需原仓或客户端源码；保留有限ACP-shaped接口与collaboration扩展，不宣称完整ACP兼容。

## 网页扫码最小改版（最小双人闭环及只读终验通过）

已按用户最终确认改为默认浏览器官方扫码＋原DSH自动领取，无电脑钉钉／核对码／“我已扫码”。双仓固定Windows／Ubuntu及打包CI成功、本人普通网络手机扫码通过后，初始认证切换使用固定提交`5209fa1eaf4b8f2d568148c487bb8771a78dda22`进入`mode:mvp-qr`：保留原成员／业务／会话epoch，仅一次撤销旧PC设备并关闭PC及临时入口，不清库、不新增公网。A/B本人扫码、重启记忆和本机退出隔离均已真人确认通过，测试项目与两项职责及B共享可见也通过；真实模型只读、TXT附件首次归档及固定版本分析已通过，待确认方案已登记；后续[资格缓存复核修复](<docs/MVP-PLAN-CONFIRM-QUALIFICATION-2026-10-16.md>)已按固定CI保留部署至`73d002e15e52d5b8380d006a94d5e9035d899609`，双方本人确认、两任务／一依赖、两份本人成果评审和产品独立接受已闭环，2026-10-17只读终验确认待评审／待验收为0。见[最终验收及未测边界](<docs/MVP-MINIMAL-FLOW-ACCEPTANCE-2026-10-17.md>)、[部署记录](<docs/MVP-QR-DEPLOYMENT-2026-10-16.md>)、[实现说明](<docs/MVP-WEB-QR.md>)和[已批准方案](<docs/MVP-网页扫码登录改版方案.md>)。以下PC证据仅为历史。

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
- [运维](docs/OPERATIONS.md)、[当前契约](docs/PROTOCOL-v4.json)、[验证](docs/VERIFY.md)、[架构决定](docs/adr/0001-hosted-collaboration-runtime.md)、[术语](GLOSSARY.md)

## 开发与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm pack --out .dsh/dsh-collaboration-acp-server.tgz
node scripts/check-package.mjs .dsh/dsh-collaboration-acp-server.tgz
```

check验证业务源码与已提交编译产物一致，再运行业务回归和接入/真实宿主接口测试，不静默重建后掩盖陈旧产物。业务源码变更后显式`pnpm run build`并提交生成内容。没有prepare/install/prepack构建，GitHub安装无需执行脚本。测试宿主只位于测试目录，不提供独立生产启动路径。

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
