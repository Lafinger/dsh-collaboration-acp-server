import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { connectAccess } from '../src/transport.mjs';
import { issueTicket } from '../src/authority.mjs';

test('standalone server launcher runs one real DSH process accepting two independent account connections', { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-cli-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\workbench-cli-${randomUUID()}` : join(root, 'service.sock');
  const accounts = { alice: 'a'.repeat(64), bob: 'b'.repeat(64) };
  const config = { serviceId: 'cli-fixture', workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), socketPath, accounts, fixture: true };
  const configPath = join(root, 'server.json'); writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', new URL('../scripts/official-loader.mjs', import.meta.url).href, fileURLToPath(new URL('../src/server-cli.mjs', import.meta.url)), configPath], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const exited = once(child, 'exit'); let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { stderr += s; });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolveReady, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error(`Early server exit ${code}: ${stderr}`)));
    lines.on('line', line => { try { const info = JSON.parse(line); if (info.ready) resolveReady(info); } catch { /* startup diagnostics */ } });
  });
  const peers = [];
  try {
    assert.equal(ready.runtimePid, child.pid);
    for (const account of ['alice', 'bob']) {
      const peer = await connectAccess(socketPath); peers.push(peer);
      await peer.request('workbench/connect', { ticket: issueTicket({ account, serviceId: config.serviceId, secret: accounts[account] }) });
      await peer.request('initialize', {});
      const identity = await peer.request('workbench/whoami', {});
      assert.equal(identity.runtimePid, child.pid); assert.equal(identity.account, account);
      const { sessionId } = await peer.request('session/new', {});
      const replies = []; peer.on('message', m => { if (m.params?.update?.sessionUpdate === 'agent_message_chunk') replies.push(m.params.update.content.text); });
      const result = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'whoami' }], _meta: { requestId: `whoami-${account}` } });
      assert.equal(result.stopReason, 'end_turn'); assert.equal(JSON.parse(replies.join('')).account, account);
    }
    console.log(JSON.stringify({ standaloneRuntimePid: child.pid, accounts: ['alice', 'bob'], independentConnections: 2, fixture: true }));
  } finally {
    for (const peer of peers) peer.close(); lines.close(); child.kill('SIGTERM');
    const [code, signal] = await exited;
    if (process.platform !== 'win32') assert.equal(code, 0, stderr);
    else assert.ok(code === 0 || signal === 'SIGTERM' || code === 1, 'Windows terminated managed child');
  }
});
