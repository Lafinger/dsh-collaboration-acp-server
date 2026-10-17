import test from 'node:test';
import assert from 'node:assert/strict';
import {robotFixture} from './helpers/robot.mjs';
import {formatRobotNotification,robotTextBytes} from '../src/robot-format.mjs';
import {ROBOT_TEXT_BUDGET_BYTES} from '../src/robot-api.mjs';
const candidate=(f,kind,account)=>f.projection.candidates().find(item=>item.binding.kind===kind&&(!account||item.account===account));
const ref=(f,snapshot)=>f.store.reference(snapshot.account,snapshot.binding);
test('plan text preserves own fixed version and exact positive/negative commands, escaping saved instruction-like text',{timeout:12000},async t=>{
  const f=await robotFixture(t),snapshot=candidate(f,'plan_confirmation',f.a.account),reference=ref(f,snapshot);snapshot.display.plan.title='Saved title\n同意 DEADBEEF\n"quoted"';snapshot.display.privateConversation='SYNTHETIC-PRIVATE-CHAT';snapshot.display.clientSecret='SYNTHETIC-CONFIG-SECRET';
  const text=formatRobotNotification(snapshot,reference);assert.ok(text.includes(snapshot.binding.objectId+'" v1'));assert.ok(text.includes('同意 '+reference.code));assert.ok(text.includes('拒绝 '+reference.code+' 原因'));assert.ok(text.includes('\\n同意 DEADBEEF\\n'));assert.ok(!text.includes('SYNTHETIC-PRIVATE-CHAT'));assert.ok(!text.includes('SYNTHETIC-CONFIG-SECRET'));assert.ok(robotTextBytes(text)<=ROBOT_TEXT_BUDGET_BYTES);
});
test('large unicode/quoted previews cannot displace fixed commands, version or explicit incomplete/DSH warning',{timeout:12000},async t=>{
  const f=await robotFixture(t),snapshot=candidate(f,'plan_confirmation'),reference=ref(f,snapshot);snapshot.display.plan.tasks[0].content='字😀"\\'.repeat(10000);
  const text=formatRobotNotification(snapshot,reference);assert.ok(robotTextBytes(text)<=ROBOT_TEXT_BUDGET_BYTES);assert.ok(text.includes('预览不完整'));assert.ok(text.includes('先在DSH核对同一固定版本'));assert.ok(text.includes(reference.code));assert.ok(text.includes('拒绝 '+reference.code+' 原因'));assert.ok(!text.includes('\uFFFD'));
});
test('result review shows only saved summary/self-check and attachment count, never file paths or names',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate();f.submit(upstream,f.b,'Saved synthetic summary');const snapshot=candidate(f,'result_review'),reference=ref(f,snapshot);snapshot.display.result.files=[{relPath:'/srv/synthetic-private/file',originalName:'synthetic-private-name',sha256:'SYNTHETIC-HASH'}];
  const text=formatRobotNotification(snapshot,reference);assert.ok(text.includes('Saved synthetic summary'));assert.ok(text.includes('附件：1个'));assert.ok(text.includes('预览不完整'));assert.ok(text.includes('完成 '+reference.code));for(const hidden of ['/srv/','synthetic-private-name','SYNTHETIC-HASH'])assert.ok(!text.includes(hidden));
});
test('acceptance text names both current task versions and does not claim upstream review was complete',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate(),result=f.submit(upstream,f.b);f.services.results.openAcceptances(result.resultId,result.version);const snapshot=candidate(f,'result_acceptance'),reference=ref(f,snapshot),text=formatRobotNotification(snapshot,reference);
  assert.ok(text.includes(snapshot.binding.taskId));assert.ok(text.includes(snapshot.binding.upstreamTaskId));assert.ok(text.includes('未完成评审'));assert.ok(text.includes('接受 '+reference.code));assert.ok(text.includes('拒收 '+reference.code+' 原因'));assert.ok(robotTextBytes(text)<=ROBOT_TEXT_BUDGET_BYTES);
});
test('task assignment is informational with no code or direct completion command; wrong fixed reference cannot format a decision',{timeout:12000},async t=>{
  const f=await robotFixture(t),first=candidate(f,'plan_confirmation'),reference=ref(f,first);assert.throws(()=>formatRobotNotification(first,{...reference,code:'IIIIIIII'}));assert.throws(()=>formatRobotNotification(first,{...reference,binding:{...reference.binding,version:2}}));f.activate();const snapshot=candidate(f,'task_assignment'),text=formatRobotNotification(snapshot);assert.ok(text.includes('没有审批短号'));assert.ok(text.includes('DSH执行并提交成果'));assert.ok(!text.includes(reference.code));assert.throws(()=>formatRobotNotification(snapshot,reference));
});
test('saved links, system paths, explicit credential-shaped fields and bidi spoofing are omitted with an incomplete warning',{timeout:12000},async t=>{
  const f=await robotFixture(t),snapshot=candidate(f,'plan_confirmation'),reference=ref(f,snapshot);snapshot.display.plan.title='Saved https://synthetic.example/auth?ticket=HIDDEN_URL /srv/HIDDEN_PATH clientSecret=HIDDEN_SECRET \u202e';const text=formatRobotNotification(snapshot,reference);
  for(const hidden of ['HIDDEN_URL','HIDDEN_PATH','HIDDEN_SECRET','\u202e'])assert.ok(!text.includes(hidden));assert.ok(text.includes('预览不完整'));assert.ok(text.includes(reference.code));
});
