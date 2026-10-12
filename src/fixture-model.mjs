import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { randomUUID } from 'node:crypto';

/** Deterministic LOCAL test model. No subscription, HTTP request or credentials are used. */
export class FixtureModel extends LlmAdapter {
  async *stream(options) {
    const last = options.messages.at(-1);
    const result = last?.role === 'tool' ? last : last?.content.find(b => b.type === 'tool-result');
    const user = [...options.messages].reverse().find(m => m.role === 'user' && m.source?.kind === 'user');
    const input = user?.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? '';
    if (input === 'whoami' && !result) {
      const id = ToolCallId(randomUUID()); const block = { type: 'tool-call', id, name: 'session_whoami', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: block.name, argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
    }
    const text = result ? result.content.filter(b => b.type === 'text').map(b => b.text).join('') : `fixture:${input}`;
    yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
