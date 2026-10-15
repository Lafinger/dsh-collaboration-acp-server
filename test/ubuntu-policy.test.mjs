import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {renderProfile} from '../deploy/ubuntu/render-profile.mjs';
import {cpaProviderConfig} from '../deploy/ubuntu/model-config.mjs';

test('Ubuntu profile is fixed-SHA, native image storage and closed gate only; old Docker remains historical',()=>{
 const root='/opt/dsh-collaboration-test/releases/'+'a'.repeat(40),source=renderProfile(root),entries=JSON.parse(source)[0].insert;
 for(const id of ['model-request-gate','llm-pi-ai','collaboration-server-mount'])assert.ok(entries.find(e=>e.id===id).name.startsWith(root+'/'));
 assert.equal(entries.find(e=>e.id==='attachments').config.maxImagesPerMessage,5);assert.equal(entries.find(e=>e.id==='attachments').config.normalizedImageMaxBytes,1048576);
 assert.ok(!/codego|dsh-web-app|dsh-terminal|dsh-tool-fs|subagent|llm-retry|controlled-dingtalk/.test(source));
 assert.equal(cpaProviderConfig.providers.cpa.retryPolicy.maxRetries,0);assert.deepEqual(cpaProviderConfig.providers.cpa.models[0].input,['text','image']);assert.equal(cpaProviderConfig.providers.cpa.reasoningEffort,undefined);
 for(const invalid of ['main','/tmp/'+'a'.repeat(40),root+'/../x',root+'\n'])assert.throws(()=>renderProfile(invalid));
 const key=readFileSync(new URL('../deploy/ubuntu/set-cpa-key.py',import.meta.url),'utf8'),activate=readFileSync(new URL('../deploy/ubuntu/activate-release.py',import.meta.url),'utf8');
 assert.match(key,/getpass\.getpass/);assert.match(key,/not sys.stdin.isatty/);assert.ok(!/subprocess|urllib|requests\./.test(key));assert.match(activate,/'modelRequestsAllowed': False/);assert.match(activate,/Restart=no/);assert.match(activate,/data_inventory\(\) != before/);
});
test('Ubuntu hidden input and exact activation preflight reject failures without live services or secrets',{skip:process.platform==='win32'?'POSIX deployment execution runs on Ubuntu CI':false},()=>{
 const result=spawnSync('python3',['-B','-m','unittest','discover','-s','deploy/ubuntu','-p','test_policy.py'],{cwd:new URL('..',import.meta.url),stdio:'inherit'});if(result.error)throw result.error;assert.equal(result.status,0);
});
