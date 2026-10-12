import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseNames, verifyReleaseTag, verifyAssetManifest, sha256, repository } from '../scripts/release-policy.mjs';
const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
test('release accepts exact version tag and refuses wrong version/repository/npm-enabled manifests', () => {
  const names = releaseNames(metadata.version);
  assert.deepEqual(verifyReleaseTag(metadata, names.tag, repository), names);
  assert.throws(() => verifyReleaseTag(metadata, 'v99.0.0', repository), /match/);
  assert.throws(() => verifyReleaseTag(metadata, names.tag, 'other/repo'), /approved/);
  assert.throws(() => verifyReleaseTag({ ...metadata, private: false }, names.tag, repository), /npm/);
  assert.throws(() => verifyReleaseTag({ ...metadata, scripts: { ...metadata.scripts, prepare: 'build' } }, names.tag, repository), /lifecycle/);
});
test('release identities reject malformed versions and preserve prerelease labels', () => {
  assert.equal(releaseNames('0.2.0-rc.1').tag, 'v0.2.0-rc.1');
  for (const value of ['v0.1.2', '0.1', '../0.1.2', '00.1.2', '1.2.3;echo']) assert.throws(() => releaseNames(value));
});
test('verified asset manifest ties one package hash to version, commit and GitHub-only scope', () => {
  const names = releaseNames(metadata.version), commit = 'a'.repeat(40);
  const manifest = { repository, version: metadata.version, tag: names.tag, commit, package: names.packageName, sha256: sha256(Buffer.from('fixture')),
    registryPublication: false, marketPublication: false };
  verifyAssetManifest(manifest, names, commit, metadata.version);
  for (const change of [{ commit: 'b'.repeat(40) }, { package: 'wrong.tgz' }, { sha256: 'invalid' }, { registryPublication: true }, { marketPublication: true }]) assert.throws(() => verifyAssetManifest({ ...manifest, ...change }, names, commit, metadata.version));
});
test('GitHub workflow separates unprivileged build from tag-only contents-write release, no registry publish', () => {
  const source = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  assert.match(source, /ubuntu-latest, windows-latest/);
  assert.match(source, /--frozen-lockfile --ignore-scripts/);
  assert.match(source, /needs: package/);
  assert.match(source, /startsWith\(github.ref, 'refs\/tags\/v'\)/);
  assert.match(source, /contents: read/); assert.match(source, /contents: write/);
  assert.ok(!/npm publish|pnpm publish|NPM_TOKEN|id-token: write|pull_request_target/.test(source));
  assert.equal(metadata.private, true);
});
