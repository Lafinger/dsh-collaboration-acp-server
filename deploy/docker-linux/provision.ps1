$ErrorActionPreference = 'Stop'
$serverRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$private = Join-Path $serverRoot '.dsh\docker-linux-sim'
if (-not (Test-Path -LiteralPath $private)) {
  New-Item -ItemType Directory -Path $private -ErrorAction Stop | Out-Null
  $account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $private /inheritance:r /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F'
  if ($LASTEXITCODE -ne 0) { throw 'Private directory ACL initialization failed' }
} else {
  throw 'Private directory already exists. This first-time provisioning script refuses to replace keys or credentials.'
}
$env:ELECTRON_RUN_AS_NODE = '1'
$process = Start-Process -FilePath 'C:\Users\cjh13\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' -ArgumentList @('deploy/docker-linux/provision-windows.cjs') -WorkingDirectory $serverRoot -NoNewWindow -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'First-time provisioning failed; inspect redacted error, do not retry overwriting data' }
& (Join-Path $PSScriptRoot 'control.ps1') Restart
