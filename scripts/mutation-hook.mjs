// Test-only in-memory mutations. Production source files are never edited.
import { registerHooks } from 'node:module';
const mutation = process.env.COLLABORATION_MUTATION;
const mutations = {
  'owner-check': { suffix: '/src/service.mjs', before: 'this.store.requireOwner(id, this.requireIdentity(c).account);', after: 'this.requireIdentity(c);' },
  'request-replay': { suffix: '/src/store.mjs', before: "if (existing) throw new AccessError(-32005, 'Request already submitted; automatic replay is forbidden', { state: existing.state });", after: "if (existing) this.db.prepare('DELETE FROM access_requests WHERE session_id=? AND request_id=?').run(id, requestId);" },
  'forged-snapshot': { suffix: '/src/collaboration-binding.mjs', before: 'original.execute({ ...args, submitted_by: account }, exec)', after: 'original.execute(args, exec)' },
  'mutable-identity': { suffix: '/src/collaboration-binding.mjs', before: "execute: () => ({ ok: false, code: 'AUTHENTICATED_IDENTITY_IMMUTABLE', message: 'Login-bound identity cannot be declared or changed by a prompt/tool argument.' }),", after: "execute: args => ({ ok: true, ...identities.declare({ sessionId, member: args.member }) })," },
};
const selected = mutations[mutation];
if (!selected) throw new Error('Unknown mutation');
let applied = false;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith(selected.suffix)) {
    const source = String(result.source);
    if (!source.includes(selected.before)) throw new Error('Mutation anchor missing');
    applied = true;
    return { ...result, source: source.replace(selected.before, selected.after) };
  }
  return result;
} });
process.on('exit', () => { if (!applied) process.exitCode = 99; });
