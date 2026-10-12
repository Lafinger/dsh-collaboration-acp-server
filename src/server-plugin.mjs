import { symbols } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { chmodSync, lstatSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveServerConfiguration } from './configuration.mjs';
import { AccountAuthority } from './authority.mjs';
import { AccessStore } from './store.mjs';
import { AccessService } from './service.mjs';
import { listenAccess } from './transport.mjs';
import { createWorkbenchRuntime } from './workbench-runtime.mjs';
import { join } from 'node:path';

export const name = 'collaboration-acp-server';
export const inject = []; // Empty configuration can mount without host services; configured activation injects them below.
export const Config = z.object({ configFile: z.string().description('私有服务端JSON配置文件的绝对路径；默认用户.dsh/collaboration-acp-server.json。') });
const instances = new WeakMap();
const canonical = v => v?.[symbols.original] ?? v;
function validateSocket(config) {
  if (process.platform === 'win32') return;
  const parent = lstatSync(dirname(config.socketPath));
  if (!parent.isDirectory() || parent.isSymbolicLink() || ![0, process.getuid()].includes(parent.uid) || (parent.mode & 0o022)) throw new Error('Socket parent must be service/root-owned and not group/other writable');
  if (existsSync(config.socketPath)) throw new Error('Socket path already exists; refuse to replace it');
}

export async function apply(ctx, input = {}) {
  if (ctx.get('workbenchServerStatus')) throw new Error('Only one collaboration service may run in this DSH profile');
  const resolved = resolveServerConfiguration(input);
  let state = Object.freeze({ state: resolved.state, configPath: resolved.configPath, message: resolved.message });
  const status = Object.freeze({ get state() { return state.state; }, get configPath() { return state.configPath; }, get message() { return state.message; } });
  ctx.provide('workbenchServerStatus', status);
  const pending = message => { state = Object.freeze({ state: 'configuration-required', configPath: resolved.configPath, message }); ctx.logger?.warn?.(message); };
  if (resolved.state !== 'configured') { pending(resolved.message); return; }
  for (const key of ['agents', 'llm', 'sessions', 'tools', 'sessionPersistence']) {
    if (!ctx.get(key)) { pending(`协作服务端待配置：宿主缺少${key}；未启动服务。`); return; }
  }
  await ctx.effect(async function* () {
    let ownerCtx;
    const owner = ctx.inject(['agents', 'llm', 'sessions', 'tools', 'sessionPersistence'], activeCtx => { ownerCtx = activeCtx; });
    yield owner.dispose; // Exact parent effect disposer; disposed AFTER the service stop below.
    await owner.await();
    if (!ownerCtx) throw new Error('Host DSH services became unavailable during startup');
    const stop = await activate(ownerCtx, resolved, value => { state = Object.freeze(value); }, pending);
    if (stop) yield stop; // Close connections/drain Agents/SQLite before factory-owned effects.
  }, 'collaboration-acp-server.ordered-lifecycle');
}

async function activate(ctx, resolved, setState, pending) {
  let state = { state: 'configured', configPath: resolved.configPath };
  if (!ctx.llm.listProviders().some(p => p.id === resolved.config.provider)) { pending('协作服务端待配置：指定宿主provider未注册；未启动服务。'); return; }
  try { ctx.agents.requireFactory(); }
  catch { pending('协作服务端待配置：宿主Agent loop尚未提供factory；未启动服务。'); return; }
  const owner = canonical(ctx.agents);
  if (instances.has(owner)) throw new Error('Only one collaboration service may run in this DSH profile');
  validateSocket(resolved.config);
  const lease = {}; instances.set(owner, lease);
  let runtime, store, listener, service, stopTask;
  const stop = () => stopTask ??= (async () => {
    state = { ...state, state: 'stopping' }; setState(state);
    try { if (listener) await listener.close(); else if (service) await service.close(); else await runtime?.closeAll(); }
    finally { store?.close(); if (instances.get(owner) === lease) instances.delete(owner); state = { ...state, state: 'stopped' }; setState(state); }
  })();
  try {
    const config = resolved.config, authority = new AccountAuthority(config);
    mkdirSync(config.stateRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      const stat = lstatSync(config.stateRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Private plugin stateRoot must be service-owned mode0700');
    }
    const workbench = await createWorkbenchRuntime(config, ctx); runtime = workbench.runtime;
    store = new AccessStore(join(workbench.root, 'access.sqlite'));
    service = new AccessService({ authority, store, runtime, cwd: workbench.workspace });
    listener = await listenAccess(service, { socketPath: config.socketPath });
    if (process.platform !== 'win32') chmodSync(config.socketPath, 0o660);
    ctx.provide('workbenchServer', Object.freeze({ service, address: listener.address, serviceId: config.serviceId, stop }));
    state = { state: 'running', configPath: resolved.configPath, message: '协作服务端已启用；模型与会话使用宿主DSH。' }; setState(state);
    ctx.logger?.info?.(state.message);
    return stop;
  } catch (error) { await stop(); throw error; }
}
