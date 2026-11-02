import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export const RESULT_DOWNLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const fixedVersion = value => Number.isSafeInteger(value) && value > 0;
const identity = value => typeof value === 'string' && value.length > 0;
const within = path => path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);

/** Read-only original verification. Does not invoke a parser/content provider or mutate a cache. */
function intactOriginal(materials, row) {
  let fd;
  try {
    if (!Number.isSafeInteger(row.size_bytes) || row.size_bytes < 0 || !/^[a-f0-9]{64}$/.test(row.sha256)) return null;
    const path = materials.absolutePathOf(row.rel_path), root = realpathSync(materials.root);
    const lexical = relative(materials.root, path);
    if (!within(lexical) || lstatSync(materials.root).isSymbolicLink()) return null;
    // Reject symlink/junction components, including ones that resolve back inside the root.
    let component = materials.root;
    for (const part of lexical.split(sep)) {
      component = join(component, part);
      if (lstatSync(component).isSymbolicLink()) return null;
    }
    const actual = realpathSync(path);
    if (!within(relative(root, actual)) || !lstatSync(path).isFile()) return null;
    fd = openSync(actual, 'r');
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== row.size_bytes) return null;
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let count = 0, length;
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) { count += length; hash.update(buffer.subarray(0, length)); }
    const after = fstatSync(fd);
    if (count !== row.size_bytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || hash.digest('hex') !== row.sha256) return null;
    return { status: 200, path: actual, name: row.original_name, size: count };
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Bearer tokens are not member identities: holding a link permits downloading its fixed
 * inventory until expiry. Legacy result tokens retain their original table and route. */
export class ResultDownloadService {
  constructor({ db, materials, port, hosts, now = Date.now, ttlMs = RESULT_DOWNLOAD_TTL_MS }) {
    this.db = db; this.materials = materials; this.port = port; this.hosts = hosts; this.now = now; this.ttlMs = ttlMs;
    db.exec(`CREATE TABLE IF NOT EXISTS result_download_tokens (
      token TEXT PRIMARY KEY,
      result_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      downloads INTEGER NOT NULL DEFAULT 0,
      last_download_at INTEGER,
      created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS result_download_tokens_result ON result_download_tokens(result_id, version);
      CREATE TABLE IF NOT EXISTS notification_download_tokens (
      token TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      resources TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      downloads INTEGER NOT NULL DEFAULT 0,
      last_download_at INTEGER,
      created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS notification_download_tokens_resources ON notification_download_tokens(project_id,resource_key);`);
  }
  row(resultId, version) {
    return this.db.prepare('SELECT * FROM result_download_tokens WHERE result_id=? AND version=? AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(resultId, version, this.now());
  }
  /** Reuse the unexpired token for this result version, or mint a new one. */
  ensure(resultId, version, projectId) {
    const existing = this.row(resultId, version);
    if (existing) return existing;
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO result_download_tokens(token,result_id,version,project_id,expires_at,downloads,last_download_at,created_at) VALUES(?,?,?,?,?,0,NULL,?)')
      .run(token, resultId, version, projectId, this.now() + this.ttlMs, this.now());
    return this.db.prepare('SELECT * FROM result_download_tokens WHERE token=?').get(token);
  }
  files(resultId, version) {
    return this.db.prepare('SELECT position,original_name,size_bytes FROM result_files WHERE result_id=? AND version=? ORDER BY position').all(resultId, version);
  }
  /** Existing fixed-result API deliberately remains compatible. */
  links(resultId, version, projectId) {
    if (!this.files(resultId, version).length) return [];
    return this.urls(this.ensure(resultId, version, projectId).token);
  }
  urls(token) { return this.hosts.map(host => `http://${host}:${this.port}/d/${token}`); }
  resultResource(projectId, resource) {
    return this.db.prepare(`SELECT f.rel_path,f.original_name,f.size_bytes,f.sha256 FROM result_files f
      JOIN result_versions r ON r.result_id=f.result_id AND r.version=f.version
      JOIN tasks t ON t.id=r.task_id
      WHERE f.result_id=? AND f.version=? AND f.position=? AND t.project_id=?`).get(resource.resultId, resource.version, resource.position, projectId);
  }
  materialResource(projectId, resource) {
    return this.db.prepare(`SELECT v.rel_path,m.original_name,v.size AS size_bytes,v.sha256 FROM material_versions v
      JOIN materials m ON m.id=v.material_id WHERE v.material_id=? AND v.version=? AND m.project_id=?`).get(resource.materialId, resource.version, projectId);
  }
  resourceRow(projectId, resource) {
    if (!resource || !fixedVersion(resource.version)) return null;
    if (resource.kind === 'result' && identity(resource.resultId) && Number.isSafeInteger(resource.position) && resource.position >= 0) return this.resultResource(projectId, resource);
    if (resource.kind === 'material' && identity(resource.materialId)) return this.materialResource(projectId, resource);
    return null;
  }
  /** One immutable inventory, results first then deduplicated fixed material tuples.
   * Validate caller recipes against same-project DB associations BEFORE minting. The
   * runtime filters known metadata gaps (and separately warns); any remaining unavailable
   * source fails the whole mint so a partially broken inventory cannot look complete. */
  notificationLinks({ projectId, resultId = null, resultVersion = null, references = [] } = {}) {
    if (!identity(projectId) || !Array.isArray(references)) return [];
    const resources = [], seen = new Set();
    let rejected = false;
    const add = resource => {
      const key = JSON.stringify(resource);
      if (seen.has(key)) return;
      seen.add(key);
      const row = this.resourceRow(projectId, resource);
      if (row && intactOriginal(this.materials, row)) resources.push(resource);
      else rejected = true;
    };
    if (resultId !== null || resultVersion !== null) {
      if (!identity(resultId) || !fixedVersion(resultVersion) || !this.db.prepare(`SELECT 1 FROM result_versions r JOIN tasks t ON t.id=r.task_id WHERE r.result_id=? AND r.version=? AND t.project_id=?`).get(resultId, resultVersion, projectId)) rejected = true;
      else for (const row of this.files(resultId, resultVersion)) add({ kind: 'result', resultId, version: resultVersion, position: row.position });
    }
    for (const reference of references) {
      if (identity(reference?.materialId) && fixedVersion(reference.version)) add({ kind: 'material', materialId: reference.materialId, version: reference.version });
      else rejected = true;
    }
    if (rejected || !resources.length) return [];
    const json = JSON.stringify(resources), resourceKey = createHash('sha256').update(json).digest('hex');
    let row = this.db.prepare('SELECT token FROM notification_download_tokens WHERE project_id=? AND resource_key=? AND resources=? AND expires_at>? ORDER BY created_at DESC LIMIT 1').get(projectId, resourceKey, json, this.now());
    if (!row) {
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO notification_download_tokens(token,project_id,resource_key,resources,expires_at,created_at) VALUES(?,?,?,?,?,?)').run(token, projectId, resourceKey, json, this.now() + this.ttlMs, this.now());
      row = { token };
    }
    return this.urls(row.token);
  }
  lookup(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    return this.db.prepare('SELECT * FROM result_download_tokens WHERE token=?').get(token)
      ?? this.db.prepare('SELECT * FROM notification_download_tokens WHERE token=?').get(token) ?? null;
  }
  inventory(row) {
    try {
      const resources = JSON.parse(row.resources);
      return Array.isArray(resources) ? resources : [];
    } catch { return []; }
  }
  /** Public positions are stable even when a resource later disappears: never redirect. */
  page(token) {
    const row = this.lookup(token);
    if (!row) return { status: 404 };
    if (row.expires_at <= this.now()) return { status: 410 };
    if (row.resources === undefined) return { status: 200, row, files: this.files(row.result_id, row.version).map(file => ({ ...file, kind: 'result', version: row.version })) };
    const files = this.inventory(row).map((resource, position) => {
      const file = this.resourceRow(row.project_id, resource);
      return { position, original_name: file?.original_name ?? null, size_bytes: file?.size_bytes ?? null,
        kind: resource.kind, version: resource.version, available: !!file && intactOriginal(this.materials, file) !== null };
    });
    return { status: 200, row, files };
  }
  file(token, position) {
    const tokenRow = this.lookup(token);
    if (!tokenRow) return { status: 404 };
    if (tokenRow.expires_at <= this.now()) return { status: 410 };
    if (!Number.isSafeInteger(position) || position < 0) return { status: 404 };
    let row;
    if (tokenRow.resources === undefined) {
      row = this.resultResource(tokenRow.project_id, { resultId: tokenRow.result_id, version: tokenRow.version, position });
    } else {
      row = this.resourceRow(tokenRow.project_id, this.inventory(tokenRow)[position]);
    }
    return row ? intactOriginal(this.materials, row) ?? { status: 404 } : { status: 404 };
  }
  record(token) {
    const row = this.lookup(token);
    if (!row) return;
    const table = row.resources === undefined ? 'result_download_tokens' : 'notification_download_tokens';
    this.db.prepare(`UPDATE ${table} SET downloads=downloads+1,last_download_at=? WHERE token=?`).run(this.now(), token);
  }
}
