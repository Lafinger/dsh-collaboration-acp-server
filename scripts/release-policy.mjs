import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const repository = 'Lafinger/dsh-collaboration-acp-server';
export function releaseNames(version) {
  assert.match(version, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/, 'Version must be an exact release version');
  return { tag: `v${version}`, packageName: `dsh-collaboration-acp-server-${version}.tgz`, checksumName: 'SHA256SUMS', metadataName: 'release.json' };
}
export function verifyReleaseTag(metadata, tag, repo) {
  const names = releaseNames(metadata.version);
  assert.equal(metadata.name, 'dsh-collaboration-acp-server');
  assert.equal(metadata.private, true, 'GitHub-only distribution keeps npm publication disabled');
  assert.equal(metadata.repository.url, `git+https://github.com/${repository}.git`);
  assert.equal(repo, repository, 'Releases belong to the approved repository only');
  assert.equal(tag, names.tag, 'Git tag must match the package version');
  for (const name of ['prepare', 'preinstall', 'install', 'postinstall', 'prepack']) assert.equal(metadata.scripts?.[name], undefined, 'GitHub install must not need lifecycle builds');
  return names;
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const fileSha256 = path => sha256(readFileSync(path));
export function verifyAssetManifest(manifest, names, sha, version) {
  assert.equal(manifest.repository, repository);
  assert.equal(manifest.version, version);
  assert.equal(manifest.tag, names.tag);
  assert.equal(manifest.commit, sha);
  assert.equal(manifest.package, names.packageName);
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.registryPublication, false);
  assert.equal(manifest.marketPublication, false);
}
