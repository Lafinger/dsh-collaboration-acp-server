import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Session } from '@deepseek-ai/dsh-session';
import { createHost } from './helpers/host.mjs';
import { DshRuntime } from '../src/dsh-runtime.mjs';
class Counting extends LlmAdapter {
  calls = 0;
  async *stream() { this.calls++; yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: 'new' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'new' } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
}
test('cold restore clears persisted pending inbox without executing it and preserves same-id history', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-cold-recovery-')), adapter = new Counting(), host = await createHost({ root, adapter });
  const runtime = await new DshRuntime({ ctx: host.ctx, provider: 'fixture', model: 'fixture' }).start();
  try {
    const handle = await runtime.open({ id: 'cold', owner: 'alice', cwd: root, resume: false });
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'previously queued command' }] });
    const event = structuredClone(handle.agent.session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [message] }));
    // Persist a pending event like a crash after enqueue: graceful close clears the real live inbox.
    await runtime.close(handle);
    const stored = await host.ctx.sessionPersistence.open('cold', 'write'); const read = await stored.read();
    event.seq = read.events.length; event.time = Date.now(); await stored.append([event]); await stored.close();
    const resumed = await runtime.open({ id: 'cold', owner: 'alice', cwd: root, resume: true });
    assert.equal(resumed.agent.inbox.nextTurn.length, 0); assert.equal(adapter.calls, 0);
    await runtime.prompt(resumed, 'explicit new input', new AbortController().signal, () => {});
    assert.equal(adapter.calls, 1);
  } finally { await runtime.closeAll(); await host.close(); }
});
