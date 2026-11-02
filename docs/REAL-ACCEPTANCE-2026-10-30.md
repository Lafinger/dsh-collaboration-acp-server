# 真人业务验收记录：附件链路 v4（2026-10-30）

验收对象：服务端 `0.7.2-rc.7`（`7ba9bbd`）＋客户端 `0.6.3-rc.6`（`cc2f2b1`）。

环境：真实 DSH GUI、生产配置的真实模型路由（CPA `openai-responses` + `deepseek-v4.1-flash`）；生产 discovery 返回 `protocolVersion: 4`。客户端安装串 `github:Lafinger/dsh-collaboration-client#v0.6.3-rc.6`。

证据来源：用户本人在 GUI 中执行并回传的两轮实际输出。本轮未由 Agent 读取服务端日志（用户选择先自行验收），因此本记录只包含客户端可见的结构化返回，不包含服务端日志摘录。

## 判据与结果

| 判据 | 实测 | 结果 |
|---|---|---|
| 第一轮模型不需要查询类前置工具，直接从消息附件清单取 handle | 直接调用 `attachment_read`，随后调用 `attachment_archive` | 通过 |
| 第一轮归档为材料第 1 版 | `version: 1`，`deduplicated: false` | 通过 |
| 第二轮不发新附件，仍能拿到同一 handle | 同一 handle、同一 sha256 | 通过 |
| 第二轮相同内容不新增版本 | `deduplicated: true`，`latest_version: 1`，版本列表仅 v1 | 通过 |
| 归档回话可读 | 第一轮「《南航数字人POC-双人协作测试需求-v2.md》已归档为第1版。」；第二轮「《南航数字人POC-双人协作测试需求-v2.md》内容未变，沿用第1版。」 | 通过 |

## 第一轮：读取并归档

输入：`@<真实文件> 读取内容并归档`，文件为 `南航数字人POC-双人协作测试需求-v2.md`。

`attachment_read` 返回：文件名 `南航数字人POC-双人协作测试需求-v2.md`，25,430 字节，sha256 `2012f9ea59b91fb8ff6f2869b777c176f0d64a1f045967d6271795803f15329e`，`kind: text`，全文已返回，无解析告警。

`attachment_archive` 返回：`material_id 462d52f601d8432383f74a5a2cd18096`，`version 1`，用途 `PAIR-NH-01 需求基线`，`attachment_id f7b0dfd9699fa8a7451fd26d4bdd443a32b332a3d8e87b1bb96e4408ac6139d2`，`deduplicated: false`。

模型随后用 `material_read` v1 回读核对：版本可读，`unreadable_reason` 为空，`parser_warnings` 为空，存储 sha256 与上传时一致。

## 第二轮：不新增附件，再次归档

输入：`把刚才那份文件再归档一次`。

`attachment_read` 返回同一 handle、同一文件名、25,430 字节、同一 sha256。

`attachment_archive` 返回同一 `material_id`、`version 1`、`deduplicated: true`、同一 `attachment_id`。

`material_versions` 显示 `latest_version` 仍为 1，版本列表只有 `v1__南航数字人POC-双人协作测试需求-v2.md`。

## 结论

- v4 的核心假设成立：模型在没有查询类前置工具的情况下，从每条人类消息注入的 `[会话附件清单]` 中直接取得 handle；跨轮引用同一 handle 可用。
- 同内容重复归档按设计去重，不新增版本。
- 交接文档中「唯一未完成的是真人业务验收」一项至此完成；附件链路 v4 验收通过。

## 发现（不影响本次通过）

`attachment_archive` 的工具描述写着 "archiving again creates another version"，未说明内容完全相同会去重。本次模型按结构化返回如实回答了 `deduplicated: true`，没有误报版本号；建议下次服务端改动时把描述改为「内容不同才新增版本，内容相同去重」。

## 边界

本次只执行了读取与归档；没有提交分析、登记方案、创建任务，也没有做方案确认、成果评审或接收。文件正文被当作资料内容，不作为操作指令。
