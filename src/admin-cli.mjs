#!/usr/bin/env node
import {readFileSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveServerConfiguration} from './configuration.mjs';
import {openDatabase} from '../business/lib/sqlite/connection.js';
import {ProjectService} from '../business/lib/service/project-service.js';
import {IdentityStore} from './identity-store.mjs';
import {administer} from './admin.mjs';
import {CommunicationStore} from './communication-store.mjs';

export function runAdmin({configFile,commandFile}){
  if(!isAbsolute(commandFile??''))throw new Error('Use an absolute private command-file path; never put secrets in command-line arguments');
  const stat=lstatSync(commandFile);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('Administrator command must be a bounded regular file');
  if(process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)))throw new Error('Administrator command requires service ownership and mode0600');
  const resolved=resolveServerConfiguration({configFile});if(resolved.state!=='configured')throw new Error(resolved.message);
  if(['mvp-https','mvp-qr'].includes(resolved.config.mode))throw new Error('MVP has no local member provisioning; use authenticated DSH project/role actions');
  const command=JSON.parse(readFileSync(commandFile,'utf8').replace(/^\uFEFF/,'')),config=resolved.config;
  const database=join(config.stateRoot,'collaboration.sqlite');
  if(!lstatSync(database).isFile())throw new Error('Initialize the configured isolated service before administrative provisioning');
  const db=openDatabase({path:database});
  try{const identities=new IdentityStore({db,serviceId:config.serviceId,...config.dingtalk});return administer({identities,projects:new ProjectService(db),configuredAccounts:config.accounts,communication:new CommunicationStore({identities,retentionDays:config.dingtalk.communicationRetentionDays,recover:false})},command);}
  finally{db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const [configFile,commandFile,...extra]=process.argv.slice(2);if(extra.length)throw new Error('Usage: admin-cli.mjs ABSOLUTE_PRIVATE_CONFIG ABSOLUTE_PRIVATE_COMMAND');
    console.log(JSON.stringify(runAdmin({configFile,commandFile})));}
  catch{console.error('Administrator operation failed; inspect private configuration, command and qualification. No credentials are printed.');process.exitCode=1;}
}
