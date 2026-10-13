import { initializeParams, collaborationMeta } from '../src/protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestCollaboration as createCollaborationRuntime } from './helpers/host.mjs';
import { AccessStore } from '../src/store.mjs';
import { AccountAuthority } from '../src/authority.mjs';
import { AccessService } from '../src/service.mjs';
import { listenAccess } from '../src/transport.mjs';
import { bridgeConnector } from '../src/connector.mjs';
import { JsonPeer } from '../src/protocol.mjs';
import { PassThrough } from 'node:stream';

test('server composition + deployment-local socket + stdio connector uses actual DSH runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collaboration-socket-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\collaboration-prototype-${randomUUID()}` : join(root, 'service.sock');
  const { runtime, workspace } = await createCollaborationRuntime({ workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), fixture: true });
  const store = new AccessStore(join(root, 'access.sqlite'));
  const secret = 'a'.repeat(64), authority = new AccountAuthority({ serviceId: 'socket-fixture', accounts: { alice: secret } });
  const service = new AccessService({ runtime, authority, store, cwd: workspace });
  const listener = await listenAccess(service, { socketPath });
  const input = new PassThrough(), output = new PassThrough();
  const bridge = await bridgeConnector({ socketPath, account: 'alice', serviceId: 'socket-fixture', secret }, input, output);
  const peer = new JsonPeer(output, input);
  try {
    await peer.request('initialize', initializeParams()); const { sessionId } = await peer.request('session/new', {});
    const updates = []; peer.on('message', m => { if (m.method === 'session/update') updates.push(m.params.update); });
    const response = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'whoami' }], _meta: { requestId: 'socket-whoami' } });
    assert.equal(response.stopReason, 'end_turn');
    const text = updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text).join('');
    assert.equal(JSON.parse(text).account, 'alice');
    assert.equal((await peer.request('collaboration/whoami', {})).runtimePid, process.pid);
  } finally { peer.close(); bridge.close(); await listener.close(); store.close(); }
});
