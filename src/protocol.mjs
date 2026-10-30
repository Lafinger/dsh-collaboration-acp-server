import { EventEmitter } from 'node:events';

export class AccessError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}
// ACP-shaped base version and our private collaboration extension version are independent.
export const ACP_PROTOCOL_VERSION = 1;
export const COLLABORATION_PROTOCOL_VERSION = 4;
export const collaborationMeta = () => ({ collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION });
export const initializeParams = () => ({ protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {}, _meta: collaborationMeta() });
export function requireCollaborationVersion(value) {
  if (value?._meta?.collaborationProtocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
    throw new AccessError(-32011, 'Collaboration protocol version mismatch; install matching client and server releases. No downgrade or replay.', { expected: COLLABORATION_PROTOCOL_VERSION });
  }
}
export function requireInitializeResult(value) {
  requireCollaborationVersion(value);
  if (value?.protocolVersion !== ACP_PROTOCOL_VERSION) throw new AccessError(-32011, 'Unsupported ACP-shaped base protocol version');
}
export function requireText(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AccessError(-32602, `Invalid ${label}`);
  return value;
}
export function textPrompt(prompt) {
  if (!Array.isArray(prompt) || !prompt.length || prompt.some(p => p?.type !== 'text' || typeof p.text !== 'string')) {
    throw new AccessError(-32602, 'This prototype accepts text prompts only');
  }
  const text = prompt.map(p => p.text).join('\n');
  requireText(text, 'prompt', 256 * 1024);
  return text;
}

/** Bounded NDJSON. Parse/protocol violations close the stream rather than silently dropping requests. */
export class JsonPeer extends EventEmitter {
  constructor(input, output = input, { maxFrame = 1024 * 1024 } = {}) {
    super(); this.input = input; this.output = output; this.maxFrame = maxFrame;
    this.buffer = ''; this.pending = new Map(); this.nextId = 1; this.closed = false;
    input.setEncoding('utf8');
    input.on('data', chunk => {
      if (this.closed) return;
      this.buffer += chunk;
      try {
        let end;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          if (Buffer.byteLength(line) > this.maxFrame) throw new Error('Protocol frame too large');
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (!message || message.jsonrpc !== '2.0' || Array.isArray(message)) throw new Error('Invalid JSON-RPC message');
          if (typeof message.method === 'string') this.emit('message', message);
          else if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (pending) {
              this.pending.delete(message.id); clearTimeout(pending.timer);
              if (message.error) pending.reject(new AccessError(message.error.code, message.error.message, message.error.data));
              else if ('result' in message) pending.resolve(message.result);
              else pending.reject(new AccessError(-32600, 'Malformed response'));
            }
          } else throw new Error('Invalid JSON-RPC message');
        }
        if (Buffer.byteLength(this.buffer) > this.maxFrame) throw new Error('Protocol frame too large');
      } catch (error) { this.fail(error); }
    });
    input.on('end', () => this.fail(new AccessError(-32001, 'Connection ended')));
    input.on('close', () => this.fail(new AccessError(-32001, 'Connection closed')));
    input.on('error', error => this.fail(error));
    if (output !== input) output.on('error', error => this.fail(error));
  }
  send(message) {
    if (this.closed) throw new AccessError(-32001, 'Connection closed');
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > this.maxFrame) throw new AccessError(-32602, 'Protocol frame too large');
    // Never accumulate an unbounded transcript for a stalled consumer.
    if (this.output.writableLength > 4 * this.maxFrame) { this.fail(new Error('Consumer backpressure limit')); throw new AccessError(-32001, 'Consumer stalled'); }
    this.output.write(line);
  }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method, params, { timeoutMs = 30000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id); reject(new AccessError(-32002, `${method} timed out; outcome may be unknown`));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  result(id, result) { if (id !== undefined && !this.closed) this.send({ jsonrpc: '2.0', id, result }); }
  error(id, error) {
    if (id !== undefined && !this.closed) this.send({ jsonrpc: '2.0', id, error: {
      code: Number.isInteger(error.code) ? error.code : -32603,
      message: error instanceof AccessError ? error.message : 'Internal access-service error',
      ...(error.data === undefined ? {} : { data: error.data }),
    } });
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('disconnected', error);
    if (this.input.destroy) this.input.destroy();
    if (this.output !== this.input && this.output.destroy) this.output.destroy();
  }
  close() { this.fail(new AccessError(-32001, 'Connection closed')); }
}
