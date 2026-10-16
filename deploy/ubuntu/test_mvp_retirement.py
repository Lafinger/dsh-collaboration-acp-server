"""Synthetic disposable metadata/DB fixtures only. Never reads or removes real collaboration data."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mvp_retirement_plan', Path(__file__).with_name('mvp-retirement-plan.py'))
plan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan)


class RetirementPlan(unittest.TestCase):
    def make_scope(self, root):
        for name in ['private-state/attachments', 'dsh-home/sessions/--srv-dsh-collaboration-test-workspace--', 'workspace', 'enrollment/provision-commands']:
            (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
        state = root / 'private-state'
        with sqlite3.connect(state / 'collaboration.sqlite') as db:
            db.executescript('CREATE TABLE projects(id TEXT); CREATE TABLE collaboration_members(account TEXT,user_id TEXT); CREATE TABLE collaboration_security_meta(key TEXT,value TEXT);')
            db.execute('INSERT INTO projects VALUES(?)', (plan.OLD_PROJECT,))
            db.executemany('INSERT INTO collaboration_members VALUES(?,?)', list(zip(plan.OLD_ACCOUNTS, ('03274727335337707128', 'manager7701'))))
            db.execute('INSERT INTO collaboration_security_meta VALUES(?,?)', ('scope', '["dingtalk-lan-test","synthetic-corp","synthetic-app"]'))
            for name, count in plan.EXPECTED_OLD.items():
                if name in ['projects', 'collaboration_members']:
                    continue
                db.execute('CREATE TABLE ' + name + '(id INTEGER)')
                db.executemany('INSERT INTO ' + name + ' VALUES(?)', [(n,) for n in range(count)])
            for name in plan.EMPTY_BUSINESS:
                db.execute('CREATE TABLE ' + name + '(id INTEGER)')
        with sqlite3.connect(state / 'access.sqlite') as db:
            db.executescript('CREATE TABLE access_sessions(id TEXT,owner TEXT,project_id TEXT); CREATE TABLE access_events(id INTEGER); CREATE TABLE access_requests(id INTEGER,state TEXT);')
            db.executemany('INSERT INTO access_sessions VALUES(?,?,?)', [(sid, plan.OLD_ACCOUNTS[1], plan.OLD_PROJECT) for sid in plan.EXPECTED_SESSIONS])
            db.executemany('INSERT INTO access_events VALUES(?)', [(n,) for n in range(1284)])
            db.executemany('INSERT INTO access_requests VALUES(?,?)', [(n, 'complete') for n in range(11)])
        (state / 'attachments' / plan.ATTACHMENT).write_bytes(b'x' * 77)
        group = root / 'dsh-home/sessions/--srv-dsh-collaboration-test-workspace--'
        for index, sid in enumerate(plan.EXPECTED_SESSIONS):
            directory = group / sid
            directory.mkdir(mode=0o700)
            (directory / 'session.lock').write_bytes(b'')
            (directory / 'session.v4.jsonl').write_bytes(b'x' * (147856 if index == 0 else 1024))
        for name in plan.ENROLLMENT_LEAVES:
            (root / 'enrollment' / name).write_text('SYNTHETIC_ID_METADATA', encoding='utf-8')
        (root / 'enrollment/application.json').write_text('DO_NOT_READ_OR_DELETE_APPLICATION_SECRET', encoding='utf-8')
        for p in root.rglob('*'):
            if p.is_file():
                p.chmod(0o600)
            elif p.is_dir():
                p.chmod(0o700)

    def under_scope(self, fn):
        with tempfile.TemporaryDirectory(prefix='offline-mvp-retirement-') as temp:
            root = Path(temp).resolve()
            self.make_scope(root)
            uid = os.getuid()
            # Production root remains strictly root-owned; only this synthetic root owner expectation is injected.
            canonical = plan.canonical_directory
            with patch.object(plan, 'canonical_directory', side_effect=lambda p, _uid, private=True: canonical(p, uid, private)):
                fn(root, uid)

    def test_exact_plan_is_metadata_only_stable_and_excludes_application(self):
        def check(root, uid):
            first = plan.build_plan(root, uid)
            self.assertEqual(first, plan.build_plan(root, uid))
            self.assertEqual(len(first['files']), 22)
            self.assertFalse(first['deleted'])
            self.assertFalse(first['backup'])
            self.assertNotIn('DO_NOT_READ', str(first))
            self.assertFalse(any(row['path'].endswith('/application.json') for row in first['files']))
            self.assertTrue((root / 'enrollment/application.json').exists())
        self.under_scope(check)

    def test_new_business_running_turns_mixed_sessions_and_unknown_leaves_refuse(self):
        mutations = [
            lambda r: (r / 'private-state/unrelated.sqlite').write_bytes(b'preserve'),
            lambda r: (r / 'workspace/unexpected.txt').write_bytes(b'preserve'),
            lambda r: (r / 'dsh-home/sessions/extra').mkdir(),
            lambda r: (r / 'private-state/attachments' / plan.ATTACHMENT).write_bytes(b'changed'),
        ]
        for mutation in mutations:
            def check(root, uid):
                mutation(root)
                with self.assertRaises(RuntimeError):
                    plan.build_plan(root, uid)
            self.under_scope(check)
        for sql in ["INSERT INTO tasks VALUES(99)", "INSERT INTO projects VALUES('unrelated')"]:
            def check(root, uid):
                with sqlite3.connect(root / 'private-state/collaboration.sqlite') as db:
                    db.execute(sql)
                with self.assertRaises(RuntimeError):
                    plan.build_plan(root, uid)
            self.under_scope(check)
        def running(root, uid):
            with sqlite3.connect(root / 'private-state/access.sqlite') as db:
                db.execute("UPDATE access_requests SET state='running' WHERE id=0")
            with self.assertRaises(RuntimeError):
                plan.build_plan(root, uid)
        self.under_scope(running)

    def test_symlink_hardlink_wrong_permissions_and_unknown_session_artifact_refuse(self):
        def symlink(root, uid):
            p = root / 'private-state/attachments' / plan.ATTACHMENT
            p.unlink()
            p.symlink_to(root / 'enrollment/application.json')
            with self.assertRaises(RuntimeError):
                plan.build_plan(root, uid)
        def hardlink(root, uid):
            os.link(root / 'private-state/attachments' / plan.ATTACHMENT, root / 'outside-link')
            with self.assertRaises(RuntimeError):
                plan.build_plan(root, uid)
        def permissions(root, uid):
            (root / 'enrollment/verified-members.json').chmod(0o644)
            with self.assertRaises(RuntimeError):
                plan.build_plan(root, uid)
        def extra_log(root, uid):
            (root / 'dsh-home/sessions/--srv-dsh-collaboration-test-workspace--' / plan.EXPECTED_SESSIONS[0] / 'other.jsonl').write_bytes(b'preserve')
            with self.assertRaises(RuntimeError):
                plan.build_plan(root, uid)
        for fn in [symlink, hardlink, permissions, extra_log]:
            self.under_scope(fn)


if __name__ == '__main__':
    unittest.main()
