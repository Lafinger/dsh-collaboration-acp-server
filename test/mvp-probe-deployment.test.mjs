import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {Context} from '@deepseek-ai/cordis';import {LlmRuntime,LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import {renderMvpProbeProfile} from '../deploy/ubuntu/mvp-probe-profile.mjs';import {installProbeGate} from '../deploy/ubuntu/mvp-probe-gate.mjs';
import {renderProbeIngress,probeProxyInclude} from '../deploy/ubuntu/mvp-probe-ingress.mjs';

const candidate='/opt/dsh-collaboration-test/mvp-candidates/'+'d'.repeat(40)+'/runtime';
test('PC feasibility profile has independent persistence/state, real fixed CPA adapter but unconditional model gates and no IM/SSH',()=>{
 const source=renderMvpProbeProfile(candidate),entries=JSON.parse(source)[0].insert;
 assert.equal(entries.find(e=>e.id==='credentials').config.path,'/srv/dsh-collaboration-test/dsh-home/.credentials.yaml');
 assert.equal(entries.find(e=>e.id==='session-persistence').config.root,'/srv/dsh-collaboration-test/mvp-pc-probe/dsh-home/sessions');
 assert.equal(entries.find(e=>e.id==='attachments').config.dshHome,'/srv/dsh-collaboration-test/mvp-pc-probe/dsh-home');
 for(const id of ['model-request-gate','collaboration-server-mount'])assert.ok(entries.find(e=>e.id===id).name.startsWith(candidate+'/'));
 assert.ok(!/controlled-dingtalk|codego|dsh-web-app|dsh-tool-fs|dsh-terminal/.test(source));
 for(const wrong of [candidate+'/..','/tmp/runtime','main',candidate+'\n'])assert.throws(()=>renderMvpProbeProfile(wrong));
});
test('real Host probe gate rejects Agent requests and direct LLM before any model use',async()=>{
 const ctx=new Context();let calls=0,delegates=0;class Fixture extends LlmAdapter{async *stream(){calls++;yield{type:'finish',reason:{kind:'stop'}};}}
 try{await ctx.plugin(LlmRuntime).await();ctx.llm.registerAdapter(['cpa'],new Fixture());installProbeGate(ctx);
 await assert.rejects(ctx.waterfall('agent/request',{},()=>{delegates++;return{provider:'cpa',model:'deepseek-v4.1-flash'};}),/MVP_PC_IDENTITY_PROBE_ONLY/);
 assert.throws(()=>ctx.llm.stream({provider:'cpa',model:'deepseek-v4.1-flash',messages:[createUserMessage({content:[{type:'text',text:'never send'}],source:{kind:'user'}})],signal:AbortSignal.timeout(1000)}),/MVP_PC_IDENTITY_PROBE_ONLY/);
 assert.equal(calls,0);assert.equal(delegates,0);assert.equal(ctx.get('collaborationMvpProbePolicy').modelRequestsAllowed,false);
 }finally{await ctx.fiber.dispose();}
});
test('additive dedicated ingress keeps every existing byte and source/TLS/listener boundary; new paths have backend nonce CSP and WSS',()=>{
 const original=readFileSync(new URL('../deploy/ubuntu/login-lan.baseline.conf',import.meta.url),'utf8').replace('        listen 192.168.2.20:443 ssl;\n','        listen 192.168.2.20:443 ssl;\n        listen 10.242.169.184:443 ssl;\n');
 const changed=renderProbeIngress(original),added=changed.slice(changed.indexOf('        # Isolated MVP PC identity probe only.'),changed.indexOf('        location / { return 404; }'));
 assert.equal(changed.replace(added,''),original);assert.equal((changed.match(/proxy_pass http:\/\/127\.0\.0\.1:19481;/g)||[]).length,1);
 assert.match(added,/location = \/collaboration\/socket/);assert.match(added,/proxy_set_header Upgrade \$http_upgrade/);assert.match(probeProxyInclude,/add_header X-Collaboration-Probe/);assert.ok(!probeProxyInclude.includes('hide_header Content-Security-Policy'));
 for(const invalid of [changed,original.replace('19481','19480'),original.replaceAll('\n','\r\n')])assert.throws(()=>renderProbeIngress(invalid));
});
