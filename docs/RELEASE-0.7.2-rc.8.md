# 0.7.2-rc.8 发行说明：成果原件内网下载链接

> 版本号：包版本 `0.7.2-rc.7` → `0.7.2-rc.8`；不发布 npm／插件市场，`private: true` 不变。决定记录：[ADR-0010](<adr/0010-result-files-via-lan-bearer-links.md>)。

## 为什么改

下游角色在钉钉收到的成果通知只有文本预览：`material_read` 只返回解析文本，PDF/XLSX/图片拿不到原始字节；`result_list` 的文件项只有路径、哈希和大小；客户端也没有下载通道。结果是下游能看到"上游交了成果"，却拿不到成果原件。

## 改了什么

- **新增下载令牌服务**：`result_download_tokens` 表按 `(result_id, version)` 记录令牌、过期时间、下载次数与最后下载时间。同一成果版本在有效期内复用同一令牌，令牌为 32 字节随机值的 base64url。
- **新增内网下载端点**：`download: { port, hosts }` 配置下，后端进程为每个 host 绑定一个无鉴权 HTTP listener。`/d/<token>` 列出该成果版本的全部原始文件，`/d/<token>/<position>` 流式返回原始字节。
- **通知带链接**：成果通知在头部之后插入"下载原件（30天内有效）"与局域网／ZeroTier 两条地址。链接由服务端生成，不经过保存文本的屏蔽函数；没有附件的成果不生成链接。
- **令牌过期 30 天**：过期返回 410，需要重新发送通知。

## 验证

- 服务端 `node scripts/check.mjs`：**exit 0**（单元 253 项 250 过 0 败 3 跳过；集成 79/79）。
- 客户端 `node scripts/check.mjs`：**exit 0**（单元 143、集成 63）。
- 双端联合 `test/joint/client-server.joint.mjs`：3/3。
- 新增 `test/result-download.test.mjs`：令牌复用、过期、页面只列本成果文件、字节一致、下载计数、HTTP 端到端。
- `test/robot-format.integration.mjs`：链接原样保留、不被屏蔽、无附件时不出现。

## 边界

- 链接是 bearer URL：持有链接即可下载，不校验成员身份；只绑定内网与 ZeroTier 地址，不开公网。
- 本轮只覆盖通知对应的成果附件，不覆盖项目全部资料。
- 不支持断点续传、打包下载、在线预览。
- 不改协作协议、不改客户端、不需要重新安装插件。

## 部署

配置文件加入 `download` 段并在防火墙放行该端口到两个内网地址；重启后端即可。详见 [运行与数据维护](<OPERATIONS.md#成果原件下载入口>)。
