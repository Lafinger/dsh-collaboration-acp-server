import * as server from 'dsh-collaboration-acp-server';
export const name='collaboration-mvp-pc-probe-mount';
export const inject=['llm','agentLoop','sessionPersistence','credentials','attachments','collaborationMvpProbePolicy'];
export async function apply(ctx){
 if(ctx.get('collaborationMvpProbePolicy')?.modelRequestsAllowed!==false)throw Error('Closed isolated PC probe policy required');
 const fiber=ctx.plugin(server,{configFile:'/srv/dsh-collaboration-test/mvp-pc-probe/dsh-home/collaboration-acp-server.json'});await fiber.await();
 if(fiber.ctx.get('collaborationServerStatus')?.state!=='running')throw Error('Isolated official PC identity probe is not running');
 // No model, existing project or member provisioning call occurs here.
}
