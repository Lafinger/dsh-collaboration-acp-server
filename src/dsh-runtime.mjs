import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry, installModelSelection } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm';
import persistencePlugin from '@deepseek-ai/dsh-session-persistence-jsonl';

/** Actual official DSH services, mounted once. Tests supply deterministic adapters, not a remote model. */
export class DshRuntime {
  constructor({ provider, model, adapter, persistenceRoot, setup }) {
    this.ctx = new Context(); this.provider = provider; this.model = model; this.setup = setup;
    this.handles = new Set();
    const ctx = this.ctx;
    ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '', personaSuffix: '' });
    ctx.plugin(LlmRuntime);
    ctx.plugin(SessionStore);
    ctx.plugin(AgentRegistry);
    ctx.plugin(SessionProjectionRegistry);
    ctx.plugin(ToolRuntime, { mode: 'native' });
    ctx.plugin(persistencePlugin, { root: persistenceRoot, compression: 'none' });
    ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    this.adapter = adapter;
  }
  async start() {
    // Cordis 4 mounts fibers immediately; await their lifecycle, not a removed Context.start().
    await Promise.all([...this.ctx.registry.values()].flatMap(runtime => [...runtime.fibers]).map(fiber => fiber.await()));
    this.unregisterAdapter = this.ctx.llm.registerAdapter([this.provider], this.adapter);
    return this;
  }
  async open({ id, owner, cwd, resume }) {
    const selection = { provider: this.provider, model: this.model };
    const setup = async (agentCtx, agent) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      // identity is captured from authenticated server metadata, never a model argument.
      // Store identity as scoped service only after explicit isolation; otherwise Cordis shares the service slot.
      agentCtx.isolate('workbenchAuthenticatedAccount').provide('workbenchAuthenticatedAccount', owner);
      await this.setup?.(agentCtx, agent, owner);
    };
    const handle = resume
      ? await this.ctx.agents.resume({ resumeSessionId: SessionId(id), agentOptions: selection, setup })
      : await this.ctx.agents.create({ sessionId: SessionId(id), meta: { cwd }, agentOptions: selection, setup });
    this.handles.add(handle);
    try { await this.ctx.sessions.flush(handle.agent.session); return handle; }
    catch (error) { await handle.dispose(); this.handles.delete(handle); throw error; }
  }
  async prompt(handle, text, signal, emit) {
    const agent = handle.agent;
    let reason = 'end_turn'; let failure;
    const offStream = agent.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent || frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (chunk.type === 'text-delta') emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } });
      if (chunk.type === 'reasoning-delta') emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } });
    });
    const offEnd = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return;
      if (event.type === 'turn/end') {
        if (event.data.reason?.kind === 'aborted') reason = 'cancelled';
        if (event.data.reason?.kind === 'max-tokens') reason = 'max_tokens';
        if (event.data.reason?.kind === 'blocked') failure = new Error('DSH turn blocked');
        if (event.data.reason?.kind === 'error') failure = event.data.reason.error;
      }
    });
    const offError = agent.ctx.on('agent/error', ({ error }) => { failure = error; });
    const abort = () => agent.cancel({ kind: 'user' });
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) return { stopReason: 'cancelled' };
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
      await agent.whenIdle();
      await this.ctx.sessions.flush(agent.session);
      if (failure && !signal.aborted) throw failure instanceof Error ? failure : new Error(failure.message ?? 'DSH turn failed');
      return { stopReason: signal.aborted ? 'cancelled' : reason };
    } finally { signal.removeEventListener('abort', abort); offStream(); offEnd(); offError(); }
  }
  async close(handle) {
    handle.agent.cancel({ kind: 'user' });
    await handle.agent.whenIdle(); await this.ctx.sessions.flush(handle.agent.session);
    await handle.dispose(); this.handles.delete(handle);
  }
  async closeAll() {
    await Promise.all([...this.handles].map(h => this.close(h)));
    this.unregisterAdapter?.(); await this.ctx.fiber.dispose();
  }
}
