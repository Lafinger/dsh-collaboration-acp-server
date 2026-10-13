# dsh-collaboration-acp-server

**服务器 DSH 的协作 ACP 服务端插件**：安装、配置并启用后，复用宿主运行时，为多个可信登录成员提供独立 Agent 会话与共享工作台业务库。插件不创建第二套 DSH，不改宿主模型注册，不在卸载时关闭宿主。

0.3.0精确支持 **DSH0.2.0-rc.2 / Cordis4.0.4 / Schemastery3.18.4 / Node>=24**。不兼容旧0.1.5独立服务入口，旧CLI明确拒绝启动，不自动迁移旧数据。服务器管理员可信；成员会话逻辑隔离不等于OS多租户隔离。

> 来源：原工作台提交3e0b76c，历史独立服务提交dac24aa。当前代码无需原仓或客户端源码；保留有限ACP-shaped接口与collaboration扩展，不宣称完整ACP兼容。

## 安装与启用

DSH插件管理器安装来源：

```text
github:Lafinger/dsh-collaboration-acp-server
```

当前固定入口：`github:Lafinger/dsh-collaboration-acp-server#v0.3.0`。无版本入口读取main，不自动选择最新Release。GitHub自动检查/打包与发布见[发布说明](docs/RELEASE.md)，实际安装、宿主隔离和旧版本首发证据见[验收记录](docs/GITHUB-RELEASE-VERIFY.md)。只发布GitHub，不发布npm或DSH插件市场。

安装后默认disabled；空配置启用为安全待配置，不建库、不监听、不调用模型。复制[空模板](examples/server-config.example.json)到服务账号自己的私有配置文件，填写部署路径、账号独立凭据与宿主已有provider/model，按[部署说明](docs/DEPLOYMENT.md)检查后启用。没有GUI配置表单，也不自动修改sshd或创建系统账号。

模型对话持久化由宿主提供；工作台业务库和接入元数据由插件管理。成员只有工作台工具，不能继承宿主文件、终端、MCP、subagent等能力；本地普通会话没有本插件业务工具。服务器当前聊天窗口切模型不改变协作服务明确选定的模型路线。

## 实现目录

- [插件入口](src/server-plugin.mjs)、[配置校验](src/configuration.mjs)、[bundle patch](cordis.patch.yml)
- [宿主运行时适配](src/dsh-runtime.mjs)、[业务装配](src/collaboration-runtime.mjs)、[接入服务](src/service.mjs)、[可信身份绑定](src/collaboration-binding.mjs)
- [轻量SSH connector](src/connector-cli.mjs)：无模型、不另起DSH
- [业务源码](business/src/)、[核验编译产物](business/lib/)、[历史业务文档](business/docs/协作服务需求文档MVP/README.md)
- [运维](docs/OPERATIONS.md)、[契约](docs/PROTOCOL-v2.json)、[验证](docs/VERIFY.md)、[架构决定](docs/adr/0001-hosted-collaboration-runtime.md)、[术语](GLOSSARY.md)

## 开发与验证

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm pack --out .dsh/dsh-collaboration-acp-server.tgz
node scripts/check-package.mjs .dsh/dsh-collaboration-acp-server.tgz
```

check验证业务源码与已提交编译产物一致，再运行282项业务回归和接入/真实宿主接口测试，不静默重建后掩盖陈旧产物。业务源码变更后显式`pnpm run build`并提交生成内容。没有prepare/install/prepack构建，GitHub安装无需执行脚本。测试宿主只位于测试目录，不提供独立生产启动路径。

联合检查显式选择另一仓库：

```sh
DSH_COLLABORATION_CLIENT_ROOT=/absolute/client-checkout pnpm run check:joint
```

测试使用本地固定模型替身，官方DSH Agent loop、工具执行、会话持久化与SQLite是真实实现。不调用付费模型；真实Linux SSH/权限与GUI端到端仍需部署验收。只有文本，不含客户端文件传输或多客户端共编，不扩大项目/管理员权限规则。

## 许可证

[MIT License](LICENSE)，Copyright (c) 2026 Lafinger。第三方依赖遵循各自许可证；保留private:true防止意外npm发布。
