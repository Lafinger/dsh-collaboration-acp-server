"""Synthetic files only; never touch a service, network or active key."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


key = load('key_policy', 'set-cpa-key.py')
activate = load('activation_policy', 'activate-release.py')


class DeploymentPolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cpa-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / 'home'
        self.home.mkdir(mode=0o700)
        self.policy = self.home / 'login-only-policy.json'
        self.policy.write_text(json.dumps({'provider': 'codego', 'model': 'deepseek-v4.1-flash', 'modelRequestsAllowed': False}))
        self.policy.chmod(0o600)

    def test_hidden_key_stage_changes_no_active_store_and_outputs_no_key(self):
        with patch.object(key, 'HOME', self.home), patch.object(key, 'STAGED', self.home / '.cpa-key-staged.json'):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                key.stage_key('synthetic-key-only')
            staged = self.home / '.cpa-key-staged.json'
            self.assertEqual(staged.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(staged.read_text())['value'], 'synthetic-key-only')
            self.assertNotIn('synthetic-key-only', output.getvalue())
            self.assertFalse((self.home / '.credentials.yaml').exists())
            before = staged.read_bytes()
            for value in ['', 'short', 'contains space', 'bad\nnewline']:
                with self.assertRaises(RuntimeError):
                    key.stage_key(value)
                self.assertEqual(staged.read_bytes(), before)
            self.policy.write_text('{"modelRequestsAllowed":true}')
            with self.assertRaises(RuntimeError):
                key.stage_key('new-synthetic-key')
            self.assertEqual(staged.read_bytes(), before)

    def test_private_symlink_and_public_policy_refused_before_stage(self):
        with patch.object(key, 'HOME', self.home), patch.object(key, 'STAGED', self.home / '.cpa-key-staged.json'):
            self.policy.chmod(0o644)
            with self.assertRaises(RuntimeError):
                key.stage_key('synthetic-key-only')
            self.policy.chmod(0o600)
            outside = Path(self.temp.name) / 'outside'
            outside.write_text('unchanged')
            (self.home / '.cpa-key-staged.json').symlink_to(outside)
            with self.assertRaises(RuntimeError):
                key.stage_key('synthetic-key-only')
            self.assertEqual(outside.read_text(), 'unchanged')

    def test_noninteractive_input_does_not_prompt_or_write(self):
        with patch.object(key.sys, 'argv', ['set-cpa-key.py']), patch.object(key.sys, 'stdin', io.StringIO('secret')), patch.object(key.getpass, 'getpass') as prompt:
            with self.assertRaises(RuntimeError):
                key.main()
            prompt.assert_not_called()

    def test_route_changes_only_provider_model_and_credential_preserves_other_refs(self):
        original = {'serviceId': 'dingtalk-lan-test', 'provider': 'codego', 'model': 'deepseek-v4.1-flash', 'accounts': {'alice': 'synthetic'}, 'dingtalk': {'clientSecret': 'synthetic'}}
        result = activate.route_config(original)
        self.assertEqual(result, {**original, 'provider': 'cpa', 'model': 'deepseek-v4.1-flash'})
        self.assertEqual(original['provider'], 'codego')
        staged = {'version': 1, 'provider': 'cpa', 'model': 'deepseek-v4.1-flash', 'ref': 'CPA_API_KEY', 'value': 'synthetic-new-key'}
        store = {'version': 1, 'refs': {'CODEGO_API_KEY': 'synthetic-old-key', 'OTHER_REF': 'unchanged'}}
        result = activate.credential_config(store, staged)
        self.assertEqual(result['refs'], {'CPA_API_KEY': 'synthetic-new-key', 'OTHER_REF': 'unchanged'})
        self.assertIn('CODEGO_API_KEY', store['refs'])
        with self.assertRaises(RuntimeError):
            activate.credential_config(store, {**staged, 'provider': 'other'})

    def test_atomic_write_refuses_symlink_and_keeps_private_mode(self):
        target = self.home / 'file'
        activate.atomic_write(target, b'synthetic', os.geteuid(), os.getegid(), 0o600)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        linked = self.home / 'link'
        linked.symlink_to(target)
        with self.assertRaises(RuntimeError):
            activate.atomic_write(linked, b'wrong', os.geteuid(), os.getegid(), 0o600)
        self.assertEqual(target.read_bytes(), b'synthetic')

    def test_missing_staged_key_prevents_stop_and_active_configuration_change(self):
        root = Path(self.temp.name) / 'code'
        sha = 'a' * 40
        release = root / 'releases' / sha
        release.mkdir(parents=True)
        evidence = release / 'verified-release.json'
        evidence.write_text(json.dumps({'commit': sha, 'repository': 'Lafinger/dsh-collaboration-acp-server', 'ciConclusion': 'success', 'publicFiles': {}}))
        profile = self.home / 'profiles/collaboration-dingtalk'
        profile.mkdir(parents=True)
        (root / 'node_modules').mkdir()
        (profile / 'node_modules').symlink_to(root / 'node_modules')
        config = self.home / 'collaboration-acp-server.json'
        config.write_text(json.dumps({'serviceId': 'dingtalk-lan-test', 'provider': 'codego', 'model': 'deepseek-v4.1-flash'}))
        config.chmod(0o600)
        original = config.read_bytes()
        service = types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        real_check = activate.check_file
        def check(path, uid, private=False):
            return real_check(path, os.getuid(), private)
        with patch.multiple(activate, ROOT=root, HOME=self.home, PROFILE=profile, DROPIN=root / 'absent'), patch.object(activate, 'check_file', check), patch.object(activate.os, 'geteuid', return_value=0), patch.object(activate.pwd, 'getpwnam', return_value=service), patch.object(activate.sys, 'argv', ['activate-release.py', sha]), patch.object(activate, 'run', return_value='active') as run:
            with self.assertRaises(FileNotFoundError):
                activate.main()
            self.assertTrue(all(call.args[:2] == ('systemctl', 'is-active') for call in run.call_args_list))
        self.assertEqual(config.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
