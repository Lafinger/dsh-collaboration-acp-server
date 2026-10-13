// Run as the named member with docker exec --user UID:GID. No secret contents printed.
import assert from 'node:assert/strict';
import { accessSync, constants } from 'node:fs';
const account=process.argv[2];if(!['alice','bob'].includes(account))throw new Error('Specify member');
const deniedRead=[
 '/srv/collaboration/dsh-home/.credentials.yaml',
 '/srv/collaboration/dsh-home/collaboration-acp-server.json',
 '/srv/collaboration/private-state/collaboration.sqlite',
 `/etc/collaboration-access/connectors/${account==='alice'?'bob':'alice'}.json`
];
for(const path of deniedRead)assert.throws(()=>accessSync(path,constants.R_OK),undefined,path);
accessSync(`/etc/collaboration-access/connectors/${account}.json`,constants.R_OK);
for(const path of [`/etc/collaboration-access/connectors/${account}.json`,'/opt/collaboration/entrypoint.sh','/opt/collaboration/node_modules/dsh-collaboration-acp-server/src/connector-cli.mjs','/etc/ssh/sshd_config'])assert.throws(()=>accessSync(path,constants.W_OK),undefined,path);
console.log(JSON.stringify({account,privateFilesUnreadable:'PASS',ownConnectorReadableOnly:true,programAndSSHConfigNotWritable:true}));
