#!/usr/bin/env node
import {readFileSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {resolveServerConfiguration} from './configuration.mjs';
import {IdentityStore} from './identity-store.mjs';
import {CommunicationStore} from './communication-store.mjs';
import {acquireMaintenanceLock,canonicalDirectory,purgeExpiredImLogs} from './im-log-retention.mjs';

/** Explicit OS-local, stopped-service command. No Host, platform login, model or runtime startup. */
export async function runMaintenance({configFile,commandFile}){
 if(!isAbsolute(commandFile??''))throw new Error('Absolute private command file required');
 const stat=lstatSync(commandFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)))throw new Error('Private maintenance command file required');
 const c=JSON.parse(readFileSync(commandFile,'utf8').replace(/^\uFEFF/,''));
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['action','sessionRoot','confirmation','dryRun','expectedPlanHash'].includes(k))||c.action!=='purge-expired-communication'||typeof c.dryRun!=='boolean'||c.confirmation!=='PURGE_EXPIRED_IM_TRANSCRIPTS_AND_DATABASE_BODIES')throw new Error('Explicit bounded maintenance command required');
 const resolved=resolveServerConfiguration({configFile});if(resolved.state!=='configured')throw new Error('Configured isolated service required');const config=resolved.config;
 canonicalDirectory(config.stateRoot);canonicalDirectory(c.sessionRoot);
 const database=join(config.stateRoot,'collaboration.sqlite'),d=lstatSync(database);if(!d.isFile()||d.isSymbolicLink()||d.nlink!==1)throw new Error('Existing isolated database required');
 const lease=await acquireMaintenanceLock(config.stateRoot);let db;
 try{
  // Do not migrate business schemas or crash-recover live/unknown communication work from this maintenance command.
  db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
  for(const name of ['collaboration_security_meta','collaboration_im_logs','collaboration_inbox','collaboration_outbox'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))throw new Error('Start and stop the new isolated service once to register owned transcripts');
  const identities=new IdentityStore({db,serviceId:config.serviceId,...config.dingtalk});
  const result=await purgeExpiredImLogs({identities,root:c.sessionRoot,retentionDays:config.dingtalk.communicationRetentionDays,confirmation:c.confirmation,dryRun:c.dryRun,expectedPlanHash:c.expectedPlanHash});
  const otherRegisteredRoots=Number(db.prepare("SELECT count(DISTINCT root) n FROM collaboration_im_logs WHERE root<>? AND state<>'purged'").get(c.sessionRoot).n);
  if(c.dryRun)return {...result,databaseBodiesDeleted:false,otherRegisteredRoots};
  const communication=new CommunicationStore({identities,retentionDays:config.dingtalk.communicationRetentionDays,recover:false});
  return {...result,otherRegisteredRoots,database:communication.purge({confirmation:'PURGE_EXPIRED_COMMUNICATION_BODIES'},'offline-maintenance'),copiesInBackupsOrPlatformDeleted:false};
 }finally{try{db?.close();}finally{await lease.release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const[configFile,commandFile,...extra]=process.argv.slice(2);if(extra.length)throw new Error('Usage: maintenance-cli.mjs ABSOLUTE_PRIVATE_CONFIG ABSOLUTE_PRIVATE_COMMAND');console.log(JSON.stringify(await runMaintenance({configFile,commandFile})));}
 catch{console.error('Offline communication maintenance refused or incomplete. Keep the service stopped; inspect the private command and audit, dry-run again. No credentials or message bodies are printed.');process.exitCode=1;}
}
