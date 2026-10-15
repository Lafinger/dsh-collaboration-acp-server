#!/usr/bin/env python3
"""One reviewed network-only change; never enroll a member, key, login or project.

The B account/public key still need independent verification. Until enrollment,
opening TCP does NOT authorize B's business access. No model/backend restart.
"""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import time
import sqlite3
import subprocess
import tempfile

LAN = '192.168.2.20'
SERVER = '10.242.169.184'
SOURCE = '10.242.66.179'
INTERFACE = 'ztfl6kpbcz'
PORT = 19482
CONFIG = Path('/etc/dsh-collaboration-ssh/sshd_config')
UNIT = 'dsh-collaboration-ssh.service'
COMMENT = 'dsh-collaboration-b-zerotier'
CONFIRMATION = 'ADD_B_ZERO_TIER_MEMBER_NETWORK_ONLY'
LAN_USERS = ['dt_f66d225ac622aaf111a0@192.168.2.*', 'dt_b7a8377e73575cacd1af@192.168.2.*']


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if result.returncode:
        # Do not dump environment/command output into a public error log.
        raise RuntimeError('Network maintenance command failed: ' + args[0])
    return result.stdout


def render_config(original):
    """Preserve all original bytes except one exact, additive ListenAddress line."""
    if '\r' in original or not original.endswith('\n'):
        raise RuntimeError('Unexpected dedicated SSH config encoding')
    directives = {}
    for line in original.splitlines():
        words = line.split('#', 1)[0].split()
        if not words:
            continue
        name = words[0].lower()
        if name in ('include', 'match'):
            raise RuntimeError('Indirect SSH policy requires separate review')
        directives.setdefault(name, []).append(' '.join(words[1:]))
    required = {
        'port': ['19482'], 'hostkey': ['/etc/ssh/ssh_host_ed25519_key'],
        'allowusers': [' '.join(LAN_USERS)],
        'forcecommand': ['/usr/local/libexec/dsh-collaboration-member-shell'],
        'authorizedkeysfile': ['/etc/dsh-collaboration-ssh/authorized_keys/%u'],
        'passwordauthentication': ['no'], 'kbdinteractiveauthentication': ['no'],
        'pubkeyauthentication': ['yes'], 'authenticationmethods': ['publickey'],
        'permitrootlogin': ['no'], 'permittty': ['no'], 'allowtcpforwarding': ['no'],
        'allowstreamlocalforwarding': ['no'], 'allowagentforwarding': ['no'],
        'x11forwarding': ['no'], 'permittunnel': ['no'], 'gatewayports': ['no'],
        'permituserenvironment': ['no'], 'permituserrc': ['no'],
    }
    for key, expected in required.items():
        if directives.get(key) != expected:
            raise RuntimeError('Dedicated SSH boundary differs: ' + key)
    addresses = directives.get('listenaddress')
    if addresses == [LAN, SERVER]:
        return original
    if addresses != [LAN]:
        raise RuntimeError('Unexpected listen addresses; refusing wildcard or replacement')
    return original.replace('ListenAddress ' + LAN + '\n', 'ListenAddress ' + LAN + '\nListenAddress ' + SERVER + '\n', 1)


def firewall_command(action='allow'):
    if action not in ('allow', 'delete'):
        raise ValueError('Unknown firewall operation')
    # Exactly one IPv4 host on the virtual interface, never a subnet or wildcard.
    source = str(ipaddress.IPv4Network(SOURCE + '/32', strict=True))
    rule = ['in', 'on', INTERFACE, 'from', source, 'to', SERVER, 'port', str(PORT), 'proto', 'tcp', 'comment', COMMENT]
    return ['ufw', 'allow', *rule] if action == 'allow' else ['ufw', '--force', 'delete', 'allow', *rule]


def has_rule(status):
    for line in status.splitlines():
        if '#' not in line:
            continue
        policy, comment = line.split('#', 1)
        if comment.strip() != COMMENT:
            continue
        policy = re.sub(r'^\[\s*\d+\]\s*', '', policy).split()
        if policy == [SERVER, str(PORT) + '/tcp', 'on', INTERFACE, 'ALLOW', 'IN', SOURCE] or policy == [SERVER, str(PORT) + '/tcp', 'on', INTERFACE, 'ALLOW', 'IN', SOURCE + '/32']:
            return True
    return False


def trusted_file(path):
    """This operation only accepts root-owned regular files under trusted parents."""
    path = Path(path)
    for parent in (path.parent, *path.parents[1:]):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Unsafe maintenance parent')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_mode & 0o022:
        raise RuntimeError('Unsafe maintenance file')
    return info


def atomic_config(data, expected):
    info = trusted_file(CONFIG)
    if CONFIG.read_bytes() != expected:
        raise RuntimeError('SSH config changed during maintenance')
    fd, name = tempfile.mkstemp(prefix='.zerotier-reviewed-', dir=CONFIG.parent)
    candidate = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), 0, info.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        run('/usr/sbin/sshd', '-t', '-f', str(candidate))
        if CONFIG.read_bytes() != expected:
            raise RuntimeError('SSH config changed before replacement')
        os.replace(candidate, CONFIG)
    finally:
        # Only our own mkstemp leaf in the already verified parent; no recursive cleanup.
        if candidate.exists():
            candidate.unlink()


def listeners():
    return run('ss', '-H', '-ltn', 'sport = :19482')


def wait_listeners():
    # sshd HUP closes/rebinds asynchronously. Poll only this bounded readiness
    # check; never retry the config write, firewall mutation or reload itself.
    for attempt in range(30):
        actual = listeners()
        if LAN + ':19482' in actual and SERVER + ':19482' in actual:
            return
        if attempt < 29:
            time.sleep(0.1)
    raise RuntimeError('Both exact member listeners must be present')


def require_idle_business():
    # An authenticated client keeps an idle SSH transport open. sshd HUP
    # preserves established children, so refuse in-flight business, not the
    # mere presence of a connected client; never kill/disconnect that client.
    path = Path('/srv/dsh-collaboration-test/private-state/access.sqlite')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 996:
        raise RuntimeError('Unexpected access metadata file')
    database = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=3)
    try:
        database.execute('PRAGMA query_only=ON')
        if database.execute("SELECT count(*) FROM access_requests WHERE state='running'").fetchone()[0]:
            raise RuntimeError('Business request active; wait for idle maintenance window')
    finally:
        database.close()


def apply():
    if os.geteuid() != 0:
        raise RuntimeError('Root maintenance environment required')
    trusted_file(CONFIG)
    original = CONFIG.read_bytes()
    rendered = render_config(original.decode('utf-8')).encode('utf-8')
    interfaces = json.loads(run('ip', '-j', '-4', 'addr', 'show'))
    addresses = {(row['ifname'], item['local']) for row in interfaces for item in row.get('addr_info', []) if item.get('family') == 'inet'}
    if (INTERFACE, SERVER) not in addresses or not any(addr == LAN for _, addr in addresses):
        raise RuntimeError('Expected existing LAN and ZeroTier addresses are required')
    require_idle_business()
    if run('systemctl', 'is-active', UNIT).strip() != 'active':
        raise RuntimeError('Dedicated SSH service must already be active')
    backend_before = run('systemctl', 'show', 'dsh-collaboration-backend.service', '-p', 'MainPID', '-p', 'ActiveState')
    firewall = run('ufw', 'status', 'numbered')
    if 'Status: active' not in firewall:
        raise RuntimeError('Existing active firewall required; never enable/disable it here')
    rule_before = has_rule(firewall)
    if rendered == original and rule_before:
        if LAN + ':19482' not in listeners() or SERVER + ':19482' not in listeners():
            raise RuntimeError('Config is present but listeners are not; explicit review needed')
        return {'changed': False, 'alreadyApplied': True, 'memberAuthenticationStillRequiresEnrollment': True}
    added_rule = False
    changed_config = False
    try:
        # Validate the existing SSH config before any firewall or file change.
        run('/usr/sbin/sshd', '-t', '-f', str(CONFIG))
        if not rule_before:
            run(*firewall_command())
            added_rule = True
            if not has_rule(run('ufw', 'status', 'numbered')):
                raise RuntimeError('Exact B firewall rule was not confirmed')
        if rendered != original:
            atomic_config(rendered, original)
            changed_config = True
            run('systemctl', 'reload', UNIT)
        wait_listeners()
        if run('systemctl', 'show', 'dsh-collaboration-backend.service', '-p', 'MainPID', '-p', 'ActiveState') != backend_before:
            raise RuntimeError('Backend state changed unexpectedly')
    except Exception:
        if changed_config:
            atomic_config(original, rendered)
            run('systemctl', 'reload', UNIT)
        if added_rule:
            run(*firewall_command('delete'))
        raise
    return {'changed': True, 'lanPreserved': True, 'zeroTierListen': SERVER + ':19482',
            'newFirewallSource': SOURCE + '/32', 'newFirewallInterface': INTERFACE,
            'accountAllowUsersUnchanged': True, 'authorizedKeysUnchanged': True,
            'memberAuthenticationStillRequiresEnrollment': True, 'backendRestarted': False,
            'businessDatabasesTouched': False, 'modelCalls': 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirmation')
    args = parser.parse_args()
    if not args.apply or args.confirmation != CONFIRMATION:
        parser.error('Explicit --apply and exact network-only confirmation required')
    print(json.dumps(apply(), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'errorType': type(error).__name__, 'message': str(error)}))
        raise SystemExit(1)
