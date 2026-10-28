import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AccessError, requireText } from './protocol.mjs';
import { inTransaction } from '../business/lib/sqlite/schema.js';

export const hashSecret = value => createHash('sha256').update(value).digest('hex');
export const opaqueSecret = () => randomBytes(32).toString('base64url');
const deny = () => { throw new AccessError(-32003, 'Member authentication or authorization unavailable'); };
const label = value => {
  requireText(value, 'member account', 200);
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new AccessError(-32602, 'Invalid member account');
  return value;
};

/** Plugin-owned authorization metadata. Shares the business connection for atomic checks/writes. */
export class IdentityStore extends EventEmitter {
  constructor({ db, serviceId, corpId, clientId, now = Date.now, organizationTtlMs = 900000, loginTtlMs = 43200000 }) {
    super(); this.db = db; this.serviceId = requireText(serviceId, 'serviceId', 200);
    this.corpId = requireText(corpId, 'corpId', 200); this.clientId = requireText(clientId, 'clientId', 200); this.now = now;
    if (!Number.isSafeInteger(organizationTtlMs) || organizationTtlMs <= 0 || organizationTtlMs > 3600000
      || !Number.isSafeInteger(loginTtlMs) || loginTtlMs <= 0 || loginTtlMs > 43200000) throw new Error('Identity validity exceeds approved limits');
    this.organizationTtlMs = organizationTtlMs; this.loginTtlMs = loginTtlMs;
    db.exec('PRAGMA synchronous=FULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_security_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_members(
        account TEXT PRIMARY KEY,corp_id TEXT NOT NULL,client_id TEXT NOT NULL,user_id TEXT NOT NULL,
        union_id TEXT NOT NULL,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),administrator INTEGER NOT NULL CHECK(administrator IN(0,1)),
        revision INTEGER NOT NULL DEFAULT 1,verified_until INTEGER NOT NULL DEFAULT 0,
        UNIQUE(corp_id,client_id,user_id),UNIQUE(corp_id,client_id,union_id));
      CREATE TABLE IF NOT EXISTS collaboration_participants(
        project_id TEXT NOT NULL REFERENCES projects(id),account TEXT NOT NULL REFERENCES collaboration_members(account),
        enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(project_id,account));
      CREATE TABLE IF NOT EXISTS collaboration_logins(
        id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,account TEXT NOT NULL REFERENCES collaboration_members(account),
        device_id TEXT NOT NULL,member_revision INTEGER NOT NULL,epoch TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS collaboration_login_requests(
        id TEXT PRIMARY KEY,account TEXT NOT NULL,device_id TEXT NOT NULL,proof_hash TEXT NOT NULL,state TEXT NOT NULL UNIQUE,
        browser_hash TEXT,code_hash TEXT UNIQUE,status TEXT NOT NULL,expires_at INTEGER NOT NULL,epoch TEXT NOT NULL,member_revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_security_audit(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,subject TEXT NOT NULL);
    `);
    this.transaction(() => {
      const scope = JSON.stringify([serviceId, corpId, clientId]);
      const prior = db.prepare("SELECT value FROM collaboration_security_meta WHERE key='scope'").get()?.value;
      if (prior !== undefined && prior !== scope) throw new Error('Authorization store belongs to a different service/organization/application; explicit migration required');
      db.prepare("INSERT OR IGNORE INTO collaboration_security_meta VALUES('scope',?)").run(scope);
      db.prepare("INSERT OR IGNORE INTO collaboration_security_meta VALUES('epoch',?)").run(randomUUID());
    });
  }
  get epoch() { return this.db.prepare("SELECT value FROM collaboration_security_meta WHERE key='epoch'").get().value; }
  transaction(fn) { return inTransaction(this.db,fn); }
  audit(actor, action, subject) { this.db.prepare('INSERT INTO collaboration_security_audit(at,actor,action,subject) VALUES(?,?,?,?)').run(this.now(),actor,action,subject); }
  member(account) { return this.db.prepare('SELECT * FROM collaboration_members WHERE account=?').get(account) ?? null; }
  /** Local administrator command only; never exposed as a model tool or public RPC. */
  bind({ account, userId, unionId, administrator = false }, actor = 'local-administrator') {
    label(account); requireText(userId,'organization userId',200); requireText(unionId,'scoped unionId',200);
    if (typeof administrator !== 'boolean') throw new AccessError(-32602,'Invalid administrator flag');
    this.transaction(() => {
      const prior = this.member(account);
      if (prior && (prior.user_id !== userId || prior.union_id !== unionId)) throw new AccessError(-32003,'Account already bound; identity replacement requires a distinct account to preserve history');
      this.db.prepare(`INSERT INTO collaboration_members(account,corp_id,client_id,user_id,union_id,enabled,administrator)
        VALUES(?,?,?,?,?,1,?) ON CONFLICT(account) DO UPDATE SET enabled=1,administrator=excluded.administrator,revision=revision+1,verified_until=0`)
        .run(account,this.corpId,this.clientId,userId,unionId,administrator?1:0);
      this.db.prepare('UPDATE collaboration_logins SET revoked=1 WHERE account=?').run(account);
      if(prior)this.suspendPending(account,null,'Member qualification reprovisioned');
      this.audit(actor,'member-bind',account);
    });
    this.emit('authorization-change',{account});
    return { account, enabled: true, administrator };
  }
  setEnabled(account, enabled, actor = 'local-administrator') {
    if (typeof enabled !== 'boolean' || !this.member(account)) deny();
    this.transaction(() => {
      this.db.prepare('UPDATE collaboration_members SET enabled=?,revision=revision+1,verified_until=0 WHERE account=?').run(enabled?1:0,account);
      this.db.prepare('UPDATE collaboration_logins SET revoked=1 WHERE account=?').run(account);
      if (!enabled) this.suspendPending(account,null,'Member qualification revoked');
      this.audit(actor,enabled?'member-enable':'member-disable',account);
    });
    this.emit('authorization-change',{account});
  }
  participate(projectId, account, enabled, actor = 'local-administrator') {
    if (typeof enabled !== 'boolean' || !this.member(account) || !this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) deny();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO collaboration_participants(project_id,account,enabled) VALUES(?,?,?)
        ON CONFLICT(project_id,account) DO UPDATE SET enabled=excluded.enabled,revision=revision+1`).run(projectId,account,enabled?1:0);
      if (!enabled) this.suspendPending(account,projectId,'Project participation revoked');
      this.audit(actor,enabled?'project-grant':'project-revoke',JSON.stringify([projectId,account]));
    });
    this.emit('authorization-change',{account,projectId});
  }
  suspendPending(account, projectId, reason) {
    // New business schema owns suspension state; fail closed rather than silently omit protection.
    this.db.prepare(`INSERT OR IGNORE INTO plan_suspensions(plan_id,plan_version,at,reason)
      SELECT DISTINCT p.id,p.version,?,? FROM plans p JOIN plan_roles r ON r.plan_id=p.id AND r.version=p.version
      JOIN project_roles pr ON pr.project_id=p.project_id AND pr.role=r.role
      LEFT JOIN confirmations c ON c.plan_id=p.id AND c.plan_version=p.version AND c.role=r.role
      WHERE p.activated_at IS NULL AND p.version=(SELECT MAX(q.version) FROM plans q WHERE q.id=p.id)
      AND (pr.member_label=? OR c.submitted_by=?) AND (? IS NULL OR p.project_id=?)`)
      .run(new Date(this.now()).toISOString(),reason,account,account,projectId,projectId);
  }
  markVerified(account, {corpId,userId,unionId,internal}) {
    const m = this.member(account);
    if (!m || !m.enabled || corpId!==this.corpId || userId!==m.user_id || unionId!==m.union_id || internal!==true) deny();
    this.db.prepare('UPDATE collaboration_members SET verified_until=? WHERE account=?').run(this.now()+this.organizationTtlMs,account);
  }
  invalidateOrganization(account,revision){
    this.transaction(()=>{const current=this.member(account);if(!current||current.revision!==revision)return;
      this.db.prepare('UPDATE collaboration_members SET revision=revision+1,verified_until=0 WHERE account=?').run(account);
      this.db.prepare('UPDATE collaboration_logins SET revoked=1 WHERE account=?').run(account);
      this.suspendPending(account,null,'Organization qualification explicitly revoked');this.audit('official-organization-refresh','member-qualification-revoked',account);
    });this.emit('authorization-change',{account});
  }
  requireMemberLink(account) {
    const m = this.member(account);
    if (!m || !m.enabled || m.corp_id!==this.corpId || m.client_id!==this.clientId) deny();
    return m;
  }
  requireMember(account) {
    const m = this.requireMemberLink(account);
    if (m.verified_until<=this.now()) deny();
    return m;
  }
  requireAdministrator(account) { const m = this.requireMember(account); if (!m.administrator) deny(); return m; }
  requireProjectLink(account, projectId) {
    this.requireMemberLink(account);
    const p = this.db.prepare('SELECT enabled,revision FROM collaboration_participants WHERE account=? AND project_id=?').get(account,projectId);
    if (!p?.enabled || !this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) deny();
    return p;
  }
  requireProject(account, projectId) {
    this.requireMember(account);
    return this.requireProjectLink(account, projectId);
  }
  projects(account) {
    this.requireMember(account);
    return this.db.prepare('SELECT project_id FROM collaboration_participants WHERE account=? AND enabled=1 ORDER BY project_id').all(account).map(p=>p.project_id);
  }
  roles(account, projectId) {
    this.requireProject(account,projectId);
    return this.db.prepare('SELECT role FROM project_roles WHERE project_id=? AND member_label=? ORDER BY role').all(projectId,account).map(r=>r.role);
  }
  issueLogin(account, deviceId) {
    requireText(deviceId,'deviceId',200); const m=this.requireMember(account), token=opaqueSecret(), id=randomUUID(), expiresAt=this.now()+this.loginTtlMs;
    this.db.prepare('INSERT INTO collaboration_logins VALUES(?,?,?,?,?,?,?,0)').run(id,hashSecret(token),account,deviceId,m.revision,this.epoch,expiresAt);
    return { token,loginId:id,account,serviceId:this.serviceId,deviceId,expiresAt,epoch:this.epoch };
  }
  verifyLogin(token, expectedAccount, deviceId) {
    if (typeof token!=='string' || token.length>200 || !token.trim()) deny();
    const login=this.db.prepare('SELECT * FROM collaboration_logins WHERE token_hash=?').get(hashSecret(token));
    if (!login || login.revoked || login.expires_at<=this.now() || login.epoch!==this.epoch || login.account!==expectedAccount || login.device_id!==deviceId) deny();
    const m=this.requireMember(login.account); if (login.member_revision!==m.revision) deny();
    return { account:login.account,serviceId:this.serviceId,loginId:login.id,deviceId,expiresAt:login.expires_at,epoch:login.epoch };
  }
  assertLogin(identity, m) {
    const row=this.db.prepare('SELECT * FROM collaboration_logins WHERE id=?').get(identity?.loginId);
    if(!row||row.account!==identity.account||row.device_id!==identity.deviceId||row.revoked||row.expires_at<=this.now()||row.epoch!==this.epoch||row.member_revision!==m.revision)deny();
    return identity;
  }
  requireLogin(identity) { return this.assertLogin(identity, this.requireMember(identity?.account)); }
  requireLoginLink(identity) { return this.assertLogin(identity, this.requireMemberLink(identity?.account)); }
  revokeDevice(token,account,deviceId){
    if(typeof token!=='string'||token.length>200||!token.trim())deny();requireText(deviceId,'deviceId',200);
    const row=this.db.prepare('SELECT id,account,device_id FROM collaboration_logins WHERE token_hash=?').get(hashSecret(token));
    if(!row||row.account!==account||row.device_id!==deviceId)deny();this.revokeLogin(row.id);
  }
  revokeLogin(loginId) {
    this.db.prepare('UPDATE collaboration_logins SET revoked=1 WHERE id=?').run(loginId);
    this.emit('login-revoked',{loginId});
  }
  revokeAllDevices(actor='local-administrator') {
    this.transaction(()=>{
      this.db.prepare('UPDATE collaboration_logins SET revoked=1').run();
      this.db.prepare("UPDATE collaboration_login_requests SET status='expired'").run();
      this.db.prepare("UPDATE collaboration_security_meta SET value=? WHERE key='epoch'").run(randomUUID());
      this.audit(actor,'new-test-epoch','all-devices');
    });
    this.emit('authorization-change',{});
  }
}
