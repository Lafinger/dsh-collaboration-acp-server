import {createHash} from 'node:crypto';
import {IdentityStore} from './identity-store.mjs';
import {AccessError,requireText} from './protocol.mjs';
const deny=()=>{throw new AccessError(-32003,'组织身份或登录不可用');};

/** Fresh MVP store: official identity auto-enrollment, all projects visible; no member-management API. */
export class MvpIdentityStore extends IdentityStore {
  get authenticationMode(){return 'mvp-https-v1';}
  get enrollmentActor(){return 'official-pc-login';}
  constructor({administratorUserId,...options}){
    super({...options,loginTtlMs:43200000});
    this.administratorUserId=requireText(administratorUserId,'指定管理员员工标识',200);
    this.loginTtlMs=604800000;
    this.transaction(()=>{
      const mode=this.db.prepare("SELECT value FROM collaboration_security_meta WHERE key='authentication-mode'").get()?.value;
      if(mode!==undefined&&mode!==this.authenticationMode)throw new Error('Authorization store uses another authentication mode; explicit upgrade required');
      if(mode===undefined&&(this.db.prepare('SELECT 1 FROM collaboration_members LIMIT 1').get()||this.db.prepare('SELECT 1 FROM projects LIMIT 1').get()))throw new Error('MVP requires fresh collaboration state; no legacy identity/business adoption');
      this.db.prepare("INSERT OR IGNORE INTO collaboration_security_meta VALUES('authentication-mode',?)").run(this.authenticationMode);
      const key='mvp-administrator-user',previous=this.db.prepare('SELECT value FROM collaboration_security_meta WHERE key=?').get(key)?.value;
      if(previous!==undefined&&previous!==this.administratorUserId)throw new Error('Fixed MVP administrator identity changed; explicit fresh deployment required');
      this.db.prepare('INSERT OR IGNORE INTO collaboration_security_meta VALUES(?,?)').run(key,this.administratorUserId);
      if(this.db.prepare('SELECT 1 FROM collaboration_members WHERE administrator=1 AND user_id<>?').get(this.administratorUserId))throw new Error('Legacy administrator store cannot become MVP state');
    });
    this.db.exec(`CREATE TABLE IF NOT EXISTS mvp_member_names(account TEXT PRIMARY KEY REFERENCES collaboration_members(account),name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_project_revisions(project_id TEXT PRIMARY KEY REFERENCES projects(id),revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mvp_admin_commands(id TEXT PRIMARY KEY,account TEXT NOT NULL,body_hash TEXT NOT NULL,result TEXT NOT NULL);`);
  }
  enroll(identity){
    const {corpId,userId,unionId,internal}=identity??{};
    if(corpId!==this.corpId||internal!==true)deny();requireText(userId,'员工身份',200);requireText(unionId,'组织用户身份',200);
    return this.transaction(()=>{
      const found=this.db.prepare('SELECT * FROM collaboration_members WHERE corp_id=? AND client_id=? AND user_id=?').get(this.corpId,this.clientId,userId);
      if(found&&(!found.enabled||found.union_id!==unionId))deny();
      const account=found?.account??('dt_'+createHash('sha256').update(JSON.stringify([this.corpId,this.clientId,userId])).digest('hex').slice(0,20));
      if(!found){
        if(this.member(account))deny();
        this.db.prepare('INSERT INTO collaboration_members(account,corp_id,client_id,user_id,union_id,enabled,administrator) VALUES(?,?,?,?,?,1,?)').run(account,this.corpId,this.clientId,userId,unionId,userId===this.administratorUserId?1:0);
        this.audit(this.enrollmentActor,'member-auto-enroll',account);
      }
      if(!!this.member(account).administrator!==(userId===this.administratorUserId))deny();
      const name=typeof identity.name==='string'&&identity.name.trim()&&identity.name.length<=200?identity.name.trim():userId;
      this.db.prepare('INSERT INTO mvp_member_names VALUES(?,?) ON CONFLICT(account) DO UPDATE SET name=excluded.name').run(account,name);
      this.markVerified(account,identity);return this.member(account);
    });
  }
  requireProject(account,projectId){
    this.requireMember(account);requireText(projectId,'项目',200);
    if(!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId))deny();
    return {enabled:1,revision:1};
  }
  projects(account){this.requireMember(account);return this.db.prepare('SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at,id').all().map(row=>row.id);}
  display(account){const member=this.requireMember(account);return {account,name:this.db.prepare('SELECT name FROM mvp_member_names WHERE account=?').get(account)?.name??account,administrator:!!member.administrator};}
}
