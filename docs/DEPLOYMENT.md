# DSH宿主插件部署（真实Linux SSH验收仍待完成）

## 安装形态

服务账号启动一个DSH0.2.0-rc.2，安装本插件的GitHub来源。插件注入宿主agents/llm/sessions/tools/sessionPersistence，使用已有Agent factory和模型路线，每profile只一个协作服务。不能通过旧server CLI生产启动，不在插件内new Context或另起DSH。

```text
github:Lafinger/dsh-collaboration-acp-server
github:Lafinger/dsh-collaboration-acp-server#v0.2.0
```

默认disabled。安装不是配置成功或真实SSH连通；空配置为configuration-required，没有监听、业务库或模型调用。

## 私有JSON配置

把[空模板](../examples/server-config.example.json)复制到服务账号`~/.dsh/collaboration-acp-server.json`，如文件已存在先阅读不要覆盖。或用插件configFile/启动环境变量`DSH_COLLABORATION_SERVER_CONFIG`指定绝对路径。Linux文件须服务账号拥有、0600，不接受符号链接；父目录/代码由可信管理员保护，不给成员写入。

```json
{
  "serviceId": "your-service-id",
  "workspace": "/srv/collaboration/workspace",
  "stateRoot": "/srv/collaboration/private-state",
  "socketPath": "/run/collaboration/service.sock",
  "provider": "<宿主已注册provider>",
  "model": "<明确的模型id>",
  "accounts": {
    "alice": "<至少64字符、该账号独有的随机凭据>",
    "bob": "<另一个不同的随机凭据>"
  }
}
```

以上占位符不可直接部署。workspace与stateRoot须分离的绝对目录、不互相包含；Linux stateRoot必须服务账号拥有、0700，插件只按0700新建、不放宽既有目录权限；生产监听只用本地Unix socket，Windows仅命名管道测试。socket父目录须root/服务账号拥有，不允许组/其他人写入，管理员预置访问组。已存在socket拒绝覆盖，先排查旧进程，不自动删除。

配置检查仅读字段、权限与格式，不验证网络/模型、不建库，输出不含accounts值：

```sh
node scripts/check-config.mjs /absolute/server.json
```

宿主必须已启用Agent loop与持久化后端，并注册指定provider；未具备时服务待配置。明确选定模型，不跟随当前聊天窗口切换；修改配置后重新启用。provider/model沿宿主调用，不要求adapterModule或fixture生产配置；首次真实请求可能消耗服务器模型配额。

启用插件后同进程监听socket。禁用断连、取消自己的在途轮次并关闭自身Agent/SQLite，不关闭宿主，也不修改其他会话/模型。已提交业务事实保留；恢复只附加同一会话、不重发旧业务指令。模型会话文件由宿主管理，不是stateRoot内另开一套JSONL后端。

## 可信成员接入

成员DSH客户端 → SSH公钥登录 → root配置forced-command轻量connector → 本地socket → 宿主内协作插件。每账号独立HMAC凭据签发30秒一次性票据，绑定serviceId；凭据/票据不交给客户端。聊天自报姓名、客户端account字段不构成认证。

root配置`/etc/workbench-access/connectors/<account>.json`，root-owned、账号独立主组可读、mode0440；成员不能属于他人凭据组：

```json
{
  "account": "alice",
  "serviceId": "your-service-id",
  "secret": "<与服务配置中alice相同的独立凭据>",
  "socketPath": "/run/collaboration/service.sock"
}
```

root-owned connector代码位置应固定到核验安装副本；推荐直接Node执行入口，不依赖成员可修改PATH：

```text
Match Group workbench-members
  ForceCommand /opt/node/bin/node /opt/collaboration-profile/node_modules/dsh-collaboration-acp-server/src/connector-cli.mjs
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

入口忽略SSH_ORIGINAL_COMMAND与客户端argv账号。管理员部署并分发可信host key，成员使用strict known_hosts。插件不创建OS账号、不配置sshd、不暴露公网端口。

## 会话和能力边界

成员可创建/恢复自己的独立会话、操作共享业务事实。工具仅在认证Agent scope注册，并移除继承的宿主工具，原生业务执行有单调拒绝guard；宿主后来加入的工具也不在业务许可集合中。普通本地会话不能调用本插件工作台工具。现有业务材料导入仅允许管理员预置在服务workspace内的文件，realpath拒绝外部路径/符号链接逃逸；不是客户端文件上传或任意宿主文件读取接口。

服务器管理员可管理宿主与业务数据，属于可信主体；插件不保证对其隐藏会话。逻辑隔离不是OS多租户隔离。仍是有限ACP-shaped/workbench协议，无文件传输、client fs/terminal/MCP或多人共编。

## 数据迁移

0.2.0新插件部署使用空的独立目录，不自动迁移旧独立服务数据库或模型会话。用户只批准删除了本仓三处打包烟测试验.state数据，不代表批准清空任何服务器库。现用desktop/acp profile、原仓、其他数据保留。

**真实Linux/SSH权限尚未验收，Windows production connector仍拒绝直到另有ACL实现。** 本轮仅隔离测试/安装，不配置实际账号凭据或调用真实付费模型。
