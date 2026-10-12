import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonPeer } from '../src/protocol.mjs';
import { AccountAuthority, issueTicket } from '../src/authority.mjs';
import { AccessStore } from '../src/store.mjs';
import { AccessService } from '../src/service.mjs';
import { listenAccess, connectAccess } from '../src/transport.mjs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const secret = 'a'.repeat(64);
async function fixture(t, runtime) {
  const store = new AccessStore(':memory:'); const authority = new AccountAuthority({ serviceId: 'f', accounts: { alice: secret } });
  const service = new AccessService({ runtime, authority, store, cwd: tmpdir() }); const listener = await listenAccess(service);
  const p = await connectAccess(listener.address); await p.request('workbench/connect', { ticket: issueTicket({ serviceId: 'f', account: 'alice', secret }) }); await p.request('initialize', {});
  t.after(async () => { p.close(); await listener.close(); store.close(); }); return { service, store, listener, p };
}
test('malformed/oversized protocol closes and rejects pending calls instead of dropping frames', async () => {
  const input = new PassThrough(), output = new PassThrough(); const peer = new JsonPeer(input, output, { maxFrame: 32 });
  const call = peer.request('method', {}); input.write('not-json\n'); await assert.rejects(call); assert.equal(peer.closed, true);
  const input2 = new PassThrough(), output2 = new PassThrough(); const peer2 = new JsonPeer(input2, output2, { maxFrame: 32 }); input2.write('x'.repeat(33)); assert.equal(peer2.closed, true);
});
test('restart marks unfinished submissions interrupted and still refuses replay', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'store-restart-')), 'access.sqlite');
  const a = new AccessStore(path); a.create('s', 'alice'); a.begin('s', 'r'); a.append('s', { saved: true }); a.close();
  const b = new AccessStore(path); assert.equal(b.status('s').state, 'interrupted'); assert.throws(() => b.begin('s', 'r'), /replay/); assert.equal(b.events('s').length, 1); b.close();
});
test('disconnect during delayed session open does not publish or leak live handle', async t => {
  let activate, began; const beganPromise = new Promise(resolve => { began = resolve; }); const gate = new Promise(resolve => { activate = resolve; }); const closed = [];
  const f = await fixture(t, { async open(p) { began(); await gate; return p; }, async close(h) { closed.push(h.id); } });
  const pending = f.p.request('session/new', {}).catch(error => error); await beganPromise;
  const id = [...f.service.sessions.keys()][0]; const entry = f.service.sessions.get(id);
  f.p.close(); await pending; activate();
  // Await the activation/drain through explicit close completion.
  await new Promise(resolve => { const original = f.service.runtime.close; f.service.runtime.close = async h => { await original(h); resolve(); }; });
  await entry.drain;
  assert.deepEqual(closed, [id]); assert.equal(f.service.sessions.size, 0); assert.equal(entry.connection, null);
});
test('account can restore after runtime failure without automatic request execution', async t => {
  let opens = 0; const f = await fixture(t, { async open(p) { opens++; if (p.resume) throw new Error('missing persistent log'); return p; }, async close() {} });
  const { sessionId } = await f.p.request('session/new', {}); await f.p.request('session/close', { sessionId });
  await assert.rejects(f.p.request('session/load', { sessionId }), /no replacement/);
  assert.equal(opens, 2); assert.equal(f.service.sessions.size, 0); assert.equal(f.store.owner(sessionId), 'alice');
});
