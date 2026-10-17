import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {RobotApplicationApi,RobotPlatformError,ROBOT_CALLBACK_TOPIC,ROBOT_TEXT_BUDGET_BYTES} from '../src/robot-api.mjs';
const binding={clientId:'fixture-message-app',clientSecret:'fixture-only-message-secret',robotCode:'fixture-robot'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const tokenReply=()=>json({accessToken:'fixture-message-token',expireIn:7200});
function fixture(handler,options={}){
  const calls=[];const api=new RobotApplicationApi({binding,fetchImpl:async(url,init)=>{const call={url,init,body:JSON.parse(init.body)};calls.push(call);assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.ok(init.signal instanceof AbortSignal);return handler(call,calls);},...options});return {api,calls};
}
test('the separate robot application owns token and single-recipient sampleText requests; no login config fallback',async()=>{
  assert.throws(()=>new RobotApplicationApi({dingtalk:{clientId:'fixture-original-login-app',clientSecret:'fixture-identity-secret'}}),error=>error instanceof RobotPlatformError&&error.kind==='invalid-robot-configuration');
  const f=fixture(call=>call.url.endsWith('/accessToken')?tokenReply():json({processQueryKey:'fixture-accepted-key',invalidStaffIdList:[]}));
  assert.deepEqual(await f.api.sendPrivateText('fixture-staff','Synthetic receipt'),{status:'accepted',acceptedKey:'fixture-accepted-key'});
  assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0].body,{appKey:binding.clientId,appSecret:binding.clientSecret});
  assert.equal(f.calls[1].url,'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend');assert.deepEqual(f.calls[1].body,{robotCode:binding.robotCode,userIds:['fixture-staff'],msgKey:'sampleText',msgParam:JSON.stringify({content:'Synthetic receipt'})});
  assert.equal(f.calls[1].init.headers['x-acs-dingtalk-access-token'],'fixture-message-token');assert.equal(JSON.stringify(f.api),'{}');assert.ok(!inspect(f.api).includes(binding.clientSecret));
});
test('a synchronous pre-send guard runs after token acquisition, so stale scope never reaches the message API',async()=>{
  let current=true;const f=fixture(call=>{if(call.url.endsWith('/accessToken')){current=false;return tokenReply();}return json({processQueryKey:'must-not-be-sent'});});
  const result=await f.api.sendPrivateText('fixture-a','Synthetic text',{beforeSend:()=>current});assert.equal(result.status,'retry-unsent');assert.equal(f.calls.length,1);
  for(const value of [1,Promise.reject(new Error('synthetic guard rejection'))]){const blocked=fixture(()=>tokenReply());assert.equal((await blocked.api.sendPrivateText('fixture-a','text',{beforeSend:()=>value})).status,'retry-unsent');assert.equal(blocked.calls.length,1);}
});
test('token acquisition is deduplicated in memory, bounded to official expiry and never causes a resend',async()=>{
  let now=1800000000000;const f=fixture(call=>call.url.endsWith('/accessToken')?tokenReply():json({processQueryKey:'fixture-key'}),{now:()=>now});
  await Promise.all([f.api.sendPrivateText('fixture-a','Synthetic A'),f.api.sendPrivateText('fixture-b','Synthetic B')]);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/accessToken')).length,1);assert.equal(f.calls.filter(call=>call.url.endsWith('/batchSend')).length,2);
  now+=7200000;await f.api.sendPrivateText('fixture-a','New synthetic intent');assert.equal(f.calls.filter(call=>call.url.endsWith('/accessToken')).length,2);assert.equal(f.calls.filter(call=>call.url.endsWith('/batchSend')).length,3);
});
test('invalid target and local UTF-8 budget fail before any credential or send request',async()=>{
  const f=fixture(()=>{throw new Error('must not fetch');});
  for(const [target,content] of [['','text'],['fixture-a\nfixture-b','text'],['fixture-a',''],['fixture-a','字'.repeat(Math.floor(ROBOT_TEXT_BUDGET_BYTES/3)+1)],['fixture-a','text\0hidden']])assert.equal((await f.api.sendPrivateText(target,content)).status,'failed');
  assert.equal(f.calls.length,0);
});
test('recipient rejection and explicit recipient throttling are distinguished from accepted or unknown',async()=>{
  for(const [reply,status] of [[{processQueryKey:'fixture-key',invalidStaffIdList:['fixture-a']},'failed'],[{filteredStaffIdList:['fixture-a']},'failed'],[{flowControlledStaffIdList:['fixture-a']},'retry-unsent'],[{},'unknown'],[{processQueryKey:'fixture-key',invalidStaffIdList:'invalid-shape'},'unknown'],[{processQueryKey:'fixture-key',invalidStaffIdList:['other-unrequested-staff']},'unknown']]){
    const f=fixture(call=>call.url.endsWith('/accessToken')?tokenReply():json(reply));assert.equal((await f.api.sendPrivateText('fixture-a','Synthetic text')).status,status);assert.equal(f.calls.length,2);
  }
});
test('only documented explicit rate rejection is retryable; 5xx, ambiguous 429 and network failure remain unknown without retry',async()=>{
  for(const [http,reply,status] of [[400,{code:'send.too.fast'},'retry-unsent'],[400,{code:'send.byToken.tooFast'},'retry-unsent'],[400,{code:'send.too.fast.byToken'},'failed'],[400,{code:'invalidParameter.msgParam.tooLong'},'failed'],[403,{code:'permission-denied'},'failed'],[500,{code:'server-error'},'unknown'],[429,{code:'undocumented-error'},'unknown']]){
    const f=fixture(call=>call.url.endsWith('/accessToken')?tokenReply():json(reply,http));assert.equal((await f.api.sendPrivateText('fixture-a','Synthetic text')).status,status);assert.equal(f.calls.length,2);
  }
  const f=fixture(call=>{if(call.url.endsWith('/accessToken'))return tokenReply();throw new Error('untrusted fixture provider text '+binding.clientSecret);});
  const result=await f.api.sendPrivateText('fixture-a','Synthetic text');assert.equal(result.status,'unknown');assert.ok(!JSON.stringify(result).includes(binding.clientSecret));assert.equal(f.calls.length,2);
});
test('credential failures happen before the send API and do not expose credentials or provider messages',async()=>{
  for(const [http,status] of [[403,'failed'],[500,'retry-unsent']]){const f=fixture(()=>json({code:'untrusted '+binding.clientSecret},http)),result=await f.api.sendPrivateText('fixture-a','text');assert.equal(result.status,status);assert.equal(f.calls.length,1);assert.ok(!JSON.stringify(result).includes(binding.clientSecret));}
});
test('oversize or malformed send replies are uncertain and never transparently retried',async()=>{
  for(const reply of [()=>new Response('not-json'),()=>json({padding:'x'.repeat(131073)})]){
    const f=fixture(call=>call.url.endsWith('/accessToken')?tokenReply():reply());assert.equal((await f.api.sendPrivateText('fixture-a','text')).status,'unknown');assert.equal(f.calls.length,2);
  }
});
test('gateway uses only the robot callback subscription and strict official endpoint with a memory-only ticket',async()=>{
  const f=fixture(()=>json({endpoint:'wss://wss-open-connection.dingtalk.com:443/connect',ticket:'fixture-one-use-ticket'}));const endpoint=await f.api.openConnection();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://api.dingtalk.com/v1.0/gateway/connections/open');assert.equal(f.calls[0].body.clientId,binding.clientId);assert.equal(f.calls[0].body.clientSecret,binding.clientSecret);assert.deepEqual(f.calls[0].body.subscriptions,[{type:'CALLBACK',topic:ROBOT_CALLBACK_TOPIC}]);assert.equal(endpoint.searchParams.get('ticket'),'fixture-one-use-ticket');assert.ok(!inspect(f.api).includes('fixture-one-use-ticket'));
});
test('gateway permanent credential/permission rejection does not request automatic reconnection',async()=>{
  for(const status of [400,401,403,404,429,500]){const f=fixture(()=>json({code:'synthetic-gateway-rejection'},status));await assert.rejects(f.api.openConnection(),error=>error instanceof RobotPlatformError&&error.retryable===![400,401,403,404].includes(status));assert.equal(f.calls.length,1);}
});
test('untrusted gateway endpoints are refused without fetching or opening them and without leaking provider data',async()=>{
  for(const endpoint of ['http://wss-open-connection.dingtalk.com/connect','wss://fixture-evil.example/connect','wss://wss-open-connection.dingtalk.com:444/connect','wss://user:password@wss-open-connection.dingtalk.com/connect','wss://wss-open-connection.dingtalk.com/connect?old=fixture-secret','wss://wss-open-connection.dingtalk.com/connect#fixture-secret','wss://wss-open-connection.dingtalk.com/other']){
    const f=fixture(()=>json({endpoint,ticket:'fixture-ticket'}));await assert.rejects(f.api.openConnection(),error=>error instanceof RobotPlatformError&&error.kind==='invalid-stream-endpoint'&&!String(error).includes('fixture-secret'));assert.equal(f.calls.length,1);
  }
});
