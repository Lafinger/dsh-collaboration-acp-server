import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTestCollaboration} from './helpers/host.mjs';
for(const invalid of [false,true])test(`real QR factory keeps robot ${invalid?'invalid owner-file':'absent/default OFF'} isolated: zero network and no additive metadata`,{timeout:12000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'robot-default-off-')),stateRoot=join(root,'state');mkdirSync(stateRoot,{mode:0o700});
  if(invalid)writeFileSync(join(stateRoot,'robot-app-binding.json'),JSON.stringify({version:99,enabled:true,clientSecret:'synthetic-unused-only'}),{mode:0o600});
  const original=globalThis.fetch;let calls=0,f;globalThis.fetch=async()=>{calls++;throw Error('Unexpected robot network while disabled');};
  t.after(async()=>{try{await f?.runtime.closeAll();}finally{globalThis.fetch=original;}});
  f=await createTestCollaboration({mode:'mvp-qr',serviceId:'synthetic-default-off',workspace:join(root,'workspace'),stateRoot,dingtalk:{corpId:'synthetic-corp',clientId:'synthetic-identity-app',clientSecret:'synthetic-unused-identity-secret',administratorUserId:'a',publicOrigin:'https://offline.example'}});
  await f.robot.tick();assert.equal(f.robot.status().enabled,false);assert.equal(f.communication,null);assert.equal(calls,0);assert.equal(f.security.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'im_%'").all().length,0);assert.equal(f.security.db.prepare("SELECT value FROM collaboration_security_meta WHERE key='im-text-decision-schema'").get(),undefined);assert.equal(f.security.db.prepare('PRAGMA user_version').get().user_version,10);assert.equal(f.security.db.prepare('SELECT count(*) AS count FROM collaboration_members').get().count,0);
  const epoch=f.security.epoch;await f.robot.tick();assert.equal(f.security.epoch,epoch);await f.runtime.closeAll();assert.equal(f.security.db.isOpen,false);
});
