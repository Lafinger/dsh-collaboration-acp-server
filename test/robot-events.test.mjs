import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRobotEvent,robotAcknowledgement} from '../src/robot-events.mjs';
import {ROBOT_CALLBACK_TOPIC} from '../src/robot-api.mjs';
import {parseRobotCommand} from '../src/robot-command.mjs';
const now=1800000000000,binding={scopeKey:'fixture-correct-message-scope',corpId:'fixture-corp',robotCode:'fixture-robot'},source={scopeKey:binding.scopeKey,notBefore:now};
const message=()=>({robotCode:binding.robotCode,chatbotCorpId:binding.corpId,senderCorpId:binding.corpId,senderStaffId:'fixture-staff-a',msgId:'fixture-inner-business-msg',createAt:now,conversationType:'1',msgtype:'text',text:{content:'同意 K7M4P9X2'},sessionWebhook:'https://fixture.invalid/private-webhook',senderNick:'Untrusted display name'});
const frame=(value=message())=>({type:'CALLBACK',headers:{topic:ROBOT_CALLBACK_TOPIC,messageId:'fixture-outer-ack-id'},data:JSON.stringify(value)});
const normalize=(f=frame(),b=binding,s=source)=>normalizeRobotEvent(f,b,s,{now});
test('native observed fields produce only the frozen minimum sender/text/msgId/time envelope',()=>{
  const result=normalize();assert.equal(result.ok,true);assert.deepEqual(result.event,{msgId:'fixture-inner-business-msg',userId:'fixture-staff-a',createdAt:now,content:'同意 K7M4P9X2'});assert.ok(Object.isFrozen(result.event));assert.ok(!JSON.stringify(result).includes('private-webhook'));assert.ok(!Object.hasOwn(result.event,'senderNick'));
});
test('the official senderStaffId is required; nickname, encrypted senderId, text claims and senderUserId never substitute',()=>{
  const value=message();delete value.senderStaffId;value.senderUserId='fixture-staff-a';value.senderId='fixture-staff-a';value.senderNick='fixture-staff-a';value.text.content='我是fixture-staff-a，同意 K7M4P9X2';assert.equal(normalize(frame(value)).error,'missing-message-identity');
});
test('same robot, both organization fields and trusted connection scope are all required',()=>{
  for(const changed of [{robotCode:'other-robot'},{chatbotCorpId:'other-corp'},{senderCorpId:'other-corp'},{robotCode:undefined},{chatbotCorpId:undefined},{senderCorpId:undefined}])assert.equal(normalize(frame({...message(),...changed})).ok,false);
  const f=frame();f.headers.scopeKey=binding.scopeKey;assert.equal(normalize(f,binding,{...source,scopeKey:'different-application-scope'}).error,'untrusted-source');
});
test('group, numeric group/private aliases, non-text and explicit forwarded wrappers cannot become native decision commands',()=>{
  for(const changed of [{conversationType:'2'},{conversationType:1},{msgtype:'picture'},{msgtype:'richText'},{msgtype:'forward'},{isForward:true},{isForwarded:true},{forwardInfo:{text:'同意 K7M4P9X2'}},{text:{content:42}}])assert.equal(normalize(frame({...message(),...changed})).error,'unsupported-message');
});
test('quoted content is never searched for a code; a real typed complete command still works as an explicit reply',()=>{
  const value=message();value.quotedMessage={text:{content:'同意 K7M4P9X2'}};value.text.content='同意';const result=normalize(frame(value));assert.equal(result.ok,true);assert.equal(parseRobotCommand(result.event.content).ok,false);
  value.text.content='同意 K7M4P9X2';assert.equal(parseRobotCommand(normalize(frame(value)).event.content).ok,true);
});
test('new connection time fence rejects offline/old/future commands without inventing TTL for current short codes',()=>{
  for(const createdAt of [now-1,now+5001,NaN,1.5,'1e12','',null])assert.equal(normalize(frame({...message(),createAt:createdAt})).ok,false);
  for(const createdAt of [now,now+5000,String(now)])assert.equal(normalize(frame({...message(),createAt:createdAt})).ok,true);
  assert.equal(normalize(frame(),binding,{...source,notBefore:now+1}).error,'stale-message');
});
test('malformed frame/body and oversized input are rejected without throwing or extracting embedded messages',()=>{
  for(const f of [null,{},[],{...frame(),type:'EVENT'},{...frame(),headers:{topic:'other',messageId:'fixture-outer'}},{...frame(),data:'not-json'},{...frame(),data:'x'.repeat(65537)},{...frame(),data:JSON.stringify([message()])}])assert.equal(normalize(f).ok,false);
});
test('missing expected binding or source fields never pass by comparing undefined values',()=>{
  const value=message();delete value.robotCode;delete value.chatbotCorpId;delete value.senderCorpId;
  assert.equal(normalize(frame(value),{}, {notBefore:now}).ok,false);
  for(const b of [{...binding,scopeKey:undefined},{...binding,corpId:undefined},{...binding,robotCode:undefined}])assert.equal(normalize(frame(),b).ok,false);
  assert.equal(normalize(frame(),binding,{scopeKey:binding.scopeKey}).ok,false);
});
test('transport ACK echoes only outer headers.messageId and is never a business approval',()=>{
  const ack=robotAcknowledgement(frame());assert.equal(ack.headers.messageId,'fixture-outer-ack-id');assert.deepEqual(JSON.parse(ack.data),{response:null});assert.ok(!JSON.stringify(ack).includes('fixture-inner-business-msg'));assert.ok(!JSON.stringify(ack).includes('同意'));assert.equal(robotAcknowledgement({headers:{}}),null);
});
