import {renderProfile} from './render-profile.mjs';
/** Temporary, separately-owned authentication feasibility only. Does not replace production Host/profile/model policy. */
export function renderQrProbeProfile(release){
 if(!/^\/opt\/dsh-collaboration-test\/qr-candidates\/[a-f0-9]{40}\/runtime$/.test(release))throw Error('Exact CI-verified QR candidate runtime required');
 const entries=JSON.parse(renderProfile('/opt/dsh-collaboration-test/releases/'+'a'.repeat(40)))[0].insert,home='/srv/dsh-collaboration-test/mvp-qr-probe/dsh-home';
 for(const entry of entries){if(entry.id==='attachments')entry.config.dshHome=home;if(entry.id==='session-persistence')entry.config.root=home+'/sessions';if(entry.id==='model-request-gate')entry.name=release+'/qr-probe-gate.mjs';if(entry.id==='collaboration-server-mount')entry.name=release+'/qr-probe-mount.mjs';}
 return JSON.stringify([{insert:entries}],null,2)+'\n';
}
export function qrProbeConfiguration(existing){
 const root='/srv/dsh-collaboration-test';if(existing?.mode!=='mvp-https'||existing.serviceId!=='dingtalk-collaboration-mvp'||existing.workspace!==root+'/workspace'||existing.stateRoot!==root+'/private-state'||existing.provider!=='cpa'||existing.model!=='deepseek-v4.1-flash'||existing.dingtalk?.administratorUserId!=='manager7701'||existing.dingtalk.publicOrigin!=='https://login.lafinger.us.ci'||existing.dingtalk.loginPort!==19481)throw Error('Exact unchanged current PC MVP configuration required');
 const {corpId,clientId,clientSecret,publicOrigin,administratorUserId}=existing.dingtalk;for(const value of [corpId,clientId,clientSecret])if(typeof value!=='string'||!value)throw Error('Official application scope missing');
 return {mode:'mvp-qr',authenticationOnly:true,serviceId:'dingtalk-mvp-qr-probe',workspace:root+'/mvp-qr-probe/workspace',stateRoot:root+'/mvp-qr-probe/private-state',provider:existing.provider,model:existing.model,dingtalk:{corpId,clientId,clientSecret,publicOrigin,administratorUserId,loginPort:19483}};
}
