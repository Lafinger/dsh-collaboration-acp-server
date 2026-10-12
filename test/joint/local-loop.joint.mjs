import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkbenchRuntime } from '../../src/workbench-runtime.mjs';
import { DshRuntime } from '../../src/dsh-runtime.mjs';
import { AccessStore } from '../../src/store.mjs';
import { AccountAuthority, issueTicket } from '../../src/authority.mjs';
import { AccessService } from '../../src/service.mjs';
import { listenAccess, connectAccess } from '../../src/transport.mjs';
const clientRoot = process.env.DSH_COLLABORATION_CLIENT_ROOT;
if (!clientRoot) throw new Error('Joint test requires DSH_COLLABORATION_CLIENT_ROOT');
const { MemberClient } = await import(pathToFileURL(resolve(clientRoot, 'src/member-client.mjs')).href);
const { MemberAdapter } = await import(pathToFileURL(resolve(clientRoot, 'src/member-plugin.mjs')).href);
test('actual local DSH loop uses independent client adapter and remote DSH loop, no auxiliary business turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'collab-two-loops-'));
  const { runtime, workspace } = await createWorkbenchRuntime({ workspace: join(root, 'workspace'), stateRoot: join(root, 'state'), fixture: true });
  const store = new AccessStore(join(root, 'access.sqlite'));
  const secret = 'a'.repeat(64);
  const service = new AccessService({ runtime, store, cwd: workspace, authority: new AccountAuthority({ serviceId: 'loop-joint', accounts: { alice: secret } }) });
  const listener = await listenAccess(service);
  const client = new MemberClient({ databasePath: join(root, 'client.sqlite'), serviceId: 'loop-joint', account: 'alice', connect: async () => {
    const peer = await connectAccess(listener.address);
    await peer.request('workbench/connect', { ticket: issueTicket({ serviceId: 'loop-joint', account: 'alice', secret }) });
    return peer;
  } });
  const adapter = new MemberAdapter(client);
  const local = await new DshRuntime({ provider: 'workbench-remote', model: 'server-agent', adapter, persistenceRoot: join(root, 'local-sessions') }).start();
  try {
    const handle = await local.open({ id: 'local-loop', owner: 'local-entry', cwd: root, resume: false });
    for (const text of ['first', 'second']) {
      let response = '';
      await local.prompt(handle, text, new AbortController().signal, update => { response += update.content.text; });
      assert.equal(response, `fixture:${text}`);
    }
    const remote = client.mapping('local-loop').remote_id;
    const inputs = () => store.events(remote).filter(event => event.update.sessionUpdate === 'user_message_chunk').map(event => event.update.content.text);
    assert.deepEqual(inputs(), ['first', 'second']);
    const message = { id: 'auxiliary', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second' }] };
    const chunks = [];
    for await (const chunk of adapter.stream({ provider: 'workbench-remote', model: 'server-agent', sessionId: 'local-loop', messages: [message], purpose: 'compact' })) chunks.push(chunk);
    assert.equal(chunks.at(-1).reason.kind, 'error');
    assert.deepEqual(inputs(), ['first', 'second']);
  } finally { await local.closeAll(); client.close(); await listener.close(); store.close(); }
});
