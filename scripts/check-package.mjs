import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node scripts/check-package.mjs <tarball>');
const tar = gunzipSync(readFileSync(resolve(process.argv[2])));
const entries = new Map();
let offset = 0, nextPath;
const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
function paxPath(bytes) {
  let index = 0, path;
  while (index < bytes.length) {
    const space = bytes.indexOf(32, index);
    const length = Number(bytes.subarray(index, space).toString('ascii'));
    assert.ok(space >= index && Number.isSafeInteger(length) && length > 0 && index + length <= bytes.length, 'Malformed PAX record');
    const record = bytes.subarray(space + 1, index + length - 1).toString('utf8');
    if (record.startsWith('path=')) path = record.slice(5);
    index += length;
  }
  return path;
}
while (offset + 512 <= tar.length) {
  const block = tar.subarray(offset, offset + 512);
  if (block.every(value => value === 0)) break;
  const name = field(block, 0, 100), prefix = field(block, 345, 155);
  const filename = (prefix ? `${prefix}/` : '') + name;
  const size = parseInt(field(block, 124, 12).trim() || '0', 8);
  const type = field(block, 156, 1) || '0';
  offset += 512;
  assert.ok(Number.isSafeInteger(size) && size >= 0 && offset + size <= tar.length, 'Invalid archive length');
  const data = Buffer.from(tar.subarray(offset, offset + size));
  if (type === 'x') nextPath = paxPath(data);
  else if (type === 'L') nextPath = data.toString('utf8').replace(/\0.*$/s, '');
  else if (type === '0') {
    const path = nextPath ?? filename;
    nextPath = undefined;
    assert.ok(path.startsWith('package/') && !path.includes('\\') && !path.split('/').includes('..'), `Unsafe tar entry: ${path}`);
    entries.set(path.slice(8), data);
  } else assert.ok(['5', 'g'].includes(type), `Unsupported tar entry ${type}`);
  offset += Math.ceil(size / 512) * 512;
}
const metadata = JSON.parse(entries.get('package.json').toString('utf8'));
for (const name of entries.keys()) assert.ok(!/(^|\/)(?:node_modules|\.git|\.dsh)(?:\/|$)|\.sqlite(?:-|$)/.test(name), `Private/generated file in package: ${name}`);
const declared = [metadata.main, ...Object.values(metadata.exports ?? {}), ...Object.values(metadata.bin ?? {})].filter(value => typeof value === 'string');
for (const name of declared) assert.ok(entries.has(name.replace(/^\.\//, '')), `Package entry missing: ${name}`);
for (const [name, bytes] of entries) {
  if (!/\.(?:mjs|js)$/.test(name)) continue;
  for (const match of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*|import\()\s*['"](\.[^'"]+)['"]/g)) {
    const target = posix.normalize(posix.join(posix.dirname(name), match[1]));
    assert.ok(entries.has(target), `Packaged import missing: ${name} => ${target}`);
  }
}
if (metadata.name === 'dsh-collaboration-client') {
  assert.ok(entries.has('cordis.patch.yml'), 'DSH bundle patch missing');
  assert.equal(metadata.dsh?.bundle?.patch, 'cordis.patch.yml');
  assert.match(entries.get('cordis.patch.yml').toString('utf8'), /disabled:\s*true/);
} else assert.ok(entries.has('business/lib/tool/register.js'), 'Business tool module missing');
mkdirSync(join(root, '.dsh'), { recursive: true });
const detached = mkdtempSync(join(root, '.dsh/packed-'));
for (const [name, bytes] of entries) {
  const target = join(detached, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
// Source is extracted from tarball; external packages resolve normally to this checkout's node_modules.
const code = metadata.name === 'dsh-collaboration-client'
  ? `const m=await import(${JSON.stringify(pathToFileURL(join(detached, 'src/member-plugin.mjs')).href)});if(typeof m.apply!=='function'||typeof m.MemberAdapter!=='function')throw new Error('Missing plugin exports');`
  : `const m=await import(${JSON.stringify(pathToFileURL(join(detached, 'src/workbench-runtime.mjs')).href)});const {runtime}=await m.createWorkbenchRuntime({workspace:${JSON.stringify(join(detached, '.state/workspace'))},stateRoot:${JSON.stringify(join(detached, '.state/data'))},fixture:true});await runtime.closeAll();`;
const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: detached, stdio: 'inherit' });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'Detached package smoke failed');
console.log(JSON.stringify({ package: metadata.name, files: entries.size, detachedPackageSmoke: 'PASS', oldRepositoryUsed: false, fixtureOnly: true }));
