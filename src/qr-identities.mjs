import {MvpIdentityStore} from './mvp-identities.mjs';
import {inTransaction} from '../business/lib/sqlite/schema.js';

/** Same member/project/session model, distinct admitted authentication version. Never auto-adopts a PC database. */
export class QrIdentityStore extends MvpIdentityStore {
 get authenticationMode(){return 'mvp-https-qr-v1';}
 get enrollmentActor(){return 'official-web-login';}
}

/** Maintenance-only operation, deliberately NOT called by plugin startup or exposed as RPC. Caller must own maintenance lock. */
export function upgradePcAuthenticationToQr({db,serviceId,corpId,clientId,administratorUserId}){
 return inTransaction(db,()=>{
  const value=key=>db.prepare('SELECT value FROM collaboration_security_meta WHERE key=?').get(key)?.value;
  if(value('scope')!==JSON.stringify([serviceId,corpId,clientId])||value('mvp-administrator-user')!==administratorUserId)throw Error('QR upgrade scope or fixed administrator mismatch');
  const mode=value('authentication-mode');if(mode==='mvp-https-qr-v1')return {changed:false};
  if(mode!=='mvp-https-v1')throw Error('Only explicit current PC MVP authentication can upgrade');
  if(db.prepare('SELECT 1 FROM collaboration_members WHERE administrator=1 AND user_id<>?').get(administratorUserId))throw Error('Unexpected administrator during QR upgrade');
  const epoch=value('epoch');if(!epoch)throw Error('Missing session epoch; refusing to reset it');
  const revoked=db.prepare('UPDATE collaboration_logins SET revoked=1 WHERE revoked=0').run().changes;
  let requests=0;if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mvp_login_requests'").get())requests=db.prepare("UPDATE mvp_login_requests SET status='cancelled',identity_json=NULL,browser_hash=NULL WHERE status IN('pending','processing','identified','verified','claiming')").run().changes;
  db.prepare("UPDATE collaboration_security_meta SET value='mvp-https-qr-v1' WHERE key='authentication-mode'").run();
  db.prepare('INSERT INTO collaboration_security_audit(at,actor,action,subject) VALUES(?,?,?,?)').run(Date.now(),'local-maintenance','pc-to-web-authentication','same-members-and-session-epoch');
  if(value('epoch')!==epoch)throw Error('QR upgrade unexpectedly changed session epoch');
  return {changed:true,revokedDeviceLogins:revoked,cancelledPcRequests:requests,sessionEpochPreserved:true};
 });
}
