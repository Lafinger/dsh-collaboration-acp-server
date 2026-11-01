import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';

export const RESULT_DOWNLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Bearer-token inventory for one submitted result version. Tokens are not member identities:
 * anyone holding the link may download until it expires (ADR-0010). */
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
      CREATE INDEX IF NOT EXISTS result_download_tokens_result ON result_download_tokens(result_id, version);`);
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
  /** URLs for the fixed notification; empty when the result has no files. */
  links(resultId, version, projectId) {
    if (!this.files(resultId, version).length) return [];
    const token = this.ensure(resultId, version, projectId).token;
    return this.hosts.map(host => `http://${host}:${this.port}/d/${token}`);
  }
  lookup(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    return this.db.prepare('SELECT * FROM result_download_tokens WHERE token=?').get(token) ?? null;
  }
  /** 200 with the file list, 404 unknown token, 410 expired token. */
  page(token) {
    const row = this.lookup(token);
    if (!row) return { status: 404 };
    if (row.expires_at <= this.now()) return { status: 410 };
    return { status: 200, row, files: this.files(row.result_id, row.version) };
  }
  /** 200 with the exact original stream source; position must belong to this token's version. */
  file(token, position) {
    const page = this.page(token);
    if (page.status !== 200) return page;
    if (!Number.isSafeInteger(position) || position < 0) return { status: 404 };
    const row = this.db.prepare('SELECT rel_path,original_name,size_bytes FROM result_files WHERE result_id=? AND version=? AND position=?').get(page.row.result_id, page.row.version, position);
    if (!row) return { status: 404 };
    const path = this.materials.absolutePathOf(row.rel_path);
    if (!existsSync(path)) return { status: 404 };
    const size = statSync(path).size;
    return { status: 200, path, name: row.original_name, size };
  }
  record(token) {
    this.db.prepare('UPDATE result_download_tokens SET downloads=downloads+1,last_download_at=? WHERE token=?').run(this.now(), token);
  }
}
