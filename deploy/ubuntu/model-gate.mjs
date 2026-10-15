import {openSync,closeSync,fstatSync,readFileSync,constants} from 'node:fs';
import {CPA_PROVIDER,CPA_MODEL} from './model-config.mjs';
export const name='collaboration-ubuntu-model-gate';
export const inject=['llm'];

/** Missing, malformed, non-boolean or off-route authorization always fails closed. */
export function validateModelPolicy(policy){
 if(!policy||typeof policy!=='object'||Array.isArray(policy)||policy.provider!==CPA_PROVIDER||policy.model!==CPA_MODEL||typeof policy.modelRequestsAllowed!=='boolean')throw new Error('Explicit boolean authorization for the configured CPA route is required');
 return Object.freeze({provider:CPA_PROVIDER,model:CPA_MODEL,modelRequestsAllowed:policy.modelRequestsAllowed});
}
export function requireModelPolicy(path){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid()||(st.mode&0o077)||st.size>65536)throw new Error('Private model policy required');
  return validateModelPolicy(JSON.parse(readFileSync(fd,'utf8')));
 }finally{closeSync(fd);}
}
// Retained for historical first-migration/closed-mode operational checks only.
export function requireClosedModelPolicy(path){
 if(requireModelPolicy(path).modelRequestsAllowed!==false)throw new Error('CPA route is configured for no real model requests; changing this requires separate authorization');
}
export function installModelPolicy(ctx,readPolicy){
 const read=()=>validateModelPolicy(readPolicy());
 const allowed=()=>{const policy=read();if(!policy.modelRequestsAllowed)throw new Error('MODEL_REQUESTS_DISABLED_FOR_LOGIN_ACCEPTANCE');return policy;};
 const route=(config,policy)=>{if(config?.provider!==policy.provider||config?.model!==policy.model)throw new Error('MODEL_ROUTE_NOT_AUTHORIZED');};
 read();
 ctx.on('agent/request',async(_payload,next)=>{allowed();const config=await next();route(config,allowed());return config;});
 ctx.on('llm/stream',(options,next)=>{route(options,allowed());return next();});
 ctx.provide('collaborationModelPolicy',Object.freeze({read}));
}
export function apply(ctx){
 const root=process.env.DSH_HOME;if(root!=='/srv/dsh-collaboration-test/dsh-home')throw new Error('Unexpected Ubuntu DSH_HOME');
 installModelPolicy(ctx,()=>requireModelPolicy(root+'/login-only-policy.json'));
}
