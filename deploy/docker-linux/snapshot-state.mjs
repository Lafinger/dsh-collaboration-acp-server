// Compare opaque identity of persistent resources. Print only PASS/fact counters, never hashes of secrets.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const snapshot='/srv/collaboration/private-state/restore-snapshot.json';
const files=['/srv/collaboration/ssh/ssh_host_ed25519_key.pub','/srv/collaboration/dsh-home/.credentials.yaml','/srv/collaboration/dsh-home/collaboration-acp-server.json'];
const value=()=>files.map(path=>createHash('sha256').update(readFileSync(path)).digest('hex'));
if(process.argv[2]==='save') { writeFileSync(`${snapshot}.tmp`,JSON.stringify(value()),{mode:0o600});renameSync(`${snapshot}.tmp`,snapshot);console.log('Persistent identity snapshot saved privately'); }
else if(process.argv[2]==='compare'){assert.deepEqual(value(),JSON.parse(readFileSync(snapshot,'utf8')));console.log('PASS: SSH host identity, Codego key and member credentials unchanged after recreation');}
else throw new Error('Choose save or compare');
