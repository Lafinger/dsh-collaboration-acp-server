# 0.7.2-rc.7 发行说明：附件链路重构（协作v4／附件v2／人类授权v3）

> 版本号：包版本 `0.7.2-rc.6` → `0.7.2-rc.7`；不发布 npm／插件市场，`private: true` 不变。设计依据：`.dsh/redesign-attachment-spec-20261029.md`（权威），决定记录：[ADR-0009](<adr/0009-authorization-is-upload-session-inventory.md>)。

## 为什么重构（证据基线）

卡死会话 `66561a4d…`（位于 `/srv/dsh-collaboration-test/dsh-home/sessions/--srv-dsh-collaboration-test-workspace--/`）的逐条证据显示三类失败叠加：

1. **客户端意图门把轮次拦死在本地**：`human-intent.mjs:69/70/81` 与 `human-admission.mjs:124` 的罐头话术在模型收到任何字节之前就终止了轮次。
2. **工具面太绕**：handle/receipt 双标识 + 5 个工具 + 长告诫描述，模型在 `attachment_receipts`→`attachment_transfer`→`attachment_inspect` 接力中迷失，声称"缺少工具"（实际只做过只读调用）。
3. **授权按轮失效**：`active` Map 随轮清空，跨轮引用历史附件必然失败。

对照组：更早的会话 `4f115b60…` 走通了完整链路，说明问题不在字节通道，而在协议形状。

## 改了什么

- **上传即授权**：成员随消息明确选定的文件在 prompt 入口由服务端拉取字节（48KiB 分块，sha256 校验）入库 `session_attachments`；授权 = 字节已在服务端且归属 (账号, 会话)，按会话持续有效。删除按轮 grant、`archiveAuthorized`、restore 确认流程。
- **工具只剩两个**：`attachment_read(handle)`（文本内联 256KiB 上限／图片有界副本／未解析返回缺口）与 `attachment_archive(handle,{purpose,role?})`（归档到会话绑定项目，去重，历史版本冲突如实报错）。删除 `attachment_receipts`/`attachment_transfer`/`attachment_inspect`。
- **每条人类消息注入会话附件清单**（name + handle），模型不再需要查询类前置工具；跨轮读同一 handle 直接可用。
- **客户端拆除意图门**：删除 `human-intent.mjs` 与澄清分支；附件轮次要求菜单选定项目（唯一绑定来源），未绑定项目零字节失败；文本轮次原样转发。
- **协议硬配对**：协作4／附件2／人类授权3，旧配对在协商或 prompt 校验处失败，无兼容层。`humanAuthorization` 元数据只剩 `{version,messageId,textSha256,projectId}`。
- **业务写短语边界不变**：`currentHumanInstruction`（文本清洗）保留，`analysis_submit`/`plan_register` 等仍需当前消息明确短语授权；`plan_confirm`/`result_review`/`result_accept` 仍对模型不可见。
- **数据不迁移**：旧表 `attachment_receipts`/`attachment_human_grants`/`attachment_restore_proposals` 原样保留，新代码不读写；新增 `session_attachments`。

## 验证证据（全部离线、合成内容，未调用真实模型）

- 服务端：`node --test test/*.test.mjs` 248 项 245 过 0 败（2 skipped）；`test/*.integration.mjs` 78/78；`node scripts/check.mjs` 退出码 0。
- 客户端：`node scripts/check.mjs` 退出码 0（单元 142、集成 63、审计、命名、构建全过）。
- 双端联合（`test/joint/client-server.joint.mjs`，3/3）：真实客户端捕获路径 + 真实服务端运行时，用卡死会话原话验收——第一轮 `@需求文档…分析、上传、归档、并生成正式计划` 完成读取+归档（材料第1版落库），模型自作主张 `plan_register` 被守卫拒绝并给出可照抄短语；第二轮无新清单，模型从会话清单读到同一 handle、相同字节去重不新增版本，`请提交方案` 短语授权后计划登记成功。
- 视觉链路：图片经 `attachment_read` 返回宿主有界副本并持久化，resume 后不重拉客户端字节。

## 过程诚实记录

- 本轮三次委派子代理均未完整交付：两次探查（f49a0321/fbd1946a）由我在其汇报前主动停止并自行重取证据；一次服务端实现（e0bd03f5）无任何输出即崩溃、工作区干净，全部实现由主会话直接重做。后续关键路径一律主会话直做。
- 客户端实现由子代理 487e3ce7 完整交付并双端联测通过；其四项语义判断中两项在联测中被修正：①文本轮次在 v3 下也必须携带人类授权元数据（服务端按连接协商强制）；②无登录会话 `session/new` 携带菜单选定项目，使服务端会话范围与 v3 元数据指向同一项目。`attachment-protocol.mjs` 以服务端（要求每项 manifest 带 projectId）为准双端同步。
- 联测中发现的实现缺口当场修复：模型上下文缺少附件清单注入（工具描述引用了并不存在的"消息绑定清单"）——已在 `dsh-runtime.prompt` 注入，并有测试锚定。

## 部署注意

- 服务端与客户端必须同批发布：旧客户端对新服务端在 `initialize` 即失败（-32011/-32012），反之亦然；不存在灰度混跑。
- 服务端发版不迁移数据、不清空身份；发版后旧会话中的历史附件（v3 receipt）不可被新链路读取，需要成员重新上传一次（与 rc.6 说明一致，不回填）。
- 客户端安装仍仅支持 `github:Lafinger/dsh-collaboration-client#v<版本>` 形式。
