"""Exact ingress transform and maintenance rollback with synthetic config only."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json

spec = importlib.util.spec_from_file_location('b_https', Path(__file__).with_name('login-zerotier.py'))
policy = importlib.util.module_from_spec(spec); spec.loader.exec_module(policy)
BASELINE = policy.BASELINE.read_text(encoding='utf-8')


class LoginZeroTier(unittest.TestCase):
    def test_exact_additive_sockets_and_only_b_source_without_changing_tls_or_routes(self):
        output = policy.render_config(BASELINE)
        self.assertEqual(policy.render_config(output), output)
        self.assertEqual(output.count('listen 192.168.2.20:443'), 2)
        self.assertEqual(output.count('listen 10.242.169.184:443'), 2)
        self.assertIn('        allow 10.242.66.179/32;\n', output)
        self.assertIn('        10.242.66.179/32 1;\n', output)
        self.assertIn('"10.242.169.184|10.242.66.179" 0;', output)
        self.assertIn('if ($collaboration_login_zt_denied = 1) { return 403; }', output)
        for text in ['ssl_reject_handshake on;', 'deny all;', 'access_log off;', 'proxy_next_upstream off;', 'server_name login.lafinger.us.ci;', 'proxy_pass http://127.0.0.1:19481;', 'location / { return 404; }', 'if ($request_method != GET) { return 405; }']:
            self.assertEqual(output.count(text), BASELINE.count(text))
        self.assertNotIn('listen 0.0.0.0', output)
        self.assertNotIn('allow 10.242.0.0/16', output)
        self.assertEqual([row for row in output.splitlines() if 'ssl_certificate' in row], [row for row in BASELINE.splitlines() if 'ssl_certificate' in row])

    def test_drift_including_host_method_tls_logging_or_source_is_refused(self):
        for wrong in [BASELINE.replace('deny all;', 'allow all;'), BASELINE.replace('access_log off;', 'access_log /tmp/log;'), BASELINE.replace('ssl_reject_handshake on;', 'ssl_reject_handshake off;'), BASELINE.replace('19481', '19387'), BASELINE.replace('location / { return 404; }', 'location / { proxy_pass http://host; }'), BASELINE.replace('GET', 'POST'), BASELINE.replace('192.168.2.0/24', '0.0.0.0/0')]:
            with self.subTest(wrong=wrong), self.assertRaises(RuntimeError):
                policy.render_config(wrong)

    def test_policy_lan_preserved_b_allowed_only_other_zerotier_denied(self):
        self.assertTrue(policy.expected_source('192.168.2.20', '192.168.2.11'))
        self.assertTrue(policy.expected_source('10.242.169.184', '10.242.66.179'))
        for source in ['10.242.66.178', '10.242.169.184', '192.168.2.11', '127.0.0.1', '203.0.113.7']:
            self.assertFalse(policy.expected_source('10.242.169.184', source))
        self.assertFalse(policy.expected_source('192.168.2.20', '10.242.66.178'))

    def simulate(self, fail_probe=False, fail_reload=False):
        with tempfile.TemporaryDirectory(prefix='b-login-test-') as temp:
            target = Path(temp) / 'nginx.conf'; target.write_bytes(BASELINE.encode())
            calls = []; reloads = 0
            def run(*args):
                nonlocal reloads
                calls.append(args)
                if args[:4] == ('ip', '-j', '-4', 'addr'):
                    return json.dumps([{'ifname': policy.net.INTERFACE, 'addr_info': [{'local': policy.net.SERVER}]}])
                if args[:2] == ('systemctl', 'is-active'):
                    return 'active\n'
                if args[:2] == ('systemctl', 'show'):
                    return 'MainPID=100\nActiveState=active\n'
                if args[:2] == ('systemctl', 'reload'):
                    reloads += 1
                    if fail_reload and reloads == 1:
                        raise RuntimeError('synthetic reload failure')
                    return ''
                if args[:2] == ('ufw', 'status'):
                    return 'Status: active\n[ 4] 443/tcp ALLOW IN Anywhere\n'
                raise AssertionError('Unexpected mutation/command: ' + repr(args))
            def atomic(data, expected):
                self.assertEqual(target.read_bytes(), expected); target.write_bytes(data)
            def probe(address, expected):
                if fail_probe and address == policy.net.SERVER:
                    raise RuntimeError('synthetic source boundary failure')
                return expected
            with patch.object(policy, 'CONFIG', target), patch.object(policy.os, 'geteuid', return_value=0, create=True), patch.object(policy.net, 'trusted_file'), patch.object(policy.net, 'require_idle_business'), patch.object(policy.net, 'run', side_effect=run), patch.object(policy, 'atomic_config', side_effect=atomic), patch.object(policy, 'wait_https_listeners'), patch.object(policy, 'https_probe', side_effect=probe):
                if fail_probe or fail_reload:
                    with self.assertRaises(RuntimeError):
                        policy.apply()
                    self.assertEqual(target.read_bytes(), BASELINE.encode())
                else:
                    report = policy.apply()
                    self.assertTrue(report['changed']); self.assertTrue(report['nonBZeroTierHttpsDenied'])
                    self.assertFalse(report['publicDnsChanged']); self.assertFalse(report['activeLoginUrlOpened'])
                    self.assertFalse(policy.apply()['changed'])
                self.assertFalse(any(row[:2] == ('systemctl', 'restart') for row in calls))

    def test_apply_and_idempotence_do_not_mutate_oauth_or_backend(self):
        self.simulate()

    def test_readiness_failure_rolls_back_ingress(self):
        self.simulate(fail_probe=True)

    def test_reload_failure_rolls_back_ingress(self):
        self.simulate(fail_reload=True)


if __name__ == '__main__':
    unittest.main()
