import test from 'node:test';
import assert from 'node:assert/strict';
import { FixtureModel } from '../src/fixture-model.mjs';
test('fixture recognizes DSH 0.2 tool-role result and finishes instead of repeating the tool', async () => {
  const content = [{ type: 'text', text: '{"account":"alice"}' }];
  const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'whoami' }] }, { role: 'tool', content }];
  const chunks = []; for await (const chunk of new FixtureModel().stream({ messages })) chunks.push(chunk);
  assert.equal(chunks.find(c => c.type === 'text-delta')?.text, content[0].text);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});
