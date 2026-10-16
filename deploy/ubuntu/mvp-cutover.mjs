import {createHash} from 'node:crypto';import {readFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
import {probeProxyInclude} from './mvp-probe-ingress.mjs';
export const MVP_SERVICE_ID='dingtalk-collaboration-mvp';
export const MVP_CUTOVER_BASELINE_SHA256='afafa40a47733149bc062c363d87ed2039831db87b0557c6e4aadee406697bf2';
const root='/srv/dsh-collaboration-test';
/** Configuration for the same existing backend. Caller must retire old state first; never adopt accounts/epochs. */
export function mvpProductionConfiguration(existing,verifiedProbe){
 if(existing?.serviceId!=='dingtalk-lan-test'||existing.workspace!==root+'/workspace'||existing.stateRoot!==root+'/private-state'||existing.provider!=='cpa'||existing.model!=='deepseek-v4.1-flash'||existing.mode)throw Error('Exact original collaboration service required');
 const old=existing.dingtalk,probe=verifiedProbe?.dingtalk;
 if(verifiedProbe?.mode!=='mvp-https'||verifiedProbe.serviceId!=='dingtalk-mvp-pc-probe'||verifiedProbe.workspace!==root+'/mvp-pc-probe/workspace'||verifiedProbe.stateRoot!==root+'/mvp-pc-probe/private-state'||probe?.loginPort!==19483||probe.administratorUserId!=='manager7701'||typeof probe.agentId!=='string'||!/^\d{1,30}$/.test(probe.agentId))throw Error('Verified isolated PC configuration required');
 for(const key of ['corpId','clientId','clientSecret','publicOrigin'])if(typeof old?.[key]!=='string'||!old[key]||old[key]!==probe[key])throw Error('Official application scope must match; no identity/application switch');
 if(old.publicOrigin!=='https://login.lafinger.us.ci')throw Error('Exact trusted origin required');
 return {mode:'mvp-https',serviceId:MVP_SERVICE_ID,workspace:existing.workspace,stateRoot:existing.stateRoot,provider:existing.provider,model:existing.model,dingtalk:{corpId:old.corpId,clientId:old.clientId,clientSecret:old.clientSecret,publicOrigin:old.publicOrigin,agentId:probe.agentId,administratorUserId:'manager7701',loginPort:19481}};
}
export const mvpProxyInclude=probeProxyInclude.replace('# Probe only.','# MVP HTTPS.').replace('add_header X-Collaboration-Probe "pc-identity-only" always;','add_header X-Collaboration-Transport "mvp-https" always;');
/** Keep existing certificates/listeners/subnets; retire OAuth and route only MVP paths to original backend port. */
export function renderMvpProductionIngress(original){
 if(typeof original!=='string'||createHash('sha256').update(original).digest('hex')!==MVP_CUTOVER_BASELINE_SHA256)throw Error('Exact reviewed unified HTTPS baseline required; no drift overwrite');
 const begin=original.indexOf('        location ~ "^/collaboration/(login/'),end=original.indexOf('        # Isolated MVP PC identity probe only.');
 if(begin<0||end<begin)throw Error('Unexpected legacy/probe ingress shape');
 let next=original.slice(0,begin)+original.slice(end);
 next=next.replace('# Isolated MVP PC identity probe only. Keep legacy OAuth routes/backend unchanged.','# MVP HTTPS only; historical OAuth paths fall through to 404.').replaceAll('proxy_pass http://127.0.0.1:19483;','proxy_pass http://127.0.0.1:19481;').replaceAll('/etc/dsh-collaboration-login/mvp-probe-proxy.conf','/etc/dsh-collaboration-login/mvp-https-proxy.conf');
 if(/oauth\/callback|login-complete|mvp-probe-proxy|19483/.test(next)||(next.match(/proxy_pass http:\/\/127\.0\.0\.1:19481;/g)||[]).length!==7)throw Error('Unexpected retired ingress paths');return next;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 if(process.argv[2]==='--include'&&process.argv.length===3)process.stdout.write(mvpProxyInclude);
 else if(process.argv[2]==='--ingress'&&process.argv.length===4)process.stdout.write(renderMvpProductionIngress(readFileSync(process.argv[3],'utf8')));
 else throw Error('Usage: node mvp-cutover.mjs --ingress <reviewed-nginx.conf> | --include (public data only)');
}
