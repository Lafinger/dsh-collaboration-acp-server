# 附件升级：保留当前项目和会话

客户端v0.3.0、服务器v0.4.1，DSH0.2.0-rc.2。正式发布/部署核验状态另记，不把本操作指南当完成证据。

## 禁止复用旧清空授权

本次用户明确保留现有CSAIR-DH-POC/COLLAB-RETEST-001、业务记录、服务器会话、客户端映射与凭据/keys/known_hosts。禁止reset、down -v、volume rm、删除客户端mapping SQLite；不要跟随历史CLIENT-REINSTALL清库或丢弃现有会话。

## 两台客户端

等正式新Release验证后，在两台DSH关闭客户端组件，正常重装固定来源：

```text
github:Lafinger/dsh-collaboration-client#v0.3.0
```

保留各自配置路径、databasePath内容、成员SSH私钥和known_hosts，不改Bob/Alice身份，不分享密钥目录。启用新组件后正常打开原本地会话，恢复原远端id；不要重试旧消息，不把恢复notice当新指令。选择collaboration-remote/协作服务/server-agent，不是本机Codego。

## Alice南航项目首轮附件

核对项目key=CSAIR-DH-POC、project_id=b723201e63b2441caa19c439b3a846b0。Alice当前本地会话工作区须是放该文件的项目目录，否则改用原生聊天附件，不开放工作区外文件。

```text
附件操作: 上传并归档
project_id: b723201e63b2441caa19c439b3a846b0
@"测试材料\项目需求\南航智慧出行数字人POC需求文档v1.3.docx"
请通过附件工具传输这个文件，检查sha256，读取正文和解析限制，
判断资料用途和所属角色（不确定归共享），登记到合适目录。
基于该固定资料版本分析明确需求、矛盾/待决问题、推断、未覆盖内容和所需角色。
注意文件名版本与正文版本可能不同，不修改原件，不擅自分配人员、确认方案或创建任务。
```

如用聊天附件，保留前两行，删除路径行即可。已确认真实文档可由当前Codego处理，但本工具升级验收不自动提交真实文件、不替用户发模型请求。

验收看receipt_id、name/bytes/sha256、material_id/version、purpose/role/classification reason、stored_at受限目录、正文和图片/修订缺口。原件预期sha256 `b69f1d4932d313de8bec8a49285b9a1a3cfee28ffb10ff9a79e1bcf819ea57ae`；新正式资料版本1不等于文件名v1.3或正文V1.0。

服务端正文解析无需LinuxPython/LibreOffice；图片嵌入未视觉分析，首版无vision/OCR工具。不看图不代表可忽略图片/形象证据，必须列为未覆盖。

## Bob只读核验

在Bob原会话明确查询CSAIR-DH-POC资料列表，按Alice返回material_id/version读取固定版本，确认sha256/正文/解析限制。Bob不能读取Alice未归档的私有接收回执，但正式项目资料继续按既有共享模型可读；不创建/修改成员/计划/任务。

## Docker保留升级

固定GitHub新tag/commit与frozen lock构建新镜像，先隔离验证native image parser/工具链与新包，再正常停旧容器，无卷删除。`verify-preserved-data save/compare`只保存opaque hash/计数，不复制业务数据库/文档/凭据，升级后核对既有业务表、access、模型会话文件与身份完全一致（新增附件表允许）。启动原服务URL/SSH地址，不开替代Web服务器。
