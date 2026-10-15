import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {IdentityStore,opaqueSecret} from '../src/identity-store.mjs';
import {LoginService} from '../src/login-service.mjs';
import {listenLoginHttp} from '../src/login-http.mjs';

function request(port,path,{host='login.example.test',cookie,method='GET'}={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path,method,headers:{host,...(cookie?{cookie}:{})}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',x=>body+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end();
  });
}

test('OAuth HTTP is route-only, loopback backend, host checked and browser never receives service credentials',async t=>{
  const db=openDatabase({path:':memory:'});
  const identities=new IdentityStore({db,serviceId:'s',corpId:'corp',clientId:'app'});
  identities.bind({account:'alice',userId:'user',unionId:'union'});
  const provider={exchange:async()=>({corpId:'corp',userId:'user',unionId:'union',internal:true})};
  const login=new LoginService({identities,provider,publicOrigin:'https://login.example.test'}),server=await listenLoginHttp(login);
  t.after(async()=>{await server.close();db.close();});const port=server.address.port;
  const proof=opaqueSecret(),start=login.start('alice','device',proof);
  const opened=await request(port,new URL(start.loginUrl).pathname);
  assert.equal(opened.status,302);assert.match(opened.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Lax/);
  assert.equal(opened.headers['cache-control'],'no-store');assert.equal(opened.headers['referrer-policy'],'no-referrer');
  const auth=new URL(opened.headers.location),state=auth.searchParams.get('state'),cookie=opened.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(port,`/collaboration/oauth/callback?state=${state}&code=ok`)).status,400);
  const callback=await request(port,`/collaboration/oauth/callback?state=${state}&code=ok`,{cookie});
  assert.equal(callback.status,303);assert.equal(callback.headers.location,'/collaboration/login-complete');
  const result=await login.claim('alice',{requestId:start.requestId,deviceId:'device',proof});
  assert.equal(result.status,'authenticated');assert.ok(!JSON.stringify(callback).includes(result.token));
  assert.equal((await request(port,'/api/dsh-im/delivery/messages',{method:'POST'})).status,400);
  assert.equal((await request(port,'/')).status,404);
  assert.equal((await request(port,'/collaboration/login-complete',{host:'attacker.example'})).status,400);
  assert.equal((await request(port,`/collaboration/oauth/callback?state=${state}&state=bad&code=ok`,{cookie})).status,400);
  await assert.rejects(listenLoginHttp(login,{host:'0.0.0.0'}));
});
