import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {LlmRuntime,createUserMessage,createAssistantMessage,createToolResultMessage,ToolCallId} from '@deepseek-ai/dsh-llm';
import {LocalAttachmentStore} from '@deepseek-ai/dsh-attachment-local';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {cpaProviderConfig,CPA_PROVIDER,CPA_MODEL,CPA_BASE_URL} from '../deploy/ubuntu/model-config.mjs';
import * as hostCpa from '../deploy/ubuntu/host-cpa.mjs';

test('fixed official CPA adapter assembles Responses tool-result image with no retries and no external HTTP',async()=>{
 const ctx=new Context(),root=mkdtempSync(join(tmpdir(),'cpa-offline-'));const originalFetch=globalThis.fetch;let requests=0,body;
 // A transport stub consumes the complete actual protocol request. It never invokes a socket.
 globalThis.fetch=async(input,init)=>{
  requests++;const request=new Request(input,init);assert.equal(request.url,CPA_BASE_URL+'/responses');body=await request.json();
  return new Response(JSON.stringify({error:{message:'Synthetic offline transport rejection',type:'invalid_request_error'}}),{status:503,headers:{'content-type':'application/json'}});
 };
 try{
  const llm=ctx.plugin(LlmRuntime),store=ctx.plugin(LocalAttachmentStore,{dshHome:root,normalizedImageMaxDimension:2048,normalizedImageMaxBytes:1048576});await llm.await();await store.await();
  ctx.provide('credentials',{resolve:async ref=>{assert.equal(ref,'CPA_API_KEY');return {value:'synthetic-offline-key-not-valid'};}});
  const host=ctx.plugin(hostCpa);await host.await();assert.equal(host.ctx.get('collaborationCpaReady'),true);
  const info=await ctx.llm.resolveModelInfo(CPA_PROVIDER,CPA_MODEL);assert.ok(info.inputModalities.includes('image'));
  const ref=await ctx.attachments.saveImage({data:await sharp({create:{width:2,height:1,channels:3,background:'#f00'}}).png().toBuffer(),mediaType:'image/png',name:'synthetic.png'}),id=ToolCallId('call_synthetic');
  const messages=[createUserMessage({content:[{type:'text',text:'Read explicitly selected synthetic image'}],source:{kind:'user'}}),createAssistantMessage({content:[{type:'tool-call',id,name:'attachment_inspect',arguments:'{}'}],source:{provider:CPA_PROVIDER,model:CPA_MODEL}}),createToolResultMessage({callId:id,isError:false,content:[{type:'text',text:'Synthetic attachment'},{type:'image',attachment:ref}]})];
  const chunks=[];for await(const chunk of ctx.llm.stream({provider:CPA_PROVIDER,model:CPA_MODEL,messages,signal:AbortSignal.timeout(5000)}))chunks.push(chunk);
  assert.equal(chunks.at(-1)?.reason?.kind,'error');assert.equal(requests,1);
  assert.equal(body.model,CPA_MODEL);assert.equal(body.stream,true);assert.equal(body.reasoning,undefined);
  assert.ok(JSON.stringify(body).includes('data:image/'));assert.ok(JSON.stringify(body).includes('input_image'));
  assert.equal(cpaProviderConfig.providers.cpa.retryPolicy.maxRetries,0);assert.equal(ctx.llm.listProviders().some(p=>p.id==='codego'),false);assert.ok(body);
  const omitted=[...messages.slice(0,-1),createToolResultMessage({callId:id,isError:false,content:[{type:'image',attachment:ref,offloaded:true}]})];
  for await(const _chunk of ctx.llm.stream({provider:CPA_PROVIDER,model:CPA_MODEL,messages:omitted,signal:AbortSignal.timeout(5000)})){}
  assert.equal(requests,2);assert.ok(!JSON.stringify(body).includes('data:image/'));assert.ok(!JSON.stringify(body).includes('input_image'));assert.match(JSON.stringify(body),/image omitted to fit request image limits/);
  await host.dispose();assert.equal(ctx.llm.listProviders().some(p=>p.id==='cpa'),false);
 }finally{globalThis.fetch=originalFetch;await ctx.fiber.dispose();}
});
