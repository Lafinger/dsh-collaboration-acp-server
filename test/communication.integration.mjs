import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LlmAdapter,ToolCallId} from '@deepseek-ai/dsh-llm';
import {randomUUID} from 'node:crypto';
import {createTestCollaboration} from './helpers/host.mjs';

class ReadonlyModel extends LlmAdapter{
  calls=0;
  async *stream(options){
    this.calls++;assert.ok(!options.tools.some(t=>['project_create','project_update_details','plan_confirm','material_read','session_declare_member','attachment_transfer'].includes(t.name)));
    const last=options.messages.at(-1);
    if(last.role==='tool'){
      const content=last.content.filter(c=>c.type==='text').map(c=>c.text).join('');
      yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:content};yield {type:'block-end',index:0,block:{type:'text',text:content}};yield {type:'finish',reason:{kind:'stop'}};return;
    }
    const interim='INTERIM-MODEL-TEXT-MUST-NOT-BE-PUBLISHED';
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:interim};yield {type:'block-end',index:0,block:{type:'text',text:interim}};
    const block={type:'tool-call',id:ToolCallId(randomUUID()),name:'todo_list',arguments:JSON.stringify({project_id:this.projectId,roles:['backend']})};
    yield {type:'block-start',index:1,blockType:'tool-call'};yield {type:'tool-call-delta',index:1,id:block.id,name:block.name,argumentsDelta:block.arguments};yield {type:'block-end',index:1,block};yield {type:'finish',reason:{kind:'tool-calls'}};
  }
}

test('same Host IM model sees narrow private tools only, no writes/reasoning stream, contexts persist independently',async()=>{
  const root=mkdtempSync(join(tmpdir(),'im-collaboration-')),adapter=new ReadonlyModel();
  const c=await createTestCollaboration({workspace:join(root,'workspace'),stateRoot:join(root,'state'),adapter,serviceId:'im-test',dingtalk:{corpId:'corp',clientId:'app',clientSecret:'synthetic',publicOrigin:'https://login.example.test'}});
  try{
    const p=c.services.projects.create({key:'A',name:'A'});adapter.projectId=p.id;
    c.security.bind({account:'alice',userId:'alice',unionId:'alice'});c.security.participate(p.id,'alice',true);c.security.markVerified('alice',{corpId:'corp',userId:'alice',unionId:'alice',internal:true});c.services.projects.setMember(p.id,'product','alice');
    c.services.plans.register({projectId:p.id,title:'Pending',tasks:[],relevantRoles:['product'],rolesReason:'one',undecided:[]});
    const principal={account:'alice',projectId:p.id,channel:'im-private',memberRevision:c.security.member('alice').revision,participantRevision:c.security.requireProject('alice',p.id).revision,epoch:c.security.epoch};
    const first=await c.communication.queryModel('本人待办',principal);assert.ok(first.includes('alice'));assert.ok(!first.includes('agent_thought'));assert.ok(!first.includes('INTERIM-MODEL-TEXT'));
    const firstSession=c.security.db.prepare('SELECT session_id FROM collaboration_im_contexts').get().session_id;
    const second=await c.communication.queryModel('再查一次',principal);assert.ok(second.includes('alice'));assert.equal(c.security.db.prepare('SELECT count(*) n FROM collaboration_im_contexts').get().n,1);
    assert.equal(c.security.db.prepare('SELECT session_id FROM collaboration_im_contexts').get().session_id,firstSession);
    c.security.setEnabled('alice',false);c.security.setEnabled('alice',true);c.security.markVerified('alice',{corpId:'corp',userId:'alice',unionId:'alice',internal:true});await assert.rejects(c.communication.queryModel('old context',principal));
    assert.equal(c.security.db.prepare('SELECT count(*) n FROM confirmations WHERE decided_at IS NOT NULL').get().n,0);assert.equal(c.runtime.handles.size,0);
  }finally{await c.runtime.closeAll();}
});
