import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('retired standalone entry refuses before starting a second DSH runtime or reading deployment config', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/server.mjs', import.meta.url))], { encoding: 'utf8' });
  if (r.error) throw r.error;
  assert.equal(r.status, 1); assert.match(r.stderr, /Standalone collaboration server removed/);
});
