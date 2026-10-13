import assert from 'node:assert/strict';import{readFileSync,readdirSync,existsSync}from'node:fs';import{DatabaseSync}from'node:sqlite';import{join}from'node:path';
const root='/srv/collaboration/private-state';
const db=new DatabaseSync(join(root,'collaboration.sqlite'),{readOnly:true});const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();const counts={};for(const{name}of tables){assert.match(name,/^[a-z_]+$/);counts[name]=Number(db.prepare(`SELECT count(*) n FROM ${name}`).get().n);assert.equal(counts[name],0,`Nonempty business table ${name}`);}db.close();
const access=new DatabaseSync(join(root,'access.sqlite'),{readOnly:true});for(const name of ['access_sessions','access_events','access_requests']){counts[name]=Number(access.prepare(`SELECT count(*) n FROM ${name}`).get().n);assert.equal(counts[name],0,`Nonempty access table ${name}`);}access.close();
assert.deepEqual(readdirSync('/srv/collaboration/dsh-home/sessions'),[],'Model sessions must be empty');
const legacy=['work','bench'].join('')+'.sqlite';for(const suffix of ['','-wal','-shm','-journal'])assert.equal(existsSync(join(root,legacy+suffix)),false,'Retired database must not remain');
const counters=JSON.parse(readFileSync(join(root,'acceptance-counters.json'),'utf8'));assert.deepEqual(counters,{turns:0,requests:0,completedTurns:0});assert.equal(JSON.parse(readFileSync(join(root,'mode.json'),'utf8')).mode,'daily');
if(existsSync(join(root,'files')))assert.deepEqual(readdirSync(join(root,'files')),[]);
console.log(JSON.stringify({emptyState:'PASS',backupCreated:false,businessAndAccessCounts:counts,modelRequests:0,modelSessions:0,mode:'daily'},null,2));
