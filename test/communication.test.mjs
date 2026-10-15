import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {PlanService} from '../business/lib/service/plan-service.js';
import {NoticeService} from '../business/lib/service/notice-service.js';
import {IdentityStore} from '../src/identity-store.mjs';
import {ProjectAccess} from '../src/project-access.mjs';
import {CommunicationBridge} from '../src/communication-bridge.mjs';
import {CommunicationStore} from '../src/communication-store.mjs';

const descriptor={contractVersion:1,channel:'dingtalk',mode:'collaboration-only',botId:'bot',corpId:'corp',clientId:'app',robotCode:'code',defaultHarness:false,sessionSync:false};
function fixture(t){
  let time=1000000;const db=openDatabase({path:':memory:'});
  const identities=new IdentityStore({db,serviceId:'s',corpId:'corp',clientId:'app',now:()=>time});
  const projects=new ProjectService(db),project=projects.create({key:'A',name:'A'}),services={projects,plans:new PlanService(db),notices:new NoticeService(db)};
  for(const account of ['alice','bob','charlie']){identities.bind({account,userId:account,unionId:account});identities.markVerified(account,{corpId:'corp',userId:account,unionId:account,internal:true});identities.participate(project.id,account,true);}
  projects.setMember(project.id,'product','alice');const access=new ProjectAccess({identities,services});
  const login={refresh:async account=>{identities.requireMember(account);}};
  const bridge=new CommunicationBridge({identities,login,access,services,runtime:{},workspace:'fixture',now:()=>time});
  const target=(id,kind,account,route)=>bridge.store.manageTarget({id,projectId:project.id,kind,account,route,...descriptor,publicEnabled:kind==='group'});
  target('alice-private','private','alice',{userId:'alice'});target('bob-private','private','bob',{userId:'bob'});target('project-group','group',null,{openConversationId:'group',groupKind:'template'});
  const sent=[];let group=['alice','bob'];
  const binding={descriptor,sendPart:async(route,body,options)=>{options.beforeSend?.();sent.push({route,body});return {accepted:true,providerQueryKey:'platform-accepted-only'};},groupMembers:async()=>({complete:true,memberUserIds:group})};
  const lease=bridge.attach(binding);
  t.after(async()=>{await bridge.close();db.close();});
  return {db,identities,project,services,bridge,lease,sent,binding,setGroup:ids=>{group=ids;},setTime:t=>{time=t;},event:(messageId,text,sender='alice',conversationType='private')=>({messageId,transportId:messageId,createdAt:time,senderUserId:sender,conversationId:conversationType==='private'?'private-conversation':'group',conversationType,text})};
}

test('durable inbox deduplicates requests and related replies, sender attribution never creates formal agreement',async t=>{
  const f=fixture(t);const event=f.event('one','/项目 A /请求 bob-private private 请澄清');
  assert.equal(f.lease.accept(event).durable,true);assert.equal(f.lease.accept(event).duplicate,true);
  await f.bridge.schedule();assert.equal(f.db.prepare('SELECT count(*) n FROM collaboration_requests').get().n,1);
  const request=f.db.prepare('SELECT * FROM collaboration_requests').get();assert.equal(request.sender,'alice');assert.equal(request.recipient,'bob');assert.equal(request.visibility,'private');
  assert.ok(f.sent.some(s=>s.route.userId==='bob'&&s.body.includes(request.id)));
  f.lease.accept(f.event('two',`/项目 A /答复 ${request.id} 同意（通信文本）`,'bob'));await f.bridge.schedule();
  assert.equal(f.db.prepare('SELECT count(*) n FROM collaboration_replies').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM confirmations').get().n,0);
  assert.throws(()=>f.bridge.store.history('charlie',f.project.id,request.id));
  const history=f.bridge.store.history('alice',f.project.id,request.id);assert.equal(history.requests[0].replies[0].sender,'bob');
});

test('group recipient authorization rechecked before send, failed or unknown membership never exposes private/project content',async t=>{
  const f=fixture(t);f.setGroup(['alice','external']);
  const result=f.bridge.store.create({account:'alice',projectId:f.project.id,targetId:'project-group',visibility:'public',body:'protected public clarification',sourceId:'one'});
  await f.bridge.dispatch();assert.equal(f.sent.length,0);assert.equal(f.db.prepare('SELECT status FROM collaboration_outbox WHERE id=?').get(result.outboxId).status,'suppressed');
  f.setGroup(['alice','bob']);f.lease.accept(f.event('group-query','/待办','alice','group'));await f.bridge.schedule();
  assert.ok(f.sent.every(s=>!s.body.includes('product')));assert.ok(f.sent.some(s=>s.body.includes('请私聊')));
});

test('unknown and partial sends retain per-part status and are never blindly replayed; crash interrupted inbox remains unknown',async t=>{
  const f=fixture(t);let sends=0;
  f.binding.sendPart=async()=>{if(++sends===1)return {accepted:true};throw Object.assign(new Error('timeout'),{code:'send-result-unknown'});};
  const result=f.bridge.store.create({account:'alice',projectId:f.project.id,targetId:'bob-private',visibility:'private',body:'x'.repeat(1900),sourceId:'split'});
  await f.bridge.dispatch();assert.equal(f.db.prepare('SELECT status FROM collaboration_outbox WHERE id=?').get(result.outboxId).status,'partial');const before=sends;
  await f.bridge.dispatch();assert.equal(sends,before);
  f.lease.accept(f.event('interrupted','/项目 A /待办'));f.db.prepare("UPDATE collaboration_inbox SET status='processing' WHERE message_id='interrupted'").run();
  new CommunicationStore({identities:f.identities,now:()=>1000000});assert.equal(f.db.prepare("SELECT status FROM collaboration_inbox WHERE message_id='interrupted'").get().status,'unknown');
});

test('recipient revocation after platform token I/O suppresses send before side effect, no unknown replay',async t=>{
  const f=fixture(t);f.binding.sendPart=async(_target,_body,options)=>{f.identities.participate(f.project.id,'bob',false);options.beforeSend();assert.fail('must not send');};
  const r=f.bridge.store.create({account:'alice',projectId:f.project.id,targetId:'bob-private',visibility:'private',body:'do not leak',sourceId:'pre-send-race'});
  await f.bridge.dispatch();assert.equal(f.db.prepare('SELECT status FROM collaboration_outbox WHERE id=?').get(r.outboxId).status,'suppressed');assert.equal(f.sent.length,0);
});

test('reply destination is pinned to original request and target revision; changed or ambiguous routes do not silently substitute recipients',async t=>{
  const f=fixture(t),r=f.bridge.store.create({account:'alice',projectId:f.project.id,targetId:'bob-private',visibility:'private',body:'question',sourceId:'pinned'});
  f.bridge.store.manageTarget({id:'alice-private',projectId:f.project.id,kind:'private',account:'alice',route:{userId:'alice'},...descriptor});
  const reply=f.bridge.store.reply({account:'bob',projectId:f.project.id,requestId:r.requestId,body:'answer',sourceId:'pinned-reply'});
  assert.equal(reply.status,'recorded-not-sent');assert.equal(reply.outboxId,null);
  f.bridge.store.manageTarget({id:'alice-alternative',projectId:f.project.id,kind:'private',account:'alice',route:{userId:'alice'},...descriptor});
  assert.equal(f.bridge.ownPrivateTarget('alice',f.project.id),null);
  assert.throws(()=>f.bridge.store.create({account:'alice',projectId:f.project.id,targetId:'bob-private',visibility:'private',body:'changed payload',sourceId:'pinned'}));
});

test('target revision changed during asynchronous query cannot rebind the output to a fresh route',async t=>{
  const f=fixture(t);f.bridge.queryModel=async()=>{f.bridge.store.manageTarget({id:'alice-private',projectId:f.project.id,kind:'private',account:'alice',route:{userId:'alice'},...descriptor});return 'must not send';};
  f.lease.accept(f.event('race','/项目 A current query'));await f.bridge.schedule();
  assert.equal(f.sent.length,0);assert.equal(f.db.prepare("SELECT status FROM collaboration_inbox WHERE message_id='race'").get().status,'rejected');
  assert.equal(f.db.prepare('SELECT count(*) n FROM collaboration_outbox').get().n,0);
});

test('subscription payloads with stored cross-project object references are blocked even if a derived notice is addressed to this member',async t=>{
  const f=fixture(t),other=f.services.projects.create({key:'B',name:'Other'});
  const p=f.services.plans.register({projectId:other.id,title:'Cross-project private title',tasks:[],relevantRoles:['product'],rolesReason:'fixture',undecided:[]});
  f.services.notices.todos=()=>[{kind:'plan_confirmation',objectId:p.plan.id,role:'product',member:'alice',version:1,summary:'Cross-project private title'}];
  f.bridge.store.subscribe({id:'reminders',projectId:f.project.id,account:'alice',targetId:'alice-private',kinds:['todo'],enabled:true});
  await f.bridge.deriveSubscriptions();assert.equal(f.db.prepare('SELECT count(*) n FROM collaboration_outbox').get().n,0);
  assert.throws(()=>f.bridge.query('/待办',{account:'alice',projectId:f.project.id,channel:'im-private'}));
});

test('target changes, member revocation, test epoch tombstones, and explicit expired body cleanup stop future access without deleting facts',async t=>{
  const f=fixture(t);const result=f.bridge.store.create({account:'alice',projectId:f.project.id,targetId:'bob-private',visibility:'private',body:'retained metadata',sourceId:'old'});
  f.identities.participate(f.project.id,'bob',false);await f.bridge.dispatch();assert.equal(f.sent.length,0);
  f.lease.accept(f.event('late','/项目 A /待办'));f.identities.revokeAllDevices();f.setTime(1000010);
  f.identities.markVerified('alice',{corpId:'corp',userId:'alice',unionId:'alice',internal:true});
  const old=f.lease.accept(f.event('late','/项目 A /待办'));assert.equal(old.oldEpoch,true);
  const row=f.event('new-late','/项目 A /待办');row.createdAt=999999;assert.equal(f.lease.accept(row).status,'rejected');
  f.setTime(1000000+91*86400000);const purge=f.bridge.store.purge({confirmation:'PURGE_EXPIRED_COMMUNICATION_BODIES'});
  assert.equal(purge.formalDataDeleted,false);assert.equal(f.db.prepare('SELECT body FROM collaboration_requests WHERE id=?').get(result.requestId).body,null);assert.equal(f.db.prepare('SELECT count(*) n FROM projects').get().n,1);
});
