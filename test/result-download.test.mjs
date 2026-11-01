import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
  return { db, project, uploaded, downloads };
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
