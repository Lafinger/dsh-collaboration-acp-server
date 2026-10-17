import test from 'node:test';
import assert from 'node:assert/strict';
import {robotFixture} from './helpers/robot.mjs';
import {RobotDecisionExecutor} from '../src/robot-decisions.mjs';
const own=(f,kind,account)=>{const item=f.projection.candidates().find(item=>item.binding.kind===kind&&item.account===account);assert.ok(item,'Expected a current own pending projection');return f.store.reference(account,item.binding);};
function entry(f,isActive=()=>true){
  const executor=new RobotDecisionExecutor({...f,isActive}),counter={value:0};
  const event=(actor,content,msgId='synthetic-native-msg-'+(++counter.value))=>({userId:actor.user_id,msgId,createdAt:f.now(),content});
  const send=async(actor,content,msgId)=>{const source=event(actor,content,msgId),accepted=executor.accept(source);return {accepted,event:source,result:accepted.work?await accepted.work:{status:accepted.status??'ignored'}};};
  return {executor,event,send};
}
const completeUpstream=(f,upstream)=>{const result=f.submit(upstream,f.b);f.services.results.review({resultId:result.resultId,version:result.version,role:'frontend',outcome:'complete',submittedBy:f.b.account,declaredMember:f.b.account});return result;};

test('durable receipt precedes ACK while original peer qualification waits outside SQLite; own approval never substitutes for the other role',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account),e=entry(f);f.advance(300001);await f.login.refresh(f.a.account);f.contacts.length=0;
  let arrived,release;const waiting=new Promise(resolve=>arrived=resolve);f.setVerifier(member=>new Promise(resolve=>{release=()=>resolve(f.official(member.user_id));arrived();}));
  const source=e.event(f.a,'同意 '+ref.code),accepted=e.executor.accept(source);assert.equal(accepted.ack,true);assert.equal(f.store.receipt(source.msgId).status,'received');await waiting;
  assert.equal(f.services.plans.get(f.plan.plan.id).slots.find(row=>row.role==='product').outcome,null);assert.equal(f.services.tasks.countByProject(f.project.id),0);release();assert.equal((await accepted.work).status,'applied');assert.deepEqual(f.contacts,['b']);
  const view=f.services.plans.get(f.plan.plan.id);assert.equal(view.slots.find(row=>row.role==='product').submittedBy,f.a.account);assert.equal(view.slots.find(row=>row.role==='frontend').outcome,null);assert.equal(f.services.tasks.countByProject(f.project.id),0);assert.equal(f.store.ready().length,1);
  const other=own(f,'plan_confirmation',f.b.account);assert.equal((await e.send(f.b,'同意 '+other.code)).result.status,'applied');assert.equal(f.services.tasks.countByProject(f.project.id),2);assert.equal(f.store.ready().length,2);
});
test('duplicate native msgId and a fresh same-action query never repeat business; a conflicting decision never overrides',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account),e=entry(f);let writes=0;const original=f.services.plans.confirm.bind(f.services.plans);f.services.plans.confirm=input=>{writes++;return original(input);};
  const first=await e.send(f.a,'同意 '+ref.code);assert.equal(first.result.status,'applied');const at=f.services.plans.get(f.plan.plan.id).slots.find(row=>row.role==='product').decidedAt;
  const intent=f.store.ready()[0];f.store.claim(intent.id);f.store.finishDelivery(intent.id,{status:'accepted',acceptedKey:'synthetic-platform-key'});
  const repeated=e.executor.accept(first.event);assert.equal(repeated.duplicate,true);assert.equal(repeated.work,null);assert.equal(f.store.delivery(intent.id).status,'accepted');
  assert.equal((await e.send(f.a,'同意 '+ref.code)).result.status,'readback');assert.equal((await e.send(f.a,'拒绝 '+ref.code+' 明确不同意见')).result.status,'conflict');assert.equal(writes,1);
  const slot=f.services.plans.get(f.plan.plan.id).slots.find(row=>row.role==='product');assert.equal(slot.outcome,'agree');assert.equal(slot.decidedAt,at);
  assert.throws(()=>e.executor.accept({...first.event,content:'拒绝 '+ref.code+' 同ID篡改'}),error=>error.code==='MESSAGE_ID_CONFLICT');assert.equal(writes,1);
});
test('administrator cannot use another recipient code; unknown and known non-pilot senders are never auto-enrolled or routed to a model',{timeout:12000},async t=>{
  const f=await robotFixture(t),other=own(f,'plan_confirmation',f.b.account),e=entry(f),before=f.security.db.prepare('SELECT COUNT(*) AS n FROM collaboration_members').get().n;
  assert.equal((await e.send(f.a,'同意 '+other.code)).result.status,'invalid');assert.ok(!f.store.ready()[0].payload_text.includes(f.b.account));assert.ok(!f.store.ready()[0].payload_text.includes(f.project.name));
  assert.equal(e.executor.accept({userId:'synthetic-unknown',msgId:'synthetic-unknown-msg',createdAt:f.now(),content:'同意 '+other.code}).ignored,true);assert.equal(f.security.db.prepare('SELECT COUNT(*) AS n FROM collaboration_members').get().n,before);
  const outsider=f.security.enroll(f.official('outside-pilot'));assert.equal(e.executor.accept(e.event(outsider,'同意 '+other.code)).ignored,true);assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);
});
test('wrong action returns the bound allowed commands without conversion, including when a plan peer needs official refresh',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account),e=entry(f);f.advance(300001);await f.login.refresh(f.a.account);f.contacts.length=0;
  const reply=await e.send(f.a,'完成 '+ref.code);assert.equal(reply.result.status,'invalid');assert.equal(f.store.receipt(reply.event.msgId).result.kind,'wrong-action');assert.deepEqual(f.contacts,['b']);assert.match(f.store.ready()[0].payload_text,/允许：同意/);assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);
});
test('temporary official peer failure collects no decision, extends no stale cache and does not revoke seven-day device logins',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account),e=entry(f);f.advance(300001);await f.login.refresh(f.a.account);const before=f.security.member(f.b.account),epoch=f.security.epoch;f.setVerifier(async()=>{throw Error('Untrusted raw synthetic provider details must not be sent');});
  const reply=await e.send(f.a,'同意 '+ref.code);assert.equal(reply.result.status,'failed');assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);assert.equal(f.security.member(f.b.account).verified_until,before.verified_until);assert.equal(f.security.member(f.b.account).revision,before.revision);assert.equal(f.security.epoch,epoch);assert.equal(f.security.db.prepare('SELECT revoked FROM collaboration_logins WHERE id=?').get(f.devices.b.loginId).revoked,0);assert.ok(f.store.ready().every(row=>!row.payload_text.includes('Untrusted raw')));
});
async function changeWhileQualifying(t,change){
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account);let active=true;const e=entry(f,()=>active);f.advance(300001);await f.login.refresh(f.a.account);
  let arrived,release;const waiting=new Promise(resolve=>arrived=resolve);f.setVerifier(member=>new Promise(resolve=>{release=()=>resolve(f.official(member.user_id));arrived();}));const source=e.event(f.a,'同意 '+ref.code),accepted=e.executor.accept(source);await waiting;await change(f,()=>{active=false;});release();const result=await accepted.work;
  assert.notEqual(result.status,'applied');assert.equal(f.services.tasks.countByProject(f.project.id),0);return {f,result,source,e};
}
test('plan version changed during qualification is not adopted by old consent',{timeout:12000},async t=>{
  const {f}=await changeWhileQualifying(t,f=>f.services.plans.revise({planId:f.plan.plan.id,...f.draft,title:'Explicit v2 during official refresh',reason:'Synthetic race'}));const view=f.services.plans.get(f.plan.plan.id);assert.equal(view.plan.version,2);assert.equal(view.slots.every(row=>row.outcome===null),true);
});
test('entry disabled during qualification drains the receipt without committing or replaying consent',{timeout:12000},async t=>{
  const {f,source}=await changeWhileQualifying(t,(_f,disable)=>disable());assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);assert.notEqual(f.store.receipt(source.msgId).status,'received');
});
test('a revoked actor during qualification cannot record a decision',{timeout:12000},async t=>{
  const {f}=await changeWhileQualifying(t,f=>f.security.setEnabled(f.a.account,false));assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);
});
test('real original business, terminal audit and receipt intent roll back together when intent persistence fails',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account),e=entry(f),enqueue=f.store.enqueue.bind(f.store);let once=true;f.store.enqueue=input=>{if(once){once=false;throw Error('synthetic after business before intent');}return enqueue(input);};
  const reply=await e.send(f.a,'同意 '+ref.code);assert.equal(reply.result.status,'failed');assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);assert.equal(f.store.receipt(reply.event.msgId).status,'failed');assert.equal(f.store.ready().length,1);assert.ok(!f.store.ready()[0].payload_text.startsWith('已记录'));
  assert.equal((await e.send(f.a,'同意 '+ref.code)).result.status,'applied');
});
test('committed decisions never silently omit the durable receipt intent when qualification expires after the final business check',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account),e=entry(f),finish=f.store.finishReceipt.bind(f.store);f.store.finishReceipt=(id,status,result)=>{finish(id,status,result);if(status==='applied')f.advance(300001);};
  const reply=await e.send(f.a,'同意 '+ref.code);assert.equal(reply.result.status,'applied');assert.equal(f.store.receipt(reply.event.msgId).status,'applied');assert.equal(f.services.plans.get(f.plan.plan.id).slots.find(row=>row.role==='product').outcome,'agree');assert.equal(f.store.ready().length,1,'An intent must persist even though later delivery must refresh qualification');
});
test('malformed ordinary chat is not archived as a conversation or interpreted by the model',{timeout:12000},async t=>{
  const f=await robotFixture(t),e=entry(f),text='Synthetic private chat that is not a formal command';const reply=await e.send(f.a,text),receipt=f.store.receipt(reply.event.msgId);assert.equal(reply.result.status,'invalid');assert.ok(!receipt.command_json.includes(text));assert.equal(receipt.command.kind,'invalid-command');assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);
});
test('negative plan decision records its required reason and creates no tasks or replacement work',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account),e=entry(f);assert.equal((await e.send(f.a,'拒绝 '+ref.code+' 缺少已保存依据')).result.status,'applied');const slot=f.services.plans.get(f.plan.plan.id).slots.find(row=>row.role==='product');assert.equal(slot.outcome,'reject');assert.equal(slot.reason,'缺少已保存依据');assert.equal(f.services.tasks.countByProject(f.project.id),0);assert.equal(f.services.plans.listByProject(f.project.id).length,1);
});
test('return and complete operate only the own saved result, never open downstream slots; rejection creates no replacement work',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream}=f.activate(),e=entry(f);let opens=0;const original=f.services.results.openAcceptances.bind(f.services.results);f.services.results.openAcceptances=(...args)=>{opens++;return original(...args);};
  f.submit(upstream,f.b,'Saved v1');let ref=own(f,'result_review',f.b.account);assert.equal((await e.send(f.b,'退回 '+ref.code+' 自检不充分')).result.status,'applied');assert.equal(f.services.tasks.get(upstream.task.id).task.completedAt,null);
  const result=f.submit(upstream,f.b,'Saved corrected v2');ref=own(f,'result_review',f.b.account);assert.equal((await e.send(f.b,'完成 '+ref.code)).result.status,'applied');assert.ok(f.services.tasks.get(upstream.task.id).task.completedAt);assert.equal(opens,0);assert.equal(f.security.db.prepare('SELECT COUNT(*) AS n FROM acceptances').get().n,0);
  f.services.results.openAcceptances(result.resultId,result.version);assert.equal(opens,1);ref=own(f,'result_acceptance',f.a.account);assert.equal((await e.send(f.a,'拒收 '+ref.code+' 不满足下游标准')).result.status,'applied');assert.equal(f.services.results.acceptancesOf(result.resultId,result.version)[0].outcome,'reject');assert.equal(f.services.tasks.countByProject(f.project.id),2);assert.equal(f.services.plans.listByProject(f.project.id).length,1);
});
test('explicit downstream acceptance enables a later own result completion; saved facts remain readable through original services',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream,downstream}=f.activate(),result=completeUpstream(f,upstream),e=entry(f);f.services.results.openAcceptances(result.resultId,result.version);const acceptance=own(f,'result_acceptance',f.a.account);assert.equal((await e.send(f.a,'接受 '+acceptance.code)).result.status,'applied');assert.equal(f.services.results.acceptancesByTask(downstream.task.id)[0].acceptedTaskVersion,1);
  f.submit(downstream,f.a);const review=own(f,'result_review',f.a.account);assert.equal((await e.send(f.a,'完成 '+review.code)).result.status,'applied');assert.ok(f.services.tasks.get(downstream.task.id).task.completedAt);assert.equal(f.projection.candidates().length,0);
});
test('specialized decisions never open the generic private-IM model/tool write channel',{timeout:12000},async t=>{
  const f=await robotFixture(t),e=entry(f),principal={channel:'im-private',account:f.a.account,projectId:f.project.id,memberRevision:f.a.revision,epoch:f.security.epoch};
  for(const tool of ['plan_confirm','result_review','result_accept','result_acceptance_open','analysis_submit','plan_register','result_submit'])assert.equal(f.access.allows(principal,tool),false);
  const ref=own(f,'plan_confirmation',f.a.account);assert.equal((await e.send(f.a,'同意 '+ref.code)).result.status,'applied');assert.equal(f.access.allows(principal,'plan_confirm'),false);
});
test('logging out one DSH device is not a global revocation of the same trusted native robot sender',{timeout:12000},async t=>{
  const f=await robotFixture(t),e=entry(f),ref=own(f,'plan_confirmation',f.a.account),epoch=f.security.epoch;f.security.revokeLogin(f.devices.a.loginId);
  assert.equal((await e.send(f.a,'同意 '+ref.code)).result.status,'applied');assert.equal(f.security.member(f.a.account).revision,f.a.revision);assert.equal(f.security.epoch,epoch);assert.equal(f.security.db.prepare('SELECT revoked FROM collaboration_logins WHERE id=?').get(f.devices.b.loginId).revoked,0);
});
test('an entry guard must return literal true, never a truthy string, number, object or Promise',{timeout:12000},async t=>{
  const f=await robotFixture(t),ref=own(f,'plan_confirmation',f.a.account);
  for(const value of ['true',1,{},Promise.resolve(true),Promise.reject(new Error('synthetic rejected guard'))]){const e=entry(f,()=>value),source=e.event(f.a,'同意 '+ref.code);const accepted=e.executor.accept(source);if(accepted.work)await accepted.work;assert.equal(accepted.ignored,true);assert.equal(f.store.receipt(source.msgId),null);}
  assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);
});
test('bounded-overload receipts are terminal without a queued decision or historical automatic replay',{timeout:12000},async t=>{
  const f=await robotFixture(t),e=entry(f),ref=own(f,'plan_confirmation',f.a.account),source=e.event(f.a,'同意 '+ref.code),accepted=e.executor.accept(source,{overloaded:true});
  assert.equal(accepted.ack,true);assert.equal(accepted.work,null);assert.equal(f.store.receipt(source.msgId).status,'failed');assert.equal(f.store.receipt(source.msgId).result.kind,'entry-busy-reply-again');assert.equal(e.executor.accept(source).duplicate,true);assert.equal(f.services.plans.get(f.plan.plan.id).slots.every(row=>row.outcome===null),true);assert.equal((await e.send(f.a,'同意 '+ref.code)).result.status,'applied');
});
test('missing accepted input refuses completion; resolving the prerequisite permits only a new explicit message, not replay of the old one',{timeout:12000},async t=>{
  const f=await robotFixture(t),{upstream,downstream}=f.activate(),result=completeUpstream(f,upstream),e=entry(f);f.services.results.openAcceptances(result.resultId,result.version);f.submit(downstream,f.a);const ref=own(f,'result_review',f.a.account),first=await e.send(f.a,'完成 '+ref.code);assert.equal(first.result.status,'failed');assert.equal(f.services.tasks.get(downstream.task.id).task.completedAt,null);
  f.services.results.decide({resultId:result.resultId,version:result.version,taskId:downstream.task.id,outcome:'accept',submittedBy:f.a.account,declaredMember:f.a.account});assert.equal(e.executor.accept(first.event).duplicate,true);assert.equal(f.services.tasks.get(downstream.task.id).task.completedAt,null);assert.equal((await e.send(f.a,'完成 '+ref.code)).result.status,'applied');assert.ok(f.services.tasks.get(downstream.task.id).task.completedAt);
});
