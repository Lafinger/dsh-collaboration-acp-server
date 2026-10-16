import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';

test('read-only retirement plan rejects live/mixed/new/linked artifacts and preserves unrelated app secrets',{skip:process.platform==='win32'?'Exact POSIX owner/mode/link preflight runs on Ubuntu CI; no Windows imitation of root semantics':false},()=>{
 const result=spawnSync('python3',['-B','-m','unittest','discover','-s','deploy/ubuntu','-p','test_mvp_retirement.py'],{cwd:new URL('..',import.meta.url),stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0);
});
