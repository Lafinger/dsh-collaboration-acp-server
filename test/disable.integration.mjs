import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createHost } from './helpers/host.mjs';
import * as plugin from '../src/server-plugin.mjs';
import { connectAccess } from '../src/transport.mjs';
import { issueTicket } from '../src/authority.mjs';
class Waiting extends LlmAdapter {
  started = Promise.withResolvers();
  async *stream(options) {
    this.started.resolve();
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'prefix' };
    await new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }); if (options.signal.aborted) resolve(); });
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'prefix' } };
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'FIXTURE_CANCEL', message: 'cancelled' } } };
  }
}
test('unloading during live turn cancels own Agent, preserves request status and host factory, no automatic replay', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-disable-')), adapter = new Waiting(), host = await createHost({ root: join(root, 'host'), adapter });
  const dir = join(root, 'socket'); mkdirSync(dir, { mode: 0o700 });
  const config = { serviceId: 'disable', workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\disable-${randomUUID()}` : join(dir, 'service.sock'), accounts: { alice: 'a'.repeat(64) }, provider: 'fixture', model: 'fixture' };
  const configFile = join(root, 'config.json'); writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  let entry, peer;
  try {
    entry = host.ctx.plugin(plugin, { configFile }); await entry.await(); const server = entry.ctx.get('workbenchServer');
    peer = await connectAccess(config.socketPath); await peer.request('workbench/connect', { ticket: issueTicket({ account: 'alice', serviceId: config.serviceId, secret: config.accounts.alice }) }); await peer.request('initialize', {});
    const { sessionId } = await peer.request('session/new', {});
    const task = peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hold' }], _meta: { requestId: 'hold' } }).catch(e => e);
    await adapter.started.promise;
    await entry.dispose(); await task; assert.equal(server.service.runtime.handles.size, 0); assert.equal(host.ctx.agents.get(sessionId), undefined); host.ctx.agents.requireFactory();
    entry = host.ctx.plugin(plugin, { configFile }); await entry.await(); const store = entry.ctx.get('workbenchServer').service.store;
    assert.ok(['cancelled', 'interrupted'].includes(store.status(sessionId).state));
    assert.throws(() => store.begin(sessionId, 'hold'), /already submitted/);
  } finally { peer?.close(); await entry?.dispose(); await host.close(); }
});
