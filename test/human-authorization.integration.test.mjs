import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareHumanRequest,deriveHumanPolicy} from '../src/human-authorization.mjs';
import {LlmAdapter,ToolCallId} from '@deepseek-ai/dsh-llm';
import {createTestCollaboration} from './helpers/host.mjs';
import {AccessStore} from '../src/store.mjs';
import {AccessService} from '../src/service.mjs';
import {initializeParams} from '../src/protocol.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function* text(value){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:value};yield{type:'block-end',index:0,block:{type:'text',text:value}};yield{type:'finish',reason:{kind:'stop'}};}
function* call(name,args){const id=ToolCallId(randomUUID());yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)};yield{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}};}
class Probe extends LlmAdapter{
 constructor(toolName){super();this.toolName=toolName;this.calls=0;this.visible=[];this.result=null;}
 async* stream(options){assert.ok(++this.calls<5,'bounded fake model');if(this.calls===1){this.visible=options.tools.map(t=>t.name);this.humanText=[...options.messages].reverse().find(m=>m.role==='user').content.filter(b=>b.type==='text').map(b=>b.text).join('');if(this.toolName){yield*call(this.toolName,this.args??{project_id:this.projectId,plan_id:'nonexistent',role:'product'});return;}}else{const last=options.messages.at(-1);this.result=last?.role==='tool'?last:last?.content.find(b=>b.type==='tool-result');}yield*text('已整理为对话草稿，未提交方案。');}
}
async function fixture(toolName){
 const root=mkdtempSync(join(tmpdir(),'human-auth-')),model=new Probe(toolName);
 const collaboration=await createTestCollaboration({workspace:join(root,'workspace'),stateRoot:join(root,'state'),adapter:model});
 const project=collaboration.services.projects.create({key:'HUMAN-'+randomUUID().slice(0,8),name:'自然语言验收项目'});model.projectId=project.id;
 const store=new AccessStore(join(root,'access.sqlite')),service=new AccessService({authority:{},store,runtime:collaboration.runtime,cwd:collaboration.workspace,projects:collaboration.services.projects});
 const c={identity:{account:'alice',serviceId:'fixture'},initialized:false,closed:false,peer:{closed:false,notify(){},request(){throw new Error('No reverse transfer in guard fixture');}}};
 const params=initializeParams();params.clientCapabilities={attachmentTransfer:{version:2},humanAuthorization:{version:3}};
 const initialized=await service.dispatch(c,'initialize',params);
 const {sessionId}=await service.dispatch(c,'session/new',{projectId:project.id});
 return {model,collaboration,project,store,service,c,sessionId,initialized,close:async()=>{await service.close();store.close();}};
}
function meta(f,text,extra={}){return{requestId:randomUUID(),humanAuthorization:{version:3,messageId:randomUUID(),textSha256:hash(text),projectId:f.project.id,...extra}};}
test('v3 capability is negotiated with collaboration 4 and attachmentTransfer 2',async()=>{const f=await fixture();try{assert.equal(f.initialized._meta.collaborationProtocolVersion,4);assert.deepEqual(f.initialized.agentCapabilities.attachmentTransfer,{version:2});assert.deepEqual(f.initialized.agentCapabilities.humanAuthorization,{version:3});}finally{await f.close();}});
test('every prompt requires current-human metadata before request begin or runtime',async()=>{const f=await fixture();try{await assert.rejects(f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:'帮我做个方案'}],_meta:{requestId:'missing-human'}}));assert.equal(f.store.status(f.sessionId),null);assert.equal(f.model.calls,0);}finally{await f.close();}});
test('original UTF8 prompt digest mismatch is rejected before runtime',async()=>{const f=await fixture();try{await assert.rejects(f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:'帮我做个方案'}],_meta:meta(f,'不同的原始消息')}));assert.equal(f.store.status(f.sessionId),null);assert.equal(f.model.calls,0);}finally{await f.close();}});
for(const command of ['帮我推进项目，做个方案','修订一下方案，先给我看看'])test('real runtime draft guard advertises writes and blocks the call: '+command,async()=>{const f=await fixture('analysis_submit');try{const result=await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:meta(f,command)});assert.equal(result.stopReason,'end_turn');for(const name of ['analysis_submit','plan_register','plan_revise','result_submit','progress_add','project_update_details','todo_mark_read','result_acceptance_open'])assert.ok(f.model.visible.includes(name),'draft still advertises '+name);for(const name of ['plan_confirm','result_review','result_accept'])assert.ok(!f.model.visible.includes(name),'draft must hide '+name);assert.equal(f.model.result?.isError,true,'hallucinated tool call must be blocked by real runtime guard');assert.match(JSON.stringify(f.model.result),/当前人类消息未授权/u);assert.equal(f.collaboration.attachments.db.prepare('SELECT COUNT(*) n FROM analyses').get().n,0);}finally{await f.close();}});
for(const command of ['请查询提交方案状态','请检查是否已经提交方案','请解释如何提交方案','请勿提交方案','请取消提交方案','请等我确认后再提交方案','提交方案了吗'])test('real guard refuses informational/negative/deferred submission: '+command,async()=>{const f=await fixture('plan_register');try{await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:meta(f,command)});assert.equal(f.model.result?.isError,true);assert.match(JSON.stringify(f.model.result),/当前人类消息未授权/u,'actual runtime guard denial, not business or schema failure');assert.ok(f.model.visible.includes('plan_register'),'write tool stays advertised');}finally{await f.close();}});
test('attachment list RPC requires current authenticated owned session and never returns storage paths',async()=>{const f=await fixture();try{const result=await f.service.dispatch(f.c,'collaboration/attachments/receipts',{sessionId:f.sessionId});assert.equal(result.ok,true);assert.deepEqual(result.attachments,[]);f.store.create('foreign','bob',{projectId:f.project.id});await assert.rejects(f.service.dispatch(f.c,'collaboration/attachments/receipts',{sessionId:'foreign'}));await f.service.dispatch(f.c,'session/close',{sessionId:f.sessionId});await assert.rejects(f.service.dispatch(f.c,'collaboration/attachments/receipts',{sessionId:f.sessionId}));}finally{await f.close();}});
function toolValue(model){return JSON.parse(model.result.content.filter(b=>b.type==='text').map(b=>b.text).join(''));}
function activateSyntheticTask(f){const s=f.collaboration.services;s.projects.setMember(f.project.id,'product','alice');const {plan}=s.plans.register({projectId:f.project.id,title:'合成已确认方案',relevantRoles:['product'],rolesReason:'合成产品任务',tasks:[{ref:'synthetic-task',taskId:null,role:'product',change:'add',content:'检查合成需求',dependsOn:[]}],undecided:[]});s.plans.confirm({planId:plan.id,role:'product',outcome:'agree',submittedBy:'alice',declaredMember:'alice'});return s.tasks.listByProject(f.project.id)[0].task.id;}
test('draft analysis_begin actually reads fixed archived synthetic content and persists no analysis',async()=>{const f=await fixture('analysis_begin');try{const source=join(f.collaboration.workspace,'synthetic.txt');writeFileSync(source,'离线合成原文，产品功能仅作测试。');const material=f.collaboration.services.materials.upload({projectId:f.project.id,sourcePath:source,originalName:'synthetic.txt',purpose:'合成需求',submittedBy:'alice'});f.model.args={project_id:f.project.id,trigger:'user-command',scope:[{material_id:material.material.id,version:1}]};const command='帮我分析这份已归档需求，先给草稿';await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:meta(f,command)});assert.notEqual(f.model.result.isError,true,JSON.stringify(f.model.result));assert.match(JSON.stringify(toolValue(f.model)),/离线合成原文/u);assert.ok(f.model.visible.includes('analysis_begin'));assert.ok(f.model.visible.includes('analysis_submit'),'write tool stays advertised');assert.equal(f.collaboration.attachments.db.prepare('SELECT COUNT(*) n FROM analyses').get().n,0);}finally{await f.close();}});
test('explicit progress actually writes one attributed note and never completes a task',async()=>{const f=await fixture('progress_add');try{const taskId=activateSyntheticTask(f);f.model.args={task_id:taskId,note:'合成需求检查已完成',submitted_by:'forged-model-name'};const command='请记录这个任务的进展：合成需求检查已完成';await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:meta(f,command)});assert.notEqual(f.model.result.isError,true,JSON.stringify(f.model.result));assert.equal(toolValue(f.model).completed,false);const records=f.collaboration.services.results.progressOf(taskId);assert.equal(records.length,1);assert.equal(records[0].submittedBy,'alice');assert.equal(f.collaboration.services.tasks.get(taskId).task.completedAt,null);assert.ok(f.model.visible.includes('result_submit'),'write tool stays advertised');assert.ok(!f.model.visible.includes('result_review'));}finally{await f.close();}});
test('progress query or vague report cannot invoke progress_add',async()=>{const f=await fixture('progress_add');try{const taskId=activateSyntheticTask(f);f.model.args={task_id:taskId,note:'模型擅自记入',submitted_by:'alice'};const command='查一下当前进度，汇报一下项目情况';await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:meta(f,command)});assert.match(JSON.stringify(f.model.result),/当前人类消息未授权/u);assert.equal(f.collaboration.services.results.progressOf(taskId).length,0);}finally{await f.close();}});
test('explicit project background update uses existing tool but gives no approval scope',async()=>{const f=await fixture('project_update_details');try{f.model.args={project_id:f.project.id,background:'仅用于离线合成验收的新背景'};const command='请更新项目背景：仅用于离线合成验收的新背景';await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:meta(f,command)});assert.notEqual(f.model.result.isError,true,JSON.stringify(f.model.result));assert.equal(f.collaboration.services.projects.get(f.project.id).background,'仅用于离线合成验收的新背景');for(const tool of ['plan_confirm','result_review','result_accept'])assert.ok(!f.model.visible.includes(tool));}finally{await f.close();}});
for(const [command,tool]of [['提交刚才那份方案','plan_register'],['请提交修订后的方案','plan_revise'],['请提交这份需求分析','analysis_submit'],['登记这个成果','result_submit'],['请把这条通知标为已读','todo_mark_read'],['请为这个成果发起验收','result_acceptance_open']])test('explicit request authorizes only its own write and keeps human-only tools hidden: '+command,async()=>{const f=await fixture('result_review');try{await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:meta(f,command)});assert.ok(f.model.visible.includes(tool),'positive scope '+tool);for(const write of ['analysis_submit','plan_register','plan_revise','result_submit','progress_add','project_update_details','todo_mark_read','result_acceptance_open'])assert.ok(f.model.visible.includes(write),'write tool stays advertised '+write);for(const name of ['plan_confirm','result_review','result_accept'])assert.ok(!f.model.visible.includes(name),'human-only tool stays hidden '+name);assert.deepEqual([...deriveHumanPolicy(command).writes],[tool],'only this write is authorized');assert.match(JSON.stringify(f.model.result),/当前人类消息未授权/u,'model approval stays blocked');}finally{await f.close();}});
test('admission rejection carries matching not_started but old submitted request never receives that attestation',async()=>{const f=await fixture();try{const command='帮我做个方案',bad=meta(f,'wrong original');await assert.rejects(f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:bad}),error=>error.data?.requestId===bad.requestId&&error.data?.executionState==='not_started');assert.equal(f.store.status(f.sessionId),null);const good=meta(f,command);await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:good});await assert.rejects(f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:'different'}],_meta:good}),error=>error.data?.executionState===undefined);assert.equal(f.model.calls,1);}finally{await f.close();}});
// Attachment flow under the new inventory semantics: bytes are ingested at prompt time from
// the real stuck-session phrasing, the model reads then archives through the two tools.
function freshAttachmentFlow(f,command,name,content,{secondTurn}={}){
 const bytes=Buffer.from(content),handle=hash('flow '+randomUUID()),manifest={handle,name,bytes:bytes.length,sha256:hash(bytes),projectId:f.project.id,sourceKind:'file-attachment'};
 let phase=0,value=null;f.model.calls=0;f.model.stream=async function*(options){
  this.calls++;assert.ok(this.calls<6);
  const result=options.messages.at(-1);
  if(phase===0){this.humanText=[...options.messages].reverse().find(m=>m.role==='user').content.filter(b=>b.type==='text').map(b=>b.text).join('');phase=1;yield*call('attachment_read',{handle:manifest.handle});return;}
  if(phase===1){value=JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join(''));assert.equal(value.ok,true);assert.equal(value.name,name);assert.equal(value.kind,'text');phase=2;yield*call('attachment_archive',{handle:manifest.handle,purpose:'合成需求'});return;}
  if(phase===2){value=JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join(''));this.archiveOutcome=value;phase=3;if(secondTurn){yield*call('attachment_read',{handle:manifest.handle});return;}}
  yield*text(value.ok?'已归档合成资料。':'没有归档。');
 };
 f.c.peer.request=async(method,p)=>{assert.equal(method,'collaboration/attachment/read');assert.equal(p.handle,handle);const chunk=bytes.subarray(p.offset,p.offset+p.maxBytes);return{offset:p.offset,bytes:chunk.length,data:chunk.toString('base64'),eof:p.offset+chunk.length===bytes.length};};
 const m=meta(f,command);m.attachments=[manifest];
 return {promise:f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:command}],_meta:m}),manifest};
}
test('attachment read then archive: full chain succeeds with the stuck-session phrasing, handle survives across turns',async()=>{const f=await fixture();try{
 const {promise,manifest}=freshAttachmentFlow(f,'这是项目的需求文档，你需要分析、上传、归档、并生成正式计划。','requirements-v2.md','合成需求正文，产品功能仅作测试。');
 await promise;
 assert.match(f.model.humanText,/这是项目的需求文档，你需要分析、上传、归档、并生成正式计划。\n\n\[会话附件清单\]\n- requirements-v2\.md handle=[a-f0-9]{64}/u);
 assert.equal(f.model.archiveOutcome.ok,true);assert.equal(f.model.archiveOutcome.version,1);assert.equal(f.model.archiveOutcome.name,'requirements-v2.md');
 // Same handle is still readable in a later turn: the inventory persists per session.
 const read=await f.collaboration.attachments.read(f.sessionId,'alice',manifest.handle);
 assert.equal(read.ok,true);assert.match(read.content,/合成需求正文/);
 const materials=f.collaboration.attachments.db.prepare('SELECT COUNT(*) n FROM materials').get();
 assert.equal(materials.n,1);
}finally{await f.close();}});
test('archive with a handle from another session is refused by tool ownership',async()=>{const f=await fixture();try{
 const bytes=Buffer.from('owned elsewhere'),manifest={handle:hash('foreign handle'),name:'foreign.txt',bytes:bytes.length,sha256:hash(bytes),projectId:f.project.id,sourceKind:'file-attachment'};
 const {sessionId}=await f.service.dispatch(f.c,'session/new',{projectId:f.project.id});
 const m=meta(f,'帮我看看这份文件');m.attachments=[manifest];
 f.c.peer.request=async(method,p)=>{assert.equal(method,'collaboration/attachment/read');const chunk=bytes.subarray(p.offset,p.offset+p.maxBytes);return{offset:p.offset,bytes:chunk.length,data:chunk.toString('base64'),eof:p.offset+chunk.length===bytes.length};};
 await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:'帮我看看这份文件'}],_meta:m});
 const other=(await f.service.dispatch(f.c,'session/new',{projectId:f.project.id})).sessionId;
 await assert.rejects(f.collaboration.attachments.read(other,'alice',manifest.handle),/not owned/);
}finally{await f.close();}});
test('deduplicated repeat archive publishes trusted operation results without new versions',async()=>{const f=await fixture();try{
 await freshAttachmentFlow(f,'请归档这份合成资料','receipted.txt','same exact contents').promise;
 await freshAttachmentFlow(f,'请归档这份合成资料','receipted.txt','same exact contents').promise;
 const events=f.store.events(f.sessionId).map(e=>e.update).filter(u=>u._meta?.operationResult);
 const archived=events.filter(e=>e._meta.operationResult.kind==='material_archive');
 assert.equal(archived.length,2);assert.equal(archived[1]._meta.operationResult.deduplicated,true);assert.equal(archived[1]._meta.operationResult.version,1);
 assert.match(archived[1].content.text,/receipted\.txt.*第1版.*未新增版本/u);
 for(const event of events){assert.equal(event.sessionUpdate,'agent_message_chunk');assert.equal(typeof event._meta.requestId,'string');assert.ok(event.content.text.includes('receipted.txt'));}
 assert.equal(f.collaboration.attachments.db.prepare('SELECT COUNT(*) n FROM material_versions').get().n,1);
}finally{await f.close();}});
test('historical version collision surfaces as an explicit tool error, never a false archive success',async()=>{const f=await fixture();try{
 const source=join(f.collaboration.workspace,'hist.txt');writeFileSync(source,'historical');f.collaboration.services.materials.upload({projectId:f.project.id,sourcePath:source,originalName:'receipted.txt',purpose:'项目需求',submittedBy:'alice'});writeFileSync(source,'latest');f.collaboration.services.materials.upload({projectId:f.project.id,sourcePath:source,originalName:'receipted.txt',purpose:'项目需求',submittedBy:'alice'});
 const bytes=Buffer.from('historical'),manifest={handle:hash('collision handle'),name:'receipted.txt',bytes:bytes.length,sha256:hash(bytes),projectId:f.project.id,sourceKind:'file-attachment'};
 let phase=0;f.model.stream=async function*(options){this.calls++;assert.ok(this.calls<6);const result=options.messages.at(-1);
  if(phase===0){phase=1;yield*call('attachment_archive',{handle:manifest.handle,purpose:'项目需求'});return;}
  const value=JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join(''));this.archiveError=value;yield*text('归档失败，如实报告。');};
 f.c.peer.request=async(method,p)=>{assert.equal(method,'collaboration/attachment/read');const chunk=bytes.subarray(p.offset,p.offset+p.maxBytes);return{offset:p.offset,bytes:chunk.length,data:chunk.toString('base64'),eof:p.offset+chunk.length===bytes.length};};
 const m=meta(f,'请归档这份合成资料');m.attachments=[manifest];
 await f.service.dispatch(f.c,'session/prompt',{sessionId:f.sessionId,prompt:[{type:'text',text:'请归档这份合成资料'}],_meta:m});
 assert.equal(f.model.archiveError.ok,false);assert.match(f.model.archiveError.error.message,/历史旧版|MATERIAL_RESTORE/u);
 assert.equal(f.collaboration.attachments.db.prepare('SELECT COUNT(*) n FROM material_versions').get().n,2);
}finally{await f.close();}});
