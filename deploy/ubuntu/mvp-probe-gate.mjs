export const name='collaboration-mvp-pc-probe-gate';
export const inject=['llm'];
/** PC feasibility is not a second paid business environment. No requests, auxiliary prompts or retries. */
export function installProbeGate(ctx){
 const denied=()=>{throw new Error('MVP_PC_IDENTITY_PROBE_ONLY_NO_MODEL_REQUESTS');};
 ctx.on('agent/request',async()=>denied());ctx.on('llm/stream',denied);
 ctx.provide('collaborationMvpProbePolicy',Object.freeze({modelRequestsAllowed:false}));
}
export function apply(ctx){
 if(process.env.DSH_HOME!=='/srv/dsh-collaboration-test/mvp-pc-probe/dsh-home')throw new Error('Unexpected isolated PC probe home');
 installProbeGate(ctx);
}
