# 协作服务v0.3.0 Docker更新验收

状态：当前插件源码已改名并通过本地与main双平台CI；新GitHub标签已推送，正式发布/固定锁文件/镜像构建与无备份清空部署仍实施中。最终结果须填入实测事实，不以计划代替完成。

- 客户端v0.2.0、服务端v0.3.0、协作扩展v2（基础ACP-shaped版本1）；无旧接口别名，旧版/缺失版本拒绝。
- 默认客户端配置改为用户home/.dsh/dsh-collaboration-client/collaboration-client.json，无旧路径回退，仍可显式配置。
- Docker保持正式DSH0.2.0-rc.2、Codego固定模型、非rootDSH、forced connector/两成员独立凭据和2CPU/2GiB/专用卷、三地址22222，来源网段不限制但需成员密钥。
- 此轮不调用真实Codego；隔离回归使用模型替身、临时数据库。实际SSH权限/协议检查不提交业务prompt。
- 无备份清空只删批准业务与会话/access/test状态，不删卷/凭据/密钥/普通Windows DSH历史。用户自行清理两台客户端映射库并重装新版本，旧会话不能恢复。
- 旧版Docker/跨设备GUI证据保留在[历史记录](VERIFY-LEGACY-v0.2.0.md)，本次新版两台GUI由用户后续重新测试，不能用旧版结果冒充新版通过。

## 待填实测

正式Release、包hash与固定来源安装；固定锁文件commit、镜像版本/ID；offline reset删除列表及身份保留结果；真实SSH双账号/版本拒绝/forced-command/公钥负例/Linux文件隔离；最终空业务表/访问元数据/模型会话、daily、0请求、healthy与三地址映射。
