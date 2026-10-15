import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('network-only B ZeroTier change preserves LAN, narrows firewall, refuses drift and rolls back reload failure',()=>{
 const python=process.platform==='win32'?'python':'python3';
 const result=spawnSync(python,['-B','-m','unittest','discover','-s','deploy/ubuntu','-p','test_member_zerotier.py'],{cwd:new URL('..',import.meta.url),stdio:'inherit'});
 if(result.error)throw result.error;
 assert.equal(result.status,0);
});

test('verified B public-key enrollment is exact-scoped, source32 restricted, A-safe and rollback-capable',()=>{
 const python=process.platform==='win32'?'python':'python3';
 const result=spawnSync(python,['-B','-m','unittest','discover','-s','deploy/ubuntu','-p','test_member_enrollment.py'],{cwd:new URL('..',import.meta.url),stdio:'inherit'});
 if(result.error)throw result.error;
 assert.equal(result.status,0);
});
