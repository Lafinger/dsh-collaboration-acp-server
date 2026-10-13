# 服务端v0.3.0正式发布验收

## 发行身份

发行提交d61e073afee4d62259d289669906719daeb1704e，带注释标签v0.3.0。旧v0.2.0不可变标签/附件未改；部署及最终证据是发行后的独立main提交，不移动新发行标签。

- [main CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38338933146)、[tag CI/Release](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38339274923)success，Windows/Ubuntu检查与单份Linux打包通过。
- [公开Release](https://github.com/Lafinger/dsh-collaboration-acp-server/releases/tag/v0.3.0)，非draft/非prerelease，官方tgz+SHA256SUMS+release.json三附件齐全。包SHA256：7cca615dc33a4edc6e33cc429e340631b48e081d491d9ae507f71008963bea68，下载核对hash/commit/tag一致。
- 抽取171文件，业务lib/main/import/bin/disabled bundle/精确宿主peers/MIT核验及安全挂载PASS，无安装时编译、无npm/插件市场发布。

固定安装：

```text
github:Lafinger/dsh-collaboration-acp-server#v0.3.0
```

从固定GitHub tag隔离安装，正式DSH服务借用同一宿主ctx，模型替身执行身份查询PASS；不网络调用真实模型。现用DSH0.2.0-rc.2真实installer接受下载tgz，专用collaboration-compat-rename-server-v030 profile，默认disabled，不启动现用profile或第二套服务器；host-supplied peer提示不通过版本豁免消除。

## 验证

98业务编译文件与源一致，282业务+29发行单元+12正式宿主接口集成+3显式联合PASS；4安全mutation被检出。后续main另增connector旧响应拒绝回归，服务端单元变30；生产发行connector已有严格响应检查，新增只补测试，不修改tag。协作扩展v2、基础ACP-shaped版本1分开，无旧别名/重放/降级；客户端0.2.0契约/helper byte equality PASS。

命名审计覆盖当前src/business/lib/脚本/配置/docs/deploy，明确历史来源/旧发行证据/真实宿主绝对路径例外。全程未使用subagent，不改原仓库/宿主目录/Git历史/第三方依赖。

## 正式部署源码

- 5e72155669a989a51a64667155646e4bf721de54提交Docker完整来源、固定v0.3.0 lock与离线reset，[双平台CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38339666880)success。
- 88837469355b27fe39388781645bdb5b8de0623b补Linux保留profile链接边界/connector旧响应测试，[双平台CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38339909250)success。
- Docker只安装lock中固定发行提交，没有临时覆盖发布包、没有main浮动依赖。实际镜像/删除事实/保留身份/SSH/最终空状态详见[Docker验收](../deploy/docker-linux/VERIFY.md)。

本轮不调用真实Codego。新版两台GUI由用户后续卸载重装及人工重测，不把旧GUI或替身结果冒充新版真实模型通过。
