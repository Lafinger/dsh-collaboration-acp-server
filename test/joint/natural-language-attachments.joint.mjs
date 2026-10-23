import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import { createTestCollaboration } from '../helpers/host.mjs';
import { syntheticDingTalkConfig, provisionSynthetic } from '../helpers/security.mjs';
import { AccountAuthority } from '../../src/authority.mjs';
import { AccessStore } from '../../src/store.mjs';
import { AccessService } from '../../src/service.mjs';
import { listenAccess } from '../../src/transport.mjs';
import { bridgeConnector } from '../../src/connector.mjs';
import { JsonPeer } from '../../src/protocol.mjs';

const clientRoot = process.env.DSH_COLLABORATION_CLIENT_ROOT;
if (!clientRoot) throw new Error('Explicit DSH_COLLABORATION_CLIENT_ROOT required; no production or implicit client discovery');
const loadClient = name => import(pathToFileURL(resolve(clientRoot, 'src', name)).href);
const { MemberClient } = await loadClient('member-client.mjs');
const { AttachmentAuthorization } = await loadClient('attachments.mjs');
const { makeHumanAuthorization } = await loadClient('human-authorization.mjs');
const { interpretAttachmentRequest } = await loadClient('human-intent.mjs');
const sha = value => createHash('sha256').update(value).digest('hex');
const RAW_ARCHIVE = '这是南航智慧出行数字人POC的需求文档你需要归档该文档并推进项目。';
const BIG_CONTENT = Buffer.from('Synthetic requirement\n' + 'non-sensitive bounded requirement text\n'.repeat(3000));

function* tool(name, args) {
  const id = ToolCallId(randomUUID()), block = { type: 'tool-call', id, name, arguments: JSON.stringify(args) };
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: block.arguments };
  yield { type: 'block-end', index: 0, block };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: value };
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
class JointArchiveModel extends LlmAdapter {
  calls = 0; turns = 0; inspected = []; archiveResults = []; selectedReceipt = null; mode = 'archive'; malicious = null; interruptAfterArchive = false;
  async *stream(options) {
    assert.ok(++this.calls < 150, 'Fake provider is bounded; no fallback model');
    const last = options.messages.at(-1);
    if (last.role !== 'tool') {
      const currentHuman = [...options.messages].reverse().find(message => message.role === 'user' && message.source?.kind === 'user');
      assert.ok(currentHuman, 'Real Agent must retain the current human message');
      const actualText = currentHuman.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert.equal(actualText, this.expectedCurrentText, 'Raw current human text must reach the actual model adapter unchanged; no server attachment notice or fake command may be appended');
      this.turns++; yield* tool('attachment_receipts', {}); return;
    }
    const raw = last.content.filter(b => b.type === 'text').map(b => b.text).join('');
    let value; try { value = JSON.parse(raw); } catch { throw new Error('Expected real structured tool result, not substituted fixture response: ' + raw.slice(0, 300)); }
    const call = options.messages.flatMap(m => m.content).find(b => b.type === 'tool-call' && b.id === last.toolCallId);
    assert.ok(call, 'Real Agent tool invocation must be present');
    if (call.name === 'attachment_receipts') {
      if (this.mode === 'receipt') {
        assert.ok(value.receipts.some(r => (r.receipt_id ?? r.receiptId) === this.selectedReceipt), 'Selected receipt came from real scoped read');
        yield* tool('attachment_archive', this.archiveArgs(this.selectedReceipt)); return;
      }
      assert.ok(Array.isArray(value.authorized_attachments) && value.authorized_attachments.length === 1, 'Server must expose only current authorized handle through read-only tool, without mutating human prompt');
      yield* tool('attachment_transfer', { handle: value.authorized_attachments[0].handle }); return;
    }
    if (call.name === 'attachment_transfer') { assert.equal(value.ok, true); this.selectedReceipt = value.receipt_id; yield* tool('attachment_inspect', { receipt_id: value.receipt_id }); return; }
    if (call.name === 'attachment_inspect') {
      assert.equal(value.ok, true); assert.ok(value.parsed.content.startsWith('Synthetic requirement'));
      this.inspected.push(value.parsed.content);
      if (this.mode === 'read') { yield* text('已阅读合成需求，仅供本次分析，尚未归档或提交方案。'); return; }
      yield* tool('attachment_archive', this.archiveArgs(value.receipt_id)); return;
    }
    if (call.name === 'attachment_archive') {
      this.archiveResults.push(value);
      if (value.ok && this.interruptAfterArchive) throw new Error('Synthetic model stream interruption after committed archive');
      yield* text(value.ok ? '合成需求已归档；以下为对话整理，尚未正式提交方案。' : '本次归档未完成，需先核对明确授权。'); return;
    }
    throw new Error('Unexpected fixture tool: ' + call.name);
  }
  archiveArgs(id) { return { receipt_id: id, purpose: '联合自然语言需求', role: 'product', reason: 'Inspected synthetic requirement body', ...(this.malicious ?? {}) }; }
}
function formalSnapshot(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const names = rows.map(r => r.name).filter(name => /^(?:analys|plan|task|result)/u.test(name));
  assert.ok(names.length >= 3, 'Actual formal business tables must exist');
  return Object.fromEntries(names.map(name => [name, Number(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n)]));
}
async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'natural-language-joint-'));
  const adapter = new JointArchiveModel(), dingtalk = await syntheticDingTalkConfig();
  const config = { serviceId: 'natural-language-joint', workspace: join(root, 'fake-workspace'), stateRoot: join(root, 'fake-state'), accounts: { alice: 'a'.repeat(64) }, dingtalk, adapter };
  let remote, store, listener, client; const bridges = [];
  const wire = { methods: [], prompts: [], reverseReads: [], dropNextPromptResult: false, dropped: 0 };
  const files = new Map(); let hostReads = 0;
  const attachments = new AttachmentAuthorization({ attachmentStore: { fileHostPath: () => undefined, async *readFileStream(ref) { hostReads++; const bytes = files.get(ref.attachmentId); assert.ok(bytes); yield bytes; } }, workspaceOf: () => root });
  const close = async () => { client?.close(); for (const b of bridges) b.close(); await listener?.close(); store?.close(); await remote?.runtime.closeAll(); };
  try {
    remote = await createTestCollaboration(config);
    provisionSynthetic(config);
    const project = remote.services.projects.create({ key: 'NATURAL-SYNTHETIC', name: '南航智慧出行数字人POC' });
    remote.security.participate(project.id, 'alice', true);
    const other = remote.services.projects.create({ key: 'OTHER-SYNTHETIC', name: 'Other synthetic project' });
    remote.security.participate(other.id, 'alice', true);
    store = new AccessStore(join(root, 'fake-access.sqlite'));
    const service = new AccessService({ runtime: remote.runtime, store, cwd: remote.workspace, authority: new AccountAuthority({ serviceId: config.serviceId, accounts: config.accounts }), login: remote.login, identities: remote.security, projects: remote.services.projects });
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\natural-language-joint-${randomUUID()}` : join(root, 'fake-service.sock');
    listener = await listenAccess(service, { socketPath });
    const history = [], updates = [];
    client = new MemberClient({ databasePath: join(root, 'fake-client.sqlite'), serviceId: config.serviceId, account: 'alice', requireLogin: true, loginOrigin: dingtalk.publicOrigin, attachments, onHistory: value => history.push(value), connect: async () => {
      const input = new PassThrough(), serverOutput = new PassThrough(); let outgoingBuffer = '', incomingBuffer = '', dropId = null, peer, bridge;
      input.on('data', chunk => {
        outgoingBuffer += chunk.toString('utf8'); let end;
        while ((end = outgoingBuffer.indexOf('\n')) >= 0) {
          const line = outgoingBuffer.slice(0, end); outgoingBuffer = outgoingBuffer.slice(end + 1); if (!line) continue;
          const message = JSON.parse(line);
          if (message.method) wire.methods.push(message.method);
          if (message.method === 'session/prompt') {
            wire.prompts.push(message.params);
            if (wire.dropNextPromptResult) { dropId = message.id; wire.dropNextPromptResult = false; }
          }
        }
      });
      const receive = new Transform({ transform(chunk, _encoding, callback) {
        try {
          incomingBuffer += chunk.toString('utf8'); let end;
          while ((end = incomingBuffer.indexOf('\n')) >= 0) {
            const line = incomingBuffer.slice(0, end); incomingBuffer = incomingBuffer.slice(end + 1); if (!line) continue;
            const message = JSON.parse(line);
            if (dropId !== null && message.id === dropId && ('result' in message)) {
              wire.dropped++; dropId = null; queueMicrotask(() => { peer.close(); bridge.close(); }); continue;
            }
            this.push(line + '\n');
          }
          callback();
        } catch (error) { callback(error); }
      } });
      serverOutput.pipe(receive);
      bridge = await bridgeConnector({ socketPath, account: 'alice', serviceId: config.serviceId, secret: config.accounts.alice }, input, serverOutput); bridges.push(bridge);
      peer = new JsonPeer(receive, input);
      peer.on('message', m => { if (m.method === 'collaboration/attachment/read') wire.reverseReads.push({ ...m.params }); });
      return peer;
    } });
    // Genuine synthetic device-login protocol; no requireLogin=false bypass or token/device mismatch.
    const started = await client.beginLogin(), browser = remote.login.browserStart(started.requestId);
    remote.login.provider = { exchange: async () => ({ corpId: dingtalk.corpId, userId: 'alice', unionId: 'alice', internal: true }), verifyMember: async m => ({ corpId: dingtalk.corpId, userId: m.user_id, unionId: m.union_id, internal: true }) };
    await remote.login.callback({ state: new URL(browser.authorizationUrl).searchParams.get('state'), code: 'synthetic-joint-one-use-' + randomUUID(), cookie: browser.cookie });
    await client.completeLogin(); assert.equal(client.authStatus().authenticated, true); assert.equal(client.requireLogin, true);
    const localId = 'local-natural'; client.selectProject(localId, project.id); await client.open(localId);
    const db = remote.attachments.db, baseline = formalSnapshot(db);
    async function entry(textValue, { bytes = BIG_CONTENT, messageId = randomUUID(), receiptScopes = [], noFile = false, projectId = project.id } = {}) {
      const ref = { attachmentId: 'sha256:' + sha(bytes), name: 'requirements.md', bytes: bytes.length }; files.set(ref.attachmentId, bytes);
      const message = createUserMessage({ content: [{ type: 'text', text: textValue }, ...(!noFile ? [{ type: 'file', attachment: ref }] : [])], source: { kind: 'user' } });
      // Keep the actual host message identity, not the proposed fixture label.
      const resolved = interpretAttachmentRequest({ text: textValue, projects: [project, other], currentProjectId: project.id });
      assert.notEqual(resolved.kind, 'clarify', resolved.message);
      const selected = await attachments.capture({ localId, message, workspace: root, admission: { ...resolved, projectId, receiptScopes } });
      adapter.expectedCurrentText = textValue;
      return { messageId: message.id, text: textValue, attachmentEntry: selected, onUpdate: update => updates.push(update) };
    }
    return { root, remote, db, store, service, client, attachments, project, other, adapter, wire, localId, baseline, history, updates, entry, close, get hostReads() { return hostReads; } };
  } catch (error) { await close(); throw error; }
}


async function expectPersistedOperation(h, kind, fields = {}, requestId = h.wire.prompts.at(-1)?._meta?.requestId) {
  const matches = update => update?._meta?.requestId === requestId && update?._meta?.operationResult?.kind === kind && Object.entries(fields).every(([key, value]) => update._meta.operationResult[key] === value);
  const live = h.updates.findLast(matches);
  assert.ok(live, `Real committed callback must publish current ${kind}, never inferred from model final text`);
  assert.equal(live.sessionUpdate, 'agent_message_chunk'); assert.equal(live.content?.type, 'text');
  assert.ok(typeof live.content.text === 'string' && live.content.text.trim());
  assert.doesNotMatch(live.content.text, /\b[a-f0-9]{32,64}\b|UNKNOWN|-32\d{3}|JSON|stored_at|source_path/u, 'Normal trusted receipt text must be human-readable, without bare IDs, raw codes or storage paths');
  assert.ok(!live.content.text.includes(h.root), 'Normal trusted receipt must not leak this portable synthetic storage root');
  const history = await h.client.legacyHistory(h.localId);
  const saved = history.events.findLast(event => matches(event.update));
  assert.ok(saved, 'Same trusted callback must be persisted in real AccessStore history');
  assert.ok(Number.isSafeInteger(saved.seq) && saved.seq > 0); assert.deepEqual(saved.update._meta, live._meta); assert.equal(saved.update.content.text, live.content.text);
  return { result: live._meta.operationResult, text: live.content.text, seq: saved.seq };
}

// No server/client implementation is stubbed: fake provider only proposes real Agent tools.
test('natural native capture -> v2 real RPC -> reverse chunks -> immutable dedup and changed version, with raw prompt preserved', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const first = await h.entry(RAW_ARCHIVE), result = await h.client.prompt(h.localId, first);
    assert.equal(result.stopReason, 'end_turn');
    assert.ok(h.wire.reverseReads.length >= 2); assert.ok(h.wire.reverseReads.every(r => r.maxBytes <= 48 * 1024));
    assert.equal(h.wire.prompts[0].prompt[0].text, RAW_ARCHIVE);
    assert.equal(h.wire.prompts[0]._meta.humanAuthorization.textSha256, sha(RAW_ARCHIVE));
    let material = h.remote.services.materials.listByProject(h.project.id)[0];
    assert.ok(material); assert.equal(material.latestVersion, 1); assert.equal(h.adapter.archiveResults.at(-1).version, 1);
    assert.equal(h.remote.services.materials.read({ materialId: material.id, version: 1 }).content, BIG_CONTENT.toString());
    const oldReceipt = h.adapter.selectedReceipt;
    const transferred = await expectPersistedOperation(h, 'attachment_transfer', { receipt_id: oldReceipt });
    assert.doesNotMatch(transferred.text, /已归档|已提交/u, 'Receiving bytes is not formal archive or submission');
    const archived = await expectPersistedOperation(h, 'material_archive', { receipt_id: oldReceipt, material_id: material.id, version: 1 });
    assert.match(archived.text, /第1版/u); assert.ok(archived.seq > transferred.seq);

    await h.client.prompt(h.localId, await h.entry('请归档这份文档。'));
    material = h.remote.services.materials.listByProject(h.project.id)[0];
    assert.equal(material.latestVersion, 1); assert.equal(h.adapter.archiveResults.at(-1).deduplicated, true);
    const reused = await expectPersistedOperation(h, 'material_archive', { version: 1, deduplicated: true });
    assert.match(reused.text, /内容未变|沿用|未新增|没有新增|复用|不增版/u);
    assert.notEqual(h.adapter.selectedReceipt, oldReceipt); assert.equal(h.remote.attachments.list(h.client.mapping(h.localId).remote_id, 'alice').receipts.length, 2);
    const changed = Buffer.from('Synthetic requirement\nChanged synthetic requirement content.\n');
    await h.client.prompt(h.localId, await h.entry('请归档这份文档。', { bytes: changed }));
    material = h.remote.services.materials.listByProject(h.project.id)[0]; assert.equal(material.latestVersion, 2);
    assert.match((await expectPersistedOperation(h, 'material_archive', { version: 2 })).text, /第2版/u);
    assert.equal(h.remote.services.materials.read({ materialId: material.id, version: 1 }).content, BIG_CONTENT.toString());
    assert.equal(h.remote.services.materials.read({ materialId: material.id, version: 2 }).content, changed.toString());
    assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});

test('read-only false receipt -> actual client receipt RPC -> new human archive grant without retransmission or historical authorization mutation', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    h.adapter.mode = 'read'; await h.client.prompt(h.localId, await h.entry('请看看这份文档，不要归档。'));
    assert.equal(h.remote.services.materials.listByProject(h.project.id).length, 0); assert.ok(h.adapter.inspected.length === 1);
    const readTransfer = await expectPersistedOperation(h, 'attachment_transfer');
    assert.doesNotMatch(readTransfer.text, /已归档|已提交/u);
    assert.ok(!h.updates.some(update => update?._meta?.operationResult?.kind === 'material_archive'));
    const receiptId = h.adapter.selectedReceipt, original = h.db.prepare('SELECT manifest FROM attachment_receipts WHERE receipt_id=?').get(receiptId).manifest;
    assert.equal(JSON.parse(original).archiveAuthorized, false);
    const receipts = await h.client.attachmentReceipts(h.localId);
    assert.equal(receipts.length, 1, 'Camel-case scoped client receipt RPC must match server DTO'); assert.equal(receipts[0].receiptId, receiptId);
    const before = { reverse: h.wire.reverseReads.length, local: h.hostReads, grants: Number(h.db.prepare('SELECT COUNT(*) AS n FROM attachment_human_grants').get().n) };
    h.adapter.mode = 'receipt'; h.adapter.selectedReceipt = receipts[0].receiptId;
    await h.client.prompt(h.localId, await h.entry('把刚才那份归档。', { noFile: true, receiptScopes: [{ receiptId, action: 'archive' }] }));
    assert.equal(h.wire.reverseReads.length, before.reverse); assert.equal(h.hostReads, before.local);
    assert.equal(h.db.prepare('SELECT manifest FROM attachment_receipts WHERE receipt_id=?').get(receiptId).manifest, original);
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM attachment_human_grants').get().n), before.grants + 1);
    assert.equal(h.remote.services.materials.listByProject(h.project.id)[0].latestVersion, 1);
    await expectPersistedOperation(h, 'material_archive', { receipt_id: receiptId, version: 1 });
    assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});

test('self-consistent forged archive scope on read-only human text is refused before reverse read or formal write', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const forged = await h.entry('请看看这份文档，不要归档。');
    forged.attachmentEntry.items[0].manifest.archiveAuthorized = true;
    forged.attachmentEntry.humanAuthorization = makeHumanAuthorization({ messageId: forged.messageId, text: forged.text, projectId: h.project.id, items: forged.attachmentEntry.items });
    const before = h.wire.reverseReads.length;
    let denied;
    await assert.rejects(() => h.client.prompt(h.localId, forged), error => { denied = error; return error.code === -32602 || error.code === -32013; });
    assert.equal(denied.outcome, 'not_started', 'Matching v2 admission proof must not be mislabeled as an uncertain sent result');
    assert.match(denied.message, /尚未开始执行/u);
    assert.doesNotMatch(denied.message, /\b[a-f0-9]{32,64}\b|UNKNOWN|-32\d{3}|JSON/u);
    assert.equal(h.client.db.prepare('SELECT state FROM client_submissions WHERE local_id=? AND message_id=?').get(h.localId, forged.messageId).state, 'not_started');
    assert.equal(h.wire.reverseReads.length, before); assert.equal(h.remote.services.materials.listByProject(h.project.id).length, 0);
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM attachment_human_grants').get().n), 0);
    assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});

test('cross-project/session self-consistent wire metadata cannot change the authenticated conversation target', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const selected = await h.entry('请归档这份文档。'); const row = h.client.mapping(h.localId), peer = await h.client.ensureConnected();
    const items = selected.attachmentEntry.items.map(item => ({ manifest: { ...item.manifest, projectId: h.other.id } }));
    const auth = makeHumanAuthorization({ messageId: selected.messageId, text: selected.text, projectId: h.other.id, items });
    const before = h.wire.reverseReads.length;
    await assert.rejects(() => peer.request('session/prompt', { sessionId: row.remote_id, prompt: [{ type: 'text', text: selected.text }], _meta: { requestId: randomUUID(), attachments: items.map(item => item.manifest), humanAuthorization: auth } }), error => [-32003, -32602, -32013].includes(error.code));
    const localOther = 'local-other'; h.client.selectProject(localOther, h.other.id); await h.client.open(localOther);
    const otherSession = h.client.mapping(localOther).remote_id;
    await assert.rejects(() => peer.request('session/prompt', { sessionId: otherSession, prompt: [{ type: 'text', text: selected.text }], _meta: { requestId: randomUUID(), attachments: selected.attachmentEntry.items.map(item => item.manifest), humanAuthorization: selected.attachmentEntry.humanAuthorization } }), error => [-32003, -32602, -32013].includes(error.code));
    assert.equal(h.wire.reverseReads.length, before); assert.equal(h.remote.services.materials.listByProject(h.project.id).length, 0); assert.equal(h.remote.services.materials.listByProject(h.other.id).length, 0);

    // A distinct conversation in the SAME project must not inherit this session's receipt.
    h.adapter.mode = 'read'; await h.client.prompt(h.localId, await h.entry('请看看这份文档，不要归档。'));
    const privateReceipt = h.adapter.selectedReceipt, secondLocal = 'same-project-second-session';
    h.client.selectProject(secondLocal, h.project.id); await h.client.open(secondLocal);
    const secondRemote = h.client.mapping(secondLocal).remote_id, raw = '把刚才那份归档。';
    const scoped = makeHumanAuthorization({ messageId: randomUUID(), text: raw, projectId: h.project.id, receiptScopes: [{ receiptId: privateReceipt, action: 'archive' }] });
    const scopedBefore = { reads: h.wire.reverseReads.length, calls: h.adapter.calls, prompts: h.wire.prompts.length };
    await assert.rejects(() => peer.request('session/prompt', { sessionId: secondRemote, prompt: [{ type: 'text', text: raw }], _meta: { requestId: randomUUID(), humanAuthorization: scoped } }), error => [-32003, -32004, -32602, -32013].includes(error.code));
    assert.equal(h.wire.prompts.length, scopedBefore.prompts + 1); assert.equal(h.adapter.calls, scopedBefore.calls); assert.equal(h.wire.reverseReads.length, scopedBefore.reads);
    assert.equal(h.remote.services.materials.listByProject(h.project.id).length, 0);
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM attachment_human_grants').get().n), 0);

    assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});

test('model-supplied historical restore fields cannot substitute for the current human grant', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    await h.client.prompt(h.localId, await h.entry('请归档这份文档。'));
    await h.client.prompt(h.localId, await h.entry('请归档这份文档。', { bytes: Buffer.from('Synthetic requirement\nNew version\n') }));
    const material = h.remote.services.materials.listByProject(h.project.id)[0]; assert.equal(material.latestVersion, 2);
    h.adapter.malicious = { target_material_id: material.id, expected_latest_version: 2, restore_version: 1 };
    await h.client.prompt(h.localId, await h.entry('请归档这份文档。'));
    assert.equal(h.adapter.archiveResults.at(-1).ok, false); assert.equal(h.remote.services.materials.listByProject(h.project.id)[0].latestVersion, 2);
    assert.ok(!h.updates.some(update => update?._meta?.requestId === h.wire.prompts.at(-1)._meta.requestId && update?._meta?.operationResult?.kind === 'material_archive'), 'Rejected model restore fields must not publish success');
    assert.equal(h.remote.services.materials.read({ materialId: material.id, version: 1 }).content, BIG_CONTENT.toString());
    assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});

test('real archive with final RPC frame dropped becomes client unknown; recovery is scoped read-only without replay or retransmission', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const selected = await h.entry('请归档这份文档。'); h.wire.dropNextPromptResult = true;
    await assert.rejects(() => h.client.prompt(h.localId, selected)); assert.equal(h.wire.dropped, 1);
    const submission = h.client.db.prepare('SELECT state FROM client_submissions WHERE local_id=? AND message_id=?').get(h.localId, selected.messageId);
    assert.equal(submission.state, 'unknown');
    const material = h.remote.services.materials.listByProject(h.project.id)[0]; assert.ok(material); assert.equal(material.latestVersion, 1);
    const counts = { prompts: h.wire.prompts.length, reads: h.wire.reverseReads.length, calls: h.adapter.calls, hostReads: h.hostReads };
    const sid = h.client.mapping(h.localId).remote_id;
    await until(() => !h.service.sessions.get(sid)?.connection, 'server detach after dropped real reply');
    await h.client.recoverAll(); const receipts = await h.client.attachmentReceipts(h.localId); const history = await h.client.legacyHistory(h.localId);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].archived, true); assert.ok(history.events.length > 0);
    const recoveredFact = await expectPersistedOperation(h, 'material_archive', { version: 1 });
    assert.match(recoveredFact.text, /第1版/u);
    await assert.rejects(() => h.client.prompt(h.localId, selected), error => error.code === -32005);
    assert.deepEqual({ prompts: h.wire.prompts.length, reads: h.wire.reverseReads.length, calls: h.adapter.calls, hostReads: h.hostReads }, counts);
    assert.equal(h.remote.services.materials.listByProject(h.project.id)[0].latestVersion, 1); assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});


test('shared human-intent fixture equals server current bytes', () => {
  assert.equal(sha(readFileSync(resolve(clientRoot, 'src/human-intent.mjs'))), sha(readFileSync(new URL('../../src/human-intent.mjs', import.meta.url))));
});


test('raw human explicit destination conflict is rejected before Agent despite internally self-consistent project metadata', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const selected = await h.entry('请归档这份文档。');
    selected.text = '请归档到Other synthetic project。';
    selected.attachmentEntry.humanAuthorization = makeHumanAuthorization({ messageId: selected.messageId, text: selected.text, projectId: h.project.id, items: selected.attachmentEntry.items });
    const before = { calls: h.adapter.calls, reads: h.wire.reverseReads.length, prompts: h.wire.prompts.length };
    await assert.rejects(() => h.client.prompt(h.localId, selected), error => [-32003, -32602, -32013].includes(error.code), 'Human explicitly named project B; self-consistent metadata A must not override that intent');
    assert.equal(h.wire.prompts.length, before.prompts + 1, 'Rejection must be from the real server, not a local-only client guard');
    assert.equal(h.adapter.calls, before.calls, 'Admission must fail before invoking the Agent');
    assert.equal(h.wire.reverseReads.length, before.reads);
    assert.equal(h.remote.services.materials.listByProject(h.project.id).length, 0);
    assert.equal(h.remote.services.materials.listByProject(h.other.id).length, 0);
  } finally { await h.close(); }
});


test('real archive followed by model interruption projects authenticated committed facts in readable partial failure, never a fabricated success or automatic retry', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    h.adapter.interruptAfterArchive = true; const selected = await h.entry('请归档这份文档。'); let failed;
    await assert.rejects(() => h.client.prompt(h.localId, selected), error => { failed = error; return error.code === -32009; });
    assert.equal(failed.outcome, 'unknown');
    assert.ok(Array.isArray(failed.data.operationResults), 'Facts must come through real service callback, not fake final text');
    const committed = failed.data.operationResults.filter(row => row.kind === 'material_archive');
    assert.equal(committed.length, 1); assert.equal(committed[0].version, 1); assert.equal(committed[0].name, 'requirements.md');
    assert.match(failed.message, /已归档为第1版/u); assert.match(failed.message, /尚未确认/u);
    assert.doesNotMatch(failed.message, /\b[a-f0-9]{32,64}\b|UNKNOWN|-32\d{3}|JSON/u);
    assert.equal(h.adapter.calls, 5, 'No automatic fake-provider retry after committed business operation and interrupted model');
    await expectPersistedOperation(h, 'material_archive', { receipt_id: committed[0].receipt_id, version: 1 });
    const material = h.remote.services.materials.listByProject(h.project.id)[0]; assert.equal(material.latestVersion, 1); assert.equal(material.id, committed[0].material_id);
    const counts = { prompts: h.wire.prompts.length, reads: h.wire.reverseReads.length, calls: h.adapter.calls, hostReads: h.hostReads };
    const receipts = await h.client.attachmentReceipts(h.localId); await h.client.legacyHistory(h.localId);
    assert.equal(receipts.length, 1); assert.equal(receipts[0].archived, true);
    assert.deepEqual({ prompts: h.wire.prompts.length, reads: h.wire.reverseReads.length, calls: h.adapter.calls, hostReads: h.hostReads }, counts);
    assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});


test('trusted historical proposal from real receipts RPC plus a new bare human confirmation restores old bytes as a new version without retransmission', { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    await h.client.prompt(h.localId, await h.entry('请归档这份文档。')); const originalReceipt = h.adapter.selectedReceipt;
    const newer = Buffer.from('Synthetic requirement\nSecond synthetic content\n');
    await h.client.prompt(h.localId, await h.entry('请归档这份文档。', { bytes: newer }));
    await h.client.prompt(h.localId, await h.entry('请归档这份文档。'));
    const oldContentReceipt = h.adapter.selectedReceipt, rejected = h.adapter.archiveResults.at(-1);
    assert.equal(rejected.ok, false, 'Historical content must first ask, not silently restore');
    const material = h.remote.services.materials.listByProject(h.project.id)[0]; assert.equal(material.latestVersion, 2);
    const needsConfirmation = await expectPersistedOperation(h, 'restore_confirmation_required', { material_id: material.id, restoreVersion: 1, expectedLatestVersion: 2 });
    assert.match(needsConfirmation.text, /确认|是否/u);
    assert.doesNotMatch(needsConfirmation.text, /已归档|已恢复/u);
    assert.ok(!h.updates.some(update => update?._meta?.requestId === h.wire.prompts.at(-1)._meta.requestId && update?._meta?.operationResult?.kind === 'material_archive'), 'Historical confirmation request must not fabricate an archive receipt');
    const receipts = await h.client.attachmentReceipts(h.localId), pendingReceipt = receipts.find(row => row.receiptId === oldContentReceipt);
    assert.ok(pendingReceipt?.pendingRestore, 'Proposal must be authoritative persisted service data, not a model-supplied boolean');
    const pending = pendingReceipt.pendingRestore;
    assert.equal(pending.targetMaterialId, material.id); assert.equal(pending.restoreVersion, 1); assert.equal(pending.expectedLatestVersion, 2);
    const raw = '确认';
    const message = createUserMessage({ content: [{ type: 'text', text: raw }], source: { kind: 'user' } });
    const selected = await h.attachments.capture({ localId: h.localId, message, workspace: h.root, admission: { kind: 'archive', projectId: h.project.id, receiptScopes: [{ receiptId: oldContentReceipt, action: 'archive', ...pending }] } });
    const before = { reads: h.wire.reverseReads.length, hostReads: h.hostReads };
    h.adapter.mode = 'receipt'; h.adapter.selectedReceipt = oldContentReceipt; h.adapter.expectedCurrentText = raw;
    h.adapter.malicious = { target_material_id: pending.targetMaterialId, expected_latest_version: pending.expectedLatestVersion, restore_version: pending.restoreVersion };
    await h.client.prompt(h.localId, { messageId: message.id, text: raw, attachmentEntry: selected, onUpdate: update => h.updates.push(update) });
    assert.equal(h.adapter.archiveResults.at(-1).ok, true); assert.equal(h.adapter.archiveResults.at(-1).version, 3);
    const restored = await expectPersistedOperation(h, 'material_archive', { receipt_id: oldContentReceipt, material_id: material.id, version: 3 });
    assert.match(restored.text, /第3版/u);
    assert.equal(h.wire.prompts.at(-1).prompt[0].text, raw, 'Bare current confirmation remains unchanged on wire');
    assert.equal(h.wire.reverseReads.length, before.reads); assert.equal(h.hostReads, before.hostReads);
    assert.equal(h.remote.services.materials.listByProject(h.project.id)[0].latestVersion, 3);
    assert.equal(h.remote.services.materials.read({ materialId: material.id, version: 1 }).content, BIG_CONTENT.toString());
    assert.equal(h.remote.services.materials.read({ materialId: material.id, version: 2 }).content, newer.toString());
    assert.equal(h.remote.services.materials.read({ materialId: material.id, version: 3 }).content, BIG_CONTENT.toString());
    const after = await h.client.attachmentReceipts(h.localId);
    assert.equal(after.find(row => row.receiptId === originalReceipt).version, 1);
    assert.equal(after.find(row => row.receiptId === oldContentReceipt).version, 3);
    assert.deepEqual(formalSnapshot(h.db), h.baseline);
  } finally { await h.close(); }
});
