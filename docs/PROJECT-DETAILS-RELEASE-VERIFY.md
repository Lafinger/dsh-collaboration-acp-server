# v0.4.2项目背景／目标工具正式发行与保留升级验收

## 正式来源与安装

- release commit `32422af722ed296b9fec9bb3a181d787e068cc18`，annotated v0.4.2；只补充`project_update_details`，不改变基础collaboration协议v2／附件扩展1；客户端v0.3.0无需升级。
- [feature main Windows/Ubuntu CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38376163461)与[tag发行CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38376525368)全部success。
- [公开v0.4.2 Release](https://github.com/Lafinger/dsh-collaboration-acp-server/releases/tag/v0.4.2)非draft/prerelease，tgz/release.json/SHA256SUMS三附件齐全；实际下载tgz SHA256 `3839b0c5802bbce0ec449a36d64cc603f6c5228196fab9db48e849dbea903892`与metadata/checksum/tagcommit一致。旧公开tag／资产不变，无npm/市场发布。
- 下载发行包182文件独立抽取safe import PASS；固定GitHubtag独立安装、真实官方host安全挂载与新工具可见PASS，无lifecycle build。
- 真实DSH CLI安装至独立disabled profile `collaboration-compat-project-details-server-v042` PASS，无版本豁免、现用desktop/acp不改。安装器报告peer提示不等于挂载失败；独立完整官方host验证以固定GitHubinstaller fixture为准。

## 实现和回归

业务源码与98个JS／声明产物一致。285业务、35服务端单元、14官方宿主集成、4独立双仓joint全部PASS。新增3项业务编辑回归及1项官方host工具回归，source与prebuilt产物均包含新工具。

编辑边界见[用法](<PROJECT-DETAILS.md>)：只提供background／goal的非空文字、每项2000字符以内；至少一个字段，未提供字段保持最新值；拒绝null／空白／其他字段，无清空／改key/name／新项目能力。读旧值、archive gate与写入在同一事务内；归档项目拒写；附件turn guard拒绝顺带编辑。新工具不赋予项目ACL或角色管理特权，也不假称自然语言授权由服务机械识别。

覆盖两个字段／部分字段／重复同内容、trim、2000边界、无效第二字段零部分写、额外字段、unknown/archived project、保留角色和资料／分析／关联表内容／原件hash、普通host工具隔离、同id恢复无自动执行。无需schema迁移，不删除业务实体，不凭工具升级写入旧草稿。

## 固定Docker和隔离Linux验证

后续部署commit `1332cf89bd4c53cd9ce5f25ed29ba69302b4d230`，[双平台CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38376774683)success。lock精确GitHubv0.4.2commit 32422af7，frozen/ignore-scripts构建，不用本地未发布源码覆盖生产插件。

镜像`dsh-collaboration-linux-sim:0.4.2` Docker inspect ID `sha256:7d6605fbc17baeb49aa8c84c64075f2c447a35fc854c20e2d4a44dc7592cc150`，OCI config `sha256:aefd38953362cab32b0b9167a17da1b085183f251665117f6b777e9b8fca9147`。

无network／无生产volume／UID1101隔离fixture PASS：真实官方Agent loop/tool executor调用project_update_details、partial patch、原值保留、无效patch原子拒绝、archive拒写、same-id恢复无重放。既有attachmentfixture也PASS：四种image格式native解码、transfer/inspect/archive、immutable版本与无重放。全部使用非敏感fixture model，不调用Codego。

## 生产保留校验

核对原container镜像0.4.1和专用卷身份，没有running请求；正常stop后离线运行[保留校验](<../deploy/docker-linux/verify-preserved-data.mjs>)的`save project-details`，只存opaque hash／计数不是数据库、文档或凭据备份。不覆盖之前attachment升级证据；启动同一container／volume后`compare project-details`PASS：

- 全部32个既有业务表逐行hash一致，包含attachment_receipts和material_extractions。
- 2项目、4远端会话、22access请求、8host会话文件逐项一致；无新会话、自动prompt／replay。
- 资料原件、私有接收原件、Codego模型计数、服务config/credential、SSH host/member身份完全一致；无volume rm/down -v/reset/no-backup清库。
- 南航CSAIR-DH-POC `b723201e63b2441caa19c439b3a846b0`仍background=null/goal=null、未归档；没有用旧草稿自动填充。
- Alice仍pm/product/design；Bob仍scenemodel/sceneart/data/frontend/backend/ue，本次没有更改任何角色。
- 保留原material `38dccec0f008476e904eb614f72219a1`v1、hash `b69f1d4932d313de8bec8a49285b9a1a3cfee28ffb10ff9a79e1bcf819ea57ae`、analysis `57e2198d03384f49b602d713a48d04eb`及42requirements；项目仍1material/1analysis/0plan/0task。
- Docker running/healthy/Restarts0、原2CPU/2GiB/256PID、三个精确入口和22222、模型route不变；成员无法读秘密／改程序/SSH，forced connector/key-only检查PASS。
- model counters仍turns22/requests53/completed22，属于此前用户业务调用；本次没有付费模型请求或变化。

## 真实SSH与交付边界

实际安装的客户端0.3.0，通过Alice/Bob本机身份与local/LAN/ZeroTier三入口initialize/whoami/history验证新server0.4.2 PASS，同host PID／原history可读、跨成员history和任意fs拒绝；无session/new/load/prompt。这不是本次另一设备GUI或真实模型写入验证。

功能已上线；用户确认有效背景／目标后在Alice原会话新发明确授权指令，按[模板](<PROJECT-DETAILS.md#alice后续明确授权模板>)只更新这两个字段，再project_get复核。无需重装客户端或重建项目；本次未替用户执行production project_update_details，未确认历史日期或草稿，不宣称Codego503/断流已修复。
