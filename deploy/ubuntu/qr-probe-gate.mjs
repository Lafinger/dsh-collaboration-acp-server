export const name='collaboration-mvp-qr-probe-gate';export const inject=['llm'];
export function installQrProbeGate(ctx){const denied=()=>{throw Error('QR_AUTHENTICATION_ONLY_NO_MODEL_REQUESTS');};ctx.on('agent/request',async()=>denied());ctx.on('llm/stream',denied);ctx.provide('collaborationQrProbePolicy',Object.freeze({modelRequestsAllowed:false}));}
export function apply(ctx){if(process.env.DSH_HOME!=='/srv/dsh-collaboration-test/mvp-qr-probe/dsh-home')throw Error('Unexpected QR probe home');installQrProbeGate(ctx);}
