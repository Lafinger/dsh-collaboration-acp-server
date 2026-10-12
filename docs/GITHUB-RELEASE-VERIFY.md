# 宿主插件首版验收：v0.2.0

## 改造与MIT上传

- `a7de034854b3d38d02c60e040f35685f55236b71`：真正宿主插件、0.2精确接口、会话/工具隔离、有序生命周期、无安装构建分发、GitHub Actions和MIT。
- `6680d81206f38bcafa03c38bbe993978265e6e98`：握手名称和版本从包元数据读取，是v0.2.0标签提交。
- GitHub识别[MIT许可证](https://github.com/Lafinger/dsh-collaboration-acp-server/blob/main/LICENSE)，private:true保留；无npm或插件市场发布。
- [最终main CI](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38241153302)：Windows/Ubuntu/check/打包全部success，非tag跳过Release。

## GitHub来源实际安装

```text
github:Lafinger/dsh-collaboration-acp-server
github:Lafinger/dsh-collaboration-acp-server#v0.2.0
```

两种来源通过本机真实DSH0.2.0-rc.2 installer，专用collaboration-compat-server-* profile注册package和bundle。默认来源另验普通安装不加ignore-scripts，也退出0。禁止脚本时pnpm有“git-hosted可能需要构建”提示，但包没有prepare/install/prepack，已提交业务lib实际可用；无需成员批准编译脚本。

来源安装副本使用应用内真实官方模块跑4项插件/在途禁用/冷恢复回归，均通过；固定tag额外跑7项身份/connector/错误/配置回归通过。测试是实际宿主模块的隔离Context，不是已运行GUI的端到端操作，也不是本地tarball代替github来源。

独立来源安装脚本为default与tag分别安装精确宿主依赖作为测试宿主、禁用构建脚本并在安装副本执行whoami、关闭插件运行时后host factory存活，均PASS；这些依赖仅为测试宿主，不是为了消除真实profile的host-supplied peer提示。

## 测试与数据边界

- 本地完整：282业务回归、28单元、12集成；业务源码与98个提交编译文件一致。
- 联合客户端3用例PASS；四项owner/replay/forged snapshot/mutable identity mutation被断言检出。
- 源码使用实际应用模块的6项关键测试PASS；包抽取、真实tarball安装及安装副本测试PASS。
- 仅删除用户明确批准的packed-MaJpa0/.state、packed-DxvRsp/.state、packed-8tCuBL/.state三处烟测试验数据；其他状态、原仓库、客户端代码与现用desktop/acp未改。
- 测试无付费模型请求；未配置真实SSH账号、密钥、sshd或正式业务库。

## 公开Release及附件

[v0.2.0发布Actions](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38241290126)四个job全部success；[Release](https://github.com/Lafinger/dsh-collaboration-acp-server/releases/tag/v0.2.0)已公开、非draft、非prerelease。

附件为版本化tgz、SHA256SUMS、release.json。实际下载核验hash、commit、GitHub-only标志和169个包内文件及抽取插件挂载PASS。tgz SHA256：

```text
bc4b5342f4a26f5297ac1fb8f3a4fea93cb09af0149bf46c7e6e5c51c3fc325f
```

本机直接Node fetch重跑因GitHub直连ECONNRESET/超时未通过；改在GitHub runner只重跑发布job，沿用原artifact，[重跑job](https://github.com/Lafinger/dsh-collaboration-acp-server/actions/runs/38241290126/job/114786537917)输出existing assets were never overwritten，success；附件hash及createdAt/updatedAt均未变化，没有重新上传。

安装固定tag使用应用内官方模块的4+7项回归通过，另有7项固定版本握手/归属/拒重检查PASS。宿主模块隔离测试不代替现用GUI全profile启动或真实LinuxSSH部署；本轮没有相应验收结论。

Actions运行存在官方action Node20兼容运行提示及ubuntu-latest将更新镜像的通知，不影响本次成功；项目测试Node版本固定24.21.0。此文档单独提交到main，不移动tag或覆盖发布附件。
