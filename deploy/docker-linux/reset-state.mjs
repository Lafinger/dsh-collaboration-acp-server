// Destructive maintenance only. Never imported by startup or run while server is active.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const legacyDatabase = ['work','bench'].join('') + '.sqlite'; // Only explicit retired-file cleanup, not a runtime alias.
const databases = [legacyDatabase, 'collaboration.sqlite', 'access.sqlite'];
const allowedState = new Set(['mode.json', 'acceptance-counters.json', 'restore-snapshot.json', 'files', ...databases.flatMap(name=>[name,name+'-wal',name+'-shm',name+'-journal'])]);
const retainedPaths = ['dsh-home/.credentials.yaml','dsh-home/collaboration-acp-server.json','ssh'];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function contained(root,path){const rel=relative(root,path);assert.ok(rel!==''&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')&&!isAbsolute(rel),'Delete must be strictly inside explicit service root');}
function noLinks(path,recursive=true){assert.ok(!lstatSync(path).isSymbolicLink(),'Refuse symlink in maintenance target');assert.equal(realpathSync(path),resolve(path),'Refuse unexpected absolute target');if(recursive&&lstatSync(path).isDirectory())for(const name of readdirSync(path))noLinks(join(path,name));}
function retained(root){const facts=new Map();function walk(path){noLinks(path);if(lstatSync(path).isDirectory())for(const name of readdirSync(path))walk(join(path,name));else facts.set(relative(root,path),hash(path));}for(const name of retainedPaths)walk(join(root,name));return facts;}
export function planReset(root){
 root=resolve(root);assert.equal(realpathSync(root),root);assert.ok(lstatSync(root).isDirectory());
 for(const name of ['private-state','dsh-home','dsh-home/sessions','ssh','workspace']){const path=join(root,name);contained(root,path);noLinks(path,name!=='dsh-home');assert.ok(lstatSync(path).isDirectory());}
 const config=JSON.parse(readFileSync(join(root,'dsh-home/collaboration-acp-server.json'),'utf8'));
 assert.equal(config.serviceId,'docker-linux-sim','Refuse unrelated service');assert.equal(config.provider,'codego');assert.equal(config.model,'deepseek-v4.1-flash');
 assert.equal(JSON.parse(readFileSync(join(root,'private-state/mode.json'),'utf8')).mode,'daily','Preserve daily mode only');
 assert.deepEqual(readdirSync(join(root,'workspace')),[],'Unknown workspace files require review, do not delete');
 const entries=readdirSync(join(root,'private-state'));for(const name of entries)assert.ok(allowedState.has(name),`Unknown private-state entry: ${name}`);
 const targets=entries.filter(name=>name!=='mode.json').map(name=>join(root,'private-state',name));
 targets.push(join(root,'dsh-home/sessions'));
 for(const path of targets){contained(root,path);noLinks(path);}
 return {root,targets,retained:retained(root)};
}
export function applyReset(plan){
 // Revalidate the complete state immediately before any deletion; no partial cleanup on unknown files.
 const current=planReset(plan.root);assert.deepEqual(current.targets,plan.targets);assert.deepEqual(current.retained,plan.retained);
 for(const path of plan.targets){contained(plan.root,path);noLinks(path);rmSync(path,{recursive:true,force:false});}
 mkdirSync(join(plan.root,'dsh-home/sessions'),{mode:0o700});
 assert.deepEqual(retained(plan.root),plan.retained,'Credential/host/member key material changed');
 assert.deepEqual(readdirSync(join(plan.root,'private-state')),['mode.json']);
 assert.deepEqual(readdirSync(join(plan.root,'dsh-home/sessions')),[]);
 console.log(JSON.stringify({reset:'PASS',backupCreated:false,removed:plan.targets.map(path=>relative(plan.root,path)),credentialsAndSSHIdentityUnchanged:true,mode:'daily'}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv[2],'--confirm-delete-without-backup','Explicit no-backup confirmation required');
 assert.equal(process.getuid?.(),0,'Offline Docker administrator required');
 assert.equal(process.env.COLLABORATION_OFFLINE_RESET,'yes','Use offline maintenance container only');
 assert.equal(existsSync('/run/collaboration/service.sock'),false,'Active service socket must not exist');
 applyReset(planReset('/srv/collaboration'));
}
