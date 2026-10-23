import {createHash} from 'node:crypto';
import {newDecisionCode,DECISION_CODE_ALPHABET} from './robot-command.mjs';

const SCHEMA_KEY='im-text-decision-schema';
const fail=code=>{const error=new Error('Robot metadata unavailable');error.code=code;throw error;};
const text=(value,max=512)=>{if(typeof value!=='string'||!value||value.length>max)fail('INVALID_METADATA');return value;};
function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isSafeInteger(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  fail('INVALID_METADATA');
}
export const robotMetadataHash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const digest=robotMetadataHash;
const decodeRef=row=>row?{...row,binding:JSON.parse(row.binding_json)}:null;
const decodeReceipt=row=>row?{...row,command:JSON.parse(row.command_json),result:row.result_json===null?null:JSON.parse(row.result_json)}:null;
const decodeDelivery=row=>row?{...row,context:JSON.parse(row.context_json)}:null;
const schema=`
 CREATE TABLE im_decision_refs (
  code TEXT PRIMARY KEY,scope_key TEXT NOT NULL,account TEXT NOT NULL,context_key TEXT NOT NULL UNIQUE,
  binding_json TEXT NOT NULL,created_at INTEGER NOT NULL,invalidated_at INTEGER,invalid_reason TEXT
 );
 CREATE INDEX im_decision_refs_scope ON im_decision_refs(scope_key,account);
 CREATE TABLE im_message_receipts (
  scope_key TEXT NOT NULL,msg_id TEXT NOT NULL,account TEXT NOT NULL,source_created_at INTEGER NOT NULL,
  command_hash TEXT NOT NULL,command_json TEXT NOT NULL,received_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('received','applied','readback','conflict','invalid','failed','interrupted')),
  result_json TEXT,PRIMARY KEY(scope_key,msg_id)
 );
 CREATE TABLE im_delivery_outbox (
  id INTEGER PRIMARY KEY,scope_key TEXT NOT NULL,event_key TEXT NOT NULL,account TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pending','task','receipt')),ref_code TEXT,
  context_json TEXT NOT NULL,payload_text TEXT NOT NULL,intent_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','unknown','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,created_at INTEGER NOT NULL,
  accepted_key TEXT,error_kind TEXT,UNIQUE(scope_key,event_key)
 );
 CREATE INDEX im_delivery_outbox_ready ON im_delivery_outbox(scope_key,status,next_attempt_at);
`;

/** Entry/delivery metadata only. All business facts remain in original services/tables.
 * Uses IdentityStore.transaction so original nested business services share the SAME SQLite lock.
 * Construct only for an explicitly configured robot; this module has no auto-start/network behavior.
 */
export class RobotStore{
  constructor({security,scopeKey,now=()=>security.now(),newCode=newDecisionCode}){
    this.security=security;this.db=security.db;this.scopeKey=text(scopeKey);this.now=now;this.newCode=newCode;
    security.transaction(()=>{
      const stored=this.db.prepare('SELECT value FROM collaboration_security_meta WHERE key=?').get(SCHEMA_KEY);
      if(stored){if(stored.value!=='1')fail('UNSUPPORTED_ROBOT_SCHEMA');return;}
      if(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('im_decision_refs','im_message_receipts','im_delivery_outbox')").get())fail('UNOWNED_ROBOT_SCHEMA');
      this.db.exec(schema);this.db.prepare('INSERT INTO collaboration_security_meta(key,value) VALUES(?,?)').run(SCHEMA_KEY,'1');
    });
  }
  ref(code){return decodeRef(this.db.prepare('SELECT * FROM im_decision_refs WHERE scope_key=? AND code=?').get(this.scopeKey,code));}
  reference(account,binding){
    text(account,200);const bindingJson=canonical(binding);if(bindingJson.length>32768)fail('INVALID_METADATA');
    const key=digest([this.scopeKey,account,binding]);
    return this.security.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM im_decision_refs WHERE context_key=?').get(key);
      if(previous){if(previous.scope_key!==this.scopeKey||previous.account!==account||previous.binding_json!==bindingJson)fail('REFERENCE_CONFLICT');return decodeRef(previous);}
      for(let attempt=0;attempt<32;attempt++){
        const code=this.newCode();if(typeof code!=='string'||code.length!==8||![...code].every(c=>DECISION_CODE_ALPHABET.includes(c)))fail('INVALID_CODE');
        if(this.db.prepare('SELECT 1 FROM im_decision_refs WHERE code=?').get(code))continue;
        this.db.prepare('INSERT INTO im_decision_refs(code,scope_key,account,context_key,binding_json,created_at) VALUES(?,?,?,?,?,?)').run(code,this.scopeKey,account,key,bindingJson,this.now());return this.ref(code);
      }
      fail('CODE_COLLISION_LIMIT');
    });
  }
  invalidate(code,reason){text(reason,100);this.db.prepare('UPDATE im_decision_refs SET invalidated_at=COALESCE(invalidated_at,?),invalid_reason=COALESCE(invalid_reason,?) WHERE scope_key=? AND code=?').run(this.now(),reason,this.scopeKey,code);}
  receipt(msgId){return decodeReceipt(this.db.prepare('SELECT * FROM im_message_receipts WHERE scope_key=? AND msg_id=?').get(this.scopeKey,msgId));}
  receive({msgId,account,sourceCreatedAt,command}){
    text(msgId,2048);text(account,200);if(!Number.isSafeInteger(sourceCreatedAt)||sourceCreatedAt<0)fail('INVALID_METADATA');const serialized=canonical(command);if(serialized.length>32768)fail('INVALID_METADATA');const hash=digest(command);
    return this.security.transaction(()=>{
      const previous=this.receipt(msgId);
      if(previous){if(previous.account!==account||previous.source_created_at!==sourceCreatedAt||previous.command_hash!==hash||previous.command_json!==serialized)fail('MESSAGE_ID_CONFLICT');return {created:false,receipt:previous};}
      this.db.prepare('INSERT INTO im_message_receipts VALUES(?,?,?,?,?,?,?,?,NULL)').run(this.scopeKey,msgId,account,sourceCreatedAt,hash,serialized,this.now(),'received');
      return {created:true,receipt:this.receipt(msgId)};
    });
  }
  /** Call inside the original business transaction together with the business write and outbox intent. */
  finishReceipt(msgId,status,result){
    if(!['applied','readback','conflict','invalid','failed'].includes(status))fail('INVALID_RECEIPT_STATUS');
    const row=this.db.prepare("UPDATE im_message_receipts SET status=?,result_json=? WHERE scope_key=? AND msg_id=? AND status='received'").run(status,canonical(result),this.scopeKey,msgId);if(row.changes!==1)fail('RECEIPT_NOT_PENDING');
  }
  enqueue({eventKey,account,kind,refCode=null,context,text:payload}){
    text(eventKey,512);text(account,200);if(!['pending','task','receipt'].includes(kind))fail('INVALID_DELIVERY_KIND');text(payload,8000);if(refCode!==null){const ref=this.ref(refCode);if(!ref)fail('UNKNOWN_REFERENCE');if(ref.account!==account)fail('REFERENCE_RECIPIENT_MISMATCH');if(kind==='pending'&&ref.invalidated_at!==null)fail('INACTIVE_REFERENCE');}
    const contextJson=canonical(context);if(contextJson.length>32768)fail('INVALID_METADATA');const hash=digest({account,kind,refCode,context,payload});
    return this.security.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM im_delivery_outbox WHERE scope_key=? AND event_key=?').get(this.scopeKey,eventKey);
      if(previous){if(previous.intent_hash!==hash)fail('DELIVERY_KEY_CONFLICT');return decodeDelivery(previous);}
      const at=this.now(),result=this.db.prepare("INSERT INTO im_delivery_outbox(scope_key,event_key,account,kind,ref_code,context_json,payload_text,intent_hash,status,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)").run(this.scopeKey,eventKey,account,kind,refCode,contextJson,payload,hash,at,at);return this.delivery(Number(result.lastInsertRowid));
    });
  }
  deliveryByKey(eventKey){return decodeDelivery(this.db.prepare('SELECT * FROM im_delivery_outbox WHERE scope_key=? AND event_key=?').get(this.scopeKey,eventKey));}
  delivery(id){return decodeDelivery(this.db.prepare('SELECT * FROM im_delivery_outbox WHERE scope_key=? AND id=?').get(this.scopeKey,id));}
  ready(limit=20,account=null){if(!Number.isSafeInteger(limit)||limit<1||limit>100)fail('INVALID_DELIVERY_LIMIT');if(account!==null)text(account,200);return this.db.prepare("SELECT * FROM im_delivery_outbox WHERE scope_key=? AND status='pending' AND attempts<3 AND next_attempt_at<=? AND (? IS NULL OR account=?) ORDER BY id LIMIT ?").all(this.scopeKey,this.now(),account,account,limit).map(decodeDelivery);}
  claim(id){return this.security.transaction(()=>{const result=this.db.prepare("UPDATE im_delivery_outbox SET status='sending',attempts=attempts+1,error_kind=NULL WHERE scope_key=? AND id=? AND status='pending' AND attempts<3 AND next_attempt_at<=?").run(this.scopeKey,id,this.now());return result.changes===1?this.delivery(id):null;});}
  suppress(id,reason){text(reason,100);this.db.prepare("UPDATE im_delivery_outbox SET status='suppressed',error_kind=? WHERE scope_key=? AND id=? AND status='pending'").run(reason,this.scopeKey,id);}
  finishDelivery(id,{status,acceptedKey=null,errorKind=null}){
    if(!['accepted','unknown','failed','retry-unsent'].includes(status))fail('INVALID_DELIVERY_STATUS');
    if(status==='accepted')text(acceptedKey,2048);if(errorKind!==null)text(errorKind,100);
    return this.security.transaction(()=>{
      const current=this.delivery(id);if(!current||current.status!=='sending')fail('DELIVERY_NOT_SENDING');
      const retry=status==='retry-unsent'&&current.attempts<3,next=retry?'pending':status==='retry-unsent'?'failed':status;
      this.db.prepare('UPDATE im_delivery_outbox SET status=?,accepted_key=?,error_kind=?,next_attempt_at=? WHERE scope_key=? AND id=?').run(next,status==='accepted'?acceptedKey:null,errorKind,this.now()+(retry?15000*2**(current.attempts-1):0),this.scopeKey,id);return this.delivery(id);
    });
  }
  recoverInterrupted(){return this.security.transaction(()=>{
    const receipts=this.db.prepare("UPDATE im_message_receipts SET status='interrupted' WHERE scope_key=? AND status='received'").run(this.scopeKey).changes;
    const deliveries=this.db.prepare("UPDATE im_delivery_outbox SET status='unknown',error_kind='interrupted-send' WHERE scope_key=? AND status='sending'").run(this.scopeKey).changes;
    return {receipts,deliveries};
  });}
}
