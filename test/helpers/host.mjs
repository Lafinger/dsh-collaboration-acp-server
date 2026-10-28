// Test-only host: production plugin never constructs Context/LLM/Agent services.
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import persistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl';
import { FixtureModel } from '../../src/fixture-model.mjs';
import { DshRuntime } from '../../src/dsh-runtime.mjs';
import { createCollaborationRuntime } from '../../src/collaboration-runtime.mjs';
import { join } from 'node:path';
export async function createHost({ root, adapter = new FixtureModel(), provider = 'fixture', model = 'fixture', toolsMode = 'native' }) {
  const ctx = new Context();
  ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' });
  ctx.plugin(LlmRuntime); ctx.plugin(SessionStore); ctx.plugin(AgentRegistry); ctx.plugin(SessionProjectionRegistry);
  ctx.plugin(ToolRuntime, { mode: toolsMode }); ctx.plugin(persistencePlugin, { root: join(root, 'sessions'), compression: 'none' });
  ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  await Promise.all([...ctx.registry.values()].flatMap(r => [...r.fibers]).map(f => f.await()));
  ctx.llm.registerAdapter([provider], adapter);
  return { ctx, adapter, provider, model, close: () => ctx.fiber.dispose() };
}
export async function createTestRuntime(options) {
  const host = await createHost({ root: options.persistenceRoot, adapter: options.adapter, provider: options.provider, model: options.model });
  const runtime = await new DshRuntime({ ...options, ctx: host.ctx }).start();
  const close = runtime.closeAll.bind(runtime); runtime.closeAll = async () => { try { await close(); } finally { await host.close(); } };
  return runtime;
}
export async function createTestCollaboration(config) {
  // Scenarios advance synthetic time by the organization re-verification window, so pin that window
  // here instead of inheriting the shipped default. Only the mechanism is under test, not the default.
  const pinned = config.dingtalk && config.dingtalk.organizationTtlMs === undefined
    ? { ...config, dingtalk: { ...config.dingtalk, organizationTtlMs: 300000 } }
    : config;
  const host = await createHost({ root: join(pinned.stateRoot, 'host'), adapter: pinned.adapter });
  const collaboration = await createCollaborationRuntime({ ...pinned, provider: host.provider, model: host.model }, host.ctx);
  const close = collaboration.runtime.closeAll.bind(collaboration.runtime);
  collaboration.runtime.closeAll = async () => { try { await close(); } finally { await host.close(); } };
  return { ...collaboration, host };
}
