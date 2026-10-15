import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {createHost} from './helpers/host.mjs';
import {DshRuntime} from '../src/dsh-runtime.mjs';
import {AccessService} from '../src/service.mjs';
import {AccessStore} from '../src/store.mjs';
import {installModelPolicy} from '../deploy/ubuntu/model-gate.mjs';
import {CPA_PROVIDER,CPA_MODEL} from '../deploy/ubuntu/model-config.mjs';

test('actual DSH and access service reproduce closed-gate greeting failure, admit a new authorized turn, and never replay the old request',async()=>{
 const root=mkdtempSync(join(tmpdir(),'collaboration-authorized-'));let calls=0,network=0;
 class Fixture extends LlmAdapter{async *stream(){calls++;yield{type:'block-start',index:0,blockType:'text'};yield{type:'text-delta',index:0,text:'OFFLINE_AUTHORIZED'};yield{type:'block-end',index:0,block:{type:'text',text:'OFFLINE_AUTHORIZED'}};yield{type:'finish',reason:{kind:'stop'}};}}
 const host=await createHost({root,provider:CPA_PROVIDER,model:CPA_MODEL,adapter:new Fixture()});let allowed=false;
 installModelPolicy(host.ctx,()=>({provider:CPA_PROVIDER,model:CPA_MODEL,modelRequestsAllowed:allowed}));
 const runtime=await new DshRuntime({ctx:host.ctx,provider:CPA_PROVIDER,model:CPA_MODEL}).start();
 const store=new AccessStore(':memory:'),service=new AccessService({authority:{},store,runtime,cwd:root});
 const id=randomUUID(),oldRequest=randomUUID(),connection={identity:{account:'synthetic-authorized-member',serviceId:'offline'},closed:false,initialized:true,peer:{closed:false,notify(){}}};
 const originalFetch=globalThis.fetch;globalThis.fetch=()=>{network++;throw new Error('External HTTP is forbidden in this regression');};
 try{
  store.create(id,connection.identity.account);await service.open(connection,id,false);
  const prompt=(text,requestId)=>service.prompt(connection,{sessionId:id,prompt:[{type:'text',text}],_meta:{requestId}});
  await assert.rejects(prompt('你好',oldRequest),error=>error.code===-32009&&error.message==='Prompt failed; some operations may already have committed. No automatic retry.'&&error.data.cause==='MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE');
  assert.equal(store.status(id).state,'unknown');assert.equal(calls,0);
  await service.detach(service.sessions.get(id));allowed=true;await service.open(connection,id,true);
  assert.equal(calls,0,'Resuming after authorization must clear any old pending inbox');assert.equal(store.status(id).state,'unknown');
  await assert.rejects(prompt('你好',oldRequest),error=>error.code===-32005);assert.equal(calls,0);
  assert.deepEqual(await prompt('New explicitly authorized synthetic control',randomUUID()),{stopReason:'end_turn'});assert.equal(calls,1);assert.equal(network,0);
  allowed=false;await assert.rejects(prompt('Closed again',randomUUID()),error=>error.data.cause==='MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE');assert.equal(calls,1);
 }finally{globalThis.fetch=originalFetch;await service.close();store.close();await host.close();}
});
