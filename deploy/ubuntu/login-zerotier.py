#!/usr/bin/env python3
"""Complete B-only HTTPS transport without changing origin, DNS or OAuth state."""
import argparse
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import socket
import ssl
import stat
import tempfile
import time

spec = importlib.util.spec_from_file_location('member_network_boundary', Path(__file__).with_name('member-zerotier.py'))
net = importlib.util.module_from_spec(spec)
spec.loader.exec_module(net)
CONFIG = Path('/etc/dsh-collaboration-login/nginx.conf')
BASELINE = Path(__file__).with_name('login-lan.baseline.conf')
NGINX = '/www/server/nginx/sbin/nginx'
PREFIX = '/var/lib/dsh-collaboration-login/'
UNIT = 'dsh-collaboration-login.service'
ORIGIN = 'login.lafinger.us.ci'
CONFIRMATION = 'ADD_VERIFIED_B_ZERO_TIER_HTTPS_ONLY'


def render_config(original):
    baseline = BASELINE.read_text(encoding='utf-8')
    rendered = baseline.replace('# Bind ONLY the verified LAN address, not 0.0.0.0 or IPv6.', '# Preserve LAN; ZeroTier listener permits only the verified B source, no wildcard/IPv6.')
    rendered = rendered.replace('        127.0.0.1/32 1;\n', '        127.0.0.1/32 1;\n        10.242.66.179/32 1;\n', 1)
    rendered = rendered.replace('        listen 192.168.2.20:443 ssl default_server;\n', '        listen 192.168.2.20:443 ssl default_server;\n        listen 10.242.169.184:443 ssl default_server;\n', 1)
    rendered = rendered.replace('        listen 192.168.2.20:443 ssl;\n', '        listen 192.168.2.20:443 ssl;\n        listen 10.242.169.184:443 ssl;\n', 1)
    rendered = rendered.replace('        allow 127.0.0.1;\n', '        allow 127.0.0.1;\n        allow 10.242.66.179/32;\n', 1)
    # LAN permissions stay on LAN. Even existing LAN/loopback sources cannot
    # consume the ZeroTier listener unless their actual source is B's exact IP.
    rendered = rendered.replace('    # Missing/unknown SNI must never reach the OAuth application.\n', '    map "$server_addr|$remote_addr" $collaboration_login_zt_denied {\n        default 0;\n        ~^10\\.242\\.169\\.184\\| 1;\n        "10.242.169.184|10.242.66.179" 0;\n    }\n\n    # Missing/unknown SNI must never reach the OAuth application.\n', 1)
    rendered = rendered.replace('        if ($collaboration_login_lan = 0) { return 403; }\n', '        if ($collaboration_login_lan = 0) { return 403; }\n        if ($collaboration_login_zt_denied = 1) { return 403; }\n', 1)
    if original not in (baseline, rendered):
        raise RuntimeError('Login ingress differs from exact reviewed baseline; no overwrite')
    return rendered


def expected_source(destination, source):
    """Executable policy fixture matching geo + exact ZeroTier listener map."""
    address = ipaddress.IPv4Address(source)
    if destination == net.SERVER:
        return source == net.SOURCE
    return destination == net.LAN and (address in ipaddress.IPv4Network('192.168.2.0/24') or source == '127.0.0.1' or source == net.SOURCE)


def atomic_config(data, expected):
    info = net.trusted_file(CONFIG)
    if CONFIG.read_bytes() != expected:
        raise RuntimeError('HTTPS config changed during maintenance')
    fd, name = tempfile.mkstemp(prefix='.b-https-reviewed-', dir=CONFIG.parent)
    candidate = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), 0, info.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        net.run(NGINX, '-e', '/dev/null', '-t', '-p', PREFIX, '-c', str(candidate))
        if CONFIG.read_bytes() != expected:
            raise RuntimeError('HTTPS config changed before replacement')
        os.replace(candidate, CONFIG)
    finally:
        # This exact temporary leaf was created by us in the verified parent.
        if candidate.exists():
            candidate.unlink()


def https_probe(address, expected):
    # A static completion page does not claim/complete a device login.
    # Never visit /login/<active-id> or the callback, follow redirects or store cookies.
    with socket.create_connection((address, 443), timeout=4) as raw:
        with ssl.create_default_context().wrap_socket(raw, server_hostname=ORIGIN) as tls:
            tls.settimeout(4)
            tls.sendall(('GET /collaboration/login-complete HTTP/1.1\r\nHost: ' + ORIGIN + '\r\nConnection: close\r\n\r\n').encode())
            response = http.client.HTTPResponse(tls); response.begin()
            status = response.status
            cache = response.getheader('Cache-Control')
            response.read(32768)
            if status != expected or (expected == 200 and cache != 'no-store'):
                raise RuntimeError('HTTPS static readiness/source boundary differs')
            return status


def wait_https_listeners():
    for attempt in range(30):
        text = net.run('ss', '-H', '-ltn', 'sport = :443')
        if net.LAN + ':443' in text and net.SERVER + ':443' in text:
            return
        if attempt < 29:
            time.sleep(0.1)
    raise RuntimeError('Exact LAN and ZeroTier HTTPS listeners are required')


def apply():
    if os.geteuid() != 0:
        raise RuntimeError('Root maintenance environment required')
    net.trusted_file(CONFIG)
    original = CONFIG.read_bytes()
    rendered = render_config(original.decode('utf-8')).encode('utf-8')
    interfaces = json.loads(net.run('ip', '-j', '-4', 'addr', 'show'))
    if not any(row['ifname'] == net.INTERFACE and any(item.get('local') == net.SERVER for item in row.get('addr_info', [])) for row in interfaces):
        raise RuntimeError('Expected existing ZeroTier address is missing')
    net.require_idle_business()
    if net.run('systemctl', 'is-active', UNIT).strip() != 'active':
        raise RuntimeError('Existing dedicated HTTPS service must be active')
    firewall = net.run('ufw', 'status', 'numbered')
    if 'Status: active' not in firewall or not any('443/tcp' in row and 'ALLOW IN' in row and 'Anywhere' in row and '(v6)' not in row for row in firewall.splitlines()):
        raise RuntimeError('Reviewed existing IPv4 443 rule required; do not alter unrelated firewall policy')
    backend = net.run('systemctl', 'show', 'dsh-collaboration-backend.service', '-p', 'MainPID', '-p', 'ActiveState')
    changed = False
    try:
        if rendered != original:
            atomic_config(rendered, original)
            changed = True
            net.run('systemctl', 'reload', UNIT)
        wait_https_listeners()
        https_probe(net.LAN, 200)
        # Local source is not B. Must get authenticated TLS then source denial,
        # proving this change did not expose OAuth to every ZeroTier member.
        https_probe(net.SERVER, 403)
        if net.run('systemctl', 'show', 'dsh-collaboration-backend.service', '-p', 'MainPID', '-p', 'ActiveState') != backend:
            raise RuntimeError('Backend changed unexpectedly')
    except Exception:
        if changed:
            atomic_config(original, rendered)
            net.run('systemctl', 'reload', UNIT)
        raise
    return {'ok': True, 'changed': changed, 'lanHttpsPreserved': True,
            'zeroTierHttpsListen': net.SERVER + ':443', 'zeroTierAllowedSource': net.SOURCE + '/32',
            'tlsOriginUnchanged': ORIGIN, 'nonBZeroTierHttpsDenied': True,
            'backendRestarted': False, 'firewallChanged': False, 'publicDnsChanged': False,
            'activeLoginUrlOpened': False, 'loginStateChanged': False, 'modelCalls': 0,
            'bActualBrowserVerified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--confirmation', required=True)
    args = parser.parse_args()
    if args.confirmation != CONFIRMATION:
        parser.error('Exact B HTTPS maintenance confirmation required')
    print(json.dumps(apply()))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'errorType': type(error).__name__, 'message': str(error)}))
        raise SystemExit(1)
