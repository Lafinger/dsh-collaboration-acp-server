import test from 'node:test';
import assert from 'node:assert/strict';
import {DingTalkIdentityProvider} from '../src/dingtalk-identity.mjs';
const config={corpId:'corp',clientId:'app',clientSecret:'secret'};

test('organization refresh rejects inactive or substituted employee identity and never trusts nickname/admin',async()=>{
  for(const detail of [{userid:'user',unionid:'union',active:false},{userid:'wrong',unionid:'union',active:true},{userid:'user',unionid:'wrong',active:true},{userid:'user',unionid:'union',admin:true,name:'user'}]){
    const p=new DingTalkIdentityProvider({...config,fetchImpl:async url=>Response.json(url.endsWith('/accessToken')?{accessToken:'token',expireIn:7200}:url.includes('/getbyunionid')?{errcode:0,result:{userid:'user',contact_type:0}}:{errcode:0,result:detail})});
    await assert.rejects(p.resolveUnion('union'),e=>e.code===-32003&&!e.message.includes('secret'));
  }
});
test('provider response bytes are capped during streaming instead of after unbounded allocation',async()=>{
  let reads=0;const p=new DingTalkIdentityProvider({...config,fetchImpl:async()=>new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(65536));if(reads>20)c.close();}}))});
  await assert.rejects(p.applicationToken(),e=>e.code===-32003);assert.ok(reads<10);
});
