import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { createTestCollaboration } from './helpers/host.mjs';

class DetailsModel extends LlmAdapter {
  calls = 0;
  async *stream(options) {
    this.calls++;
    const last = options.messages.at(-1);
    if (last.role === 'tool') {
      const text = last.content.filter(b => b.type === 'text').map(b => b.text).join('');
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } }; return;
    }
    assert.ok(options.tools.some(t => t.name === 'project_update_details'));
    const text = [...options.messages].reverse().find(m => m.role === 'user' && m.source?.kind === 'user').content.map(b => b.text ?? '').join('');
    const args = JSON.parse(/^FIXTURE_UPDATE (.+)$/m.exec(text)[1]);
    const id = ToolCallId(randomUUID()), block = { type: 'tool-call', id, name: 'project_update_details', arguments: JSON.stringify(args) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

test('official scoped details tool updates existing project atomically, retains related data, rejects archive and attachment-turn writes, restore never replays', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-project-details-')), adapter = new DetailsModel();
  const collaboration = await createTestCollaboration({ workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), adapter });
  const { projects, materials, analyses } = collaboration.services;
  let db;
  try {
    const project = projects.create({ key: 'DETAILS', name: 'Preserved' }), other = projects.create({ key: 'OTHER', name: 'Other' });
    projects.setMember(project.id, 'pm', 'alice'); projects.setMember(project.id, 'product', 'alice'); projects.setMember(project.id, 'design', 'alice');
    const source = join(collaboration.workspace, 'sample.txt'); writeFileSync(source, 'Synthetic requirement');
    const stored = materials.upload({ projectId: project.id, sourcePath: source, purpose: 'Sample', submittedBy: 'alice' });
    const analysis = analyses.submit({ projectId: project.id, trigger: 'Fixture only', scope: [{ materialId: stored.material.id, version: 1 }], requirements: [], undecided: [], inferences: [], notUnderstood: [], basisMissing: [] });
    db = new DatabaseSync(join(root, 'state/collaboration.sqlite'), { readOnly: true });
    const facts = () => Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='projects' ORDER BY name").all().map(({ name }) => [name, db.prepare('SELECT * FROM "' + name + '"').all()]));
    const roles = projects.getWithRoles(project.id).roles;
    const id = randomUUID(); let handle = await collaboration.runtime.open({ id, owner: 'alice', cwd: collaboration.workspace, resume: false });
    const before = facts();
    const run = async (args, attachmentRequest) => {
      const chunks = [], prompt = 'FIXTURE_UPDATE ' + JSON.stringify(args) + (attachmentRequest ? '\n附件操作: 上传并归档\nproject_id: ' + project.id : '');
      const result = await collaboration.runtime.prompt(handle, prompt, new AbortController().signal, u => { if (u.sessionUpdate === 'agent_message_chunk') chunks.push(u.content.text); }, attachmentRequest);
      assert.equal(result.stopReason, 'end_turn'); return chunks.join('');
    };
    const first = JSON.parse(await run({ project_id: project.id, background: '  Approved background  ' }));
    assert.equal(first.ok, true); assert.equal(first.project.background, 'Approved background'); assert.equal(first.project.goal, null); assert.deepEqual(first.project.pending_fields, ['goal']);
    const second = JSON.parse(await run({ project_id: project.id, goal: 'Approved goal' }));
    assert.equal(second.ok, true); assert.equal(second.project.background, first.project.background); assert.deepEqual(second.project.pending_fields, []);
    const repeat = JSON.parse(await run({ project_id: project.id, goal: 'Approved goal' })); assert.deepEqual(repeat, second);
    const invalid = JSON.parse(await run({ project_id: project.id, background: 'Must not change', goal: '' })); assert.equal(invalid.ok, false); assert.equal(invalid.code, 'INVALID_ARGUMENT');
    const definition = handle.agent.ctx.tools.get('project_update_details', handle.agent);
    const extra = await definition.execute({ project_id: project.id, goal: 'Must not change', name: 'Forbidden rename' }, {}); assert.equal(extra.ok, false);
    const data = Buffer.from('Synthetic attachment'), request = { sessionId: id, requestId: 'blocked', account: 'alice', manifests: [{ handle: 'a'.repeat(64), name: 'sample.txt', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), projectId: project.id, archiveAuthorized: true, sourceKind: 'file-attachment' }], read: () => { throw new Error('No attachment transfer expected'); } };
    await run({ project_id: project.id, goal: 'Attachment must not edit project' }, request);
    assert.equal(projects.get(project.id).goal, 'Approved goal');
    assert.deepEqual(facts(), before); assert.deepEqual(projects.getWithRoles(project.id).roles, roles);
    assert.deepEqual(projects.get(other.id), other); assert.equal(analyses.get(analysis.id).id, analysis.id);
    assert.equal(createHash('sha256').update(readFileSync(materials.absolutePathOf(stored.version.relPath))).digest('hex'), stored.version.sha256);
    const calls = adapter.calls; await collaboration.runtime.close(handle);
    handle = await collaboration.runtime.open({ id, owner: 'alice', cwd: collaboration.workspace, resume: true }); assert.equal(adapter.calls, calls);
    projects.archive(project.id);
    const archived = JSON.parse(await run({ project_id: project.id, goal: 'Forbidden archive edit' })); assert.equal(archived.ok, false); assert.equal(archived.code, 'PROJECT_ARCHIVED');
    assert.equal(projects.get(project.id).goal, 'Approved goal'); await collaboration.runtime.close(handle);
  } finally { db?.close(); await collaboration.runtime.closeAll(); }
});
