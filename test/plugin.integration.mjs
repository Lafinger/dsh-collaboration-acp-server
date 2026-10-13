import { initializeParams, collaborationMeta } from '../src/protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Context, symbols } from '@deepseek-ai/cordis';
import { createUserMessage, ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import * as plugin from '../src/server-plugin.mjs';
import { createHost } from './helpers/host.mjs';
import { connectAccess } from '../src/transport.mjs';
import { issueTicket } from '../src/authority.mjs';
const canonical = v => v[symbols.original] ?? v;
function configuration(root) {
  const socketDir = join(root, 'socket'); mkdirSync(socketDir, { mode: 0o700 });
  const config = { serviceId: 'plugin', workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), socketPath: process.platform === 'win32' ? `\\\\.\\pipe\\plugin-${randomUUID()}` : join(socketDir, 'service.sock'), provider: 'fixture', model: 'fixture', accounts: { alice: 'a'.repeat(64), bob: 'b'.repeat(64) } };
  const configFile = join(root, 'config.json'); writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 }); return { config, configFile };
}
async function connect(config, account) {
  const peer = await connectAccess(config.socketPath);
  await peer.request('collaboration/connect', { _meta: collaborationMeta(),  ticket: issueTicket({ serviceId: config.serviceId, account, secret: config.accounts[account] }) });
  await peer.request('initialize', initializeParams()); return peer;
}
async function send(peer, sessionId, text, requestId = randomUUID()) {
  const updates = [], listener = m => { if (m.params?.sessionId === sessionId) updates.push(m.params.update); }; peer.on('message', listener);
  try { const result = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }], _meta: { requestId } }); return { result, text: updates.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text).join('') }; }
  finally { peer.off('message', listener); }
}
test('actual plugin empty enable stays pending without any host/model/database/listener', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-empty-')), ctx = new Context();
  try { const entry = ctx.plugin(plugin, { configFile: join(root, 'missing.json') }); await entry.await(); assert.equal(entry.ctx.get('collaborationServerStatus').state, 'configuration-required'); assert.equal(entry.ctx.get('collaborationServer'), undefined); assert.equal(existsSync(join(root, 'state')), false); }
  finally { await ctx.fiber.dispose(); }
});
test('plugin borrows one host, isolates members/tools, unload leaves ordinary Agent alive, same-id reenable restores without replay', { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-host-')), { config, configFile } = configuration(root), host = await createHost({ root: join(root, 'host') });
  const hostServices = Object.fromEntries(['agents', 'llm', 'tools', 'sessions', 'sessionPersistence'].map(k => [k, canonical(host.ctx.get(k))]));
  let unsafeCalls = 0; host.ctx.tools.register(defineTool({ name: 'unsafe_host_terminal', description: 'Fixture forbidden host capability', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: () => { unsafeCalls++; return {}; } }));
  const ordinary = await host.ctx.agents.create({ sessionId: 'ordinary-' + randomUUID(), agentOptions: { provider: 'fixture', model: 'fixture' } });
  let entry, a, b, a2;
  try {
    entry = host.ctx.plugin(plugin, { configFile }); await entry.await(); assert.equal(entry.ctx.get('collaborationServerStatus').state, 'running');
    for (const [key, original] of Object.entries(hostServices)) assert.equal(canonical(entry.ctx.get(key)), original);
    const server = entry.ctx.get('collaborationServer');
    a = await connect(config, 'alice'); b = await connect(config, 'bob');
    const as = await a.request('session/new', {}), bs = await b.request('session/new', {});
    const [ar, br] = await Promise.all([send(a, as.sessionId, 'whoami'), send(b, bs.sessionId, 'whoami')]);
    assert.equal(JSON.parse(ar.text).account, 'alice'); assert.equal(JSON.parse(br.text).account, 'bob');
    await assert.rejects(b.request('session/load', { sessionId: as.sessionId }), /account/);
    const agent = host.ctx.agents.get(as.sessionId);
    assert.equal(agent.ctx.tools.get('unsafe_host_terminal', agent), undefined);
    assert.ok(agent.ctx.tools.get('project_create', agent));
    assert.equal(host.ctx.tools.get('project_create', ordinary.agent), undefined);
    const blockedFile = await agent.ctx.tools.get('material_upload', agent).execute({ source_path: configFile, submitted_by: 'forged' }, {});
    assert.equal(blockedFile.code, 'SERVER_WORKSPACE_ONLY');
    agent.ctx.tools.register(defineTool({ name: 'late_host_capability', description: 'Fixture later scoped preset', parameters: {}, output: { schema: { type: 'json' }, render: () => [] }, execute: () => { unsafeCalls++; return {}; } }));
    assert.ok(agent.ctx.tools.guardReason({ name: 'late_host_capability', agent }));
    const assembly = await agent.ctx.get('systemPrompt').assemble({ agent, scope: agent, signal: new AbortController().signal });
    assert.ok(!assembly.tools.some(t => t.name === 'late_host_capability'));
    const denial = await agent.ctx.tools.execute({ callId: ToolCallId(randomUUID()), name: 'unsafe_host_terminal', arguments: {}, agent, signal: new AbortController().signal });
    assert.equal(denial.isError, true); assert.equal(unsafeCalls, 0);
    const duplicate = host.ctx.plugin({ name: 'duplicate-collaboration-fixture', inject: plugin.inject, apply: plugin.apply }, { configFile });
    await assert.rejects(duplicate.await(), /one collaboration service/); await duplicate.dispose();
    const originalEvents = server.service.store.events(as.sessionId).length;
    await entry.dispose(); assert.equal(server.service.runtime.handles.size, 0);
    assert.equal(host.ctx.agents.get(ordinary.agent.id), ordinary.agent);
    for (const [key, original] of Object.entries(hostServices)) assert.equal(canonical(host.ctx.get(key)), original);
    ordinary.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary alive' }] })); await ordinary.agent.whenIdle();
    assert.ok(ordinary.agent.session.deriveMessages().some(m => m.content.some(b => b.type === 'text' && b.text === 'fixture:ordinary alive')));
    entry = host.ctx.plugin(plugin, { configFile }); await entry.await(); assert.equal(entry.ctx.get('collaborationServerStatus').state, 'running');
    a2 = await connect(config, 'alice'); await a2.request('session/load', { sessionId: as.sessionId });
    assert.equal(entry.ctx.get('collaborationServer').service.store.events(as.sessionId).length, originalEvents);
    const next = await send(a2, as.sessionId, 'followup'); assert.equal(next.text, 'fixture:followup');
    await send(a2, as.sessionId, 'once', 'stable-request');
    await assert.rejects(send(a2, as.sessionId, 'again', 'stable-request'), /already submitted/);
  } finally { a?.close(); b?.close(); a2?.close(); await entry?.dispose(); await ordinary.dispose(); await host.close(); }
});
