# 两台Windows客户端重装与新一轮测试

服务器已更新正式v0.3.0并清空旧项目、业务资料、服务端会话/access请求与测试计数，**没有备份**；Codego、成员认证、服务器SSH主机身份和成员密钥保持。旧本地会话远端记录不可恢复，不在旧会话里点重试。

## 1. 先停止旧插件，清理仅插件映射

两台分别关闭collaboration-client组件并退出DSH；然后卸载旧插件。卸载不会保证删除旧databasePath外置SQLite。

先检查你该成员以前客户端JSON中的databasePath，确认是本插件专用映射数据库，**不是普通DSH聊天库或服务器业务库**。只删该文件与-wal/-shm边车，不备份、不删目录/密钥/known_hosts。若旧JSON已删除，无法确认库用途则先不要猜测删除；用新配置独立新库仍能重新测试。

```powershell
# 必须用已核对的旧客户端databasePath替换；不能填.dsh目录或普通会话库。
$oldDb = '完整绝对路径/该成员旧插件专用.sqlite'
if (-not [IO.Path]::IsPathFullyQualified($oldDb) -or
    [IO.Path]::GetExtension($oldDb) -notin @('.sqlite','.db')) { throw '需要核对的完整数据库路径' }
if (Test-Path -LiteralPath $oldDb) {
  $item = Get-Item -LiteralPath $oldDb
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw '拒绝目录或链接，先核对目标'
  }
  Write-Host "将删除插件专用数据库：$($item.FullName)"
  # 人工确认这个确实是旧插件mapping库后才执行下列删除：
  foreach ($suffix in @('', '-wal', '-shm')) {
    $target = $oldDb + $suffix
    if (Test-Path -LiteralPath $target) {
      $file = Get-Item -LiteralPath $target
      if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '拒绝未知链接目标' }
      Write-Host "核对删除：$($file.FullName)"
      Remove-Item -LiteralPath $file.FullName -ErrorAction Stop
    }
  }
}
```

不删除整个用户.dsh，不删除普通聊天/项目目录，不移动或轮换私钥。Bob以前专用目录collaboration-bob中的成员密钥/known_hosts也保留；只清其已核对的旧mapping库。

## 2. 安装固定客户端v0.2.0

DSH插件页安装来源：

```text
github:Lafinger/dsh-collaboration-client#v0.2.0
```

[客户端公开Release](https://github.com/Lafinger/dsh-collaboration-client/releases/tag/v0.2.0)也提供tgz。确认加载的是0.2.0而不是旧缓存副本；不要使用宿主版本豁免。

## 3. 每台建立各自新默认配置

两台都放到**当前登录用户**下面：

```text
%USERPROFILE%\.dsh\dsh-collaboration-client\collaboration-client.json
```

Alice即用户cjh13的此目录；Bob即另一台实际登录用户（之前admin）的此目录。不能把Alice的绝对路径原样发给Bob，也不要分享双方密钥目录。

创建目录后编辑文件（如已存在先读取核对，不自动覆盖）：

```powershell
$dir = Join-Path $env:USERPROFILE '.dsh\dsh-collaboration-client'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$configPath = Join-Path $dir 'collaboration-client.json'
Test-Path -LiteralPath $configPath
```

模板（所有PATH必须替换为该台自己的绝对路径，不能直接使用占位符）：

```json
{
  "serviceId": "docker-linux-sim",
  "databasePath": "C:/Users/YOUR_USER/.dsh/dsh-collaboration-client/client.sqlite",
  "ssh": {
    "host": "127.0.0.1",
    "port": 22222,
    "account": "alice",
    "identityFile": "ABSOLUTE_PATH_TO_EXISTING/alice_ed25519",
    "knownHostsFile": "ABSOLUTE_PATH_TO_EXISTING/known_hosts",
    "sshExecutable": "C:/Windows/System32/OpenSSH/ssh.exe"
  }
}
```

| 参数 | Alice本机 | Bob另一台Windows |
|---|---|---|
| host | 127.0.0.1 | 10.242.14.211（ZeroTier）；LAN可用192.168.2.27但外部LAN未新测 |
| account | alice | bob |
| identityFile | 原服务器仓库忽略目录.dsh/docker-linux-sim/alice_ed25519的实际绝对路径 | 原用户.dsh/collaboration-bob/bob_ed25519的实际绝对路径 |
| knownHostsFile | 原.dsh/docker-linux-sim/known_hosts实际绝对路径 | 原用户.dsh/collaboration-bob/known_hosts实际绝对路径 |
| databasePath | 本机新插件目录client.sqlite | Bob本机新插件目录client.sqlite，不能共用远程盘库 |
| serviceId/port | docker-linux-sim / 22222 | 相同 |

旧根目录默认collaboration-client.json**不再自动读取**。若以前组件configFile或环境DSH_COLLABORATION_CLIENT_CONFIG显式指向旧文件，需要自行清除/改为新路径；完整inline仍可用。默认provider/model为collaboration-remote/server-agent，显示**协作服务**，不必写入JSON。

服务器主机指纹未改变：

```text
SHA256:cbJb7w9mffMKym1ECHp5oTV+X2RinPMf92D2u1s5ziM
```

保持StrictHostKeyChecking；如不匹配先停下核对，不删除known_hosts绕过验证。客户端不放服务端HMAC、模型API Key或另一个成员私钥。

## 4. 启用后必须新建会话

重新打开组件，看到配置完整后，在**新建本地会话**中选择 **collaboration-remote / 协作服务（server-agent）**，不是本机Codego模型。

服务器机器保持开机/Docker Desktop运行；Bob测试两端ZeroTier在线/已授权。另一客户端无需Docker/Codego凭据。

建议新一轮开始时只读测试：

1. 各成员新会话明确发一次身份查询，核对Alice/alice与Bob/bob。
2. 明确发一次project_list，当前应无项目（开始真实模型测试后requests计数会正常增加）。
3. 如需新写测试项目，由用户明确给出创建请求；不要复制旧会话的历史指令当“恢复”。

本次已验证新版真实SSH/权限/版本协商，不调用真实模型。**新版两台GUI和真实模型业务由你上述操作重新测试**，尚未替你宣称通过。遇到TIMEOUT或COLLABORATION_NO_REPLAY不要自动重发写入，先核对实际提交结果；旧轮次Bob超时根因没有被命名改动证明修复。
