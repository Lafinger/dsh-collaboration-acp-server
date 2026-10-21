import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {PlanService} from '../business/lib/service/plan-service.js';
import {TaskService} from '../business/lib/service/task-service.js';
import {MaterialService} from '../business/lib/service/material-service.js';
import {AnalysisService} from '../business/lib/service/analysis-service.js';
import {ResultService} from '../business/lib/service/result-service.js';
import {NoticeService} from '../business/lib/service/notice-service.js';
import {SessionIdentityService} from '../business/lib/service/session-identity-service.js';
import {analysisToolDefinitions} from '../business/lib/tool/analysis-tools.js';
import {materialToolDefinitions} from '../business/lib/tool/material-tools.js';
import {noticeToolDefinitions} from '../business/lib/tool/notice-tools.js';
import {IdentityStore} from '../src/identity-store.mjs';
import {ProjectAccess} from '../src/project-access.mjs';
import {bindCollaborationIdentity} from '../src/collaboration-binding.mjs';

// Production order matters: access(identity(original)), not access(original).
// All identity, material, plan, task and result facts below are synthetic and local.
function fixture(t){
  const db=openDatabase({path:':memory:'});t.after(()=>db.close());
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'project-access-binding-'))),workspace=join(root,'workspace');mkdirSync(workspace);
  const projects=new ProjectService(db),tasks=new TaskService(db),materials=new MaterialService(db,join(root,'files'));
  const services={projects,tasks,materials,plans:new PlanService(db,undefined,tasks),analyses:new AnalysisService(db,materials),results:new ResultService(db),notices:new NoticeService(db),identities:new SessionIdentityService(db)};
  const security=new IdentityStore({db,serviceId:'synthetic-binding-service',corpId:'synthetic-corp',clientId:'synthetic-app'});
  const project=projects.create({key:'BINDING',name:'Synthetic production binding regression'});
  for(const account of ['alice','bob']){
    security.bind({account,userId:account,unionId:account});
    security.markVerified(account,{corpId:'synthetic-corp',userId:account,unionId:account,internal:true});
    security.participate(project.id,account,true);
  }
  projects.setMember(project.id,'product','alice');projects.setMember(project.id,'backend','bob');
  const principal={account:'alice',projectId:project.id,channel:'dsh'},access=new ProjectAccess({identities:security,services});
  const identity=bindCollaborationIdentity(null,services.identities,{sessionId:'synthetic-binding-session',account:'alice',workspace});
  const definitions=[...analysisToolDefinitions(services.analyses),...materialToolDefinitions(materials),...noticeToolDefinitions(services)];
  const tool=(name,instrument=definition=>definition)=>{
    const original=definitions.find(definition=>definition.name===name);assert.ok(original,'Expected an actual business tool');
    return access.transform(principal)(identity(instrument(original)));
  };
  return {db,root,workspace,project,services,tool};
}

function analysisInput(f){
  const sourcePath=join(f.workspace,'synthetic-analysis.txt');writeFileSync(sourcePath,'Synthetic fixed analysis input.');
  const material=f.services.materials.upload({projectId:f.project.id,sourcePath,purpose:'synthetic analysis',submittedBy:'alice'});
  return {project_id:f.project.id,trigger:'Synthetic production combination',scope:[{material_id:material.material.id,version:1}],requirements:Array.from({length:9},()=>({text:'Synthetic requirement',sources:[{material_id:material.material.id,version:1}]})),undecided:[],inferences:['Synthetic inference'],not_understood:[],basis_missing:[]};
}

function countedAnalysis(f){
  const counts={dispatches:0,submits:0},submit=f.services.analyses.submit.bind(f.services.analyses);
  f.services.analyses.submit=(...args)=>{counts.submits++;return submit(...args);};
  const tool=f.tool('analysis_submit',original=>({...original,execute:(...args)=>{counts.dispatches++;return original.execute(...args);}}));
  return {counts,tool};
}

test('production binding rejects object inferences before official dispatch or analysis service invocation',async t=>{
  const f=fixture(t),args=analysisInput(f),{tool,counts}=countedAnalysis(f);
  const result=await tool.execute({...args,inferences:[{text:'SYNTHETIC_PRIVATE_ARGUMENT'}]},{});
  assert.equal(result.ok,false);assert.equal(result.code,'INVALID_ARGS');assert.deepEqual(counts,{dispatches:0,submits:0});
  assert.equal(f.services.analyses.listByProject(f.project.id).length,0);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_PRIVATE_ARGUMENT'));
});

test('production binding submits corrected string inferences exactly once after an explicit rejected call',async t=>{
  const f=fixture(t),args=analysisInput(f),{tool,counts}=countedAnalysis(f);
  const rejected=await tool.execute({...args,inferences:[{text:'Synthetic inference'}]},{});
  assert.equal(rejected.code,'INVALID_ARGS');assert.deepEqual(counts,{dispatches:0,submits:0});
  assert.equal(f.services.analyses.listByProject(f.project.id).length,0);
  const accepted=await tool.execute(args,{});assert.equal(accepted.ok,true);assert.deepEqual(counts,{dispatches:1,submits:1});
  const stored=f.services.analyses.listByProject(f.project.id);assert.equal(stored.length,1);assert.equal(stored[0].id,accepted.analysis_id);
});

for(const [label,extra]of [['missing',{}],['null',{submitted_by:null}],['number',{submitted_by:123}],['forged',{submitted_by:'synthetic-forged-user'}]]){
  test(`production material upload binds ${label} submitted_by to the authenticated account before official validation`,async t=>{
    const f=fixture(t),sourcePath=join(f.workspace,'synthetic-upload.txt');writeFileSync(sourcePath,'Synthetic upload only.');
    const result=await f.tool('material_upload').execute({project_id:f.project.id,source_path:sourcePath,purpose:'synthetic upload',...extra},{});
    assert.equal(result.ok,true);assert.equal(result.material.submitted_by,'alice');
    const stored=f.db.prepare('SELECT submitted_by FROM materials WHERE id=?').get(result.material.material_id);
    assert.equal(stored.submitted_by,'alice');assert.equal(f.db.prepare('SELECT count(*) AS n FROM materials').get().n,1);
  });
}

test('production material binding preserves SERVER_WORKSPACE_ONLY precedence for a non-workspace file',async t=>{
  const f=fixture(t),sourcePath=join(f.root,'synthetic-outside-workspace.txt');writeFileSync(sourcePath,'Synthetic outside-workspace fixture.');
  let uploads=0;const upload=f.services.materials.upload.bind(f.services.materials);
  f.services.materials.upload=(...args)=>{uploads++;return upload(...args);};
  const result=await f.tool('material_upload').execute({project_id:f.project.id,source_path:sourcePath,purpose:'synthetic outside'},{});
  assert.equal(result.ok,false);assert.equal(result.code,'SERVER_WORKSPACE_ONLY');assert.equal(uploads,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM materials').get().n,0);
});

function seedOwnAndOtherItems(f){
  const plan=f.services.plans.register({projectId:f.project.id,title:'Synthetic completed tasks',relevantRoles:['product','backend'],rolesReason:'Synthetic two-member filtering',tasks:['product','backend'].map(role=>({ref:'synthetic-'+role,role,change:'add',content:'Synthetic isolated '+role+' task',requiredResults:'Synthetic receipt',completionCriteria:'Synthetic self-check',dependsOn:[]})),undecided:[]});
  for(const [role,account]of [['product','alice'],['backend','bob']]){
    f.services.plans.confirm({planId:plan.plan.id,role,outcome:'agree',submittedBy:account,declaredMember:account});
  }
  const tasks=f.services.tasks.listByProject(f.project.id);assert.equal(tasks.length,2);
  for(const {task}of tasks){
    const account=task.role==='product'?'alice':'bob';
    const result=f.services.results.submit({taskId:task.id,summary:'Synthetic '+task.role+' result',selfCheck:'Synthetic self-check',files:[],submittedBy:account});
    f.services.results.review({resultId:result.resultId,version:result.version,role:task.role,outcome:'complete',submittedBy:account,declaredMember:account});
  }
  f.services.plans.register({projectId:f.project.id,title:'Synthetic pending confirmations',relevantRoles:['product','backend'],rolesReason:'Synthetic pending two-member filtering',tasks:[],undecided:[]});
  for(const rows of [f.services.notices.todos({projectId:f.project.id}),f.services.notices.list({projectId:f.project.id})]){
    assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.member).sort(),['alice','bob']);
  }
}

for(const [name,key]of [['todo_list','todos'],['notice_list','notices']]){
  test(`production ${name} keeps own-only filtering before official validation of caller role filters`,async t=>{
    const f=fixture(t);seedOwnAndOtherItems(f);
    const filters=[['omitted',{}],['empty',{roles:[]}],['other role',{roles:['backend']}],['unknown role',{roles:['synthetic-unknown-role']}],['non-array',{roles:'backend'}],['null',{roles:null}]];
    for(const [label,extra]of filters){
      const result=await f.tool(name).execute({project_id:f.project.id,...extra},{});
      assert.equal(result.ok,true,label);assert.equal(result.count,1,label);assert.equal(result[key].length,1,label);
      assert.equal(result[key][0].member,'alice',label);assert.equal(result[key][0].role,'product',label);
    }
  });
}
