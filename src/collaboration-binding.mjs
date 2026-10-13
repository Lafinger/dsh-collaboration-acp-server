import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';

/** Transform before scoped registration: never register duplicate tools in the same Agent layer. */
export function bindCollaborationIdentity(_agentCtx, identities, { sessionId, account, workspace }) {
  identities.declare({ sessionId, member: account });
  const attributed = new Set(['plan_confirm', 'result_review', 'result_accept', 'material_upload', 'analysis_submit', 'result_submit', 'progress_add']);
  return original => {
    if (original.name === 'session_declare_member') return {
      ...original, description: 'Unavailable in authenticated remote sessions: identity comes from login.',
      execute: () => ({ ok: false, code: 'AUTHENTICATED_IDENTITY_IMMUTABLE', message: 'Login-bound identity cannot be declared or changed by a prompt/tool argument.' }),
    };
    if (original.name === 'session_whoami') return {
      ...original, description: 'Read the server-verified login account bound to this conversation.',
      execute: () => ({ ok: true, account, session_id: sessionId, identity_source: 'authenticated_connector' }),
    };
    if (original.name === 'material_upload') return { ...original, execute: (args, exec) => {
      // Existing business import is not an arbitrary host-file read endpoint.
      try {
        if (!workspace || !isAbsolute(args.source_path)) throw new Error('No server workspace');
        const source = realpathSync(args.source_path), root = realpathSync(workspace), path = relative(root, source);
        if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')) throw new Error('Outside server workspace');
        return original.execute({ ...args, submitted_by: account, source_path: source }, exec);
      } catch { return { ok: false, code: 'SERVER_WORKSPACE_ONLY', message: 'Only deployment-staged files inside the server workspace may be imported; no client file upload or arbitrary host read.' }; }
    } };
    if (attributed.has(original.name)) return { ...original, execute: (args, exec) => original.execute({ ...args, submitted_by: account }, exec) };
    return original;
  };
}
