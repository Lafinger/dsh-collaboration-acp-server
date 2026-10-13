import { userInfo } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { issueTicket } from './authority.mjs';
import { connectAccess } from './transport.mjs';
import { AccessError, JsonPeer, collaborationMeta, requireCollaborationVersion } from './protocol.mjs';

/** This config is administrator-provisioned on the SERVER, owned by the account and not writable by it. */
export function readConnectorConfig(path, { username = userInfo().username, platform = process.platform, gid = process.getgid?.() } = {}) {
  const stat = statSync(path);
  if (platform === 'win32') throw new Error('Production connector credential ACL validation is Linux-only in this prototype');
  if (stat.uid !== 0 || stat.gid !== gid || (stat.mode & 0o777) !== 0o440) {
    throw new Error('Connector credential must be root-owned, account-group-readable and mode 0440');
  }
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.account !== username) throw new Error('Connector credential does not match the authenticated operating-system account');
  if (typeof config.socketPath !== 'string') throw new Error('Connector requires a deployment-local socket path');
  return config;
}
/** stdio carries ordinary ACP only. Client-controlled collaboration/connect is deliberately not forwarded. */
export async function bridgeConnector(config, input, output) {
  const remote = await connectAccess(config.socketPath ?? config.endpoint);
  let identity;
  try {
    identity = await remote.request('collaboration/connect', { ticket: issueTicket(config), _meta: collaborationMeta() });
    requireCollaborationVersion(identity);
  }
  catch (error) { remote.close(); throw error; }
  const client = new JsonPeer(input, output);
  remote.on('message', m => {
    if (m.id !== undefined) {
      if (m.method !== 'collaboration/attachment/read') { remote.error(m.id, new AccessError(-32601, 'Client filesystem, terminal and reverse methods are unsupported')); return; }
      void client.request(m.method, m.params, { timeoutMs: 30000 })
        .then(result => remote.result(m.id, result), error => remote.error(m.id, error)).catch(() => remote.close());
    } else client.notify(m.method, m.params);
  });
  client.on('message', m => {
    if (m.method === 'collaboration/connect') { client.error(m.id, new AccessError(-32003, 'Client cannot choose its identity')); return; }
    if (m.id === undefined) { try { remote.notify(m.method, m.params); } catch { client.close(); } return; }
    void remote.request(m.method, m.params, { timeoutMs: m.method === 'session/prompt' ? 0 : 30000 })
      .then(result => client.result(m.id, result), error => client.error(m.id, error)).catch(() => client.close());
  });
  client.on('disconnected', () => remote.close()); remote.on('disconnected', () => client.close());
  return { identity, remote, client, close() { client.close(); remote.close(); } };
}
