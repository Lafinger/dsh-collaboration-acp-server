import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { releaseNames, repository, fileSha256 } from './release-policy.mjs';
const directory = resolve(process.argv[2] ?? '.dsh/release');
const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const names = releaseNames(metadata.version);
const source = join(directory, 'dsh-collaboration-acp-server.tgz'), destination = join(directory, names.packageName);
// Rename only these two explicitly resolved package paths within the selected release directory.
if (existsSync(destination)) throw new Error('Refusing to overwrite release package');
if (source !== destination) renameSync(source, destination);
const hash = fileSha256(destination);
writeFileSync(join(directory, names.checksumName), `${hash}  ${names.packageName}\n`);
writeFileSync(join(directory, names.metadataName), JSON.stringify({ repository, version: metadata.version, tag: names.tag,
  commit: process.env.GITHUB_SHA ?? null, package: names.packageName, sha256: hash, dshVersion: metadata.engines.dsh,
  nodeVersion: process.version, packageManager: metadata.packageManager, registryPublication: false, marketPublication: false }, null, 2) + '\n');
console.log(JSON.stringify({ tag: names.tag, package: names.packageName, sha256: hash }));
