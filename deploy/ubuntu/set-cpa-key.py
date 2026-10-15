#!/usr/bin/env python3
"""Run locally on Ubuntu as the service user. No network, active change, or secret output."""
import getpass
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import tempfile
import warnings

HOME = Path('/srv/dsh-collaboration-test/dsh-home')
STAGED = HOME / '.cpa-key-staged.json'


def check_private(path, directory=False):
    st = path.lstat()
    valid_type = stat.S_ISDIR(st.st_mode) if directory else stat.S_ISREG(st.st_mode)
    if not valid_type or stat.S_ISLNK(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise RuntimeError('Private service-owned input required')
    if not directory and (st.st_nlink != 1 or st.st_size > 65536):
        raise RuntimeError('Invalid private input')


def stage_key(key):
    if not 8 <= len(key) <= 4096 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise RuntimeError('API key must be 8-4096 printable non-whitespace ASCII characters')
    check_private(HOME, True)
    policy_path = HOME / 'login-only-policy.json'
    check_private(policy_path)
    if json.loads(policy_path.read_text()).get('modelRequestsAllowed') is not False:
        raise RuntimeError('Real model request gate must remain closed')
    if os.path.lexists(STAGED):
        check_private(STAGED)
    fd, temporary = tempfile.mkstemp(prefix='.cpa-key-', dir=HOME)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump({'version': 1, 'provider': 'cpa', 'model': 'deepseek-v4.1-flash', 'ref': 'CPA_API_KEY', 'value': key}, stream)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, STAGED)
        dfd = os.open(HOME, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        temporary_path = Path(temporary)
        if temporary_path.parent != HOME or not temporary_path.name.startswith('.cpa-key-'):
            raise RuntimeError('Unexpected temporary cleanup target')
        if temporary_path.exists():
            temporary_path.unlink()


def main():
    if len(sys.argv) != 1 or not sys.stdin.isatty():
        raise RuntimeError('Run interactively without arguments, redirects, pipes or a recording terminal')
    if os.geteuid() != pwd.getpwnam('dsh-collab-test').pw_uid:
        raise RuntimeError('Run using sudo -u dsh-collab-test; not as root')
    if HOME.resolve(strict=True) != HOME:
        raise RuntimeError('Unexpected service home link')
    warnings.simplefilter('error', getpass.GetPassWarning)
    key = getpass.getpass('CPA API key (hidden): ')
    confirmation = getpass.getpass('Repeat CPA API key (hidden): ')
    if key != confirmation:
        raise RuntimeError('Inputs did not match; nothing was stored')
    stage_key(key)
    print('CPA key staged privately (0600). Active service is unchanged. Model requests remain disabled.')
    print('This checks local format/storage only, not API-key validity or gateway compatibility.')


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('Cancelled; no active configuration changed.', file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Do not interpolate third-party messages, tracebacks, input bytes or credentials.
        print('CPA key staging failed. Check interactive input, service ownership, private permissions and closed gate.', file=sys.stderr)
        sys.exit(1)
