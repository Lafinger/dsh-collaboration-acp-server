# 钉钉通信与模型日志：停服保留维护

用户已明确选择：保留期清理同时覆盖通信数据库正文和本插件拥有的钉钉模型会话日志。默认／上限90天；不覆盖DSH会话、其他Host会话、正式资料／决定、个人原件、备份或平台已发副本。本次只实现并在临时数据上验证，未执行实际清理。

## 所有权与期限

- `collaboration_im_logs`在模型查询前登记来自实际Host JSONL持久化的精确root／directory／sessionId／cwd／创建header，不接受用户或模型提供路径。旧IM上下文只能从本库已记录的会话ID经实际持久化精确补登记，不扫描其他会话猜所有权。
- 一个日志按首次登记／创建起算保留期；达到期限不再resume，从新UUID继续只读查询。新查询不会续期旧正文，也不把旧会话文本拷到新上下文。
- 删除前提交`purge-planned`，删除后保留`purged`及时间。重启／重新授权／恢复都不能用旧ID重开模型，数据库去重、epoch、资格revision、通信metadata和审计不删除。
- 清理是显式维护，不是后台定时删除。管理员必须安排到期维护窗口；若尚未执行维护，磁盘仍留有过期日志，不能声称物理副本已经清除。备份／平台副本需另行管理。

## 停服前提与操作

1. 在隔离部署中先让新插件启动并正常停止一次，确保精确登记（这不是授权在现用生产上操作）。备份策略另行核对，注意备份本身仍包含正文。
2. 停止专属机器人和**整个持久化Host进程**，不只是断开SSH或卸载机器人。禁用进程监护器自动重启；Unix以服务账号操作，Windows必须同服务账号／会话环境操作。服务与维护共用不会因超时失效的内核租约；每个会话同时获取固定DSH0.2.0-rc.2 JSONL写锁。任一锁仍被持有则拒绝，不删锁文件／不杀其他进程／不盲重试。
3. 确认实际JSONL `root`的规范绝对路径。不能用DSH home、整个持久卷、workspace、项目分组目录或猜测路径代替。目录及祖先不能是符号链接／junction。未知后端或未来格式须另验证后才能启用此维护。
4. 在服务账号私有的mode0600文件中写入dry-run命令（路径只是示意，不是现有文件）：

```json
{
  "action": "purge-expired-communication",
  "confirmation": "PURGE_EXPIRED_IM_TRANSCRIPTS_AND_DATABASE_BODIES",
  "sessionRoot": "/srv/collaboration/dsh-home/sessions",
  "dryRun": true
}
```

```sh
node /absolute/package/src/maintenance-cli.mjs /absolute/private-server-config.json /absolute/private-maintenance-command.json
# 或已隔离安装的bin：
dsh-collaboration-maintenance /absolute/private-server-config.json /absolute/private-maintenance-command.json
```

5. 审核输出`sessionIds`、`expiredSessions`、`planHash`。dry-run不删正文；如`otherRegisteredRoots`非零，意味着以前更换过Host root，必须逐个登记根目录分别核对维护，不能声称所有副本已清理。
6. 在同一私有命令文件把`dryRun`改为`false`，加入`expectedPlanHash`为刚审核的hash，再执行同一命令。无hash／清单、文件身份／大小／mtime变化都会拒绝。不存在回退为递归清目录。
7. 核对审计与各ID状态；完成维护后再由管理员显式启动Host／机器人。命令返回`copiesInBackupsOrPlatformDeleted:false`，不承诺擦除备份、SQLite空闲页或平台消息。

## 删除边界与失败恢复

- 只遍历精确登记到期的 `root / 项目分组 / UUID` 一层叶文件。所有待清目录完整预检后才开始删除；会话header必须匹配ID、cwd、创建时间且未fork／seed，不删子目录、其他会话、未知文件、symlink或hardlink。
- 固定rc.2生成文件、zstd压缩及固定格式的迁移／写入暂存文件可清理。文件只逐个unlink，在删除前重新校验规范绝对路径和文件身份；POSIX稳定`session.lock`不删除，以免释放被别的写进程绕过。Windows无文件锁的空目录可删。
- 维护先取得本插件服务租约，逐会话取得与实际Host一致的写租约。服务租约覆盖整个通信／DSH runtime生命周期，直到Agent关闭和SQLite关闭。不能把这些检查当作其他用户恶意修改文件系统的防护；根目录必须保持服务账号私有。
- 正文部分删除后崩溃／磁盘故障时状态仍为`purge-planned`，旧ID不可resume。保持停服，重新dry-run剩余精确叶文件并审核新hash再apply；不取消tombstone、不删除数据库重建，不自动重发unknown通信。无法识别header／未知文件／锁失败时停止，人工核对，不扩大删除范围。
- 数据库过期正文随后用现有purge规则清除；pending／processing／sending仍保留供人工核对，不以清理改变投递事实。旧admin `purge`是数据库限定操作，返回`imTranscriptsPurged:false`与`requiresOfflineTranscriptMaintenance:true`，不能替代此命令。

## 验证边界

临时测试覆盖明文／zstd、近期限／未登记DSH不删、跨路径／junction／symlink／hardlink／header替换拒绝、hash变更、真实Host活动会话锁、运行中服务锁、中断tombstone恢复、保留epoch／正式项目，旧上下文精确补登记，以及真实物理清理并重启后的新ID、不回放旧正文。真实平台、生产日志清理与新Linux部署未执行；POSIX原生锁分支仍需对应Linux隔离验收，Windows已经核对真实Host会话锁命名契约。
