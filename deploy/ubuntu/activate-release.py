#!/usr/bin/env python3
"""Activate an exact prepared Ubuntu release with the real-model gate kept closed."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path('/opt/dsh-collaboration-test')
HOME = Path('/srv/dsh-collaboration-test/dsh-home')
STATE = Path('/srv/dsh-collaboration-test/private-state')
PROFILE = HOME / 'profiles/collaboration-dingtalk'
UNIT = 'dsh-collaboration-backend.service'
DROPIN = Path('/etc/systemd/system/' + UNIT + '.d/cpa-release.conf')


def check_file(path, uid, private=False):
    st = path.lstat()
    if path.resolve(strict=True) != path or not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != uid:
        raise RuntimeError('Unexpected file identity')
    if st.st_mode & (0o077 if private else 0o022):
        raise RuntimeError('Unexpected file permissions')
    return path.read_bytes()


def atomic_write(path, body, uid, gid, mode):
    if os.path.lexists(path):
        check_file(path, uid, mode == 0o600)
    fd, name = tempfile.mkstemp(prefix='.cpa-activate-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), uid, gid)
            os.fchmod(stream.fileno(), mode)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary = Path(name)
        if temporary.parent != path.parent or not temporary.name.startswith('.cpa-activate-'):
            raise RuntimeError('Unexpected atomic-write cleanup target')
        if temporary.exists():
            temporary.unlink()


def run(*args):
    # Only fixed administrator commands, no credential or business content in argv/output.
    return subprocess.run(args, check=True, capture_output=True, timeout=45).stdout.decode().strip()


def route_config(config):
    if config.get('serviceId') != 'dingtalk-lan-test' or config.get('provider') != 'codego' or config.get('model') != 'deepseek-v4.1-flash':
        raise RuntimeError('Active baseline route differs')
    result = dict(config)
    result.update(provider='cpa', model='deepseek-v4.1-flash')
    return result


def credential_config(config, staged):
    if config.get('version') != 1 or not isinstance(config.get('refs'), dict):
        raise RuntimeError('Unsupported credential store')
    if (staged.get('version'), staged.get('provider'), staged.get('model'), staged.get('ref')) != (1, 'cpa', 'deepseek-v4.1-flash', 'CPA_API_KEY'):
        raise RuntimeError('Unexpected staged route')
    value = staged.get('value')
    if not isinstance(value, str) or not 8 <= len(value) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise RuntimeError('Invalid staged key format')
    refs = dict(config['refs'])
    refs.pop('CODEGO_API_KEY', None)
    refs['CPA_API_KEY'] = value
    return {**config, 'refs': refs}


def data_inventory():
    """Hash files without decoding records; no filenames or bodies leave this process."""
    roots = [STATE, HOME / 'sessions', Path('/srv/dsh-collaboration-test/workspace')]
    result = {}
    for root in roots:
        if root.resolve(strict=True) != root:
            raise RuntimeError('Unexpected data root')
        for path in sorted(root.rglob('*')):
            st = path.lstat()
            if stat.S_ISLNK(st.st_mode):
                raise RuntimeError('Unexpected data symlink')
            if stat.S_ISREG(st.st_mode):
                result[str(path)] = (st.st_size, hashlib.sha256(path.read_bytes()).hexdigest())
    return result


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'[a-f0-9]{40}', sys.argv[1]) or os.geteuid() != 0:
        raise RuntimeError('Root and exact full SHA required')
    sha = sys.argv[1]
    release = ROOT / 'releases' / sha
    if release.resolve(strict=True) != release:
        raise RuntimeError('Release link is not allowed')
    svc = pwd.getpwnam('dsh-collab-test')
    if HOME.resolve(strict=True) != HOME or stat.S_IMODE(HOME.stat().st_mode) != 0o700 or HOME.stat().st_uid != svc.pw_uid:
        raise RuntimeError('Unexpected private home')
    evidence = json.loads(check_file(release / 'verified-release.json', 0))
    if evidence.get('commit') != sha or evidence.get('repository') != 'Lafinger/dsh-collaboration-acp-server' or evidence.get('ciConclusion') != 'success':
        raise RuntimeError('Successful fixed GitHub CI evidence required')
    for relative, digest in evidence['publicFiles'].items():
        if Path(relative).is_absolute() or '..' in Path(relative).parts:
            raise RuntimeError('Unsafe release manifest path')
        if hashlib.sha256(check_file(release / relative, 0)).hexdigest() != digest:
            raise RuntimeError('Release file digest mismatch')
    for unit in [UNIT, 'dsh-collaboration-login.service', 'dsh-collaboration-ssh.service']:
        if run('systemctl', 'is-active', unit) != 'active':
            raise RuntimeError('An existing service is not active')
    if os.path.lexists(DROPIN):
        raise RuntimeError('CPA activation already exists; inspect rather than repeat')
    if (PROFILE / 'node_modules').resolve() != (ROOT / 'node_modules').resolve():
        raise RuntimeError('Unexpected old profile module resolution')
    config_path = HOME / 'collaboration-acp-server.json'
    gate_path = HOME / 'login-only-policy.json'
    credentials_path = HOME / '.credentials.yaml'
    staged_path = HOME / '.cpa-key-staged.json'
    config = json.loads(check_file(config_path, svc.pw_uid, True))
    gate = json.loads(check_file(gate_path, svc.pw_uid, True))
    if gate != {'provider': 'codego', 'model': 'deepseek-v4.1-flash', 'modelRequestsAllowed': False}:
        raise RuntimeError('Closed baseline model gate required')
    new_config = route_config(config)
    staged = json.loads(check_file(staged_path, svc.pw_uid, True))
    # Read the active credential store only to retain non-model secrets; never print or back it up.
    credentials = credential_config(json.loads(check_file(credentials_path, svc.pw_uid, True)), staged)
    new_profile = check_file(release / 'profile.patch.yml', 0)
    if b'@deepseek-ai/dsh-llm-pi-ai' not in new_profile or b'host-cpa.mjs' in new_profile or b'openai-responses' not in new_profile or b'codego' in new_profile.lower() or b'model-request-gate' not in new_profile:
        raise RuntimeError('Unexpected new profile')
    # No service stop happens until all configuration/key/release preflight succeeds.
    run('systemctl', 'stop', UNIT)
    try:
        before = data_inventory()
        atomic_write(config_path, encode(new_config), svc.pw_uid, svc.pw_gid, 0o600)
        atomic_write(gate_path, encode({'provider': 'cpa', 'model': 'deepseek-v4.1-flash', 'modelRequestsAllowed': False}), svc.pw_uid, svc.pw_gid, 0o600)
        atomic_write(credentials_path, encode(credentials), svc.pw_uid, svc.pw_gid, 0o600)
        atomic_write(PROFILE / 'cordis.patch.yml', new_profile, svc.pw_uid, svc.pw_gid, 0o600)
        # Validate old target immediately before replacing just this profile-owned symlink.
        link = PROFILE / 'node_modules'
        if not link.is_symlink() or link.resolve() != (ROOT / 'node_modules').resolve():
            raise RuntimeError('Profile node_modules changed during activation')
        temporary_link = PROFILE / ('.cpa-modules-' + sha)
        os.symlink(str(release / 'node_modules'), temporary_link)
        os.lchown(temporary_link, svc.pw_uid, svc.pw_gid)
        os.replace(temporary_link, link)
        dropin = '[Service]\nExecStart=\nExecStart=/usr/bin/node ' + str(release) + '/node_modules/@deepseek-ai/dsh/lib/bin.js --profile collaboration-dingtalk\nRestart=no\n'
        atomic_write(DROPIN, dropin.encode(), 0, 0, 0o644)
        if data_inventory() != before:
            raise RuntimeError('Data changed while backend was stopped')
        run('systemctl', 'daemon-reload')
        run('systemctl', 'start', UNIT)
        socket = Path('/run/dsh-collaboration-test/service.sock')
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if run('systemctl', 'is-active', UNIT) == 'active' and socket.exists() and stat.S_ISSOCK(socket.stat().st_mode):
                break
            time.sleep(0.3)
        else:
            raise RuntimeError('Backend readiness was not confirmed')
        for unit in ['dsh-collaboration-login.service', 'dsh-collaboration-ssh.service']:
            if run('systemctl', 'is-active', unit) != 'active':
                raise RuntimeError('Existing ingress health changed')
        # Remove only the exact private staged copy after success, not an arbitrary computed path.
        check_file(staged_path, svc.pw_uid, True)
        if staged_path != Path('/srv/dsh-collaboration-test/dsh-home/.cpa-key-staged.json'):
            raise RuntimeError('Unexpected staged deletion target')
        staged_path.unlink()
        print(json.dumps({'commit': sha, 'provider': 'cpa', 'model': 'deepseek-v4.1-flash', 'modelRequestsAllowed': False, 'dataUnchangedDuringStop': True, 'oldModelReferenceRemoved': True, 'backend': 'active', 'ingressPreserved': True, 'realModelCalls': 0}))
    except BaseException:
        # Fail closed; no provider rollback and no loop of automatic service restarts.
        subprocess.run(['systemctl', 'stop', UNIT], capture_output=True, timeout=45)
        raise


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print('CPA activation did not complete. Inspect the closed gate and service state; no automatic Codego rollback or model test was attempted.', file=sys.stderr)
        sys.exit(1)
