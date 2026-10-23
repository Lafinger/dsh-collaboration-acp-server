import WebSocket from 'ws';
import {randomUUID} from 'node:crypto';
import {RobotPlatformError} from './robot-api.mjs';
import {normalizeRobotEvent,robotAcknowledgement} from './robot-events.mjs';

/** One private outbound Stream. No business execution, endpoint persistence or SDK auto-retry.
 * onEvent must synchronously persist/ignore before returning {ack:true}; returned work is not ACK.
 * Every connection owns a distinct frozen source lease. Old work must capture that lease.
 */
export class RobotStream{
  #api;#binding;#onEvent;#onState;#WebSocket;#now;#timers;#random;
  #running=false;#stopped=false;#socket=null;#source=null;#openedAt=null;#opening=null;#closing=null;
  #retryTimer=null;#killTimer=null;#attempt=0;#state='idle';#counts={frames:0,callbacksHandled:0,ignored:0};
  constructor({api,binding,onEvent,onState=()=>{},WebSocketImpl=WebSocket,now=Date.now,timers={setTimeout,clearTimeout},random=Math.random}){
    if(typeof api?.openConnection!=='function'||typeof onEvent!=='function'||!binding?.scopeKey||!binding.corpId||!binding.robotCode)throw new Error('Robot Stream configuration unavailable');
    this.#api=api;this.#binding=Object.freeze({scopeKey:binding.scopeKey,corpId:binding.corpId,robotCode:binding.robotCode});this.#onEvent=onEvent;this.#onState=onState;this.#WebSocket=WebSocketImpl;this.#now=now;this.#timers=timers;this.#random=random;
  }
  status(){return {state:this.#state,connected:this.isCurrent(this.#source),...this.#counts};}
  currentSource(){return this.isCurrent(this.#source)?this.#source:null;}
  isCurrent(source){return this.#running&&source!==null&&source===this.#source&&this.#socket?.readyState===1;}
  #report(state){if(this.#state===state)return;this.#state=state;try{const value=this.#onState(state,this.currentSource());if(value?.then)void Promise.resolve(value).catch(()=>{});}catch{/* Diagnostics never crash the original DSH runtime. */}}
  start(){if(this.#stopped)return Promise.resolve();if(this.#running)return this.#opening??Promise.resolve();this.#running=true;return this.#begin();}
  #begin(){const opening=this.#connect();this.#opening=opening;void opening.finally(()=>{if(this.#opening===opening)this.#opening=null;}).catch(()=>{});return opening;}
  async #connect(){
    if(!this.#running||this.#socket)return;
    this.#report('connecting');
    try{
      const raw=await this.#api.openConnection();if(!this.#running)return;
      const endpoint=new URL(raw);
      if(endpoint.protocol!=='wss:'||endpoint.hostname!=='wss-open-connection.dingtalk.com'||endpoint.port&&endpoint.port!=='443'||endpoint.pathname!=='/connect'||endpoint.username||endpoint.password||endpoint.hash||[...endpoint.searchParams.keys()].some(key=>key!=='ticket')||endpoint.searchParams.getAll('ticket').length!==1||!endpoint.searchParams.get('ticket')||endpoint.searchParams.get('ticket').length>8192)throw new RobotPlatformError('invalid-stream-endpoint');
      const socket=new this.#WebSocket(endpoint,{followRedirects:false,rejectUnauthorized:true,perMessageDeflate:false,maxPayload:65536,handshakeTimeout:10000});this.#socket=socket;
      socket.on('open',()=>{
        if(!this.#running||this.#socket!==socket){try{socket.terminate();}catch{}return;}
        this.#openedAt=this.#now();this.#source=Object.freeze({scopeKey:this.#binding.scopeKey,notBefore:this.#openedAt,connectionId:randomUUID()});this.#report('connected');
      });
      socket.on('message',(data,isBinary)=>this.#message(socket,data,isBinary));
      socket.on('error',()=>this.#retire(socket));
      socket.on('close',()=>this.#closed(socket));
    }catch(error){if(!this.#running)return;if(error instanceof RobotPlatformError&&!error.retryable){this.#report('blocked');return;}this.#retry();}
  }
  #retry(){
    if(!this.#running||this.#retryTimer)return;
    const base=Math.min(300000,1000*2**Math.min(this.#attempt,10)),delay=Math.min(300000,Math.max(1,Math.round(base*(0.8+this.#random()*0.4))));this.#attempt=Math.min(this.#attempt+1,11);this.#report('retrying');
    this.#retryTimer=this.#timers.setTimeout(()=>{this.#retryTimer=null;void this.#begin();},delay);this.#retryTimer?.unref?.();
  }
  #retire(socket){
    if(this.#socket!==socket)return;
    this.#source=null;this.#report('disconnected');
    if(socket.readyState===3){this.#closed(socket);return;}
    try{socket.close(1000,'entry-paused');}catch{try{socket.terminate();}catch{}}
    if(socket.readyState!==3&&!this.#killTimer){this.#killTimer=this.#timers.setTimeout(()=>{this.#killTimer=null;try{socket.terminate();}catch{}},2000);this.#killTimer?.unref?.();}
  }
  #closed(socket){
    if(this.#socket!==socket)return;
    if(this.#openedAt!==null&&this.#now()-this.#openedAt>=30000)this.#attempt=0;this.#openedAt=null;
    this.#source=null;this.#socket=null;if(this.#killTimer){this.#timers.clearTimeout(this.#killTimer);this.#killTimer=null;}
    this.#report('disconnected');if(this.#running)this.#retry();
  }
  #send(socket,value){if(!value||socket!==this.#socket||socket.readyState!==1)return;try{socket.send(JSON.stringify(value),error=>{if(error)this.#retire(socket);});}catch{this.#retire(socket);}}
  #message(socket,data,isBinary){
    if(socket!==this.#socket||!this.isCurrent(this.#source))return;
    this.#counts.frames++;
    if(isBinary||!(typeof data==='string'||Buffer.isBuffer(data))||Buffer.byteLength(data)>65536){this.#counts.ignored++;this.#retire(socket);return;}
    let frame;try{frame=JSON.parse(data.toString());}catch{this.#counts.ignored++;return;}
    if(frame?.type==='SYSTEM'){
      if(frame.headers?.topic==='ping'&&typeof frame.data==='string'){const ack=robotAcknowledgement(frame);if(ack){ack.data=frame.data;this.#send(socket,ack);}return;}
      if(frame.headers?.topic==='disconnect'){this.#send(socket,robotAcknowledgement(frame));this.#retire(socket);}return;
    }
    const source=this.#source,normalized=normalizeRobotEvent(frame,this.#binding,source,{now:this.#now()});
    if(!normalized.ok){this.#counts.ignored++;this.#send(socket,robotAcknowledgement(frame));return;}
    try{
      const result=this.#onEvent(normalized.event,source);
      if(result?.then){void Promise.resolve(result).catch(()=>{});throw new Error('Synchronous durable callback required');}
      if(result?.ack!==true)throw new Error('Durable callback acknowledgement unavailable');
      this.#counts.callbacksHandled++;this.#send(socket,robotAcknowledgement(frame));
    }catch{this.#retire(socket);/* No ACK when durable processing was not confirmed. */}
  }
  close(){
    if(this.#closing)return this.#closing;
    this.#stopped=true;this.#running=false;this.#source=null;
    if(this.#retryTimer){this.#timers.clearTimeout(this.#retryTimer);this.#retryTimer=null;}
    try{this.#api.stop?.();}catch{}
    const socket=this.#socket,closed=socket&&socket.readyState!==3?new Promise(resolve=>socket.once('close',resolve)):Promise.resolve();
    if(socket)this.#retire(socket);
    return this.#closing=(async()=>{await this.#opening;await closed;this.#report('stopped');})();
  }
}
