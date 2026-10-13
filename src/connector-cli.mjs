#!/usr/bin/env node
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { bridgeConnector, readConnectorConfig } from './connector.mjs';

// Forced SSH command ignores SSH_ORIGINAL_COMMAND, prompts, argv account names and client environment.
// This path is fixed in root-owned deployment code; each account can read ONLY its own root-owned credential.
const account = userInfo().username;
if (!/^[a-zA-Z0-9_.-]+$/.test(account)) throw new Error('Unsupported operating-system account id');
const path = join('/etc/collaboration-access/connectors', `${account}.json`);
try {
  const bridge = await bridgeConnector(readConnectorConfig(path), process.stdin, process.stdout);
  await new Promise(resolve => bridge.client.on('disconnected', resolve));
  bridge.close();
} catch (error) {
  console.error(`collaboration connector: ${error.message}`); process.exitCode = 1;
}
