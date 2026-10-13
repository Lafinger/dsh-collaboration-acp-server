#!/bin/sh
set -eu
umask 077
node /opt/collaboration/initialize.mjs
if [ ! -f /srv/collaboration/ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /srv/collaboration/ssh/ssh_host_ed25519_key
fi
chmod 600 /srv/collaboration/ssh/ssh_host_ed25519_key
/usr/sbin/sshd -t
if [ ! -f /srv/collaboration/dsh-home/.credentials.yaml ]; then
  echo 'Codego single credential has not been provisioned. Awaiting explicit provisioning.' >&2
  # Keeps only the local bootstrap process alive; no SSH or DSH listener is started.
  trap 'exit 0' TERM INT
  while :; do sleep 60 & wait $!; done
fi
chown 1101:1101 /srv/collaboration/dsh-home/.credentials.yaml
chmod 600 /srv/collaboration/dsh-home/.credentials.yaml
cd /srv/collaboration/workspace
gosu dshsvc node /opt/collaboration/node_modules/@deepseek-ai/dsh/lib/bin.js --profile collaboration-server &
dsh_pid=$!
cleanup() {
  trap - TERM INT
  kill -TERM "$dsh_pid" "${sshd_pid:-}" 2>/dev/null || true
  wait "$dsh_pid" 2>/dev/null || true
  if [ -n "${sshd_pid:-}" ]; then wait "$sshd_pid" 2>/dev/null || true; fi
}
trap 'cleanup; exit 0' TERM INT
attempt=0
while ! node /opt/collaboration/health.mjs >/dev/null 2>&1; do
  if ! kill -0 "$dsh_pid" 2>/dev/null; then wait "$dsh_pid"; exit 1; fi
  attempt=$((attempt + 1)); if [ "$attempt" -ge 60 ]; then echo 'DSH readiness failed; SSH not started' >&2; cleanup; exit 1; fi
  sleep 1
done
/usr/sbin/sshd -D -e &
sshd_pid=$!
echo 'Simulator ready: one non-root DSH host and forced-command SSH' >&2
while kill -0 "$dsh_pid" 2>/dev/null && kill -0 "$sshd_pid" 2>/dev/null; do sleep 1; done
cleanup
exit 1
