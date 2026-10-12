import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestRuntime } from './helpers/host.mjs';
class FailingModel extends LlmAdapter {
  async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_FAIL', message: 'deterministic model failure' } } }; }
}
class WaitingModel extends LlmAdapter {
  async *stream(options) {
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'prefix' };
    await new Promise(resolve => { options.signal.addEventListener('abort', resolve, { once: true }); if (options.signal.aborted) resolve(); });
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'prefix' } };
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'CANCELLED', message: 'cancel' } } };
  }
}
test('actual DSH errors are not reported as clean completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-error-'));
  const runtime = await createTestRuntime({ provider: 'fixture', model: 'f', adapter: new FailingModel(), persistenceRoot: join(root, 'sessions') });
  try { const h = await runtime.open({ id: 'error', owner: 'alice', cwd: root, resume: false }); await assert.rejects(runtime.prompt(h, 'fail', new AbortController().signal, () => {}), /deterministic model failure/); }
  finally { await runtime.closeAll(); }
});
test('actual DSH cancellation keeps partial stream and persists same session for restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cancel-')); const runtime = await createTestRuntime({ provider: 'fixture', model: 'f', adapter: new WaitingModel(), persistenceRoot: join(root, 'sessions') });
  try {
    const h = await runtime.open({ id: 'cancel', owner: 'alice', cwd: root, resume: false }); const controller = new AbortController();
    const updates = []; const response = await runtime.prompt(h, 'wait', controller.signal, u => { updates.push(u); controller.abort(); });
    assert.equal(response.stopReason, 'cancelled'); assert.equal(updates[0].content.text, 'prefix');
    await runtime.close(h); const resumed = await runtime.open({ id: 'cancel', owner: 'alice', cwd: root, resume: true });
    assert.ok(resumed.agent.session.deriveMessages().some(m => m.content.some(b => b.type === 'text' && b.text === 'prefix')));
  } finally { await runtime.closeAll(); }
});
