import test from 'node:test';
import assert from 'node:assert/strict';
import {DingTalkIdentityProvider} from '../src/dingtalk-identity.mjs';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {MvpIdentityStore} from '../src/mvp-identities.mjs';
import {LoginService} from '../src/login-service.mjs';
const config={corpId:'corp',clientId:'app',clientSecret:'secret'};

test('organization refresh rejects substituted or malformed identity and never trusts nickname/admin',async()=>{
  for(const detail of [{userid:'wrong',unionid:'union',active:true},{userid:'user',unionid:'wrong',active:true},{userid:'user',unionid:'union',admin:true,name:'user'}]){
    const p=new DingTalkIdentityProvider({...config,fetchImpl:async url=>Response.json(url.endsWith('/accessToken')?{accessToken:'token',expireIn:7200}:url.includes('/getbyunionid')?{errcode:0,result:{userid:'user',contact_type:0}}:{errcode:0,result:detail})});
    await assert.rejects(p.resolveUnion('union'),e=>e.code===-32003&&!e.message.includes('secret'));
  }
});
test('provider response bytes are capped during streaming instead of after unbounded allocation',async()=>{
  let reads=0;const p=new DingTalkIdentityProvider({...config,fetchImpl:async()=>new Response(new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(65536));if(reads>20)c.close();}}))});
  await assert.rejects(p.applicationToken(),e=>e.code===-32003);assert.ok(reads<10);
});
test('provider success error code accepts only absent or exact numeric/string zero, never coercible arrays or other values',async()=>{
  for(const errcode of [undefined,0,'0']){
    const p=new DingTalkIdentityProvider({...config,fetchImpl:async()=>Response.json({errcode,result:{synthetic:true}})});
    assert.deepEqual((await p.json('https://synthetic.example')).result,{synthetic:true});
  }
  for(const errcode of [[0],[],null,false,true,{},'00',' 0 ','',1]){
    const p=new DingTalkIdentityProvider({...config,fetchImpl:async()=>Response.json({errcode,result:{synthetic:true}})});
    await assert.rejects(p.json('https://synthetic.example'),error=>error.code===-32003&&error.qualificationRevoked!==true,JSON.stringify(errcode));
  }
});
const contactProvider=contactType=>new DingTalkIdentityProvider({...config,fetchImpl:async url=>Response.json(
  url.endsWith('/accessToken')?{accessToken:'synthetic-token',expireIn:7200}:
  url.includes('/getbyunionid')?{errcode:0,result:{userid:'user',contact_type:contactType}}:
  {errcode:0,result:{userid:'user',unionid:'union',active:false,name:'Synthetic'}})});
const malformedContactTypes=[[0],[1],[],[[1]],null,true,false,{},'01',' 1 ','',2,-1];
test('contact type accepts only documented number/string enums; malformed values never establish or revoke qualification',async()=>{
  for(const contactType of [0,'0'])assert.equal((await contactProvider(contactType).resolveUnion('union')).internal,true);
  for(const contactType of [1,'1'])await assert.rejects(contactProvider(contactType).resolveUnion('union'),error=>error.qualificationRevoked===true);
  for(const contactType of [...malformedContactTypes,undefined])await assert.rejects(contactProvider(contactType).resolveUnion('union'),error=>error.code===-32003&&error.qualificationRevoked!==true,JSON.stringify(contactType));
});
test('malformed contact types mark unknown without revoking existing devices, revising members or extending the old lease',async()=>{
  for(const contactType of malformedContactTypes){
    const db=openDatabase({path:':memory:'});let now=1800000000000;
    try{
      const identities=new MvpIdentityStore({db,serviceId:'synthetic-contact-matrix',corpId:'corp',clientId:'app',administratorUserId:'boss',now:()=>now});
      const member=identities.enroll({corpId:'corp',userId:'user',unionId:'union',internal:true,name:'Synthetic'}),old=identities.issueLogin(member.account,'synthetic-device');
      const login=new LoginService({identities,provider:contactProvider(contactType),publicOrigin:'https://synthetic.example',now:()=>now});
      now+=1000;await assert.rejects(login.refresh(member.account,{force:true}));
      assert.equal(identities.profile(member.account).qualification,'unknown');assert.equal(identities.profile(member.account).assignable,false);
      assert.equal(identities.member(member.account).revision,member.revision);assert.equal(identities.member(member.account).verified_until,member.verified_until);
      assert.equal(identities.verifyLogin(old.token,member.account,'synthetic-device').loginId,old.loginId);
      assert.equal(db.prepare('SELECT count(*) n FROM collaboration_role_qualifications').get().n,0);
      assert.equal(db.prepare("SELECT count(*) n FROM collaboration_security_audit WHERE action='member-qualification-revoked'").get().n,0);
    }finally{db.close();}
  }
});
