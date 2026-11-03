import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {MvpIdentityStore} from '../src/mvp-identities.mjs';
import {LoginService} from '../src/login-service.mjs';
import {OrganizationSync} from '../src/organization-sync.mjs';
import {DingTalkIdentityProvider} from '../src/dingtalk-identity.mjs';
import {QrIdentityStore} from '../src/qr-identities.mjs';
import {QrLoginService} from '../src/qr-login.mjs';
import {MvpLoginService} from '../src/mvp-login.mjs';
import {opaqueSecret} from '../src/identity-store.mjs';
const official=(id='one',name='Official')=>({corpId:'corp',userId:id,unionId:'union-'+id,internal:true,name});
function fixture(t){
 const db=openDatabase({path:':memory:'});t.after(()=>db.close());let time=1000000;
 const options={db,serviceId:'s',corpId:'corp',clientId:'app',administratorUserId:'boss',now:()=>time};
 const identities=new MvpIdentityStore(options);const member=identities.enroll(official());let calls=0;
 const provider={async verifyMember(m){calls++;return official(m.user_id);}};
 const login=new LoginService({identities,provider,publicOrigin:'https://example.test',now:()=>time});
 return {db,options,identities,member,provider,login,get calls(){return calls;},now:()=>time,advance:ms=>time+=ms};
}
for(const qr of [false,true])for(const delayed of [false,true])test(`${qr?'QR':'PC'} pending claim cannot cross revoke/re-enroll during ${delayed?'delayed':'cached microtask'} refresh`,async t=>{
 const db=openDatabase({path:':memory:'});t.after(()=>db.close());
 const Store=qr?QrIdentityStore:MvpIdentityStore,identities=new Store({db,serviceId:'s',corpId:'corp',clientId:'app',administratorUserId:'boss'});
 const provider={exchange:async()=>official(),exchangePc:async()=>official(),verifyMember:async()=>official()};
 const Login=qr?QrLoginService:MvpLoginService,login=new Login({identities,provider,agentId:'123',publicOrigin:'https://example.test'});
 const proof=opaqueSecret(),started=login.start(null,'d',proof),browser=login.browser(new URL(started.loginUrl).hash.slice(1));
 if(qr)await login.callback({state:new URL(browser.authorizationUrl).searchParams.get('state'),cookie:browser.cookie,code:opaqueSecret()});
 else{await login.authorize({requestId:started.requestId,cookie:browser.cookie,code:opaqueSecret()});login.confirm({requestId:started.requestId,cookie:browser.cookie});}
 const a=identities.db.prepare('SELECT account FROM collaboration_members').get().account;
 let finish=()=>{};if(delayed)login.refresh=()=>new Promise(resolve=>finish=resolve);
 const claiming=login.claim(null,{requestId:started.requestId,deviceId:'d',proof});
 identities.invalidateOrganization(a,identities.member(a).revision);identities.enroll(official());finish();
 await assert.rejects(claiming);assert.equal(db.prepare('SELECT COUNT(*) n FROM collaboration_logins').get().n,0);
});
for(const qr of [false,true])test(`${qr?'QR':'PC'} old official exchange cannot requalify after concurrent revocation`,async t=>{
 const db=openDatabase({path:':memory:'});t.after(()=>db.close());const Store=qr?QrIdentityStore:MvpIdentityStore;
 const identities=new Store({db,serviceId:'s',corpId:'corp',clientId:'app',administratorUserId:'boss'}),a=identities.enroll(official()).account;
 let finish;const delayed=()=>new Promise(resolve=>finish=resolve),provider={exchange:delayed,exchangePc:delayed};
 const Login=qr?QrLoginService:MvpLoginService,login=new Login({identities,provider,agentId:'123',publicOrigin:'https://example.test'});
 const started=login.start(null,'d',opaqueSecret()),browser=login.browser(new URL(started.loginUrl).hash.slice(1));
 const pending=qr?login.callback({state:new URL(browser.authorizationUrl).searchParams.get('state'),cookie:browser.cookie,code:opaqueSecret()}):login.authorize({requestId:started.requestId,cookie:browser.cookie,code:opaqueSecret()});
 identities.invalidateOrganization(a,identities.member(a).revision);finish(official());await assert.rejects(pending);assert.equal(identities.profile(a).qualification,'revoked');
});
test('manual sync debounces repeated requests without inventing a newer official check time',async t=>{
 const f=fixture(t),sync=new OrganizationSync({identities:f.identities,login:f.login,now:f.now});const first=await sync.sync();f.advance(1000);
 assert.deepEqual(await sync.sync(),first);assert.equal(f.calls,1);f.advance(4001);await sync.sync();assert.equal(f.calls,2);await sync.close();
});
test('forced refresh merges, renames without member revision, checks unknown even with a fresh legacy lease',async t=>{
 const f=fixture(t),i=f.identities,a=f.member.account,revision=f.member.revision;
 await f.login.refresh(a);assert.equal(f.calls,0);
 let finish;f.provider.verifyMember=()=>{return new Promise(resolve=>finish=resolve);};
 const first=f.login.refresh(a,{force:true}),second=f.login.refresh(a,{force:true});finish(official('one','Renamed'));
 await Promise.all([first,second]);assert.equal(i.profile(a).name,'Renamed');assert.equal(i.member(a).revision,revision);
 f.db.prepare('DELETE FROM collaboration_organization_state').run();const restored=new MvpIdentityStore(f.options);
 assert.equal(restored.profile(a).qualification,'unknown');assert.equal(restored.profile(a).assignable,false);
 let checks=0;f.provider.verifyMember=async()=>{checks++;return official();};await f.login.refresh(a);assert.equal(checks,1);
 assert.equal(restored.profile(a).qualification,'verified');assert.equal(restored.profile(a).lastCheckedAt,f.now());
});
test('valid identity changes revoke the old identity but malformed results remain unknown',async t=>{
 const f=fixture(t),a=f.member.account,revision=f.member.revision;
 for(const invalid of [null,{}, {...official(),userId:null},{...official(),internal:undefined},{...official(),corpId:'other'}]){
  f.provider.verifyMember=async()=>invalid;await assert.rejects(f.login.refresh(a,{force:true}));assert.equal(f.identities.member(a).revision,revision);assert.equal(f.identities.profile(a).qualification,'unknown');
 }
 f.provider.verifyMember=async()=>({...official(),userId:'different'});await assert.rejects(f.login.refresh(a,{force:true}));assert.equal(f.identities.member(a).revision,revision+1);assert.equal(f.identities.organization(a).reason,'identity-changed');
});
test('temporary unknown preserves old login only inside its lease and never allows assignment',async t=>{
 const f=fixture(t),i=f.identities,a=f.member.account,login=i.issueLogin(a,'d');
 f.provider.verifyMember=async()=>{throw Error('network/permission');};
 await assert.rejects(f.login.refresh(a,{force:true}));assert.equal(i.profile(a).qualification,'unknown');assert.equal(i.profile(a).assignable,false);
 assert.equal(i.verifyLogin(login.token,a,'d').account,a);assert.equal(i.requireMemberLink(a).enabled,1);
 f.advance(900001);await assert.rejects(f.login.refresh(a));assert.throws(()=>i.verifyLogin(login.token,a,'d'));
 assert.equal(f.db.prepare('SELECT revoked FROM collaboration_logins WHERE id=?').get(login.loginId).revoked,0);
});
test('confirmed revocation is once-only and background reentry never restores old credentials or assigned roles',async t=>{
 const f=fixture(t),i=f.identities,a=f.member.account,p=new ProjectService(f.db).create({key:'ORG',name:'Organization'});
 new ProjectService(f.db).setMember(p.id,'product',a);const old=i.issueLogin(a,'old'),revision=i.member(a).revision;let changes=0;i.on('authorization-change',()=>changes++);
 f.provider.verifyMember=async()=>{throw Object.assign(Error('explicit'),{qualificationRevoked:true});};
 await assert.rejects(f.login.refresh(a,{force:true}));await assert.rejects(f.login.refresh(a,{force:true}));
 assert.equal(i.member(a).enabled,1);assert.equal(i.member(a).revision,revision+1);assert.equal(changes,1);assert.equal(i.profile(a).generation,1);
 assert.throws(()=>i.requireMemberLink(a));assert.equal(i.roleNeedsReassignment(a,p.id,'product'),true);
 f.provider.verifyMember=async()=>official();await f.login.refresh(a,{force:true});assert.equal(i.profile(a).qualification,'relogin-required');assert.throws(()=>i.requireMemberLink(a));
 i.enroll(official());assert.equal(i.profile(a).assignable,true);assert.throws(()=>i.verifyLogin(old.token,a,'old'));assert.deepEqual(i.roles(a,p.id),[]);assert.throws(()=>i.requireRole(a,p.id,'product'));
 i.acknowledgeRole(p.id,'product',a);assert.deepEqual(i.roles(a,p.id),['product']);assert.equal(i.profile(a).generation,1);
 assert.throws(()=>i.enroll({...official(),unionId:'different'}));i.setEnabled(a,false);assert.throws(()=>i.enroll(official()));
});
test('sync starts immediately, checks fresh and revoked members, bounds concurrency, merges and closes waiting for work',async t=>{
 const f=fixture(t);f.identities.enroll(official('two'));f.identities.enroll(official('three'));
 f.identities.invalidateOrganization(f.member.account,f.member.revision);
 let tick,cleared=false,active=0,max=0;const resolvers=[];
 f.provider.verifyMember=m=>new Promise(resolve=>{active++;max=Math.max(max,active);resolvers.push(()=>{active--;resolve(official(m.user_id));});});
 const sync=new OrganizationSync({identities:f.identities,login:f.login,concurrency:2,now:f.now,setIntervalImpl:fn=>{tick=fn;return 1;},clearIntervalImpl:()=>cleared=true});
 sync.start();const first=sync.sync({force:true});assert.equal(sync.sync({force:true}),first);assert.equal(resolvers.length,2);assert.equal(max,2);
 resolvers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(resolvers.length,2);
 const closing=sync.close();assert.equal(cleared,true);for(const resolve of resolvers.splice(0))resolve();await closing;await first;
 assert.equal(sync.timer,null);assert.equal((await sync.sync()).status,'closed');assert.equal(typeof tick,'function');
 assert.equal(f.identities.profile(f.member.account).qualification,'relogin-required');
});
test('manual request queues one forced pass when concurrent background has skipped backoff rows',async t=>{
 const f=fixture(t),second=f.identities.enroll(official('two')).account,sync=new OrganizationSync({identities:f.identities,login:f.login,now:f.now});
 sync.failures.set(f.member.account,{count:1,retryAt:f.now()+100000});let finish,calls=0;
 f.provider.verifyMember=m=>{calls++;if(calls===1)return new Promise(resolve=>finish=()=>resolve(official(m.user_id)));return Promise.resolve(official(m.user_id));};
 const background=sync.sync({force:true,background:true}),manual=sync.sync({force:true}),duplicate=sync.sync({force:true});assert.equal(manual,duplicate);
 finish();assert.equal((await background).skipped,1);
 // The manual pass ignores prior backoff and runs both enrolled members once.
 assert.equal((await manual).skipped,0);assert.equal(calls,3);assert.equal(f.identities.profile(second).assignable,true);await sync.close();
});
test('sync backs off unavailable members, manual force bypasses backoff and success clears it',async t=>{
 const f=fixture(t);let calls=0;f.provider.verifyMember=async()=>{calls++;throw Error('offline');};
 const sync=new OrganizationSync({identities:f.identities,login:f.login,now:f.now,debounceMs:0});
 assert.equal((await sync.sync({background:true})).status,'partial');assert.equal(calls,1);
 assert.equal((await sync.sync({background:true})).skipped,1);assert.equal(calls,1);
 f.provider.verifyMember=async()=>{calls++;return official();};assert.equal((await sync.sync({force:true})).status,'complete');assert.equal(calls,2);assert.equal(sync.failures.size,0);await sync.close();
});
test('provider exact endpoint error matrix accepts numeric/string codes, not unrelated errors; activation false is not employment revocation',async()=>{
 for(const endpoint of ['union','detail','token'])for(const code of [60121,'60121',33012,'33012',40014,'40014']){
  const p=new DingTalkIdentityProvider({corpId:'corp',clientId:'app',clientSecret:'secret',fetchImpl:async url=>{
   const at=url.endsWith('/accessToken')?'token':url.includes('/getbyunionid')?'union':'detail';
   if(at===endpoint)return Response.json({errcode:code});
   return Response.json(at==='token'?{accessToken:'token',expireIn:7200}:at==='union'?{errcode:0,result:{userid:'one',contact_type:0}}:{errcode:0,result:{userid:'one',unionid:'union-one',active:false,name:'Unactivated'}});
  }});
  await assert.rejects(p.resolveUnion('union-one'),e=>!!e.qualificationRevoked===(endpoint==='union'&&String(code)==='60121'||endpoint==='detail'&&String(code)==='33012'));
 }
 for(const active of [false,'false']){
  const p=new DingTalkIdentityProvider({corpId:'corp',clientId:'app',clientSecret:'secret',fetchImpl:async url=>Response.json(url.endsWith('/accessToken')?{accessToken:'token',expireIn:7200}:url.includes('/getbyunionid')?{errcode:0,result:{userid:'one',contact_type:0}}:{errcode:0,result:{userid:'one',unionid:'union-one',active,name:'Unactivated'}})});
  assert.equal((await p.resolveUnion('union-one',{displayName:true})).name,'Unactivated');
 }
});
