import {randomUUID,randomBytes} from 'node:crypto';
import {LoginService} from './login-service.mjs';
import {hashSecret,opaqueSecret} from './identity-store.mjs';
import {AccessError,requireText} from './protocol.mjs';
const unavailable=()=>{throw new AccessError(-32003,'登录请求不可用或已过期，请在原DSH明确重新发起');};
const secret=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))unavailable();return value;};

/** PC app login binds official identity only AFTER login; no preallocated account or client-asserted name. */
export class MvpLoginService extends LoginService {
  constructor({agentId,...options}){
    super(options);if(typeof agentId!=='string'||!/^\d{1,30}$/.test(agentId))throw new Error('Official PC application AgentId required');this.agentId=agentId;
    this.db.exec(`CREATE TABLE IF NOT EXISTS mvp_login_requests(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,proof_hash TEXT NOT NULL,browser_hash TEXT,browser_token TEXT UNIQUE NOT NULL,pairing_code TEXT UNIQUE NOT NULL,code_hash TEXT UNIQUE,identity_json TEXT,account TEXT,status TEXT NOT NULL,expires_at INTEGER NOT NULL,epoch TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mvp_login_expiry ON mvp_login_requests(expires_at);`);
    this.expireInterrupted();
  }
  expireInterrupted(){
    this.db.prepare("UPDATE mvp_login_requests SET status='failed',identity_json=NULL WHERE status IN('processing','claiming')").run();
  }
  start(_account,deviceId,proof){
    requireText(deviceId,'设备',200);secret(proof);
    // Retain only short-lived replay evidence; never accumulate browser secrets or staged personal data.
    this.db.prepare('DELETE FROM mvp_login_requests WHERE expires_at<=?').run(this.now()-300000);
    this.db.prepare('UPDATE mvp_login_requests SET identity_json=NULL WHERE expires_at<=?').run(this.now());
    const active=this.db.prepare("SELECT count(*) n FROM mvp_login_requests WHERE expires_at>? AND status IN('pending','processing','identified','verified')").get(this.now()).n;
    const own=this.db.prepare("SELECT count(*) n FROM mvp_login_requests WHERE device_id=? AND expires_at>? AND status IN('pending','processing','identified','verified')").get(deviceId,this.now()).n;
    if(active>=200||own>=3)throw new AccessError(-32007,'待登录请求过多，请等候已有请求失效');
    const id=randomUUID(),browserToken=opaqueSecret(),pairingCode=randomBytes(8).toString('hex').toUpperCase(),expiresAt=this.now()+300000;
    this.db.prepare('INSERT INTO mvp_login_requests(id,device_id,proof_hash,browser_token,pairing_code,status,expires_at,epoch) VALUES(?,?,?,?,?,?,?,?)').run(id,deviceId,hashSecret(proof),browserToken,pairingCode,'pending',expiresAt,this.identities.epoch);
    const loginUrl=`${this.origin}/collaboration/pc-login#${browserToken}`;
    const target=new URL('dingtalk://dingtalkclient/action/openapp');target.search=new URLSearchParams({corpid:this.identities.corpId,container_type:'work_platform',app_id:'0_'+this.agentId,redirect_type:'jump',redirect_url:loginUrl}).toString();
    return {requestId:id,loginUrl,openUrl:target.href,pairingCode,expiresAt};
  }
  request(id){
    const row=this.db.prepare('SELECT * FROM mvp_login_requests WHERE id=?').get(id);
    if(!row||row.expires_at<=this.now()||row.epoch!==this.identities.epoch)unavailable();return row;
  }
  browser(token,cookie){
    secret(token);const candidate=this.db.prepare('SELECT id FROM mvp_login_requests WHERE browser_token=?').get(token);if(!candidate)unavailable();
    const row=this.request(candidate.id);if(row.status!=='pending')unavailable();
    if(row.browser_hash){if(!cookie||hashSecret(cookie)!==row.browser_hash)unavailable();}
    else{cookie=opaqueSecret();this.db.prepare("UPDATE mvp_login_requests SET browser_hash=? WHERE id=? AND status='pending'").run(hashSecret(cookie),row.id);}
    return {requestId:row.id,cookie,serviceId:this.identities.serviceId,corpId:this.identities.corpId,clientId:this.identities.clientId,expiresAt:row.expires_at,pairingCode:row.pairing_code};
  }
  pair(pairingCode,cookie){
    if(typeof pairingCode!=='string'||!/^[A-F0-9]{16}$/.test(pairingCode))unavailable();
    const row=this.db.prepare('SELECT browser_token FROM mvp_login_requests WHERE pairing_code=?').get(pairingCode);if(!row)unavailable();
    return this.browser(row.browser_token,cookie);
  }
  async authorize({requestId,cookie,code}){
    requireText(code,'PC授权码',4096);const row=this.request(requestId);
    if(row.status!=='pending'||!cookie||hashSecret(cookie)!==row.browser_hash)unavailable();
    this.identities.transaction(()=>{
      const current=this.request(requestId);if(current.status!=='pending')unavailable();
      this.db.prepare("UPDATE mvp_login_requests SET status='processing',code_hash=? WHERE id=? AND status='pending'").run(hashSecret(code),requestId);
    });
    try{
      const identity=await this.provider.exchangePc(code);
      return this.identities.transaction(()=>{
        const current=this.request(requestId);if(current.status!=='processing'||identity.corpId!==this.identities.corpId||identity.internal!==true)unavailable();
        requireText(identity.userId,'员工身份',200);requireText(identity.unionId,'组织身份',200);
        // Stage verified identity first; the page must show the actual person before approval.
        this.db.prepare("UPDATE mvp_login_requests SET status='identified',identity_json=? WHERE id=?").run(JSON.stringify(identity),requestId);
        return {identified:true,name:identity.name??identity.userId,corpId:identity.corpId,serviceId:this.identities.serviceId};
      });
    }catch{
      this.db.prepare("UPDATE mvp_login_requests SET status='failed' WHERE id=? AND status='processing'").run(requestId);unavailable();
    }
  }
  confirm({requestId,cookie}){
    return this.identities.transaction(()=>{
      const row=this.request(requestId);if(row.status!=='identified'||!cookie||hashSecret(cookie)!==row.browser_hash)unavailable();
      const identity=JSON.parse(row.identity_json),member=this.identities.enroll(identity);
      // Confirmation must not extend the lifetime of an earlier official verification.
      this.db.prepare('UPDATE collaboration_members SET verified_until=MIN(verified_until,?) WHERE account=?').run(row.expires_at,member.account);
      this.db.prepare("UPDATE mvp_login_requests SET status='verified',account=?,identity_json=NULL WHERE id=?").run(member.account,requestId);
      return {verified:true,...this.identities.display(member.account)};
    });
  }
  async claim(_account,{requestId,deviceId,proof}){
    secret(proof);const row=this.request(requestId);
    if(row.device_id!==deviceId||row.proof_hash!==hashSecret(proof))unavailable();
    if(['pending','processing','identified'].includes(row.status))return {status:'pending'};
    if(row.status!=='verified')unavailable();
    await this.refresh(row.account);
    return this.identities.transaction(()=>{
      const current=this.request(requestId);if(current.status!=='verified')unavailable();
      const login=this.identities.issueLogin(row.account,deviceId);
      this.db.prepare("UPDATE mvp_login_requests SET status='claimed',browser_hash=NULL WHERE id=?").run(requestId);
      return {status:'authenticated',...login,...this.identities.display(row.account)};
    });
  }
  async refresh(account){
    const before=this.identities.member(account);if(!before?.enabled)unavailable();
    try{await super.refresh(account);}catch(error){
      const current=this.identities.member(account);
      if(current?.enabled&&current.revision===before.revision&&current.verified_until<=this.now())throw new AccessError(-32014,'暂时无法复核钉钉组织资格，业务已暂停；登录未延长，请稍后查询，不必反复登录');
      throw error;
    }
  }
  async authenticate(_account,{token,deviceId}){
    secret(token);requireText(deviceId,'设备',200);
    const row=this.db.prepare('SELECT * FROM collaboration_logins WHERE token_hash=? AND device_id=?').get(hashSecret(token),deviceId);
    if(!row||row.revoked||row.expires_at<=this.now()||row.epoch!==this.identities.epoch||row.member_revision!==this.identities.member(row.account)?.revision)unavailable();
    await this.refresh(row.account);
    return {...this.identities.verifyLogin(token,row.account,deviceId),...this.identities.display(row.account)};
  }
  logout({token,deviceId}){secret(token);this.identities.revokeDevice(token,this.db.prepare('SELECT account FROM collaboration_logins WHERE token_hash=?').get(hashSecret(token))?.account,deviceId);return {authenticated:false};}
}
