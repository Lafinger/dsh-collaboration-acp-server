# 钉钉接入方案架构审查记录

**审查日期：2026-10-13。结论：方向可行，原稿不足以直接实施；已按用户确认的十二项取舍修订架构，未修复代码或验证真实平台。** 主方案见[修订方案](<DSH-IM-DINGTALK-PLAN.md>)。

> 此处“未修复代码”是审查阶段的历史结论。后续授权实施及当前测试状态见[实施记录](<DINGTALK-IMPLEMENTATION.md>)，没有推送、生产升级或真实钉钉验收。

## 1. 核对范围与方法

- 基线：协作服务0.4.2、客户端0.3.0、DSH0.2.0-rc.2；仓库HEAD `fdb2bfc88d58543bfe18771261a8799fe8c18886`，方案为此前生成的未提交文档。
- 上游：dsh-im v4.39.0，对应提交 `f6a9dd0abbeae605e459a660a9922c9a703e6aa0`；核对固定版本源码及钉钉官方网页／Markdown文档，不将搜索摘要当作已实现能力。
- 本地：直接阅读认证、工具、业务服务、profile和重置边界；离线脚本在内存业务库中创建合成项目并验证行为，资料只在独立临时目录保存。无生产库／数据卷访问、模型请求、平台登录或消息发送。
- 未安装dsh-im、修改实现／部署、清库或提交发布。公开API文档与源码核查不是实际组织权限、扫码或收发验收。

## 2. 问题、依据与设计修复

| 编号／重要性 | 原方案问题及证据 | 已确认的架构修复 |
|---|---|---|
| R1 严重：权限闭环 | [业务入口](<../business/src/index.ts#L1-L5>)明确无权限模型；[项目查询](<../business/src/service/project-service.ts#L79-L90>)不接受成员，[待办角色](<../business/src/tool/notice-tools.ts#L86-L113>)由调用方给定。不能假定“项目受限／本人待办”已落实。 | DSH与钉钉共用新增项目访问控制；管理员维护独立参与名单；角色不是访问权限，本人角色从可信成员解析。 |
| R2 严重：关联对象越权 | [分析读取](<../business/src/service/analysis-service.ts#L83-L94>)确认外层项目后，按资料ID[读取](<../business/src/service/analysis-service.ts#L241-L266>)；离线证实项目A可引用项目B资料。检查project_id不足以限制内容。 | 逐项解析真实归属，校验资料、分析、方案、任务、成果及引用链；首期禁止跨项目引用，进入模型前拒绝无权内容。 |
| R3 严重：只改客户端不能认证 | [现有connector](<../src/connector.mjs#L19-L39>)在客户端initialize前按SSH账号签票绑定；[连接服务](<../src/service.mjs#L26-L42>)后续只检查已有身份。换掉配置显示不会改变服务器信任链，也不能支持可靠撤销。 | 服务器验证扫码并签发受限登录资格，与SSH入口匹配；恢复、工具与投递均复核授权。设备退出与全局停用分开，12小时设备上限。 |
| R4 高：登录引用过时／身份标识不同 | 原引用[旧扫码文档](https://open.dingtalk.com/document/orgapp/scan-qr-code-to-log-on-to-third-party-websites.md)明确已转历史；[新版](https://open.dingtalk.com/document/orgapp/tutorial-obtaining-user-personal-information.md)有内嵌页面／回调同源要求。[unionId转换](https://open.dingtalk.com/document/orgapp/query-a-user-by-the-union-id.md)有开发者作用域、权限及内部／外部联系人区分，[机器人字段](https://open.dingtalk.com/document/orgapp/robot-receive-message.md)使用senderStaffId。 | 客户端打开可信HTTPS登录页，结果绑定原设备／服务；用组织内应用验证身份转换与资格，不比较昵称或不同标识、不回退不可信senderId。 |
| R5 高：同Host依赖缺口 | [dsh-im入口](https://github.com/xmanrui/dsh-im/blob/v4.39.0/plugin-src/host/index.mjs)依赖connection／typertGateway；[钉钉入口](https://github.com/xmanrui/dsh-im/blob/v4.39.0/plugin-src/host/channels/dingtalk/index.mjs)亦要求这些服务，生产路径使用宿主会话／工作区管理。当前[精简profile](<../deploy/docker-linux/profile.patch.yml>)没有相应配置。 | 同Host保留为目标，依赖补齐与隔离是上线门槛；只暴露受控管理员入口，机器人不走普通宿主、管理命令、审批或会话同步。 |
| R6 高：钉钉受控契约未具备 | [投递适配器](https://github.com/xmanrui/dsh-im/blob/v4.39.0/plugin-src/host/delivery-adapter.mjs)对核心能力不存在时拒绝；[钉钉控制器](https://github.com/xmanrui/dsh-im/blob/v4.39.0/src/channels/dingtalk/dingtalk-controller.mjs)无consumeInbound／replyChecked／describeDeliveryAccount实现。泛用发送不能当飞书受控发送契约。 | 补齐钉钉专属受控接收、身份／目标、生命周期及原消息关联，单消费者；能力缺失不开放双向，不启用普通问答替代。 |
| R7 严重：群受众扩大 | 原稿仅核对发问者，未区分公共群和个人结果。[群成员API](https://open.dingtalk.com/document/orgapp/query-group-members.md)仅适用群模板创建或安装群聊酷应用的群，非任意群。 | 公开范围与成员资格分别校验；本人待办仅私聊，群范围不明停止受保护发送；承认外部群变化竞态与已发消息不可收回。 |
| R8 高：上下文绕过新权限 | [现有运行时](<../src/dsh-runtime.mjs#L26-L48>)按成员建立Agent，没有项目／公开私聊上下文约束；只阻止新工具不清除模型已有历史。 | 会话固定项目并按成员／渠道／受众隔离；撤销停用对应上下文，切项目不拼历史；不能承诺抹掉成员本机和平台已有副本。 |
| R9 高：角色换人后旧同意仍有效 | [角色更新](<../business/src/service/project-service.ts#L92-L102>)无交接历史；[方案门禁](<../business/src/domain/plan.ts#L141-L154>)计入旧agree而不核对确认人现资格。离线确认换掉Alice后，Bob下一确认仍促成方案生效。 | 管理员管理角色；受影响待生效方案暂停、人修订新版本、重收全部角色确认，保留旧同意／拒绝；已生效决定不自动回滚。 |
| R10 高：ACK不等于保存 | [钉钉运行时](https://github.com/xmanrui/dsh-im/blob/v4.39.0/src/channels/dingtalk/dingtalk-runtime.mjs)先socketCallBackResponse成功，再异步解析和bridge.accept；ACK后崩溃可能无持久记录。 | 先验证／持久登记再ACK，异步处理不等待模型完成；做不到不承诺可靠双向，不假称平台断线消息可完整补投。 |
| R11 高：发送部分成功／未知状态 | [主动发送](https://github.com/xmanrui/dsh-im/blob/v4.39.0/src/channels/dingtalk/dingtalk-api.mjs)长Markdown可能分段发送；[投递服务](https://github.com/xmanrui/dsh-im/blob/v4.39.0/plugin-src/host/delivery-service.mjs)普通send结果不是持久出站日志。别名路由可变，重试整条可能重复。 | 持久投递意图、逐段状态、实际路由重核；恢复不盲重发在途／未知结果。模板提醒以已提交事实派生，发送前检查版本、资格和是否仍需处理。 |
| R12 高：重置后旧IM仍可到达 | 清空本库不删除钉钉消息。旧[重置脚本](<../deploy/docker-linux/reset-state.mjs#L9-L25>)不覆盖新附件／通信状态；[客户端映射](<https://github.com/Lafinger/dsh-collaboration-client/blob/ecc91eeee55765122703d734e348de80a9c3f22d/src/member-client.mjs#L53-L79>)与服务器独立保存。 | 先停收停发、冻结队列和撤销登录，再清限定数据；新批次保留旧消息失效边界，迟到消息／按钮不关联新项目；删除与备份清单实施前再确认。 |

## 3. 离线验证结果

直接运行当前业务预构建代码，输出`offlineArchitectureProbe: PASS`。PASS表示复现原行为，不表示缺陷已修复：

1. 项目列表返回两个合成项目，无成员筛选；角色成员不是访问名单。
2. todo_list可按参数查询Bob角色待办，无可信本人筛选。
3. 项目A的analysis readScope可读取项目B的合成资料内容。
4. Alice确认product后换成另一成员，Bob确认backend仍使方案生效，旧Alice记录继续有效。
5. 固定版本dsh-im的宿主依赖与当前profile不同；钉钉控制器未提供飞书式受控接收契约。

这些验证只读公开实现并写隔离合成状态，没有验证真实认证、群权限、平台重投递或付费模型链路。不因离线复现直接修改当前业务数据或扩大生产操作。

## 4. 已确认取舍与剩余验收

用户分轮确认：统一项目名单（两端）、群公共／个人输出分离、同Host依赖隔离、可信HTTPS扫码页、设备退出／全局撤销分离、独立协作管理员、可校验项目群、12小时设备登录、先持久后ACK、重置新批次、待生效旧确认失效及人修订、项目／渠道／受众上下文隔离。

仍属实施前条件，而非等待用户重答的设计问题：

- 登录与机器人应用的真实权限、用户标识作用域对应、内部员工与私聊身份的可信证据。
- 所选钉钉群具备成员校验能力，且不能依靠错误的默认群能力假设。
- dsh-im依赖能在本宿主安全补齐；钉钉专属消费者与持久接收／目标校验接口通过实际测试。
- 权限层覆盖所有入口、派生对象、历史和关联引用；资格变化与业务提交有一致的校验边界。
- 设置组织复核窗口、最小通信保留策略及受控失败恢复策略；必要日志脱敏、模型预算与防滥用边界实施时确定，当前不承诺无限请求或无成本。
- 实际登录／退出／撤销、群与私聊、崩溃恢复、部分发送、旧批次迟到消息和限域重置均需验收；平台已收到的消息和客户端已有副本无法保证收回。

**修订范围只是文档。** 不能把“用户确认＋架构补齐”写成代码安全修复、实际扫码通过或已完成测试重置。主方案任何硬门槛未验证即停止双向上线。
