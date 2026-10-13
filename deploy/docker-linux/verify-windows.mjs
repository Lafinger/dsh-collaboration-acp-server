import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const clientRoot = process.env.DSH_COLLABORATION_CLIENT_ROOT;
if (!clientRoot) throw new Error('Explicitly set DSH_COLLABORATION_CLIENT_ROOT for local cross-project acceptance');
const { openSsh } = await import(pathToFileURL(join(clientRoot, 'src/ssh.mjs')));
const { initializeParams, requireInitializeResult } = await import(pathToFileURL(join(clientRoot, 'src/protocol.mjs')));
const directory = resolve('.dsh/docker-linux-sim'), action = process.argv[2] ?? 'protocol';
const load = (account, route = 'local') => JSON.parse(readFileSync(join(directory, `${account}-${route}.local.json`), 'utf8'));
const peers = [];
const connect = async (account, route = 'local', override = {}) => {
  const config = load(account, route); const peer = await openSsh({ ...config.ssh, ...override }); peers.push(peer);
  const initialized = await peer.request('initialize', initializeParams()); requireInitializeResult(initialized); assert.equal(initialized.agentInfo.version, '0.4.2');
  const who = await peer.request('collaboration/whoami', {}); assert.equal(who.account, account); assert.equal(who.serviceId, config.serviceId); return { peer, who };
};
const saved = join(directory, 'acceptance-sessions.local.json');
try {
  if (action === 'protocol') {
    const a = await connect('alice'), b = await connect('bob'); assert.equal(a.who.runtimePid, b.who.runtimePid);
    const as = await a.peer.request('session/new', {}), bs = await b.peer.request('session/new', {});
    assert.notEqual(as.sessionId, bs.sessionId);
    await assert.rejects(b.peer.request('collaboration/history', { sessionId: as.sessionId }), /not available/);
    await assert.rejects(b.peer.request('session/load', { sessionId: as.sessionId }), /not available/);
    await assert.rejects(a.peer.request('collaboration/connect', { ticket: { account: 'bob' } }), /cannot choose/i);
    writeFileSync(saved, JSON.stringify({ alice: as.sessionId, bob: bs.sessionId, previousPid: a.who.runtimePid }, null, 2));
    console.log(JSON.stringify({ protocol: 'PASS', members: ['alice', 'bob'], singleHost: true, crossMemberRestoreRejected: true, forgedIdentityRejected: true }));
  } else if (action === 'protocol-version') {
    const config = load('alice'); const peer = await openSsh(config.ssh); peers.push(peer);
    for(const params of [{protocolVersion:1},{protocolVersion:1,_meta:{collaborationProtocolVersion:1}},{protocolVersion:1,_meta:{collaborationProtocolVersion:3}}]) {
      await assert.rejects(peer.request('initialize',params),error=>error.code===-32011);
      await assert.rejects(peer.request('session/new',{}),/Initialize first/);
    }
    requireInitializeResult(await peer.request('initialize',initializeParams()));
    const oldNamespace=['work','bench'].join('');
    await assert.rejects(peer.request(`${oldNamespace}/whoami`,{}),error=>error.code===-32601);
    console.log('PASS: wrong/missing collaboration version and retired namespace rejected; no model requests');
  } else if (action === 'addresses') {
    for (const route of ['local', 'lan', 'zerotier']) { const { who } = await connect('alice', route); console.log(JSON.stringify({ route, host: load('alice', route).ssh.host, account: who.account, localMachinePath: 'PASS', externalDeviceTest: false })); }
  } else if (action === 'forced-command') {
    const { sshArguments } = await import(pathToFileURL(join(clientRoot, 'src/ssh.mjs')));
    const { JsonPeer } = await import(pathToFileURL(join(clientRoot, 'src/protocol.mjs')));
    const { spawn } = await import('node:child_process');
    const config = load('alice'); const args = sshArguments(config.ssh); args[args.length - 1] = 'id; cat /etc/passwd';
    const child = spawn(config.ssh.sshExecutable, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const peer = new JsonPeer(child.stdout, child.stdin); peers.push(peer); peer.on('disconnected', () => child.kill());
    await peer.request('initialize', initializeParams()); const who = await peer.request('collaboration/whoami', {}); assert.equal(who.account, 'alice');
    console.log('PASS: arbitrary SSH_ORIGINAL_COMMAND still enters authenticated connector, not shell');
  } else if (action === 'negative-key') {
    const config = load('bob'); const peer = await openSsh({ ...config.ssh, identityFile: load('alice').ssh.identityFile }); peers.push(peer);
    await assert.rejects(peer.request('initialize', initializeParams())); console.log('PASS: alice private key cannot authenticate as bob');
  } else if (action === 'model-create' || action === 'model-read' || action === 'model-restored') {
    const ids = JSON.parse(readFileSync(saved, 'utf8')); const account = action === 'model-create' ? 'alice' : 'bob'; const { peer } = await connect(account);
    await peer.request('session/load', { sessionId: ids[account] });
    const key = 'DOCKER-LINUX-SIM-TEST', text = action === 'model-create'
      ? `这是隔离验收。请只调用一次 project_create 创建测试项目，key为${key}，name为Docker Linux模拟服务器验收项目。不要调用其他写入工具，也不要创建计划。根据工具结果用中文简短报告项目key和id。`
      : `这是隔离验收。请调用 project_list，确认是否存在key为DOCKER-LINUX-SIM-TEST的测试项目。不要创建或修改任何内容，根据实际工具结果简短报告。`;
    let output = '';
    peer.on('message', m => { if (m.method === 'session/update' && m.params?.sessionId === ids[account] && m.params.update?.sessionUpdate === 'agent_message_chunk') output += m.params.update.content?.text ?? ''; });
    const id = `docker-acceptance-${action}`;
    const cancel = setTimeout(() => peer.notify('session/cancel', { sessionId: ids[account] }), 240000);
    let result; try { result = await peer.request('session/prompt', { sessionId: ids[account], prompt: [{ type: 'text', text }], _meta: { requestId: id } }, { timeoutMs: 250000 }); } finally { clearTimeout(cancel); }
    assert.equal(result.stopReason, 'end_turn'); assert.ok(output.trim());
    writeFileSync(join(directory, `${action}.local.json`), JSON.stringify({ account, sessionId: ids[account], requestId: id, result, output }, null, 2));
    console.log(JSON.stringify({ modelAcceptance: action, account, result, response: output }));
  } else if (action === 'restore') {
    const ids = JSON.parse(readFileSync(saved, 'utf8'));
    for (const account of ['alice', 'bob']) { const { peer, who } = await connect(account); const loaded = await peer.request('session/load', { sessionId: ids[account] }); assert.equal(loaded.sessionId, ids[account]); const history = await peer.request('collaboration/history', { sessionId: ids[account] }); assert.ok(history.events.length > 0); console.log(JSON.stringify({ account, sameSessionRestore: 'PASS', historyEvents: history.events.length, pid: who.runtimePid })); await peer.request('session/close', { sessionId: ids[account] }); peer.close(); }
    const { peer } = await connect('alice'); await peer.request('session/load', { sessionId: ids.alice });
    await assert.rejects(peer.request('session/prompt', { sessionId: ids.alice, prompt: [{ type: 'text', text: 'must not replay' }], _meta: { requestId: 'docker-acceptance-model-create' } }), /replay is forbidden/);
    console.log('PASS: persisted requestId refuses replay after host restart');
  } else throw new Error('Unknown verification action');
} finally { for (const peer of peers) peer.close(); }
