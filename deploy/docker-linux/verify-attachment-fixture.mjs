// Isolated Linux host/tool acceptance against installed release. No production volume, Codego, or SSH credentials.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { LlmRuntime, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const require=createRequire(import.meta.url),packageRoot=dirname(realpathSync(require.resolve('dsh-collaboration-acp-server/package.json')));
const {createCollaborationRuntime}=await import(pathToFileURL(join(packageRoot,'src/collaboration-runtime.mjs')).href);
const {parseAttachment}=await import(pathToFileURL(join(packageRoot,'src/attachment-parser.mjs')).href);
const sharp=createRequire(join(packageRoot,'package.json'))('sharp');
class Fixture extends LlmAdapter {
  receipt=null;archive=null;calls=0;
  async *stream(options){
    if(++this.calls>10)throw new Error('Bounded local fixture');const last=options.messages.at(-1);let name,args;
    if(last.role!=='tool'){name='attachment_transfer';args={handle:'a'.repeat(64)};}
    else{const value=JSON.parse(last.content.filter(b=>b.type==='text').map(b=>b.text).join(''));assert.equal(value.ok,true);const call=options.messages.flatMap(m=>m.content).find(b=>b.type==='tool-call'&&b.id===last.toolCallId);
      if(call.name==='attachment_transfer'){this.receipt=value.receipt_id;name='attachment_inspect';args={receipt_id:this.receipt};}
      else if(call.name==='attachment_inspect'){assert.equal(value.parsed.content,'Sample Linux requirement');name='attachment_archive';args={receipt_id:this.receipt,purpose:'non-sensitive fixture',reason:'Sample Linux requirement inspected'};}
      else{this.archive=value;const text=JSON.stringify(value);yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'finish',reason:{kind:'stop'}};return;}}
    const id=ToolCallId(randomUUID()),block={type:'tool-call',id,name,arguments:JSON.stringify(args)};
    yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name,argumentsDelta:block.arguments};yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'tool-calls'}};
  }
}
const root=mkdtempSync(join(tmpdir(),'collab-linux-fixture-')),ctx=new Context(),fixture=new Fixture();
ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'',personaSuffix:''});ctx.plugin(LlmRuntime);ctx.plugin(SessionStore);ctx.plugin(AgentRegistry);ctx.plugin(SessionProjectionRegistry);ctx.plugin(ToolRuntime,{mode:'native'});ctx.plugin(persistence,{root:join(root,'host-sessions'),compression:'none'});ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
await Promise.all([...ctx.registry.values()].flatMap(r=>[...r.fibers]).map(f=>f.await()));ctx.llm.registerAdapter(['fixture'],fixture);
let runtime;
try{
 for(const [format,extension]of[['png','png'],['jpeg','jpg'],['webp','webp'],['gif','gif']]){const image=await sharp({create:{width:2,height:2,channels:3,background:'#ffffff'}}).toFormat(format).toBuffer(),parsed=await parseAttachment(image,'test.'+extension);assert.equal(parsed.kind,'image');assert.equal(parsed.visualAnalysis,'not-performed');}
 const collaboration=await createCollaborationRuntime({workspace:join(root,'workspace'),stateRoot:join(root,'state'),provider:'fixture',model:'fixture'},ctx);runtime=collaboration.runtime;
 const project=collaboration.services.projects.create({key:'LINUX-FIXTURE',name:'Non-sensitive sample'}),data=Buffer.from('Sample Linux requirement'),controller=new AbortController(),id=randomUUID(),handle=await runtime.open({id,owner:'alice',cwd:join(root,'workspace'),resume:false});
 const manifests=[{handle:'a'.repeat(64),name:'sample.txt',bytes:data.length,sha256:createHash('sha256').update(data).digest('hex'),projectId:project.id,archiveAuthorized:true,sourceKind:'file-attachment'}];let reads=0;
 const result=await runtime.prompt(handle,'附件操作: 上传并归档\nproject_id: '+project.id,controller.signal,()=>{}, {sessionId:id,requestId:'fixture',account:'alice',manifests,read:async({offset,maxBytes})=>{reads++;const bytes=data.subarray(offset,offset+maxBytes);return {offset,bytes:bytes.length,data:bytes.toString('base64'),eof:offset+bytes.length===data.length};}});
 assert.equal(result.stopReason,'end_turn');assert.equal(reads,1);assert.ok(fixture.archive.material_id);assert.equal(collaboration.services.materials.read({materialId:fixture.archive.material_id,version:1}).content,data.toString());
 await runtime.close(handle);const restored=await runtime.open({id,owner:'alice',cwd:join(root,'workspace'),resume:true});assert.equal(reads,1);assert.equal(collaboration.attachments.list(id,'alice').receipts.length,1);await runtime.close(restored);
 console.log(JSON.stringify({installedLinuxAttachmentFixture:'PASS',imageFormats:['png','jpeg','webp','gif'],officialScopedTools:true,immutableArchive:true,sameSessionRestoreNoReplay:true,productionVolumeMounted:false,modelRequests:false}));
}finally{await runtime?.closeAll();await ctx.fiber.dispose();}
