# 独立服务部署（Linux SSH 验收待完成）

## 单运行时与身份边界

成员 DSH 插件 → 隐藏 SSH → 受限轻量 connector → 服务器本地 Unix socket → 一个 DSH 运行时。connector 无模型、不另启动 DSH；其 OS 用户是 SSH 登录成员，而共享服务 OS 用户只是服务账号。

服务端对每账号配置独立随机 HMAC secret。root 配置的 connector 只读取本账号凭据，签发 30 秒、一次性 nonce、绑定 serviceId 的票据；票据仅进入本地 socket，不交给客户端。服务器验证后绑定账号/会话，每次操作检查 owner。

服务配置、代码和 socket 父目录不得由成员修改。Linux connector 要求凭据 root-owned、账号独立主组可读、mode0440；成员不得属于他人凭据组。共享 secret 或客户端自报用户名不能替代可信登录。

## 服务配置

服务账号私有 JSON（0600），只用于隔离状态路径。占位符不是可用密钥：

```json
{
  "serviceId": "workbench-test",
  "workspace": "/srv/collaboration-test/workspace",
  "stateRoot": "/srv/collaboration-test/state",
  "socketPath": "/run/collaboration-test/service.sock",
  "fixture": true,
  "accounts": {
    "alice": "<64+字符独立随机密钥>",
    "bob": "<另一个独立随机密钥>"
  }
}
```

workspace/stateRoot/socketPath 必须绝对路径；服务忽略客户端 cwd，不挂载客户端 MCP。root 预先建立服务目录，配置 socket access group。服务端 socket mode0660，父目录不可由成员替换。

```sh
pnpm run build
node bin/server.mjs /etc/workbench-access/server.json
```

正常依赖在项目 node_modules 解析；测试用 `WORKBENCH_OFFICIAL_NODE_MODULES` 仅用于明确缓存复核，不是运行必要条件。进程输出 ready/serviceId/runtimePid，不输出密钥。

显式 `fixture:true` 使用本地替身，不消耗配额。真实模型路线需部署人员配 adapterModule 绝对路径，导出 `createAdapter(config)`，以及 provider/model；本轮不配置或调用真实模型。

## 成员 connector

固定 root provisioned 配置 `/etc/workbench-access/connectors/<account>.json`：

```json
{
  "account": "alice",
  "serviceId": "workbench-test",
  "secret": "<alice对应独立密钥>",
  "socketPath": "/run/collaboration-test/service.sock"
}
```

sshd 示意：

```text
Match Group workbench-members
  ForceCommand /opt/node/bin/node /opt/dsh-collaboration-acp-server/src/connector-cli.mjs
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

禁止用户 environment / SSH_ORIGINAL_COMMAND 改写账号、凭据路径或实际命令；root 拥有连接器与父目录。服务组可访问 socket，但每个成员只能读自己主组对应凭据。host key 由可信渠道分配到客户端 known_hosts。

**真实 Linux/SSH 尚未验证。** Windows 可运行替身服务/命名管道集成，但 production connector ACL 检查明确拒绝 Windows。没有自动创建系统账号、安装 sshd、修改正式配置或业务库。
