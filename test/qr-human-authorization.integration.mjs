// OFFLINE: real HTTP/WSS through QrAccessService/MvpAccessService; synthetic DingTalk provider and runtime, no real network/model.
// Regression for: MvpAccessService.initialize overrode the core initialize and dropped humanAuthorization v2
// negotiation (no validation, no per-connection state, no advertisement), so every real QR client failed with
// -32012 "协作服务尚不支持本次自然语言授权" before any business request was sent.
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {PassThrough} from 'node:stream';import {once} from 'node:events';import {WebSocket} from 'ws';
import {openDatabase} from '../business/lib/sqlite/connection.js';import {ProjectService} from '../business/lib/service/project-service.js';import {QrIdentityStore} from '../src/qr-identities.mjs';import {QrLoginService} from '../src/qr-login.mjs';import {QrAccessService} from '../src/qr-service.mjs';import {listenQrHttp} from '../src/qr-transport.mjs';import {JsonPeer,initializeParams} from '../src/protocol.mjs';

test('real QR HTTP/WSS: human authorization v2 is negotiated on the connection, advertised from stored state, and fail-closed',async t=>{
 const db=openDatabase({path:':memory:'}),identities=new QrIdentityStore({db,serviceId:'same',corpId:'corp',clientId:'app',administratorUserId:'boss'});
 const provider={async exchange(){return {corpId:'corp',userId:'boss',unionId:'union-boss',internal:true,name:'Boss'};},async verifyMember(){return {corpId:'corp',userId:'boss',unionId:'union-boss',internal:true};}};
 const login=new QrLoginService({identities,provider,publicOrigin:'https://login.example'});
 const service=new QrAccessService({identities,login,projects:new ProjectService(db),runtime:{async closeAll(){}},cwd:process.cwd(),store:{}});
 // Capture the real per-connection state object the transport creates; advertising alone must not satisfy the contract.
 const connections=[],attach=service.attach.bind(service);service.attach=peer=>{const c=attach(peer);connections.push(c);return c;};
 const listener=await listenQrHttp(service,login),peers=[];
 t.after(async()=>{for(const peer of peers)peer.close();await service.close();await listener.close();db.close();});
 const connect=async caps=>{const ws=new WebSocket(`ws://127.0.0.1:${listener.address.port}/collaboration/socket`,{headers:{host:'login.example'}});await once(ws,'open');const input=new PassThrough(),output=new PassThrough();ws.on('message',v=>input.write(v));ws.on('close',()=>input.destroy());output.on('data',v=>ws.send(v.toString()));input.on('close',()=>ws.terminate());const peer=new JsonPeer(input,output);peers.push(peer);const params=initializeParams();params.clientCapabilities={...caps};return {peer,initialized:peer.request('initialize',params)};};

 // 1. A client that asks for v2 receives v2, and the reply is backed by real connection state.
 const asking=await connect({webQrLogin:1,humanAuthorization:{version:2}}),asked=await asking.initialized;
 assert.deepEqual(asked.agentCapabilities.humanAuthorization,{version:2},'QR client requesting humanAuthorization v2 must be answered with v2');
 const askingState=connections.at(-1);assert.equal(askingState.humanAuthorization?.version,2,'Negotiated capability must be stored on this connection, not only advertised');
 assert.equal(asked.agentCapabilities.mvpHttpsVersion,2);assert.equal(asked.agentCapabilities.loginMethod,'dingtalk-qr');assert.equal(asked.authMethods[0].id,'dingtalk-device');

 // 2. Unsupported or malformed declarations are refused before any business, never silently upgraded.
 for(const value of [{version:1},{version:3},null,'2',{version:'2'}]){
  const bad=await connect({webQrLogin:1,humanAuthorization:value});
  await assert.rejects(bad.initialized,e=>e.code===-32012,'humanAuthorization '+JSON.stringify(value)+' must be rejected');
  const state=connections.at(-1);assert.equal(state.humanAuthorization,null,'Rejected declaration must not leave negotiated state behind');
  assert.equal(state.initialized,false,'Rejected initialization must not mark the connection initialized');
  bad.peer.close();
 }

 // 3. A legacy client that never asks stays exactly as before: no advertisement and no implicit upgrade.
 const legacy=await connect({webQrLogin:1}),legacyReply=await legacy.initialized;
 assert.equal(legacyReply.agentCapabilities.humanAuthorization,undefined,'Legacy client must not be advertised a capability it never requested');
 assert.equal(connections.at(-1).humanAuthorization,null,'Legacy client must not silently acquire v2 authority');

 // 4. Negotiation is per connection; a later client must not inherit the earlier one's state.
 const plain=await connect({webQrLogin:1});await plain.initialized;
 assert.equal(connections.at(-1).humanAuthorization,null,'Per-connection state must not leak between clients');
 // The first, already-negotiated connection keeps its own state while a new one is independent.
 assert.equal(askingState.humanAuthorization?.version,2,'Earlier connection must retain its own negotiated state');
});
