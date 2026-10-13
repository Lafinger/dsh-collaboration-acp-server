import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('real host-plugin package has entry, disabled bundle, precise peers and MIT, no standalone bin or install build', () => {
  assert.equal(metadata.main, 'src/server-plugin.mjs'); assert.equal(metadata.exports['.'], './src/server-plugin.mjs');
  assert.equal(metadata.engines.dsh, '0.2.0-rc.2'); assert.equal(metadata.peerDependencies['@deepseek-ai/cordis'], '4.0.4');
  assert.equal(metadata.dsh.bundle.patch, 'cordis.patch.yml'); assert.equal(metadata.bin['dsh-collaboration-acp-server'], undefined);
  assert.equal(metadata.license, 'MIT'); assert.equal(metadata.private, true);
  for (const k of ['prepare','prepack','install','postinstall']) assert.equal(metadata.scripts[k], undefined);
  assert.match(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), /disabled:\s*true/);
  assert.match(readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /^MIT License\r?\n/);
});
test('production runtime files neither construct Context nor mount or dispose host runtime services', () => {
  for (const file of ['dsh-runtime.mjs','collaboration-runtime.mjs','server-plugin.mjs']) {
    const source = readFileSync(new URL('../src/' + file, import.meta.url), 'utf8');
    assert.ok(!/new Context\(|ctx\.plugin\(|ctx\.fiber\.dispose\(|registerAdapter\(/.test(source));
  }
});
