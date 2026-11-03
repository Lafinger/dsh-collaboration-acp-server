import test from 'node:test';
import assert from 'node:assert/strict';
import {robotFixture} from './helpers/robot.mjs';

test('organization revocation fences old robot code and all task-owner tool commits after re-login until explicit role reassignment',async t=>{
 const f=await robotFixture(t),{upstream}=f.activate(),item=f.projection.candidates().find(v=>v.binding.kind==='task_assignment'&&v.account===f.b.account);
 const reference=f.store.reference(item.account,item.binding);
 f.security.invalidateOrganization(f.b.account,f.security.member(f.b.account).revision);
 assert.equal(f.projection.candidates().some(v=>v.account===f.b.account),false);
 assert.throws(()=>f.projection.validate(reference));
 f.security.enroll(f.official('b'));const login=f.security.issueLogin(f.b.account,'new-device');
 const principal={account:f.b.account,projectId:f.project.id,channel:'dsh',memberRevision:f.security.member(f.b.account).revision,epoch:f.security.epoch,login};
 assert.equal(f.security.profile(f.b.account).assignable,true);
 assert.throws(()=>f.access.validateInput('result_submit',{task_id:upstream.task.id,summary:'new',files:[]},principal));
 assert.throws(()=>f.access.validateInput('progress_add',{task_id:upstream.task.id,note:'new'},principal));
 assert.equal(f.projection.candidates().some(v=>v.account===f.b.account),false);
 await f.assignRole('frontend',f.b.account);
 assert.doesNotThrow(()=>f.access.validateInput('result_submit',{task_id:upstream.task.id,summary:'new',files:[]},principal));
 assert.equal(f.projection.candidates().some(v=>v.account===f.b.account),true);
 assert.throws(()=>f.projection.validate(reference),'old member/role fingerprint never resumes');
});

test('real result-review and peer plan shortcodes never revive through official re-login and same-account acknowledgement',async t=>{
 const f=await robotFixture(t),planItem=f.projection.candidates().find(v=>v.account===f.a.account),planRef=f.store.reference(planItem.account,planItem.binding);
 const {upstream}=f.activate(),result=f.submit(upstream,f.b),reviewItem=f.projection.candidates().find(v=>v.binding.kind==='result_review'&&v.binding.objectId===result.resultId),reviewRef=f.store.reference(reviewItem.account,reviewItem.binding);
 f.security.invalidateOrganization(f.b.account,f.security.member(f.b.account).revision);
 assert.throws(()=>f.projection.validate(reviewRef));assert.throws(()=>f.projection.validate(planRef));
 f.security.enroll(f.official('b'));
 assert.throws(()=>f.projection.validate(reviewRef));assert.throws(()=>f.projection.validate(planRef));
 await f.assignRole('frontend',f.b.account);
 assert.throws(()=>f.projection.validate(reviewRef));assert.throws(()=>f.projection.validate(planRef));
 const current=f.projection.candidates().find(v=>v.binding.kind==='result_review'&&v.binding.objectId===result.resultId);
 assert.ok(current);assert.notEqual(f.store.reference(current.account,current.binding).code,reviewRef.code);
});

test('mere trusted name change preserves saved decision binding and does not replay accepted notices',async t=>{
 const f=await robotFixture(t),item=f.projection.candidates().find(v=>v.account===f.b.account),before=f.projection.describe(item.binding,f.b.account);
 f.setVerifier(async m=>({...f.official(m.user_id),name:'Updated official display'}));
 await f.login.refresh(f.b.account,{force:true});
 const after=f.projection.describe(item.binding,f.b.account);
 assert.deepEqual(after.binding,before.binding);assert.equal(f.security.profile(f.b.account).name,'Updated official display');
});
