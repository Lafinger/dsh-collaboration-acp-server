import { readFileSync, statSync, chmodSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createWorkbenchRuntime } from './workbench-runtime.mjs';
import { AccountAuthority } from './authority.mjs';
import { AccessStore } from './store.mjs';
import { AccessService } from './service.mjs';
import { listenAccess } from './transport.mjs';

const file = process.argv[2];
if (!file || !isAbsolute(file)) throw new Error('Usage: node --import official-loader.mjs server-cli.mjs <absolute-server-config.json>');
if (process.platform !== 'win32') {
  const stat = statSync(file);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error('Server config must be service-account-owned with no group/other access');
}
const config = JSON.parse(readFileSync(file, 'utf8'));
if (!isAbsolute(config.socketPath ?? '')) throw new Error('Deployment-local absolute socketPath required');
if (process.platform !== 'win32') process.umask(0o077);
const authority = new AccountAuthority(config);
const { runtime, workspace, root } = await createWorkbenchRuntime(config);
const store = new AccessStore(join(root, 'access.sqlite'));
const service = new AccessService({ authority, store, runtime, cwd: workspace });
const listener = await listenAccess(service, { socketPath: config.socketPath });
// Linux deployment must pre-create socket's parent directory root/service-owned and apply an access group.
if (process.platform !== 'win32') chmodSync(config.socketPath, 0o660);
console.log(JSON.stringify({ ready: true, serviceId: config.serviceId, runtimePid: process.pid, fixture: config.fixture === true }));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  try { await listener.close(); store.close(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
