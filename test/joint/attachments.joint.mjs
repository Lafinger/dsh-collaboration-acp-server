import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime, LlmAdapter, ToolCallId, createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm';
import { createTestCollaboration } from '../helpers/host.mjs';
import { AccountAuthority } from '../../src/authority.mjs';
import { AccessStore } from '../../src/store.mjs';
import { AccessService } from '../../src/service.mjs';
import { listenAccess } from '../../src/transport.mjs';
import { bridgeConnector } from '../../src/connector.mjs';
import { JsonPeer } from '../../src/protocol.mjs';
const clientRoot = process.env.DSH_COLLABORATION_CLIENT_ROOT;
if (!clientRoot) throw new Error('Joint test requires explicit DSH_COLLABORATION_CLIENT_ROOT');
const plugin = await import(pathToFileURL(resolve(clientRoot, 'src/member-plugin.mjs')).href);
function* tool(name, args) {
  const id = ToolCallId(randomUUID()), block = { type: 'tool-call', id, name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
class ArchiveModel extends LlmAdapter {
  calls = 0;
  async *stream(options) {
    if (++this.calls > 20) throw new Error('Bounded fixture calls');
    const result = options.messages.at(-1);
    if (result.role !== 'tool') {
      const message = [...options.messages].reverse().find(m => m.role === 'user' && m.source.kind === 'user');
      const handle = /"handle":"([a-f0-9]{64})"/.exec(message.content[0].text)[1];
      yield* tool('attachment_transfer', { handle }); return;
    }
    const value = JSON.parse(result.content.filter(b => b.type === 'text').map(b => b.text).join(''));
    assert.equal(value.ok, true);
    const call = options.messages.flatMap(m => m.content).find(b => b.type === 'tool-call' && b.id === result.toolCallId);
    if (call.name === 'attachment_transfer') { yield* tool('attachment_inspect', { receipt_id: value.receipt_id }); return; }
    if (call.name === 'attachment_inspect') { assert.ok(value.parsed.content.startsWith('Sample requirement')); yield* tool('attachment_archive', { receipt_id: value.receipt_id, purpose: '联合测试需求', role: 'product', reason: 'Inspected non-sensitive sample requirement body' }); return; }
    const text = JSON.stringify(value);
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
test('independent mounted client native/path attachment goes through actual reverse connector and scoped server tools; chunks, fixed versions, no replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-attachment-joint-')), bytes = Buffer.from('Sample requirement\n' + 'bounded text\n'.repeat(8500));
  const filename = join(root, 'sample.md'); writeFileSync(filename, bytes);
  const ref = { attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), name: 'sample.md', bytes: bytes.length };
  const remote = await createTestCollaboration({ workspace: join(root, 'remote-workspace'), stateRoot: join(root, 'remote-state'), adapter: new ArchiveModel() });
  const project = remote.services.projects.create({ key: 'JOINT-ATTACHMENT', name: 'Non-sensitive sample' });
  const store = new AccessStore(join(root, 'access.sqlite')), secret = 'a'.repeat(64);
  const service = new AccessService({ runtime: remote.runtime, store, cwd: remote.workspace, authority: new AccountAuthority({ serviceId: 'joint-attachment', accounts: { alice: secret } }) });
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\collab-joint-attach-${randomUUID()}` : join(root, 'service.sock');
  const listener = await listenAccess(service, { socketPath }), bridges = [];
  const ctx = new Context(), llm = ctx.plugin(LlmRuntime); await llm.await();
  ctx.provide('attachments', { fileHostPath: () => undefined, async *readFileStream() { yield bytes; } });
  const fiber = ctx.plugin(plugin, { databasePath: join(root, 'client.sqlite'), serviceId: 'joint-attachment', ssh: { host: 'example.test', account: 'alice', identityFile: join(root, 'fake-key'), knownHostsFile: join(root, 'fake-known-hosts') } });
  await fiber.await(); const client = fiber.ctx.get('collaborationMemberClient'); client.attachments.workspaceOf = () => root;
  let reads = 0;
  client.connect = async () => {
    const input = new PassThrough(), output = new PassThrough();
    const bridge = await bridgeConnector({ socketPath, account: 'alice', serviceId: 'joint-attachment', secret }, input, output); bridges.push(bridge);
    const peer = new JsonPeer(output, input); peer.on('message', m => { if (m.method === 'collaboration/attachment/read') reads++; }); return peer;
  };
  const messages = [];
  async function send(message) {
    messages.push(message); const result = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({ provider: 'collaboration-remote', model: 'server-agent', sessionId: 'local-file', messages })) result.push(chunk);
    return result;
  }
  try {
    const text = '附件操作: 上传并归档\nproject_id: ' + project.id;
    const native = createUserMessage({ content: [{ type: 'text', text }, { type: 'file', attachment: ref }], source: { kind: 'user' } });
    const first = await send(native); assert.equal(first.finish.kind, 'stop'); assert.ok(reads >= 3); const archived = JSON.parse(first.blocks()[0].text); assert.equal(archived.version, 1);
    const beforeReplay = reads, duplicate = await send(native); assert.equal(duplicate.finish.kind, 'error'); assert.equal(reads, beforeReplay);
    const path = createUserMessage({ content: [{ type: 'text', text: text + '\n@sample.md' }], source: { kind: 'user' } });
    const second = await send(path); assert.equal(second.finish.kind, 'stop'); assert.equal(JSON.parse(second.blocks()[0].text).version, 2);
    const material = remote.services.materials.listByProject(project.id)[0]; assert.equal(material.versions.length, 2); assert.ok(material.versions.every(v => v.sha256 === ref.attachmentId.slice(7)));
    const sessionId = client.mapping('local-file').remote_id, beforeRestore = reads;
    await client.peer.request('session/close', { sessionId }); client.disconnect(); await client.open('local-file');
    assert.equal(client.mapping('local-file').remote_id, sessionId); assert.equal(reads, beforeRestore); assert.equal(remote.attachments.list(sessionId, 'alice').receipts.length, 2);
    assert.equal(remote.attachments.list(sessionId, 'bob').receipts.length, 0);
  } finally { await ctx.fiber.dispose(); for (const bridge of bridges) bridge.close(); await listener.close(); store.close(); }
});
