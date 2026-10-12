# dsh-collaboration-acp-server

独立服务端 DSH ACP 接入服务：一个常驻运行时接受多个成员的独立会话，共享工作台业务库，按可信登录账号校验会话归属。

> 来源：`dsh-project-workbench` 提交 `3e0b76c`。服务端已包含业务模块与对应测试，不依赖旧仓库编译目录或客户端源码。保留有限 ACP-shaped 接口与 `workbench/*` 扩展，不宣称完整 ACP 兼容。

## 目录

- [src/server-cli.mjs](src/server-cli.mjs) / [bin/server.mjs](bin/server.mjs)：独立运行服务。
- [src/dsh-runtime.mjs](src/dsh-runtime.mjs)：真实官方 DSH 循环、工具和持久化。
- [src/connector-cli.mjs](src/connector-cli.mjs)：Linux SSH forced-command 轻量连接器。
- [business/src](business/src/)：工作台业务源代码；[业务文档索引](business/docs/项目管理工作台需求文档MVP/README.md)保留原需求/ADR历史。
- [部署](docs/DEPLOYMENT.md)、[运行维护](docs/OPERATIONS.md)、[通信契约](docs/PROTOCOL-v1.json)、[验证](docs/VERIFY.md)。
- [术语](GLOSSARY.md)、[语境地图](GLOSSARY-MAP.md)、[来源与拆分边界](docs/SPLIT.md)。

## 独立检查与启动

Node >=24，官方 DSH family 固定 0.1.5-rc.2，Cordis 4.0.2：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm pack --out .dsh/dsh-collaboration-acp-server.tgz
node scripts/check-package.mjs .dsh/dsh-collaboration-acp-server.tgz
node bin/server.mjs /absolute/isolated-server-config.json
```

`check` 类型检查、构建内部业务模块、运行 282 项业务回归及服务器协议/真实 DSH 集成测试，不需要兄弟仓库。服务器 package 内只发布构建后的业务模块，测试源码和状态库不进入包。

联合验收仅显式指定客户端路径时才执行：

```sh
DSH_COLLABORATION_CLIENT_ROOT=/absolute/client-checkout pnpm run check:joint
```

## 本轮边界

- 测试模型是本地固定替身；DSH loop、工具执行、JSONL 会话与业务 SQLite 是真实实现。
- 真实 SSH 公钥认证/权限与现用 GUI 0.2 尚未验收，真实模型未调用。
- 仅文本，无本地文件上传、成果下载、client fs/terminal/MCP、多客户端共编。
- 管理员/项目创建授权尚未讨论；本次拆分不扩大权限范围。
- 原工作台仓库原封保留作历史基线，两个新仓库独立维护接入功能，不复制原 Git 历史。
