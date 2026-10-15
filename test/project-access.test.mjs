import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {PlanService} from '../business/lib/service/plan-service.js';
import {MaterialService} from '../business/lib/service/material-service.js';
import {AnalysisService} from '../business/lib/service/analysis-service.js';
import {NoticeService} from '../business/lib/service/notice-service.js';
import {projectToolDefinitions} from '../business/lib/tool/project-tools.js';
import {analysisToolDefinitions} from '../business/lib/tool/analysis-tools.js';
import {materialToolDefinitions} from '../business/lib/tool/material-tools.js';
import {noticeToolDefinitions} from '../business/lib/tool/notice-tools.js';
import {IdentityStore} from '../src/identity-store.mjs';
import {ProjectAccess} from '../src/project-access.mjs';

function fixture(t){
  const db=openDatabase({path:':memory:'});t.after(()=>db.close());const root=mkdtempSync(join(tmpdir(),'project-access-'));
  const projects=new ProjectService(db),plans=new PlanService(db),materials=new MaterialService(db,join(root,'files'));
  const services={projects,plans,materials,analyses:new AnalysisService(db,materials),notices:new NoticeService(db)};
  const identities=new IdentityStore({db,serviceId:'service',corpId:'corp',clientId:'app'});
  for(const account of ['alice','bob']){identities.bind({account,userId:account,unionId:account});identities.markVerified(account,{corpId:'corp',userId:account,unionId:account,internal:true});}
  const a=projects.create({key:'A',name:'A'}),b=projects.create({key:'B',name:'B'});
  identities.participate(a.id,'alice',true);identities.participate(b.id,'bob',true);
  projects.setMember(a.id,'product','alice');projects.setMember(a.id,'backend','bob');
  const principal={account:'alice',projectId:a.id,channel:'dsh'};
  const access=new ProjectAccess({identities,services});
  const defs=[...projectToolDefinitions(projects,plans),...analysisToolDefinitions(services.analyses),...materialToolDefinitions(materials),...noticeToolDefinitions(services)];
  const tool=(name,p=principal)=>access.transform(p)(defs.find(d=>d.name===name));
  return {db,root,services,identities,a,b,principal,access,tool};
}

test('DSH project-bound scope filters directory and refuses cross project objects before business execution',async t=>{
  const f=fixture(t);const list=await f.tool('project_list').execute({},{});assert.deepEqual(list.projects.map(p=>p.id),[f.a.id]);
  const own=await f.tool('project_get').execute({project_id:f.a.id},{});assert.equal(own.ok,true);
  const other=await f.tool('project_get').execute({project_id:f.b.id},{});assert.equal(other.ok,false);
  const path=join(f.root,'other.txt');writeFileSync(path,'SECRET OTHER PROJECT');
  const m=f.services.materials.upload({projectId:f.b.id,sourcePath:path,purpose:'other',submittedBy:'bob'});
  for(const name of ['analysis_begin','analysis_submit']){
    const result=await f.tool(name).execute({project_id:f.a.id,scope:[{material_id:m.material.id,version:1}],trigger:'read',requirements:[],undecided:[],inferences:[],not_understood:[],basis_missing:[]},{});
    assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
  assert.equal(f.services.analyses.listByProject(f.a.id).length,0);
});

test('qualified role can record its decision while another slot is vacant; inactive assigned member cannot complete activation',t=>{
  const f=fixture(t);const plan=f.services.plans.register({projectId:f.a.id,title:'Vacant design',relevantRoles:['product','design'],rolesReason:'both',tasks:[],undecided:[]});
  assert.doesNotThrow(()=>f.access.validateInput('plan_confirm',{plan_id:plan.plan.id,role:'product'},f.principal));
  const decided=f.services.plans.confirm({planId:plan.plan.id,role:'product',outcome:'agree',submittedBy:'alice',declaredMember:'alice'});assert.equal(decided.gate.kind,'waiting');
  const invalid=f.services.plans.register({projectId:f.a.id,title:'Unqualified assignee',relevantRoles:['product','backend'],rolesReason:'both',tasks:[],undecided:[]});
  assert.throws(()=>f.access.validateInput('plan_confirm',{plan_id:invalid.plan.id,role:'product'},f.principal));
});

test('own todos cannot be broadened by arbitrary roles or empty filters and unauthorized read markers fail',async t=>{
  const f=fixture(t);
  f.services.plans.register({projectId:f.a.id,title:'Both',relevantRoles:['product','backend'],rolesReason:'both',tasks:[],undecided:[]});
  const result=await f.tool('todo_list').execute({project_id:f.a.id,roles:['backend']},{});
  assert.equal(result.ok,true);assert.equal(result.todos.length,1);assert.equal(result.todos[0].member,'alice');
  const counts=await f.tool('todo_unread').execute({project_id:f.a.id},{});assert.deepEqual(counts.roles.map(r=>r.role),['product']);
  const fail=await f.tool('todo_mark_read').execute({project_id:f.a.id,object_id:result.todos[0].object_id,version:1,kind:'plan_confirmation',role:'backend'},{});assert.equal(fail.ok,false);
});

test('IM private receives only narrowed metadata, no writes/full materials; group cannot borrow private query tools',async t=>{
  const f=fixture(t),p={...f.principal,channel:'im-private'};
  const details=await f.tool('project_get',p).execute({project_id:f.a.id},{});
  assert.equal(details.ok,true);assert.ok(!('roles' in details));assert.ok(!('background' in details.project));assert.equal(details.project.project_id,f.a.id);
  const full=await f.tool('material_read',p).execute({material_id:'forged',version:1},{});assert.equal(full.ok,false);
  const write=await f.tool('project_update_details',p).execute({project_id:f.a.id,goal:'wrong'},{});assert.equal(write.ok,false);assert.equal(f.services.projects.get(f.a.id).goal,null);
  const group=await f.tool('todo_list',{...p,channel:'im-group'}).execute({project_id:f.a.id},{});assert.equal(group.ok,false);
});

test('revocation after tool invocation suppresses output and old/corrupted stored cross references are rejected',async t=>{
  const f=fixture(t),original={name:'project_get',execute:()=>{f.identities.participate(f.a.id,'alice',false);return {ok:true,project:{id:f.a.id,name:'must not disclose'}};}};
  const denied=await f.access.transform(f.principal)(original).execute({project_id:f.a.id},{});assert.equal(denied.ok,false);
  f.identities.participate(f.a.id,'alice',true);
  const file=join(f.root,'other.txt');writeFileSync(file,'private');const m=f.services.materials.upload({projectId:f.b.id,sourcePath:file,purpose:'other',submittedBy:'bob'});
  const analysis=f.services.analyses.submit({projectId:f.a.id,trigger:'old malformed reference',scope:[{materialId:m.material.id,version:1}],requirements:[],undecided:[],inferences:[],notUnderstood:[],basisMissing:[]});
  const result=await f.tool('analysis_get').execute({analysis_id:analysis.id},{});assert.equal(result.ok,false);
});
