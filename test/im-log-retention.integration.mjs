import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createTestCollaboration} from './helpers/host.mjs';import {runMaintenance} from '../src/maintenance-cli.mjs';import {acquireKernelLock} from '../src/maintenance-lock.mjs';
const confirmation='PURGE_EXPIRED_IM_TRANSCRIPTS_AND_DATABASE_BODIES';
async function provision(c){const p=c.services.projects.create({key:'A',name:'A'});c.security.bind({account:'alice',userId:'alice',unionId:'alice'});c.security.participate(p.id,'alice',true);c.security.markVerified('alice',{corpId:'corp',userId:'alice',unionId:'alice',internal:true});return p;}
function principal(c,p){return{account:'alice',projectId:p.id,channel:'im-private',memberRevision:c.security.member('alice').revision,participantRevision:c.security.requireProject('alice',p.id).revision,epoch:c.security.epoch};}
async function fixture(){const root=mkdtempSync(join(tmpdir(),'im-maintenance-host-')),config={serviceId:'retention',workspace:join(root,'workspace'),stateRoot:join(root,'state'),provider:'fixture',model:'fixture',accounts:{alice:'a'.repeat(64)},socketPath:process.platform==='win32'?`\\\\.\\pipe\\retention-${randomUUID()}`:join(root,'service.sock'),dingtalk:{corpId:'corp',clientId:'app',clientSecret:'synthetic',publicOrigin:'https://example.test',loginPort:19000,communicationRetentionDays:90}};
 const c=await createTestCollaboration(config),p=await provision(c);
 const configFile=join(root,'config.json'),commandFile=join(root,'command.json');writeFileSync(configFile,JSON.stringify(config),{mode:0o600});const sessionRoot=join(config.stateRoot,'host','sessions');
 function command(dryRun,expectedPlanHash){writeFileSync(commandFile,JSON.stringify({action:'purge-expired-communication',confirmation,sessionRoot,dryRun,...expectedPlanHash?{expectedPlanHash}:{}}),{mode:0o600});return{configFile,commandFile};}
 return{root,config,c,p,sessionRoot,command};}
test('actual Host owns registered IM log before query; live service and actual live session leases refuse maintenance; stopped CLI purges IM only',async()=>{
 const f=await fixture();let stopped=false;try{
  const output=await f.c.communication.queryModel('synthetic private original',principal(f.c,f.p));assert.ok(output.includes('synthetic private original'));
  const db=f.c.security.db,row=db.prepare('SELECT * FROM collaboration_im_logs').get();assert.equal(row.state,'registered');assert.equal(row.account,'alice');
  const dsh=await f.c.runtime.open({id:randomUUID(),owner:'alice',cwd:f.config.workspace,resume:false,principal:{...principal(f.c,f.p),channel:'dsh'}});
  await f.c.runtime.prompt(dsh,'synthetic DSH must survive',new AbortController().signal,()=>{});const dshArtifact=await f.c.runtime.persistedImLog(dsh);await f.c.runtime.close(dsh);const before=readFileSync(dshArtifact.path);
  db.prepare('UPDATE collaboration_im_logs SET registered_at=? WHERE session_id=?').run(Date.now()-91*86400000,row.session_id);
  await assert.rejects(runMaintenance(f.command(true)),/active|lock unavailable/);assert.ok(existsSync(join(row.directory,'session.v4.jsonl')));
  const live=await f.c.host.ctx.sessionPersistence.open(row.session_id,'write');try{await assert.rejects(acquireKernelLock(join(row.directory,'session.lock'),{session:true}));}finally{await live.close();}
  await f.c.runtime.closeAll();stopped=true;
  const plan=await runMaintenance(f.command(true));assert.equal(plan.expiredSessions,1);assert.equal(plan.deleted,false);
  const result=await runMaintenance(f.command(false,plan.planHash));assert.equal(result.imTranscriptBodiesDeleted,true);assert.equal(result.dshSessionsDeleted,false);assert.deepEqual(readFileSync(dshArtifact.path),before);
  const fresh=new DatabaseSync(join(f.config.stateRoot,'collaboration.sqlite'));try{assert.equal(fresh.prepare('SELECT state FROM collaboration_im_logs WHERE session_id=?').get(row.session_id).state,'purged');assert.ok(fresh.prepare("SELECT seq FROM collaboration_security_audit WHERE action='im-transcript-purged'").get());assert.equal(fresh.prepare('SELECT count(*) n FROM projects').get().n,1);assert.ok(fresh.prepare("SELECT value FROM collaboration_security_meta WHERE key='epoch'").get());}finally{fresh.close();}
 }finally{if(!stopped)await f.c.runtime.closeAll();}
});
test('startup precisely registers old known IM context; real stopped purge then restart never resumes deleted transcript or touches DSH',async()=>{
 const f=await fixture();let current=f.c,stopped=false;
 try{
  await current.communication.queryModel('historical synthetic IM text',principal(current,f.p));const row=current.security.db.prepare('SELECT * FROM collaboration_im_logs').get();
  current.security.db.prepare('DELETE FROM collaboration_im_logs WHERE session_id=?').run(row.session_id);await current.runtime.closeAll();stopped=true;
  current=await createTestCollaboration(f.config);stopped=false;assert.equal(current.security.db.prepare('SELECT session_id FROM collaboration_im_logs').get().session_id,row.session_id);
  current.security.db.prepare('UPDATE collaboration_im_logs SET registered_at=? WHERE session_id=?').run(Date.now()-91*86400000,row.session_id);await current.runtime.closeAll();stopped=true;
  const plan=await runMaintenance(f.command(true));await runMaintenance(f.command(false,plan.planHash));assert.equal(existsSync(join(row.directory,'session.v4.jsonl')),false);
  current=await createTestCollaboration(f.config);stopped=false;const result=await current.communication.queryModel('fresh query',principal(current,f.p));assert.ok(!result.includes('historical synthetic IM text'));
  assert.notEqual(current.security.db.prepare('SELECT session_id FROM collaboration_im_contexts').get().session_id,row.session_id);assert.equal(current.security.db.prepare('SELECT state FROM collaboration_im_logs WHERE session_id=?').get(row.session_id).state,'purged');
 }finally{if(!stopped)await current.runtime.closeAll();}
});

test('90-day context rotation and post-purge queries get new IDs without deleting tombstones or resuming old stored text',async()=>{
 const f=await fixture();try{let time=Date.now();f.c.communication.now=()=>time;const pr=principal(f.c,f.p);
  await f.c.communication.queryModel('old synthetic context',pr);const db=f.c.security.db,old=db.prepare('SELECT * FROM collaboration_im_logs').get();
  time+=91*86400000;await f.c.communication.queryModel('new query',pr);const current=db.prepare('SELECT session_id FROM collaboration_im_contexts').get().session_id;assert.notEqual(current,old.session_id);assert.equal(db.prepare('SELECT count(*) n FROM collaboration_im_logs').get().n,2);
  db.prepare("UPDATE collaboration_im_logs SET state='purged' WHERE session_id=?").run(current);await f.c.communication.queryModel('after purge query',pr);assert.notEqual(db.prepare('SELECT session_id FROM collaboration_im_contexts').get().session_id,current);assert.equal(db.prepare('SELECT state FROM collaboration_im_logs WHERE session_id=?').get(current).state,'purged');
 }finally{await f.c.runtime.closeAll();}
});
