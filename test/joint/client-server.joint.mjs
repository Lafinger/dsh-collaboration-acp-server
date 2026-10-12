import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkbenchRuntime } from '../../src/workbench-runtime.mjs';
import { AccessStore } from '../../src/store.mjs';
import { AccountAuthority,issueTicket } from '../../src/authority.mjs';
import { AccessService } from '../../src/service.mjs';
import { listenAccess,connectAccess } from '../../src/transport.mjs';
import { createUserMessage,BlockAssembler } from '@deepseek-ai/dsh-llm';
const clientRoot=process.env.DSH_COLLABORATION_CLIENT_ROOT;
if(!clientRoot)throw new Error('Joint check only: set DSH_COLLABORATION_CLIENT_ROOT to the other repository');
const {MemberClient}=await import(pathToFileURL(resolve(clientRoot,'src/member-client.mjs')).href);
const {MemberAdapter}=await import(pathToFileURL(resolve(clientRoot,'src/member-plugin.mjs')).href);
test('versioned contract and wire helpers are byte-identical across independently owned repositories',()=>{
 assert.equal(readFileSync(new URL('../../docs/PROTOCOL-v1.json',import.meta.url),'utf8'),readFileSync(join(clientRoot,'docs/PROTOCOL-v1.json'),'utf8'));
 assert.equal(readFileSync(new URL('../../src/protocol.mjs',import.meta.url),'utf8'),readFileSync(join(clientRoot,'src/protocol.mjs'),'utf8'));
});
test('independent client adapter converses with real server runtime; no history replay on followup',async()=>{
 const root=mkdtempSync(join(tmpdir(),'collaboration-joint-'));const {runtime,workspace}=await createWorkbenchRuntime({workspace:join(root,'workspace'),stateRoot:join(root,'state'),fixture:true});
 const store=new AccessStore(join(root,'access.sqlite'));const secret='a'.repeat(64);
 const service=new AccessService({runtime,store,cwd:workspace,authority:new AccountAuthority({serviceId:'joint',accounts:{alice:secret}})});const listener=await listenAccess(service);
 const client=new MemberClient({databasePath:join(root,'client.sqlite'),account:'alice',serviceId:'joint',connect:async()=>{const peer=await connectAccess(listener.address);await peer.request('workbench/connect',{ticket:issueTicket({serviceId:'joint',account:'alice',secret})});return peer;}});
 const adapter=new MemberAdapter(client);const messages=[];
 try{for(const text of ['first','second']){messages.push(createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}));const assembled=new BlockAssembler();for await(const chunk of adapter.stream({provider:'workbench-remote',model:'server-agent',sessionId:'local',messages}))assembled.push(chunk);assert.equal(assembled.blocks()[0].text,`fixture:${text}`);assert.equal(assembled.finish.kind,'stop');}
 const remote=client.mapping('local').remote_id;assert.deepEqual(store.events(remote).filter(e=>e.update.sessionUpdate==='user_message_chunk').map(e=>e.update.content.text),['first','second']);
 await client.peer.request('session/close',{sessionId:remote});client.disconnect();await client.open('local');assert.equal(client.mapping('local').remote_id,remote);assert.equal(store.events(remote).filter(e=>e.update.sessionUpdate==='user_message_chunk').length,2);
 }finally{client.close();await listener.close();store.close();}
});
