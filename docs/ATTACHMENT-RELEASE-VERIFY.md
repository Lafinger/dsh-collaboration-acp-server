# 服务端v0.4.1附件正式发行与保留数据部署验收

## 提交、CI与Release

- 初始附件功能v0.4.0：commit `1630c2dc33382d7d2679849365c69d1920f5e738`，[main CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38354237765)、[tag CI/Release](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38354425521)success。
- 实际用户Word本地兼容检查发现安全空目录ZIP条目使用反斜杠，过严校验拒绝；最小模拟回归先红后绿，窄修复不开放反斜杠文件/../drive路径/宏/实体。最终v0.4.1 commit `c90bba68b2987f6af80f5ccece809d6a5743f055`，parser1.0.1；原v0.4.0tag/包保持不变。
- [patch main双平台CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38355126876)、[patch tag CI/Release](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38355393344)success。
- [公开v0.4.1](https://github.com/Lafinger/dsh-collaboration-acp-server/releases/tag/v0.4.1)非draft/prerelease，三附件齐全；下载tgz SHA256 `5af8bb3a719aa063df0c9b75dc72bf2cadd4f89659f60d8a912b8329aa9cc473`与release.json/SHA256SUMS/commit一致。未npm或市场发布。
- 固定GitHub来源独立安装＋真实官方host/runtime/whoami工具fixturePASS，下载180文件包抽取importPASS；真实DSH CLI在专用disabled `collaboration-compat-attachment-server-v041` profile安装PASS，无宿主版本豁免，不修改现用desktop/acp。

## 本地测试

282业务回归、35服务端单元、13宿主集成PASS；客户端31单元/8集成，双仓joint4项PASS。官方Agent loop、SQLite/存储、工具scope、forced connector为实际实现，模型替身不HTTP。

覆盖：原生附件投影前授权、当前human操作行与唯一项目ID、项目绑定/账号session/request隔离、分块offset/编码/len/hash、取消与事务回滚、immutable版本/同回执一次、解析/原件hash防篡改、真实DOCX body/table/图片缺口、压缩膨胀/CRC/DTD/宏/路径拒绝、严格UTF-8、PNG/JPEG/WebP/GIF格式/尺寸/首帧校验、同id恢复不重放；附件turn强制guard拒绝role成员赋值等非附件业务写。

实际POC原件本地解析兼容PASS，body11996UTF-8bytes、1嵌入图片存在、原件hash不变；无文本打印、上传、模型调用。Word文件名版本与正文V1.0保留差异，不修改文档。此检查不是布局/视觉检查。

## 固定来源Docker

部署源后续commit `9ea9e73716b9467a78cb56d4f74a86694995a0ad`，[双平台CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38355586007)success。deployment lock精确GitHubv0.4.1commit c90bba68，依赖安装ignore-scripts；native sharp0.35.5与XML parser5.11.1实际Linux加载。

新镜像 `dsh-collaboration-linux-sim:0.4.1`：Docker inspect image ID `sha256:7459523ebb5fc86ed94c01b53f210dea8dcf10d8def4b978ed82ff7a9e7b3c72`，OCI config `sha256:f92d18377858dea877d25c1cbd4f7f01cd9eac27d139d5f2cb139ee9d4bdc116`。新镜像无network、无生产volume、dshsvcUID的隔离fixturePASS：官方host/tools transfer/inspect/archive、图片四种格式、原件hash、same-id恢复无重放。不在生产Codegoroute发送fixtureprompt，不换服务模型。

## 保留数据升级结果

按[保留升级脚本](<../deploy/docker-linux/verify-preserved-data.mjs>)在正常停旧容器后离线只保存opaque hash/计数，不备份业务库/文档/credentials；验证原卷名后启动新容器，比较PASS：

- 30个既有业务表全行内容一致（新增attachment_receipts/material_extractions允许）。
- 2项目：CSAIR-DH-POC `b723201e63b2441caa19c439b3a846b0`、COLLAB-RETEST-001 `b20e6b2749224582887a6ce81cfafc7d`不变。
- 3远端会话、9access请求、6宿主持久会话文件逐项一致，无自动model/prompt/replay。
- Codego单项credential、member HMAC/SSH public keys、host私钥/公钥、serviceconfig、daily mode一致，已有资料目录hash一致。
- 原volume `dsh-collaboration-linux-sim-data`保留；无reset/volume rm/down -v/no-backup deletion，无客户端mapping清理/密钥轮换。
- 运行中healthy/Restarts0、2CPU/2GiB/256PID、原三个精确地址/22222、key-only forced connector不变；Linux文件权限/成员无法读秘密或改程序/sshdpolicyPASS。
- 原acceptance统计仍turns9/requests20/completed9（用户此前真实GUI测试积累），本轮未产生额外付费请求；不能称当前业务空或历史无模型。

## 真实SSH与用户边界

下载的客户端v0.3.0通过当前Alice用户配置真实SSH与新server0.4.1能力协商/身份/现有POC历史PASS，未来attachmentversion/通用fs/跨Bob历史拒绝，未新建会话。Alice/Bob本机身份与local/LAN/ZeroTier入口PASS，同hostPID；这不是另一台设备此次GUI验收。

客户端更新由用户手工重装固定v0.3.0，保留现有配置、映射和会话。真实资料上传、智能分类质量与角色建议由Alice后续明确请求，Bob只读固定版本复核；见[操作清单](<../deploy/docker-linux/ATTACHMENT-UPDATE.md>)。本轮未代替上传南航保密文件或调用真实模型，不宣称真实GUI附件/需求分析已验收。
