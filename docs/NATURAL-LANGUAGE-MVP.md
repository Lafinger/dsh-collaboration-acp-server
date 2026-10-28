# 自然语言项目资料与项目推进MVP

本候选版本为0.7.2-rc.2，源码来自2026-10-28的附件词表同步：`src/human-intent.mjs` 与客户端0.6.3-rc.1逐字节相同，"存档／存为资料"与"归档"同义，"上传"仍只是传输；该模块已纳入跨仓字节一致契约。0.7.2-rc.1为自然语言授权体验版本，0.7.1-rc.4、0.7.1-rc.3、0.7.1-rc.2与0.7.1-rc.1为历史记录。协议未变（collaboration 3 / humanAuthorization 2）。用户已授权受保护PR、真实CI与普通合入main。

## 日常表达

- “这是南航POC的需求文档，请归档并整理要点。”项目名称是已有可用项目的例子，不要求填写内部ID。
- “先阅读，不要归档。”只为本次阅读传输，不新增共享资料。
- “把刚才那份归档。”仅在当前账号/项目/会话能明确指认且原件仍可用时消费新的真人许可，不重新上传已接收原件；多份无法确定就澄清。
- “帮我做个方案。”先给对话草稿，不登记方案、不自动生成任务或代人批准。
- “请提交刚才那份方案。”才尝试按原权限和前置条件登记；登记不等于激活、评审或完成。
- 遇历史内容相同，先给旧版/当前版说明。只有唯一、有效、未被后续无关话题/取消取代的可信待确认提议，才可用下一条真人“确认”继续恢复为新版本。没有提议的裸“确认”不产生许可。

“仓库”在此指项目资料库，不是Git仓库。自然语言采用保守识别，含糊/冲突/混合对象应问一句澄清，不宣称覆盖任意表达。不扫描成员电脑，不靠文件名-v2自动判断资料关系；不同用途/项目不按hash全局合并。取消待执行意图不会删除已经归档的历史。

## 结果如实表达

- 前置澄清尚未调用业务prompt，不称已上传/归档。
- 校验接收仅表示临时传输完成，不等于共享资料已经登记。
- 归档回复用资料名和必要版本，重复当前内容复用原版并说明未增版；旧回执永远仍指原版本。
- 归档已提交但后续模型整理中断，报告已确认的归档事实与未完成部分，整体仍保留错误/不确定状态。
- 已发送丢回执只读核对status/history/receipts；不自动重发prompt或业务工具，不以模型口述当作成功凭据。
- not_started仅证明该请求业务未开始，不意味着连授权审计记录也完全没有写入。

## 开发者协议边界

基础collaborationProtocolVersion=3、attachmentTransfer.version=1保持，initialize独立协商humanAuthorization={version:2}。每个v2 session/prompt携带_meta.humanAuthorization：version、当前真实messageId、UTF8原文textSha256、projectId、attachmentScopes(handle/action)、receiptScopes(receiptId/action及已核验的可选targetMaterialId/expectedLatestVersion/restoreVersion)。原文不补伪人类授权行；元数据与manifest逐项核对，不让模型签发或升级许可。

collaboration/attachments/receipts为受认证、会话/项目作用域内的只读RPC，返回camel白名单receiptId/name/projectId/requestId/archived及必要materialId/version/archiveAuthorized/pendingRestore。requestId用于原始选择组消歧，不能按最后一次transfer时间随便选。pendingRestore只由真实历史内容冲突产生，包含targetMaterialId/restoreVersion/expectedLatestVersion，并校验有效期、上下文、身份和最新版本。

attachment_receipts工具内部保持snake_case，另给当前请求authorized_attachments元数据，模型先查再传输，不从改写的人类正文取handle。正常可信操作通知位于session/update的update._meta.operationResult，update._meta.requestId必须匹配；外层_meta仍为序号。正常归档/去重/旧回执与待恢复确认区别展示，内部工具ID/JSON不作默认人类回复。部分失败error.data.operationResults也只能来自实际提交结果。客户端已发送失败仍以error结束，只有未调用业务prompt的本地澄清以stop结束。

analysis_begin仅只读准备，不登记正式分析；analysis_submit才持久化。默认草稿允许原权限约束的实际读取，禁止未授权正式提交。result_acceptance_open确实创建验收槽位，仍需原条件和明确意图；plan_confirm/result_review/result_accept本人决定入口不由模型新增代办路线。

## 数据兼容与回退限制

attachment_human_grants为不可变辅助许可记录，不改旧false manifest。attachment_restore_proposals保留提议及superseded/consumed状态；资料身份、既有版本和旧引用不重写。恢复可信证据是内部upload的独立第三参数，模型在普通工具参数里填restore_version或authorized不能取代它。

旧实现从数据结构上可忽略新增辅助表，但不保证保有新安全门禁，不代表已做生产迁移/回退验收。不得删除这些表、旧资料/版本或改旧回执来伪装回滚；版本切换、真实验收和部署另行批准。原PNG/JPEG/WebP范围、GIF拒绝、大小/路径/原件完整性限制不因自然语言放宽。

## 本人决定验证的准确边界

原本人决定的身份、项目、职责、资格复核与版本规则不改。六项QR回归直接运行经过真实QR principal、身份绑定和ProjectAccess包装的原工具execute层，另有实际Agent负控证明模型不能代批。它们验证的是既有内部本人执行鉴权层，不是MemberNode公网本人审批端到端。本候选未新增Node非LLM决定接口，也未进行新的真人审批验收。
