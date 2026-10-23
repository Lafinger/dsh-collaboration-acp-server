import {readRobotBinding} from './robot-config.mjs';
import {RobotStore,robotMetadataHash} from './robot-store.mjs';
import {RobotProjection} from './robot-projection.mjs';
import {RobotDecisionExecutor} from './robot-decisions.mjs';
import {RobotApplicationApi} from './robot-api.mjs';
import {RobotStream} from './robot-stream.mjs';
import {formatRobotNotification} from './robot-format.mjs';

/** Optional QR-only adapter. No Agent/session/model, second business store or general IM tools.
 * Injection points are trusted Node test seams, never configuration or public RPC fields.
 */
export class RobotRuntime{
  #args;#read;#apiFactory;#streamFactory;#timers;#session=null;#poll=null;#tick=null;#closing=null;#closed=false;#started=false;#reason='disabled';#blocked=null;
  constructor({root,security,login,access,services,readConfig=()=>readRobotBinding({root,security}),apiFactory=binding=>new RobotApplicationApi({binding,now:()=>security.now()}),streamFactory=options=>new RobotStream(options),timers={setInterval,clearInterval}}){
    this.#args={security,login,access,services};this.#read=readConfig;this.#apiFactory=apiFactory;this.#streamFactory=streamFactory;this.#timers=timers;
  }
  #config(){try{return this.#read();}catch{return {enabled:false,reason:'robot-configuration-unavailable'};}}
  #live(session,source=session?.stream.currentSource()){
    if(this.#closed||!session||this.#session!==session||this.#blocked===session.fingerprint||!session.stream.isCurrent(source))return false;
    const config=this.#config();return config.enabled===true&&config.fingerprint===session.fingerprint;
  }
  status(){const session=this.#session;return {enabled:this.#live(session),reason:this.#reason,connection:session?.stream.status().state??'stopped',pendingWork:session?.work.size??0};}
  start(){if(this.#closed)return Promise.resolve();if(!this.#started){this.#started=true;this.#poll=this.#timers.setInterval(()=>{void this.tick();},1000);this.#poll?.unref?.();}return this.tick();}
  tick(){if(this.#closed)return Promise.resolve();if(this.#tick)return this.#tick;const tick=this.#execute();this.#tick=tick;void tick.finally(()=>{if(this.#tick===tick)this.#tick=null;}).catch(()=>{});return tick;}
  async #stop(session=this.#session){
    if(!session)return;if(this.#session===session)this.#session=null;
    return session.closing??=(async()=>{try{await session.stream.close();}finally{await Promise.allSettled([...session.work]);}})();
  }
  async #execute(){
    const config=this.#config();
    try{
      if(config.enabled!==true){await this.#stop();this.#blocked=null;this.#reason=config.reason??'disabled';return;}
      if(this.#blocked===config.fingerprint){await this.#stop();return;}
      if(!this.#session||this.#session.fingerprint!==config.fingerprint){
        await this.#stop();if(this.#closed)return;
        const {binding}=config,store=new RobotStore({security:this.#args.security,scopeKey:binding.scopeKey});store.recoverInterrupted();
        const projection=new RobotProjection({...this.#args,pilotAccounts:binding.pilotAccounts}),api=this.#apiFactory(binding);
        const session={binding,fingerprint:config.fingerprint,store,projection,api,stream:null,work:new Set(),nextScan:0,nextRecipient:0,qualification:new Map()};
        try{session.stream=this.#streamFactory({api,binding,now:()=>this.#args.security.now(),onEvent:(event,source)=>this.#incoming(session,event,source),onState:state=>{if(state==='connected')session.nextScan=0;}});}catch(error){api.stop();throw error;}
        this.#session=session;await session.stream.start();
      }
      const session=this.#session;if(!this.#live(session))return;this.#reason='running';
      if(session.nextScan<=this.#args.security.now()){session.nextScan=this.#args.security.now()+15000;await this.#scan(session);}
      if(this.#live(session))await this.#sendOne(session);
    }catch{
      this.#blocked=config.fingerprint??null;this.#reason='robot-entry-unavailable';await this.#stop();
    }
  }
  #incoming(session,event,source){
    const executor=new RobotDecisionExecutor({...this.#args,store:session.store,projection:session.projection,isActive:()=>this.#live(session,source)});
    const accepted=executor.accept(event,{overloaded:session.work.size>=32});
    if(accepted.work){const work=accepted.work;session.work.add(work);void work.then(()=>session.work.delete(work),()=>{session.work.delete(work);this.#blocked=session.fingerprint;this.#reason='robot-entry-unavailable';});}
    return accepted;
  }
  async #qualify(session,account){
    const {security,login}=this.#args;
    try{security.requireMember(account);return true;}catch{}
    const previous=session.qualification.get(account);if(previous&&previous.next>security.now())return false;
    try{await login.refresh(account);security.requireMember(account);session.qualification.delete(account);return true;}
    catch{const failures=Math.min((previous?.failures??0)+1,6);session.qualification.set(account,{failures,next:security.now()+Math.min(300000,15000*2**(failures-1))});return false;}
  }
  #scope(binding,account){
    const {security,access}=this.#args;security.requireMember(account);
    const principal={channel:'im-private',account,projectId:binding.projectId,epoch:binding.epoch,memberRevision:binding.memberRevision};access.scope(principal);
    access.object(binding.kind==='plan_confirmation'?'plan':binding.kind==='task_assignment'?'task':'result',binding.objectId,principal);
    if(binding.taskId)access.object('task',binding.taskId,principal);
  }
  async #scan(session){
    let created=0;
    for(const snapshot of session.projection.candidates()){
      if(!this.#live(session)||created>=20)return;
      const eventKey='notice:'+robotMetadataHash(snapshot.binding);if(session.store.deliveryByKey(eventKey))continue;
      if(!await this.#qualify(session,snapshot.account))continue;
      if(!this.#live(session))return;
      this.#args.security.transaction(()=>{
        if(!this.#live(session)||session.store.deliveryByKey(eventKey))return;
        let current;try{this.#scope(snapshot.binding,snapshot.account);current=session.projection.describe(snapshot.binding,snapshot.account);}catch{return;}
        if(!current.pending||robotMetadataHash(current.binding)!==robotMetadataHash(snapshot.binding))return;
        const informational=current.binding.kind==='task_assignment',reference=informational?null:session.store.reference(current.account,current.binding);
        session.store.enqueue({eventKey,account:current.account,kind:informational?'task':'pending',refCode:reference?.code??null,context:{kind:'fixed-notification',binding:current.binding},text:formatRobotNotification(current,reference)});created++;
      });
    }
  }
  #deliveryContext(session,row,{fresh=true}={}){
    const {security}=this.#args,context=row.context,binding=context.binding,member=session.projection.member(row.account);
    const fixed=context.kind==='fixed-notification';if(!fixed&&context.kind!=='own-receipt')throw new Error('Delivery context unavailable');
    const owner=fixed?binding:context;
    if(owner.account!==row.account||owner.memberRevision!==member.revision||owner.epoch!==security.epoch||owner.recipientUserId!==member.user_id)throw new Error('Delivery recipient changed');
    if(binding){
      if(fresh)this.#scope(binding,row.account);
      const reference=row.ref_code?session.store.ref(row.ref_code):null;
      const current=reference?session.projection.validate(reference):session.projection.describe(binding,row.account);
      if(reference?robotMetadataHash(reference.binding)!==robotMetadataHash(binding):robotMetadataHash(current.binding)!==robotMetadataHash(binding))throw new Error('Delivery version changed');
      if(fixed&&!current.pending)throw new Error('Notification is no longer pending');
    }
    return member.user_id;
  }
  async #sendOne(session){
    const accounts=session.binding.pilotAccounts,start=session.nextRecipient;
    // Fixed two-pilot fairness: at most one ready head per recipient and one API attempt per poll.
    for(let offset=0;offset<accounts.length;offset++){
      if(!this.#live(session))return;
      const index=(start+offset)%accounts.length,row=session.store.ready(1,accounts[index])[0];if(!row)continue;
      if(await this.#sendRow(session,row)){session.nextRecipient=(index+1)%accounts.length;return;}
    }
  }
  async #sendRow(session,row){
    // Check permanent local context first; an unchanged accepted/unknown event is never queried here.
    try{this.#deliveryContext(session,row,{fresh:false});}catch{session.store.suppress(row.id,'stale-or-unavailable-context');return;}
    if(!await this.#qualify(session,row.account)||!this.#live(session))return;
    const source=session.stream.currentSource();let claimed,userId;
    this.#args.security.transaction(()=>{
      if(!this.#live(session,source))return;
      try{userId=this.#deliveryContext(session,row);this.#args.security.requireMember(row.account);}catch{return;}
      claimed=session.store.claim(row.id);
    });
    if(!claimed)return;
    const beforeSend=()=>{
      if(!this.#live(session,source))return false;
      try{return this.#args.security.transaction(()=>{this.#deliveryContext(session,claimed);this.#args.security.requireMember(claimed.account);return this.#live(session,source);});}catch{return false;}
    };
    let result;try{result=await session.api.sendPrivateText(userId,claimed.payload_text,{beforeSend});}catch{result={status:'unknown',errorKind:'unknown-send-outcome'};}
    session.store.finishDelivery(claimed.id,result);return true;
  }
  close(){
    if(this.#closing)return this.#closing;this.#closed=true;this.#reason='stopped';
    if(this.#poll){this.#timers.clearInterval(this.#poll);this.#poll=null;}
    const stop=this.#stop();return this.#closing=(async()=>{try{await stop;}finally{await this.#tick;}})();
  }
}
