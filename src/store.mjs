import { DatabaseSync } from 'node:sqlite';
import { AccessError } from './protocol.mjs';

/** Access metadata only. Business records remain in the collaboration's own authoritative database. */
export class AccessStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS access_sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_events(session_id TEXT NOT NULL REFERENCES access_sessions(id), seq INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(session_id,seq));
      CREATE TABLE IF NOT EXISTS access_requests(session_id TEXT NOT NULL REFERENCES access_sessions(id), request_id TEXT NOT NULL,
        state TEXT NOT NULL, PRIMARY KEY(session_id,request_id));`);
    const columns=new Set(this.db.prepare('PRAGMA table_info(access_sessions)').all().map(c=>c.name));
    for(const [column,type]of [['project_id','TEXT'],['participant_revision','INTEGER'],['member_revision','INTEGER'],['epoch','TEXT']])if(!columns.has(column))this.db.exec(`ALTER TABLE access_sessions ADD COLUMN ${column} ${type}`);
    // Recovery is never a license to re-run a previously submitted request.
    this.db.exec("UPDATE access_requests SET state='interrupted' WHERE state='running'");
  }
  create(id, owner, scope={}) { this.db.prepare('INSERT INTO access_sessions(id,owner,created_at,project_id,participant_revision,member_revision,epoch) VALUES(?,?,?,?,?,?,?)').run(id, owner, Date.now(),scope.projectId??null,scope.participantRevision??null,scope.memberRevision??null,scope.epoch??null); }
  scope(id) { return this.db.prepare('SELECT project_id,participant_revision,member_revision,epoch FROM access_sessions WHERE id=?').get(id)??null; }
  owner(id) { return this.db.prepare('SELECT owner FROM access_sessions WHERE id=?').get(id)?.owner ?? null; }
  requireOwner(id, account) {
    if (this.owner(id) !== account) throw new AccessError(-32004, 'Session not available to this account');
  }
  list(account) { return this.db.prepare('SELECT id AS sessionId,created_at AS createdAt,project_id AS projectId FROM access_sessions WHERE owner=? ORDER BY created_at,id').all(account); }
  append(id, update) {
    const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM access_events WHERE session_id=?').get(id).seq);
    this.db.prepare('INSERT INTO access_events VALUES(?,?,?)').run(id, seq, JSON.stringify(update));
    return { seq, update };
  }
  events(id, after = 0) { return this.db.prepare('SELECT seq,payload FROM access_events WHERE session_id=? AND seq>? ORDER BY seq').all(id, after).map(r => ({ seq: Number(r.seq), update: JSON.parse(r.payload) })); }
  begin(id, requestId) {
    const existing = this.db.prepare('SELECT state FROM access_requests WHERE session_id=? AND request_id=?').get(id, requestId);
    if (existing) throw new AccessError(-32005, 'Request already submitted; automatic replay is forbidden', { state: existing.state });
    this.db.prepare('INSERT INTO access_requests VALUES(?,?,?)').run(id, requestId, 'running');
  }
  settle(id, requestId, state) { this.db.prepare('UPDATE access_requests SET state=? WHERE session_id=? AND request_id=?').run(state, id, requestId); }
  status(id) { return this.db.prepare('SELECT request_id AS requestId,state FROM access_requests WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(id) ?? null; }
  close() { this.db.close(); }
}
