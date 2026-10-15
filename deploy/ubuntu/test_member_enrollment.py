"""Synthetic public keys/SQLite/config only. No real identity, network or private key."""
import base64
import importlib.util
import json
from pathlib import Path
import sqlite3
import stat
import struct
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


enroll = load('verified_b_enrollment', 'enroll-member-zerotier.py')
network_tests = load('network_fixtures', 'test_member_zerotier.py')
ORIGINAL = enroll.net.render_config(network_tests.ORIGINAL)
BLOB = struct.pack('>I', 11) + b'ssh-ed25519' + struct.pack('>I', 32) + bytes(range(32))
PUBLIC = 'ssh-ed25519 ' + base64.b64encode(BLOB).decode() + ' synthetic'
NORMALIZED, FINGERPRINT = enroll.public_key(PUBLIC)
MANIFEST = {'version': 1, 'account': enroll.B_ACCOUNT, 'employeeUserId': '000123', 'source': '10.242.66.179/32', 'publicKey': PUBLIC, 'publicKeyFingerprint': FINGERPRINT}


class MemberEnrollment(unittest.TestCase):
    def test_manifest_never_trusts_claimed_a_identity_or_wrong_source(self):
        valid = enroll.validate_manifest(MANIFEST)
        self.assertEqual(valid['employeeUserId'], '000123')
        self.assertEqual(valid['publicKey'], NORMALIZED)
        for replacement in [{'account': enroll.A_ACCOUNT}, {'source': '10.242.0.0/16'}, {'employeeUserId': 123}, {'publicKeyFingerprint': 'wrong'}, {'claimedExistingAccount': enroll.A_ACCOUNT}]:
            with self.subTest(replacement=replacement), self.assertRaises(RuntimeError):
                enroll.validate_manifest({**MANIFEST, **replacement})

    def test_plain_ed25519_parser_rejects_options_multiline_or_wrong_payload(self):
        for wrong in ['restrict ' + PUBLIC, PUBLIC + '\ncommand=x', PUBLIC.replace('ssh-ed25519 ', 'ssh-rsa ', 1), 'ssh-ed25519 AAAA', 'ssh-ed25519 ' + base64.b64encode(BLOB[:-1]).decode()]:
            with self.subTest(wrong=wrong), self.assertRaises((RuntimeError, ValueError)):
                enroll.public_key(wrong)

    def test_only_exact_b_source_added_and_existing_lan_policy_preserved(self):
        rendered = enroll.render_config(ORIGINAL)
        self.assertEqual(rendered.replace(' ' + enroll.B_ACCOUNT + '@10.242.66.179', ''), ORIGINAL)
        self.assertEqual(enroll.render_config(rendered), rendered)
        for changed in [ORIGINAL.replace('AllowUsers ', 'AllowUsers *@* '), ORIGINAL.replace('ListenAddress 10.242.169.184\n', ''), ORIGINAL.replace('PasswordAuthentication no', 'PasswordAuthentication yes')]:
            with self.assertRaises(RuntimeError):
                enroll.render_config(changed)

    def test_key_only_exact_source_restrict_and_refuses_unknown_existing_keys(self):
        manifest = enroll.validate_manifest(MANIFEST)
        rendered = enroll.render_keys(enroll.EMPTY_KEYS, manifest)
        self.assertTrue(rendered.startswith(b'from="10.242.66.179/32",restrict ssh-ed25519 '))
        self.assertEqual(enroll.render_keys(rendered, manifest), rendered)
        with self.assertRaises(RuntimeError):
            enroll.render_keys(b'# different\nssh-ed25519 another-key\n', manifest)

    def test_exact_scoped_database_match_preserves_leading_zero(self):
        with tempfile.TemporaryDirectory(prefix='b-identity-') as temp:
            path = Path(temp) / 'identities.sqlite'
            db = sqlite3.connect(path)
            db.executescript('CREATE TABLE collaboration_security_meta(key TEXT,value TEXT); CREATE TABLE collaboration_members(account TEXT,corp_id TEXT,client_id TEXT,user_id TEXT,enabled INTEGER,administrator INTEGER,revision INTEGER);')
            db.execute('INSERT INTO collaboration_security_meta VALUES(?,?)', ('scope', json.dumps(['dingtalk-lan-test', 'synthetic-corp', 'synthetic-app'])))
            db.execute('INSERT INTO collaboration_members VALUES(?,?,?,?,?,?,?)', (enroll.B_ACCOUNT, 'synthetic-corp', 'synthetic-app', '000123', 1, 0, 7))
            db.commit(); db.close()
            safe = types.SimpleNamespace(lstat=lambda: types.SimpleNamespace(st_mode=stat.S_IFREG, st_uid=996, st_nlink=1), as_uri=path.as_uri)
            with patch.object(enroll, 'DATABASE', safe):
                self.assertEqual(enroll.require_binding(MANIFEST), 7)
                with self.assertRaises(RuntimeError):
                    enroll.require_binding({**MANIFEST, 'employeeUserId': '123'})
            db = sqlite3.connect(path); db.execute("UPDATE collaboration_members SET user_id='000123',account=?", (enroll.A_ACCOUNT,)); db.commit(); db.close()
            with patch.object(enroll, 'DATABASE', safe), self.assertRaises(RuntimeError):
                enroll.require_binding(MANIFEST)

    def simulate(self, failure=False, same_a_key=False):
        with tempfile.TemporaryDirectory(prefix='b-enroll-') as temp:
            root = Path(temp); config = root / 'sshd_config'; config.write_bytes(ORIGINAL.encode())
            keys = root / 'keys'; keys.mkdir(); b = keys / enroll.B_ACCOUNT; b.write_bytes(enroll.EMPTY_KEYS)
            a = keys / enroll.A_ACCOUNT; a.write_bytes((NORMALIZED if same_a_key else 'SYNTHETIC_A_PUBLIC_POLICY').encode())
            a_original = a.read_bytes(); reloads = 0; calls = []
            def run(*args):
                nonlocal reloads
                calls.append(args)
                if args[:2] == ('ufw', 'status'):
                    return 'Status: active\n' + network_tests.RULE
                if args[:2] == ('systemctl', 'show'):
                    return 'MainPID=123\nActiveState=active\n'
                if args[:2] == ('/usr/sbin/sshd', '-t'):
                    return ''
                if args[:2] == ('systemctl', 'reload'):
                    reloads += 1
                    if failure and reloads == 1:
                        raise RuntimeError('synthetic reload failure')
                    return ''
                raise AssertionError('Unexpected command: ' + repr(args))
            def atomic(path, data, expected, validate_config=False):
                self.assertEqual(path.read_bytes(), expected)
                path.write_bytes(data)
            with patch.object(enroll, 'CONFIG', config), patch.object(enroll, 'KEY_ROOT', keys), patch.object(enroll.os, 'geteuid', return_value=0, create=True), patch.object(enroll, 'require_binding', return_value=1), patch.object(enroll.net, 'trusted_file'), patch.object(enroll.net, 'require_idle_business'), patch.object(enroll.net, 'run', side_effect=run), patch.object(enroll.net, 'wait_listeners'), patch.object(enroll, 'atomic_file', side_effect=atomic):
                if failure or same_a_key:
                    with self.assertRaises(RuntimeError):
                        enroll.apply(MANIFEST)
                    self.assertEqual(config.read_bytes(), ORIGINAL.encode())
                    self.assertEqual(b.read_bytes(), enroll.EMPTY_KEYS)
                else:
                    report = enroll.apply(MANIFEST)
                    self.assertTrue(report['changed'])
                    self.assertFalse(report['identityStoreChanged'])
                    self.assertFalse(report['bDeviceLoginVerified'])
                    self.assertFalse(enroll.apply(MANIFEST)['changed'])
                self.assertEqual(a.read_bytes(), a_original)
                self.assertFalse(any(command[:2] == ('systemctl', 'restart') for command in calls))

    def test_enroll_idempotence_preserves_a_and_does_not_restart_backend(self):
        self.simulate()

    def test_reload_failure_revokes_new_key_and_restores_source_policy(self):
        self.simulate(failure=True)

    def test_a_public_key_cannot_be_enrolled_for_b(self):
        self.simulate(same_a_key=True)


if __name__ == '__main__':
    unittest.main()
