import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import vm from 'node:vm';
import {listenMvpHttp} from '../src/mvp-transport.mjs';

test('served PC page shows official identity before explicit confirmation and clears fragment before calling platform',async t=>{
 const listener=await listenMvpHttp({identities:{serviceId:'test'}},{origin:'https://mvp.example'},{port:0});t.after(()=>listener.close());
 const text=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:listener.address.port,path:'/collaboration/pc-login',headers:{host:'mvp.example'}},res=>{let text='';res.setEncoding('utf8');res.on('data',v=>text+=v);res.on('end',()=>resolve(text));}).on('error',reject);});
 assert.ok(text.includes('/collaboration/pc-sdk.js'));assert.ok(!text.includes('g.alicdn.com'));
 const scripts=[...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);assert.equal(scripts.length,1);
 const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:true,disabled:false,value:''});return nodes.get(id);};const posts=[];let replaced=false,authCalls=0;
 const context={document:{getElementById:el},location:{hash:'#'+'a'.repeat(43),pathname:'/collaboration/pc-login'},history:{replaceState(){replaced=true;}},setTimeout(){return 1;},fetch:async(path,options)=>{
 posts.push(path);const value=path.endsWith('/bind')?{requestId:'id',corpId:'corp',clientId:'app',serviceId:'service',pairingCode:'A'.repeat(16)}:path.endsWith('/authorize')?{name:'Official Person',corpId:'corp',serviceId:'service'}:{name:'Official Person'};
 assert.equal(options.credentials,'same-origin');return Response.json({ok:true,value});
 },window:{dd:{env:{platform:'pc'},requestAuthCode({onSuccess}){authCalls++;return onSuccess({code:'once'});}}}};
 new vm.Script(scripts[0]).runInNewContext(context);for(let n=0;n<8;n++)await Promise.resolve();
 assert.equal(replaced,true);assert.equal(el('confirm').hidden,false);await el('confirm').onclick();for(let n=0;n<8;n++)await Promise.resolve();
 assert.equal(authCalls,1);assert.ok(el('status').textContent.includes('Official Person'));assert.equal(posts.includes('/collaboration/pc/confirm'),false,'Platform identity must be shown before explicit approval');
 await el('confirm').onclick();assert.equal(posts.at(-1),'/collaboration/pc/confirm');assert.ok(el('status').textContent.includes('原DSH'));await el('confirm').onclick();assert.equal(posts.filter(p=>p.endsWith('/confirm')).length,1);
});
