import { randomUUID } from 'node:crypto';
import { AccessError, requireText } from './protocol.mjs';
import { hashSecret, opaqueSecret } from './identity-store.mjs';

const deny=()=>{throw new AccessError(-32003,'Login request unavailable or expired');};
/** SSH-authenticated device starts/claims; browser sees neither device proof nor service token. */
export class LoginService {
  constructor({identities,provider,publicOrigin,now=Date.now}) {
    const origin=new URL(publicOrigin);
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Login requires an explicit HTTPS origin');
    this.origin=origin.origin;this.identities=identities;this.db=identities.db;this.provider=provider;this.now=now;this.refreshes=new Map();
  }
  start(account,deviceId,proof) {
    requireText(deviceId,'deviceId',200);requireText(proof,'device request proof',200);
    if(!/^[A-Za-z0-9_-]{43}$/.test(proof))throw new AccessError(-32602,'Device proof must have 256 bits of randomness');
    const member=this.identities.member(account);if(!member?.enabled)deny();
    const pending=this.db.prepare("SELECT COUNT(*) n FROM collaboration_login_requests WHERE account=? AND status IN('pending','processing') AND expires_at>?").get(account,this.now()).n;
    if(pending>=5)throw new AccessError(-32007,'Too many pending logins; wait for expiry');
    const id=randomUUID(),state=opaqueSecret(),expiresAt=this.now()+300000;
    this.db.prepare('INSERT INTO collaboration_login_requests(id,account,device_id,proof_hash,state,status,expires_at,epoch,member_revision) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,account,deviceId,hashSecret(proof),state,'pending',expiresAt,this.identities.epoch,member.revision);
    return {requestId:id,loginUrl:`${this.origin}/collaboration/login/${id}`,expiresAt};
  }
  request(id) {
    const row=this.db.prepare('SELECT * FROM collaboration_login_requests WHERE id=?').get(id);
    const member=this.identities.member(row?.account);
    if(!row||!member?.enabled||row.member_revision!==member.revision||row.expires_at<=this.now()||row.epoch!==this.identities.epoch)deny();return row;
  }
  browserStart(id,existingCookie) {
    const row=this.request(id);if(row.status!=='pending')deny();
    let cookie=existingCookie;
    if(row.browser_hash) { if(!cookie||hashSecret(cookie)!==row.browser_hash)deny(); }
    else {cookie=opaqueSecret();this.db.prepare("UPDATE collaboration_login_requests SET browser_hash=? WHERE id=? AND status='pending'").run(hashSecret(cookie),id);}
    const url=new URL('https://login.dingtalk.com/oauth2/auth');
    url.search=new URLSearchParams({redirect_uri:`${this.origin}/collaboration/oauth/callback`,response_type:'code',client_id:this.identities.clientId,
      scope:'openid corpid',state:row.state,prompt:'consent',corpId:this.identities.corpId}).toString();
    return {authorizationUrl:url.href,cookie,requestId:id};
  }
  async callback({state,code,cookie}) {
    requireText(state,'OAuth state',200);requireText(code,'authorization code',4096);
    const candidate=this.db.prepare('SELECT id FROM collaboration_login_requests WHERE state=?').get(state);if(!candidate)deny();
    const row=this.request(candidate.id);
    if(row.status!=='pending'||!cookie||!row.browser_hash||hashSecret(cookie)!==row.browser_hash)deny();
    try {
      // Commit one-use code reservation before external I/O; crashes never retry the same code.
      this.identities.transaction(()=>{
        const latest=this.request(row.id);if(latest.status!=='pending')deny();
        this.db.prepare("UPDATE collaboration_login_requests SET status='processing',code_hash=? WHERE id=?").run(hashSecret(code),row.id);
      });
    }catch{deny();}
    try {
      const identity=await this.provider.exchange(code),member=this.identities.member(row.account);
      if(!member||identity.corpId!==member.corp_id||identity.userId!==member.user_id||identity.unionId!==member.union_id||identity.internal!==true)deny();
      this.identities.transaction(()=>{
        const current=this.request(row.id);if(current.status!=='processing')deny();
        this.identities.markVerified(row.account,identity);
        this.db.prepare("UPDATE collaboration_login_requests SET status='verified' WHERE id=?").run(row.id);
      });
      return {requestId:row.id,status:'verified'};
    }catch{
      this.db.prepare("UPDATE collaboration_login_requests SET status='failed' WHERE id=? AND status='processing'").run(row.id);
      deny();
    }
  }
  async refresh(account) {
    const member=this.identities.member(account);if(!member?.enabled)deny();
    if(member.verified_until>this.now())return;
    let task=this.refreshes.get(account);
    if(!task){
      task=(async()=>{const revision=member.revision;let identity;
        try{identity=await this.provider.verifyMember(member);}catch(error){if(error?.qualificationRevoked===true)this.identities.invalidateOrganization(account,revision);deny();}
        this.identities.transaction(()=>{const current=this.identities.member(account);if(!current||current.revision!==revision)deny();this.identities.markVerified(account,identity);});
      })().finally(()=>this.refreshes.delete(account));this.refreshes.set(account,task);
    }
    await task;
  }
  async claim(account,{requestId,deviceId,proof}) {
    requireText(proof,'device request proof',200);const row=this.request(requestId);
    if(row.account!==account||row.device_id!==deviceId||row.proof_hash!==hashSecret(proof))deny();
    if(row.status==='pending'||row.status==='processing')return {status:'pending'};
    if(row.status!=='verified')deny();await this.refresh(account);
    return this.identities.transaction(()=>{
      const current=this.request(requestId);if(current.status!=='verified')deny();
      const login=this.identities.issueLogin(account,deviceId);
      this.db.prepare("UPDATE collaboration_login_requests SET status='claimed',browser_hash=NULL WHERE id=?").run(requestId);
      return {status:'authenticated',...login};
    });
  }
  async authenticate(account,{token,deviceId}) { await this.refresh(account);return this.identities.verifyLogin(token,account,deviceId); }
  expireInterrupted() {this.db.prepare("UPDATE collaboration_login_requests SET status='failed' WHERE status='processing'").run();}
}
