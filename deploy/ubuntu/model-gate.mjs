import {readFileSync,lstatSync} from 'node:fs';
import {CPA_PROVIDER,CPA_MODEL} from './model-config.mjs';
export const name='collaboration-ubuntu-model-gate';
export const inject=['llm'];
export function requireClosedModelPolicy(path){
 const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077))throw new Error('Private model policy required');
 const policy=JSON.parse(readFileSync(path,'utf8'));
 if(policy.provider!==CPA_PROVIDER||policy.model!==CPA_MODEL||policy.modelRequestsAllowed!==false)throw new Error('CPA route is configured for no real model requests; changing this requires separate authorization');
}
export function apply(ctx){
 const root=process.env.DSH_HOME;if(root!=='/srv/dsh-collaboration-test/dsh-home')throw new Error('Unexpected Ubuntu DSH_HOME');
 const path=root+'/login-only-policy.json';requireClosedModelPolicy(path);
 const block=()=>{requireClosedModelPolicy(path);throw new Error('MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE');};
 ctx.on('agent/request',block);ctx.on('llm/stream',block);
 ctx.provide('collaborationLoginOnlyPolicy',Object.freeze({modelRequestsAllowed:false,provider:CPA_PROVIDER,model:CPA_MODEL}));
}
