import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {LlmRuntime,LlmAdapter,createUserMessage} from '@deepseek-ai/dsh-llm';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as gate from '../deploy/ubuntu/model-gate.mjs';
import * as mount from '../deploy/ubuntu/mount-server.mjs';
import {CPA_PROVIDER,CPA_MODEL} from '../deploy/ubuntu/model-config.mjs';

const policy=allowed=>({provider:CPA_PROVIDER,model:CPA_MODEL,modelRequestsAllowed:allowed});

test('private model policy file admits only explicit boolean allow/deny on the fixed CPA route',{skip:process.platform==='win32'?'POSIX ownership and modes run on Ubuntu CI':false},()=>{
 assert.equal(typeof gate.requireModelPolicy,'function');
 const directory=mkdtempSync(join(tmpdir(),'model-authorization-')),path=join(directory,'policy.json');
 const save=value=>{writeFileSync(path,JSON.stringify(value),{mode:0o600});chmodSync(path,0o600);};
 for(const allowed of[false,true]){save(policy(allowed));assert.deepEqual(gate.requireModelPolicy(path),policy(allowed));assert.ok(Object.isFrozen(gate.requireModelPolicy(path)));}
 for(const invalid of[{provider:'codego',model:CPA_MODEL,modelRequestsAllowed:true},{...policy(true),model:'other'}, {...policy(true),modelRequestsAllowed:'true'},{...policy(true),modelRequestsAllowed:undefined}]){save(invalid);assert.throws(()=>gate.requireModelPolicy(path));}
 save(policy(false));gate.requireClosedModelPolicy(path);save(policy(true));assert.throws(()=>gate.requireClosedModelPolicy(path));
 assert.throws(()=>gate.requireModelPolicy(join(directory,'missing')));writeFileSync(path,'not-json');assert.throws(()=>gate.requireModelPolicy(path));
 if(process.platform!=='win32'){save(policy(true));chmodSync(path,0o644);assert.throws(()=>gate.requireModelPolicy(path));chmodSync(path,0o600);const link=join(directory,'link');symlinkSync(path,link);assert.throws(()=>gate.requireModelPolicy(link));}
});

test('actual Cordis waterfalls and LLM stay blocked until explicitly allowed; close, drift and corrupt policy fail closed',async()=>{
 assert.equal(typeof gate.installModelPolicy,'function');
 const ctx=new Context();let current=policy(false),calls=0,delegations=0;
 class Fixture extends LlmAdapter{async *stream(){calls++;yield{type:'finish',reason:{kind:'stop'}};}}
 const request=()=>ctx.waterfall('agent/request',{},()=>{delegations++;return{provider:CPA_PROVIDER,model:CPA_MODEL};});
 const options=()=>({provider:CPA_PROVIDER,model:CPA_MODEL,messages:[createUserMessage({content:[{type:'text',text:'synthetic only'}],source:{kind:'user'}})],signal:AbortSignal.timeout(1000)});
 try{
  await ctx.plugin(LlmRuntime).await();ctx.llm.registerAdapter([CPA_PROVIDER],new Fixture());gate.installModelPolicy(ctx,()=>current);
  await assert.rejects(request,/MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE/);assert.throws(()=>ctx.llm.stream(options()),/MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE/);assert.equal(calls,0);assert.equal(delegations,0);
  current=policy(true);assert.deepEqual(await request(),{provider:CPA_PROVIDER,model:CPA_MODEL});const chunks=[];for await(const chunk of ctx.llm.stream(options()))chunks.push(chunk);assert.equal(chunks.at(-1).reason.kind,'stop');assert.equal(calls,1);assert.equal(delegations,1);
  assert.throws(()=>ctx.llm.stream({...options(),model:'other'}),/MODEL_ROUTE_NOT_AUTHORIZED/);assert.equal(calls,1);
  current=policy(false);await assert.rejects(request,/MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE/);assert.throws(()=>ctx.llm.stream(options()),/MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE/);
  current={...policy(true),modelRequestsAllowed:'true'};await assert.rejects(request);assert.equal(calls,1);
   current=policy(false);assert.deepEqual(ctx.get('collaborationModelPolicy').read(),policy(false));
 }finally{await ctx.fiber.dispose();}
});

test('mount accepts a validated closed or explicitly authorized policy, not a missing or forged one',()=>{
 assert.equal(typeof mount.requireMountPolicy,'function');
 for(const allowed of[false,true])assert.deepEqual(mount.requireMountPolicy({read:()=>policy(allowed)}),policy(allowed));
 for(const invalid of[undefined,{},policy(true),{read:()=>({...policy(true),model:'other'})},{read:()=>({...policy(true),modelRequestsAllowed:'true'})}])assert.throws(()=>mount.requireMountPolicy(invalid));
});
