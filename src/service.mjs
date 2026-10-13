import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
import { AccessError, requireText, textPrompt, ACP_PROTOCOL_VERSION, collaborationMeta, requireCollaborationVersion } from './protocol.mjs';

export class AccessService {
  constructor({ authority, store, runtime, cwd }) {
    this.authority = authority; this.store = store; this.runtime = runtime; this.cwd = resolve(cwd);
    this.connections = new Set(); this.sessions = new Map(); this.closing = false;
  }
  attach(peer) {
    const connection = { peer, identity: null, initialized: false, closed: false, id: randomUUID() };
    connection.authTimer = setTimeout(() => peer.close(), 10000);
    connection.authTimer.unref?.();
    this.connections.add(connection);
    peer.on('message', message => {
      void this.dispatch(connection, message.method, message.params ?? {}).then(
        result => peer.result(message.id, result), error => peer.error(message.id, error),
      ).catch(() => peer.close());
    });
    peer.on('disconnected', () => { void this.disconnect(connection); });
    return connection;
  }
  requireIdentity(c) {
    if (c.closed || this.closing) throw new AccessError(-32001, 'Connection closed');
    if (!c.identity) throw new AccessError(-32003, 'Authenticated connector required');
    return c.identity;
  }
  requireSession(c, id) {
    this.store.requireOwner(id, this.requireIdentity(c).account);
    const entry = this.sessions.get(id);
    if (!entry || entry.connection !== c) throw new AccessError(-32006, 'Restore this session before using it');
    return entry;
  }
  async dispatch(c, method, p) {
    if (method === 'collaboration/connect') {
      if (c.closed || c.identity || this.closing) throw new AccessError(-32003, 'Connection already bound or closed');
      requireCollaborationVersion(p);
      c.identity = this.authority.verify(p.ticket); clearTimeout(c.authTimer);
      return { ...c.identity, connectionId: c.id, runtimePid: process.pid, _meta: collaborationMeta() };
    }
    const identity = this.requireIdentity(c);
    if (method === 'initialize') {
      c.initialized = false;
      requireCollaborationVersion(p);
      if (p.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AccessError(-32011, 'Unsupported ACP-shaped base protocol version');
      c.initialized = true;
      return { protocolVersion: ACP_PROTOCOL_VERSION, _meta: collaborationMeta(), agentInfo: { name: 'dsh-collaboration-acp-server', version },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {} }, promptCapabilities: { image: false } }, authMethods: [] };
    }
    if (!c.initialized) throw new AccessError(-32600, 'Initialize first');
    if (method === 'collaboration/whoami') return { ...identity, runtimePid: process.pid };
    if (method === 'session/new') {
      const id = randomUUID(); this.store.create(id, identity.account);
      return this.open(c, id, false);
    }
    if (method === 'session/load' || method === 'session/resume') {
      requireText(p.sessionId, 'sessionId', 200); this.store.requireOwner(p.sessionId, identity.account);
      const prior = this.sessions.get(p.sessionId);
      if (prior?.connection) throw new AccessError(-32007, 'Session already attached; shared editing is not supported');
      if (prior?.drain) await prior.drain;
      if (prior && !prior.handle) throw new AccessError(-32007, 'Session activation is draining; try restoring later');
      this.requireIdentity(c);
      return this.open(c, p.sessionId, true);
    }
    if (method === 'session/list') return { sessions: this.store.list(identity.account), nextCursor: null };
    if (method === 'collaboration/history') {
      this.store.requireOwner(p.sessionId, identity.account);
      if (p.after !== undefined && (!Number.isSafeInteger(p.after) || p.after < 0)) throw new AccessError(-32602, 'Invalid history cursor');
      return { events: this.store.events(p.sessionId, p.after ?? 0), status: this.store.status(p.sessionId) };
    }
    if (method === 'session/prompt') return this.prompt(c, p);
    if (method === 'session/cancel') { this.requireSession(c, p.sessionId).controller?.abort(); return {}; }
    if (method === 'session/close') { const e = this.requireSession(c, p.sessionId); await this.detach(e); return {}; }
    // No client-supplied MCP, mode/permission switching, filesystem, or terminal callbacks.
    throw new AccessError(-32601, `Unsupported prototype method: ${method}`);
  }
  async open(c, id, resume) {
    this.requireIdentity(c);
    if (this.sessions.has(id)) throw new AccessError(-32007, 'Session is opening or draining');
    const e = { id, connection: c, controller: null, running: null, drain: null, handle: null, activation: null };
    this.sessions.set(id, e);
    try {
      e.activation = this.runtime.open({ id, owner: c.identity.account, cwd: this.cwd, resume });
      e.handle = await e.activation;
      if (c.closed || this.closing) { await this.detach(e); throw new AccessError(-32001, 'Connection closed during session activation'); }
      return { sessionId: id, cwd: this.cwd, _meta: { owner: c.identity.account, serviceId: c.identity.serviceId, status: this.store.status(id) } };
    } catch (error) {
      if (this.sessions.get(id) === e) this.sessions.delete(id);
      throw new AccessError(-32008, resume ? 'Session restore failed; no replacement session or history replay was performed' : 'Session creation failed', { cause: error.message });
    }
  }
  publish(e, update) {
    const record = this.store.append(e.id, update);
    if (e.connection && !e.connection.closed && !e.connection.peer.closed) {
      try { e.connection.peer.notify('session/update', { sessionId: e.id, update, _meta: { sequence: record.seq } }); }
      catch { e.connection.peer.close(); }
    }
  }
  async prompt(c, p) {
    const e = this.requireSession(c, p.sessionId);
    if (e.running) throw new AccessError(-32007, 'A prompt is already running');
    const text = textPrompt(p.prompt); const requestId = requireText(p._meta?.requestId, 'requestId', 200);
    this.store.begin(e.id, requestId); e.controller = new AbortController();
    // Mark running before publication, which can itself discover a disconnected/stalled consumer.
    e.running = Promise.resolve().then(() => {
      this.publish(e, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
      if (e.controller.signal.aborted) return { stopReason: 'cancelled' };
      return this.runtime.prompt(e.handle, text, e.controller.signal, update => this.publish(e, update));
    });
    try {
      const result = await e.running;
      const reason = e.controller.signal.aborted ? 'cancelled' : result.stopReason;
      this.store.settle(e.id, requestId, reason === 'end_turn' ? 'completed' : reason);
      return { stopReason: reason };
    } catch (error) {
      this.store.settle(e.id, requestId, e.controller.signal.aborted ? 'cancelled' : 'unknown');
      if (e.controller.signal.aborted) return { stopReason: 'cancelled' };
      throw new AccessError(-32009, 'Prompt failed; some operations may already have committed. No automatic retry.', { cause: error.message });
    } finally { e.running = null; e.controller = null; }
  }
  detach(e) {
    if (e.drain) return e.drain;
    e.connection = null; e.controller?.abort();
    e.drain = (async () => {
      try { await e.running; } catch { /* original prompt owns its result */ }
      if (e.handle) await this.runtime.close(e.handle);
    })().finally(() => { if (this.sessions.get(e.id) === e) this.sessions.delete(e.id); });
    return e.drain;
  }
  async disconnect(c) {
    if (c.closed) return;
    c.closed = true; clearTimeout(c.authTimer); this.connections.delete(c);
    const entries = [...this.sessions.values()].filter(e => e.connection === c);
    // Opens without handles finish their own activation cleanup; they are not claimable by another connection.
    for (const e of entries) if (!e.handle) e.connection = null;
    await Promise.allSettled(entries.filter(e => e.handle).map(e => this.detach(e)));
  }
  async close() {
    this.closing = true;
    for (const c of this.connections) c.peer.close();
    const entries = [...this.sessions.values()];
    await Promise.allSettled(entries.map(async e => {
      if (!e.handle && e.activation) { try { await e.activation; } catch { return; } }
      if (e.handle) await this.detach(e);
    }));
    await this.runtime.closeAll?.();
  }
}
