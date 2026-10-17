# v0.6.0 双仓正式发布记录

**已完成：两仓非预发布版GitHub Release、原始附件及固定源码核验。** 发布于2026-10-17，用户明确要求先发布现有稳定版本，再实现机器人最小方案。此次未改变现用服务器／客户端安装，不因发布强制重扫、迁移或重启。

| 范围 | 固定提交 | 正式Release | 标签CI |
|---|---|---|---|
| 服务端 | `a2875188cd2d67b606a2ee6e3ecd9f861baef1fe` | [v0.6.0](<https://github.com/Lafinger/dsh-collaboration-acp-server/releases/tag/v0.6.0>) | [39003833111](<https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/39003833111>) |
| 客户端 | `b4a996c4ea68c462cc314400c0964b7afadcb62a` | [v0.6.0](<https://github.com/Lafinger/dsh-collaboration-client/releases/tag/v0.6.0>) | [39003833763](<https://github.com/Lafinger/dsh-collaboration-client/actions/runs/39003833763>) |

两仓标签均为固定提交的不可变发布来源，Windows／Ubuntu验证、Package、Publish四个任务全部success。正式资产各3份：版本化原始`.tgz`、`SHA256SUMS`、`release.json`。下载的Release文件逐字等于对应标签CI的原始artifact，未重打包、未覆盖旧资产。

- 服务端原包SHA-256：`2f4c8b0a9538486aa8b2f4cb61ecd922fd867c84d269fccfda03b823c9d60bd7`，270个公开文件逐一匹配固定Git树。
- 客户端原包SHA-256：`e529a3078ff4be8dc1dd8e6b6c52fdfaeee1ac674f851eea56858043901a27ee`，140个公开文件逐一匹配固定Git树。
- 只允许既有pnpm打包去除`packageManager`的清单规范化；其余manifest字段和所有文件必须一致。客户端时钟修复原包为139文件，正式基线额外包含后来新增的已知问题说明，故为140；源码差异已核对，不以修改／重打包原件解决计数预期错误。
- Release为非draft、非prerelease。中文说明包含已验收范围、固定安装源、宿主兼容和延期项；仅GitHub分发，不发布npm／插件市场。

## 固定安装源

```text
github:Lafinger/dsh-collaboration-acp-server#v0.6.0
github:Lafinger/dsh-collaboration-client#v0.6.0
```

支持既定DSH `0.2.0-rc.2`、Cordis `4.0.4`、Schemastery `3.18.4`、Node >=24。需要安装时用官方管理器及原始CI资产；后台升级须完整托盘退出再重启，但**本次发布本身没有执行安装**，不要求已有A/B仅为发布重装或重扫。

正式服务仍运行已验证的`73d002e`功能源，发布源码`a287518`与其运行代码／依赖一致；客户端正式源码`b4a996c`的功能与时钟修复`afd38fc`一致，A首轮安装源与B修复安装源保持分别记录。不要把新tag说成当前机器已加载该tag。

## 稳定范围与下一阶段

本次稳定包仅包含网页扫码、设备记忆／退出隔离、共享项目与私有会话、资料／分析／方案／任务／成果／独立接收，以及已验收的两项最小修复。验收证据及未测项见[最小闭环终验](<MVP-MINIMAL-FLOW-ACCEPTANCE-2026-10-17.md>)。

**机器人设计和实现没有混入本次稳定包。** 本地设计文档在发布前另行逐字保存，tag固定在其提交之前。现在才进入[机器人最小升级方案](<MVP-机器人文本通知与职责审批-最小升级方案.md>)阶段0；当前企业应用机器人编码、Stream启用状态、主动发送权限和A/B可见范围需要证据，不因为扫码有效就推断机器人已可用。条件不足先停下，不擅改应用／网络或猜robotCode。

已知管理区下拉偶现问题仍延期未修；未等时真人满7天、实际图片视觉未验收，不扩大本次正式版的验证结论。
