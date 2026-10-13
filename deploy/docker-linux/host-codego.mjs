import * as provider from '@deepseek-ai/dsh-llm-pi-ai';
export const name = 'collaboration-host-codego';
export const inject = ['llm', 'credentials'];
export async function apply(ctx, config) {
  const fiber = ctx.plugin(provider, config);
  await fiber.await();
  if (!ctx.llm.listProviders().some(route => route.id === 'codego')) throw new Error('Codego route failed to register');
  ctx.provide('collaborationCodegoReady', true);
}
