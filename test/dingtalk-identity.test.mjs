import test from 'node:test';
import assert from 'node:assert/strict';
import {DingTalkIdentityProvider} from '../src/dingtalk-identity.mjs';

test('official OAuth identity mapping uses selected corp and internal scoped union conversion, no encrypted sender fallback or refresh retention',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/userAccessToken'))return Response.json({corpId:'corp',accessToken:'user-private',refreshToken:'must-not-store',expireIn:7200});
    if(url.endsWith('/users/me'))return Response.json({unionId:'union',nick:'ignored',mobile:'ignored'});
    if(url.endsWith('/accessToken'))return Response.json({accessToken:'app-private',expireIn:7200});
    if(url.includes('/getbyunionid'))return Response.json({errcode:0,result:{contact_type:0,userid:'user'}});
    if(url.includes('/v2/user/get?'))return Response.json({errcode:0,result:{userid:'user',unionid:'union',active:true}});
    throw new Error('Unknown endpoint');
  };
  const p=new DingTalkIdentityProvider({corpId:'corp',clientId:'app',clientSecret:'private',fetchImpl});
  const identity=await p.exchange('one-use-code');assert.deepEqual(identity,{corpId:'corp',userId:'user',unionId:'union',internal:true});
  assert.ok(!JSON.stringify(p).includes('must-not-store'));assert.ok(calls.every(c=>c.options.redirect==='error'));assert.ok(calls.every(c=>c.url.startsWith('https://api.dingtalk.com/')||c.url.startsWith('https://oapi.dingtalk.com/')));
  const external=new DingTalkIdentityProvider({corpId:'corp',clientId:'app',clientSecret:'private',fetchImpl:async url=>url.endsWith('/accessToken')?Response.json({accessToken:'t',expireIn:7200}):Response.json({errcode:0,result:{contact_type:1,userid:'external'}})});
  await assert.rejects(external.resolveUnion('union'),e=>e.code===-32003);
  const wrongCorp=new DingTalkIdentityProvider({corpId:'corp',clientId:'app',clientSecret:'private',fetchImpl:async()=>Response.json({corpId:'other',accessToken:'secret'})});await assert.rejects(wrongCorp.exchange('c'));
});
