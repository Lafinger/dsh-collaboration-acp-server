import * as server from 'dsh-collaboration-acp-server';
export const name='collaboration-ubuntu-mount';
export const inject=['agentLoop','sessionPersistence','credentials','attachments','collaborationLoginOnlyPolicy','collaborationCpaReady'];
export async function apply(ctx){
 if(ctx.get('collaborationLoginOnlyPolicy')?.modelRequestsAllowed!==false)throw new Error('Real model requests must remain disabled');
 const fiber=ctx.plugin(server,{configFile:'/srv/dsh-collaboration-test/dsh-home/collaboration-acp-server.json'});await fiber.await();
 if(fiber.ctx.get('collaborationServerStatus')?.state!=='running')throw new Error('Ubuntu collaboration backend is not running');
}
