import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServerConfiguration } from '../src/configuration.mjs';
const fixture = () => { const root = mkdtempSync(join(tmpdir(), 'server-config-')); return { root, file: join(root, 'config.json'), config: { serviceId: 'test', workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), socketPath: process.platform === 'win32' ? '\\\\.\\pipe\\config-test' : join(root, 'socket'), provider: 'fixture', model: 'fixture', accounts: { alice: 'a'.repeat(64) },dingtalk:{corpId:'corp',clientId:'app',clientSecret:'private-test-secret',publicOrigin:'https://login.example.test',loginPort:19481} } }; };
test('MVP file uses only unified HTTPS and fixed official administrator, no legacy accounts or socket',()=>{
 const f=fixture(),{accounts,socketPath,...plain}=f.config,value={...plain,mode:'mvp-https',dingtalk:{...plain.dingtalk,administratorUserId:'boss',agentId:'123'}};
 writeFileSync(f.file,JSON.stringify(value),{mode:0o600});const result=resolveServerConfiguration({configFile:f.file});assert.equal(result.state,'configured');assert.equal(result.config.dingtalk.loginTtlMs,604800000);assert.equal(result.config.accounts,undefined);
 for(const bad of [{...value,accounts},{...value,socketPath},{...value,dingtalk:{...value.dingtalk,agentId:''}},{...value,dingtalk:{...value.dingtalk,administratorUserId:''}}]){writeFileSync(f.file,JSON.stringify(bad),{mode:0o600});assert.equal(resolveServerConfiguration({configFile:f.file}).state,'configuration-required');}
});
test('QR mode requires same private HTTPS/organization/admin but no PC AgentId, never adopts legacy account fields',()=>{const f=fixture(),{accounts,socketPath,...plain}=f.config,value={...plain,mode:'mvp-qr',dingtalk:{...plain.dingtalk,administratorUserId:'boss'}};writeFileSync(f.file,JSON.stringify(value),{mode:0o600});const result=resolveServerConfiguration({configFile:f.file});assert.equal(result.state,'configured');assert.equal(result.config.dingtalk.loginTtlMs,604800000);assert.equal(result.config.dingtalk.agentId,undefined);writeFileSync(f.file,JSON.stringify({...value,accounts}),{mode:0o600});assert.equal(resolveServerConfiguration({configFile:f.file}).state,'configuration-required');});
test('QR and MVP organization re-verification lease defaults to 15 minutes and stays bounded at 60',()=>{
 const f=fixture(),{accounts,socketPath,...plain}=f.config,base={...plain,dingtalk:{...plain.dingtalk,administratorUserId:'boss'}};
 for(const mode of ['mvp-qr','mvp-https']){
  const value=mode==='mvp-qr'?{...base,mode}:{...base,mode,dingtalk:{...base.dingtalk,agentId:'123'}};
  writeFileSync(f.file,JSON.stringify(value),{mode:0o600});
  const configured=resolveServerConfiguration({configFile:f.file});
  assert.equal(configured.state,'configured',mode);
  assert.equal(configured.config.dingtalk.organizationTtlMs,900000,mode);
  writeFileSync(f.file,JSON.stringify({...value,dingtalk:{...value.dingtalk,organizationTtlMs:1800000}}),{mode:0o600});
  assert.equal(resolveServerConfiguration({configFile:f.file}).config.dingtalk.organizationTtlMs,1800000,mode);
  for(const organizationTtlMs of [0,3600001,1.5]){
   writeFileSync(f.file,JSON.stringify({...value,dingtalk:{...value.dingtalk,organizationTtlMs}}),{mode:0o600});
   assert.equal(resolveServerConfiguration({configFile:f.file}).state,'configuration-required',`${mode} ${organizationTtlMs}`);
  }
 }
});
test('missing configuration stays pending and does not expose guessed deployment values', () => {
  const f = fixture(), r = resolveServerConfiguration({ configFile: f.file });
  assert.equal(r.state, 'configuration-required'); assert.equal(r.config, undefined);
});
test('private complete JSON accepts host route and isolated paths without revealing credentials in status', () => {
  const f = fixture(); writeFileSync(f.file, '\uFEFF' + JSON.stringify(f.config), { mode: 0o600 });
  const { config, ...status } = resolveServerConfiguration({ configFile: f.file });
  assert.equal(status.state, 'configured'); assert.equal(config.provider, 'fixture');
  assert.ok(!JSON.stringify(status).includes('a'.repeat(64)));
});
test('invalid, ambiguous, legacy and shared-secret config fails closed with redacted reason', () => {
  const f = fixture();
  for (const value of [{ ...f.config, fixture: true }, { ...f.config, workspace: 'relative' }, { ...f.config, accounts: { alice: 'x'.repeat(64), bob: 'x'.repeat(64) } }, { ...f.config, stateRoot: f.config.workspace }, { ...f.config, model: '' }]) {
    writeFileSync(f.file, JSON.stringify(value), { mode: 0o600 }); const r = resolveServerConfiguration({ configFile: f.file });
    assert.equal(r.state, 'configuration-required'); assert.ok(!JSON.stringify(r).includes('x'.repeat(64)));
  }
  assert.equal(resolveServerConfiguration({ configFile: f.file, provider: 'fixture' }).state, 'configuration-required');
  writeFileSync(f.file, '{invalid'); assert.equal(resolveServerConfiguration({ configFile: f.file }).state, 'configuration-required');
  if (process.platform !== 'win32') { writeFileSync(f.file, JSON.stringify(f.config)); chmodSync(f.file, 0o644); assert.equal(resolveServerConfiguration({ configFile: f.file }).state, 'configuration-required'); }
});
