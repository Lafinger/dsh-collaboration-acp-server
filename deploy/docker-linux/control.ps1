param([ValidateSet('Build','Start','Stop','Restart','Status','Logs')][string]$Action = 'Status')
$ErrorActionPreference = 'Stop'
$dockerBin = 'C:\Users\cjh13\AppData\Local\Programs\DockerDesktop\resources\bin'
$docker = Join-Path $dockerBin 'docker.exe'
$env:PATH = "$dockerBin;$env:PATH"
# Docker's registry-auth client does not automatically read the Windows proxy setting.
if ($Action -eq 'Build') {
  $settings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($settings.ProxyEnable -eq 1 -and $settings.ProxyServer -match '^127\.0\.0\.1:\d+$') {
    $env:HTTP_PROXY = 'http://' + $settings.ProxyServer
    $env:HTTPS_PROXY = $env:HTTP_PROXY
    $env:NO_PROXY = '127.0.0.1,localhost'
  }
}
$argsForDocker = @('compose','--project-directory',$PSScriptRoot,'-f',(Join-Path $PSScriptRoot 'compose.yaml'))
switch ($Action) {
  'Build' { $argsForDocker += @('--progress','plain','build') }
  'Start' { $argsForDocker += @('up','-d') }
  'Stop' { $argsForDocker += @('stop','--timeout','45') }
  'Restart' { $argsForDocker += @('restart','--timeout','45') }
  'Status' { $argsForDocker += @('ps') }
  'Logs' { $argsForDocker += @('logs','--tail','80') }
}
& $docker @argsForDocker
if ($LASTEXITCODE -ne 0) { throw "Docker action failed: $Action" }
# Deliberately no down -v, volume rm, system prune or force data-reset operation.
