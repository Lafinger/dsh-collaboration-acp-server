# 项目工作台 ACP 成员接入原型

> 隔离原型，不是现用 DSH 的已安装插件，也不是正式多租户/权限系统。
> 所有工作由主代理直接完成，没有使用 subagent。

## 已确认目标

- 服务器一个常驻 DSH 运行时；多成员连接、多独立会话、共享项目业务库。
- 成员客户端是纯业务入口：模型决策和工作台工具执行在服务器。本地 DSH loop 仍存在，只转发用户消息、呈现回复。
- 插件隐藏 SSH；每人独立账号和密钥；预配置主机、账号、已核验的 known_hosts。
- 服务器工作目录固定，不接受客户端 cwd 或 MCP 配置来改变服务范围。
- 登录账号绑定连接/会话；知道 sessionId 不代表有权恢复、读取、取消或提交。
- 断线取消当前会话这一轮，不回滚已提交数据、不影响其他成员。
- 自动重新建立连接、恢复会话/保存记录；不自动重新发送业务指令。
- 首轮不做文件传输、不讨论管理员/项目创建权限、不迁移现用库。

## 结构

```text
成员 DSH → member-plugin（LLM adapter，无本地业务模型）
           → ssh.exe（校验服务器指纹，key-only，禁用转发）
           → Linux 受限 forced-command connector
           → 本地 Unix socket（不向网络开放）
           → server-cli（一个进程，一套官方 DSH 服务）
                ├─ access.sqlite：会话归属、请求提交记录、恢复事件
                ├─ workbench.sqlite：现有工作台业务权威库（隔离新库）
                └─ 官方 JSONL 会话持久化
```

这不是把多个客户端裸接到 official stdio ACP。原型直接挂载官方 AgentRegistry、AgentLoop、ToolRuntime、LlmRuntime 与持久化服务，并提供限制范围的 ACP 方法以及 `workbench/*` 扩展。没有完整 ACP SDK server/client 能力兼容承诺。`session/load` 附加后通过 `workbench/history` 获取恢复事件；不是标准 ACP transcript replay 的完整实现。

## 身份可信边界

1. SSH 服务器验证成员公钥，运行固定连接器；禁止交互 shell、TTY、端口转发、agent forwarding、用户环境和任意 remote command。
2. 连接器从**连接器自己的 OS 账号**读取用户名。共享 DSH 服务不使用自己的 OS 用户来识别成员。
3. 每成员一份独立随机签名密钥：root 配置、成员自身仅只读；不得多成员共享。连接器为账号签发 30 秒、一次性 nonce、绑定 serviceId 的 HMAC 凭证；此凭证只发往服务器本地 socket，不发给成员客户端。
4. 服务端核验签名与成员配置；把已验证账号持久绑定到会话。任何业务操作前检查会话归属，列举仅返回本人会话。
5. 新版身份桥仅在隔离 session scope 内屏蔽 `session_declare_member`，以服务器 setup 写入现有 session identity 兼容层；并用可信账号覆盖各工具 `submitted_by`。原有源代码及旧声明工具没有删除。

**部署条件不可省略：** root-owned 连接器代码/配置父目录；每份凭据 root:成员独立主组、0440，成员不属于别人的凭据组；服务配置服务账号自有、0600；socket 目录由 root/服务拥有不可被成员替换；root provisioned SSH host key。Windows 原型服务器/管道可做隔离测试，但 production connector ACL 目前只实现 Linux 检查，Windows 路径会明确拒绝。

不同账号凭据间的隔离依赖 OS 与 sshd 正确部署；本机模拟 HMAC 测试不证明真实 SSH 登录安全。管理员拥有服务器/模型/数据库最高可信能力；本轮没有新做管理员授权设计。

## 文件职责

- `src/server-cli.mjs`：一个官方 DSH 运行时的独立启动器。
- `src/connector-cli.mjs`：Linux SSH forced command，不接受客户端选择账号。
- `src/member-plugin.mjs`：客户端模型适配器及恢复通知；不执行远端回传的 tools。
- `src/member-client.mjs`：持久会话映射/稳定 message ID/零重发恢复。
- `src/service.mjs`：会话所有权和生命周期。
- `src/workbench-binding.mjs`：可信账号到现有业务工具的隔离桥。
- `scripts/official-loader.mjs`：一次性进程 import 路由，指向已安装官方 0.1.5-rc.2 构件；不改 profile 或全局依赖。

## 本机运行测试（PowerShell）

先在仓库根构建现有业务模块：

```powershell
$node = 'C:\Users\cjh13\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmitOnError
```

在本目录运行：

```powershell
$env:WORKBENCH_OFFICIAL_NODE_MODULES = 'C:\Users\cjh13\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules'
& $node --test ./test/*.test.mjs
& $node --import ./scripts/official-loader.mjs --test ./test/*.integration.mjs
```

`official-loader` 使用已存在的官方 Node 包，要求整个 package family 匹配 0.1.5-rc.2。没有运行 npm install，未修改 desktop/acp 现有 profile，也没有使用 0.2 GUI 构件混装。

测试模型是本地固定替身；**官方 DSH loop/工具调度/会话持久化是真实代码**。没有网络模型调用或配额消耗。

## 隔离服务配置

在仓库以外的隔离数据目录创建绝对路径配置，不提交真实密钥。示意（占位符不可直接部署）：

```json
{
  "serviceId": "workbench-test",
  "workspace": "/srv/workbench-test/workspace",
  "stateRoot": "/srv/workbench-test/state",
  "socketPath": "/run/workbench-test/service.sock",
  "fixture": true,
  "accounts": {
    "alice": "<64+字符独立随机密钥>",
    "bob": "<另一个独立随机密钥>"
  }
}
```

Linux 单次启动：

```sh
WORKBENCH_OFFICIAL_NODE_MODULES=/opt/workbench-runtime/node_modules \
node --import ./scripts/official-loader.mjs ./src/server-cli.mjs /etc/workbench-access/server.json
```

默认必须显式 `fixture:true` 才使用免费本地替身。真实模型路线需部署人员另配 `adapterModule` 绝对路径（导出 `createAdapter(config)`）、provider/model；本轮未配置、未调用真实模型。

## Linux SSH 部署形态（待真实验证）

成员账号配置独立主组和公钥。每账号 root provisioned 文件位于固定 `/etc/workbench-access/connectors/<account>.json`：

```json
{
  "account": "alice",
  "serviceId": "workbench-test",
  "secret": "<alice对应的服务器端独立随机密钥>",
  "socketPath": "/run/workbench-test/service.sock"
}
```

sshd `Match Group` 配置示意：

```text
Match Group workbench-members
  ForceCommand /opt/workbench-runtime/bin/node /opt/workbench-access/src/connector-cli.mjs
  AuthenticationMethods publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PermitTTY no
  AllowTcpForwarding no
  AllowAgentForwarding no
  X11Forwarding no
  PermitUserEnvironment no
  PermitUserRC no
```

节点执行文件、连接器文件和父目录由 root 拥有，成员不能修改。不要启用 AcceptEnv 来传递 connector config/account，不把服务主密钥下发给客户端。部署人员需确保 service socket 的主组包含成员连接器、但成员不能访问其他成员凭据或服务配置。

**本机无 sshd，也无已提供的外部 SSH 测试服务器；以上是运行接口/部署说明，不是实测通过证明。** 不自动安装系统服务、创建真实成员账号或修改 sshd 配置。

## 客户端插件配置

隔离 client profile 中手动加载本地 `src/member-plugin.mjs`（该 prototype package 不带自动注入 bundle），配置：

```yaml
id: workbench-member-entry
name: /absolute/path/to/prototypes/acp-access/src/member-plugin.mjs
config:
  provider: workbench-remote
  serviceId: workbench-test
  databasePath: /absolute/client-isolated/access.sqlite
  ssh:
    host: server.example
    account: alice
    identityFile: /absolute/client/key
    knownHostsFile: /absolute/client/known_hosts
```

将本地会话的 provider/model 选择为 `workbench-remote/server-agent`。本地 loop 保留，但 adapter 不转发工具定义、不转发系统上下文/历史、不调用本地业务模型。仅转发最后一个稳定 ID 的真实 user-source 文本消息；标题在本地截取文字，其他辅助调用明确报错，不触发服务器 Agent。

插件只按显式用户 prompt 提交业务请求；连接中断后后台恢复连接/会话，但绝不执行 `session/prompt`。恢复记录作为 source=plugin 的本地 notice 写入，不能被当作用户指令再转发。恢复失败保留 mapping 并提示，不静默建立替代会话。

现用 Web GUI 0.2 的渲染/loader 兼容性**尚未验收**；这里的插件 `apply` 和 notice 事件只验证官方 0.1.5-rc.2 服务接口。没有启动替代 Web 服务或触碰现用 URL。

## 未覆盖/限制

- 真正的 SSH publickey 认证、POSIX 凭据组隔离、host key mismatch 和 UI 提示需要 Linux 服务器验收。
- 同一远端会话禁止多客户端同时附加；同一账号可拥有多个会话。
- 第一版恢复数据来源为 access 事件日志；没有把它冒称跨存储分布式事务。服务器在已提交业务操作后崩溃仍可能留“结果未知”，不会自动补执行。
- 不自动回滚，不实现 arbitrary side effects 的 exactly-once；稳定请求 ID 仅阻止同一次业务输入被 transport retry 重复提交。
- 文本原型：不支持图片、成员本地文件上传、成果下载、client fs/terminal、client MCP。
- 一个进程内成员会话共享磁盘与业务库，不是 OS sandbox 多租户隔离。管理员/业务操作授权与真正模型配置另议。
