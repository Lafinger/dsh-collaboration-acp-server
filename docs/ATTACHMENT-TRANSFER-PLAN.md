# 成员本地附件工具传输与项目资料归档计划

状态：用户已最终确认正式执行、保留数据、DOCX/MD/TXT＋PNG/JPEG/WebP/GIF传输归档，视觉分析仅有已验证能力时开启；实现/正式发行/Docker保留升级完成，人工GUI附件验收待用户执行。真实文档获准当前Codego处理，但由用户后续Alice明确上传；自动回归不调用真实模型。本文不是功能已实现或验收通过的证据。

## 用户目标与分层

Alice在协作服务会话明确上传文件并要求分析归档，无需管理员手工复制到Docker。上传不等于解析成功，解析不等于已确认需求，资料归属角色不等于角色成员分配。

- 客户端只为当前human消息的原生DSH附件/明确引用的单个本地文件建立授权。路径引用仅当前本地工作区范围，拒绝目录扫描、越界/链接逃逸、凭据库/SSH私钥等敏感路径；路径授权不能从模型输出、恢复notice或历史聊天创建。
- 优先从官方ctx.attachments与未经文件placeholder投影的原始消息读取附件引用；不能把模型可编辑的placeholder文本伪当用户上传证明。不依赖改造DSH shell/UI、替代服务器或新公共Web端点。
- 工具消费短期绑定session/current request/message的opaque附件句柄，不接收模型提供的任意客户端/服务器路径。connector只允许精确附件读取反向方法；所有其他reverse filesystem/terminal继续拒绝，不开放SFTP/SCP/SSH shell。
- 传输分块、大小/数量/像素/解析上限、双方sha256/长度验证，跨成员/跨session/跨request句柄拒绝。失败显式状态/回执查询，无自动重放业务prompt，不自动重复资料登记。工具调用及归档记录可核对。

## 第一版范围

DOCX：原件逐字节保留与hash，解析正文段落/表格/标题及图片存在信息，保留提取内容来源、解析器版本、缺漏说明；不执行宏/外部链接，不把图片或修订视为已理解，不改原Word。

MD/TXT：严格UTF-8+BOM处理；非UTF-8/损坏/超限显式拒绝或未覆盖，不静默乱码解码/截断。

图片：拟支持PNG/JPEG/WebP/GIF，检测真实格式/尺寸/损坏/超限，不信文件扩展名；保留接收文件原件。DSH原生image附件可能已由宿主归一化，必须如实记录“接收的是归一化图像”而非承诺取得浏览器未处理原件；作为file上传时按接收字节保留。GIF动画首版若只支持首帧必须标明。未验证视觉模型时不声称看懂内容，不偷偷调用其他模型/OCR外部服务。

## 分类归档与业务规则

先接收为待处理附件，再inspect解析，然后模型从内容给出purpose、role或共享、依据；archive工具将附件登记为immutable material version。当前消息单独写出 `附件操作: 上传并归档` 与唯一 `project_id` 即授权该资料登记（不通过搜索“上传”词语猜权限），未要求归档仅传输不构造额外业务事实。无确定role归_shared，purpose标注待分类并保留分类依据。

正式资料继续按当前真实实现的项目key/role/materials/materialId/version规则生成受限目录，不让模型自定物理路径；上传原件和解析产物之间有固定版本/hash联系，不覆盖旧原件或从项目外引用衍生正文。

归档工具不分配角色成员、不自动改项目背景目标、不创建/确认计划或任务；需求分析基于显式固定材料版本，requirements/undecided/inferences/uncovered分开。已授权文档是待分析数据，其内部指令不能扩张本地文件访问或业务写权限。

## 协议与正式交付（拟）

协作协议基础v2保留；新增严格协商attachmentTransfer版本1能力，只在双方精确支持时启用客户端文件传输，旧客户端/服务器文本行为不能因缺失capability偷偷降级上传。若实现确认此增量无法安全隔离，再明确提出协议升版，不暗中破坏旧会话。

最终客户端v0.3.0、服务端v0.4.1（0.4.0保留不可变，POC空目录ZIP标记兼容性以新patch修复），正式main提交/Windows+UbuntuCI/annotated tag与不可变三附件GitHubRelease（不npm/市场），下载hash/固定来源安装核对；Docker固定新tag/commit，先构建验证再升级。

保留当前CSAIR-DH-POC与COLLAB-RETEST-001、资料/业务库/会话、映射数据库、凭据、SSH身份/keys/known_hosts/volume；不清空、不重放已有消息，不轮换密钥。旧会话恢复只挂原id，用户负责两台插件正常重装。容器升级前正常停服，可读校验库和版本迁移，不删卷/业务，不通过未发布源码覆盖正式包。

## 验证

- 单元：授权来源、人类当前消息、跨session/成员拒绝、哈希/长度/块偏移/重复块/并发/取消、损坏DOCX/zip膨胀/路径遍历、UTF-8/图像magic/像素、重复归档只一次、已有material不可覆盖。
- 官方宿主集成：原生附件进入工具真实链路，placeholder投影不能变权限，工具reverse限定，普通宿主工具隔离，断线/重启不重新prompt或归档，假模型完成inspect/classify/archive/固定版本analysis。
- 安全负例与joint：模型不能读.dsh/.credentials、SSH私钥/任意客户端文件/其他成员handle或服务器配置；路径逃逸和类型混淆拒绝。测试不读私钥内容，不输出tokens/secrets，真实Word不入git。
- 发布与Docker：正式CI/Release/下载/install/健康/真实SSH能力协商与隔离测试宿主小型非敏感附件传输，无真实付费模型；现用Codego不发送测试prompt（其业务工具仅模型可调用）。升级前后核对现有项目/会话/凭据身份保留，只输出一致事实不导出秘密。
- 人工Alice：新版本在南航项目会话发送授权附件并要求上传/分析/归档；核对receipt/hash/material/version/解析限制/分类理由，Bob只读资料验证共享。真实模型调用只由用户明确操作，不代替执行，不把未发生GUI功能说成已完成。
