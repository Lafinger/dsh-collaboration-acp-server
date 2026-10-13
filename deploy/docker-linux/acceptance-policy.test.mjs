import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Exercise the actual policy plugin with only its private file paths relocated.
async function harness(mode, counters) {
  const root=mkdtempSync(join(tmpdir(),'collaboration-policy-')),counts=join(root,'counts.json'),modePath=join(root,'mode.json');
  writeFileSync(modePath,JSON.stringify({mode}));writeFileSync(counts,JSON.stringify(counters));
  const source=readFileSync(new URL('./acceptance-policy.mjs',import.meta.url),'utf8').replace("'/srv/collaboration/private-state/acceptance-counters.json'",JSON.stringify(counts)).replace("'/srv/collaboration/private-state/mode.json'",JSON.stringify(modePath));
  const plugin=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const handlers=new Map(),effects=[];const ctx={on:(name,fn)=>handlers.set(name,fn),effect:fn=>effects.push(fn()),provide:()=>{}};
  plugin.apply(ctx);return {handlers,cleanup:()=>effects.forEach(fn=>fn()),root,counts};
}
test('acceptance enforces output and cumulative request limits using actual plugin',async()=>{
 const h=await harness('acceptance',{turns:0,requests:23,completedTurns:0});
 try{const config=await h.handlers.get('agent/request')({agent:{session:{id:'test'},cancel(){}},turn:1},async()=>({provider:'codego',model:'deepseek-v4.1-flash'}));assert.equal(config.maxTokens,2048);
 let calls=0;h.handlers.get('llm/stream')({},()=>{calls++;});assert.equal(calls,1);assert.throws(()=>h.handlers.get('llm/stream')({},()=>{calls++;}),/ACCEPTANCE_REQUEST_LIMIT/);assert.equal(calls,1);
 }finally{h.cleanup();}
});
test('daily adds no request/count/token constraints, removes restored acceptance cap',async()=>{
 const h=await harness('daily',{turns:100,requests:1000,completedTurns:100});try{const config=await h.handlers.get('agent/request')({agent:{session:{id:'daily'},cancel(){throw new Error('Daily should not schedule cancel');}},turn:101},async()=>({provider:'codego',model:'deepseek-v4.1-flash',maxTokens:2048}));assert.equal(config.maxTokens,undefined);let called=false;h.handlers.get('llm/stream')({},()=>{called=true;});assert.equal(called,true);assert.equal(JSON.parse(readFileSync(h.counts,'utf8')).requests,1001);}finally{h.cleanup();}
});
test('policy rejects route fallback without executing alternative model',async()=>{
 const h=await harness('daily',{turns:0,requests:0,completedTurns:0});try{await assert.rejects(h.handlers.get('agent/request')({agent:{session:{id:'route'},cancel(){}},turn:1},async()=>({provider:'codego',model:'deepseek-v4-pro'})),/MODEL_ROUTE_NOT_ALLOWED/);}finally{h.cleanup();}
});
