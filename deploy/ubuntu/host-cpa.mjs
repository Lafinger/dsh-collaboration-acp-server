import * as provider from '@deepseek-ai/dsh-llm-pi-ai';
import {cpaProviderConfig,CPA_PROVIDER,CPA_MODEL} from './model-config.mjs';
export const name='collaboration-ubuntu-cpa';
export const inject=['llm','credentials'];
export async function apply(ctx){
 const fiber=ctx.plugin(provider,cpaProviderConfig);await fiber.await();
 if(!ctx.llm.listProviders().some(route=>route.id===CPA_PROVIDER))throw new Error('CPA provider failed to register');
 const model=await ctx.llm.resolveModelInfo(CPA_PROVIDER,CPA_MODEL);
 if(!model.inputModalities?.includes('image'))throw new Error('CPA model image input declaration is missing');
 ctx.provide('collaborationCpaReady',true);
}
