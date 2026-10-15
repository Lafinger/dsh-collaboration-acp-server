import test from 'node:test';
import assert from 'node:assert/strict';
import {CPA_PROVIDER,CPA_MODEL,CPA_BASE_URL,CPA_CREDENTIAL_REF,cpaProviderConfig} from '../deploy/ubuntu/model-config.mjs';
import {renderProfile} from '../deploy/ubuntu/render-profile.mjs';

test('Ubuntu CPA default is deepseek-v4.1-flash without changing provider, Responses endpoint or credential reference',()=>{
 assert.equal(CPA_PROVIDER,'cpa');assert.equal(CPA_MODEL,'deepseek-v4.1-flash');
 assert.equal(CPA_BASE_URL,'http://10.242.66.179:8317/v1');assert.equal(CPA_CREDENTIAL_REF,'CPA_API_KEY');
 const entries=JSON.parse(renderProfile('/opt/dsh-collaboration-test/releases/'+'a'.repeat(40)))[0].insert;
 const entry=entries.find(row=>row.id==='llm-pi-ai');assert.equal(entry.name,'@deepseek-ai/dsh-llm-pi-ai');
 assert.deepEqual(entry.config,cpaProviderConfig);const provider=entry.config.providers.cpa;
 assert.equal(provider.api,'openai-responses');assert.equal(provider.baseURL,CPA_BASE_URL);
 assert.equal(provider.models[0].id,'deepseek-v4.1-flash');assert.equal(provider.models[0].name,'deepseek-v4.1-flash');
 assert.equal(provider.retryPolicy.maxRetries,0);assert.equal(provider.apiKeyEnv,'CPA_API_KEY');
 assert.ok(entries.some(row=>row.id==='model-request-gate'));assert.ok(!JSON.stringify(entries).includes('codego'));
});
