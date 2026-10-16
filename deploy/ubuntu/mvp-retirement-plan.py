"""Read-only exact-scope retirement plan. No delete/stop/userdel/config writes in this module.
Run as the existing service owner. Stop services and hold the existing maintenance/session locks before applying any separately reviewed plan.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat

ROOT = Path('/srv/dsh-collaboration-test')
OLD_SERVICE = 'dingtalk-lan-test'
OLD_PROJECT = '74eb5e97eb9445d995caed52211f9192'
OLD_ACCOUNTS = ('dt_b7a8377e73575cacd1af', 'dt_f66d225ac622aaf111a0')
EXPECTED_SESSIONS = ('00d8d049-5f85-44ba-96aa-90e479125886', '12e32613-97bd-4af9-9150-432cc2af6fc1', '175edf9c-7dd1-469a-9f65-655f96033132', '5f023fbc-5c15-4ef7-bb44-3c7142a5a3b2', '722d6f5e-e706-45aa-9244-f031fe898c25', 'e3da3e26-a4d9-4c06-91fa-0e92f4600caa')
STATE_LEAVES = {'access.sqlite', 'access.sqlite-wal', 'access.sqlite-shm', 'collaboration.sqlite', 'collaboration.sqlite-wal', 'collaboration.sqlite-shm', 'collaboration-maintenance.lock', 'native-probe.lock'}
ATTACHMENT = 'e0a98c898bd539ec1956aa5ed2fcdf222efa7a17e88d56b41fbf5c9ae65853ef.bin'
ENROLLMENT_LEAVES = {'verified-members.json', 'provision-result.json', 'provision-commands/bind-0.json', 'provision-commands/bind-1.json', 'provision-commands/create-demo.json', 'final-backend-evidence.json', 'login-readiness-evidence.json'}
EXPECTED_OLD = {'projects': 1, 'collaboration_members': 2, 'collaboration_participants': 2, 'collaboration_logins': 9, 'collaboration_login_requests': 21, 'attachment_receipts': 1, 'session_members': 6}
EMPTY_BUSINESS = ('materials', 'material_versions', 'analyses', 'plans', 'tasks', 'result_versions', 'confirmations', 'acceptances', 'collaboration_inbox', 'collaboration_outbox')


def canonical_directory(path, uid, private=True):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise RuntimeError('Canonical absolute retirement directory required')
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != uid or s.st_mode & (0o077 if private else 0o022):
        raise RuntimeError('Unexpected directory owner or permissions')
    # Reject symlink ancestors even when they happen to resolve back into this tree.
    for parent in path.parents:
        if parent.is_symlink():
            raise RuntimeError('Retirement ancestor is a symlink')
    return path


def metadata(path, uid):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != uid or s.st_nlink != 1 or s.st_mode & 0o077 or path.resolve(strict=True) != path:
        raise RuntimeError('Unexpected retirement file type/owner/links/permissions')
    return {'path': str(path), 'bytes': s.st_size, 'uid': s.st_uid, 'gid': s.st_gid, 'mode': stat.S_IMODE(s.st_mode), 'device': s.st_dev, 'inode': s.st_ino}


def scoped_database(path):
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    return db


def require_old_rows(state):
    with closing(scoped_database(state / 'collaboration.sqlite')) as db:
        if [r[0] for r in db.execute('SELECT id FROM projects')] != [OLD_PROJECT]:
            raise RuntimeError('Project scope changed; inspect instead of destructive reuse')
        scope = json.loads(db.execute("SELECT value FROM collaboration_security_meta WHERE key='scope'").fetchone()[0])
        if not isinstance(scope, list) or len(scope) != 3 or scope[0] != OLD_SERVICE:
            raise RuntimeError('Original service scope differs')
        if tuple(r for r in db.execute('SELECT account,user_id FROM collaboration_members ORDER BY account')) != tuple(zip(OLD_ACCOUNTS, ('03274727335337707128', 'manager7701'))):
            raise RuntimeError('Member scope changed')
        if any(db.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0] != count for table, count in EXPECTED_OLD.items()):
            raise RuntimeError('Known old business/identity counts changed')
        if any(db.execute('SELECT count(*) FROM "' + table + '"').fetchone()[0] for table in EMPTY_BUSINESS):
            raise RuntimeError('New business or queued communication exists')
    with closing(scoped_database(state / 'access.sqlite')) as db:
        rows = db.execute('SELECT id,owner,project_id FROM access_sessions ORDER BY id').fetchall()
        if tuple(r[0] for r in rows) != EXPECTED_SESSIONS or any(r[1] != OLD_ACCOUNTS[1] or r[2] != OLD_PROJECT for r in rows):
            raise RuntimeError('Conversation scope is not exclusively approved old project/member')
        if db.execute("SELECT count(*) FROM access_requests WHERE state='running'").fetchone()[0]:
            raise RuntimeError('A business turn is running; never force-stop it')
        if db.execute('SELECT count(*) FROM access_events').fetchone()[0] != 1284 or db.execute('SELECT count(*) FROM access_requests').fetchone()[0] != 11:
            raise RuntimeError('Conversation metadata changed')


def build_plan(root=ROOT, uid=None):
    uid = os.getuid() if uid is None else uid
    root = canonical_directory(root, 0, private=False)
    state = canonical_directory(root / 'private-state', uid)
    sessions = canonical_directory(root / 'dsh-home/sessions', uid)
    workspace = canonical_directory(root / 'workspace', uid)
    enrollment = canonical_directory(root / 'enrollment', uid)
    if list(workspace.iterdir()):
        raise RuntimeError('Old workspace is no longer empty; inspect exact ownership')
    # Reject unexpected/symlink database leaves before opening even a read-only connection.
    for name in ['collaboration.sqlite', 'access.sqlite']:
        metadata(state / name, uid)
    require_old_rows(state)
    leaves = []
    for p in sorted(state.rglob('*')):
        rel = p.relative_to(state).as_posix()
        if p.is_dir() and not p.is_symlink() and rel == 'attachments':
            canonical_directory(p, uid)
            continue
        if rel not in STATE_LEAVES and rel != 'attachments/' + ATTACHMENT:
            raise RuntimeError('Unexpected state entry; no broad tree deletion')
        leaves.append(metadata(p, uid))
    attachments = [r for r in leaves if r['path'].endswith('/' + ATTACHMENT)]
    if len(attachments) != 1 or attachments[0]['bytes'] != 77:
        raise RuntimeError('Attachment inventory changed')
    # Official persistence layout: one cwd grouping, exact six session directories; no unrelated logs.
    group = sessions / '--srv-dsh-collaboration-test-workspace--'
    canonical_directory(group, uid)
    if list(sessions.iterdir()) != [group] or sorted(p.name for p in group.iterdir()) != list(EXPECTED_SESSIONS):
        raise RuntimeError('Extra or missing remote session directory')
    session_files = []
    for sid in EXPECTED_SESSIONS:
        directory = canonical_directory(group / sid, uid)
        if sorted(p.name for p in directory.iterdir()) != ['session.lock', 'session.v4.jsonl']:
            raise RuntimeError('Unexpected session artifacts')
        session_files.extend(metadata(directory / n, uid) for n in ['session.lock', 'session.v4.jsonl'])
    if sum(r['bytes'] for r in session_files) != 152976:
        raise RuntimeError('Conversation file metadata changed')
    leaves.extend(session_files)
    # Preserve application.json and every unknown enrollment leaf, do not traverse them.
    canonical_directory(enrollment / 'provision-commands', uid)
    if sorted(p.name for p in (enrollment / 'provision-commands').iterdir()) != ['bind-0.json', 'bind-1.json', 'create-demo.json']:
        raise RuntimeError('Unexpected old provisioning command; inspect')
    for name in sorted(ENROLLMENT_LEAVES):
        path = enrollment / name
        if not path.exists():
            raise RuntimeError('Expected old enrollment metadata missing; inspect')
        leaves.append(metadata(path, uid))
    plan = {'version': 1, 'oldServiceId': OLD_SERVICE, 'oldProjectId': OLD_PROJECT, 'oldAccounts': list(OLD_ACCOUNTS), 'root': str(root), 'files': leaves, 'remoteSessionIds': list(EXPECTED_SESSIONS), 'backup': False, 'deleted': False}
    plan['metadataPlanSha256'] = hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return plan


if __name__ == '__main__':
    # Metadata only: no chat/attachment body, identity secrets or original app credentials are read/printed.
    print(json.dumps(build_plan(), indent=2))
