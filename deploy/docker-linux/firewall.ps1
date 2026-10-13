param([ValidateSet('Install','Remove','Inspect')][string]$Action = 'Inspect')
$ErrorActionPreference = 'Stop'
$AllowName = 'DSH-Collaboration-Linux-Sim-SSH-22222'
$LegacyBlockName = 'DSH-Collaboration-Linux-Sim-SSH-22222-BlockOutside'
$Names = @($AllowName,$LegacyBlockName)
if ($Action -eq 'Inspect') {
  foreach ($name in $Names) {
    $rule = Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue
    if ($rule) {
      $rule | Select-Object Name,Enabled,Direction,Action,Profile
      $rule | Get-NetFirewallPortFilter
      $rule | Get-NetFirewallAddressFilter
    } else { Write-Output "Not installed: $name" }
  }
  return
}
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script in an Administrator PowerShell. No settings were changed.' }
if ($Action -eq 'Remove') {
  # Only these dedicated simulator rules, never existing Docker or system rules.
  foreach ($name in $Names) { if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) { Remove-NetFirewallRule -Name $name } }
  return
}
foreach ($name in $Names) { if (Get-NetFirewallRule -Name $name -ErrorAction SilentlyContinue) { throw 'Dedicated simulator rule already exists; inspect/remove it explicitly before installing the new policy.' } }
# User-selected policy: no source IP/subnet restriction, still SSH public-key authentication.
# Optional fallback if Docker's existing application rules are absent; not needed on this host now.
New-NetFirewallRule -Name $AllowName -DisplayName 'DSH collaboration Linux simulator SSH 22222' -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalPort 22222 -LocalAddress @('192.168.2.27','10.242.14.211') -RemoteAddress Any -Description 'User-selected unrestricted source addresses; only simulator SSH port and confirmed LAN/ZeroTier addresses. SSH keys remain mandatory.' | Select-Object Name,Enabled,Direction,Action
