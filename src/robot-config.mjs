import * as nativeFs from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const keys=['version','purpose','corpId','clientId','clientSecret','robotCode','pilotAccounts','enabled'].sort();
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);
const unavailable=()=>({enabled:false,reason:'robot-configuration-unavailable'});
/** Pure validation. No enrollment, configuration repair, identity migration or network fallback. */
export function validateRobotBinding(value,security){
  if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(keys))throw new Error('Robot configuration unavailable');
  if(value.version!==1||value.purpose!=='independent-robot-application'||typeof value.enabled!=='boolean'||!text(value.corpId,200)||value.corpId!==security.corpId||!text(value.clientId,200)||value.clientId===security.clientId||!text(value.robotCode,200)||!text(value.clientSecret,4096))throw new Error('Robot configuration unavailable');
  if(!Array.isArray(value.pilotAccounts)||value.pilotAccounts.length!==2||new Set(value.pilotAccounts).size!==2)throw new Error('Robot configuration unavailable');
  for(const account of value.pilotAccounts){
    if(!text(account,200))throw new Error('Robot configuration unavailable');
    const member=security.member(account);if(!member||member.corp_id!==security.corpId||member.client_id!==security.clientId)throw new Error('Robot configuration unavailable');
  }
  const scopeKey=hash(JSON.stringify(['robot-text-v1',security.serviceId,security.corpId,security.clientId,value.clientId,value.robotCode]));
  return Object.freeze({...value,pilotAccounts:Object.freeze([...value.pilotAccounts]),scopeKey});
}
/** Linux protected owner-file only. Invalid/absent/off never changes or breaks the original DSH.
 * Credentials remain inside this trusted loader's caller; never log/serialize its binding.
 * Other platforms fail the optional robot closed rather than claiming unverified ACL safety.
 */
export function readRobotBinding({root,security,fsImpl=nativeFs,platform=process.platform,uid=process.getuid?.()}){
  if(platform!=='linux'||!Number.isSafeInteger(uid))return {enabled:false,reason:'robot-credential-platform-unverified'};
  let fd;
  try{
    const directory=resolve(root),path=join(directory,'robot-app-binding.json'),parent=fsImpl.lstatSync(directory);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==uid||(parent.mode&0o077)!==0)return unavailable();
    const flags=fsImpl.constants;if(!Number.isInteger(flags?.O_NOFOLLOW)||flags.O_NOFOLLOW===0)return unavailable();
    fd=fsImpl.openSync(path,flags.O_RDONLY|flags.O_NOFOLLOW);
    const before=fsImpl.fstatSync(fd);
    if(!before.isFile()||before.uid!==uid||(before.mode&0o777)!==0o600||before.nlink!==1||before.size<1||before.size>32768)return unavailable();
    const bytes=Buffer.alloc(before.size+1),count=fsImpl.readSync(fd,bytes,0,bytes.length,0),after=fsImpl.fstatSync(fd),current=fsImpl.lstatSync(path),parentAfter=fsImpl.lstatSync(directory);
    if(count!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.uid!==before.uid||after.mode!==before.mode||after.nlink!==1||current.isSymbolicLink()||current.dev!==before.dev||current.ino!==before.ino||current.uid!==before.uid||current.mode!==before.mode||current.nlink!==1||current.size!==before.size||current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs||!parentAfter.isDirectory()||parentAfter.isSymbolicLink()||parentAfter.dev!==parent.dev||parentAfter.ino!==parent.ino||parentAfter.uid!==uid||(parentAfter.mode&0o077)!==0)return unavailable();
    const content=bytes.subarray(0,count),binding=validateRobotBinding(JSON.parse(content.toString('utf8')),security);
    return {enabled:binding.enabled,reason:binding.enabled?'ready':'disabled',fingerprint:hash(content),binding};
  }catch(error){return error?.code==='ENOENT'?{enabled:false,reason:'absent'}:unavailable();}
  finally{if(fd!==undefined)try{fsImpl.closeSync(fd);}catch{}}
}
