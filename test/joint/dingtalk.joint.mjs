import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createHost} from '../helpers/host.mjs';
import {syntheticDingTalkConfig,provisionSynthetic} from '../helpers/security.mjs';
import * as serverPlugin from '../../src/server-plugin.mjs';
import {connectAccess} from '../../src/transport.mjs';
import {issueTicket} from '../../src/authority.mjs';
import {collaborationMeta} from '../../src/protocol.mjs';

const clientRoot=process.env.DSH_COLLABORATION_CLIENT_ROOT,imRoot=process.env.DSH_COLLABORATION_IM_ROOT;
if(!clientRoot||!imRoot)throw new Error('Joint only: explicitly select independent client and dsh-im checkouts');
const {MemberClient}=await import(pathToFileURL(resolve(clientRoot,'src/member-client.mjs')).href);
const {createControlledDingTalkPlugin,ControlledDingTalkRuntime}=await import(pathToFileURL(resolve(imRoot,'plugin-src/host/controlled-dingtalk.mjs')).href);

test('three-repository same Host: scanned DSH identity equals trusted IM sender, ACK persisted first, no default runtime/model calls',async()=>{
  const root=mkdtempSync(join(tmpdir(),'three-repo-dingtalk-')),host=await createHost({root:join(root,'host')});
  const config={serviceId:'joint-auth',workspace:join(root,'workspace'),stateRoot:join(root,'state'),socketPath:process.platform==='win32'?`\\\\.\\pipe\\joint-auth-${randomUUID()}`:join(root,'socket'),accounts:{alice:'a'.repeat(64)},provider:'fixture',model:'fixture',dingtalk:await syntheticDingTalkConfig()};
  const configFile=join(root,'private-config.json');writeFileSync(configFile,JSON.stringify(config),{mode:0o600});
  let entry,client,controlled,raw,imEntry;
  try{
    entry=host.ctx.plugin(serverPlugin,{configFile});await entry.await();const server=entry.ctx.get('collaborationServer');
    const provisioned=provisionSynthetic(config),contract=entry.ctx.get('collaborationCommunication');
    assert.equal(contract.corpId,config.dingtalk.corpId);
    client=new MemberClient({databasePath:join(root,'client.sqlite'),serviceId:config.serviceId,account:'alice',requireLogin:true,loginOrigin:config.dingtalk.publicOrigin,connect:async()=>{const peer=await connectAccess(config.socketPath);await peer.request('collaboration/connect',{_meta:collaborationMeta(),ticket:issueTicket({account:'alice',serviceId:config.serviceId,secret:config.accounts.alice})});return peer;}});
    const started=await client.beginLogin();const login=server.service.login;const browser=login.browserStart(started.requestId);
    login.provider={exchange:async()=>({corpId:config.dingtalk.corpId,userId:'alice',unionId:'alice',internal:true}),verifyMember:async m=>({corpId:config.dingtalk.corpId,userId:m.user_id,unionId:m.union_id,internal:true})};
    await login.callback({state:new URL(browser.authorizationUrl).searchParams.get('state'),code:'synthetic-one-use-code',cookie:browser.cookie});await client.completeLogin();
    const project=provisioned.projectId;assert.equal(client.authStatus().account,'alice');client.selectProject('local',project);await client.open('local');
    // Provision explicit route through same authoritative store, not a generic delivery alias.
    const db=server.service.identities.db,{CommunicationStore}=await import('../../src/communication-store.mjs'),store=new CommunicationStore({identities:server.service.identities,recover:false});
    store.manageTarget({id:'alice-private',projectId:project,kind:'private',account:'alice',botId:'robot',corpId:config.dingtalk.corpId,clientId:config.dingtalk.clientId,robotCode:'code',route:{userId:'alice'}});
    let callback;const messages=[];raw={connected:false,registerCallbackListener:(topic,fn)=>{assert.equal(topic,'/v1.0/im/bot/messages/get');callback=fn;},socketCallBackResponse:()=>{assert.equal(db.prepare("SELECT status FROM collaboration_inbox WHERE message_id='message'").get().status,'pending');},async connect(){this.connected=true;},async disconnect(){this.connected=false;}};
    const imConfig=join(root,'controlled-config.json');writeFileSync(imConfig,JSON.stringify({botId:'robot',corpId:config.dingtalk.corpId,clientId:config.dingtalk.clientId,clientSecret:'synthetic',robotCode:'code'}),{mode:0o600});
    imEntry=entry.ctx.plugin(createControlledDingTalkPlugin({createRuntime:options=>controlled=new ControlledDingTalkRuntime({...options,streamFactory:async()=>raw,api:{async sendRobotText({target,text,beforeSend}){beforeSend?.();messages.push({target,text});return {accepted:true,providerQueryKey:'synthetic'};},async queryGroupMembers(){throw new Error('Group not configured');}}})}),{configFile:imConfig});
    await imEntry.await();assert.equal(imEntry.ctx.get('dshImControlledDingTalk').mode,'collaboration-only');callback({headers:{messageId:'wire'},data:JSON.stringify({chatbotCorpId:config.dingtalk.corpId,senderCorpId:config.dingtalk.corpId,senderStaffId:'alice',robotCode:'code',msgId:'message',conversationId:'private',conversationType:'1',createAt:Date.now(),msgtype:'text',text:{content:'/项目 SYNTHETIC /状态'}})});
    await server.service.communication.schedule();
    assert.ok(messages.some(m=>m.target.userId==='alice'&&m.text.includes('Synthetic integration')));
    await imEntry.dispose();assert.equal(raw.connected,false); // Actual Host unload settles owned carrier without replay.
    assert.equal(db.prepare("SELECT account FROM collaboration_inbox WHERE message_id='message'").get().account,'alice');
    assert.equal(host.adapter.calls??0,0);assert.equal(server.service.runtime.handles.size,1);assert.equal(controlled.describe().sessionSync,false);
    const history=await client.communications(project);assert.equal(history.ok,true);assert.equal(history.requests.length,0);
    await client.logout();assert.equal(server.service.identities.requireMember('alice').enabled,1);
  }finally{await imEntry?.dispose();await controlled?.stop();client?.close();await entry?.dispose();await host.close();}
});
