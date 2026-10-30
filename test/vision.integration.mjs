import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {LlmAdapter,ToolCallId} from '@deepseek-ai/dsh-llm';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import {createHost} from './helpers/host.mjs';
import {createCollaborationRuntime} from '../src/collaboration-runtime.mjs';
import {prepareHumanRequest} from '../src/human-authorization.mjs';
const text=message=>message?.content.filter(b=>b.type==='text').map(b=>b.text).join('')??'';
class VisualFixture extends LlmAdapter {
 calls=[];
 async*stream(options){
  this.calls.push(options);const last=options.messages.at(-1);let call;
  if(last.role==='user')call={name:'attachment_read',arguments:JSON.stringify({handle:'a'.repeat(64)})};
  else if(last.role==='tool'&&!last.content.some(b=>b.type==='image')){const result=JSON.parse(text(last));assert.equal(result.ok,true);assert.equal(result.kind,'image');call={name:'attachment_read',arguments:JSON.stringify({handle:'a'.repeat(64)})};}
  if(call){const id=ToolCallId(randomUUID());yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name:call.name,argumentsDelta:call.arguments};yield {type:'block-end',index:0,block:{type:'tool-call',id,...call}};yield {type:'finish',reason:{kind:'tool-calls'}};return;}
  assert.equal(last.role,'tool');assert.equal(last.content.filter(b=>b.type==='image').length,1);const value=JSON.parse(text(last));assert.equal(value.visual_input,'prepared-for-current-model');
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Synthetic model received pixels'};yield {type:'block-end',index:0,block:{type:'text',text:'Synthetic model received pixels'}};yield {type:'finish',reason:{kind:'stop'}};
 }
}
test('actual Agent loop reads an uploaded picture twice, emits durable native tool image, and preserves history after resume without rereading client',async()=>{
 const root=mkdtempSync(join(tmpdir(),'vision-loop-')),adapter=new VisualFixture(),host=await createHost({root:join(root,'host'),adapter});let runtime,handle;
 try{
  const storage=host.ctx.plugin(LocalAttachmentStore,{dshHome:join(root,'home'),normalizedImageMaxDimension:2048,normalizedImageMaxBytes:1048576});await storage.await();
  const app=await createCollaborationRuntime({workspace:join(root,'workspace'),stateRoot:join(root,'state'),provider:'fixture',model:'fixture'},host.ctx);runtime=app.runtime;
  const project=app.services.projects.create({key:'VISUAL',name:'Synthetic image'}),sessionId=randomUUID();handle=await runtime.open({id:sessionId,owner:'alice',cwd:join(root,'workspace')});
  const data=await sharp({create:{width:20,height:10,channels:3,background:'#f00'}}).png().toBuffer(),manifest={handle:'a'.repeat(64),name:'sample.png',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),sourceKind:'file-attachment',projectId:project.id};let reads=0;
  const command='帮我看看这张图片',admitted=prepareHumanRequest({text:command,projectId:project.id,manifests:[manifest],sessionId,account:'alice',requestId:'one'});
  await app.attachments.ingest({...admitted,read:async({offset,maxBytes})=>{reads++;const part=data.subarray(offset,offset+maxBytes);return {offset,bytes:part.length,data:part.toString('base64'),eof:offset+part.length===data.length};}});
  const result=await runtime.prompt(handle,command,new AbortController().signal,()=>{},{...admitted});
  assert.equal(result.finalText,'Synthetic model received pixels');assert.equal(adapter.calls.length,2);assert.equal(reads,1);assert.equal(app.services.materials.listByProject(project.id).length,0);
  assert.equal(handle.agent.session.deriveMessages().filter(m=>m.role==='tool').flatMap(m=>m.content).filter(b=>b.type==='image').length,1);
  await runtime.close(handle);handle=await runtime.open({id:sessionId,owner:'alice',cwd:join(root,'workspace'),resume:true});assert.equal(reads,1);assert.equal(handle.agent.session.deriveMessages().flatMap(m=>m.content).filter(b=>b.type==='image').length,1);
 }finally{await runtime?.closeAll();await host.close();}
});
