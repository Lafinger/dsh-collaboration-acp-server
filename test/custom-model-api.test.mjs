import test from 'node:test';
import assert from 'node:assert/strict';
import {renderProfile} from '../deploy/ubuntu/render-profile.mjs';
import {cpaProviderConfig,CPA_BASE_URL,CPA_MODEL,CPA_CREDENTIAL_REF} from '../deploy/ubuntu/model-config.mjs';
import * as mount from '../deploy/ubuntu/mount-server.mjs';

test('Ubuntu uses DSH standard custom-model API directly for the external CPA, not a CPA-specific provider plugin',()=>{
 const release='/opt/dsh-collaboration-test/releases/'+'a'.repeat(40),entries=JSON.parse(renderProfile(release))[0].insert;
 const provider=entries.find(entry=>entry.id==='llm-pi-ai');
 assert.equal(provider.name,'@deepseek-ai/dsh-llm-pi-ai','External CPA must be ordinary DSH custom API configuration, not host-cpa.mjs');
 assert.deepEqual(provider.config,cpaProviderConfig);
 const custom=provider.config.providers.cpa;
 assert.equal(custom.baseURL,CPA_BASE_URL);assert.equal(custom.api,'openai-responses');assert.equal(custom.apiKeyEnv,CPA_CREDENTIAL_REF);
 assert.equal(custom.models[0].id,CPA_MODEL);assert.deepEqual(custom.models[0].input,['text','image']);assert.equal(custom.retryPolicy.maxRetries,0);
 assert.ok(!JSON.stringify(entries).includes('host-cpa.mjs'));assert.ok(!mount.inject.includes('collaborationCpaReady'));
 for(const id of ['model-request-gate','collaboration-server-mount'])assert.ok(entries.find(entry=>entry.id===id).name.startsWith(release+'/'));
 assert.equal(entries.find(entry=>entry.id==='attachments').name,'@deepseek-ai/dsh-attachment-local');
});
