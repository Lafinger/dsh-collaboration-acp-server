import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {PassThrough} from 'node:stream';
import {WebSocket} from 'ws';
import {createHost} from './helpers/host.mjs';
import {syntheticDingTalkConfig} from './helpers/security.mjs';
import * as plugin from '../src/server-plugin.mjs';
import {JsonPeer,initializeParams} from '../src/protocol.mjs';
import {opaqueSecret} from '../src/identity-store.mjs';

async function connect(port){
 const ws=new WebSocket(`ws://127.0.0.1:${port}/collaboration/socket`,{headers:{host:'login.example.test'}});await once(ws,'open');
 const input=new PassThrough(),output=new PassThrough();ws.on('message',data=>input.write(data));ws.on('close',()=>input.destroy());output.on('data',data=>ws.send(data.toString()));input.on('close',()=>ws.terminate());
 const peer=new JsonPeer(input,output);await peer.request('initialize',initializeParams());return peer;
}
async function login(service,peer,userId,deviceId){
 const proof=opaqueSecret(),start=await peer.request('collaboration/login/start',{deviceId,proof}),bound=service.login.browser(new URL(start.loginUrl).hash.slice(1));
 // Only this platform exchange is synthetic; the real store, host Agent factory and transport are not.
 service.login.provider.exchangePc=async()=>({corpId:'synthetic-corp',userId,unionId:'union-'+userId,internal:true,name:'Official '+userId});
 await service.login.authorize({requestId:start.requestId,cookie:bound.cookie,code:opaqueSecret()});service.login.confirm({requestId:start.requestId,cookie:bound.cookie});
 const result=await peer.request('collaboration/login/claim',{requestId:start.requestId,deviceId,proof});await peer.request('collaboration/login/authenticate',{token:result.token,deviceId});return result;
}
async function prompt(peer,sessionId,text,requestId='single'){
 let reply='';const listener=message=>{if(message.params?.sessionId===sessionId&&message.params.update?.sessionUpdate==='agent_message_chunk')reply+=message.params.update.content.text;};peer.on('message',listener);
 try{await peer.request('session/prompt',{sessionId,prompt:[{type:'text',text}],_meta:{requestId}});return reply;}finally{peer.off('message',listener);}
}
test('configured MVP plugin uses one real DSH host with no bot or SSH, auto-enrollment, private conversation scopes and role changes do not strand conversations',{timeout:10000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'mvp-host-')),ding={...await syntheticDingTalkConfig(),agentId:'123',administratorUserId:'boss'},config={mode:'mvp-https',serviceId:'mvp-host',workspace:join(root,'workspace'),stateRoot:join(root,'state'),provider:'fixture',model:'fixture',dingtalk:ding};
 const configFile=join(root,'config.json');writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
 const host=await createHost({root:join(root,'host')});let entry,a,b;
 try{
  entry=host.ctx.plugin(plugin,{configFile});await entry.await();assert.equal(entry.ctx.get('collaborationServerStatus').state,'running');assert.equal(entry.ctx.get('collaborationCommunication'),undefined);
  const server=entry.ctx.get('collaborationServer'),service=server.service;assert.equal(service.authority,null);assert.equal(service.communication,null);
  service.login.provider.verifyMember=async member=>({corpId:ding.corpId,userId:member.user_id,unionId:member.union_id,internal:true});
  a=await connect(ding.loginPort);b=await connect(ding.loginPort);
  const admin=await login(service,a,'boss','a'),member=await login(service,b,'member','b');
  const created=await a.request('collaboration/admin',{action:'create',commandId:'new',key:'MVP',name:'All members'}),projectId=created.project.id;
  assert.deepEqual((await b.request('collaboration/projects',{})).projects.map(p=>p.id),[projectId]);
  await assert.rejects(b.request('collaboration/admin',{action:'create',commandId:'bypass',key:'NO',name:'No'}),e=>e.code===-32003);
  const sa=await a.request('session/new',{projectId}),sb=await b.request('session/new',{projectId});
  assert.equal(JSON.parse(await prompt(a,sa.sessionId,'whoami')).account,admin.account);assert.equal(JSON.parse(await prompt(b,sb.sessionId,'whoami')).account,member.account);
  await assert.rejects(b.request('collaboration/history',{sessionId:sa.sessionId}),e=>e.code===-32004);
  const agent=host.ctx.agents.get(sb.sessionId),assembly=await agent.ctx.get('systemPrompt').assemble({agent,scope:agent,signal:new AbortController().signal});
  assert.ok(!assembly.tools.some(tool=>['project_create','project_set_role_member','session_declare_member'].includes(tool.name)));
  const view=await a.request('collaboration/admin',{action:'view',projectId});await a.request('collaboration/admin',{action:'role',commandId:'assign',projectId,role:'frontend',account:member.account,revision:view.revision});
  assert.equal(await prompt(b,sb.sessionId,'after-role-change','second'),'fixture:after-role-change');
  await assert.rejects(prompt(b,sb.sessionId,'again','second'),e=>e.code===-32005);
 }finally{a?.close();b?.close();await entry?.dispose();await host.close();}
});
