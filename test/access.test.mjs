import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountAuthority, issueTicket } from '../src/authority.mjs';
import { AccessStore } from '../src/store.mjs';
import { AccessService } from '../src/service.mjs';
import { listenAccess, connectAccess } from '../src/transport.mjs';

const secrets = { alice: 'a'.repeat(64), bob: 'b'.repeat(64) };
const ticket = (account, now) => issueTicket({ account, serviceId: 'fixture-service', secret: secrets[account] }, now);
class Runtime {
  constructor() { this.opens = []; this.prompts = []; this.commits = []; this.closed = []; this.release = null; }
  async open(options) { this.opens.push(options); return options; }
  async prompt(handle, text, signal, emit) {
    this.prompts.push({ id: handle.id, text, owner: handle.owner });
    this.commits.push({ owner: handle.owner, text });
    emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${handle.owner}:${text}` } });
    if (text === 'hold') await new Promise(resolve => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); });
    return { stopReason: signal.aborted ? 'cancelled' : 'end_turn' };
  }
  async close(h) { this.closed.push(h.id); }
}
async function fixture(t, runtime = new Runtime()) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-access-'));
  const store = new AccessStore(join(root, 'access.sqlite'));
  const authority = new AccountAuthority({ serviceId: 'fixture-service', accounts: secrets });
  const service = new AccessService({ store, authority, runtime, cwd: root });
  const listener = await listenAccess(service); const peers = [];
  const connect = async account => {
    const peer = await connectAccess(listener.address); peers.push(peer);
    await peer.request('workbench/connect', { ticket: ticket(account) });
    await peer.request('initialize', { protocolVersion: 1 }); return peer;
  };
  t.after(async () => { peers.forEach(p => p.close()); await listener.close(); store.close(); });
  return { root, store, runtime, authority, service, listener, connect };
}
const prompt = (peer, id, text, requestId) => peer.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }], _meta: { requestId } });

 test('authority verifies account-specific signature, expiry, service and one-time nonce', () => {
  let now = 100000;
  const authority = new AccountAuthority({ serviceId: 'fixture-service', accounts: secrets, now: () => now });
  const good = ticket('alice', now); assert.equal(authority.verify(good).account, 'alice');
  assert.throws(() => authority.verify(good), /authentication/);
  assert.throws(() => authority.verify(issueTicket({ account: 'bob', serviceId: 'fixture-service', secret: secrets.alice }, now)), /authentication/);
  assert.throws(() => authority.verify(issueTicket({ account: 'alice', serviceId: 'other', secret: secrets.alice }, now)), /authentication/);
  const expired = ticket('alice', now); now += 30001; assert.throws(() => authority.verify(expired), /authentication/);
  assert.throws(() => new AccountAuthority({ serviceId: 's', accounts: { a: secrets.alice, b: secrets.alice } }), /distinct/);
 });
 test('all methods reject before connector authentication and initialize', async t => {
  const f = await fixture(t); const peer = await connectAccess(f.listener.address); t.after(() => peer.close());
  await assert.rejects(peer.request('session/new', { account: 'alice' }), /connector required/);
  await peer.request('workbench/connect', { ticket: ticket('alice') });
  await assert.rejects(peer.request('session/new', {}), /Initialize first/);
  await assert.rejects(peer.request('workbench/connect', { ticket: ticket('bob') }), /already bound/);
 });
 test('two authenticated members share one service PID but not identity/history or local cwd', async t => {
  const f = await fixture(t); const a = await f.connect('alice'), b = await f.connect('bob');
  const [ai, bi] = await Promise.all([a.request('workbench/whoami', {}), b.request('workbench/whoami', {})]);
  assert.equal(ai.runtimePid, bi.runtimePid); assert.equal(ai.account, 'alice'); assert.equal(bi.account, 'bob');
  const [as, bs] = await Promise.all([a.request('session/new', { cwd: 'C:\\member\\desktop', mcpServers: [{ evil: true }] }), b.request('session/new', { cwd: '/tmp/other' })]);
  assert.notEqual(as.sessionId, bs.sessionId); assert.equal(as.cwd, f.root); assert.equal(bs.cwd, f.root);
  await Promise.all([prompt(a, as.sessionId, 'I am bob', 'a1'), prompt(b, bs.sessionId, 'hello', 'b1')]);
  assert.deepEqual(f.runtime.prompts.map(p => p.owner).sort(), ['alice', 'bob']);
  const list = await b.request('session/list', {}); assert.deepEqual(list.sessions.map(s => s.sessionId), [bs.sessionId]);
  const history = await b.request('workbench/history', { sessionId: bs.sessionId });
  assert.ok(history.events.some(e => e.update.content.text === 'bob:hello')); assert.ok(!JSON.stringify(history).includes('I am bob'));
 });
 test('knowing another member sessionId cannot read, restore, prompt, cancel or close it', async t => {
  const f = await fixture(t); const a = await f.connect('alice'), b = await f.connect('bob');
  const { sessionId } = await a.request('session/new', {});
  for (const method of ['workbench/history', 'session/load', 'session/resume', 'session/prompt', 'session/cancel', 'session/close']) {
    await assert.rejects(b.request(method, { sessionId, prompt: [{ type: 'text', text: 'hi' }], _meta: { requestId: 'evil' } }), /not available/);
  }
  assert.equal(f.runtime.prompts.length, 0);
 });
 test('stable requestId refuses duplicate business execution', async t => {
  const f = await fixture(t); const a = await f.connect('alice'); const { sessionId } = await a.request('session/new', {});
  await prompt(a, sessionId, 'save progress', 'one');
  await assert.rejects(prompt(a, sessionId, 'save progress', 'one'), /replay is forbidden/);
  assert.equal(f.runtime.commits.length, 1);
 });
 test('disconnect cancels only its turn and preserves committed data and other member turn', async t => {
  const f = await fixture(t); const a = await f.connect('alice'), b = await f.connect('bob');
  const as = await a.request('session/new', {}), bs = await b.request('session/new', {});
  const received = once(a, 'message');
  const pending = prompt(a, as.sessionId, 'hold', 'held').catch(error => error); await received;
  const drain = [...f.service.sessions.values()].find(e => e.id === as.sessionId);
  a.close(); await pending;
  // Server-side close is observed using runtime completion, not wall-clock sleep.
  await new Promise(resolve => {
    if (drain.drain) drain.drain.then(resolve); else {
      const original = f.runtime.close.bind(f.runtime);
      f.runtime.close = async handle => { await original(handle); if (handle.id === as.sessionId) resolve(); };
    }
  });
  await prompt(b, bs.sessionId, 'still works', 'next');
  assert.equal(f.store.status(as.sessionId).state, 'cancelled');
  assert.deepEqual(f.runtime.commits.map(c => c.text), ['hold', 'still works']);
  const anew = await f.connect('alice'); await anew.request('session/load', { sessionId: as.sessionId });
  assert.equal(f.runtime.opens.at(-1).id, as.sessionId); assert.equal(f.runtime.opens.at(-1).resume, true);
  assert.equal(f.runtime.prompts.length, 2);
 });
 test('same account cannot concurrently attach same conversation from two clients', async t => {
  const f = await fixture(t); const a = await f.connect('alice'), a2 = await f.connect('alice');
  const { sessionId } = await a.request('session/new', {});
  await assert.rejects(a2.request('session/load', { sessionId }), /already attached/);
 });
