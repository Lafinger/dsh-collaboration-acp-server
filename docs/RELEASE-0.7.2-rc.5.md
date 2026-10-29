# 0.7.2-rc.5 候选：已选项目的会话不再被追问「所属项目」

## 候选状态与授权边界

本文件描述**拟议预发布候选**。本轮授权为：创建修复分支、提交推送、运行草稿 PR 的双平台 CI 与打包。合并 main、创建 tag／Release、部署服务器均需用户单独明确授权。

- 分支 `fix/generic-project-reference-clarify-20261029`，从 `253a22d`（已部署的 0.7.2-rc.4）继续。
- 包版本 `0.7.2-rc.4` → `0.7.2-rc.5`；不发布 npm／插件市场，`private: true` 不变。
- 保留业务数据、成员身份、设备登录、会话历史与未知请求，不回滚数据库、不重放旧请求。

## 修复的问题

**症状**：用户在**已经选定项目**的会话里发「这是整个项目的需求文档，你需要分析并上传。」，助手不处理附件，而是反覆回「请确认这份资料所属的项目名称，不会按相似名字自动归档。」，无论重发多少次都不前进。

**根因**：`src/human-intent.mjs` 的 `resolveHumanProject` 用

```js
const stated = instruction.match(/这是\s*(.{1,100}?)\s*的(?:需求文档|需求|项目资料|资料|文档)/u)?.[1]?.trim();
if (stated && !matches.some(row => [row.name, row.key].includes(stated))) return clarify('unresolved-stated-project', ...);
```

把「这是**整个项目**的需求文档」中的「整个项目」当作用户指名的项目名，再拿它去和受信项目名／键比对。它不可能等于任何真实项目名，于是必然进入 `unresolved-stated-project` 澄清分支。**这是解析层的问题，与会话归属无关。**

**实证**（线上只读核对）：`access.sqlite` 的 `access_sessions` 共 15 行，`project_id` **全部已绑定、无一条为 NULL**，说明会话确实已选定项目；而同期该澄清确实触发，因此失败点只能落在解析层。

```
captured stated = "整个项目"
resolveHumanProject(...) -> {kind:"clarify", reason:"unresolved-stated-project"}
```

## 修复方式

泛指当前项目的说法（整个／本／这个／那个／该／此／当前／目前／本次／这次／我们／咱们 + 项目，以及裸「项目」）视为**指代已绑定项目**，而不是新指名的项目，因此不再触发澄清。

同时严格保留原有的保守边界，避免"放宽"变成"随便挑一个项目"：

| 输入 | 结果 |
| --- | --- |
| 这是整个项目／本项目／这个项目／该项目／此项目／当前项目／本次项目的需求文档… | 解析到当前绑定项目 |
| 这是项目的需求文档…（裸「项目」） | 解析到当前绑定项目 |
| 这是南航智慧出行数字人POC2的需求文档…（精确名） | 解析到该项目 |
| 这是NHMHPOC02的需求文档…（精确键） | 解析到该项目 |
| 这是南航数字人POC的需求文档…（真实近似名，不匹配） | 仍澄清 `unresolved-stated-project` |
| 这是财务系统的需求文档…（无关名） | 仍澄清 `unresolved-stated-project` |
| 这是另一个真实项目的需求文档…（另一个真实可见项目） | 仍澄清 `bound-project-conflict` |

## 测试

新增 `test/human-intent.test.mjs`（此前该模块只有依赖外部客户端仓库的 joint 测试覆盖，缺少独立单元回归）：

- 泛指说法 8 种全部解析到绑定项目；
- 泛指说法经 `interpretAttachmentRequest` 全链路仍产出 `kind:"read"`、`archiveAuthorized:false`、`projectId` 为当前项目；
- 真实近似名与无关名仍澄清；
- 精确名与精确键仍解析；
- 指名另一个真实项目仍拒绝抢占当前会话。

## 验证

- `test/human-intent.test.mjs`：5/5 通过
- 本地全量门禁 `pnpm run check`（把捆绑 Python 置于 PATH 前部以规避 Windows 上 Microsoft Store 存根 `python` 造成的 `member-zerotier` 假失败）：**exit 0** —— 295/295、270（267 通过 + 3 跳过）、78/78、11（9 通过 + 2 跳过），`fail 0`

## 部署与配套

- 服务端：合并并以 `v0.7.2-rc.5` 发布后，按既有 `deploy/ubuntu` 流程装新 release 目录并切换。
- **客户端同步修复**：`dsh-collaboration-client` 内含同源 `src/human-intent.mjs` 副本，由 `human-admission.mjs` 调用，同样的缺陷与同样的修法；客户端需单独发版，由用户手动安装。仅修服务端不会让用户看到的现象消失。

## 残留风险

- 本次只扩大"泛指词"的识别范围，未改变精确名／键匹配、跨项目冲突拒绝、目的项目校验等既有规则。
- 「这是X的需求文档」中若 X 恰好是一个泛指词同时又是真实项目名，将按泛指处理（当前项目中无此情形）。
