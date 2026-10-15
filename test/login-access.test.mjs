import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {IdentityStore,opaqueSecret} from '../src/identity-store.mjs';
import {LoginService} from '../src/login-service.mjs';
import {AccessStore} from '../src/store.mjs';
import {AccessService} from '../src/service.mjs';
import {AccountAuthority,issueTicket} from '../src/authority.mjs';
import {initializeParams,collaborationMeta} from '../src/protocol.mjs';
import {listenAccess,connectAccess} from '../src/transport.mjs';

async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'scoped-access-')),db=openDatabase({path:':memory:'});let clock=1000000;
  const identities=new IdentityStore({db,serviceId:'s',corpId:'corp',clientId:'app',now:()=>clock});
  identities.bind({account:'alice',userId:'user',unionId:'union'});
  const projects=new ProjectService(db),a=projects.create({key:'A',name:'A'}),b=projects.create({key:'B',name:'B'});identities.participate(a.id,'alice',true);
  const provider={exchange:async()=>({corpId:'corp',userId:'user',unionId:'union',internal:true}),verifyMember:async m=>({corpId:'corp',userId:m.user_id,unionId:m.union_id,internal:true})};
  const login=new LoginService({identities,provider,publicOrigin:'https://login.example.test',now:()=>clock});
  const store=new AccessStore(join(root,'access.sqlite'));
  const runtime={opened:[],prompts:[],async open(input){this.opened.push(input);return input;},async prompt(handle,text,_signal,emit){this.prompts.push(text);emit({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});return {stopReason:'end_turn'};},async close(){}};
  const secret='a'.repeat(64),authority=new AccountAuthority({serviceId:'s',accounts:{alice:secret}});
  const service=new AccessService({authority,store,runtime,cwd:root,login,identities,projects}),listener=await listenAccess(service),peers=[];
  t.after(async()=>{peers.forEach(p=>p.close());await listener.close();store.close();db.close();});
  const connect=async()=>{const peer=await connectAccess(listener.address);peers.push(peer);await peer.request('collaboration/connect',{ticket:issueTicket({account:'alice',serviceId:'s',secret}),_meta:collaborationMeta()});await peer.request('initialize',initializeParams());return peer;};
  const authenticate=async peer=>{
    const proof=opaqueSecret(),start=await peer.request('collaboration/login/start',{deviceId:'device',proof}),browser=login.browserStart(start.requestId);
    await login.callback({state:new URL(browser.authorizationUrl).searchParams.get('state'),code:opaqueSecret(),cookie:browser.cookie});
    const claimed=await peer.request('collaboration/login/claim',{requestId:start.requestId,deviceId:'device',proof});
    await peer.request('collaboration/login/authenticate',{token:claimed.token,deviceId:'device'});return claimed;
  };
  return {store,identities,projects,a,b,connect,authenticate,runtime,advance:ms=>clock+=ms};
}

test('SSH ticket cannot create business session until device login; project scope is mandatory',async t=>{
  const f=await fixture(t),peer=await f.connect();
  assert.equal((await peer.request('collaboration/login/status',{})).authenticated,false);
  await assert.rejects(peer.request('session/new',{}),e=>e.code===-32003);
  const claimed=await f.authenticate(peer);assert.equal(claimed.account,'alice');
  assert.equal((await peer.request('collaboration/whoami',{})).identitySource,'dingtalk');
  assert.deepEqual((await peer.request('collaboration/projects',{})).projects.map(p=>p.id),[f.a.id]);
  await assert.rejects(peer.request('session/new',{}),e=>e.code===-32602);
  await assert.rejects(peer.request('session/new',{projectId:f.b.id}),e=>e.code===-32003);
  const created=await peer.request('session/new',{projectId:f.a.id});assert.equal(f.runtime.opened[0].principal.projectId,f.a.id);
  await peer.request('session/prompt',{sessionId:created.sessionId,prompt:[{type:'text',text:'query'}],_meta:{requestId:'one'}});
  assert.deepEqual(f.runtime.prompts,['query']);
  const second=await f.connect();await second.request('collaboration/login/logout',{token:claimed.token,deviceId:claimed.deviceId});
  await assert.rejects(peer.request('collaboration/history',{sessionId:created.sessionId}));
  assert.equal(f.identities.requireMember('alice').enabled,1);
});

test('legacy scope stays read-only, participant revoke/regrant cannot revive old context or display project history',async t=>{
  const f=await fixture(t),peer=await f.connect();await f.authenticate(peer);
  f.store.create('legacy','alice');f.store.append('legacy',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'legacy owner history'}});
  assert.equal((await peer.request('collaboration/history',{sessionId:'legacy'})).events.length,1);
  await assert.rejects(peer.request('session/load',{sessionId:'legacy'}),/read-only/);
  const created=await peer.request('session/new',{projectId:f.a.id});
  f.identities.participate(f.a.id,'alice',false);await assert.rejects(peer.request('collaboration/history',{sessionId:created.sessionId}));
  assert.deepEqual((await peer.request('session/list',{})).sessions.map(s=>s.sessionId),['legacy']);
  f.identities.participate(f.a.id,'alice',true);await assert.rejects(peer.request('session/prompt',{sessionId:created.sessionId,prompt:[{type:'text',text:'no'}],_meta:{requestId:'no'}}),/qualification changed/);
  assert.equal(f.runtime.prompts.length,0);
});

test('expired or globally revoked devices cannot access after a cached connected peer',async t=>{
  const f=await fixture(t),peer=await f.connect();await f.authenticate(peer);const created=await peer.request('session/new',{projectId:f.a.id});
  f.advance(43200000);await assert.rejects(peer.request('collaboration/history',{sessionId:created.sessionId}),e=>e.code===-32003);
  await f.authenticate(peer);f.identities.setEnabled('alice',false);await assert.rejects(peer.request('collaboration/whoami',{}));
});
