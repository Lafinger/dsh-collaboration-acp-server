import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { releaseNames, verifyReleaseTag, verifyAssetManifest, sha256, repository } from './release-policy.mjs';

const directory = resolve(process.argv[2] ?? '.dsh/release');
const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const names = verifyReleaseTag(metadata, process.env.GITHUB_REF_NAME, process.env.GITHUB_REPOSITORY);
const manifest = JSON.parse(readFileSync(join(directory, names.metadataName), 'utf8'));
verifyAssetManifest(manifest, names, process.env.GITHUB_SHA, metadata.version);
const packageBytes = readFileSync(join(directory, names.packageName));
assert.equal(sha256(packageBytes), manifest.sha256, 'Downloaded build artifact checksum differs');
assert.equal(readFileSync(join(directory, names.checksumName), 'utf8'), `${manifest.sha256}  ${names.packageName}\n`);
if (!process.env.GH_TOKEN) throw new Error('GitHub Actions token missing');
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(60000) });
  if (options.allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub release API failed (${response.status}) for ${options.method ?? 'GET'} ${path}`);
  return response.status === 204 ? null : response.json();
}
let release = await api(`/releases/tags/${encodeURIComponent(names.tag)}`, { allowMissing: true });
if (!release) {
  release = await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: names.tag, target_commitish: process.env.GITHUB_SHA,
    name: `${metadata.name} ${metadata.version}`, draft: true, prerelease: metadata.version.includes('-'), generate_release_notes: true,
    body: `GitHub-only plugin distribution. No npm or plugin-market publication.\n\nDSH ${metadata.engines.dsh}, Node >=24.\n\nInstall fixed version: \`github:${repository}#${names.tag}\`.\nDefault-branch install: \`github:${repository}\` (not necessarily latest Release).\n\nConfiguration is required before connecting; installation is not SSH/GUI/business acceptance.` }), headers: { 'Content-Type': 'application/json' } });
}
const assets = await api(`/releases/${release.id}/assets`);
const files = [names.packageName, names.checksumName, names.metadataName];
for (const name of files) {
  const bytes = readFileSync(join(directory, name));
  const existing = assets.find(asset => asset.name === name);
  if (existing) {
    // Public download: the normal browser endpoint requires no credential; never forward the Actions token to a redirect.
    const url = new URL(existing.browser_download_url);
    assert.equal(url.origin, 'https://github.com');
    assert.ok(url.pathname.startsWith(`/${repository}/releases/download/`));
    let response;
    if (release.draft) {
      // Draft asset API keeps auth on api.github.com only; redirect targets receive no custom Authorization header.
      response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${existing.id}`, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'manual', signal: AbortSignal.timeout(60000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = new URL(response.headers.get('location')); assert.equal(target.protocol, 'https:');
        response = await fetch(target, { signal: AbortSignal.timeout(60000) });
      }
    } else response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Cannot verify existing release asset ${name} (${response.status})`);
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(bytes), `Existing ${name} differs: publish a new version, do not overwrite`);
  } else {
    assert.equal(release.draft, true, 'Published release is incomplete: refuse mutation; review or use a new version');
    const upload = `https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
    const response = await fetch(upload, { method: 'POST', headers: { ...headers, 'Content-Type': name.endsWith('.tgz') ? 'application/gzip' : 'application/octet-stream' }, body: bytes, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Asset upload failed (${response.status}); draft retained for diagnosis`);
  }
}
if (release.draft) release = await api(`/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, make_latest: metadata.version.includes('-') ? 'false' : 'true' }) });
console.log(`PASS: GitHub Release ${release.html_url}; existing assets were never overwritten`);
