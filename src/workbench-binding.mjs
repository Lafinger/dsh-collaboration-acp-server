import { defineTool } from '@deepseek-ai/dsh-tools';

/** Only isolated sessions receive these scoped shadows; the existing declaration implementation stays intact. */
export function bindWorkbenchIdentity(agentCtx, identities, { sessionId, account }) {
  // Compatibility bridge into the existing business service; only trusted server setup invokes it.
  identities.declare({ sessionId, member: account });
  // Record attribution from the verified account, not an LLM-written submitted_by snapshot.
  for (const name of ['plan_confirm', 'result_review', 'result_accept', 'material_upload', 'analysis_submit', 'result_submit', 'progress_add']) {
    const original = agentCtx.tools.get(name);
    if (!original) continue;
    agentCtx.tools.register({ ...original, execute: (args, exec) => original.execute({ ...args, submitted_by: account }, exec) });
  }
  const json = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  agentCtx.tools.register(defineTool({
    name: 'session_declare_member', description: 'Unavailable in authenticated remote sessions: identity comes from login.',
    parameters: { member: { type: 'string', required: true } }, output: json,
    execute: () => ({ ok: false, code: 'AUTHENTICATED_IDENTITY_IMMUTABLE', message: 'Login-bound identity cannot be declared or changed by a prompt/tool argument.' }),
  }));
  agentCtx.tools.register(defineTool({
    name: 'session_whoami', description: 'Read the server-verified login account bound to this conversation.', parameters: {}, output: json,
    execute: () => ({ ok: true, account, session_id: sessionId, identity_source: 'authenticated_connector' }),
  }));
}
