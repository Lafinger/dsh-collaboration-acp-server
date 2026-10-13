# 附件实现审查记录（部署待验收）

v0.4.0已正式发布但实际POC Word本地兼容检查发现空目录ZIP标记含反斜杠，被过严校验拒绝；不是正文路径逃逸。v0.4.1窄修复允许安全空目录标记并忽略，不放开反斜杠文件/..绝对路径/宏。模拟最小回归先红后绿，实际文档本地提取11996UTF-8bytes/1图片存在，原件hash不变；没有上传或模型请求。v0.4.0不可变标签与附件不覆盖。

当前机制：官方llm/stream waterfall在file placeholder投影前捕获当前人类附件引用；显式单文件路径在当前本地会话cwd内。用单独 `附件操作: 上传并归档` / `仅传输` 和唯一 `project_id` 解析权限，不搜索“上传”等词语猜授权。

附件扩展1附着基础v2，connector唯一新增反向attachment/read；句柄绑定account/session/request，断线只恢复记录。收到回执持久化到业务库附加表；原件在私有附件目录。回执归档与解析记录在MaterialService同一transaction/文件回滚范围写入，不使用外层transaction导致孤立原件。固定解析版本/hash再校验原件与正文hash，目标项目来自人类元数据不是模型参数。

新资料模型classification.role可以选固定角色/shared，已有同名同purpose资料仍保持首次role；发现旧实现role参数可能使新版本落到另一role目录，已纠正并加回归。资料角色不代表人类成员。附件turn新增工具guard，仅传输、inspect、archive、只读查询与analysis允许；成员分配/plan/write工具结构拒绝，而不是仅靠提示词。

DOCX使用Node原生inflateRawSync maxOutputLength，先校验central directory条目/size/数量/CRC与本地header一致，不依赖声明uncompressed size可被篡改的unzip全量预分配；XML拒绝DTD/entities并限制element/depth。fast-xml-parser固定5.11.1、sharp0.35.5；fflate仅dev fixture生成测试ZIP。图片首帧校验、原件接收hash、未视觉分析标记，明确无vision/OCR工具。

所有回归使用non-sensitive sample。真实Word不进入git、不作为自动模型测试输入；GitHub发行和Docker部署完成前不让用户用现行版本尝试附件。

本地最新PASS：客户端31单元/8宿主集成，服务端282业务/35单元/13宿主集成，双仓joint4项（多块原生/path附件、版本与同id恢复无重放）。两个抽取发行包安全导入PASS（客户端24文件、服务端180文件）。

正式发布/双平台CI/下载hash/独立installer、生产Linux固定GitHub包native sharp和隔离工具fixture、现有volume业务/会话/凭据hash完全一致核对已通过；Docker v0.4.1 healthy/Restarts0，保留2项目/3远端会话/9请求/6session文件。实际GUI附件/真实模型由用户后续Alice操作，未代替执行；见[本次发行证据](<ATTACHMENT-RELEASE-VERIFY.md>)。
