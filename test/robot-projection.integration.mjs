import test from 'node:test';
import assert from 'node:assert/strict';
import {robotFixture} from './helpers/robot.mjs';
import {RobotContextError} from '../src/robot-projection.mjs';
import {projectRoleRevision} from '../src/project-role-revision.mjs';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const ofKind=(f,kind)=>f.projection.candidates().filter(item=>item.binding.kind===kind);
const reference=(f,item)=>f.store.reference(item.account,item.binding);
function changeTask(f,task,change='modify'){
  const role=task.task.role,actor=role==='frontend'?f.b:f.a,view=f.services.plans.register({projectId:f.project.id,title:'Explicit synthetic '+change,relevantRoles:[role],rolesReason:'Explicitly change only this task',sourceAnalysisId:f.analysis.id,tasks:[{ref:'target',taskId:task.task.id,role,change,content:'Explicit saved synthetic '+change,dependsOn:change==='cancel'?[]:task.current.dependsOn}],undecided:[]});
  return {view,actor,role,activate:()=>f.confirm(actor,role,view.plan.id)};
}
function uploadReference(f,text,name='reference.txt',projectId=f.project.id){
  const source=join(f.workspace,'reference-input.txt');writeFileSync(source,text);
  return f.services.materials.upload({projectId,sourcePath:source,originalName:name,purpose:'reference tests',submittedBy:f.a.account});
}
function analyzeReference(f,scope){return f.services.analyses.submit({projectId:f.project.id,trigger:'reference tests',scope,requirements:[],undecided:[],inferences:[],notUnderstood:[],basisMissing:[]});}
function modifyFrom(f,task,sourceAnalysisId){
  const role=task.task.role,view=f.services.plans.register({projectId:f.project.id,title:'Fixed source modification',relevantRoles:[role],rolesReason:'only owner changes',sourceAnalysisId,tasks:[{ref:'modify',taskId:task.task.id,role,change:'modify',content:'changed definition',dependsOn:task.current.dependsOn}],undecided:[]});
  f.confirm(role==='frontend'?f.b:f.a,role,view.plan.id);return view;
}
const completeUpstream=(f,upstream)=>{const result=f.submit(upstream,f.b);f.services.results.review({resultId:result.resultId,version:result.version,role:'frontend',outcome:'complete',submittedBy:f.b.account,declaredMember:f.b.account});return result;};

test('fixed scope display is metadata-only, independent of successful read history, and leaves binding and business rows unchanged',{timeout:12000},async t=>{
  const f=await robotFixture(t),first=ofKind(f,'plan_confirmation')[0],ref=reference(f,first),db=f.security.db;
  const before={scope:db.prepare('SELECT * FROM analysis_scope').all(),reads:db.prepare('SELECT * FROM analysis_reads').all(),tasks:f.services.tasks.countByProject(f.project.id)};
  f.services.materials.read=()=>{throw new Error('notification must not read contents');};
  f.services.analyses.readScope=()=>{throw new Error('notification must not reanalyze');};
  const next=f.projection.describe(first.binding,first.account);
  assert.deepEqual(next.display.referenceFiles,[{materialId:f.material.material.id,version:1,name:f.material.material.originalName,available:true}]);
  assert.equal(next.display.referenceStatus,'available');assert.deepEqual(next.binding,first.binding);assert.equal(reference(f,next).code,ref.code);
  assert.deepEqual(db.prepare('SELECT * FROM analysis_scope').all(),before.scope);assert.deepEqual(db.prepare('SELECT * FROM analysis_reads').all(),before.reads);assert.equal(f.services.tasks.countByProject(f.project.id),before.tasks);
  // Failure to read at analysis time does not erase a declared reference or claim it was read.
  db.prepare('UPDATE analysis_reads SET ok=0,reason=? WHERE analysis_id=?').run('unreadable',f.analysis.id);
  assert.equal(f.projection.describe(first.binding,first.account).display.referenceStatus,'available');
  f.services.notices.markRead(first.binding);assert.equal(reference(f,f.projection.describe(first.binding,first.account)).code,ref.code);
});

test('task references use current task definition plan version, not creatorOf or latest material/plan',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate(),old=ofKind(f,'task_assignment').find(item=>item.binding.objectId===upstream.task.id);
  const one=uploadReference(f,'fixed first'),two=uploadReference(f,'newer second'),scope=[{materialId:one.material.id,version:1}],analysis=analyzeReference(f,scope);
  assert.equal(two.version.version,2);
  const changed=modifyFrom(f,upstream,analysis.id),current=ofKind(f,'task_assignment').find(item=>item.binding.objectId===upstream.task.id);
  assert.equal(current.binding.version,2);assert.deepEqual(current.display.referenceFiles,[{...scope[0],name:'reference.txt',available:true}]);
  assert.notDeepEqual(current.display.referenceFiles,old.display.referenceFiles);
  // A later saved version of the same plan must not redirect the task's source plan version.
  const db=f.security.db;db.prepare(`INSERT INTO plans(id,project_id,version,title,roles_reason,roles_overridden,proposed_roles,source_analysis_id,activated_at,created_at)
    SELECT id,project_id,version+1,title,roles_reason,roles_overridden,proposed_roles,NULL,NULL,created_at FROM plans WHERE id=? AND version=1`).run(changed.plan.id);
  const fixed=ofKind(f,'task_assignment').find(item=>item.binding.objectId===upstream.task.id);
  assert.deepEqual(fixed.display.referenceFiles,current.display.referenceFiles);assert.deepEqual(fixed.binding,current.binding);
});

test('review and acceptance reference original result task source, never unrelated downstream source',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream,downstream}=f.activate(),other=uploadReference(f,'downstream only'),analysis=analyzeReference(f,[{materialId:other.material.id,version:1}]);
  modifyFrom(f,downstream,analysis.id);
  const result=f.submit(upstream,f.b);f.services.results.openAcceptances(result.resultId,result.version);
  const review=ofKind(f,'result_review')[0],acceptance=ofKind(f,'result_acceptance')[0],assignment=ofKind(f,'task_assignment').find(item=>item.binding.objectId===downstream.task.id);
  assert.deepEqual(review.display.referenceFiles,[{materialId:f.material.material.id,version:1,name:f.material.material.originalName,available:true}]);
  assert.deepEqual(acceptance.display.referenceFiles,review.display.referenceFiles);assert.equal(assignment.display.referenceFiles[0].materialId,other.material.id);
});

test('a saved plan without source propagates none through current task, review and original-result acceptance',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate();modifyFrom(f,upstream,null);
  const task=ofKind(f,'task_assignment').find(item=>item.binding.objectId===upstream.task.id);
  assert.equal(task.display.referenceStatus,'none');assert.deepEqual(task.display.referenceFiles,[]);
  const result=f.submit(f.services.tasks.get(upstream.task.id),f.b);f.services.results.openAcceptances(result.resultId,result.version);
  for(const kind of ['result_review','result_acceptance']){const item=ofKind(f,kind)[0];assert.equal(item.display.referenceStatus,'none');assert.deepEqual(item.display.referenceFiles,[]);}
});

test('null source is none; missing or cross-project source and scope entries are unavailable without invented names',{timeout:12000},async t=>{
  const f=await robotFixture(t),db=f.security.db,first=ofKind(f,'plan_confirmation')[0],binding=first.binding;
  const describe=()=>f.projection.describe(binding,first.account);
  db.prepare('UPDATE plans SET source_analysis_id=NULL WHERE id=?').run(f.plan.plan.id);
  assert.deepEqual(describe().display.referenceFiles,[]);assert.equal(describe().display.referenceStatus,'none');assert.deepEqual(describe().binding,binding);
  const other=f.services.projects.create({key:'REF_OTHER',name:'other'}),foreign=uploadReference(f,'foreign','foreign.txt',other.id);
  db.prepare('UPDATE plans SET source_analysis_id=? WHERE id=?').run(f.analysis.id,f.plan.plan.id);
  db.prepare('INSERT INTO analysis_scope VALUES(?,?,?,?)').run(f.analysis.id,'missing-material',1,1);
  db.prepare('INSERT INTO analysis_scope VALUES(?,?,?,?)').run(f.analysis.id,f.material.material.id,99,2);
  db.prepare('INSERT INTO analysis_scope VALUES(?,?,?,?)').run(f.analysis.id,foreign.material.id,1,3);
  const missing=describe();assert.equal(missing.display.referenceStatus,'unavailable');
  assert.deepEqual(missing.display.referenceFiles.slice(1),[
    {materialId:'missing-material',version:1,name:null,available:false},
    {materialId:f.material.material.id,version:99,name:f.material.material.originalName,available:false},
    {materialId:foreign.material.id,version:1,name:null,available:false},
  ]);
  assert.deepEqual(missing.binding,binding);
  db.prepare('UPDATE analyses SET project_id=? WHERE id=?').run(other.id,f.analysis.id);
  assert.equal(describe().display.referenceStatus,'unavailable');assert.deepEqual(describe().display.referenceFiles,[]);
  // Deliberate corrupt foreign-key fixture: an explicit missing source is not no source.
  db.exec('PRAGMA foreign_keys=OFF');db.prepare('UPDATE plans SET source_analysis_id=? WHERE id=?').run('missing-analysis',f.plan.plan.id);db.exec('PRAGMA foreign_keys=ON');
  assert.equal(describe().display.referenceStatus,'unavailable');assert.deepEqual(describe().display.referenceFiles,[]);
});

test('current plan notifications are two own-role projections, unchanged by read state and with no business writes',{timeout:12000},async t=>{
  const f=await robotFixture(t),first=ofKind(f,'plan_confirmation');assert.equal(first.length,2);assert.deepEqual(new Set(first.map(item=>item.account)),new Set([f.a.account,f.b.account]));assert.equal(f.services.tasks.countByProject(f.project.id),0);
  const ref=reference(f,first[0]);f.services.notices.markRead(first[0].binding);assert.equal(ofKind(f,'plan_confirmation').length,2);assert.equal(reference(f,ofKind(f,'plan_confirmation').find(item=>item.account===ref.account)).code,ref.code);assert.equal(f.services.tasks.countByProject(f.project.id),0);
});
test('a revised plan never redirects an old code to latest slots',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=reference(f,ofKind(f,'plan_confirmation')[0]);f.services.plans.revise({planId:f.plan.plan.id,...f.draft,title:'Explicit v2',reason:'Synthetic revision'});
  assert.throws(()=>f.projection.validate(ref),RobotContextError);assert.ok(ofKind(f,'plan_confirmation').every(item=>item.binding.version===2));assert.equal(f.store.ref(ref.code).binding.version,1);
});
test('activation creates only current incomplete task reminders, not downstream acceptance slots or notifications',{timeout:12000},async t=>{
  const f=await robotFixture(t),refs=ofKind(f,'plan_confirmation').map(item=>reference(f,item));f.activate();assert.equal(ofKind(f,'plan_confirmation').length,0);assert.equal(ofKind(f,'task_assignment').length,2);assert.equal(ofKind(f,'result_acceptance').length,0);assert.equal(f.security.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n,0);
  for(const ref of refs){const current=f.projection.validate(ref);assert.equal(current.outcome,'agree');assert.equal(current.pending,false);}
});
test('historical unreviewed result slots are filtered and old result codes cannot follow a new submission',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate(),old=f.submit(upstream,f.b,'Saved v1'),ref=reference(f,ofKind(f,'result_review')[0]),next=f.submit(upstream,f.b,'Saved v2');
  assert.equal(old.version,1);assert.equal(next.version,2);assert.equal(f.services.notices.todos({projectId:f.project.id,kinds:['result_review']}).length,2);const projected=ofKind(f,'result_review');assert.equal(projected.length,1);assert.equal(projected[0].binding.version,2);assert.throws(()=>f.projection.validate(ref),RobotContextError);
});
test('own review binds task definition and result version, rather than notifying an old submission against a revised task',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate();f.submit(upstream,f.b);const ref=reference(f,ofKind(f,'result_review')[0]);changeTask(f,upstream).activate();assert.equal(f.services.tasks.get(upstream.task.id).task.currentVersion,2);assert.equal(ofKind(f,'result_review').length,0);assert.throws(()=>f.projection.validate(ref),RobotContextError);
});
test('acceptance exists only after explicit DSH opening and pins downstream and upstream result-owner task versions',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream,downstream}=f.activate(),result=completeUpstream(f,upstream);assert.equal(ofKind(f,'result_acceptance').length,0);f.services.results.openAcceptances(result.resultId,result.version);
  const item=ofKind(f,'result_acceptance')[0],ref=reference(f,item);assert.equal(item.account,f.a.account);assert.equal(item.binding.taskId,downstream.task.id);assert.equal(item.binding.taskVersion,1);assert.equal(item.binding.upstreamTaskId,upstream.task.id);assert.equal(item.binding.upstreamTaskVersion,1);assert.equal(item.display.review.outcome,'complete');
  changeTask(f,downstream).activate();assert.throws(()=>f.projection.validate(ref),RobotContextError);const next=ofKind(f,'result_acceptance')[0];assert.equal(next.binding.taskVersion,2);assert.notEqual(reference(f,next).code,ref.code);
});
test('an explicitly opened slot does not invent upstream completion, and stale upstream definitions stop both old review and acceptance',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate(),result=f.submit(upstream,f.b);f.services.results.openAcceptances(result.resultId,result.version);const item=ofKind(f,'result_acceptance')[0],ref=reference(f,item);assert.equal(item.display.review.outcome,null);
  changeTask(f,upstream).activate();assert.equal(ofKind(f,'result_review').length,0);assert.equal(ofKind(f,'result_acceptance').length,0);assert.throws(()=>f.projection.validate(ref),RobotContextError);
});
test('original administrator A→B→A path invalidates codes even when assignments and actor member revision return to the same values',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate();f.submit(upstream,f.b);const ref=reference(f,ofKind(f,'result_review')[0]),before=projectRoleRevision(f.security,f.services.projects,f.project.id),revision=f.security.member(f.b.account).revision;
  await f.assignRole('frontend',f.a.account);await f.assignRole('frontend',f.b.account);assert.equal(f.security.member(f.b.account).revision,revision);assert.notEqual(projectRoleRevision(f.security,f.services.projects,f.project.id),before);assert.throws(()=>f.projection.validate(ref),RobotContextError);assert.notEqual(reference(f,ofKind(f,'result_review')[0]).code,ref.code);
});
test('own immutable plan guard permits its exact activation effects for readback, but not later unrelated task versions',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate(),first=changeTask(f,upstream),item=ofKind(f,'plan_confirmation').find(item=>item.binding.objectId===first.view.plan.id),ref=reference(f,item);first.activate();assert.equal(f.projection.validate(ref).outcome,'agree');assert.equal(f.store.ref(ref.code).binding.taskVersions.find(([id])=>id===upstream.task.id)[1],1);
  changeTask(f,f.services.tasks.get(upstream.task.id)).activate();assert.throws(()=>f.projection.validate(ref),RobotContextError);
});
test('cancellation and archive suppress existing pending slots without deleting them or creating replacement work',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream,downstream}=f.activate(),result=f.submit(upstream,f.b);f.services.results.openAcceptances(result.resultId,result.version);const ref=reference(f,ofKind(f,'result_acceptance')[0]);changeTask(f,downstream,'cancel').activate();assert.equal(ofKind(f,'result_acceptance').length,0);assert.throws(()=>f.projection.validate(ref),RobotContextError);assert.equal(f.services.results.acceptancesOf(result.resultId,result.version)[0].outcome,null);
  f.services.projects.archive(f.project.id);assert.equal(f.projection.candidates().length,0);assert.equal(f.services.tasks.countByProject(f.project.id),2);
});
test('cancellation without an owning plan marker is still cancelled, never an alias for no own-plan effects',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream,downstream}=f.activate(),result=f.submit(upstream,f.b);f.services.results.openAcceptances(result.resultId,result.version);const ref=reference(f,ofKind(f,'result_acceptance')[0]);
  f.security.db.prepare('UPDATE tasks SET cancelled_at=?,cancelled_by_plan_id=NULL WHERE id=?').run('synthetic-cancelled',downstream.task.id);assert.throws(()=>f.projection.validate(ref),RobotContextError);assert.equal(ofKind(f,'result_acceptance').length,0);
});
test('completed two-person acceptance remains complete and produces no historic backlog on repeated scans',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream,downstream}=f.activate(),result=completeUpstream(f,upstream);f.services.results.openAcceptances(result.resultId,result.version);f.services.results.decide({resultId:result.resultId,version:result.version,taskId:downstream.task.id,outcome:'accept',submittedBy:f.a.account,declaredMember:f.a.account});
  const downstreamResult=f.submit(downstream,f.a);f.services.results.review({resultId:downstreamResult.resultId,version:downstreamResult.version,role:'product',outcome:'complete',submittedBy:f.a.account,declaredMember:f.a.account});
  for(let n=0;n<3;n++)assert.equal(f.projection.candidates().length,0);assert.equal(f.services.results.acceptancesOf(result.resultId,result.version)[0].outcome,'accept');assert.equal(f.security.member(f.a.account).revision,f.a.revision);assert.equal(f.security.db.prepare('SELECT expires_at FROM collaboration_logins WHERE id=?').get(f.devices.a.loginId).expires_at,f.devices.a.expiresAt);
});
