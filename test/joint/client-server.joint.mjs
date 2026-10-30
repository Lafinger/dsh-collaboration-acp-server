import { initializeParams, collaborationMeta } from '../../src/protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,mkdirSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { LlmAdapter,ToolCallId } from '@deepseek-ai/dsh-llm';
import { createTestCollaboration as createCollaborationRuntime } from '../helpers/host.mjs';
import { AccessStore } from '../../src/store.mjs';
import { AccountAuthority,issueTicket } from '../../src/authority.mjs';
import { AccessService } from '../../src/service.mjs';
import { listenAccess,connectAccess } from '../../src/transport.mjs';
import { createUserMessage,BlockAssembler } from '@deepseek-ai/dsh-llm';
const clientRoot=process.env.DSH_COLLABORATION_CLIENT_ROOT;
if(!clientRoot)throw new Error('Joint check only: set DSH_COLLABORATION_CLIENT_ROOT to the other repository');
const {MemberClient}=await import(pathToFileURL(resolve(clientRoot,'src/member-client.mjs')).href);
const {MemberAdapter}=await import(pathToFileURL(resolve(clientRoot,'src/member-plugin.mjs')).href);
const {AttachmentAuthorization}=await import(pathToFileURL(resolve(clientRoot,'src/attachments.mjs')).href);
const wire=name=>readFileSync(new URL('../..'+name,import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const clientWire=name=>readFileSync(join(clientRoot,name),'utf8').replace(/\r\n/gu,'\n');
test('versioned contract and wire helpers are identical across independently owned repositories',()=>{
 assert.equal(wire('/docs/PROTOCOL-v4.json'),clientWire('docs/PROTOCOL-v4.json'));
 assert.equal(wire('/src/protocol.mjs'),clientWire('src/protocol.mjs'));
 assert.equal(wire('/src/attachment-protocol.mjs'),clientWire('src/attachment-protocol.mjs'));
});
test('independent client adapter converses with real server runtime; no history replay on followup',async()=>{
 const root=mkdtempSync(join(tmpdir(),'collaboration-joint-'));const collaboration=await createCollaborationRuntime({workspace:join(root,'workspace'),stateRoot:join(root,'state'),fixture:true});const {runtime,workspace}=collaboration;
 const store=new AccessStore(join(root,'access.sqlite'));const secret='a'.repeat(64);
 const service=new AccessService({runtime,store,cwd:workspace,authority:new AccountAuthority({serviceId:'joint',accounts:{alice:secret}})});const listener=await listenAccess(service);
 const client=new MemberClient({databasePath:join(root,'client.sqlite'),account:'alice',serviceId:'joint',attachments:new AttachmentAuthorization(),connect:async()=>{const peer=await connectAccess(listener.address);await peer.request('collaboration/connect',{ _meta: collaborationMeta(), ticket:issueTicket({serviceId:'joint',account:'alice',secret})});return peer;}});
 const adapter=new MemberAdapter(client);const messages=[];
 try{const project=collaboration.services.projects.create({key:'JOINT',name:'联测项目'});client.selectProject('local',project.id);
  for(const text of ['first','second']){messages.push(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));const assembled=new BlockAssembler();for await(const chunk of adapter.stream({provider:'collaboration-remote',model:'server-agent',sessionId:'local',messages}))assembled.push(chunk);assert.equal(assembled.blocks()[0].text,`fixture:${text}`);assert.equal(assembled.finish.kind,'stop');}
 const remote=client.mapping('local').remote_id;assert.deepEqual(store.events(remote).filter(e=>e.update.sessionUpdate==='user_message_chunk').map(e=>e.update.content.text),['first','second']);
 await client.peer.request('session/close',{sessionId:remote});client.disconnect();await client.open('local');assert.equal(client.mapping('local').remote_id,remote);assert.equal(store.events(remote).filter(e=>e.update.sessionUpdate==='user_message_chunk').length,2);
 }finally{client.close();await listener.close();store.close();}
});
// L2: the real stuck-session phrasing, end to end through the real client capture path and the real
// server runtime. Turn 1 archives the @-selected requirement and the model still cannot self-register
// a plan; turn 2 reads the SAME handle from the session-persisted inventory (no new manifest) and an
// explicit 提交方案 phrase authorizes plan_register.
function* jointTool(name,args){const id=ToolCallId(randomUUID()),block={type:'tool-call',id,name,arguments:JSON.stringify(args)};yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name,argumentsDelta:block.arguments};yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'tool-calls'}};}
function* jointText(value){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:value};yield{type:'block-end',index:0,block:{type:'text',text:value}};yield{type:'finish',reason:{kind:'stop'}};}
test('stuck-session phrasing: @需求文档 archives on turn one, inventory persists to turn two, explicit phrase registers the plan',async()=>{
 const root=mkdtempSync(join(tmpdir(),'collaboration-joint-l2-'));
 const requirement='需求：双人协作测试。成员各自上传需求文档，模型读取并归档，再登记正式计划。仅用于离线联测。';
 mkdirSync(join(root,'workspace'),{recursive:true});
 const requirementPath=join(root,'workspace','南航数字人POC-双人协作测试需求-v2.md');writeFileSync(requirementPath,requirement,'utf8');
 let phase=0;const seen=[];
 class JointModel extends LlmAdapter{archive=null;planAttempt=null;projectId=null;
  async*stream(options){
  const last=options.messages.at(-1);const result=last?.role==='tool'?last:last?.content.find(b=>b.type==='tool-result');
  if(!result){const humanText=[...options.messages].reverse().find(m=>m.role==='user').content.filter(b=>b.type==='text').map(b=>b.text).join('');const handle=humanText.match(/handle=([a-f0-9]{64})/u)?.[1];assert.ok(handle,'session inventory names the attachment handle in the human message');yield*jointTool('attachment_read',{handle});return;}
  const call=options.messages.flatMap(m=>m.content).find(b=>b.type==='tool-call'&&b.id===result.toolCallId);
  const raw=result.content.filter(b=>b.type==='text').map(b=>b.text).join('');
  if(call?.name==='plan_register'){const refused=result.isError===true;this.planAttempt=refused?raw:JSON.parse(raw);yield*jointText(refused?'计划登记被拒绝，需要明确提交方案。':'需求已归档，方案已登记。');return;}
  const value=JSON.parse(raw);
  if(call?.name==='attachment_read'){assert.equal(value.ok,true,'second-turn read must work from the session-persisted inventory');seen.push(value.handle);yield*jointTool('attachment_archive',{handle:value.handle,purpose:'双人协作测试需求'});return;}
  if(call?.name==='attachment_archive'){assert.equal(value.ok,true);this.archive=value;yield*jointTool('plan_register',{project_id:this.projectId,title:'双人协作测试正式计划',roles_reason:'需求文档要求生成正式计划',relevant_roles:['product'],tasks:[{ref:'t1',role:'product',change:'add',content:'完成双人协作测试',depends_on:[]}],undecided:[]});return;}
  throw new Error('unexpected tool call '+call?.name);
 }}
 const model=new JointModel();
 const collaboration=await createCollaborationRuntime({workspace:join(root,'workspace'),stateRoot:join(root,'state'),adapter:model});const {runtime,workspace}=collaboration;
 const store=new AccessStore(join(root,'access.sqlite'));const secret='a'.repeat(64);
 const service=new AccessService({runtime,store,cwd:workspace,authority:new AccountAuthority({serviceId:'joint',accounts:{alice:secret}})});const listener=await listenAccess(service);
 const client=new MemberClient({databasePath:join(root,'client.sqlite'),account:'alice',serviceId:'joint',attachments:new AttachmentAuthorization(),connect:async()=>{const peer=await connectAccess(listener.address);await peer.request('collaboration/connect',{ _meta: collaborationMeta(), ticket:issueTicket({serviceId:'joint',account:'alice',secret})});return peer;}});
 const {admitHumanTurn}=await import(pathToFileURL(resolve(clientRoot,'src/human-admission.mjs')).href);
 try{
  const project=collaboration.services.projects.create({key:'JOINT-L2',name:'双人协作联测'});client.selectProject('local',project.id);model.projectId=project.id;
  const runTurn=async(messageId,text)=>{
   const message=createUserMessage({content:[{type:'text',text}],source:{kind:'user'},id:messageId});
   const admitted=await admitHumanTurn({client,options:{sessionId:'local'},message});
   const entry=await client.attachments.capture({localId:'local',message,workspace,admission:admitted.admission});
   return client.prompt('local',{messageId:String(message.id),text,attachmentEntry:entry,onUpdate(){}});
  };
  const first=await runTurn('m1',`@${requirementPath} 这是项目的需求文档，你需要分析、上传、归档、并生成正式计划。`);
  assert.equal(first.stopReason,'end_turn');
  assert.ok(model.archive.material_id,'turn-one archive committed a material');
  const versions=()=>collaboration.services.materials.listByProject(project.id)[0].versions;
  assert.equal(versions().length,1);
  assert.match(JSON.stringify(model.planAttempt),/当前人类消息未授权/u,'model cannot self-register a plan without the explicit phrase');
  const second=await runTurn('m2','归档该需求文档并推进项目；请提交方案。');
  assert.equal(second.stopReason,'end_turn');
  assert.equal(versions().length,1,'identical bytes deduplicate: no new version');
  assert.equal(model.archive.deduplicated,true);
  const plans=collaboration.services.plans.listByProject(project.id);
  assert.equal(plans.length,1,'planAttempt='+JSON.stringify(model.planAttempt)?.slice(0,300));assert.equal(plans[0].plan.title,'双人协作测试正式计划');
 }finally{client.close();await listener.close();store.close();}
});
