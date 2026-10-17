import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrate,SCHEMA_VERSION} from '../business/lib/sqlite/schema.js';
import {IdentityStore} from '../src/identity-store.mjs';
import {RobotStore} from '../src/robot-store.mjs';

function fixture(t,options={}){
  const db=new DatabaseSync(':memory:');migrate(db);t.after(()=>db.close());let now=1800000000000;
  const security=new IdentityStore({db,serviceId:'offline-robot-store',corpId:'fixture-corp',clientId:'fixture-original-identity-app',now:()=>now});const epoch=security.epoch;
  const store=new RobotStore({security,scopeKey:'fixture-message-scope-a',...options});
  return {db,security,store,epoch,advance:ms=>{now+=ms;}};
}
const binding={projectId:'fixture-project',kind:'plan_confirmation',objectId:'fixture-plan',version:1,role:'product',memberRevision:1};
const command={kind:'plan_confirmation',outcome:'agree',code:'K7M4P9X2',reason:null};
const event=(msgId='fixture-msg')=>({msgId,account:'fixture-a',sourceCreatedAt:1800000000000,command});
const delivery=(eventKey='fixture-event')=>({eventKey,account:'fixture-a',kind:'pending',context:binding,text:'Synthetic saved business preview; no production data'});

test('additive schema is idempotent and does not change original business user_version or identity scope/epoch',t=>{
  const f=fixture(t);const scope=f.db.prepare("SELECT value FROM collaboration_security_meta WHERE key='scope'").get().value;
  new RobotStore({security:f.security,scopeKey:'fixture-message-scope-a'});
  assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);assert.equal(f.security.epoch,f.epoch);
  assert.equal(f.db.prepare("SELECT value FROM collaboration_security_meta WHERE key='scope'").get().value,scope);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('im_decision_refs','im_message_receipts','im_delivery_outbox')").get().n,3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM collaboration_members').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);
});
test('fixed bindings are canonical, never retargeted, and have no normal time expiry',t=>{
  const f=fixture(t);const original=f.store.reference('fixture-a',binding);f.advance(30*24*3600000);
  const reordered=Object.fromEntries(Object.entries(binding).reverse());assert.equal(f.store.reference('fixture-a',reordered).code,original.code);
  const next=f.store.reference('fixture-a',{...binding,version:2});assert.notEqual(next.code,original.code);assert.equal(f.store.ref(original.code).binding.version,1);
  f.store.invalidate(original.code,'version-changed');assert.equal(f.store.ref(original.code).invalid_reason,'version-changed');
  assert.ok(f.store.reference('fixture-a',binding).invalidated_at);assert.equal(f.store.ref(next.code).invalidated_at,null);
});
test('short codes are globally unique across scopes, while lookups and receipts never cross scopes',t=>{
  const codeA='K7M4P9X2',codeB='T5V8Q2M7',f=fixture(t,{newCode:()=>codeA});f.store.reference('fixture-a',binding);f.store.receive(event());let calls=0;
  const other=new RobotStore({security:f.security,scopeKey:'fixture-message-scope-b',newCode:()=>++calls===1?codeA:codeB});
  assert.equal(other.ref(codeA),null);assert.equal(other.receipt('fixture-msg'),null);assert.equal(other.reference('fixture-a',binding).code,codeB);assert.equal(calls,2);
  assert.throws(()=>f.store.reference('fixture-a',{...binding,version:2}),error=>error.code==='CODE_COLLISION_LIMIT');
});
test('durable message dedup compares sender, source time and full canonical command without replaying',t=>{
  const {store}=fixture(t);assert.equal(store.receive(event()).created,true);assert.equal(store.receive(event()).created,false);
  for(const changed of [{account:'fixture-b'},{sourceCreatedAt:1800000000001},{command:{...command,outcome:'reject',reason:'synthetic conflict'}}])assert.throws(()=>store.receive({...event(),...changed}),error=>error.code==='MESSAGE_ID_CONFLICT');
  store.finishReceipt('fixture-msg','applied',{outcome:'agree',objectId:'fixture-plan',version:1});assert.equal(store.receive(event()).receipt.status,'applied');
  assert.throws(()=>store.finishReceipt('fixture-msg','applied',{}),error=>error.code==='RECEIPT_NOT_PENDING');
});
test('original business row, final message audit and receipt intent roll back together with nested original transactions',t=>{
  const f=fixture(t);f.store.receive(event());
  assert.throws(()=>f.security.transaction(()=>{
    f.db.prepare('INSERT INTO projects(id,key,name,created_at) VALUES(?,?,?,?)').run('synthetic-p','SYNTHETIC','Synthetic original business row','2026-01-01T00:00:00.000Z');
    f.store.finishReceipt('fixture-msg','applied',{outcome:'agree'});f.store.enqueue({...delivery(),kind:'receipt'});throw new Error('injected-after-intent');
  }),/injected-after-intent/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,0);assert.equal(f.store.receipt('fixture-msg').status,'received');assert.equal(f.store.ready().length,0);
  f.security.transaction(()=>{f.store.finishReceipt('fixture-msg','applied',{outcome:'agree'});f.store.enqueue({...delivery(),kind:'receipt'});});
  assert.equal(f.store.receipt('fixture-msg').status,'applied');assert.equal(f.store.ready().length,1);
});
test('recovery marks unfinished commands interrupted and sending intents unknown; neither is automatically replayed',t=>{
  const f=fixture(t);f.store.receive(event());const intent=f.store.enqueue(delivery());assert.equal(f.store.claim(intent.id).attempts,1);assert.equal(f.store.claim(intent.id),null);
  assert.deepEqual(f.store.recoverInterrupted(),{receipts:1,deliveries:1});assert.equal(f.store.receipt('fixture-msg').status,'interrupted');
  assert.equal(f.store.receive(event()).created,false);assert.equal(f.store.enqueue(delivery()).status,'unknown');assert.equal(f.store.ready().length,0);
  assert.equal(f.store.delivery(intent.id).attempts,1);assert.throws(()=>f.store.finishDelivery(intent.id,{status:'accepted',acceptedKey:'fixture-key'}),error=>error.code==='DELIVERY_NOT_SENDING');
});
test('only explicit known-unsent temporary results back off, bounded to three actual send attempts',t=>{
  const f=fixture(t),intent=f.store.enqueue(delivery());
  for(let n=1;n<=3;n++){
    assert.equal(f.store.claim(intent.id).attempts,n);const after=f.store.finishDelivery(intent.id,{status:'retry-unsent',errorKind:'explicit-recipient-rate-limit'});
    assert.equal(after.status,n<3?'pending':'failed');assert.equal(f.store.ready().length,0);f.advance(60000);
  }
  assert.equal(f.store.claim(intent.id),null);assert.equal(f.store.delivery(intent.id).attempts,3);
});
test('accepted, unknown, permanent failed and suppressed delivery keys never become pending again',t=>{
  const f=fixture(t);
  for(const status of ['accepted','unknown','failed']){const input=delivery('fixture-'+status),intent=f.store.enqueue(input);f.store.claim(intent.id);f.store.finishDelivery(intent.id,{status,acceptedKey:status==='accepted'?'fixture-platform-key':null,errorKind:status==='accepted'?null:'synthetic-error'});assert.equal(f.store.enqueue(input).status,status);assert.equal(f.store.claim(intent.id),null);}
  const input=delivery('fixture-suppressed'),intent=f.store.enqueue(input);f.store.suppress(intent.id,'stale-version');assert.equal(f.store.enqueue(input).status,'suppressed');assert.equal(f.store.ready().length,0);
  assert.throws(()=>f.store.enqueue({...input,account:'fixture-b'}),error=>error.code==='DELIVERY_KEY_CONFLICT');
});
test('a reference notification cannot be addressed to another member or revive an invalid binding',t=>{
  const f=fixture(t),ref=f.store.reference('fixture-a',binding);
  assert.throws(()=>f.store.enqueue({...delivery('wrong-recipient'),account:'fixture-b',refCode:ref.code}),error=>error.code==='REFERENCE_RECIPIENT_MISMATCH');
  f.store.invalidate(ref.code,'stale-context');
  assert.throws(()=>f.store.enqueue({...delivery('invalid-reference'),refCode:ref.code}),error=>error.code==='INACTIVE_REFERENCE');
  assert.equal(f.store.ready().length,0);
});
test('future or unowned plugin schemas fail closed without changing the business schema',t=>{
  const f=fixture(t);f.db.prepare("UPDATE collaboration_security_meta SET value='2' WHERE key='im-text-decision-schema'").run();
  assert.throws(()=>new RobotStore({security:f.security,scopeKey:'fixture-message-scope-a'}),error=>error.code==='UNSUPPORTED_ROBOT_SCHEMA');assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,SCHEMA_VERSION);
  f.db.prepare("DELETE FROM collaboration_security_meta WHERE key='im-text-decision-schema'").run();
  assert.throws(()=>new RobotStore({security:f.security,scopeKey:'fixture-message-scope-a'}),error=>error.code==='UNOWNED_ROBOT_SCHEMA');
});
