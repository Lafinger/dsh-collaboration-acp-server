import {createHash} from 'node:crypto';
import {parseRobotCommand} from './robot-command.mjs';
import {robotMetadataHash} from './robot-store.mjs';
import {RobotContextError} from './robot-projection.mjs';
const words=Object.freeze({plan_confirmation:{agree:'同意',reject:'拒绝'},result_review:{complete:'完成',return:'退回'},result_acceptance:{accept:'接受',reject:'拒收'}});
const types=Object.freeze({plan_confirmation:'方案',result_review:'本职成果',result_acceptance:'下游接收'});
const help='仅支持本人事项的完整命令：同意／拒绝、完成／退回、接受／拒收，后接通知中的8位短号；否定动作还须填写原因。主线工作请在DSH完成。';
const stale='该短号不属于本人当前有效事项，或已失效。不会改批其他版本；失效不表示此前决定未发生，请到DSH核对。';
const paused='入口已暂停，本次未收集决定。请到DSH办理，或恢复后重新明确发送。';

/** Narrow non-model entry. Never creates an Agent/session, opens acceptance, or enables IM tools.
 * accept() is synchronous through durable receipt insertion; its returned work is deliberately
 * separate from transport ACK. Only a trusted Stream controller may pass a normalized event.
 */
export class RobotDecisionExecutor{
  constructor({security,login,access,services,store,projection,isActive}){
    if(typeof isActive!=='function')throw new Error('Explicit robot entry guard required');
    Object.assign(this,{security,login,access,services,store,projection,isActive});
  }
  active(){
    try{const value=this.isActive();if(value&&typeof value.then==='function')void Promise.resolve(value).catch(()=>{});return value===true;}catch{return false;}
  }
  accept(event,{overloaded=false}={}){
    if(!this.active())return {ack:true,ignored:true,work:null};
    const actor=this.security.db.prepare('SELECT * FROM collaboration_members WHERE corp_id=? AND client_id=? AND user_id=? AND enabled=1').get(this.security.corpId,this.security.clientId,event.userId);
    if(!actor||!this.projection.pilots.has(actor.account))return {ack:true,ignored:true,work:null};
    const parsed=parseRobotCommand(event.content),command=parsed.ok?parsed.command:{kind:'invalid-command',textHash:createHash('sha256').update(event.content).digest('hex')};
    const received=this.store.receive({msgId:event.msgId,account:actor.account,sourceCreatedAt:event.createdAt,command});
    if(!received.created)return {ack:true,duplicate:true,status:received.receipt.status,work:null};
    if(overloaded){this.store.finishReceipt(event.msgId,'failed',{kind:'entry-busy-reply-again'});return {ack:true,status:'failed',work:null};}
    return {ack:true,work:this.process(event,actor,parsed)};
  }
  principal(ref,actor){return {channel:'im-private',account:actor.account,projectId:ref.binding.projectId,memberRevision:ref.binding.memberRevision,epoch:ref.binding.epoch};}
  requireCurrent(ref,actor,event){
    if(!this.active())throw new RobotContextError('entry-disabled');
    const member=this.security.requireMember(actor.account);
    if(member.user_id!==event.userId)throw new RobotContextError();
    const principal=this.principal(ref,actor);this.access.scope(principal);
    this.access.object(ref.binding.kind==='plan_confirmation'?'plan':'result',ref.binding.objectId,principal);
    if(ref.binding.taskId)this.access.object('task',ref.binding.taskId,principal);
    if(ref.binding.kind==='plan_confirmation')for(const [,peer]of ref.binding.peers)if(peer)this.security.requireProject(peer,ref.binding.projectId);
    return this.projection.validate(ref);
  }
  queueReceipt(event,actor,status,result,text,ref=null){
    // Must be called in the same outer transaction as the original decision/terminal receipt.
    this.store.finishReceipt(event.msgId,status,result);
    const member=this.security.member(actor.account);
    if(!member||member.enabled!==1||member.corp_id!==this.security.corpId||member.client_id!==this.security.clientId||member.user_id!==event.userId){
      if(ref)throw new RobotContextError('member-unavailable');return;
    }
    // Persist the intent regardless of cache expiry; the delivery worker must refresh before API.
    // A stop suppresses the intent, not the original business/audit atomicity.
    const context={kind:'own-receipt',account:actor.account,recipientUserId:member.user_id,memberRevision:member.revision,epoch:this.security.epoch,binding:ref?.binding??null};
    const intent=this.store.enqueue({eventKey:'receipt:'+robotMetadataHash(event.msgId),account:actor.account,kind:'receipt',refCode:ref?.code??null,context,text});
    if(!this.active())this.store.suppress(intent.id,'entry-disabled');
  }
  async process(event,actor,parsed){
    let ref=null;
    try{
      await this.login.refresh(actor.account);
      if(parsed.ok){const found=this.store.ref(parsed.command.code);if(found?.account===actor.account)ref=found;}
      if(ref&&ref.binding.kind==='plan_confirmation'){
        const peers=new Set(ref.binding.peers.map(row=>row[1]).filter(Boolean));peers.delete(actor.account);
        for(const peer of peers)await this.login.refresh(peer);
      }
      return this.security.transaction(()=>{
        if(!this.active())throw new RobotContextError('entry-disabled');
        const member=this.security.requireMember(actor.account);if(member.user_id!==event.userId)throw new RobotContextError();
        if(!parsed.ok){this.queueReceipt(event,actor,'invalid',{kind:'invalid-command'},help);return {status:'invalid'};}
        if(!ref){this.queueReceipt(event,actor,'invalid',{kind:'unavailable-reference'},stale);return {status:'invalid'};}
        const current=this.requireCurrent(ref,actor,event),command=parsed.command,b=ref.binding;
        if(command.kind!==b.kind){const allowed=Object.values(words[b.kind]).map(word=>`${word} ${ref.code}${['拒绝','退回','拒收'].includes(word)?' 原因':''}`).join(' ／ ');this.queueReceipt(event,actor,'invalid',{kind:'wrong-action'},`该号仅用于${types[b.kind]}，允许：${allowed}。`,ref);return {status:'invalid'};}
        if(current.outcome!==null){
          const same=current.outcome===command.outcome&&current.decidedBy===actor.account,status=same?'readback':'conflict';
          const result={kind:b.kind,objectId:b.objectId,version:b.version,role:b.role,taskId:b.taskId,outcome:current.outcome};
          this.queueReceipt(event,actor,status,result,same?`已处理：${types[b.kind]}v${b.version}，职责${b.role}，${words[b.kind][current.outcome]}，短号${ref.code}。相同决定已存在，未重复写入。`:`该固定版本已有其他决定，不会覆盖。短号${ref.code}，请到DSH核对。`,ref);return {status,result};
        }
        if(!current.pending)throw new RobotContextError();
        const common={outcome:command.outcome,reason:command.reason,submittedBy:actor.account,declaredMember:actor.account};
        if(b.kind==='plan_confirmation')this.services.plans.confirm({...common,planId:b.objectId,role:b.role});
        else if(b.kind==='result_review')this.services.results.review({...common,resultId:b.objectId,version:b.version,role:b.role});
        else if(b.kind==='result_acceptance')this.services.results.decide({...common,resultId:b.objectId,version:b.version,taskId:b.taskId});
        else throw new RobotContextError();
        const after=this.requireCurrent(ref,actor,event);
        if(after.outcome!==command.outcome||after.decidedBy!==actor.account)throw new RobotContextError('decision-not-recorded');
        const result={kind:b.kind,objectId:b.objectId,version:b.version,role:b.role,taskId:b.taskId,outcome:after.outcome};
        this.queueReceipt(event,actor,'applied',result,`已记录：${types[b.kind]}v${b.version}，职责${b.role}，${words[b.kind][after.outcome]}，短号${ref.code}。详细事实请在DSH查询。`,ref);
        return {status:'applied',result};
      });
    }catch(error){
      const kind=error instanceof RobotContextError?error.kind:'qualification-or-original-rule-unavailable';
      return this.security.transaction(()=>{
        const existing=this.store.receipt(event.msgId);if(!existing||existing.status!=='received')return {status:existing?.status??'unavailable'};
        const status=error instanceof RobotContextError?'invalid':'failed';
        const text=kind==='entry-disabled'?paused:error instanceof RobotContextError?stale:'原组织资格或原业务前置条件暂不可用，本次未收集决定。不会补做主线工作或开放接收，请在DSH核对后重新明确发送。';
        this.queueReceipt(event,actor,status,{kind},text);return {status};
      });
    }
  }
}
