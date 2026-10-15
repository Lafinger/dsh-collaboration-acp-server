#!/usr/bin/env python3
"""Enroll one verified B public key, never replace identity or read private keys.

Requires a root-owned 0600 manifest; exact employee ID is rechecked in the
existing scoped identity store. No project writes, login, model or backend restart.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import struct
import tempfile

spec = importlib.util.spec_from_file_location('reviewed_member_network', Path(__file__).with_name('member-zerotier.py'))
net = importlib.util.module_from_spec(spec)
spec.loader.exec_module(net)
CONFIG = net.CONFIG
B_ACCOUNT = 'dt_b7a8377e73575cacd1af'
A_ACCOUNT = 'dt_f66d225ac622aaf111a0'
KEY_ROOT = Path('/etc/dsh-collaboration-ssh/authorized_keys')
DATABASE = Path('/srv/dsh-collaboration-test/private-state/collaboration.sqlite')
CONFIRMATION = 'ENROLL_VERIFIED_B_SINGLE_ZERO_TIER_KEY'
EMPTY_KEYS = b'# No device key enrolled; member cannot authenticate yet.\n'


def public_key(value):
    if not isinstance(value, str) or len(value) > 1000:
        raise RuntimeError('Expected one bounded public key')
    match = re.fullmatch(r'ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?', value)
    if not match:
        raise RuntimeError('Only a plain Ed25519 public key is allowed')
    encoded = match.group(1)
    blob = base64.b64decode(encoded, validate=True)
    if base64.b64encode(blob).decode() != encoded:
        raise RuntimeError('Noncanonical public key encoding')
    expected = struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32)
    if len(blob) != len(expected) + 32 or not blob.startswith(expected):
        raise RuntimeError('Invalid Ed25519 public key payload')
    fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip('=')
    return 'ssh-ed25519 ' + encoded + ' dsh-collaboration-b', fingerprint


def validate_manifest(value):
    keys = {'version', 'account', 'employeeUserId', 'source', 'publicKey', 'publicKeyFingerprint'}
    if not isinstance(value, dict) or set(value) != keys or value['version'] != 1:
        raise RuntimeError('Unexpected enrollment manifest')
    if value['account'] != B_ACCOUNT or value['source'] != net.SOURCE + '/32':
        raise RuntimeError('Only verified B and the exact ZeroTier source are allowed')
    user_id = value['employeeUserId']
    if not isinstance(user_id, str) or not 1 <= len(user_id) <= 200 or user_id.strip() != user_id or re.search(r'[\r\n\x00]', user_id):
        raise RuntimeError('Employee ID must remain an exact nonempty string')
    normalized, fingerprint = public_key(value['publicKey'])
    if fingerprint != value['publicKeyFingerprint']:
        raise RuntimeError('Public key fingerprint differs from reviewed manifest')
    return {**value, 'publicKey': normalized}


def require_binding(manifest):
    info = DATABASE.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 996 or info.st_nlink != 1:
        raise RuntimeError('Unexpected identity database path')
    connection = sqlite3.connect(DATABASE.as_uri() + '?mode=ro', uri=True, timeout=3)
    try:
        connection.execute('PRAGMA query_only=ON')
        scope = json.loads(connection.execute("SELECT value FROM collaboration_security_meta WHERE key='scope'").fetchone()[0])
        if len(scope) != 3 or scope[0] != 'dingtalk-lan-test':
            raise RuntimeError('Identity store is not the reviewed service scope')
        rows = connection.execute('SELECT account,enabled,administrator,revision FROM collaboration_members WHERE corp_id=? AND client_id=? AND user_id=?', (scope[1], scope[2], manifest['employeeUserId'])).fetchall()
        if len(rows) != 1 or rows[0][0] != B_ACCOUNT or rows[0][1:3] != (1, 0):
            raise RuntimeError('Exact employee ID does not match the enabled non-admin B account')
        return rows[0][3]
    finally:
        connection.close()


def render_config(original):
    old = 'AllowUsers ' + ' '.join(net.LAN_USERS) + '\n'
    new = old.rstrip('\n') + ' ' + B_ACCOUNT + '@' + net.SOURCE + '\n'
    if original.count(new) == 1:
        baseline = original.replace(new, old, 1)
    elif original.count(old) == 1:
        baseline = original
    else:
        raise RuntimeError('Account source policy differs from reviewed first stage')
    if net.render_config(baseline) != baseline:
        raise RuntimeError('Reviewed ZeroTier network stage must already be applied')
    return baseline.replace(old, new, 1)


def render_keys(original, manifest):
    expected = ('from="' + net.SOURCE + '/32",restrict ' + manifest['publicKey'] + '\n').encode('utf-8')
    if original not in (EMPTY_KEYS, expected):
        raise RuntimeError('B already has different enrolled keys; no overwrite permitted')
    return expected


def atomic_file(path, data, expected, validate_config=False):
    info = net.trusted_file(path)
    if path.read_bytes() != expected:
        raise RuntimeError('Enrollment file changed during maintenance')
    fd, name = tempfile.mkstemp(prefix='.verified-b-', dir=path.parent)
    candidate = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), 0, info.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if validate_config:
            net.run('/usr/sbin/sshd', '-t', '-f', str(candidate))
        if path.read_bytes() != expected:
            raise RuntimeError('Enrollment file changed before replacement')
        os.replace(candidate, path)
    finally:
        # Only this mkstemp leaf in a verified root-owned parent, no recursive deletion.
        if candidate.exists():
            candidate.unlink()


def apply(manifest):
    manifest = validate_manifest(manifest)
    if os.geteuid() != 0:
        raise RuntimeError('Root maintenance environment required')
    revision = require_binding(manifest)
    net.require_idle_business()
    key_path = KEY_ROOT / B_ACCOUNT
    a_path = KEY_ROOT / A_ACCOUNT
    for path in (CONFIG, key_path, a_path):
        net.trusted_file(path)
    original_config = CONFIG.read_bytes()
    original_keys = key_path.read_bytes()
    a_keys = a_path.read_bytes()
    if manifest['publicKey'].split()[1].encode() in a_keys:
        raise RuntimeError('B cannot reuse A public key')
    rendered_config = render_config(original_config.decode('utf-8')).encode('utf-8')
    rendered_keys = render_keys(original_keys, manifest)
    if not net.has_rule(net.run('ufw', 'status', 'numbered')):
        raise RuntimeError('Reviewed B-only firewall rule is missing')
    backend_before = net.run('systemctl', 'show', 'dsh-collaboration-backend.service', '-p', 'MainPID', '-p', 'ActiveState')
    net.run('/usr/sbin/sshd', '-t', '-f', str(CONFIG))
    changed_key = False
    changed_config = False
    try:
        if require_binding(manifest) != revision:
            raise RuntimeError('Identity changed before enrollment')
        if rendered_keys != original_keys:
            atomic_file(key_path, rendered_keys, original_keys)
            changed_key = True
        if rendered_config != original_config:
            atomic_file(CONFIG, rendered_config, original_config, validate_config=True)
            changed_config = True
            net.run('systemctl', 'reload', net.UNIT)
        net.wait_listeners()
        if a_path.read_bytes() != a_keys or require_binding(manifest) != revision:
            raise RuntimeError('A boundary or B identity changed during maintenance')
        if net.run('systemctl', 'show', 'dsh-collaboration-backend.service', '-p', 'MainPID', '-p', 'ActiveState') != backend_before:
            raise RuntimeError('Backend state changed unexpectedly')
    except Exception:
        # Revoke only this new key even if config rollback/reload itself fails.
        try:
            if changed_key:
                atomic_file(key_path, original_keys, rendered_keys)
        finally:
            if changed_config:
                atomic_file(CONFIG, original_config, rendered_config, validate_config=True)
                net.run('systemctl', 'reload', net.UNIT)
        raise
    return {'ok': True, 'changed': changed_key or changed_config, 'account': B_ACCOUNT,
            'publicKeyFingerprint': manifest['publicKeyFingerprint'], 'source': net.SOURCE + '/32',
            'aAccountAndKeyUnchanged': True, 'identityStoreChanged': False, 'backendRestarted': False,
            'privateKeyRead': False, 'modelCalls': 0, 'bDeviceLoginVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--confirmation', required=True)
    args = parser.parse_args()
    if args.confirmation != CONFIRMATION:
        parser.error('Exact verified-B enrollment confirmation required')
    path = Path(args.manifest)
    if not path.is_absolute():
        raise RuntimeError('Use absolute private manifest path')
    info = net.trusted_file(path)
    if stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 8192:
        raise RuntimeError('Manifest requires mode0600 and bounded size')
    print(json.dumps(apply(json.loads(path.read_text(encoding='utf-8')))))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'errorType': type(error).__name__, 'message': str(error)}))
        raise SystemExit(1)
