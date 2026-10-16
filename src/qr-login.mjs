import {randomUUID,createHash,createHmac} from 'node:crypto';
import {LoginService} from './login-service.mjs';
import {hashSecret,opaqueSecret} from './identity-store.mjs';
import {AccessError,requireText} from './protocol.mjs';
const unavailable=()=>{throw new AccessError(-32003,'本次扫码登录不可用、已取消或已过期，请在原DSH核对后明确重新发起');};
const secret=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))unavailable();return value;};
const browserSecret=(id,proof)=>createHash('sha256').update(JSON.stringify(['qr-browser-v1',id,proof])).digest('base64url');
// Independent domain-separated capabilities: the browser token cannot derive the device login token.
const deviceToken=(id,proof)=>createHmac('sha256',Buffer.from(proof,'base64url')).update(JSON.stringify(['qr-device-token-v1',id])).digest('base64url');

/** Account-free official browser OAuth, bound original device proof and initiating browser; no PC bridge or extra app confirmation. */
export class QrLoginService extends LoginService {
 constructor(options){
  super(options);this.method='dingtalk-qr';
  if(this.db.prepare("SELECT value FROM collaboration_security_meta WHERE key='authentication-mode'").get()?.value!=='mvp-https-qr-v1')throw Error('QR login requires explicitly admitted QR authentication store');
  this.db.exec(`CREATE TABLE IF NOT EXISTS qr_login_requests(
   id TEXT PRIMARY KEY,device_id TEXT NOT NULL,proof_hash TEXT NOT NULL,browser_token_hash TEXT UNIQUE NOT NULL,
   state TEXT UNIQUE NOT NULL,browser_hash TEXT,code_hash TEXT UNIQUE,account TEXT,status TEXT NOT NULL,
   expires_at INTEGER NOT NULL,epoch TEXT NOT NULL,login_id TEXT,claim_recovery TEXT);
   CREATE INDEX IF NOT EXISTS qr_login_device ON qr_login_requests(device_id,expires_at);`);
  this.expireInterrupted();
 }
 expireInterrupted(){this.db.prepare("UPDATE qr_login_requests SET status='failed',browser_hash=NULL WHERE status='processing'").run();}
 start(_account,deviceId,proof){
  requireText(deviceId,'发起设备',200);secret(proof);
  return this.identities.transaction(()=>{
   const now=this.now();this.db.prepare('UPDATE qr_login_requests SET claim_recovery=NULL,browser_hash=NULL WHERE expires_at<=?').run(now);
   this.db.prepare('DELETE FROM qr_login_requests WHERE expires_at<=?').run(now-300000);
   const same=this.db.prepare('SELECT * FROM qr_login_requests WHERE device_id=? AND proof_hash=?').get(deviceId,hashSecret(proof));
   if(same){if(same.expires_at<=now||!['pending','processing','verified','claimed'].includes(same.status))unavailable();return this.started(same,proof);}
   if(this.db.prepare('SELECT COUNT(*) n FROM qr_login_requests').get().n>=1000)throw new AccessError(-32007,'扫码请求总量已达上限，请等待过期后明确重试');
   const row=this.db.prepare("SELECT * FROM qr_login_requests WHERE device_id=? AND expires_at>? AND status IN('pending','processing','verified') ORDER BY expires_at DESC LIMIT 1").get(deviceId,now);
   if(row)throw new AccessError(-32007,'已有本设备扫码请求，请核对或取消原请求，不重复发起');
   if(this.db.prepare("SELECT COUNT(*) n FROM qr_login_requests WHERE expires_at>? AND status IN('pending','processing','verified')").get(now).n>=200)throw new AccessError(-32007,'待完成扫码请求过多，请稍后明确重试');
   const id=randomUUID();this.db.prepare("INSERT INTO qr_login_requests(id,device_id,proof_hash,browser_token_hash,state,status,expires_at,epoch) VALUES(?,?,?,?,?,'pending',?,?)").run(id,deviceId,hashSecret(proof),hashSecret(browserSecret(id,proof)),opaqueSecret(),now+300000,this.identities.epoch);
   return this.started(this.request(id),proof);
  });
 }
 resume(_account,{deviceId,proof}){requireText(deviceId,'发起设备',200);secret(proof);const row=this.db.prepare('SELECT id FROM qr_login_requests WHERE device_id=? AND proof_hash=?').get(deviceId,hashSecret(proof));if(!row)unavailable();const current=this.request(row.id);if(!['pending','processing','verified','claimed'].includes(current.status))unavailable();return this.started(current,proof);}
 started(row,proof){const loginUrl=`${this.origin}/collaboration/qr-login#${browserSecret(row.id,proof)}`;return {requestId:row.id,loginUrl,openUrl:loginUrl,loginMethod:this.method,expiresAt:row.expires_at};}
 request(id){requireText(id,'扫码请求',100);const row=this.db.prepare('SELECT * FROM qr_login_requests WHERE id=?').get(id);if(!row||row.expires_at<=this.now()||row.epoch!==this.identities.epoch)unavailable();return row;}
 device(p){secret(p?.proof);requireText(p?.deviceId,'发起设备',200);const row=this.request(p?.requestId);if(row.device_id!==p.deviceId||row.proof_hash!==hashSecret(p.proof))unavailable();return row;}
 browser(token,cookie){
  secret(token);const candidate=this.db.prepare('SELECT id FROM qr_login_requests WHERE browser_token_hash=?').get(hashSecret(token));if(!candidate)unavailable();
  const row=this.request(candidate.id);if(row.status!=='pending')unavailable();
  if(row.browser_hash){if(!cookie||hashSecret(cookie)!==row.browser_hash)unavailable();}else{cookie=opaqueSecret();this.db.prepare("UPDATE qr_login_requests SET browser_hash=? WHERE id=? AND status='pending'").run(hashSecret(cookie),row.id);}
  const url=new URL('https://login.dingtalk.com/oauth2/auth');url.search=new URLSearchParams({redirect_uri:`${this.origin}/collaboration/oauth/callback`,response_type:'code',client_id:this.identities.clientId,scope:'openid corpid',state:row.state,prompt:'consent',corpId:this.identities.corpId}).toString();
  return {authorizationUrl:url.href,cookie,requestId:row.id,expiresAt:row.expires_at};
 }
 reject({state,cookie}){
  secret(state);const candidate=this.db.prepare('SELECT id FROM qr_login_requests WHERE state=?').get(state);if(!candidate)unavailable();const row=this.request(candidate.id);
  if(row.status!=='pending'||!cookie||!row.browser_hash||hashSecret(cookie)!==row.browser_hash)unavailable();
  this.db.prepare("UPDATE qr_login_requests SET status='failed',browser_hash=NULL WHERE id=? AND status='pending'").run(row.id);return {status:'failed'};
 }
 async callback({state,code,cookie}){
  secret(state);requireText(code,'官方网页授权码',4096);const candidate=this.db.prepare('SELECT id FROM qr_login_requests WHERE state=?').get(state);if(!candidate)unavailable();
  const row=this.request(candidate.id);if(row.status!=='pending'||!cookie||!row.browser_hash||hashSecret(cookie)!==row.browser_hash)unavailable();
  try{this.identities.transaction(()=>{if(this.request(row.id).status!=='pending')unavailable();this.db.prepare("UPDATE qr_login_requests SET status='processing',code_hash=? WHERE id=? AND status='pending'").run(hashSecret(code),row.id);});}catch{this.db.prepare("UPDATE qr_login_requests SET status='failed',browser_hash=NULL WHERE id=? AND status='pending'").run(row.id);unavailable();}
  try{
   const identity=await this.provider.exchange(code,{displayName:true});
   return this.identities.transaction(()=>{
    const current=this.request(row.id);if(current.status!=='processing'||identity?.corpId!==this.identities.corpId||identity.internal!==true)unavailable();
    const member=this.identities.enroll(identity);this.db.prepare('UPDATE collaboration_members SET verified_until=MIN(verified_until,?) WHERE account=?').run(row.expires_at,member.account);
    this.db.prepare("UPDATE qr_login_requests SET status='verified',account=?,browser_hash=NULL WHERE id=?").run(member.account,row.id);
    return {requestId:row.id,status:'verified'};
   });
  }catch{this.db.prepare("UPDATE qr_login_requests SET status='failed',browser_hash=NULL WHERE id=? AND status='processing'").run(row.id);unavailable();}
 }
 cancel(_account,p){return this.identities.transaction(()=>{const row=this.device(p);if(row.status==='claimed')return {status:'completed'};if(row.status==='cancelled')return {status:'cancelled'};this.db.prepare("UPDATE qr_login_requests SET status='cancelled',browser_hash=NULL,claim_recovery=NULL WHERE id=?").run(row.id);return {status:'cancelled'};});}
 status(_account,p){const row=this.device(p);return {status:row.status==='claimed'?'completed':['pending','processing','verified'].includes(row.status)?'pending':row.status,expiresAt:row.expires_at};}
 acknowledge(_account,p){return this.identities.transaction(()=>{const row=this.device(p);if(row.status!=='claimed')unavailable();this.db.prepare('UPDATE qr_login_requests SET claim_recovery=NULL WHERE id=?').run(row.id);return {status:'acknowledged'};});}
 async refresh(account){const before=this.identities.member(account);if(!before?.enabled)unavailable();try{await super.refresh(account);}catch(error){const current=this.identities.member(account);if(current?.enabled&&current.revision===before.revision&&current.verified_until<=this.now())throw new AccessError(-32014,'暂时无法复核钉钉组织资格，业务已暂停；登录未延长，请稍后查询');throw error;}}
 async claim(_account,p){
  let row=this.device(p);if(['pending','processing'].includes(row.status))return {status:'pending'};if(!['verified','claimed'].includes(row.status))unavailable();
  await this.refresh(row.account);
  return this.identities.transaction(()=>{
   row=this.device(p);
   if(row.status==='claimed'){
    if(row.claim_recovery!=='recoverable')unavailable();const token=deviceToken(row.id,p.proof),login=this.identities.verifyLogin(token,row.account,p.deviceId);return {status:'authenticated',...login,token,...this.identities.display(row.account),loginMethod:this.method};
   }
   if(row.status!=='verified')unavailable();const token=deviceToken(row.id,p.proof),issued=this.identities.issueLogin(row.account,p.deviceId);
   // Re-derive response-loss recovery from the original device proof. Store only a hash, never token/proof/plain or encrypted login payload.
   this.db.prepare('UPDATE collaboration_logins SET token_hash=? WHERE id=?').run(hashSecret(token),issued.loginId);
   const result={status:'authenticated',...issued,token,...this.identities.display(row.account),loginMethod:this.method};
   this.db.prepare("UPDATE qr_login_requests SET status='claimed',login_id=?,claim_recovery='recoverable',browser_hash=NULL WHERE id=?").run(issued.loginId,row.id);return result;
  });
 }
 async authenticate(_account,{token,deviceId}){secret(token);requireText(deviceId,'设备',200);const row=this.db.prepare('SELECT * FROM collaboration_logins WHERE token_hash=? AND device_id=?').get(hashSecret(token),deviceId);if(!row||row.revoked||row.expires_at<=this.now()||row.epoch!==this.identities.epoch||row.member_revision!==this.identities.member(row.account)?.revision)unavailable();await this.refresh(row.account);return {...this.identities.verifyLogin(token,row.account,deviceId),...this.identities.display(row.account),loginMethod:this.method};}
 logout({token,deviceId}){secret(token);this.identities.revokeDevice(token,this.db.prepare('SELECT account FROM collaboration_logins WHERE token_hash=?').get(hashSecret(token))?.account,deviceId);return {authenticated:false};}
}
