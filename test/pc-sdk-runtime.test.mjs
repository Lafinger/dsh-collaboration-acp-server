// Execute the exact served official bundle. Only the desktop native bridge is synthetic; no API/network/user login.
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';

test('committed official PC SDK exports the callable auth API and traverses its native PC message bridge',async()=>{
 const posted=[],listeners=[];
 const browser={name:JSON.stringify({containerId:'offline-pc',hostOrigin:'https://h5.dingtalk.com',hostVersion:'9.0.1'}),location:{href:'https://offline.example/collaboration/pc-login'},navigator:{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/116.0.0.0 Safari/537.36 DingTalk/9.0.1'},localStorage:{},XMLHttpRequest:function(){},addEventListener(type,fn){if(type==='message')listeners.push(fn);},postMessage(value,target){posted.push({value,target});},console,setTimeout,clearTimeout,dingtalk:{platform:{invokeAPI(){}}}};
 browser.window=browser;browser.self=browser;browser.top=browser;
 const context=vm.createContext(browser);new vm.Script(readFileSync(new URL('../assets/dingtalk-pc.js',import.meta.url),'utf8')).runInContext(context);
 assert.equal(typeof browser.dd.requestAuthCode,'function','The served PC page must be able to call the actual bundled official API');assert.equal(browser.dd.env.platform,'pc');
 let callback;const task=browser.dd.requestAuthCode({corpId:'offline-corp',clientId:'offline-app',onSuccess(value){callback=value;},onFail(){assert.fail('Offline native bridge should respond successfully');}});
 for(let n=0;n<24;n++)await Promise.resolve();assert.equal(posted.length,1);const {value,target}=posted[0];assert.equal(value.methodName,'runtime.permission.requestAuthCodeV2');assert.equal(target,'https://h5.dingtalk.com');assert.equal(value.body.corpId,'offline-corp');assert.equal(value.body.clientId,'offline-app');
 for(const fn of listeners)fn({origin:target,data:{type:'response',msgId:value.msgId,success:true,body:{code:'OFFLINE-SYNTHETIC-CODE'}}});
 const result=await task;assert.equal(result.code,'OFFLINE-SYNTHETIC-CODE');assert.equal(callback.code,result.code);
});
