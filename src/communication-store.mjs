import {randomUUID} from 'node:crypto';
import {AccessError,requireText} from './protocol.mjs';
const unavailable=()=>{throw new AccessError(-32003,'Communication unavailable in current member/project context');};
export const splitCommunication=text=>{requireText(text,'communication text',32000);const chars=Array.from(text),parts=[];for(let i=0;i<chars.length;i+=850)parts.push(chars.slice(i,i+850).join(''));return parts;};

/** Durable communication is separate from formal business facts; no model owns reliability/visibility. */
export class CommunicationStore{
  constructor({identities,now=Date.now,retentionDays=90,recover=true}){
    this.identities=identities;this.db=identities.db;this.now=now;
    if(!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>90)throw new Error('Invalid communication retention');this.retentionDays=retentionDays;
    this.db.exec(`CREATE TABLE IF NOT EXISTS collaboration_communication_epoch(epoch TEXT PRIMARY KEY,started_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_targets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind IN('private','group')),
        account TEXT REFERENCES collaboration_members(account),route TEXT NOT NULL,bot_id TEXT NOT NULL,corp_id TEXT NOT NULL,client_id TEXT NOT NULL,robot_code TEXT NOT NULL,
        enabled INTEGER NOT NULL,public_enabled INTEGER NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_inbox(id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,message_id TEXT NOT NULL,transport_id TEXT NOT NULL,
        sender_user_id TEXT,conversation_id TEXT,conversation_type TEXT,created_at INTEGER,received_at INTEGER NOT NULL,epoch TEXT NOT NULL,
        body TEXT,status TEXT NOT NULL,reason TEXT,account TEXT,project_id TEXT,member_revision INTEGER,participant_revision INTEGER,
        UNIQUE(bot_id,message_id));
      CREATE TABLE IF NOT EXISTS collaboration_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),sender TEXT NOT NULL REFERENCES collaboration_members(account),
        recipient TEXT REFERENCES collaboration_members(account),visibility TEXT NOT NULL CHECK(visibility IN('private','public')),target_id TEXT NOT NULL,
        body TEXT,created_at INTEGER NOT NULL,epoch TEXT NOT NULL,source_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS collaboration_replies(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES collaboration_requests(id),sender TEXT NOT NULL REFERENCES collaboration_members(account),
        body TEXT,created_at INTEGER NOT NULL,epoch TEXT NOT NULL,source_id TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS collaboration_receipts(request_id TEXT NOT NULL REFERENCES collaboration_requests(id),account TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(request_id,account));
      CREATE TABLE IF NOT EXISTS collaboration_outbox(id TEXT PRIMARY KEY,dedup_key TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,author TEXT NOT NULL,visibility TEXT NOT NULL,target_id TEXT NOT NULL,
        target_revision INTEGER NOT NULL,member_revision INTEGER NOT NULL,participant_revision INTEGER NOT NULL,epoch TEXT NOT NULL,created_at INTEGER NOT NULL,body TEXT,
        subject_kind TEXT NOT NULL,subject_id TEXT NOT NULL,subject_version TEXT,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_outbox_parts(outbox_id TEXT NOT NULL REFERENCES collaboration_outbox(id),part INTEGER NOT NULL,body TEXT,status TEXT NOT NULL,
        provider_query_key TEXT,started_at INTEGER,settled_at INTEGER,PRIMARY KEY(outbox_id,part));
      CREATE TABLE IF NOT EXISTS collaboration_subscriptions(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,account TEXT NOT NULL,target_id TEXT NOT NULL,
        kinds TEXT NOT NULL,enabled INTEGER NOT NULL,revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_im_model_calls(inbox_id TEXT PRIMARY KEY,account TEXT NOT NULL,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_im_logs(session_id TEXT PRIMARY KEY,account TEXT NOT NULL,project_id TEXT NOT NULL,root TEXT NOT NULL,directory TEXT NOT NULL UNIQUE,cwd TEXT NOT NULL,
        header_created_at INTEGER NOT NULL,registered_at INTEGER NOT NULL,last_used_at INTEGER NOT NULL,state TEXT NOT NULL,purged_at INTEGER);
      CREATE TABLE IF NOT EXISTS collaboration_im_contexts(key TEXT PRIMARY KEY,session_id TEXT NOT NULL,account TEXT NOT NULL,project_id TEXT NOT NULL,
        channel TEXT NOT NULL,member_revision INTEGER NOT NULL,participant_revision INTEGER NOT NULL,epoch TEXT NOT NULL);
    `);
    this.db.prepare("INSERT OR IGNORE INTO collaboration_security_meta VALUES('controlled-ingress','1')").run();
    const columns=new Set(this.db.prepare('PRAGMA table_info(collaboration_outbox)').all().map(r=>r.name));
    if(!columns.has('recipient_scope'))this.db.exec('ALTER TABLE collaboration_outbox ADD COLUMN recipient_scope TEXT');
    const inboxColumns=new Set(this.db.prepare('PRAGMA table_info(collaboration_inbox)').all().map(r=>r.name));
    for(const [name,type]of [['target_id','TEXT'],['target_revision','INTEGER']])if(!inboxColumns.has(name))this.db.exec(`ALTER TABLE collaboration_inbox ADD COLUMN ${name} ${type}`);
    const requestColumns=new Set(this.db.prepare('PRAGMA table_info(collaboration_requests)').all().map(r=>r.name));
    for(const [name,type]of [['reply_target_id','TEXT'],['reply_target_revision','INTEGER']])if(!requestColumns.has(name))this.db.exec(`ALTER TABLE collaboration_requests ADD COLUMN ${name} ${type}`);
    this.ensureEpoch();
    // Only service startup owns crash recovery; concurrent local administration must not settle live work.
    if(recover){
    // Uncertain work is NEVER returned to pending; operator sees the crash boundary.
    this.db.prepare("UPDATE collaboration_inbox SET status='unknown',reason='process-interrupted' WHERE status='processing'").run();
    this.db.prepare("UPDATE collaboration_outbox_parts SET status='unknown',settled_at=? WHERE status='sending'").run(this.now());
    for(const r of this.db.prepare("SELECT DISTINCT outbox_id FROM collaboration_outbox_parts WHERE status='unknown'").all())this.settleOutbox(r.outbox_id);
    }
  }
  ensureEpoch(){const epoch=this.identities.epoch;this.db.prepare('INSERT OR IGNORE INTO collaboration_communication_epoch VALUES(?,?)').run(epoch,this.now());return epoch;}
  target(id){return this.db.prepare('SELECT * FROM collaboration_targets WHERE id=?').get(id)??null;}
  privateTarget(account,projectId){const rows=this.db.prepare("SELECT * FROM collaboration_targets WHERE project_id=? AND account=? AND kind='private' AND enabled=1").all(projectId,account);return rows.length===1?rows[0]:null;}
  manageTarget(command,actor='local-administrator'){
    const {id,projectId,kind,account=null,botId,corpId,clientId,robotCode,route,enabled=true,publicEnabled=false}=command;
    requireText(id,'target id',128);if(!/^[A-Za-z0-9_.-]+$/.test(id))unavailable();
    if(!['private','group'].includes(kind)||typeof enabled!=='boolean'||typeof publicEnabled!=='boolean'||!this.db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))unavailable();
    if(corpId!==this.identities.corpId||clientId!==this.identities.clientId)unavailable();for(const x of [botId,robotCode])requireText(x,'bot scope',200);
    if(!route||typeof route!=='object'||Array.isArray(route))unavailable();
    const keys=Object.keys(route);let normalized;
    if(kind==='private'){
      const member=this.identities.member(account);if(!member?.enabled||!this.db.prepare('SELECT 1 FROM collaboration_participants WHERE project_id=? AND account=? AND enabled=1').get(projectId,account)||publicEnabled||keys.length!==1||keys[0]!=='userId'||route.userId!==member.user_id)unavailable();
      normalized={type:'user',userId:route.userId};
    }else{
      if(account!==null||keys.some(k=>!['openConversationId','groupKind','coolAppCode'].includes(k))||!['template','cool-app'].includes(route.groupKind))unavailable();
      requireText(route.openConversationId,'group route',200);if(route.groupKind==='cool-app')requireText(route.coolAppCode,'cool app code',200);
      if(route.groupKind==='template'&&route.coolAppCode!==undefined)unavailable();
      normalized={type:'group',openConversationId:route.openConversationId,groupKind:route.groupKind,...(route.coolAppCode?{coolAppCode:route.coolAppCode}:{})};
    }
    return this.identities.transaction(()=>{
      const prior=this.target(id);if(prior&&(prior.project_id!==projectId||prior.kind!==kind||prior.account!==account))unavailable();
      this.db.prepare(`INSERT INTO collaboration_targets VALUES(?,?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET route=excluded.route,bot_id=excluded.bot_id,
        corp_id=excluded.corp_id,client_id=excluded.client_id,robot_code=excluded.robot_code,enabled=excluded.enabled,public_enabled=excluded.public_enabled,revision=revision+1`)
        .run(id,projectId,kind,account,JSON.stringify(normalized),botId,corpId,clientId,robotCode,enabled?1:0,publicEnabled?1:0);
      this.identities.audit(actor,'communication-target',id);return {ok:true,id,revision:this.target(id).revision};
    });
  }
  subscribe({id,projectId,account,targetId,kinds,enabled},actor='local-administrator'){
    requireText(id,'subscription id',128);if(!/^[A-Za-z0-9_.-]+$/.test(id))unavailable();if(typeof enabled!=='boolean'||!Array.isArray(kinds)||!kinds.length||kinds.some(k=>!['todo','notice','communication'].includes(k)))unavailable();
    const target=this.target(targetId);if(!target?.enabled||target.kind!=='private'||target.account!==account||target.project_id!==projectId)unavailable();
    const member=this.identities.member(account);if(!member?.enabled||!this.db.prepare('SELECT 1 FROM collaboration_participants WHERE project_id=? AND account=? AND enabled=1').get(projectId,account))unavailable();
    const prior=this.db.prepare('SELECT * FROM collaboration_subscriptions WHERE id=?').get(id);if(prior&&(prior.project_id!==projectId||prior.account!==account))unavailable();
    this.db.prepare(`INSERT INTO collaboration_subscriptions VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET target_id=excluded.target_id,kinds=excluded.kinds,enabled=excluded.enabled,revision=revision+1`)
      .run(id,projectId,account,targetId,JSON.stringify([...new Set(kinds)]),enabled?1:0);this.identities.audit(actor,'communication-subscription',id);return {ok:true};
  }
  accept(descriptor,event){
    requireText(event.messageId,'platform message ID',200);requireText(event.transportId,'platform transport ID',200);
    const epoch=this.ensureEpoch(),cutoff=this.db.prepare('SELECT started_at FROM collaboration_communication_epoch WHERE epoch=?').get(epoch).started_at;
    return this.identities.transaction(()=>{
      const previous=this.db.prepare('SELECT id,status,epoch FROM collaboration_inbox WHERE bot_id=? AND message_id=?').get(descriptor.botId,event.messageId);
      if(previous)return {durable:true,duplicate:true,id:previous.id,status:previous.status,oldEpoch:previous.epoch!==epoch};
      let reason=event.rejection;
      if(!reason&&(!Number.isSafeInteger(event.createdAt)||event.createdAt<cutoff||event.createdAt>this.now()+300000))reason='stale-or-invalid-message-time';
      const id=randomUUID();this.db.prepare('INSERT INTO collaboration_inbox(id,bot_id,message_id,transport_id,sender_user_id,conversation_id,conversation_type,created_at,received_at,epoch,body,status,reason,account,project_id,member_revision,participant_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,descriptor.botId,event.messageId,event.transportId,event.senderUserId,event.conversationId,event.conversationType,event.createdAt,this.now(),epoch,reason?null:event.text,reason?'rejected':'pending',reason??null,null,null,null,null);
      return {durable:true,id,status:reason?'rejected':'pending'};
    });
  }
  scope(account,projectId){const m=this.identities.requireMember(account),p=this.identities.requireProject(account,projectId);return {m,p,epoch:this.ensureEpoch()};}
  requireRequest(id,account,projectId){
    this.scope(account,projectId);const row=this.db.prepare('SELECT * FROM collaboration_requests WHERE id=?').get(id);
    if(!row||row.project_id!==projectId||row.epoch!==this.identities.epoch||(row.visibility==='private'&&row.sender!==account&&row.recipient!==account))unavailable();return row;
  }
  intent({key,projectId,author,visibility,targetId,body,subjectKind,subjectId,subjectVersion=null}){
    const {m,p,epoch}=this.scope(author,projectId),target=this.target(targetId);
    if(!target?.enabled||target.project_id!==projectId||(visibility==='public'?(target.kind!=='group'||!target.public_enabled):target.kind!=='private'))unavailable();
    const previous=this.db.prepare('SELECT id FROM collaboration_outbox WHERE dedup_key=?').get(key);if(previous)return previous.id;
    const id=randomUUID(),parts=splitCommunication(body);
    this.db.prepare('INSERT INTO collaboration_outbox(id,dedup_key,project_id,author,visibility,target_id,target_revision,member_revision,participant_revision,epoch,created_at,body,subject_kind,subject_id,subject_version,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,key,projectId,author,visibility,targetId,target.revision,m.revision,p.revision,epoch,this.now(),body,subjectKind,subjectId,subjectVersion,'pending');
    if(target.kind==='private'){const recipient=this.scope(target.account,projectId);this.db.prepare('UPDATE collaboration_outbox SET recipient_scope=? WHERE id=?').run(JSON.stringify({account:target.account,memberRevision:recipient.m.revision,participantRevision:recipient.p.revision}),id);}
    for(let part=0;part<parts.length;part++)this.db.prepare('INSERT INTO collaboration_outbox_parts VALUES(?,?,?,\'pending\',NULL,NULL,NULL)').run(id,part,`[通信 ${id} ${part+1}/${parts.length}]\n${parts[part]}`);
    return id;
  }
  create({account,projectId,targetId,visibility,body,sourceId}){
    requireText(body,'explicit communication',12000);if(!['private','public'].includes(visibility))unavailable();
    return this.identities.transaction(()=>{
      this.scope(account,projectId);const target=this.target(targetId);if(!target?.enabled||target.project_id!==projectId||(visibility==='private'?target.kind!=='private':target.kind!=='group'||!target.public_enabled))unavailable();
      if(visibility==='private')this.scope(target.account,projectId);
      if(sourceId){const previous=this.db.prepare('SELECT * FROM collaboration_requests WHERE source_id=?').get(sourceId);if(previous){if(previous.project_id!==projectId||previous.sender!==account||previous.target_id!==targetId||previous.visibility!==visibility||previous.body!==body||previous.epoch!==this.identities.epoch)unavailable();return {ok:true,requestId:previous.id,duplicate:true};}}
      const id=randomUUID(),replyTarget=visibility==='private'?this.privateTarget(account,projectId):target;
      this.db.prepare('INSERT INTO collaboration_requests(id,project_id,sender,recipient,visibility,target_id,body,created_at,epoch,source_id,reply_target_id,reply_target_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,account,visibility==='private'?target.account:null,visibility,targetId,body,this.now(),this.identities.epoch,sourceId??null,replyTarget?.id??null,replyTarget?.revision??null);
      const outboxId=this.intent({key:`request:${id}`,projectId,author:account,visibility,targetId,body:`项目沟通请求 ${id}\n发起成员：${account}\n${body}\n请用 /答复 ${id} 答复文本 显式关联。不是正式业务决定。`,subjectKind:'request',subjectId:id});
      return {ok:true,requestId:id,outboxId,status:'pending',formalDecision:false};
    });
  }
  reply({account,projectId,requestId,body,sourceId}){
    requireText(body,'explicit reply',12000);
    return this.identities.transaction(()=>{
      const request=this.requireRequest(requestId,account,projectId);
      if(sourceId){const prior=this.db.prepare('SELECT * FROM collaboration_replies WHERE source_id=?').get(sourceId);if(prior){if(prior.request_id!==requestId||prior.sender!==account||prior.body!==body||prior.epoch!==this.identities.epoch)unavailable();return {ok:true,replyId:prior.id,duplicate:true};}}
      const id=randomUUID();this.db.prepare('INSERT INTO collaboration_replies VALUES(?,?,?,?,?,?,?)').run(id,requestId,account,body,this.now(),this.identities.epoch,sourceId??null);
      // Public reply stays in original explicit public target; private reply never upgrades visibility.
      const target=this.target(request.reply_target_id);let outboxId=null;
      if(target?.enabled&&target.revision===request.reply_target_revision)outboxId=this.intent({key:`reply:${id}`,projectId,author:account,visibility:request.visibility,targetId:target.id,body:`项目沟通答复 ${requestId}\n答复成员：${account}\n${body}\n仅通信文本，不是同意、正式资料或确认。`,subjectKind:'reply',subjectId:id});
      return {ok:true,replyId:id,outboxId,status:outboxId?'pending':'recorded-not-sent',formalDecision:false};
    });
  }
  acknowledge({account,projectId,requestId}){
    return this.identities.transaction(()=>{const request=this.requireRequest(requestId,account,projectId);if(request.sender===account)unavailable();this.db.prepare('INSERT OR IGNORE INTO collaboration_receipts VALUES(?,?,?)').run(requestId,account,this.now());return {ok:true,explicitReceipt:true,formalDecision:false};});
  }
  history(account,projectId,requestId){
    this.scope(account,projectId);const rows=requestId?[this.requireRequest(requestId,account,projectId)]:this.db.prepare("SELECT * FROM collaboration_requests WHERE project_id=? AND epoch=? AND (visibility='public' OR sender=? OR recipient=?) ORDER BY created_at DESC LIMIT 100").all(projectId,this.identities.epoch,account,account);
    return {ok:true,limit:100,requests:rows.map(row=>({requestId:row.id,projectId,sender:row.sender,recipient:row.recipient,visibility:row.visibility,body:row.body,bodyExpired:row.body===null,createdAt:row.created_at,
      replies:this.db.prepare('SELECT id,sender,body,created_at FROM collaboration_replies WHERE request_id=? ORDER BY created_at').all(row.id),
      explicitReceipts:this.db.prepare('SELECT account,at FROM collaboration_receipts WHERE request_id=?').all(row.id),
      deliveries:this.db.prepare('SELECT id,status,subject_kind,subject_id FROM collaboration_outbox WHERE subject_id=? OR subject_id IN(SELECT id FROM collaboration_replies WHERE request_id=?)').all(row.id,row.id).map(o=>({...o,parts:this.db.prepare('SELECT part,status,provider_query_key FROM collaboration_outbox_parts WHERE outbox_id=? ORDER BY part').all(o.id),delivered:false,read:false}))}))};
  }
  settleOutbox(id){
    const parts=this.db.prepare('SELECT status FROM collaboration_outbox_parts WHERE outbox_id=? ORDER BY part').all(id).map(r=>r.status);
    const accepted=parts.filter(s=>s==='accepted').length;
    const status=parts.every(s=>s==='accepted')?'platform-accepted':accepted&&parts.some(s=>['unknown','rejected','suppressed'].includes(s))?'partial':parts.includes('unknown')?'unknown':parts.includes('rejected')?'rejected':parts.includes('suppressed')?'suppressed':parts.includes('sending')?'sending':'pending';
    this.db.prepare('UPDATE collaboration_outbox SET status=? WHERE id=?').run(status,id);return status;
  }
  purge({confirmation},actor='local-administrator'){
    if(confirmation!=='PURGE_EXPIRED_COMMUNICATION_BODIES')unavailable();const cutoff=this.now()-this.retentionDays*86400000;
    return this.identities.transaction(()=>{
      let count=0;
      for(const table of ['collaboration_requests','collaboration_replies'])count+=Number(this.db.prepare(`UPDATE ${table} SET body=NULL WHERE body IS NOT NULL AND created_at<?`).run(cutoff).changes);
      count+=Number(this.db.prepare("UPDATE collaboration_inbox SET body=NULL WHERE body IS NOT NULL AND received_at<? AND status NOT IN('pending','processing')").run(cutoff).changes);
      const ids=this.db.prepare("SELECT id FROM collaboration_outbox WHERE created_at<? AND status NOT IN('pending','sending')").all(cutoff);
      for(const {id}of ids){count+=Number(this.db.prepare('UPDATE collaboration_outbox SET body=NULL WHERE id=? AND body IS NOT NULL').run(id).changes);this.db.prepare('UPDATE collaboration_outbox_parts SET body=NULL WHERE outbox_id=?').run(id);}
      this.identities.audit(actor,'communication-body-purge',String(count));return {ok:true,bodyRowsPurged:count,formalDataDeleted:false,dedupAndEpochRetained:true,imTranscriptsPurged:false,requiresOfflineTranscriptMaintenance:true};
    });
  }
}
