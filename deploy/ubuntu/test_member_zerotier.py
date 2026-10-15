"""Synthetic network/config boundaries only: no live SSH, firewall or keys."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json

spec = importlib.util.spec_from_file_location('member_zerotier', Path(__file__).with_name('member-zerotier.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

ORIGINAL = '''# Synthetic dedicated member fixture
Port 19482
ListenAddress 192.168.2.20
HostKey /etc/ssh/ssh_host_ed25519_key
AllowUsers dt_f66d225ac622aaf111a0@192.168.2.* dt_b7a8377e73575cacd1af@192.168.2.*
ForceCommand /usr/local/libexec/dsh-collaboration-member-shell
AuthorizedKeysFile /etc/dsh-collaboration-ssh/authorized_keys/%u
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
PermitRootLogin no
PermitTTY no
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
PermitUserEnvironment no
PermitUserRC no
'''
RULE = '[ 9] 10.242.169.184 19482/tcp on ztfl6kpbcz ALLOW IN 10.242.66.179 # dsh-collaboration-b-zerotier\n'


class MemberNetworkPolicy(unittest.TestCase):
    def test_only_one_additive_listener_and_no_identity_expansion(self):
        output = policy.render_config(ORIGINAL)
        self.assertEqual(output.replace('ListenAddress 10.242.169.184\n', ''), ORIGINAL)
        self.assertEqual(policy.render_config(output), output)
        for line in ['AllowUsers', 'AuthorizedKeysFile', 'ForceCommand']:
            self.assertEqual([row for row in ORIGINAL.splitlines() if row.startswith(line)], [row for row in output.splitlines() if row.startswith(line)])

    def test_changed_security_wildcard_and_indirect_config_refused(self):
        for changed in [ORIGINAL.replace('PasswordAuthentication no', 'PasswordAuthentication yes'),
                        ORIGINAL.replace('AllowTcpForwarding no', 'AllowTcpForwarding yes'),
                        ORIGINAL.replace('ListenAddress 192.168.2.20', 'ListenAddress 0.0.0.0'),
                        ORIGINAL.replace('Port 19482', 'Port 22'),
                        ORIGINAL + 'Include /other/file\n', ORIGINAL + 'Match All\n',
                        ORIGINAL.replace('dt_b7a8377e73575cacd1af@192.168.2.*', '*'),
                        ORIGINAL + 'ListenAddress 10.0.0.1\n']:
            with self.subTest(changed=changed), self.assertRaises(RuntimeError):
                policy.render_config(changed)

    def test_firewall_is_only_source32_interface_and_existing_rule_is_exact(self):
        command = policy.firewall_command()
        self.assertEqual(command, ['ufw', 'allow', 'in', 'on', 'ztfl6kpbcz', 'from', '10.242.66.179/32', 'to', '10.242.169.184', 'port', '19482', 'proto', 'tcp', 'comment', 'dsh-collaboration-b-zerotier'])
        self.assertTrue(policy.has_rule(RULE))
        for changed in [RULE.replace('10.242.66.179', 'Anywhere'), RULE.replace('10.242.66.179', '10.242.0.0/16'), RULE.replace('ztfl6kpbcz', 'eth0'), RULE.replace('ALLOW IN', 'DENY IN'), RULE.replace('19482', '22')]:
            self.assertFalse(policy.has_rule(changed))

    def simulate_apply(self, fail_reload=False, busy=False):
        temp = tempfile.TemporaryDirectory(prefix='zt-synthetic-')
        self.addCleanup(temp.cleanup)
        target = Path(temp.name) / 'sshd_config'
        target.write_bytes(ORIGINAL.encode('utf-8'))
        state = {'rule': False, 'reloaded': False, 'reloadFailures': 0}
        calls = []
        def run(*args):
            calls.append(args)
            if args[:4] == ('ip', '-j', '-4', 'addr'):
                return json.dumps([{'ifname': 'eth0', 'addr_info': [{'family': 'inet', 'local': policy.LAN}]}, {'ifname': policy.INTERFACE, 'addr_info': [{'family': 'inet', 'local': policy.SERVER}]}])
            if args == ('ss', '-H', '-ltn', 'sport = :19482'):
                return policy.LAN + ':19482\n' + (policy.SERVER + ':19482\n' if state['reloaded'] else '')
            if args[:2] == ('systemctl', 'is-active'):
                return 'active\n'
            if args[:2] == ('systemctl', 'show'):
                return 'MainPID=123\nActiveState=active\n'
            if args[:3] == ('ufw', 'status', 'numbered'):
                return 'Status: active\n' + (RULE if state['rule'] else '')
            if list(args) == policy.firewall_command():
                state['rule'] = True
                return ''
            if list(args) == policy.firewall_command('delete'):
                state['rule'] = False
                return ''
            if args[:2] == ('systemctl', 'reload'):
                if fail_reload and state['reloadFailures'] == 0:
                    state['reloadFailures'] += 1
                    raise RuntimeError('synthetic reload failure')
                state['reloaded'] = 'ListenAddress ' + policy.SERVER in target.read_text()
                return ''
            if args[:2] == ('/usr/sbin/sshd', '-t'):
                return ''
            raise AssertionError('Unreviewed maintenance command: ' + repr(args))
        def atomic(data, expected):
            self.assertEqual(target.read_bytes(), expected)
            target.write_bytes(data)
        with patch.object(policy, 'CONFIG', target), patch.object(policy, 'trusted_file'), patch.object(policy.os, 'geteuid', return_value=0, create=True), patch.object(policy, 'require_idle_business', side_effect=RuntimeError('synthetic running request') if busy else None), patch.object(policy, 'run', side_effect=run), patch.object(policy, 'atomic_config', side_effect=atomic):
            if busy or fail_reload:
                with self.assertRaises(RuntimeError):
                    policy.apply()
                self.assertEqual(target.read_text(), ORIGINAL)
                self.assertFalse(state['rule'])
            else:
                report = policy.apply()
                self.assertTrue(report['lanPreserved'])
                self.assertTrue(report['authorizedKeysUnchanged'])
                self.assertTrue(report['memberAuthenticationStillRequiresEnrollment'])
                self.assertFalse(report['backendRestarted'])
                self.assertTrue(policy.apply()['alreadyApplied'])
                self.assertTrue(state['rule'])
        self.assertFalse(any(args[:2] == ('systemctl', 'restart') for args in calls))
        return calls

    def test_apply_and_idempotence_do_not_touch_identity_or_backend(self):
        self.simulate_apply()

    def test_failed_reload_rolls_back_only_our_listener_and_rule(self):
        self.simulate_apply(fail_reload=True)

    def test_running_business_prevents_network_write(self):
        calls = self.simulate_apply(busy=True)
        self.assertFalse(any(args[:2] == ('ufw', 'allow') for args in calls))


if __name__ == '__main__':
    unittest.main()
