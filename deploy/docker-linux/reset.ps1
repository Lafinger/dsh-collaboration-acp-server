param([switch]$ConfirmDeleteWithoutBackup)
$ErrorActionPreference = 'Stop'
if (-not $ConfirmDeleteWithoutBackup) { throw 'Explicit -ConfirmDeleteWithoutBackup is required. No data were changed.' }
$docker = Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin\docker.exe'
$container='dsh-collaboration-linux-sim'
$volume='dsh-collaboration-linux-sim-data'
$state = & $docker inspect $container --format '{{json .}}' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect simulator; refuse reset' }
if ($state.State.Running) { throw 'Stop the simulator first; do not delete live SQLite files' }
$mount = @($state.Mounts | Where-Object { $_.Type -eq 'volume' -and $_.Name -eq $volume -and $_.Destination -eq '/srv/collaboration' })
if ($mount.Count -ne 1) { throw 'Unexpected volume or destination; refuse reset' }
$users = & $docker ps -q --filter "volume=$volume"
if ($LASTEXITCODE -ne 0 -or $users) { throw 'A running container still uses this volume; refuse reset' }
$image='dsh-collaboration-linux-sim:0.3.0'
& $docker image inspect $image --format '{{.Id}}'
if ($LASTEXITCODE -ne 0) { throw 'Build and verify the new release image before any reset' }
& $docker run --rm --network none --entrypoint node -e COLLABORATION_OFFLINE_RESET=yes --mount "type=volume,src=$volume,dst=/srv/collaboration" $image /opt/collaboration/reset-state.mjs --confirm-delete-without-backup
if ($LASTEXITCODE -ne 0) { throw 'Offline reset failed; inspect safety condition, do not broaden deletion' }
# Deliberately no volume rm, down -v, prune, key rotation or backups.
