# v0.4.2项目背景／目标编辑升级

状态：正式v0.4.2发行及Docker保留部署核验PASS，见[发行证据](<../../docs/PROJECT-DETAILS-RELEASE-VERIFY.md>)。客户端v0.3.0和协议基础v2／附件扩展1不变，不需要重装客户端、重新上传或重建项目。

## 本次授权边界

只新增`project_update_details`能力，不替用户调用新工具，不把Alice旧草稿写入CSAIR-DH-POC。不修改成员或模型配置，不换Codego，不执行付费模型回归。实际字段填写必须由用户在新消息逐项明确确认。

现有数据已经非空：项目角色／资料／分析／会话为用户当前事实，必须全部保留。旧reset授权不适用，禁止reset/down -v/volume rm/删除客户端mapping。

## 部署流程

1. 正式main双平台CI通过后创建不可变v0.4.2标签，tag CI公开三附件，下载核验SHA256和release.json commit。
2. isolated fixed GitHub install及官方DSH installer核验，不碰desktop/acp profile。
3. Docker lock固定正式tag/commit，用frozen lock/ignore-scripts构建；隔离容器无network／无生产volume执行`verify-project-details-fixture`与既有attachmentfixture，验证官方工具参数和native依赖。
4. 核对专用volume身份与没有running请求，再正常停服，离线`verify-preserved-data save project-details`记录opaque hash/计数（不是库／文档／密钥备份）。
5. 启动原container和volume，再`compare project-details`。本次全部业务表（含attachment_receipts/material_extractions）、全部access、host会话、原件资料／私有附件、Codego模型计数、凭据／SSH身份完全一致。
6. 真实SSH只initialize/whoami/history，无session/new/prompt；验证客户端0.3.0兼容新server0.4.2。

## 客户端后续

保持原配置／mapping／key／known_hosts。服务器短暂停服期间不要发送业务消息；正常恢复原会话。新工具只注册于认证协作Agent，不新增普通本地工具。

用户确认文本后按[编辑用法与模板](<../../docs/PROJECT-DETAILS.md>)发送新指令，不点旧失败消息重试。未提供字段保持当前值，空白／null拒绝，无清空能力；未确认历史日期不得自动写成当前承诺。
