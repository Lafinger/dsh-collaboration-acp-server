import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
const path = '/srv/collaboration/private-state/acceptance-counters.json';
const modePath = '/srv/collaboration/private-state/mode.json';
export const name = 'collaboration-acceptance-policy';
export const inject = ['llm'];
export function apply(ctx) {
  const counts = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { turns: 0, requests: 0, completedTurns: 0 };
  const save = () => { writeFileSync(`${path}.tmp`, JSON.stringify(counts, null, 2), { mode: 0o600 }); renameSync(`${path}.tmp`, path); };
  const mode = () => JSON.parse(readFileSync(modePath, 'utf8')).mode;
  const turns = new Map();
  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const acceptance = mode() === 'acceptance';
    const key = `${agent.session.id}:${turn}`;
    if (!turns.has(key)) {
      if (acceptance && counts.turns >= 6) throw new Error('ACCEPTANCE_TURN_LIMIT');
      counts.turns++; save();
      const timer = acceptance ? setTimeout(() => agent.cancel({ kind: 'user' }), 240000) : null;
      turns.set(key, { timer, sessionId: agent.session.id });
    }
    const config = await next();
    if (config.provider !== 'codego' || config.model !== 'deepseek-v4.1-flash') throw new Error('MODEL_ROUTE_NOT_ALLOWED');
    const { maxTokens, ...route } = config;
    return acceptance ? { ...route, maxTokens: 2048 } : route;
  });
  ctx.on('llm/stream', (options, next) => {
    if (mode() === 'acceptance' && counts.requests >= 24) throw new Error('ACCEPTANCE_REQUEST_LIMIT');
    counts.requests++; save();
    return next();
  });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return;
    for (const [key, entry] of turns) if (entry.sessionId === session.id) { if (entry.timer) clearTimeout(entry.timer); turns.delete(key); }
    counts.completedTurns++; save();
  });
  ctx.effect(() => () => { for (const entry of turns.values()) if (entry.timer) clearTimeout(entry.timer); });
  save();
  ctx.provide('collaborationAcceptancePolicy', Object.freeze({ get mode() { return mode(); }, get requests() { return counts.requests; } }));
}
