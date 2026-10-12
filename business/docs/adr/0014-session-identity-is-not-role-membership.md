# 会话身份与角色成员是两件事

> **目标接入方案补记：** 本 ADR 保留当前自我声明实现的历史依据；“会话身份与角色槽位归属分开”仍成立，但新接入原型从可信登录连接绑定账号，不再接受自我声明改变身份。它只在隔离会话 scope 中桥接现有业务校验，旧工具与数据迁移尚未执行。
> 见[成员接入原型](../../../README.md)及[验证边界](../../../docs/VERIFY.md)。本文“因为 clientInfo 未读取，所以只能自我声明”的广义推论不适用于已认证的自定义接入层。

## 背景

MVP-019 对"谁能确认方案"写得很清楚：

> 由**该角色的成员**以角色名提交**同意**或**有理由的拒绝**，记录结论、理由、**提交者快照**与时间。

但实现只检查了**一半**：槽位有没有人，没检查**说话的这个人是不是那个成员**。

```ts
// plan-service.ts（修复前）
const member = this.memberOf(latest.projectId, input.role)
if (member === null) { throw new VACANT_ROLE_CANNOT_CONFIRM() }   // ← 只问"槽位空不空"

const submittedBy = requireText(input.submittedBy, ...)           // ← 名字照单全收
```

**后果在真实使用中立刻出现。** 一次测试里，调用方让 Agent 登记了一份 22 个任务的方案、需要 9 个角色确认。Agent 因为**没被告知任何真实人名**，就**替 9 个角色各编了一个名字**填进槽位：

| 角色 | Agent 编的名字 |
| --- | --- |
| pm / product / design / scenemodel / sceneart | 陈静 / 林晓雯 / 苏芮 / 赵鹏 / 何雨萌 |
| data / backend / ue / frontend | 周浩 / 郑凯 / 孙铭泽 / 吴迪 |

**九个"成员"全是虚构的，而每个角色都各有一个看起来合法的确认槽位。** "由该角色的成员确认"这条需求，在实现上**等于没有** —— 只要有人愿意填名字，谁都能替任何角色同意。

## 根因：一个 `member_label` 承担了两个含义

库里当时只有**一个**成员概念：

```sql
CREATE TABLE project_roles (
  project_id   TEXT NOT NULL,
  role         TEXT NOT NULL,
  member_label TEXT,          -- 这到底是"谁在说话"还是"这个槽位归谁"？
  PRIMARY KEY (project_id, role)
);
```

它被同时用来回答两个**不同**的问题：

| 问题 | 例子 |
| --- | --- |
| **谁在说话？** | 现在是陈静在跟我交互 |
| **这个槽位归谁？** | pm 这个角色由陈静担任 |

**这两个答案可以不一致，而且必须允许不一致** —— 否则会出现循环：*"我声明我是 pm，于是我自动成了 pm 的成员"*，任何自封身份都会立刻合法化。

**词义混淆是缺陷的根源，不只是命名问题。**

## 决定一：拆成两个概念，各存一处

新增 `session_members`，**只回答"谁在说话"**：

```sql
CREATE TABLE session_members (
  session_id   TEXT PRIMARY KEY,
  member_label TEXT NOT NULL,
  declared_at  TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

`project_roles` **继续只回答"槽位归谁"**，语义不变，一列不改。

**判定合成一条：**

```
声明的成员 == 槽位的成员  →  允许
否则                      →  拒绝（NOT_ROLE_MEMBER）
未声明                    →  拒绝（MEMBER_NOT_DECLARED）
```

## 决定二：身份按会话声明一次，不逐次传

客户端身份**无法从 ACP 连接取得**。已查证 `dsh-acp/lib/index.js`：

```js
async newSession(params, signal) {
  validateWorkspaceParams(params);          // 只校验 cwd 是绝对路径
  record = await AcpSession.create(ctx, {
    sessionId,
    cwd: params.cwd,                        // ← 客户端唯一能传进来的业务信息
    mcpServers: params.mcpServers,
    ...
  });
}
```

ACP 协议确实有 `clientInfo`，**但 DSH 的生产代码一次都没读它**（该字段只出现在测试文件里）。所以"从连接里自动得知我是谁"**这条路当前走不通**，不是难，是协议层未暴露。

于是改为**在会话内显式声明一次**，存 `session_members`。会话 ID 取自 `exec.agent.session.id` —— 已验证可达：`ToolRunContext` → `agent` → `session` → 同步 `get id() { return this.header.id }`，且 DSH 自身有 43 处生产代码这样用。

**一个会话锁一个成员。** 想换身份就重新声明（留痕），或另开会话。

## 决定三：只校验"代表角色做决定"的三个操作

按角色做决定的操作有**三个**，必须校验：

| 工具 | 记的是什么 |
| --- | --- |
| `plan_confirm` | pm **同意**了方案 |
| `result_review` | 负责人**确认完成** |
| `result_accept` | 下游**接收**了成果 |

**`todo_mark_read` 不在此列**，理由是需求明文规定它按槽位记录，与"谁读的"无关：

> **MVP-030**：已读只表示看过，不代表同意、完成、接收或解决；已读**按角色槽位记录**。

且它**不改变任何业务状态**（ADR-0011 的全部要点），实现里 `read_by` 一直写 `null`。

**其余 8 个带 `submitted_by` 的工具（上传资料、提交分析、登记/修订方案、提交成果……）一律不校验。** 因为**九个角色完全平级**（ADR-0004）：任何角色都能上传资料、登记方案。给这些加校验等于**凭空造出一套权限**，而 MVP 明确不做权限。

## 决定四：`submitted_by` 参数保留为快照；判定只看**声明的身份**

第一版实现曾经写成"拿 `submitted_by` 去比对槽位成员"，**这是错的，并且是同一个洞的另一种写法**：

```ts
// 错：判定的输入来自调用方自己填的参数
const submittedBy = assertCanActAsRole({
  memberOfRole: this.memberOf(projectId, input.role),
  declaredMember: requireText(input.submittedBy, ...),   // ← 调用方填什么就是什么
})
```

`submitted_by` 是**调用方提供的字面量**。拿它当判定输入，等于让被检查者自己出考卷 —— 模型只要填上"陈静"就能通过。**漏洞没被堵上，只是从"不检查"变成了"检查一个自己填的值"。**

**现在的分工：**

| 值 | 来源 | 用途 |
| --- | --- | --- |
| `declaredMember` | **会话身份**（`session_members`） | **唯一的判定输入** |
| `submittedBy` | 工具参数 | **只做记录快照**（ADR-0010） |

服务层签名因此是**两个独立入参**：

```ts
assertCanActAsRole({
  role,
  memberOfRole: this.memberOf(projectId, role),
  declaredMember: input.declaredMember ?? null,   // ← 由工具层从会话注入
})
```

`declaredMember` **不是工具参数**，模型无法填写。工具层在 `register.ts` 里从 `exec.agent.session.id` 查出声明值注入：

```ts
const declaredMemberOf = (exec) => {
  const sessionId = sessionIdOf(exec)
  return sessionId === null ? null : services.identities.current(sessionId)
}
```

**`submitted_by` 参数保留**（删除会让"以某角色提交"无法表达，且改动面覆盖 12 个工具），但它**不再参与判定**。

**这条修正是本项目最值得记的一点**：一个"看起来在检查"的实现，如果检查的输入来自被检查方，它提供的**只是检查的样子**。

## 决定五：历史记录不追溯校验

新校验**只作用于新提交**。库中已有的确认记录**原样保留，不重新判定**。

理由是 ADR-0010 已经论证过的：**快照必须冗余存在记录上，正是为了让历史不随成员变更而变。** 如果反过来用"当前成员"去校验历史，那么**改一次成员名就会让过去的记录变成非法** —— 那是让改名篡改历史，恰是 ADR-0010 要防的事。

**同一个道理适用于 `submitted_by` 本身**：它是快照，不是外键。

## 排除的方案

**从 ACP 连接自动取得客户端身份。** DSH 不读 `clientInfo`，`session/new` 只接受 `cwd`。**当前协议层做不到**，不是实现选择。

**按"当前会话 = 一个成员"隐式推断。** 会话 ID 与人不相等：同一个人会开多个会话，一个会话也可能被换人使用。**把会话当作身份会制造一个虚假的对应关系。**

**给全部 12 个操作都加校验。** 会把"上传资料"这种**任何角色都能做**的事变成有门槛的事，与 ADR-0004"角色完全平级"直接冲突。

**把成员升级为独立实体表（`members` + 外键）。** 能防拼写不一致，但**改动面覆盖全部角色相关代码**，而收益只在"人多且名字易错"时才显现。**MVP 的规模下不值得**，留待真正需要时再做。

## 后果

- **"由该角色的成员提交"第一次真正成立。** 之前它只是文档里的一句话，实现上任何人都能替任何角色确认。
- **成员名字由人给出，不再由模型编造。** 未声明身份时，模型无法替任何角色做决定。

### 如何证明它生效（而不只是"写了代码"）

**只测"成员能提交"是无效的** —— 修复前的代码接受**所有人**，那种测试在修复前也照样通过。有效的测试必须断言**拒绝**：

| 断言 | 期望 |
| --- | --- |
| 未声明的会话提交 `plan_confirm` | `MEMBER_NOT_DECLARED` |
| 非成员提交 `plan_confirm` | `NOT_ROLE_MEMBER` |
| **声明为甲、却把 `submitted_by` 填成乙** | `NOT_ROLE_MEMBER` ← 堵住"自己给自己出考卷" |
| 非成员提交 `result_review` / `result_accept` | `NOT_ROLE_MEMBER` |
| 拒绝之后槽位与激活状态 | **未被写入**（拒绝不留痕） |

**变异验证（证明测试真的有约束力）：**

| 变异 | 结果 |
| --- | --- |
| 判定输入改回 `submittedBy` | **5 项中 1 项失败**（正是"未声明的会话不能提交"） |
| `memberOfRole !== declaredMember` 改为恒假（即取消身份比对） | **5 项失败** |

即：把"只查空槽位"的旧行为放回去，**测试会失败**。这是"这条需求真的被实现了"的证据。

- **声明只在一个会话内有效，关窗即失效。** 这是刻意的：身份跟着"谁在说话"走，不跟着机器走。代价是新会话要重新声明一次。
- **`session_members` 与会话生命周期绑定，但会话 ID 由 DSH 管理。** 插件不清理失效行 —— 这是**有意的取舍**：删掉它们不会让任何历史变得不可读（历史不带会话 ID），留着也无害。将来若要清理，判据是"该会话是否还存在于会话日志里"。
- **不再有"一个人扮演全部角色"的顺利路径。** 想单人推进，就声明自己一个成员、并让九个槽位都归自己（**一人兼多角色是允许的**，`project_roles` 主键是 (项目, 角色)，同一名字可占多个槽位）。**这不是绕过校验，而是把真实情况如实说出来。**
