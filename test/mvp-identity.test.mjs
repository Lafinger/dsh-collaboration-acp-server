import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {MvpIdentityStore} from '../src/mvp-identities.mjs';
import {MvpLoginService} from '../src/mvp-login.mjs';
import {MvpAccessService} from '../src/mvp-service.mjs';
import {DingTalkIdentityProvider} from '../src/dingtalk-identity.mjs';
const identity=(userId='person')=>({corpId:'corp',userId,unionId:'union-'+userId,internal:true,name:'Name '+userId});
const proof=()=>randomBytes(32).toString('base64url');
function fixture(t){
 const db=openDatabase({path:':memory:'});t.after(()=>db.close());let time=1_800_000_000_000;
 const identities=new MvpIdentityStore({db,serviceId:'mvp',corpId:'corp',clientId:'app',administratorUserId:'boss',now:()=>time});
 let next=identity(),calls=0;
 const provider={async exchangePc(){calls++;return next;},async verifyMember(member){return identity(member.user_id);}};
 const login=new MvpLoginService({identities,provider,publicOrigin:'https://mvp.example',agentId:'123',now:()=>time});
 return {db,identities,login,provider,get calls(){return calls;},setIdentity:v=>next=v,advance:ms=>time+=ms,projects:new ProjectService(db)};
}
async function signedIn(f,user='person',device='pc'){
 f.setIdentity(identity(user));const p=proof(),started=f.login.start(null,device,p),binding=f.login.browser(new URL(started.loginUrl).hash.slice(1));
 await f.login.authorize({requestId:started.requestId,cookie:binding.cookie,code:proof()});
 f.login.confirm({requestId:started.requestId,cookie:binding.cookie});
 return f.login.claim(null,{requestId:started.requestId,deviceId:device,proof:p});
}
test('MVP official identity auto-enrolls stable accounts, fixed admin only; all projects visible without participant rows',t=>{
 const f=fixture(t);const a=f.identities.enroll(identity('boss')),b=f.identities.enroll(identity());
 assert.equal(a.administrator,1);assert.equal(b.administrator,0);assert.equal(f.identities.enroll(identity()).account,b.account);
 assert.throws(()=>f.identities.enroll({...identity(),unionId:'impostor'}));assert.throws(()=>f.identities.enroll({...identity(),corpId:'other'}));
 const project=f.projects.create({key:'ONE',name:'Shared'});assert.deepEqual(f.identities.projects(b.account),[project.id]);assert.equal(f.identities.requireProject(b.account,project.id).revision,1);
 assert.deepEqual(f.identities.requireProjectLink(b.account,project.id),{enabled:1,revision:1});
 assert.throws(()=>f.identities.requireProjectLink(b.account,'missing'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM collaboration_participants').get().n,0);
});
test('MVP PC requests bind device proof and browser, reject replay/cross-device and issue fixed seven-day logins',async t=>{
 const f=fixture(t),p=proof(),started=f.login.start(null,'pc',p),token=new URL(started.loginUrl).hash.slice(1),browser=f.login.browser(token);
 assert.ok(started.openUrl.startsWith('dingtalk://'));assert.equal(started.pairingCode.length,16);assert.throws(()=>f.login.browser(token));
 await assert.rejects(f.login.authorize({requestId:started.requestId,cookie:'wrong',code:proof()}));
 const identified=await f.login.authorize({requestId:started.requestId,cookie:browser.cookie,code:proof()});assert.equal(identified.identified,true);
 assert.equal((await f.login.claim(null,{requestId:started.requestId,deviceId:'pc',proof:p})).status,'pending');
 f.login.confirm({requestId:started.requestId,cookie:browser.cookie});
 await assert.rejects(f.login.claim(null,{requestId:started.requestId,deviceId:'other',proof:p}));
 await assert.rejects(f.login.claim(null,{requestId:started.requestId,deviceId:'pc',proof:proof()}));
 const result=await f.login.claim(null,{requestId:started.requestId,deviceId:'pc',proof:p});assert.equal(result.status,'authenticated');assert.equal(result.administrator,false);
 const valid=await f.login.authenticate(null,{token:result.token,deviceId:'pc'});assert.equal(valid.expiresAt,1_800_000_000_000+7*86400000);
 await assert.rejects(f.login.claim(null,{requestId:started.requestId,deviceId:'pc',proof:p}));
 f.login.logout({token:result.token,deviceId:'pc'});await assert.rejects(f.login.authenticate(null,{token:result.token,deviceId:'pc'}));
});
test('MVP official organization recheck remains bounded, expiry rejects existing devices and pending browser requests',async t=>{
 const f=fixture(t),result=await signedIn(f);f.advance(300001);let verifies=0;f.provider.verifyMember=async member=>{verifies++;return identity(member.user_id);};
 await f.login.authenticate(null,{token:result.token,deviceId:'pc'});assert.equal(verifies,1);
 f.advance(7*86400000);await assert.rejects(f.login.authenticate(null,{token:result.token,deviceId:'pc'}));
 const p=proof(),r=f.login.start(null,'new',p);f.advance(300001);assert.throws(()=>f.login.browser(new URL(r.loginUrl).hash.slice(1)));
});
test('MVP management only creates projects or assigns known member roles with stale revision and command replay protection',async t=>{
 const f=fixture(t);const admin=f.identities.enroll(identity('boss')),member=f.identities.enroll(identity());
 const service=new MvpAccessService({identities:f.identities,login:f.login,projects:f.projects,runtime:{},cwd:process.cwd(),store:{}});t.after(()=>clearInterval(service.authorizationMonitor));
 await assert.rejects(service.manage(member.account,{action:'view'}));
 const command={action:'create',commandId:'once',key:'DEMO',name:'Fresh'};const created=await service.manage(admin.account,command);assert.deepEqual(await service.manage(admin.account,command),created);
 await assert.rejects(service.manage(admin.account,{...command,name:'Changed'}));
 const view=service.adminView(admin.account,created.project.id);assert.equal(view.members.length,2);
 const role={action:'role',commandId:'role1',projectId:created.project.id,role:'frontend',account:member.account,revision:view.revision};
 const updated=await service.manage(admin.account,role);assert.ok(updated.project.roles.some(r=>r.role==='frontend'&&r.member===member.account));
 await assert.rejects(service.manage(admin.account,{...role,commandId:'stale',role:'product'}));
 await assert.rejects(service.manage(admin.account,{action:'disable',account:member.account}));
});
test('official PC code uses the correct once-only API, verifies organization mapping and keeps secrets server-side',async()=>{
 const paths=[];const p=new DingTalkIdentityProvider({corpId:'corp',clientId:'app',clientSecret:'test-secret',fetchImpl:async(url,options)=>{
 paths.push(new URL(url).pathname);
 if(url.endsWith('/accessToken'))return Response.json({accessToken:'private-app-token',expireIn:7200});
 if(url.includes('/getuserinfo?')){assert.equal(JSON.parse(options.body).code,'pc-one-use');return Response.json({errcode:0,result:{userid:'person',unionid:'union-person',name:'Person'}});}
 if(url.includes('/getbyunionid?'))return Response.json({errcode:0,result:{contact_type:0,userid:'person'}});
 if(url.includes('/v2/user/get?'))return Response.json({errcode:0,result:{userid:'person',unionid:'union-person',name:'Person',active:true}});throw new Error('Unexpected endpoint');
 }});
 assert.deepEqual(await p.exchangePc('pc-one-use'),{...identity(),name:'Person'});assert.ok(paths.includes('/topapi/v2/user/getuserinfo'));assert.ok(!paths.some(path=>path.includes('userAccessToken')));
});
