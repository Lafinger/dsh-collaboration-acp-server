import * as server from 'dsh-collaboration-acp-server';
import {validateModelPolicy} from './model-gate.mjs';
export const name='collaboration-ubuntu-mount';
export const inject=['llm','agentLoop','sessionPersistence','credentials','attachments','collaborationModelPolicy'];
export function requireMountPolicy(service){
 if(typeof service?.read!=='function')throw new Error('Validated collaboration model policy required');
 return validateModelPolicy(service.read());
}
export async function apply(ctx){
 requireMountPolicy(ctx.get('collaborationModelPolicy'));
 const fiber=ctx.plugin(server,{configFile:'/srv/dsh-collaboration-test/dsh-home/collaboration-acp-server.json'});await fiber.await();
 if(fiber.ctx.get('collaborationServerStatus')?.state!=='running')throw new Error('Ubuntu collaboration backend is not running');
}
