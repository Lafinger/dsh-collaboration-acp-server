import {lstatSync,realpathSync,existsSync,readdirSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,basename,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createZstdDecompress} from 'node:zlib';
import {acquireKernelLock,acquireMaintenanceLock} from './maintenance-lock.mjs';

const refuse=()=>{throw new Error('IM transcript maintenance precondition unavailable; nothing outside the exact registered expired IM scope may be deleted');};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const logName=v=>/^(?:session(?:\.v[1-4])?\.jsonl(?:\.zstd)?(?:\.[a-f0-9]{12}\.tmp)?|session\.migration\.[A-Za-z0-9_-]+(?:\.jsonl(?:\.zstd)?)?\.tmp)$/.test(v);
export function canonicalDirectory(path){
 if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)refuse();
 let current=path;for(;;){const stat=lstatSync(current);if(!stat.isDirectory()||stat.isSymbolicLink())refuse();const parent=dirname(current);if(parent===current)break;current=parent;}
 if(realpathSync(path)!==path)refuse();
 if(process.platform!=='win32'){const stat=lstatSync(path);if(stat.uid!==process.getuid()||(stat.mode&0o077))refuse();}
 return path;
}
export function assertRegisteredDirectory(root,directory,sessionId){
 canonicalDirectory(root);if(!uuid(sessionId)||!isAbsolute(directory)||resolve(directory)!==directory)refuse();
 const rel=relative(root,directory),parts=rel.split(/[\\/]/);if(isAbsolute(rel)||parts.length!==2||parts.some(p=>!p||p==='..'||p==='.')||parts[1]!==sessionId)refuse();
 canonicalDirectory(dirname(directory));if(existsSync(directory))canonicalDirectory(directory);return directory;
}
/** Registration occurs before the model query. Paths come from the pinned Host persistence, not tool/user input. */
export function registerImLog({db,sessionId,account,projectId,artifact,now}){
 if(artifact?.header?.id!==sessionId||artifact.header.isSeeded!==false||artifact.header.parentSession||artifact.header.version!==4||!Number.isSafeInteger(artifact.header.createdAt))refuse();
 const root=canonicalDirectory(resolve(artifact.root)),directory=dirname(resolve(artifact.path));assertRegisteredDirectory(root,directory,sessionId);
 if(!logName(basename(artifact.path)))refuse();
 const prior=db.prepare('SELECT * FROM collaboration_im_logs WHERE session_id=?').get(sessionId);
 if(prior){if(prior.state!=='registered'||prior.root!==root||prior.directory!==directory||prior.account!==account||prior.project_id!==projectId||prior.header_created_at!==artifact.header.createdAt||prior.cwd!==artifact.header.cwd)refuse();return prior;}
 db.prepare('INSERT INTO collaboration_im_logs(session_id,account,project_id,root,directory,cwd,header_created_at,registered_at,last_used_at,state) VALUES(?,?,?,?,?,?,?,?,?,?)').run(sessionId,account,projectId,root,directory,artifact.header.cwd,artifact.header.createdAt,now,now,'registered');
 return db.prepare('SELECT * FROM collaboration_im_logs WHERE session_id=?').get(sessionId);
}
async function firstHeader(path){
 const input=createReadStream(path),stream=path.endsWith('.zstd')?input.pipe(createZstdDecompress()):input;if(stream!==input)input.on('error',e=>stream.destroy(e));let buffer=Buffer.alloc(0);
 try{for await(const chunk of stream){buffer=Buffer.concat([buffer,chunk]);const end=buffer.indexOf(10);if(end>=0){if(end>65536)refuse();return JSON.parse(buffer.subarray(0,end).toString('utf8'));}if(buffer.length>65536)refuse();}refuse();}
 finally{stream.destroy();input.destroy();}
}
function identity(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||process.platform!=='win32'&&s.uid!==process.getuid())refuse();return {name:basename(path),size:s.size,mtime:s.mtimeMs,ino:String(s.ino),dev:String(s.dev)};}
async function inspect(row){
 assertRegisteredDirectory(row.root,row.directory,row.session_id);if(!existsSync(row.directory))return {missing:true,files:[]};const files=[];let logs=0;
 for(const name of readdirSync(row.directory).sort()){
  if(name==='session.lock'){identity(join(row.directory,name));continue;}
  if(!logName(name))refuse();const path=join(row.directory,name),fact=identity(path);
  if(!name.endsWith('.tmp')){const h=await firstHeader(path);if(h.type!=='session'||!Number.isSafeInteger(h.version)||h.version<0||h.version>4||h.id!==row.session_id||h.cwd!==row.cwd||h.createdAt!==row.header_created_at||h.isSeeded!==false||h.parentSession)refuse();logs++;}
  files.push(fact);
 }
 if(!logs&&row.state!=='purge-planned')refuse();return {missing:false,files};
}
const signature=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
/** Caller must hold the service maintenance lease for the whole scan/apply; no live Host is constructed. */
export async function purgeExpiredImLogs({identities,retentionDays,root,confirmation,now=Date.now(),dryRun=true,expectedPlanHash}){
 if(confirmation!=='PURGE_EXPIRED_IM_TRANSCRIPTS_AND_DATABASE_BODIES'||!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>90)refuse();canonicalDirectory(root);
 const cutoff=now-retentionDays*86400000,db=identities.db;
 const rows=db.prepare("SELECT * FROM collaboration_im_logs WHERE root=? AND state IN('registered','purge-planned') AND registered_at<? ORDER BY session_id").all(root,cutoff);
 const locks=[],observed=[];try{
  // Validate every target BEFORE the first deletion, then acquire the same per-session kernel ownership as Host JSONL.
  for(const row of rows){assertRegisteredDirectory(root,row.directory,row.session_id);if(existsSync(row.directory))locks.push(await acquireKernelLock(join(row.directory,'session.lock'),{session:true}));observed.push({sessionId:row.session_id,...await inspect(row)});}
  const planHash=signature(observed);if(dryRun)return {ok:true,dryRun:true,expiredSessions:rows.length,sessionIds:rows.map(r=>r.session_id),planHash,deleted:false};
  if(typeof expectedPlanHash!=='string'||expectedPlanHash!==planHash)refuse();
  // Tombstones commit first. A crash cannot make a half-deleted log resumable or an old ID reusable.
  identities.transaction(()=>{for(const row of rows)db.prepare("UPDATE collaboration_im_logs SET state='purge-planned' WHERE session_id=? AND state IN('registered','purge-planned')").run(row.session_id);identities.audit('offline-maintenance','im-transcript-purge-plan',planHash);});
  const latest=[];for(const row of rows)latest.push({sessionId:row.session_id,...await inspect({...row,state:'purge-planned'})});if(signature(latest)!==planHash)refuse();
  for(let i=0;i<rows.length;i++){
   const row=rows[i];assertRegisteredDirectory(root,row.directory,row.session_id);
   // Verify the exact absolute leaf immediately before unlink; never recurse through user paths or unknown artifacts.
   for(const f of observed[i].files){const path=join(row.directory,f.name);if(dirname(path)!==row.directory||JSON.stringify(identity(path))!==JSON.stringify(f))refuse();unlinkSync(path);}
   // Keep POSIX session.lock inode stable; remove the empty directory only when no lock file exists (Windows).
   if(existsSync(row.directory)&&readdirSync(row.directory).length===0){assertRegisteredDirectory(root,row.directory,row.session_id);rmdirSync(row.directory);}
   identities.transaction(()=>{db.prepare("UPDATE collaboration_im_logs SET state='purged',purged_at=? WHERE session_id=?").run(now,row.session_id);identities.audit('offline-maintenance','im-transcript-purged',row.session_id);});
  }
  return {ok:true,dryRun:false,expiredSessions:rows.length,sessionIds:rows.map(r=>r.session_id),planHash,imTranscriptBodiesDeleted:true,dshSessionsDeleted:false,formalDataDeleted:false,tombstonesRetained:true};
 }finally{for(const lock of locks.reverse())await lock.release();}
}
export {acquireMaintenanceLock};
