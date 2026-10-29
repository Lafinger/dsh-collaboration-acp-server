# 0.7.2-rc.6 候选：自然语言上传资料不再卡在 handle／receipt 混淆与意图漏判

## 候选状态与授权边界

本文件描述**拟议预发布候选**。本轮授权为：创建修复分支、提交推送、运行草稿 PR 的双平台 CI 与打包。合并 main、创建 tag／Release、部署服务器均需用户单独明确授权。

- 分支 `fix/attachment-handle-receipt-guidance-20261029`，从 `d7e50f0`（已部署的 0.7.2-rc.5）继续。
- 包版本 `0.7.2-rc.5` → `0.7.2-rc.6`；不发布 npm／插件市场，`private: true` 不变。
- 保留业务数据、成员身份、设备登录、会话历史与未知请求，不回滚数据库、不重放旧请求。

## 修复的问题

**症状**：用户把文件拖进会话后用自然语言说「上传归档为项目资料」「上传并归档」「归档为项目资料」，助手不处理附件，只回「还没有处理附件。你希望我先阅读分析，还是归档为项目资料？」；即使重发也不前进。

线上会话日志显示这是**三个独立缺陷叠加**，此前只被当成一个现象。

### 缺陷一：把 handle 当成 receipt_id（真正的阻塞点）

`attachment_receipts` 一次返回两组语义不同的值：

```json
{"receipts": [], "authorized_attachments": [{"handle": "8584512f…"}]}
```

模型没有猜 id（`receipts` 为空它看到了），而是把 `authorized_attachments[0].handle` 直接传给了 `attachment_inspect(receipt_id: …)`。两者是不同的哈希：

```
handle       : 8584512fdc4422ad855aeba2838810d258f3b9128bd7b5d7150080962271cfa5
real receipt : 92e7bb15be68db68564122143d6f01215f9863a236069e7b0727917e4a263039
```

数据库没有这个 receipt，于是抛 `-32013 Attachment receipt is not owned by this account/session`。**该错误只说"不属于此账号／会话"，没有指出"少了一步 attachment_transfer"**，于是模型用同一个值重复调用 `attachment_inspect` 达 9 次。

### 缺陷二：归档表述被漏判为无意图

`classifyHumanIntent` 的 `requested()` 要求动词紧贴子句开头，因此以「上传」开头的归档命令全部落空：

| 输入 | 修复前 | 修复后 |
| --- | --- | --- |
| 上传归档为项目资料 | clarify/missing-intent | archive |
| 上传并归档 | clarify/missing-intent | archive |
| 归档为项目资料 | clarify/missing-intent | archive |

### 缺陷三：受影响的会话在服务端没有 receipt

只读核对：目标会话在 `attachment_receipts` 中 0 条记录，全库仅 5 条且都属其他会话。**因此本次修复只保证此后上传能走通，不会凭空产生已经丢失的 receipt；该会话需重新上传一次。**

## 修复方式

1. **`src/attachment-service.mjs`** — `receipt()` 在数据库查不到时，若该 id 恰好等于本轮 `active.manifests` 里的某个 handle，抛出可自纠的错误：

   > 这是附件 handle，不是 receipt_id：请先调用 attachment_transfer（handle 原样传入）传输并校验，再用返回的 receipt_id 调用 attachment_inspect。

   无法匹配的任意 id 仍沿用原来的保守错误 `Attachment receipt is not owned by this account/session`。

2. **`src/attachment-service.mjs`** — `list()` 增加 `next_step` 字段，直接说明下一步：有待传输 handle 时提示先 `attachment_transfer`，已有 receipt 时提示可直接 `attachment_inspect`，都没有时说明无待处理附件。

3. **`src/attachment-tools.mjs`** — 三个工具描述分别澄清：`attachment_transfer` 说明必须先传 handle 再取 receipt_id；`attachment_receipts` 说明 handle 与 receipt_id 是不同值、永不互换；`attachment_inspect` 说明只接受 `attachment_transfer` 返回的 receipt_id。

4. **`src/human-intent.mjs`** — 归档识别新增两类表述：`上传` 前缀 + 归档动词 + 真实目标（项目资料／资料库／资料／项目里／本项目／当前项目），以及裸「上传并归档」「上传归档」。

### 刻意保留的边界

放宽只针对归档动词，不改变安全模型：

| 输入 | 结果 | 原因 |
| --- | --- | --- |
| 上传归档为项目资料 / 上传并归档 / 归档为项目资料 | archive | 含明确归档动词与目标 |
| 归档这份文件 / 归档该文档 / 把这份资料归档到项目里 | archive | 原有规则保持 |
| 上传 / 上传这份文件 / 重新上传 | clarify | **上传单独只是传输，不构成归档授权** |
| 归档指南 / 归档说明 / 归档规则 / 归档流程 | clarify | 说明性名词是文档标题，不是命令 |
| 只阅读，不要上传并归档 | clarify | 否定词仍然生效 |
| 不要把这份文件归档，也不要上传 | clarify | 否定词仍然生效 |
| 这个应该如何归档？ / 归档是怎么回事 | clarify | 疑问句不构成指令 |

> 第一版实现曾把「归档指南」误判为归档命令，客户端既有测试当场捕获；收紧后要求归档动词后必须跟真实目标或宾语，并禁止说明性名词。

## 测试

- `test/attachments.test.mjs` 新增：`handle` 当 `receipt_id` 使用时返回可操作指引而非不透明归属错误；transfer 后 handle 仍不等于 receipt_id 且可正常 inspect；从未授权的任意 id 保留原错误。
- `test/human-intent.test.mjs` 新增：7 种归档表述全部判为 archive；`上传`／`上传这份文件`／`重新上传` 仍判 clarify；两类否定表述仍拒绝。

## 验证

- `test/attachments.test.mjs`：6/6 通过
- `test/human-intent.test.mjs`：6/6 通过
- 本地全量门禁 `pnpm run check`（把捆绑 Python 置于 PATH 前部以规避 Windows 上 Microsoft Store 存根 `python` 造成的 `member-zerotier` 假失败）：**exit 0** —— 295/295、272（269 通过 + 3 跳过）、78/78、11（9 通过 + 2 跳过），`fail 0`

## 部署与配套

- 服务端：合并并以 `v0.7.2-rc.6` 发布后，按既有 `deploy/ubuntu` 流程装新 release 目录并切换。
- **客户端同步修复**：`dsh-collaboration-client` 内含同源 `src/human-intent.mjs` 副本，由 `human-admission.mjs` 调用，同样的意图缺陷与同样的修法；客户端需单独发版，由用户手动安装。仅修服务端不会让用户看到的现象消失。

## 残留风险

- 本次只扩大归档动词的识别范围，未改变 handle／receipt 的所有权校验、项目归属校验、`archiveAuthorized` 判定等既有规则。
- 已丢失 receipt 的历史会话不会被修复，必须重新上传原始文件。
- `next_step` 是面向模型的提示字段，不构成任何授权，也不改变 `receipts`／`authorized_attachments` 的既有语义。
