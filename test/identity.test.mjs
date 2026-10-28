import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {PlanService} from '../business/lib/service/plan-service.js';
import {NoticeService} from '../business/lib/service/notice-service.js';
import {IdentityStore} from '../src/identity-store.mjs';
import {LoginService} from '../src/login-service.mjs';
import {opaqueSecret} from '../src/identity-store.mjs';

function fixture(t){
  const db=openDatabase({path:':memory:'});t.after(()=>db.close());let clock=1000000;
  const identities=new IdentityStore({db,serviceId:'service',corpId:'corp',clientId:'app',now:()=>clock,organizationTtlMs:300000});
  for(const account of ['alice','bob'])identities.bind({account,userId:`u-${account}`,unionId:`union-${account}`,administrator:account==='alice'});
  const verify=account=>identities.markVerified(account,{corpId:'corp',userId:`u-${account}`,unionId:`union-${account}`,internal:true});
  verify('alice');verify('bob');
  const projects=new ProjectService(db),project=projects.create({key:'TEST',name:'Test'});
  identities.participate(project.id,'alice',true);identities.participate(project.id,'bob',true);
  projects.setMember(project.id,'product','alice');projects.setMember(project.id,'backend','bob');
  const provider={exchange:async code=>({corpId:'corp',userId:`u-${code}`,unionId:`union-${code}`,internal:true}),
    verifyMember:async m=>({corpId:'corp',userId:m.user_id,unionId:m.union_id,internal:true})};
  const login=new LoginService({identities,provider,publicOrigin:'https://login.example.test',now:()=>clock});
  return {db,identities,projects,project,verify,provider,login,advance:ms=>{clock+=ms;}};
}

test('identity metadata is scoped, unique, private credentials hashed and member/project/admin distinct',t=>{
  const f=fixture(t),{identities:i}=f;
  assert.throws(()=>i.bind({account:'other',userId:'u-alice',unionId:'union-other'}));
  assert.throws(()=>i.bind({account:'alice',userId:'new-user',unionId:'new-union'}),/distinct account/);
  assert.throws(()=>i.requireAdministrator('bob'));
  assert.equal(i.requireProject('bob',f.project.id).enabled,1);
  const login=i.issueLogin('alice','device');assert.equal(i.verifyLogin(login.token,'alice','device').account,'alice');
  assert.throws(()=>i.verifyLogin(login.token,'bob','device'));
  assert.throws(()=>i.verifyLogin(login.token,'alice','other-device'));
  assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM collaboration_logins').all()).includes(login.token));
  assert.throws(()=>new IdentityStore({db:f.db,serviceId:'another',corpId:'corp',clientId:'app'}),/different service/);
});

test('device logout does not disable IM member; expiry, global revoke and new epoch fail closed',t=>{
  const f=fixture(t),i=f.identities,a=i.issueLogin('alice','one'),b=i.issueLogin('alice','two');
  assert.throws(()=>i.revokeDevice(a.token,'bob','one'));assert.throws(()=>i.revokeDevice(a.token,'alice','wrong'));
  i.revokeDevice(a.token,'alice','one');assert.throws(()=>i.verifyLogin(a.token,'alice','one'));
  assert.equal(i.requireMember('alice').enabled,1);assert.equal(i.verifyLogin(b.token,'alice','two').account,'alice');
  i.setEnabled('alice',false);assert.throws(()=>i.requireMember('alice'));assert.throws(()=>i.verifyLogin(b.token,'alice','two'));
  i.setEnabled('alice',true);f.verify('alice');const c=i.issueLogin('alice','one');i.revokeAllDevices();assert.throws(()=>i.verifyLogin(c.token,'alice','one'));
  const d=i.issueLogin('bob','one');f.advance(43200000);f.verify('bob');assert.throws(()=>i.verifyLogin(d.token,'bob','one'));
});

test('project revoke suspends pending plan, retains decisions and rejects other participant next confirmation',t=>{
  const f=fixture(t),plans=new PlanService(f.db),notices=new NoticeService(f.db);
  const v=plans.register({projectId:f.project.id,title:'Pending',relevantRoles:['product','backend'],rolesReason:'both',tasks:[],undecided:[]});
  plans.confirm({planId:v.plan.id,role:'product',outcome:'agree',submittedBy:'alice',declaredMember:'alice'});
  f.identities.participate(f.project.id,'alice',false);
  assert.equal(plans.get(v.plan.id).gate.kind,'suspended');assert.throws(()=>f.identities.requireProject('alice',f.project.id));
  assert.throws(()=>plans.confirm({planId:v.plan.id,role:'backend',outcome:'agree',submittedBy:'bob',declaredMember:'bob'}),e=>e.code==='PLAN_SUSPENDED');
  assert.equal(plans.get(v.plan.id).slots.find(s=>s.role==='product').outcome,'agree');assert.equal(notices.todos({projectId:f.project.id}).length,0);
  const revised=plans.revise({planId:v.plan.id,title:'Revised',relevantRoles:['product','backend'],rolesReason:'both',tasks:[],undecided:[],reason:'Explicit re-review'});
  assert.equal(revised.gate.kind,'waiting');assert.equal(plans.history(v.plan.id)[0].slots.find(s=>s.role==='product').outcome,'agree');
});

test('role replacement suspends, vacant first assignment does not suspend, activated facts do not roll back',t=>{
  const f=fixture(t),plans=new PlanService(f.db);
  const v=plans.register({projectId:f.project.id,title:'Pending',relevantRoles:['product','backend'],rolesReason:'both',tasks:[],undecided:[]});
  plans.confirm({planId:v.plan.id,role:'product',outcome:'reject',reason:'Needs correction',submittedBy:'alice',declaredMember:'alice'});
  f.projects.setMember(f.project.id,'product','bob');assert.equal(plans.get(v.plan.id).gate.kind,'suspended');
  assert.equal(plans.get(v.plan.id).slots.find(s=>s.role==='product').reason,'Needs correction');
  const r=plans.revise({planId:v.plan.id,title:'Revised',relevantRoles:['product'],rolesReason:'now one',tasks:[],undecided:[],reason:'Human revision'});
  const active=plans.confirm({planId:r.plan.id,role:'product',outcome:'agree',submittedBy:'bob',declaredMember:'bob'});
  f.projects.setMember(f.project.id,'product','alice');assert.equal(plans.get(v.plan.id).plan.activatedAt,active.plan.activatedAt);
  const vacant=plans.register({projectId:f.project.id,title:'Vacant',relevantRoles:['design'],rolesReason:'design',tasks:[],undecided:[]});
  f.projects.setMember(f.project.id,'design','alice');assert.equal(plans.get(vacant.plan.id).gate.kind,'waiting');
});

test('OAuth start callback claim bound to original device, SSH member, browser cookie and one-use code',async t=>{
  const f=fixture(t),proof=opaqueSecret(),start=f.login.start('alice','device',proof);
  assert.ok(!start.loginUrl.includes(proof));const browser=f.login.browserStart(start.requestId);
  const authorization=new URL(browser.authorizationUrl);assert.equal(authorization.searchParams.get('corpId'),'corp');
  await assert.rejects(f.login.callback({state:authorization.searchParams.get('state'),code:'alice',cookie:'wrong'}));
  assert.equal((await f.login.claim('alice',{requestId:start.requestId,deviceId:'device',proof})).status,'pending');
  await f.login.callback({state:authorization.searchParams.get('state'),code:'alice',cookie:browser.cookie});
  await assert.rejects(f.login.claim('bob',{requestId:start.requestId,deviceId:'device',proof}));
  await assert.rejects(f.login.claim('alice',{requestId:start.requestId,deviceId:'other',proof}));
  const result=await f.login.claim('alice',{requestId:start.requestId,deviceId:'device',proof});assert.equal(result.status,'authenticated');
  assert.equal((await f.login.authenticate('alice',{token:result.token,deviceId:'device'})).account,'alice');
  await assert.rejects(f.login.claim('alice',{requestId:start.requestId,deviceId:'device',proof}));
  const second=f.login.start('alice','device',opaqueSecret()),b=f.login.browserStart(second.requestId);
  await assert.rejects(f.login.callback({state:new URL(b.authorizationUrl).searchParams.get('state'),code:'alice',cookie:b.cookie}));
});

test('official explicit membership revocation suspends pending decisions and invalidates contexts even after organization requalification',async t=>{
  const f=fixture(t),plans=new PlanService(f.db),before=f.identities.member('alice').revision,login=f.identities.issueLogin('alice','device');
  const plan=plans.register({projectId:f.project.id,title:'Qualification',relevantRoles:['product','backend'],rolesReason:'both',tasks:[],undecided:[]});
  f.advance(300001);f.provider.verifyMember=async()=>{throw Object.assign(new Error('official inactive'),{qualificationRevoked:true});};await assert.rejects(f.login.refresh('alice'));
  assert.equal(f.identities.member('alice').revision,before+1);assert.equal(plans.get(plan.plan.id).gate.kind,'suspended');
  f.provider.verifyMember=async m=>({corpId:'corp',userId:m.user_id,unionId:m.union_id,internal:true});await f.login.refresh('alice');assert.throws(()=>f.identities.verifyLogin(login.token,'alice','device'));
});

test('OAuth wrong identity and expired organization refresh fail closed without fallback',async t=>{
  const f=fixture(t),proof=opaqueSecret(),start=f.login.start('alice','device',proof),browser=f.login.browserStart(start.requestId);
  await assert.rejects(f.login.callback({state:new URL(browser.authorizationUrl).searchParams.get('state'),code:'bob',cookie:browser.cookie}));
  await assert.rejects(f.login.claim('alice',{requestId:start.requestId,deviceId:'device',proof}));
  const active=f.identities.issueLogin('alice','device');f.advance(300001);f.provider.verifyMember=async()=>{throw new Error('offline');};
  await assert.rejects(f.login.authenticate('alice',{token:active.token,deviceId:'device'}));assert.throws(()=>f.identities.requireMember('alice'));
  assert.throws(()=>f.login.browserStart(start.requestId));
});
