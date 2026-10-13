// Installed Linux release only, network disabled and no production volume.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { LlmRuntime, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
const require=createRequire(import.meta.url),packageRoot=dirname(realpathSync(require.resolve('dsh-collaboration-acp-server/package.json')));
const {createCollaborationRuntime}=await import(pathToFileURL(join(packageRoot,'src/collaboration-runtime.mjs')).href);
class Fixture extends LlmAdapter {
  calls=0;
  async *stream(options){
    if(++this.calls>20)throw new Error('Bounded local fixture');const last=options.messages.at(-1);
    if(last.role==='tool'){const text=last.content.filter(b=>b.type==='text').map(b=>b.text).join('');yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'finish',reason:{kind:'stop'}};return;}
    assert.ok(options.tools.some(t=>t.name==='project_update_details'));
    const human=[...options.messages].reverse().find(m=>m.role==='user'&&m.source?.kind==='user'),args=JSON.parse(human.content.map(b=>b.text??'').join(''));
    const id=ToolCallId(randomUUID()),block={type:'tool-call',id,name:'project_update_details',arguments:JSON.stringify(args)};
    yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name:block.name,argumentsDelta:block.arguments};yield{type:'block-end',index:0,block};yield{type:'finish',reason:{kind:'tool-calls'}};
  }
}
const root=mkdtempSync(join(tmpdir(),'collab-details-linux-')),ctx=new Context(),fixture=new Fixture();
ctx.plugin(SystemPrompt,{includeHarnessIdentity:false,includeRuntimeContext:false,personaPrefix:'',personaSuffix:''});ctx.plugin(LlmRuntime);ctx.plugin(SessionStore);ctx.plugin(AgentRegistry);ctx.plugin(SessionProjectionRegistry);ctx.plugin(ToolRuntime,{mode:'native'});ctx.plugin(persistence,{root:join(root,'host-sessions'),compression:'none'});ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1});
await Promise.all([...ctx.registry.values()].flatMap(r=>[...r.fibers]).map(f=>f.await()));ctx.llm.registerAdapter(['fixture'],fixture);let runtime;
try{
 const collaboration=await createCollaborationRuntime({workspace:join(root,'workspace'),stateRoot:join(root,'state'),provider:'fixture',model:'fixture'},ctx);runtime=collaboration.runtime;
 const project=collaboration.services.projects.create({key:'DETAILS-FIXTURE',name:'Sample only'});collaboration.services.projects.setMember(project.id,'pm','alice');
 const id=randomUUID();let handle=await runtime.open({id,owner:'alice',cwd:collaboration.workspace,resume:false});
 const run=async(args)=>{const chunks=[];const result=await runtime.prompt(handle,JSON.stringify(args),new AbortController().signal,u=>{if(u.sessionUpdate==='agent_message_chunk')chunks.push(u.content.text);});assert.equal(result.stopReason,'end_turn');return JSON.parse(chunks.join(''));};
 const first=await run({project_id:project.id,background:'  Explicit fixture background  '});assert.equal(first.ok,true);assert.equal(first.project.background,'Explicit fixture background');assert.equal(first.project.goal,null);assert.deepEqual(first.project.pending_fields,['goal']);
 const second=await run({project_id:project.id,goal:'Explicit fixture goal'});assert.equal(second.ok,true);assert.equal(second.project.background,first.project.background);assert.deepEqual(second.project.pending_fields,[]);assert.equal(second.project.id,project.id);assert.equal(second.project.key,project.key);
 const invalid=await run({project_id:project.id,background:'Must not change',goal:''});assert.equal(invalid.ok,false);assert.equal(collaboration.services.projects.get(project.id).background,first.project.background);
 const calls=fixture.calls;await runtime.close(handle);handle=await runtime.open({id,owner:'alice',cwd:collaboration.workspace,resume:true});assert.equal(fixture.calls,calls);
 collaboration.services.projects.archive(project.id);const archived=await run({project_id:project.id,goal:'Must not change'});assert.equal(archived.ok,false);assert.equal(archived.code,'PROJECT_ARCHIVED');assert.equal(collaboration.services.projects.get(project.id).goal,second.project.goal);assert.equal(collaboration.services.projects.getWithRoles(project.id).roles.find(r=>r.role==='pm').member,'alice');await runtime.close(handle);
 console.log(JSON.stringify({installedLinuxProjectDetailsFixture:'PASS',explicitPartialUpdate:true,invalidPatchAtomic:true,archivedRejected:true,sameIdRestoreNoReplay:true,productionVolumeMounted:false,paidModelRequests:0}));
}finally{await runtime?.closeAll();await ctx.fiber.dispose();}
