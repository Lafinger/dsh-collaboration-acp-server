#!/usr/bin/env node
import {lstatSync} from 'node:fs';import {join,isAbsolute} from 'node:path';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
import {resolveServerConfiguration} from './configuration.mjs';import {acquireMaintenanceLock} from './maintenance-lock.mjs';import {upgradePcAuthenticationToQr} from './qr-identities.mjs';
/** Explicit stopped-service migration only. Never starts a Host/model or changes configuration/network/business/session metadata. */
export async function upgradeQrAuthentication({configFile,confirmation}){
 if(!isAbsolute(configFile??'')||confirmation!=='REVOKE_PC_DEVICES_PRESERVE_MEMBERS_AND_SESSIONS')throw Error('Explicit absolute private config and scope confirmation required');
 const resolved=resolveServerConfiguration({configFile});if(resolved.state!=='configured'||!['mvp-https','mvp-qr'].includes(resolved.config.mode))throw Error('Current private MVP configuration required');
 const config=resolved.config,path=join(config.stateRoot,'collaboration.sqlite'),before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error('Existing ordinary MVP database required');
 const lease=await acquireMaintenanceLock(config.stateRoot);let db;
 try{const after=lstatSync(path);if(!after.isFile()||after.isSymbolicLink()||after.nlink!==1||after.dev!==before.dev||after.ino!==before.ino)throw Error('Database changed while acquiring stopped-service lock');
  db=new DatabaseSync(path);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
  return upgradePcAuthenticationToQr({db,serviceId:config.serviceId,...config.dingtalk});
 }finally{try{db?.close();}finally{await lease.release();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{const [configFile,confirmation,...extra]=process.argv.slice(2);if(extra.length)throw Error('Unexpected parameters');console.log(JSON.stringify(await upgradeQrAuthentication({configFile,confirmation})));}catch{console.error('QR authentication upgrade refused or incomplete. Keep the service stopped and inspect private scope/maintenance state; no credentials are printed.');process.exitCode=1;}}
