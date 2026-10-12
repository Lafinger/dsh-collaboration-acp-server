import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeBuild } from './normalize-build.mjs';
mkdirSync('.dsh', { recursive: true });
const target = mkdtempSync(resolve('.dsh/build-verify-'));
const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'business/tsconfig.json', '--noEmitOnError', '--outDir', target], { stdio: 'inherit' });
if (result.error) throw result.error; assert.equal(result.status, 0, 'Business compilation failed');
normalizeBuild(target);
function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(root, join(prefix, e.name)) : [join(prefix, e.name)]).sort();
}
const committed = files(resolve('business/lib')), expected = files(target);
assert.deepEqual(committed, expected, 'Committed business artifacts must contain exactly current compiler output');
for (const name of expected) assert.equal(readFileSync(join('business/lib', name), 'utf8').replace(/\r\n/g, '\n'), readFileSync(join(target, name), 'utf8').replace(/\r\n/g, '\n'), `Business artifact differs from source: ${name}`);
console.log(JSON.stringify({ businessBuildMatchesSource: true, files: expected.length, generatedAt: relative(process.cwd(), target) }));
