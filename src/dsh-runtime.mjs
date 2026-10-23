import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {deriveHumanPolicy,allowsHumanTool} from './human-authorization.mjs';

/** Borrow host services; this owner never constructs or disposes the host runtime. */
export class DshRuntime {
  constructor({ ctx, provider, model, setup }) {
    if (!ctx) throw new Error('Host DSH context required');
    this.ctx = ctx; this.provider = provider; this.model = model; this.setup = setup;
    this.handles = new Set(); this.opening = new Set(); this.closing = false;
    this.abort = new AbortController();this.humanRequests=new Map();
  }
  async start() {
    for (const key of ['agents', 'llm', 'sessions', 'tools', 'sessionPersistence']) {
      if (!this.ctx.get(key)) throw new Error(`Host DSH service required: ${key}`);
    }
    if (!this.ctx.llm.listProviders().some(p => p.id === this.provider)) throw new Error('Configured host model provider is not registered');
    this.ctx.agents.requireFactory();
    return this;
  }
  async open(input) {
    if (this.closing) throw new Error('Collaboration runtime is closing');
    const task = this.activate(input); this.opening.add(task);
    try { return await task; } finally { this.opening.delete(task); }
  }
  async activate({ id, owner, cwd, resume, principal }) {
    const selection = { provider: this.provider, model: this.model };
    const setup = async (agentCtx, agent) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
      agentCtx.isolate('collaborationAuthenticatedAccount').provide('collaborationAuthenticatedAccount', owner);
      // Never inherit host/ancestor filesystem, terminal, MCP, delegation or future global tools.
      agentCtx.tools.restrict({ allow: [] });
      agentCtx.tools.presentAs('native');
      await this.setup?.(agentCtx, agent, owner,principal);
      // Host publication presets can add scope-local tools later: guard stays monotonic.
      const allowed = new Map(agentCtx.tools.view(agent).visible);
      const humanAllowed=name=>principal?.channel&&principal.channel!=='dsh'?true:typeof this.attachments?.allows==='function'?this.attachments.allows(String(agent.session.id),owner,name):allowsHumanTool(this.humanRequests.get(String(agent.session.id)),name);
      agentCtx.tools.guard(exec=>humanAllowed(exec.name)?undefined:'当前人类消息未授权此操作；草稿不能登记业务，模型不能代本人确认。');
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        return { ...assembly, tools: assembly.tools.filter(tool => humanAllowed(tool.name)&&allowed.has(tool.name) && allowed.get(tool.name) === agentCtx.tools.get(tool.name, agent)) };
      });
      agentCtx.tools.guard(exec => allowed.has(exec.name) && allowed.get(exec.name) === agentCtx.tools.get(exec.name, agent) ? undefined : 'Only authenticated collaboration business tools are allowed');
      // A restored durable inbox must not implicitly execute an old business instruction.
      if (resume) agent.inbox.clear(); // Do not abort the host factory's pre-publication maintenance signal.
    };
    const options = { agentOptions: selection, setup, signal: this.abort.signal };
    const handle = resume
      ? await this.ctx.agents.resume({ ...options, resumeSessionId: SessionId(id) })
      : await this.ctx.agents.create({ ...options, sessionId: SessionId(id), meta: { cwd } });
    this.handles.add(handle);
    handle.collaborationOwner=owner;handle.collaborationPrincipal=principal;
    try {
      if (this.closing) throw new Error('Collaboration runtime closed during activation');
      await this.ctx.sessions.flush(handle.agent.session); return handle;
    } catch (error) { await handle.dispose(); this.handles.delete(handle); throw error; }
  }
  async prompt(handle, text, signal, emit, attachmentRequest) {
    if (this.closing || !this.handles.has(handle)) throw new Error('Inactive collaboration Agent');
    const agent = handle.agent;
    const key=String(agent.session.id);if(this.humanRequests.has(key))throw new Error('A human turn is already active for this Agent');
    this.humanRequests.set(key,attachmentRequest??{policy:deriveHumanPolicy(text)});
    let releaseAttachments=()=>{};
    try{if(attachmentRequest&&this.attachments)releaseAttachments=this.attachments.bind(attachmentRequest,signal);else if(attachmentRequest?.manifests?.length||attachmentRequest?.receiptScopes?.length)throw new Error('Attachment service unavailable for this runtime');}catch(error){this.humanRequests.delete(key);throw error;}
    let releaseVision=()=>{};
    try{releaseVision=this.vision?.begin(agent.session.id,handle.collaborationOwner,handle.collaborationPrincipal,text)??releaseVision;}catch(error){releaseAttachments();this.humanRequests.delete(key);throw error;}
    let reason = 'end_turn', failure,finalText=null;
    const offStream = agent.ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== agent || frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (chunk.type === 'text-delta') emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } });
      if (chunk.type === 'reasoning-delta') emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } });
    });
    const offEnd = agent.ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return;
      if(event.type==='assistant/message'){
        const content=event.data.message?.content??[];
        finalText=event.data.interrupted||content.some(c=>c.type==='tool-call')?null:content.filter(c=>c.type==='text').map(c=>c.text).join('');
      }
      if(event.type!=='turn/end')return;
      if (event.data.reason?.kind === 'aborted') reason = 'cancelled';
      if (event.data.reason?.kind === 'max-tokens') reason = 'max_tokens';
      if (event.data.reason?.kind === 'blocked') failure = new Error('DSH turn blocked');
      if (event.data.reason?.kind === 'error') failure = event.data.reason.error;
    });
    const offError = agent.ctx.on('agent/error', ({ agent: subject, error }) => { if (!subject || subject === agent) failure = error; });
    const abort = () => agent.cancel({ kind: 'user' });
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) return { stopReason: 'cancelled' };
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' }, ...(attachmentRequest?.messageId?{id:attachmentRequest.messageId}:{}) }));
      await agent.whenIdle(); await this.ctx.sessions.flush(agent.session);
      if (failure && !signal.aborted) throw failure instanceof Error ? failure : new Error(failure.message ?? 'DSH turn failed');
      return { stopReason: signal.aborted ? 'cancelled' : reason,finalText:!signal.aborted&&reason==='end_turn'?finalText:null };
    } finally { releaseVision();releaseAttachments();this.humanRequests.delete(key); signal.removeEventListener('abort', abort); offStream(); offEnd(); offError(); }
  }
  async persistedImLog(handle){
    const artifact=await this.persistedImLogById(handle.agent.session.id,handle.agent.session.header.cwd);if(!artifact)throw new Error('Materialized IM session header unavailable');return artifact;
  }
  async persistedImLogById(id,cwd){
    const p=this.ctx.sessionPersistence;
    if(p.name!=='session-persistence-jsonl'||typeof p.resolveCurrentLog!=='function'||typeof p.config?.root!=='string')throw new Error('IM retention requires pinned rc.2 JSONL persistence');
    const snapshot=await p.stat(id),path=await p.resolveCurrentLog(id);
    if(!snapshot&&!path)return null;
    if(!snapshot||snapshot.header.id!==id||snapshot.header.cwd!==cwd||!path)throw new Error('Materialized IM session header unavailable');
    return {root:p.config.root,path,header:snapshot.header};
  }
  async close(handle) {
    if (!this.handles.has(handle)) return;
    handle.agent.cancel({ kind: 'user' });
    try { await handle.agent.whenIdle(); await this.ctx.sessions.flush(handle.agent.session); }
    finally { await handle.dispose(); this.handles.delete(handle); }
  }
  closeAll() {
    return this.closeTask ??= (async () => {
      this.closing = true; this.abort.abort(new Error('Collaboration plugin stopping'));
      for (const handle of this.handles) handle.agent.cancel({ kind: 'user' });
      await Promise.allSettled([...this.opening]);
      const results = await Promise.allSettled([...this.handles].map(h => this.close(h)));
      const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Collaboration Agent cleanup failed');
    })();
  }
}
