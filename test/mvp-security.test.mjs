import test from 'node:test';import assert from 'node:assert/strict';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {MvpIdentityStore} from '../src/mvp-identities.mjs';
import {MvpLoginService} from '../src/mvp-login.mjs';
import {MvpAccessService} from '../src/mvp-service.mjs';
import {IdentityStore,opaqueSecret} from '../src/identity-store.mjs';
const official=userId=>({corpId:'corp',userId,unionId:'union-'+userId,internal:true,name:userId});
function fixture(t){const db=openDatabase({path:':memory:'});t.after(()=>db.close());let now=1_800_000_000_000;
 const identities=new MvpIdentityStore({db,serviceId:'mvp',corpId:'corp',clientId:'app',administratorUserId:'boss',now:()=>now});
 const provider={async exchangePc(){return official('boss');},async verifyMember(member){return official(member.user_id);}};
 const login=new MvpLoginService({identities,provider,publicOrigin:'https://mvp.example',agentId:'123',now:()=>now});
 return {db,identities,provider,login,projects:new ProjectService(db),advance:ms=>now+=ms};}
function started(f,device='pc'){const proof=opaqueSecret(),start=f.login.start(null,device,proof),binding=f.login.browser(new URL(start.loginUrl).hash.slice(1));return {proof,start,binding};}
async function verified(f,device='pc',code=opaqueSecret()){const v=started(f,device);await f.login.authorize({requestId:v.start.requestId,cookie:v.binding.cookie,code});f.login.confirm({requestId:v.start.requestId,cookie:v.binding.cookie});return {requestId:v.start.requestId,deviceId:device,proof:v.proof};}
test('MVP refuses adoption of old members, old projects or a changed fixed administrator',t=>{
 const f=fixture(t);assert.throws(()=>new MvpIdentityStore({db:f.db,serviceId:'mvp',corpId:'corp',clientId:'app',administratorUserId:'different'}),/Fixed/);
 for(const kind of ['member','project']){const db=openDatabase({path:':memory:'});try{const old=new IdentityStore({db,serviceId:'old',corpId:'corp',clientId:'app'});if(kind==='member')old.bind({account:'old-member',userId:'boss',unionId:'union-boss'});else new ProjectService(db).create({key:'OLD',name:'Old'});assert.throws(()=>new MvpIdentityStore({db,serviceId:'old',corpId:'corp',clientId:'app',administratorUserId:'boss'}),/fresh/);}finally{db.close();}}
});
test('one PC code cannot authorize two requests; simultaneous claims issue only one token',async t=>{
 const f=fixture(t),code=opaqueSecret(),claim=await verified(f,'pc',code),second=started(f,'other');
 await assert.rejects(f.login.authorize({requestId:second.start.requestId,cookie:second.binding.cookie,code}));
 const results=await Promise.allSettled([f.login.claim(null,claim),f.login.claim(null,claim)]);assert.equal(results.filter(v=>v.status==='fulfilled').length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM collaboration_logins').get().n,1);
});
test('confirmation does not extend official verification; separate devices revoke independently',async t=>{
 const f=fixture(t),v=started(f);await f.login.authorize({requestId:v.start.requestId,cookie:v.binding.cookie,code:opaqueSecret()});f.advance(299000);f.login.confirm({requestId:v.start.requestId,cookie:v.binding.cookie});assert.equal(f.identities.member(f.db.prepare('SELECT account FROM mvp_login_requests WHERE id=?').get(v.start.requestId).account).verified_until,v.start.expiresAt);
 const a=await f.login.claim(null,{requestId:v.start.requestId,proof:v.proof,deviceId:'pc'}),b=await f.login.claim(null,await verified(f,'other'));
 f.login.logout({token:a.token,deviceId:a.deviceId});await assert.rejects(f.login.authenticate(null,{token:a.token,deviceId:a.deviceId}));assert.equal((await f.login.authenticate(null,{token:b.token,deviceId:b.deviceId})).account,b.account);
});
test('management rechecks current device after candidate verification and stale A-B-A role revisions never reuse a token',async t=>{
 const f=fixture(t),admin=f.identities.enroll(official('boss')),a=f.identities.enroll(official('a')),b=f.identities.enroll(official('b'));
 const service=new MvpAccessService({identities:f.identities,login:f.login,projects:f.projects,runtime:{},cwd:process.cwd(),store:{}});t.after(()=>clearInterval(service.authorizationMonitor));
 const project=f.projects.create({key:'P',name:'P'}),view=service.adminView(admin.account,project.id);let current=true;
 const role={action:'role',commandId:'one',projectId:project.id,role:'frontend',account:a.account,revision:view.revision};
 f.login.refresh=async()=>{current=false;};await assert.rejects(service.manage(admin.account,role,()=>{if(!current)throw Error('logged out during request');}));assert.equal(f.projects.getWithRoles(project.id).roles.find(r=>r.role==='frontend').member,null);
 f.login.refresh=async()=>{};const first=await service.manage(admin.account,role),next=await service.manage(admin.account,{...role,commandId:'two',account:b.account,revision:first.revision}),back=await service.manage(admin.account,{...role,commandId:'three',revision:next.revision});assert.notEqual(back.revision,first.revision);assert.equal(f.identities.requireProject(a.account,project.id).revision,1);
 await assert.rejects(service.manage(admin.account,{...role,commandId:'stale',revision:first.revision}));
});
test('temporary organization outage pauses business without revoking seven-day login',async t=>{
 const f=fixture(t),result=await f.login.claim(null,await verified(f));f.advance(300001);f.provider.verifyMember=async()=>{throw Error('offline');};
 await assert.rejects(f.login.authenticate(null,{token:result.token,deviceId:result.deviceId}),e=>e.code===-32014);assert.equal(f.db.prepare('SELECT revoked FROM collaboration_logins').get().revoked,0);
 f.provider.verifyMember=async member=>official(member.user_id);assert.equal((await f.login.authenticate(null,{token:result.token,deviceId:result.deviceId})).account,result.account);
});
test('organization denial revokes saved token; unverified request accumulation has explicit bounds',async t=>{
 const f=fixture(t),result=await f.login.claim(null,await verified(f));f.advance(300001);f.provider.verifyMember=async()=>{throw Object.assign(Error('official inactive'),{qualificationRevoked:true});};await assert.rejects(f.login.authenticate(null,{token:result.token,deviceId:result.deviceId}));assert.equal(f.db.prepare('SELECT revoked FROM collaboration_logins').get().revoked,1);
 for(let n=0;n<3;n++)f.login.start(null,'limited',opaqueSecret());assert.throws(()=>f.login.start(null,'limited',opaqueSecret()),e=>e.code===-32007);
});
