# 把工作台搬到服务器：ACP 独立运行时方案

> **历史调查稿，不是当前目标部署方案。** 下文“每成员一个 DSH 进程”和“会话自我声明身份”的方案已被后续确认的“单 DSH 运行时、多成员独立会话、SSH 登录账号可信绑定”替代。文中对 stdio、配置传输与身份的部分否定结论也已被后续核查收窄；保留正文供追溯，不应据此部署。
> 当前隔离原型及验收边界见[成员接入原型说明](../../../README.md)与[验证记录](../../../docs/VERIFY.md)。真实 SSH 和现用 GUI 尚未验收。

> 目标：把"仓库管理和项目分析推进 Agent"从桌面应用内部搬到**独立运行的进程**，
> 让多个项目成员各自用客户端接入**同一个仓库**。
>
> 现状：Agent 是「模型 + 插件 + DSH 宿主进程」三者合起来的行为，跑在桌面应用进程内，
> 因此无法单独重启。本文只写**已核实**的事实，推断处标「推断」。

## 一、ACP 的边界

核实自 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-acp`（v0.1.5-rc.2）。包描述原文：

> **Automation-only Agent Client Protocol server** for driving DeepSeek Harness agents over **JSON-RPC stdio**

| 项 | 事实 |
| --- | --- |
| 传输 | **stdio**（`ndJsonStream(process.stdout, process.stdin)`） |
| 方法 | `initialize` / `authenticate` / `session.new` / `session.list` / `session.resume` / `session.close` / `session.setConfigOption` / `session.prompt` / `session.cancel`（通知） |
| `sessionId` | **服务端生成**的随机 UUID —— 不承载身份含义；`session.resume` 复用它 |
| 客户端可传 | **只有 `cwd` 和 `mcpServers`**（`additionalDirectories` 被明确拒绝） |
| 客户端身份 | **拿不到** —— `clientInfo` / `clientCapabilities` 在生产代码中**零次出现** |
| 认证 | **无** —— `authMethods: []`，`authenticate()` 直接返回 `{}` |
| 断线恢复 | **支持** —— `session.list` 列出可恢复会话，`session.resume` 用**同一 sessionId** 重连（要求 `cwd` 与持久化记录一致） |
| 自定义传输 | `config.stream` 存在，但**不在 Config schema 里**（只有 `provider`/`model`/`sessionListPageSize`），只有测试能注入 —— **没有任何网络监听原语** |

三条结论：

1. **"身份由客户端自带"走不通** —— 不是难，是 DSH 从不读 `clientInfo`（该字段只出现在测试文件里）。
2. **`sessionId` 不承载身份** —— 这反而是好消息，见第三节。
3. **没有网络层** —— 客户端只能 **spawn 进程**、用 stdio 说话（本机直接 spawn，跨机走 SSH）。详见第六节。

## 二、这是**多进程**，不是一个进程多会话

`config.stream` 看起来像"换成共享 socket、一个进程服务多个客户端"，**但它不是**（注释写明是给测试用的）。
**stdio 的本质决定：一个客户端 = 一个进程。**

```
成员 A ──spawn──> dsh --profile acp (进程1) ─┐
成员 B ──spawn──> dsh --profile acp (进程2) ─┼─> 同一个 collaboration.sqlite
成员 C ──spawn──> dsh --profile acp (进程3) ─┘
```

**并发问题因此永远是 SQLite 的多进程并发**，与进程内怎么设计无关。

> 「推断」进程内确实支持多会话（`sessions` 是 `Map<sessionId, record>`），
> 但 stdio 下每个客户端各起一个进程，这条能力在实际部署里用不上。

## 三、`cwd` 是隔离轴，不是身份轴

客户端唯一能影响服务端的业务输入就是 `cwd`，而插件的存储路径**相对于 cwd**：
`databasePath` 默认 `.dsh/collaboration.sqlite`、`fileRoot` 默认 `.dsh/collaboration-files`，两者都 `resolve` 成绝对路径。

**所以按 cwd 给人分目录是错的**：每人得到**自己的库**，那是几个互不相干的仓库，不是共享仓库 —— 张三传的资料李四看不见。

正确做法是**所有人 cwd 相同**，身份靠会话声明：

```
/srv/collaboration/            <-- 所有成员的客户端都用这个 cwd
  collaboration.sqlite         <-- 唯一的仓库（N 个进程都指向它）
  collaboration-files/         <-- 唯一的资料根
```

身份不靠 cwd，也不靠连接推断，靠**人在会话里说出来**（`session_declare_member`）。
ADR-0014 当初"身份按会话声明"的论证正是为此：每个进程有自己的 `agent.session.id`，`session_members` 表以它为键。

## 四、插件已经为多进程写好了

| 保障 | 位置 | 作用 |
| --- | --- | --- |
| `journal_mode = WAL` | `connection.ts` | 读不阻塞写 |
| `busy_timeout = 5000` | `connection.ts` | 拿不到锁时等待，而非立刻失败 |
| `foreign_keys = ON` | `connection.ts` | 级联是真约束 |
| **`BEGIN IMMEDIATE`** | `schema.ts` `inTransaction` | 写锁在事务开始时就拿 |

最后一条尤其重要：默认的 deferred 事务下，两个进程各自先读、再想写，会互相等对方释放锁 —— 多进程 SQLite 的经典死锁。

## 五、真实缺口：SQLITE_BUSY 没有重试

`isBusy()` 在 `src/sqlite/errors.ts` 有定义，但**全项目只在测试里引用**。生产代码的 `inTransaction` 对 `SQLITE_BUSY` **没有任何重试**：

```ts
db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE')   // ← 拿不到锁就抛
```

**后果**：三人同时操作时，第 5 秒仍未拿到写锁的那位收到**原始 SQLite 错误**，而不是"请稍后重试"。
`busy_timeout = 5000` 是唯一缓冲。桌面单用户永远碰不到（没有竞争）。

**建议**：对 `isBusy` 做有限次退避重试（如 3 次）。小改动，但是"多人能同时用"与"时不时报错"的分界线。
⚠️ 属新增行为，**应先有失败测试**（先证明会 BUSY，再证明重试解决它）。

## 六、落地形态

每个成员一个进程，profile 用 `acp`。已核实：

| 项 | 状态 |
| --- | --- |
| `dsh-acp` / `dsh-acp-app` | ✓ 已安装（0.1.5-rc.2） |
| acp profile 组合（`--dump-config`） | ✓ 含 `dsh-base` + `dsh-acp-app` + `dsh-tools` + `dsh-agent` |
| **工作台插件已注册？** | ✗ **未注册** |

```powershell
dsh plugin --profile acp add link:C:/Users/cjh13/Desktop/项目管理工作台/dsh-project-workbench
```

### 客户端怎么连上

ACP **只走 stdio，服务端没有任何网络监听**，所以客户端必须**自己把进程拉起来**：

| 场景 | 客户端做什么 |
| --- | --- |
| 同机 | 直接 `spawn dsh --profile acp` |
| 跨机（服务器） | `ssh 服务器 "dsh --profile acp"` —— sshd 在服务器上起进程，stdio 走加密通道 |

> **不存在"一个常驻 Agent 服务"。** 每个客户端连上就产生**自己那个进程**：
> 3 个成员同时在线 = 服务器上 3 个 `dsh` 进程。共享的只有 SQLite 文件。
> 连接断开时该进程 `quiesce` 并退出（源码 `connection.closed`）。

会话生命周期（同一连接上）：

```
session.new(cwd = "/srv/collaboration")   → 服务端生成 sessionId
  ↓ prompt("我是张三") → 模型调用 session_declare_member
  ↓ 此后该会话的角色决定都以"张三"为准
  ↓ 断线后 session.list 找回来，session.resume 按同一 sessionId 重连
```

**身份不靠 cwd，也不靠客户端自报**：声明的值来自人说的话，模型没有编造空间。
`session_members` 以 sessionId 为键，而 resume 复用同一个 sessionId —— 所以**断线重连后身份仍在**。

### 两条必须知道的边界

- **acp profile 带完整工具集**：`dsh-tool-bash` / `pwsh` / `fs` / `fs-search` / `jobs` 都在。
  桌面机上正常，放到共享服务器上意味着**连上即拿到一个 shell**，不只是仓库。
- **无认证**（`authMethods: []`）：`session_members` 里是"我自称是谁"，不是"系统验证了我是谁"，**不能当访问控制**。

这与"不考虑权限"的 MVP 定位一致，但离开本机后不要把 `session_declare_member` 误解成登录。

## 七、验证计划（在写服务器代码之前）

按顺序做，**第 2 步是分水岭**。

1. **本机三人一个仓库** —— cwd 都指向同一目录，各自声明身份。
   - 张三上传 → 李四 `material_list` 能看到
   - 张三确认 product → `confirmations.submitted_by = 张三`
   - **李四以 product 身份确认 → 应被拒（`NOT_ROLE_MEMBER`）** ← ADR-0014 在多进程下的第一次检验
   - 同时看三人操作是否出现 BUSY
2. **并发写（最关键）** —— 两个客户端几乎同时写。是否 BUSY、是否写丢失。
   **决定要不要补第五节的重试逻辑。**
3. **断线重连** —— 客户端中途断开后，用 `session.list` 找回会话、`session.resume` 按同一 sessionId 重连。
   要验证两件事：**身份是否仍在**（`session_whoami` 应仍返回原成员）、`cwd` 不一致时是否被拒。
4. **搬真机** —— cwd 与库路径换成服务器路径，重复第 1–2 步。

## 八、这个方案没有解决的问题

- **`session_members` 按会话存**，会话结束即失去意义。服务器长跑会累积，而插件**不清理旧会话**
  （ADR-0014 记为有意取舍）。需要清理判据，**当前没实现**。
- **名称不是标识**：名字是自由文本，`张三` / `张三 ` / `张 三` 是三个人。跨成员协作时会放大
  （ADR-0014 记为留待真正需要时再做）。
- **SQLITE_BUSY 无重试**（第五节）。
- **无认证**（第六节边界）。
- **无网络层**：纯 stdio，客户端必须能 spawn 进程（本机或 SSH）。

## 九、结论

| 需要的能力 | 现状 |
| --- | --- |
| 固定 cwd → 同一个库 | ✓ 已有 |
| 多进程安全访问 | ✓ 已有（WAL + busy_timeout + `BEGIN IMMEDIATE`） |
| 会话级身份 | ✓ 已有（ADR-0014 `session_declare_member`） |
| 身份与角色成员分离校验 | ✓ 已有（`assertCanActAsRole`） |
| acp profile 可承载插件 | ✓ 已核实依赖齐全 |
| **插件注册进 acp profile** | ✗ 待做（一条命令） |
| **BUSY 重试** | ✗ 待做（需先写失败测试） |

最该先做两件事：**第七节第 1–2 步实测**（决定第五节的缺口有多严重）、**把插件注册进 acp profile**
（一条命令，不做之前什么都跑不起来）。

---

## 事实来源

- `@deepseek-ai/dsh-acp` v0.1.5-rc.2 `lib/index.js` —— 传输、方法、`newSession`、`authMethods`、`config.stream` 注释
- `dsh --profile acp --dump-config` 与 `~/.dsh/profiles/acp/package.json` —— profile 组合、依赖、插件未注册
- `src/sqlite/connection.ts` —— WAL、busy_timeout
- `src/sqlite/schema.ts` —— `inTransaction`，`BEGIN IMMEDIATE`，**无重试**
- `src/sqlite/errors.ts` —— `isBusy` 定义；全项目仅测试引用
- `src/index.ts` —— `databasePath` / `fileRoot` 默认值
- ADR-0014 —— 会话身份与角色成员分离
