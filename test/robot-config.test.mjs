import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateRobotBinding,readRobotBinding} from '../src/robot-config.mjs';
const value=()=>({version:1,purpose:'independent-robot-application',corpId:'synthetic-corp',clientId:'synthetic-message-app',clientSecret:'synthetic-unused-secret',robotCode:'synthetic-robot',pilotAccounts:['synthetic-a','synthetic-b'],enabled:false});
const security={serviceId:'synthetic-service',corpId:'synthetic-corp',clientId:'synthetic-identity-app',member:account=>['synthetic-a','synthetic-b'].includes(account)?{corp_id:'synthetic-corp',client_id:'synthetic-identity-app',enabled:0}:null};
function fixture(data=value()){
  const content=Buffer.from(JSON.stringify(data)),directory={uid:1001,mode:0o40700,dev:1,ino:10,isDirectory:()=>true,isSymbolicLink:()=>false},file={uid:1001,mode:0o100600,dev:1,ino:20,nlink:1,size:content.length,mtimeMs:1,ctimeMs:1,isFile:()=>true,isSymbolicLink:()=>false};
  const state={content,directory,file,reads:0,opens:0,closes:0,stats:0,current:()=>({...file}),after:()=>({...file})};
  const fsImpl={constants:{O_RDONLY:0,O_NOFOLLOW:131072},lstatSync:path=>path.endsWith('robot-app-binding.json')?state.current():{...directory},openSync:(_path,flags)=>{assert.equal(flags&131072,131072);state.opens++;return 42;},fstatSync:()=>++state.stats===1?{...file}:state.after(),readSync:(_fd,buffer)=>{state.reads++;return state.content.copy(buffer);},closeSync:()=>{state.closes++;}};
  return {state,fsImpl,read:()=>readRobotBinding({root:'synthetic-root',security,fsImpl,platform:'linux',uid:1001})};
}
test('binding validates only the existing original identity scope and an independent application; disabled members are not enrolled or globally excluded',()=>{
  const first=validateRobotBinding(value(),security);assert.equal(first.enabled,false);assert.equal(Object.isFrozen(first),true);assert.equal(Object.isFrozen(first.pilotAccounts),true);assert.equal(first.scopeKey.length,64);
  assert.equal(validateRobotBinding({...value(),clientSecret:'synthetic-rotated'},security).scopeKey,first.scopeKey);assert.notEqual(validateRobotBinding({...value(),clientId:'synthetic-other-message-app'},security).scopeKey,first.scopeKey);
});
test('unknown schema, ambiguous switch, same identity app, different corp and unknown or duplicate pilots all fail closed',()=>{
  for(const override of [{version:2},{purpose:'other'},{enabled:'true'},{clientId:security.clientId},{corpId:'synthetic-other'},{pilotAccounts:['synthetic-a']},{pilotAccounts:['synthetic-a','synthetic-a']},{pilotAccounts:['synthetic-a','unknown']},{clientSecret:'secret\n'},{extra:true}])assert.throws(()=>validateRobotBinding({...value(),...override},security));
});
test('protected false/true files are read only and return a private binding, not network or enrollment effects',()=>{
  for(const enabled of [false,true]){const f=fixture({...value(),enabled}),result=f.read();assert.equal(result.enabled,enabled);assert.equal(result.reason,enabled?'ready':'disabled');assert.equal(result.binding.clientSecret,'synthetic-unused-secret');assert.equal(result.fingerprint.length,64);assert.equal(f.state.reads,1);assert.equal(f.state.closes,1);}
});
test('unsafe root, ownership, permissions, type, hardlink or size are refused before credential bytes are read',()=>{
  for(const change of [f=>{f.state.directory.mode=0o40755;},f=>{f.state.directory.uid=1002;},f=>{f.state.directory.isSymbolicLink=()=>true;},f=>{f.state.file.uid=1002;},f=>{f.state.file.mode=0o100644;},f=>{f.state.file.nlink=2;},f=>{f.state.file.isFile=()=>false;},f=>{f.state.file.size=32769;}]){
    const f=fixture();change(f);const result=f.read();assert.equal(result.enabled,false);assert.equal(f.state.reads,0);assert.ok(!JSON.stringify(result).includes('synthetic-unused-secret'));assert.equal(f.state.closes,f.state.opens);
  }
});
test('replacement or mutation between bounded read and pathname check is not an enabled configuration',()=>{
  for(const change of [f=>{f.state.current=()=>({...f.state.file,ino:99});},f=>{f.state.after=()=>({...f.state.file,mtimeMs:2});},f=>{f.state.current=()=>({...f.state.file,mtimeMs:2});},f=>{f.state.current=()=>({...f.state.file,nlink:2});},f=>{f.state.current=()=>({...f.state.file,isSymbolicLink:()=>true});}]){
    const f=fixture({...value(),enabled:true});change(f);assert.equal(f.read().enabled,false);assert.equal(f.state.closes,1);
  }
});
test('missing files, no-follow failures and missing no-follow support only disable the optional robot',()=>{
  const absent=fixture();absent.fsImpl.openSync=()=>{throw Object.assign(new Error('synthetic missing'),{code:'ENOENT'});};assert.equal(absent.read().reason,'absent');
  const linked=fixture();linked.fsImpl.openSync=()=>{throw Object.assign(new Error('synthetic no-follow failure'),{code:'ELOOP'});};assert.equal(linked.read().enabled,false);
  const unsupported=fixture();unsupported.fsImpl.constants.O_NOFOLLOW=0;assert.equal(unsupported.read().enabled,false);assert.equal(unsupported.state.opens,0);
});
test('native Linux owner-file rules are exercised where supported; other platforms explicitly fail the optional feature closed',()=>{
  if(process.platform!=='linux'){assert.equal(readRobotBinding({root:'synthetic-root',security}).reason,'robot-credential-platform-unverified');return;}
  const root=fs.mkdtempSync(join(tmpdir(),'robot-credentials-'));fs.chmodSync(root,0o700);const path=join(root,'robot-app-binding.json');fs.writeFileSync(path,JSON.stringify({...value(),enabled:true}),{mode:0o600});assert.equal(readRobotBinding({root,security}).enabled,true);fs.chmodSync(path,0o644);assert.equal(readRobotBinding({root,security}).enabled,false);
});
