# GitHub-only 插件构建发布

仅GitHub发布，不发布npm或DSH插件市场；private:true保留，许可证[MIT](../LICENSE)。下载官方依赖可能访问npm，与发布本包无关。

## 本轮0.5.0例外：仅固定提交部署，不创建tag／Release

先独立保存现用Ubuntu已部署基线，再提交CPA／图片增量；main双平台CI与包检查全部成功后按完整SHA及该次核验包同步Ubuntu。旧公开v0.4.2早于现用钉钉基线，不能用它替代升级源。操作见[Ubuntu部署](<../deploy/ubuntu/README.md>)。以下tag流程是通用历史，不在本轮执行；客户端0.5.3在其独立仓库正式发行。

## 来源安装

```text
github:Lafinger/dsh-collaboration-acp-server
github:Lafinger/dsh-collaboration-acp-server#v0.4.2
```

默认入口读取main，不自动下载latest Release。首个宿主插件发行版v0.2.0，精确DSH0.2.0-rc.2、Node>=24；安装默认禁用，无prepare/install/prepack编译脚本。业务源码和核验后的JS/声明文件均提交，CI拒绝源码与产物不符，而不是重建后掩盖问题。

隔离installer示意，不对现用profile执行：

```sh
dsh plugin --profile collaboration-compat-server-github add github:Lafinger/dsh-collaboration-acp-server --ignore-scripts
```

## 工作流

[Actions](../.github/workflows/release.yml)：PR/main/手动触发仅检查与打包；v*标签先验版本等于包版本、提交属于main，再由Windows+Ubuntu检查、单份Linux打包核验、下载该artifact后发布。Node24.21.0/pnpm11.7.0、冻结lockfile、安装脚本禁用；包内没有测试状态/凭据/私钥。业务源码变更需明确build再提交，日常check额外验证98项编译文件。

仅Release job有contents:write，PR不使用pull_request_target，不配置NPM_TOKEN/市场token。Release以draft上传版本化tgz、SHA256SUMS、release.json后公开，已存在附件逐一核验；同内容可重跑，差异停止要求升版，不覆盖公开发行版/标签。

## 后续发布

1. 修改源码并升package.version，更新必要文档，`pnpm run build`同步业务产物。
2. 冻结安装、check、打包检查通过，push main并等待CI成功。
3. 创建对应带注释tag并push，例如下一次v0.3.1：

```sh
git tag -a v0.3.1 -m "Release v0.3.1"
git push origin v0.3.1
```

4. 验证Actions、公开Release、附件hash和固定tag安装。prerelease版本自动标预发布，不覆盖latest。

[发布脚本](../scripts/publish-github-release.mjs)采用草稿→公开、严格内容比较。失败draft保留诊断，删除/修复前核查原因，不强制重打tag。发布是分发验收，不是LinuxSSH、真实模型或GUI业务验收；启用步骤见[部署](DEPLOYMENT.md)。
