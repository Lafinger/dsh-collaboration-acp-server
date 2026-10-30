import test from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';import{mkdtempSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{PassThrough}from'node:stream';
import{LlmAdapter,ToolCallId}from'@deepseek-ai/dsh-llm';import{createTestCollaboration}from'./helpers/host.mjs';import{AccessStore}from'../src/store.mjs';import{AccountAuthority}from'../src/authority.mjs';import{AccessService}from'../src/service.mjs';import{listenAccess}from'../src/transport.mjs';import{bridgeConnector}from'../src/connector.mjs';import{JsonPeer,initializeParams}from'../src/protocol.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function* tool(name,args){const id=ToolCallId(randomUUID()),block={type:'tool-call',id,name,arguments:JSON.stringify(args)};yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name,argumentsDelta:block.arguments};yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'tool-calls'}};}
function* text(value){yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:value};yield{type:'block-end',index:0,block:{type:'text',text:value}};yield{type:'finish',reason:{kind:'stop'}};}
class AttachmentModel extends LlmAdapter{
 calls=0;read=null;archive=null;projectId=null;blockedAssignment=false;
 async*stream(options){this.calls++;if(this.calls>10)throw new Error('Bounded fixture loop');const last=options.messages.at(-1),result=last?.role==='tool'?last:last?.content.find(b=>b.type==='tool-result');
 if(!result){assert.ok(options.tools.some(t=>t.name==='attachment_read'));assert.ok(options.tools.some(t=>t.name==='attachment_archive'));assert.ok(!options.tools.some(t=>t.name==='attachment_receipts'));yield*tool('attachment_read',{handle:this.handle});return;}
 const call=options.messages.flatMap(message=>message.content).find(block=>block.type==='tool-call'&&block.id===result.toolCallId);
 if(call?.name==='project_set_role_member'){assert.equal(result.isError,true);this.blockedAssignment=true;yield*text('Unauthorized assignment blocked');return;}
 const value=JSON.parse(result.content.filter(b=>b.type==='text').map(b=>b.text).join(''));assert.equal(value.ok,true);
 if(call?.name==='attachment_read'){this.read=value;assert.equal(value.kind,'text');assert.equal(value.content,'Requirement: test only');yield*tool('attachment_archive',{handle:this.handle,purpose:'测试需求',role:'product'});return;}
 this.archive=value;yield*tool('project_set_role_member',{project_id:this.projectId,role:'product',member:'alice'});
 }
}
test('official host Agent reads and archives an ingested attachment through forced connector once; stored copy is session and account bound',async()=>{
 const root=mkdtempSync(join(tmpdir(),'collab-attach-stdio-')),model=new AttachmentModel();const collaboration=await createTestCollaboration({workspace:join(root,'workspace'),stateRoot:join(root,'state'),adapter:model});
 const project=collaboration.services.projects.create({key:'ATTACH-STDIO',name:'Sample project'}),store=new AccessStore(join(root,'access.sqlite')),secret='a'.repeat(64),service=new AccessService({runtime:collaboration.runtime,store,cwd:collaboration.workspace,authority:new AccountAuthority({serviceId:'attach',accounts:{alice:secret}})});
 model.projectId=project.id;
 const socketPath=process.platform==='win32'?`\\\\.\\pipe\\collab-attach-${randomUUID()}`:join(root,'service.sock'),listener=await listenAccess(service,{socketPath});
 const input=new PassThrough(),output=new PassThrough(),bridge=await bridgeConnector({socketPath,account:'alice',serviceId:'attach',secret},input,output),peer=new JsonPeer(output,input);
 const bytes=Buffer.from('Requirement: test only'),handle='b'.repeat(64);model.handle=handle;let reads=0;peer.on('message',message=>{if(message.id!==undefined){try{assert.equal(message.method,'collaboration/attachment/read');assert.equal(message.params.handle,handle);const{offset,maxBytes}=message.params,data=bytes.subarray(offset,offset+maxBytes);reads++;peer.result(message.id,{offset,data:data.toString('base64'),bytes:data.length,eof:offset+data.length===bytes.length});}catch(error){peer.error(message.id,error);}}});
 try{const init=initializeParams();init.clientCapabilities={attachmentTransfer:{version:2},humanAuthorization:{version:3}};const initialized=await peer.request('initialize',init);assert.equal(initialized.agentCapabilities.attachmentTransfer.version,2);assert.equal(initialized.agentCapabilities.humanAuthorization.version,3);const{sessionId}=await peer.request('session/new',{projectId:project.id});
 const command='@requirements.txt 这是需求文档，归档它。',manifest={handle,name:'requirements.txt',bytes:bytes.length,sha256:hash(bytes),projectId:project.id,sourceKind:'file-attachment'};
 const result=await peer.request('session/prompt',{sessionId,prompt:[{type:'text',text:command}],_meta:{requestId:'tool-transfer',humanAuthorization:{version:3,messageId:randomUUID(),textSha256:hash(command),projectId:project.id},attachments:[manifest]}});
 assert.equal(result.stopReason,'end_turn');assert.equal(reads,1);assert.ok(model.read);assert.ok(model.archive.material_id);assert.equal(model.blockedAssignment,true);assert.equal(collaboration.services.projects.getWithRoles(project.id).roles.find(role=>role.role==='product')?.member,null);assert.equal(collaboration.services.materials.listByProject(project.id)[0].versions.length,1);assert.equal(collaboration.services.materials.read({materialId:model.archive.material_id,version:1}).content,bytes.toString());
 assert.ok(collaboration.attachments.owned(sessionId,'alice',handle));assert.throws(()=>collaboration.attachments.owned(sessionId,'bob',handle));
 const inventory=collaboration.attachments.listForClient(sessionId,'alice',project.id);assert.equal(inventory.ok,true);assert.equal(inventory.attachments.length,1);assert.equal(inventory.attachments[0].attachmentId,handle);assert.equal(inventory.attachments[0].name,'requirements.txt');
 await peer.request('session/close',{sessionId});await peer.request('session/load',{sessionId});assert.equal(reads,1,'resume must not re-pull client bytes');
 }finally{peer.close();bridge.close();await listener.close();store.close();}
});
