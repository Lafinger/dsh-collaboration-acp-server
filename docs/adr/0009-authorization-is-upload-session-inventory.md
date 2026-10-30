# 附件授权即上传：会话级清单 + 单一 handle + 两个工具

状态：已接受并实现于 0.7.2（协议 `collaboration 4` / `attachmentTransfer 2` / `humanAuthorization 3`，硬配对，无兼容层）。取代 ADR-0002 中"按消息授权、receipt 与 handle 双标识"的部分。

rc.6 时代的附件链路把一次上传拆成五步（receipts → transfer → inspect → archive），模型要在两种不可互换的哈希之间自己接力，任何一步漏掉都会得到一条不指明下一步的错误；同时客户端意图门会按正则把整轮拦死在本地，授权又是按轮失效的。卡死会话的证据显示：模型全程只做了只读调用，却声称"缺少工具"。

现在的模型只有两个动作：`attachment_read(handle)` 读全文（图片返回有界副本），`attachment_archive(handle,{purpose,role?})` 归档为当前项目资料版本。成员随消息明确选定的文件在 prompt 入口就由服务端拉取字节、校验 sha256 并入库（`session_attachments`），**上传即授权**：授权 = 字节已在服务端且归属 (account, session)，按会话持续有效，不再有按轮 grant，也不再有 `archiveAuthorized` 字段。每条人类消息注入会话附件清单（name + handle），模型从消息里拿到 handle，不需要任何查询类前置工具。

被拒绝的替代方案：保留 receipts/transfer/inspect 但修错误提示 —— 治标，五步链的任何简化都仍要求模型维护两种标识符的映射；客户端本地澄清 —— 已被证明是卡死根源，删除（服务端仅保留 `currentHumanInstruction` 文本清洗，因为业务写短语边界依赖它）。代价：协议硬断（新旧客户端/服务端互拒），且重复上传相同内容不再产生新版本（去重），历史版本冲突作为普通工具错误如实返回。
