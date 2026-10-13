import { initializeParams, collaborationMeta } from '../src/protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bridgeConnector, readConnectorConfig } from '../src/connector.mjs';
import { JsonPeer } from '../src/protocol.mjs';
import { AccessService } from '../src/service.mjs';
import { AccountAuthority } from '../src/authority.mjs';
import { AccessStore } from '../src/store.mjs';
import { listenAccess } from '../src/transport.mjs';

const secret = 'a'.repeat(64);
test('stdio connector fixes trusted account and forbids client identity renegotiation', async t => {
  const store = new AccessStore(':memory:');
  const runtime = { open: async p => p, prompt: async () => ({ stopReason: 'end_turn' }), close: async () => {} };
  const service = new AccessService({ store, runtime, cwd: tmpdir(), authority: new AccountAuthority({ serviceId: 'connector', accounts: { alice: secret } }) });
  const listener = await listenAccess(service);
  const input = new PassThrough(), output = new PassThrough();
  const bridge = await bridgeConnector({ account: 'alice', serviceId: 'connector', secret, endpoint: listener.address }, input, output);
  const member = new JsonPeer(output, input);
  t.after(async () => { member.close(); bridge.close(); await listener.close(); store.close(); });
  await member.request('initialize', initializeParams());
  assert.equal((await member.request('collaboration/whoami', {})).account, 'alice');
  await assert.rejects(member.request('collaboration/connect', { ticket: { account: 'bob' } }), /cannot choose/);
  await assert.rejects(member.request('fs/read_text_file', { path: 'private' }), /Unsupported/);
  assert.equal(service.connections.size, 1);
});
test('production credential reader fails closed on Windows until ACL implementation exists', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'connector-config-')), 'account.json');
  writeFileSync(path, JSON.stringify({ account: 'alice', serviceId: 's', secret }));
  assert.throws(() => readConnectorConfig(path, { platform: 'win32', username: 'alice' }), /Linux-only/);
});
test('production credential reader checks logged-in OS account after file protection', () => {
  // Full POSIX uid/gid/mode acceptance requires the separately gated real Linux SSH test.
  const path = join(mkdtempSync(join(tmpdir(), 'connector-config-')), 'account.json');
  writeFileSync(path, JSON.stringify({ account: 'bob' }));
  assert.throws(() => readConnectorConfig(path, { platform: 'linux', username: 'alice', gid: 1234 }), /root-owned/);
});
