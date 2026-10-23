import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRobotCommand,newDecisionCode,DECISION_CODE_ALPHABET} from '../src/robot-command.mjs';

const code='K7M4P9X2';
test('the six exact commands map only to their original decision kinds and outcomes',()=>{
  for(const [action,kind,outcome,reason] of [
    ['同意','plan_confirmation','agree',null],['拒绝','plan_confirmation','reject','缺少依据'],
    ['完成','result_review','complete',null],['退回','result_review','return','校验未通过'],
    ['接受','result_acceptance','accept',null],['拒收','result_acceptance','reject','版本不匹配'],
  ]){
    const result=parseRobotCommand(`${action} ${code}${reason?' '+reason:''}`);
    assert.equal(result.ok,true);assert.deepEqual(result.command,{kind,outcome,code,reason});assert.deepEqual(JSON.parse(result.canonical),result.command);
  }
});
test('only boundary whitespace and ASCII code case are normalized',()=>{
  const result=parseRobotCommand(' \n\t同意\t k7m4p9x2 \r\n');
  assert.equal(result.ok,true);assert.equal(result.command.code,code);assert.equal(result.canonical,parseRobotCommand('同意 '+code).canonical);
  const negative=parseRobotCommand(' 拒绝 '+code+'  需要改进  ');assert.equal(negative.command.reason,'需要改进');
});
test('bare agreement, latest guesses, batches, extra positive text and embedded commands are rejected',()=>{
  for(const input of ['同意','好','可以','yes','approve '+code,'完成最近一个','同意 '+code+' '+code,'同意 '+code+' 请通过','同意 '+code+'\n完成 '+code,'拒绝 '+code+' 原因 同意 T5V8Q2M7','拒绝 '+code+' 原因；接受 T5V8Q2M7','同意 '+code+';完成 '+code,'连通测试'])assert.equal(parseRobotCommand(input).ok,false,input);
});
test('negative decisions always require their own original business reason',()=>{
  for(const action of ['拒绝','退回','拒收'])for(const tail of ['',' ','\t'])assert.equal(parseRobotCommand(action+' '+code+tail).ok,false);
  assert.equal(parseRobotCommand('拒绝 '+code+' '+'因'.repeat(2000)).ok,true);
  assert.equal(parseRobotCommand('拒绝 '+code+' '+'因'.repeat(2001)).ok,false);
  for(const action of ['退回','拒收']){
    assert.equal(parseRobotCommand(action+' '+code+' '+'因'.repeat(8000)).ok,true);
    assert.equal(parseRobotCommand(action+' '+code+' '+'因'.repeat(8001)).ok,false);
  }
});
test('no fuzzy code, arbitrary object id, quote extraction or non-text wrapper is accepted',()=>{
  for(const input of [null,undefined,{},[],42,{text:{content:'同意 '+code}},'> 同意 '+code,'“同意 '+code+'”','转发：同意 '+code,'同意 K7M4P9X','同意 K7M4P9X22','同意 K7M4P9I2','同意 K7M4P9O2','同意 K7M4P9L2','同意 K7M4P902','同意 Ｋ７Ｍ４Ｐ９Ｘ２','同意 plan-arbitrary-id','拒绝 '+code+' 因\u0000为','拒绝 '+code+' 因\u2028为'])assert.equal(parseRobotCommand(input).ok,false,String(input));
});
test('generated codes have bounded exact syntax; uniqueness remains a persistence obligation',()=>{
  const seen=new Set();
  for(let n=0;n<1000;n++){const value=newDecisionCode();assert.equal(value.length,8);assert.ok([...value].every(c=>DECISION_CODE_ALPHABET.includes(c)));assert.equal(parseRobotCommand('同意 '+value).ok,true);seen.add(value);}
  assert.ok(seen.size>1);
});
