import * as server from 'dsh-collaboration-acp-server';
// Startup barrier only: mount the unmodified released plugin after real host services exist.
export const name = 'collaboration-linux-mount';
export const inject = ['agentLoop', 'sessionPersistence', 'credentials', 'collaborationAcceptancePolicy', 'collaborationCodegoReady'];
export async function apply(ctx) {
  if (!ctx.get('llm').listProviders().some(route => route.id === 'codego')) throw new Error('Codego host provider unavailable');
  const fiber = ctx.plugin(server, { configFile: '/srv/collaboration/dsh-home/collaboration-acp-server.json' });
  await fiber.await();
  const status = fiber.ctx.get('collaborationServerStatus');
  if (status?.state !== 'running') throw new Error('Collaboration service did not enter running state');
}
