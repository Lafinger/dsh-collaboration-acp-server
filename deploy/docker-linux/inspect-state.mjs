// Run inside container as Docker administrator. Outputs facts/modes/counts, never secrets.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const root='/srv/collaboration';
const facts=[];
for(const [path,uid,gid,mode] of [
  [join(root,'dsh-home/.credentials.yaml'),1101,1101,0o600],
  [join(root,'dsh-home/collaboration-acp-server.json'),1101,1101,0o600],
  [join(root,'private-state'),1101,1101,0o700],
  ['/etc/collaboration-access/connectors/alice.json',0,1102,0o440],
  ['/etc/collaboration-access/connectors/bob.json',0,1103,0o440],
  ['/run/collaboration',1101,1100,0o2750],
  ['/run/collaboration/service.sock',1101,1100,0o660]
]){const stat=lstatSync(path);assert.equal(stat.uid,uid,path);assert.equal(stat.gid,gid,path);assert.equal(stat.mode&0o7777,mode,path);facts.push({path,uid,gid,mode:mode.toString(8)});}
const config=JSON.parse(readFileSync(join(root,'dsh-home/collaboration-acp-server.json'),'utf8'));
assert.notEqual(config.accounts.alice,config.accounts.bob);
const key=JSON.parse(readFileSync(join(root,'dsh-home/.credentials.yaml'),'utf8'));
assert.deepEqual(Object.keys(key.refs),['CODEGO_API_KEY']);assert.ok(key.refs.CODEGO_API_KEY);assert.equal(key.records,undefined);
const counters=JSON.parse(readFileSync(join(root,'private-state/acceptance-counters.json'),'utf8'));
const mode=JSON.parse(readFileSync(join(root,'private-state/mode.json'),'utf8')).mode;
const db=new DatabaseSync(join(root,'private-state/collaboration.sqlite'),{readOnly:true});
const projects=db.prepare('SELECT id,key,name FROM projects').all();db.close();
const events=[];
function walk(dir){for(const e of readdirSync(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isDirectory())walk(path);else if(e.name.endsWith('.jsonl'))for(const line of readFileSync(path,'utf8').split('\n').filter(Boolean)){try{const event=JSON.parse(line);if(event.type==='tool/result'||event.type==='tool/call'||event.type==='llm/request'||event.type==='agent/request')events.push({type:event.type,dataKeys:Object.keys(event.data??{})});}catch{}}}}
walk(join(root,'dsh-home/sessions'));
console.log(JSON.stringify({linuxPermissions:'PASS',credentialCopy:'codego-only',distinctMemberCredentials:true,mode,counters,projects,sessionEventFacts:events},null,2));
