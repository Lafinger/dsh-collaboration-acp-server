import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {inspect} from 'node:util';
import {RobotStream} from '../src/robot-stream.mjs';
import {RobotPlatformError,ROBOT_CALLBACK_TOPIC} from '../src/robot-api.mjs';
const binding={scopeKey:'synthetic-scope',corpId:'synthetic-corp',robotCode:'synthetic-robot'};
function timers(){const pending=new Set();return {pending,setTimeout(fn,ms){const timer={fn,ms,unref(){return this;}};pending.add(timer);return timer;},clearTimeout(timer){pending.delete(timer);},run(){const timer=[...pending][0];assert.ok(timer);pending.delete(timer);timer.fn();return timer.ms;}};}
function fixture({onEvent,onState,openConnection}={}){
  let now=1800000000000,calls=0,stops=0;const clock=timers(),sockets=[],handled=[],states=[];
  class Socket extends EventEmitter{
    readyState=0;sent=[];
    constructor(endpoint,options){super();this.endpoint=String(endpoint);this.options=options;sockets.push(this);}
    open(){this.readyState=1;this.emit('open');}
    send(text,callback){this.sent.push(JSON.parse(text));callback?.();}
    close(){this.readyState=3;this.emit('close');}
    terminate(){this.close();}
    frame(frame){this.emit('message',Buffer.from(JSON.stringify(frame)),false);}
  }
  const api={openConnection:async()=>{calls++;return openConnection?openConnection(calls):new URL('wss://wss-open-connection.dingtalk.com/connect?ticket=synthetic-ticket-'+calls);},stop(){stops++;}};
  const stream=new RobotStream({api,binding,WebSocketImpl:Socket,timers:clock,now:()=>now,random:()=>0.5,onEvent:onEvent??((event,source)=>{handled.push({event,source});return {ack:true};}),onState:(state,source)=>{states.push(state);return onState?.(state,source);}});
  const frame=(createdAt=now,overrides={})=>({type:'CALLBACK',headers:{topic:ROBOT_CALLBACK_TOPIC,messageId:'synthetic-outer-id'},data:JSON.stringify({robotCode:binding.robotCode,chatbotCorpId:binding.corpId,senderCorpId:binding.corpId,conversationType:'1',msgtype:'text',senderStaffId:'synthetic-staff',msgId:'synthetic-inner-msg',createAt:createdAt,text:{content:'同意 ABCDEFGH'},senderNick:'Untrusted nickname',...overrides})});
  return {stream,api,sockets,clock,handled,states,frame,now:()=>now,advance:ms=>{now+=ms;},calls:()=>calls,stops:()=>stops};
}

test('only strict official TLS WebSocket options and a post-open frozen private connection lease are used',async()=>{
  const f=fixture();await f.stream.start();assert.equal(f.calls(),1);const socket=f.sockets[0];assert.equal(f.stream.currentSource(),null);assert.equal(socket.options.followRedirects,false);assert.equal(socket.options.rejectUnauthorized,true);assert.equal(socket.options.perMessageDeflate,false);assert.equal(socket.options.maxPayload,65536);assert.equal(socket.options.handshakeTimeout,10000);
  f.advance(500);socket.open();const source=f.stream.currentSource();assert.equal(source.notBefore,f.now());assert.equal(source.scopeKey,binding.scopeKey);assert.equal(Object.isFrozen(source),true);assert.equal(f.stream.isCurrent({...source}),false);assert.ok(!inspect(f.stream).includes('synthetic-ticket'));assert.ok(!JSON.stringify(f.stream.status()).includes('ticket'));await f.stream.close();assert.equal(f.stream.isCurrent(source),false);assert.equal(f.stops(),1);
});
test('callback ACK is sent only after synchronous durable processing, echoes outer id and never claims approval',async()=>{
  const order=[],f=fixture({onEvent:()=>{order.push('durable-receipt');return {ack:true,work:Promise.resolve({status:'not-an-ack'})};}});await f.stream.start();const socket=f.sockets[0];socket.open();const send=socket.send.bind(socket);socket.send=(text,callback)=>{assert.deepEqual(order,['durable-receipt']);send(text,callback);};socket.frame(f.frame());assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].headers.messageId,'synthetic-outer-id');assert.deepEqual(JSON.parse(socket.sent[0].data),{response:null});assert.equal(f.stream.status().callbacksHandled,1);assert.equal(Object.hasOwn(f.stream.status(),'accepted'),false);await f.stream.close();
});
test('reconnect uses a new ticket and lease, rejects messages created in the disconnected gap and never reuses an old source',async()=>{
  const f=fixture();await f.stream.start();f.sockets[0].open();const old=f.stream.currentSource();f.sockets[0].frame(f.frame());assert.equal(f.handled.length,1);f.sockets[0].close();assert.equal(f.stream.isCurrent(old),false);assert.equal(f.clock.pending.size,1);assert.equal(f.clock.run(),1000);await f.stream.start();assert.equal(f.calls(),2);assert.notEqual(f.sockets[0].endpoint,f.sockets[1].endpoint);
  const inGap=f.now();f.advance(100);f.sockets[1].open();const current=f.stream.currentSource();assert.notEqual(current.connectionId,old.connectionId);f.sockets[1].frame(f.frame(inGap));assert.equal(f.handled.length,1);f.sockets[1].frame(f.frame());assert.equal(f.handled.length,2);assert.equal(f.stream.isCurrent(old),false);assert.equal(f.stream.isCurrent(current),true);await f.stream.close();assert.equal(f.clock.pending.size,0);
});
test('native SYSTEM ping data is acknowledged opaquely and never treated as a business callback',async()=>{
  const f=fixture();await f.stream.start();const socket=f.sockets[0];socket.open();const opaque=JSON.stringify({opaque:'synthetic-ping-nonce'});socket.frame({type:'SYSTEM',headers:{topic:'ping',messageId:'synthetic-ping-id'},data:opaque});assert.equal(socket.sent[0].data,opaque);assert.equal(socket.sent[0].headers.messageId,'synthetic-ping-id');assert.equal(f.handled.length,0);await f.stream.close();
});
test('storage/durability failure receives no ACK, retires its lease and schedules at most one controlled reconnect',async()=>{
  const f=fixture({onEvent:()=>{throw Error('raw synthetic URL with ticket must not be logged');}});await f.stream.start();const socket=f.sockets[0];socket.open();const source=f.stream.currentSource();socket.frame(f.frame());assert.equal(socket.sent.length,0);assert.equal(f.stream.isCurrent(source),false);assert.equal(f.clock.pending.size,1);assert.ok(!f.states.join(' ').includes('ticket'));await f.stream.close();assert.equal(f.clock.pending.size,0);await f.stream.start();assert.equal(f.calls(),1);
});
test('an async rejecting callback cannot ACK or leak an unhandled rejection into the DSH process',async()=>{
  const f=fixture({onEvent:async()=>{throw Error('synthetic unsupported async handler');}});await f.stream.start();const socket=f.sockets[0];socket.open();socket.frame(f.frame());assert.equal(socket.sent.length,0);assert.equal(f.stream.status().connected,false);await f.stream.close();await new Promise(resolve=>setImmediate(resolve));
});
test('permanent gateway and untrusted endpoint rejection stop retries while temporary gateway failure backs off without a socket',async()=>{
  for(const failure of [new RobotPlatformError('synthetic-permanent',false),'wss://synthetic-evil.example/connect?ticket=synthetic']){
    const f=fixture({openConnection:async()=>{if(failure instanceof Error)throw failure;return failure;}});await f.stream.start();assert.equal(f.sockets.length,0);assert.equal(f.stream.status().state,'blocked');assert.equal(f.clock.pending.size,0);await f.stream.close();
  }
  const f=fixture({openConnection:async()=>{throw new RobotPlatformError('synthetic-temporary',true);}});await f.stream.start();assert.equal(f.clock.pending.size,1);assert.equal(f.sockets.length,0);assert.equal(f.clock.run(),1000);await f.stream.start();assert.equal([...f.clock.pending][0].ms,2000);await f.stream.close();assert.equal(f.clock.pending.size,0);
});
test('a stable connection resets backoff even when an error retires its lease before the close event',async()=>{
  const f=fixture();await f.stream.start();f.sockets[0].open();f.sockets[0].close();assert.equal(f.clock.run(),1000);await f.stream.start();const socket=f.sockets[1];socket.open();f.advance(30001);socket.emit('error',new Error('synthetic transport failure'));assert.equal([...f.clock.pending][0].ms,1000);await f.stream.close();
});
test('foreign scope is deliberately ignored, while binary or oversized frames retire the lease without touching a handler',async()=>{
  const f=fixture();await f.stream.start();const socket=f.sockets[0];socket.open();socket.frame(f.frame(f.now(),{senderCorpId:'synthetic-other-corp'}));assert.equal(f.handled.length,0);assert.equal(socket.sent.length,1);socket.emit('message',Buffer.from('{}'),true);assert.equal(f.handled.length,0);assert.equal(socket.sent.length,1);assert.equal(f.stream.status().connected,false);await f.stream.close();
  const large=fixture();await large.stream.start();large.sockets[0].open();large.sockets[0].emit('message',Buffer.alloc(65537,120),false);assert.equal(large.handled.length,0);assert.equal(large.sockets[0].sent.length,0);assert.equal(large.stream.status().connected,false);await large.stream.close();
});
test('stop invalidates an in-flight gateway open before its ticket can create a socket and never restarts a stopped instance',async()=>{
  let release;const f=fixture({openConnection:()=>new Promise(resolve=>{release=resolve;})}),starting=f.stream.start(),closing=f.stream.close();assert.equal(f.stops(),1);release(new URL('wss://wss-open-connection.dingtalk.com/connect?ticket=synthetic-late'));await starting;await closing;assert.equal(f.sockets.length,0);assert.equal(f.clock.pending.size,0);assert.equal(f.stream.status().state,'stopped');await f.stream.start();assert.equal(f.calls(),1);
});
