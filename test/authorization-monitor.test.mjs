import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {IdentityStore,opaqueSecret} from '../src/identity-store.mjs';
import {LoginService} from '../src/login-service.mjs';
import {AccessStore} from '../src/store.mjs';
import {AccessService} from '../src/service.mjs';
import {AccountAuthority,issueTicket} from '../src/authority.mjs';
import {initializeParams,collaborationMeta} from '../src/protocol.mjs';
import {listenAccess,connectAccess} from '../src/transport.mjs';

const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const MONITOR_TICKS=2.5; // the qualification monitor samples once per second

/** A turn that stays open until the authorization monitor aborts it or the test releases it. */
async function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'monitor-lease-')),db=openDatabase({path:':memory:'});let clock=1000000;
  const identities=new IdentityStore({db,serviceId:'s',corpId:'corp',clientId:'app',now:()=>clock});
  identities.bind({account:'alice',userId:'user',unionId:'union'});
  const projects=new ProjectService(db),a=projects.create({key:'A',name:'A'});
  identities.participate(a.id,'alice',true);
  const provider={exchange:async()=>({corpId:'corp',userId:'user',unionId:'union',internal:true}),verifyMember:async m=>({corpId:'corp',userId:m.user_id,unionId:m.union_id,internal:true})};
  const login=new LoginService({identities,provider,publicOrigin:'https://login.example.test',now:()=>clock});
  const store=new AccessStore(join(root,'access.sqlite'));
  const turn={signal:null,release:null};
  turn.started=new Promise(resolve=>{turn.markStarted=resolve;});
  const runtime={async open(input){return input;},async prompt(handle,text,signal,emit){
    turn.signal=signal;turn.markStarted();
    await new Promise(resolve=>{turn.release=resolve;signal.addEventListener('abort',resolve,{once:true});});
    return {stopReason:signal.aborted?'cancelled':'end_turn'};
  },async close(){}};
  const secret='a'.repeat(64),authority=new AccountAuthority({serviceId:'s',accounts:{alice:secret}});
  const service=new AccessService({authority,store,runtime,cwd:root,login,identities,projects}),listener=await listenAccess(service),peers=[];
  t.after(async()=>{turn.release?.();peers.forEach(p=>p.close());await listener.close();store.close();db.close();});
  const connect=async()=>{const peer=await connectAccess(listener.address);peers.push(peer);await peer.request('collaboration/connect',{ticket:issueTicket({account:'alice',serviceId:'s',secret}),_meta:collaborationMeta()});await peer.request('initialize',initializeParams());return peer;};
  const authenticate=async peer=>{
    const proof=opaqueSecret(),start=await peer.request('collaboration/login/start',{deviceId:'device',proof}),browser=login.browserStart(start.requestId);
    await login.callback({state:new URL(browser.authorizationUrl).searchParams.get('state'),code:opaqueSecret(),cookie:browser.cookie});
    const claimed=await peer.request('collaboration/login/claim',{requestId:start.requestId,deviceId:'device',proof});
    await peer.request('collaboration/login/authenticate',{token:claimed.token,deviceId:'device'});return claimed;
  };
  return {store,identities,projects,a,db,connect,authenticate,turn,advance:ms=>clock+=ms};
}

async function openTurn(t){
  const f=await fixture(t),peer=await f.connect();await f.authenticate(peer);
  const created=await peer.request('session/new',{projectId:f.a.id});
  const pending=peer.request('session/prompt',{sessionId:created.sessionId,prompt:[{type:'text',text:'提交成果'}],_meta:{requestId:'lease-window'}});
  await f.turn.started;
  return {f,peer,created,pending};
}

test('a lapsed organization re-verification lease does not cancel a running turn',async t=>{
  const {f,created,pending}=await openTurn(t);
  // Only the freshness lease lapses: account, organization subject, epoch and revisions are untouched.
  f.advance(f.identities.organizationTtlMs+1);
  assert.equal(f.identities.member('alice').enabled,1);
  assert.ok(f.identities.member('alice').verified_until<=f.identities.now());
  await tick(1000*MONITOR_TICKS);
  assert.equal(f.turn.signal.aborted,false,'a lapsed re-verification lease is not a revocation');
  f.turn.release();
  assert.deepEqual(await pending,{stopReason:'end_turn'});
  assert.equal(f.store.db.prepare('SELECT state FROM access_requests WHERE session_id=?').get(created.sessionId).state,'completed');
});

test('a member revision bump still cancels the running turn through the monitor alone',async t=>{
  const {f,pending}=await openTurn(t);
  // Bypass the authorization-change event so this exercises the monitor's own qualification check.
  f.db.prepare('UPDATE collaboration_members SET revision=revision+1 WHERE account=?').run('alice');
  assert.deepEqual(await pending,{stopReason:'cancelled'});
  assert.equal(f.turn.signal.aborted,true);
});

test('business commits re-verify the lease instead of inheriting a stale member row',async t=>{
  const f=await fixture(t);
  assert.equal(f.identities.organizationTtlMs,900000,'the default re-verification lease is 15 minutes');
  f.advance(f.identities.organizationTtlMs+1);
  assert.throws(()=>f.identities.requireMember('alice'),e=>e.code===-32003);
  // The verifier renews a lapsed lease; requireMember accepts it again without any revision change.
  f.identities.markVerified('alice',{corpId:'corp',userId:'user',unionId:'union',internal:true});
  assert.equal(f.identities.requireMember('alice').revision,1);
});
