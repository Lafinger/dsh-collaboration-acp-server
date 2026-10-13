import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from './helpers/host.mjs';
import * as plugin from '../src/server-plugin.mjs';
const prepare = () => {
  const root = mkdtempSync(join(tmpdir(), 'incomplete-host-')); const dir = join(root, 'socket'); mkdirSync(dir, { mode: 0o700 });
  const config = { serviceId: 'pending', workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\pending-${randomUUID()}` : join(dir, 'service.sock'), provider: 'not-registered', model: 'test', accounts: { alice: 'a'.repeat(64) } };
  const configFile = join(root, 'config.json'); writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 }); return { configFile, root };
};
test('complete config but no host services stays pending without opening database', async () => {
  const f = prepare(), ctx = new Context(); try { const entry = ctx.plugin(plugin, { configFile: f.configFile }); await entry.await(); assert.equal(entry.ctx.get('collaborationServerStatus').state, 'configuration-required'); assert.equal(existsSync(join(f.root, 'state')), false); } finally { await ctx.fiber.dispose(); }
});
test('unknown host model provider refuses activation before creating data or listener', async () => {
  const f = prepare(), host = await createHost({ root: join(f.root, 'host') }); try { const entry = host.ctx.plugin(plugin, { configFile: f.configFile }); await entry.await(); assert.equal(entry.ctx.get('collaborationServerStatus').state, 'configuration-required'); assert.equal(entry.ctx.get('collaborationServer'), undefined); assert.equal(existsSync(join(f.root, 'state')), false); } finally { await host.close(); }
});
