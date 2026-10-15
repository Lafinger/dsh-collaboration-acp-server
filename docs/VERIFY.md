# 服务端验证

## 外部CPA标准自定义API修正与一次授权实测（当前）

Ubuntu已更新到固定成功CI提交03ad8841ed3a66d83faa93bc816e27b7dd36364e，DSH标准模型插件直接配置外部CPA／OpenAI Responses／gpt-6.1-sol，不部署CPA或修改DSH源码。ZeroTier恢复默认allowManaged后地址／路由生效，ping／TCP连通；用户另行授权的唯一实际HTTP模型请求返回200／CPA_OK，网关报告gpt-6.1-sol，4197ms。协作业务门禁仍false，密钥与全部数据保留，详见[配置修正、CI／上线与真实测试](<EXTERNAL-CPA-CUSTOM-API.md>)。真实图片／业务模型链路未测试，本机未改。

## 0.5.0 CPA与授权图片（首次上线历史，真实模型门禁关闭）

现用Ubuntu钉钉／权限基线单独提交9ad7b158809f5be910235ce1d02c680457d6e6a7；基线285业务＋70单元／安全＋18宿主集成通过，部署9通过／2Windows POSIX跳过。该提交不包含本轮CPA增量，不改变已经上线的基线规则。

本轮新增GIF双端拒绝、PNG／JPEG／WebP实际像素限额副本、原生tool/result image引用、成员／会话／项目与当前人类回执授权、持久历史offload。定向11项与实际Agent工具循环通过；固定官方Responses适配器在完全替换fetch、没有socket的离线503传输下核对image请求且仅请求一次，不强制推理等级。部署隐藏录入／门禁／切换预检另有合成文件回归；Windows完整check通过285业务＋76单元／安全（1项Ubuntu执行跳过）＋19宿主集成、594内部导入／238链接及命名审计；历史部署回归9通过／2Windows POSIX跳过。源码包抽取挂载与新部署脚本字节检查通过。首轮CI在Ubuntu执行6项Python脚本策略全通过、285业务／77单元／19集成全通过，但审计暴露历史文档跨仓库本地链接；Windows另暴露合成tmpdir大小写未canonical的fixture问题。已改固定公开历史链接并将测试临时根先realpath，不降低生产路径／锁校验；CI窄断言进一步确认Windows的TEMP使用RUNNER~1短名，普通realpathSync未展开而异步realpath返回runneradmin长名；单元fixture改用realpathSync.native后已通过Windows，集成fixture仍继承短名TEMP；检查启动器现为所有隔离子进程提供native长路径临时根，保留生产严格拒绝及互斥断言。最终固定SHA af3cba92249b9c9eb53cd613c98a5bafdb92fb1a的Windows／Ubuntu／打包CI全部成功，已按同一核验包切换Ubuntu；实际后端0.5.0、CPA路线、HTTPS和成员SSH正常，51张原业务表／3张接入表及资料原件会话未变，仅新增图片引用表。完整公开来源、保留核验和未验收边界见[上线验收](<CPA-UBUNTU-VERIFY.md>)。真实模型请求门禁保持false，未用真实key测试、未启用机器人、不清库重放；[Ubuntu操作](<../deploy/ubuntu/README.md>)。

## 0.3.0命名与协作协议v2（本地验证）

当前服务统一collaboration命名、业务库collaboration.sqlite、connector配置/etc/collaboration-access/connectors；业务装配和可信绑定源码文件已改名，中文当前说明与目录统一协作服务。真实历史来源及旧版证据保留列明例外。

协作版本v2以_meta.collaborationProtocolVersion双向检查，与基础ACP-shaped版本1分开。connector认证、initialize错误/缺失/旧版本拒绝，版本失败不能创建session或发业务请求；client重新绑定身份仍拒绝。

Node24.21.0/pnpm11.7.0：98构建文件与源码一致，282业务+29单元+12正式宿主接口集成PASS；3显式客户端联合用例PASS，4项安全mutation均检出。新版tarball171文件，相对imports/entry/disabled bundle/精确peers/MIT与抽取挂载PASS，冻结依赖与命名/链接审计PASS。

正式GitHub发布和新Docker空状态已完成核验，见[新发行记录](RENAME-RELEASE-VERIFY.md)及[Docker验收](../deploy/docker-linux/VERIFY.md)；不把以下历史结果当新版部署或GUI验收。测试无真实模型调用，不修改两台现用客户端。

## 0.2.0宿主插件改造（历史）

当前正式入口是[server plugin](../src/server-plugin.mjs)，复用宿主0.2.0-rc.2；旧独立CLI明确拒绝，不创建第二套DSH。check对照临时编译与已提交业务产物（98文件）、执行282业务回归，再检查接入/配置/真实宿主集成。

新增验证覆盖：空配置无宿主也安全待配置；两个成员独立Agent、共享同一宿主服务对象；可信账号与归属拒绝；普通宿主Agent看不到工作台工具；协作Agent不能继承通用工具，后续scope工具也被guard与模型schema过滤；业务导入拒绝workspace之外文件；单实例；禁用后宿主/普通Agent存活；启用恢复同id不prompt；在途取消和请求拒重。旧0.1.5替身只识别tool-result块导致0.2工具角色消息重复调用，先复现并添加回归后修复，无真实模型网络。

本地Node24.21.0/pnpm11.7.0：282业务、28单元、12集成通过；3联合用例通过，4项身份/重放mutation被检出。实际应用内0.2模块的6项关键插件/冷恢复用例通过，真实tarball installer通过，安装副本的3项启停/隔离测试通过。

打包检查验证MIT文本、main/exports/bin/import、disabled patch、业务lib与配置模板，然后在抽取包启用空配置。真实LinuxSSH/权限、GUI交互和真实模型仍未验收。GitHub默认/tag真实来源安装、双平台CI和公开v0.2.0及下载附件已验收，见[线上记录](GITHUB-RELEASE-VERIFY.md)；不是用本地烟测代替github来源。

## 以下为0.1.0历史验证（不是当前部署方式）

`pnpm run check` 独立安装依赖后类型检查/编译业务模块，执行原 282 项业务回归、服务端协议/身份测试与官方 DSH loop 集成；运行时与检查不读取原仓库或客户端源码。

覆盖独立账号签名/过期/nonce、未认证拒绝、固定 cwd、他人会话拒绝、稳定请求 ID 去重、断线取消与保留已提交记录、opening/draining 生命周期、真实 DSH 取消/错误和同 sessionId 持久化恢复、业务 plan_confirm 的可信账号快照、socket+stdio connector 与独立双成员单 PID 启动。

联合测试单独执行：`DSH_COLLABORATION_CLIENT_ROOT` 必须显式选择客户端目录；检查契约/protocol helper byte equality，并用客户端 adapter 与真实服务端替身运行时进行两轮与恢复验证。不是服务端常规运行依赖。

打包检查抽取 tarball，核验所有 entry/import 存在并启动其中的 fixture runtime；不从旧仓读取业务 lib。真实 Linux SSH/权限隔离、现用 GUI 0.2、真实模型尚未验收。服务器固定替身不调用模型网络、不消耗配额。

## 拆分后实测结果

Windows、Node 24.21.0、pnpm 11.7.0、服务端独立 fresh node_modules 和 lockfile：

- 类型检查、业务 build **PASS**。
- 业务回归 **282/282 PASS（64 suites）**。
- 接入/connector 单元测试 **14/14 PASS**。
- 官方真实 DSH 集成 **6/6 PASS**。
- 四项内存 mutation（owner-check、request-replay、forged-snapshot、mutable-identity）均被测试断言检出。
- tarball 内部 entry/import 与抽取后的 fixture runtime 启动 **PASS**。
- 新文档和迁入业务文档的相对链接审计 **PASS**。

迁入文件仅移除六处原有 EOF 空行、修复旧原型相对链接；正文与业务逻辑未改。新仓设置 CRLF-aware whitespace check 以保留原文换行。打包检查增加 PAX/GNU Unicode 长路径支持后，包含业务中文文档的 tarball 再次通过。

本仓现有 check 和包 smoke 都使用本仓依赖，不需缓存 hook 或原仓。服务端显式联合测试 **3/3 PASS**：契约一致、adapter 双轮与恢复、真实本地+远端 DSH loop 和辅助调用拒绝；客户端联合契约 **1/1 PASS**。

原型历史结果在[归档记录](history/acp-access-original-VERIFY.md)，不代替拆分后检查。检查日志位于忽略的 `.dsh/evidence`，不提交密钥/数据库/生成文件。全程没有使用 subagent，原仓库与现用 profile 保留不变。
