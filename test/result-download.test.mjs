import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../business/lib/sqlite/connection.js';
import { ProjectService } from '../business/lib/service/project-service.js';
import { MaterialService } from '../business/lib/service/material-service.js';
import { ResultDownloadService } from '../src/result-download-service.mjs';
import { listenResultDownloads } from '../src/download-transport.mjs';

function fixture(t, { now = Date.now, ttlMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'result-download-'));
  const db = openDatabase({ path: join(root, 'business.sqlite') });
  const projects = new ProjectService(db);
  const materials = new MaterialService(db, join(root, 'files'));
  const project = projects.create({ key: 'DL', name: 'download test' });
  const source = join(root, 'spec.md');
  writeFileSync(source, 'hello world');
  const uploaded = materials.upload({ projectId: project.id, sourcePath: source, originalName: 'spec.md', purpose: '成果', submittedBy: 'alice' });
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run('task-1', project.id, 'frontend', 1, '2026-10-30T00:00:00.000Z', null, null, null);
  db.prepare('INSERT INTO result_versions VALUES(?,?,?,?,?,?,?,?)').run('result-1', 1, 'task-1', 1, 'summary', 'self check', 'alice', '2026-10-30T00:00:00.000Z');
  db.prepare('INSERT INTO result_files VALUES(?,?,?,?,?,?,?)').run('result-1', 1, 0, uploaded.version.relPath, 'spec.md', uploaded.version.sha256, uploaded.version.size);
  db.prepare('INSERT INTO result_versions VALUES(?,?,?,?,?,?,?,?)').run('result-empty', 1, 'task-1', 1, 'summary', 'self check', 'alice', '2026-10-30T00:00:00.000Z');
  const downloads = new ResultDownloadService({ db, materials, port: 18080, hosts: ['192.168.2.20', '10.242.169.184'], now, ...(ttlMs === undefined ? {} : { ttlMs }) });
  t.after(() => db.close());
  return { root, source, db, projects, project, materials, uploaded, downloads };
}

test('one unexpired token per result version; page and file resolve only that version', t => {
  const f = fixture(t);
  const first = f.downloads.ensure('result-1', 1, f.project.id);
  const second = f.downloads.ensure('result-1', 1, f.project.id);
  assert.equal(first.token, second.token);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  const page = f.downloads.page(first.token);
  assert.equal(page.status, 200);
  assert.deepEqual(page.files.map(file => file.original_name), ['spec.md']);
  const file = f.downloads.file(first.token, 0);
  assert.equal(file.status, 200);
  assert.equal(file.name, 'spec.md');
  assert.equal(file.size, 11);
  assert.equal(f.downloads.file(first.token, 1).status, 404);
  assert.deepEqual(f.downloads.links('result-empty', 1, f.project.id), []);
});

test('links reuse the token across both configured hosts; download count is recorded', t => {
  const f = fixture(t);
  const links = f.downloads.links('result-1', 1, f.project.id);
  assert.equal(links.length, 2);
  assert.match(links[0], /^http:\/\/192\.168\.2\.20:18080\/d\/[A-Za-z0-9_-]{43}$/);
  assert.match(links[1], /^http:\/\/10\.242\.169\.184:18080\/d\/[A-Za-z0-9_-]{43}$/);
  const token = links[0].split('/').pop();
  f.downloads.record(token);
  const row = f.db.prepare('SELECT downloads,last_download_at FROM result_download_tokens WHERE token=?').get(token);
  assert.equal(row.downloads, 1);
  assert.ok(row.last_download_at > 0);
});

test('expired and malformed tokens are refused', t => {
  let clock = 1000;
  const f = fixture(t, { now: () => clock, ttlMs: 500 });
  const token = f.downloads.ensure('result-1', 1, f.project.id).token;
  assert.equal(f.downloads.page(token).status, 200);
  clock = 2000;
  assert.equal(f.downloads.page(token).status, 410);
  assert.equal(f.downloads.page('not-a-token').status, 404);
  assert.equal(f.downloads.file(token, 0).status, 410);
});

const tokenOf = links => links[0].split('/').pop();
const refOf = uploaded => ({ materialId: uploaded.material.id, version: uploaded.version.version });

test('notification inventory combines exact originals and fixed references, deduplicates tuples and isolates recipes', async t => {
  const f = fixture(t), ref = refOf(f.uploaded);
  writeFileSync(f.source, 'second immutable version');
  const second = f.materials.upload({ projectId: f.project.id, sourcePath: f.source, originalName: 'spec.md', purpose: '成果', submittedBy: 'alice' });
  f.materials.read = () => { throw new Error('must not parse or refresh'); };
  const links = f.downloads.notificationLinks({ projectId: f.project.id, resultId: 'result-1', resultVersion: 1, references: [ref, ref, refOf(second)] });
  assert.equal(links.length, 2);
  assert.equal(tokenOf(links), tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, resultId: 'result-1', resultVersion: 1, references: [ref, ref, refOf(second)] })));
  const token = tokenOf(links), page = f.downloads.page(token);
  assert.deepEqual(page.files.map(({ position, kind, version }) => ({ position, kind, version })), [
    { position: 0, kind: 'result', version: 1 }, { position: 1, kind: 'material', version: 1 }, { position: 2, kind: 'material', version: 2 },
  ]);
  assert.equal(readFileSync(f.downloads.file(token, 1).path, 'utf8'), 'hello world');
  assert.equal(readFileSync(f.downloads.file(token, 2).path, 'utf8'), 'second immutable version');
  const onlyFirst = tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, references: [ref] }));
  assert.notEqual(onlyFirst, token);
  assert.equal(f.downloads.file(onlyFirst, 1).status, 404);
  assert.equal(f.downloads.file(token, 3).status, 404);
  const listener = await listenResultDownloads(f.downloads, { port: 0, hosts: ['127.0.0.1'] });
  t.after(() => listener.close());
  const origin = `http://127.0.0.1:${listener.addresses[0].port}`;
  const html = await (await fetch(`${origin}/d/${token}`)).text();
  assert.match(html, /相关文件/); assert.match(html, /成果原件 · 固定 v1/); assert.match(html, /参考资料 · 固定 v2/);
  for (const [position, bytes] of [[0, 'hello world'], [1, 'hello world'], [2, 'second immutable version']]) {
    const response = await fetch(`${origin}/d/${token}/${position}`);
    assert.equal(response.status, 200); assert.equal(await response.text(), bytes);
  }
  assert.equal(f.db.prepare('SELECT downloads FROM notification_download_tokens WHERE token=?').get(token).downloads, 3);
  // Legacy tokens keep the original fixed result table and still download after new tokens exist.
  const legacy = f.downloads.ensure('result-1', 1, f.project.id).token;
  assert.equal(readFileSync(f.downloads.file(legacy, 0).path, 'utf8'), 'hello world');
});

test('result versions and stable manifest positions never redirect to later or remaining resources', t => {
  const f = fixture(t), ref = refOf(f.uploaded);
  const first = tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, resultId: 'result-1', resultVersion: 1, references: [ref] }));
  writeFileSync(f.source, 'new result version');
  const next = f.materials.upload({ projectId: f.project.id, sourcePath: f.source, originalName: 'spec.md', purpose: '成果', submittedBy: 'alice' });
  f.db.prepare('INSERT INTO result_versions VALUES(?,?,?,?,?,?,?,?)').run('result-1', 2, 'task-1', 1, 'second summary', 'second check', 'alice', '2026-11-02T00:00:00.000Z');
  f.db.prepare('INSERT INTO result_files VALUES(?,?,?,?,?,?,?)').run('result-1', 2, 0, next.version.relPath, 'spec.md', next.version.sha256, next.version.size);
  const second = tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, resultId: 'result-1', resultVersion: 2, references: [ref] }));
  assert.notEqual(first, second);
  assert.equal(readFileSync(f.downloads.file(first, 0).path, 'utf8'), 'hello world');
  assert.equal(readFileSync(f.downloads.file(second, 0).path, 'utf8'), 'new result version');
  f.db.prepare('DELETE FROM result_files WHERE result_id=? AND version=1').run('result-1');
  assert.deepEqual(f.downloads.page(first).files.map(row => [row.position, row.available]), [[0, false], [1, true]]);
  assert.equal(f.downloads.file(first, 0).status, 404);
  assert.equal(readFileSync(f.downloads.file(first, 1).path, 'utf8'), 'hello world');
  const other = f.projects.create({ key: 'MOVED', name: 'moved fixture' });
  f.db.prepare('UPDATE materials SET project_id=? WHERE id=?').run(other.id, ref.materialId);
  assert.equal(f.downloads.file(first, 1).status, 404);
  assert.equal(f.downloads.file(second, 0).status, 200);
});

test('invalid, missing and cross-project recipes never mint fake links or substitute latest versions', t => {
  const f = fixture(t), ref = refOf(f.uploaded), other = f.projects.create({ key: 'OTHER', name: 'other project' });
  for (const input of [
    { projectId: f.project.id, references: [{ materialId: ref.materialId, version: 99 }] },
    { projectId: other.id, references: [ref], resultId: 'result-1', resultVersion: 1 },
    { projectId: f.project.id, references: [{ materialId: 'absent', version: 1 }] },
    { projectId: f.project.id, resultId: ref.materialId, resultVersion: 1 },
    { projectId: f.project.id, references: [{ ...ref, version: 0 }] },
  ]) assert.deepEqual(f.downloads.notificationLinks(input), []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notification_download_tokens').get().n, 0);
  assert.deepEqual(f.downloads.notificationLinks({ projectId: f.project.id, references: [{ materialId: 'absent', version: 1 }, ref] }), []);
  const token = tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, references: [ref] }));
  assert.equal(f.downloads.page(token).files.length, 1);
  f.db.prepare('DELETE FROM material_versions WHERE material_id=? AND version=1').run(ref.materialId);
  assert.deepEqual(f.downloads.page(token).files.map(file => [file.position, file.original_name, file.available]), [[0, null, false]]);
  assert.equal(f.downloads.file(token, 0).status, 404);
});

test('combined token expiry and malformed positions do not weaken legacy expiry', t => {
  let clock = 100;
  const f = fixture(t, { now: () => clock, ttlMs: 50 });
  const token = tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, references: [refOf(f.uploaded)] }));
  assert.equal(f.downloads.file(token, -1).status, 404);
  assert.equal(f.downloads.file(token, 0.1).status, 404);
  assert.equal(f.downloads.page('a'.repeat(43)).status, 404);
  clock = 151;
  assert.equal(f.downloads.page(token).status, 410);
  assert.equal(f.downloads.file(token, 0).status, 410);
  assert.notEqual(tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, references: [refOf(f.uploaded)] })), token);
});

test('material originals reject missing bytes, size/hash corruption, directories and traversal before mint and download', t => {
  const f = fixture(t), ref = refOf(f.uploaded);
  const token = tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, references: [ref] }));
  const path = f.materials.absolutePathOf(f.uploaded.version.relPath);
  const expectRefused = () => {
    assert.equal(f.downloads.file(token, 0).status, 404);
    assert.deepEqual(f.downloads.notificationLinks({ projectId: f.project.id, references: [ref] }), []);
  };
  writeFileSync(path, 'HELLO WORLD'); expectRefused(); // same size, different hash
  writeFileSync(path, 'short'); expectRefused();
  unlinkSync(path); expectRefused();
  mkdirSync(path); expectRefused();
  f.db.prepare('UPDATE material_versions SET rel_path=? WHERE material_id=?').run('../escape.txt', ref.materialId); expectRefused();
  f.db.prepare('UPDATE material_versions SET rel_path=? WHERE material_id=?').run('C:\\outside.txt', ref.materialId); expectRefused();
  f.db.prepare('UPDATE material_versions SET rel_path=?,sha256=? WHERE material_id=?').run(f.uploaded.version.relPath, '', ref.materialId); expectRefused();
});

test('symlink and junction originals are refused, including targets inside the file root', t => {
  const f = fixture(t), ref = refOf(f.uploaded), original = f.materials.absolutePathOf(f.uploaded.version.relPath);
  const token = tokenOf(f.downloads.notificationLinks({ projectId: f.project.id, references: [ref] }));
  const target = join(f.materials.root, 'linked-target'); mkdirSync(target);
  writeFileSync(join(target, 'copy.txt'), 'hello world');
  const junction = join(f.materials.root, 'junction');
  symlinkSync(target, junction, process.platform === 'win32' ? 'junction' : 'dir');
  f.db.prepare('UPDATE material_versions SET rel_path=? WHERE material_id=?').run('junction/copy.txt', ref.materialId);
  assert.equal(f.downloads.file(token, 0).status, 404);
  assert.deepEqual(f.downloads.notificationLinks({ projectId: f.project.id, references: [ref] }), []);
  assert.equal(readFileSync(original, 'utf8'), 'hello world');
});

test('one damaged resource refuses a new mixed inventory and old page marks the gap without a fake link', async t => {
  const f = fixture(t), good = refOf(f.uploaded);
  writeFileSync(f.source, 'separate reference');
  const uploaded = f.materials.upload({ projectId: f.project.id, sourcePath: f.source, originalName: 'reference.md', purpose: '参考', submittedBy: 'alice' });
  const bad = refOf(uploaded), input = { projectId: f.project.id, resultId: 'result-1', resultVersion: 1, references: [good, bad] };
  const token = tokenOf(f.downloads.notificationLinks(input));
  writeFileSync(uploaded.absolutePath, 'corrupt reference!');
  assert.deepEqual(f.downloads.notificationLinks(input), []);
  const files = f.downloads.page(token).files;
  assert.deepEqual(files.map(file => [file.position, file.available]), [[0, true], [1, true], [2, false]]);
  const listener = await listenResultDownloads(f.downloads, { port: 0, hosts: ['127.0.0.1'] });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.addresses[0].port}/d/${token}`), html = await response.text();
  assert.match(html, /reference\.md/); assert.match(html, /不可用（原件缺失或校验失败）/);
  assert.ok(!html.includes(`href="/d/${token}/2"`));
  assert.equal(f.downloads.file(token, 2).status, 404);
});

test('legacy result downloads also refuse tampered hashes and unsafe paths', t => {
  const f = fixture(t), token = f.downloads.ensure('result-1', 1, f.project.id).token;
  writeFileSync(f.materials.absolutePathOf(f.uploaded.version.relPath), 'HELLO WORLD');
  assert.equal(f.downloads.file(token, 0).status, 404);
  f.db.prepare('UPDATE result_files SET rel_path=? WHERE result_id=?').run('../escape', 'result-1');
  assert.equal(f.downloads.file(token, 0).status, 404);
});

test('HTTP request errors do not terminate the shared backend', async t => {
  const downloads = { page() { throw new Error('database temporarily unavailable'); } };
  const listener = await listenResultDownloads(downloads, { port: 0, hosts: ['127.0.0.1'] });
  t.after(() => listener.close());
  const origin = `http://127.0.0.1:${listener.addresses[0].port}`;
  const failed = await fetch(`${origin}/d/${'a'.repeat(43)}`);
  assert.equal(failed.status, 500);
  assert.ok(!(await failed.text()).includes('database'));
  const subsequent = await fetch(`${origin}/unknown`);
  assert.equal(subsequent.status, 404);
});

test('HTTP page lists the file and streams the exact original bytes', async t => {
  const f = fixture(t);
  const token = f.downloads.ensure('result-1', 1, f.project.id).token;
  const listener = await listenResultDownloads(f.downloads, { port: 0, hosts: ['127.0.0.1'] });
  t.after(() => listener.close());
  const origin = `http://127.0.0.1:${listener.addresses[0].port}`;
  const page = await fetch(`${origin}/d/${token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /spec\.md/);
  const file = await fetch(`${origin}/d/${token}/0`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'hello world');
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''spec\.md/);
  const missing = await fetch(`${origin}/d/${token}/9`);
  assert.equal(missing.status, 404);
  const invalid = await fetch(`${origin}/d/${'x'.repeat(43)}`);
  assert.equal(invalid.status, 404);
  const row = f.db.prepare('SELECT downloads FROM result_download_tokens WHERE token=?').get(token);
  assert.equal(row.downloads, 1);
});
