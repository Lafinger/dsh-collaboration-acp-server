import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const counts=JSON.parse(readFileSync('/srv/collaboration/private-state/acceptance-counters.json','utf8'));
assert.ok(counts.turns>0&&counts.turns<=6,'Acceptance turn budget');assert.ok(counts.requests>0&&counts.requests<=24,'Acceptance request budget');
let requests=0;const toolCalls=[];const eventTypes=new Map();
const expectedHeaders=counts.completedTurns;
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())walk(path);else if(entry.name.endsWith('.jsonl'))for(const line of readFileSync(path,'utf8').split('\n').filter(Boolean)){const event=JSON.parse(line);eventTypes.set(event.type,(eventTypes.get(event.type)??0)+1);if(event.type==='assistant/message'){const blocks=event.data?.message?.content??event.data?.content??[];for(const block of blocks)if(block.type==='tool-call')toolCalls.push({name:block.name});}if(event.type==='assistant/request'||event.type==='llm/request'||event.type==='request/header'){const config=event.data?.config??event.data?.header?.config;if(config?.provider==='codego'){assert.equal(config.maxTokens,2048,'Actual persisted provider request output cap');requests++;}}}}}
walk('/srv/collaboration/dsh-home/sessions');
assert.ok(requests>=expectedHeaders,'Persisted request headers must actually be inspected');
assert.equal(toolCalls.filter(call=>call.name==='project_create').length,1,'One business write only');
assert.ok(toolCalls.filter(call=>call.name==='project_list').length>=1,'Shared project read must use actual tool');
console.log(JSON.stringify({acceptanceBudget:'PASS',counts,persistedRequestHeadersChecked:requests,toolCalls,eventTypes:Object.fromEntries(eventTypes)},null,2));
