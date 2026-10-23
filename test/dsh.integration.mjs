import { initializeParams, collaborationMeta } from '../src/protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter, ToolCallId, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { createTestRuntime } from './helpers/host.mjs';
import { AccountAuthority, issueTicket } from '../src/authority.mjs';
import { AccessStore } from '../src/store.mjs';
import { AccessService } from '../src/service.mjs';
import { listenAccess, connectAccess } from '../src/transport.mjs';
import { bindCollaborationIdentity } from '../src/collaboration-binding.mjs';
import { openDatabase } from '../business/lib/sqlite/connection.js';
import { SessionIdentityService } from '../business/lib/service/session-identity-service.js';
import { ProjectService } from '../business/lib/service/project-service.js';
import { PlanService } from '../business/lib/service/plan-service.js';
import { TaskService } from '../business/lib/service/task-service.js';
import { registerTools } from '../business/lib/tool/register.js';

const secret = 'a'.repeat(64), bobSecret = 'b'.repeat(64);
function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
}
function* toolChunks(name, args) {
  const block = { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
class FixtureModel extends LlmAdapter {
  calls = []; holds = new Map(); confirmations = null;
  async *stream(options) {
    this.calls.push(options);
    const last = options.messages.at(-1);
    const results = last?.role === 'tool' ? [last] : last?.content.filter(b => b.type === 'tool-result') ?? [];
    if (this.calls.length > 30) throw new Error('Fixture exceeded bounded model calls');
    if (results.length) {
      const raw = results[0].content.filter(b => b.type === 'text').map(b => b.text).join('');
      yield* textChunks(raw); return;
    }
    const user = [...options.messages].reverse().find(m => m.role === 'user' && m.source?.kind === 'user');
    const text = user?.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
    if (text === 'whoami') { yield* toolChunks('session_whoami', {}); return; }
    if (text.startsWith('declare ')) { yield* toolChunks('session_declare_member', { member: text.slice(8) }); return; }
    if (text === 'confirm') { yield* toolChunks('plan_confirm', { ...this.confirmations, outcome: 'agree', submitted_by: 'forged-other-person' }); return; }
    if (text === 'hold') {
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'started' };
      await new Promise(resolve => { this.holds.set(String(options.sessionId), resolve); options.signal.addEventListener('abort', resolve, { once: true }); if (options.signal.aborted) resolve(); });
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'started' } }; yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'fixture', message: 'cancelled' } } }; return;
    }
    yield* textChunks(`reply:${text}`);
  }
}
async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'collaboration-dsh-integration-'));
  const db = openDatabase({ path: join(root, 'business.sqlite') });
  const identities = new SessionIdentityService(db); const model = new FixtureModel();
  const tasks = new TaskService(db), projects = new ProjectService(db), plans = new PlanService(db, undefined, tasks);
  const runtime = await createTestRuntime({ provider: 'fixture', model: 'fixture', adapter: model, persistenceRoot: join(root, 'sessions'),
    setup: (ctx, agent, account) => registerTools(ctx, { identities, tasks, projects, plans }, bindCollaborationIdentity(ctx, identities, { sessionId: agent.session.id, account })),
  });
  const store = new AccessStore(join(root, 'access.sqlite'));
  const authority = new AccountAuthority({ serviceId: 'integration', accounts: { alice: secret, bob: bobSecret } });
  const service = new AccessService({ authority, store, runtime, cwd: root }); const listener = await listenAccess(service);
  const peers = [];
  const connect = async account => {
    const p = await connectAccess(listener.address); peers.push(p);
    await p.request('collaboration/connect', { _meta: collaborationMeta(),  ticket: issueTicket({ account, serviceId: 'integration', secret: account === 'alice' ? secret : bobSecret }) }); return p;
  };
  t.after(async () => { peers.forEach(p => p.close()); await listener.close(); store.close(); db.close(); });
  return { root, model, runtime, db, identities, store, service, listener, connect, projects, plans };
}
async function send(peer, sessionId, text, requestId = randomUUID()) {
  const updates = []; const onMessage = m => { if (m.params?.sessionId === sessionId) updates.push(m.params.update); };
  peer.on('message', onMessage);
  try {
    const result = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }], _meta: { requestId } });
    return { result, text: updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text).join('') };
  } finally { peer.off('message', onMessage); }
}
test('actual official DSH loop: isolated accounts, scoped identity override, persisted same-session restore', async t => {
  const f = await setup(t); const a = await f.connect('alice'), b = await f.connect('bob');
  await a.request('initialize', initializeParams()); await b.request('initialize', initializeParams());
  const as = await a.request('session/new', { cwd: '/not/server' }), bs = await b.request('session/new', {});
  const [ar, br] = await Promise.all([send(a, as.sessionId, 'whoami'), send(b, bs.sessionId, 'whoami')]);
  assert.equal(JSON.parse(ar.text).account, 'alice'); assert.equal(JSON.parse(br.text).account, 'bob');
  assert.equal(f.identities.current(as.sessionId), 'alice'); assert.equal(f.identities.current(bs.sessionId), 'bob');
  const forged = await send(a, as.sessionId, 'declare bob'); assert.match(forged.text,/当前人类消息未授权/u);
  assert.equal(f.identities.current(as.sessionId), 'alice');
  await a.request('session/close', { sessionId: as.sessionId });
  const a2 = await f.connect('alice'); await a2.request('initialize', initializeParams());
  await a2.request('session/load', { sessionId: as.sessionId });
  const restored = await send(a2, as.sessionId, 'followup'); assert.equal(restored.text, 'reply:followup');
  const call = f.model.calls.at(-1); assert.equal(String(call.sessionId), as.sessionId);
  assert.ok(call.messages.some(m => m.content.some(c => c.type === 'text' && c.text === 'whoami')));
  assert.ok(!call.messages.some(m => m.content.some(c => c.type === 'text' && c.text.includes('"account":"bob"'))));
});
test('authenticated standalone model cannot turn a vague confirm into a formal own-role decision', async t => {
  const f = await setup(t);
  const project = f.projects.create({ key: 'ISOLATED', name: 'fixture' });
  f.projects.setMember(project.id, 'pm', 'alice');
  const plan = f.plans.register({ projectId: project.id, title: 'fixture plan', rolesReason: 'pm owns this fixture', relevantRoles: ['pm'], tasks: [], undecided: [] });
  f.model.confirmations = { plan_id: plan.plan.id, role: 'pm' };
  const a = await f.connect('alice'); await a.request('initialize', initializeParams()); const as = await a.request('session/new', {});
  const response = await send(a, as.sessionId, 'confirm'); assert.match(response.text,/当前人类消息未授权/u);
  const records = f.db.prepare('SELECT submitted_by FROM confirmations').all();
  assert.equal(records.length,1,'The original undecided role slot remains');assert.ok(records.every(r=>r.submitted_by===null));assert.ok(f.plans.get(plan.plan.id).slots.every(slot=>slot.outcome===null));assert.ok(!f.model.calls.at(-1).tools.some(t=>t.name==='plan_confirm'));
});
