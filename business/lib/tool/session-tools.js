/**
 * Session identity tool (ADR-0014).
 *
 * One tool, one job: say who this session is. It is deliberately NOT part of
 * `project_set_role_member` — that answers "which slot belongs to whom" (a project fact), while
 * this answers "who is speaking" (a session fact). Merging them is precisely the confusion that
 * let an agent invent nine members and confirm on behalf of all of them.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runTool } from './result.js';
const JSON_OUTPUT = {
    schema: { type: 'json' },
    render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) },
    ],
};
function identityToJson(identity) {
    return {
        session_id: identity.sessionId,
        member: identity.member,
        declared_at: identity.declaredAt,
        updated_at: identity.updatedAt,
    };
}
function present(title, rawInput) {
    return {
        card: 'generic',
        title,
        kind: 'other',
        ...(rawInput === undefined ? {} : { rawInput }),
    };
}
/**
 * The session id comes from the execution context, never from the model.
 *
 * If it came from a parameter, a caller could claim to be a different session and inherit
 * someone else's declared identity — which would make the whole check decorative.
 */
export function sessionToolDefinitions(identities, sessionIdOf) {
    return [
        defineTool({
            name: 'session_declare_member',
            description: 'Declare which member this session is speaking as. Needed before this session can ' +
                'decide AS a role: plan_confirm, result_review and result_accept each require that the ' +
                'role belongs to the declared member. One session speaks as one member; declaring ' +
                'again replaces it and only affects future records. Reading, uploading and registering ' +
                'do not require a declaration. A member may hold several roles.',
            parameters: {
                member: {
                    type: 'string',
                    required: true,
                    description: 'The member this session speaks as, e.g. a person\'s name.',
                },
            },
            output: JSON_OUTPUT,
            execute: (args, exec) => {
                const sessionId = sessionIdOf(exec);
                return runTool(() => {
                    if (sessionId === null) {
                        // Reported, not worked around: without a session id there is nothing to key the
                        // declaration to, and silently inventing one would make identity meaningless.
                        throw new Error('this execution has no session id, so identity cannot be declared');
                    }
                    return Promise.resolve(identityToJson(identities.declare({ sessionId, member: args.member })));
                });
            },
            presentCall: (args) => present('Declare member', args.member),
        }),
        defineTool({
            name: 'session_whoami',
            description: 'Report which member this session is currently speaking as, or that it has not ' +
                'declared one. Read-only.',
            parameters: {},
            output: JSON_OUTPUT,
            execute: (_args, exec) => runTool(() => {
                const sessionId = sessionIdOf(exec);
                const identity = sessionId === null ? null : identities.find(sessionId);
                return Promise.resolve({
                    declared: identity !== null,
                    identity: identity === null ? null : identityToJson(identity),
                });
            }),
            presentCall: () => present('Who am I'),
        }),
    ];
}
