# 拆分来源与维护边界

已确认拆分：

- 客户端 DSH 插件独立仓库 `dsh-collaboration-client`：member plugin/client、SSH、wire helper、独立测试、客户端文档。
- 服务端 DSH ACP 服务独立仓库 `dsh-collaboration-acp-server`：authority、connector、access service/store、官方 DSH runtime、工作台业务模块、独立测试和服务部署文档。
- 原 `dsh-project-workbench` 的提交 `3e0b76c` 保留原封基线；新仓库分别首次提交、不复制旧 Git 历史。
- 部署文档各自所有，通信契约在两仓各存一份版本1，通过显式联合测试检查一致；不新增第三仓，也不以兄弟源码作为运行依赖。

## 业务模块

[business/src](../business/src/) 是原业务代码和 282 项回归所在模块；构建输出 business/lib。工作台需求与历史 ADR 保留在 business/docs 中，不将历史“多进程/自报身份”文本误作当前部署指令。

[当前部署](DEPLOYMENT.md)、[运行维护](OPERATIONS.md)、[契约](PROTOCOL-v1.json)描述接入方案；[历史原型验证](history/acp-access-original-VERIFY.md)仅记录拆分前结果，不能代替[本仓库验证](VERIFY.md)。

以上为0.1.0拆分历史。0.2.0改为[宿主插件](adr/0001-hosted-collaboration-runtime.md)，精确适配DSH0.2.0-rc.2，取消独立生产启动入口，业务编译产物提交以支持无安装脚本GitHub来源。仍不展开管理员授权、文件传输或现用数据库迁移；检查和证据不写现用DSH profile。
