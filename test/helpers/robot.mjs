// OFFLINE ONLY: original runtime factory, real QR store/SQLite/services and official Host.
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createTestCollaboration} from './host.mjs';
import {RobotStore} from '../../src/robot-store.mjs';
import {RobotProjection} from '../../src/robot-projection.mjs';
import {MvpAccessService} from '../../src/mvp-service.mjs';
class NoRobotModel extends LlmAdapter{calls=0;async *stream(){this.calls++;throw new Error('Robot must never call the model');}}
export async function robotFixture(t,{adapter=new NoRobotModel()}={}){
  const root=mkdtempSync(join(tmpdir(),'robot-offline-')),f=await createTestCollaboration({mode:'mvp-qr',serviceId:'offline-robot-authority',workspace:join(root,'workspace'),stateRoot:join(root,'state'),adapter,dingtalk:{corpId:'synthetic-corp',clientId:'synthetic-original-identity-app',clientSecret:'synthetic-unused-identity-secret',administratorUserId:'a',publicOrigin:'https://offline.example'}});let admin;
  t.after(async()=>{try{if(adapter instanceof NoRobotModel)assert.equal(adapter.calls,0);await admin?.close();}finally{await f.runtime.closeAll();}});
  let now=1800000000000;f.security.now=()=>now;f.login.now=()=>now;
  const official=userId=>({corpId:'synthetic-corp',userId,unionId:'synthetic-union-'+userId,internal:true,name:'Offline '+userId}),a=f.security.enroll(official('a')),b=f.security.enroll(official('b'));
  const project=f.services.projects.create({key:'FIXTURE',name:'Synthetic robot two-person project'});f.services.projects.setMember(project.id,'product',a.account);f.services.projects.setMember(project.id,'frontend',b.account);
  const file=join(f.workspace,'synthetic.txt');writeFileSync(file,'SYNTHETIC saved evidence only');const material=f.services.materials.upload({projectId:project.id,sourcePath:file,purpose:'synthetic fixture',submittedBy:a.account});
  const analysis=f.services.analyses.submit({projectId:project.id,trigger:'offline fixture',scope:[{materialId:material.material.id,version:1}],requirements:[{text:'Produce and independently accept a synthetic receipt',sources:[{materialId:material.material.id,version:1}]}],undecided:[],inferences:[],notUnderstood:[],basisMissing:[]});
  const draft={title:'Synthetic two-person plan',relevantRoles:['product','frontend'],rolesReason:'frontend produces and product accepts',tasks:[{ref:'produce',role:'frontend',change:'add',content:'Produce a saved synthetic receipt',requiredResults:'One synthetic receipt',completionCriteria:'Independent product acceptance',dependsOn:[]},{ref:'consume',role:'product',change:'add',content:'Independently verify the saved receipt',requiredResults:'A saved independent conclusion',completionCriteria:'Explicitly accept the input',dependsOn:['produce']}],undecided:[]};
  const plan=f.services.plans.register({projectId:project.id,...draft,sourceAnalysisId:analysis.id}),devices={a:f.security.issueLogin(a.account,'synthetic-device-a'),b:f.security.issueLogin(b.account,'synthetic-device-b')};
  const contacts=[];let verifier=async member=>official(member.user_id);f.login.provider.verifyMember=async member=>{assert.equal(f.security.db.isTransaction,false,'Network qualification must be outside the SQLite write transaction');contacts.push(member.user_id);return verifier(member);};
  const store=new RobotStore({security:f.security,scopeKey:'synthetic-two-application-scope'}),projection=new RobotProjection({security:f.security,services:f.services,pilotAccounts:[a.account,b.account]});
  admin=new MvpAccessService({runtime:f.runtime,cwd:f.workspace,login:f.login,identities:f.security,projects:f.services.projects});
  const assignRole=(role,account)=>admin.manage(a.account,{action:'role',commandId:randomUUID(),projectId:project.id,role,account,revision:admin.roleRevision(project.id)},()=>f.security.requireLogin(devices.a));
  const confirm=(actor,role,planId=plan.plan.id)=>f.services.plans.confirm({planId,role,outcome:'agree',submittedBy:actor.account,declaredMember:actor.account});
  const activate=()=>{confirm(a,'product');confirm(b,'frontend');const outcomes=f.services.tasks.outcomesOf(plan.plan.id,1);return {upstream:f.services.tasks.get(outcomes.find(row=>row.ref==='produce').taskId),downstream:f.services.tasks.get(outcomes.find(row=>row.ref==='consume').taskId)};};
  const submit=(task,actor,summary='Synthetic result')=>f.services.results.submit({taskId:task.task.id,summary,selfCheck:'Synthetic self-check',files:[],submittedBy:actor.account});
  return {...f,adapter,store,projection,a,b,project,material,analysis,draft,plan,devices,official,contacts,assignRole,confirm,activate,submit,now:()=>now,advance:ms=>{now+=ms;},setVerifier:fn=>{verifier=fn;}};
}
