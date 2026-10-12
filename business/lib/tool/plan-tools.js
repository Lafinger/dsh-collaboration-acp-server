/**
 * Plan tools (M4).
 *
 * The gate is the whole point, so the descriptions state the rules the model must not work
 * around: a confirmation belongs to a ROLE, silence and refusal both block, and registering
 * a plan creates no work until every relevant role has agreed.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runTool } from './result.js';
const JSON_OUTPUT = {
    schema: { type: 'json' },
    render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) },
    ],
};
const ROLE_ENUM = [
    'pm',
    'product',
    'design',
    'scenemodel',
    'sceneart',
    'data',
    'frontend',
    'backend',
    'ue',
];
function planToJson(plan) {
    return {
        plan_id: plan.id,
        version: plan.version,
        project_id: plan.projectId,
        title: plan.title,
        relevant_roles: [...plan.relevantRoles],
        roles_reason: plan.rolesReason,
        roles_overridden: plan.rolesOverridden,
        proposed_roles: plan.proposedRoles === null ? null : [...plan.proposedRoles],
        tasks: plan.tasks.map((t) => ({
            ref: t.ref,
            role: t.role,
            change: t.change,
            content: t.content,
            depends_on: [...t.dependsOn],
        })),
        undecided: [...plan.undecided],
        source_analysis_id: plan.sourceAnalysisId,
        is_active: plan.activatedAt !== null,
        activated_at: plan.activatedAt,
        created_at: plan.createdAt,
    };
}
function gateToJson(gate) {
    if (gate.kind === 'unanimous') {
        return { state: 'unanimous', agreed: [...gate.agreed] };
    }
    if (gate.kind === 'superseded') {
        // Reported explicitly so a superseded version is never mistaken for an untouched one.
        return {
            state: 'superseded',
            voided_at: gate.voidedAt,
            void_reason: gate.voidReason,
            note: 'a later revision voided every confirmation on this version',
        };
    }
    return {
        state: 'waiting',
        // A vacancy is called out separately: it is the one case where nobody can act.
        pending: [...gate.pending],
        vacancies: [...gate.vacancies],
        rejected: [...gate.rejected],
    };
}
function withSlotsToJson(view) {
    return {
        ...planToJson(view.plan),
        gate: gateToJson(view.gate),
        confirmations: view.slots.map((s) => ({
            role: s.role,
            outcome: s.outcome,
            reason: s.reason,
            submitted_by: s.submittedBy,
            decided_at: s.decidedAt,
            voided_at: s.voidedAt,
            void_reason: s.voidReason,
        })),
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
export function planToolDefinitions(service, declaredMemberOf = () => null) {
    return [
        defineTool({
            name: 'plan_register',
            description: 'Register a plan drawn from an analysis. Registering creates NO work: the plan ' +
                'stays pending until every relevant role has agreed. Name the roles that must all ' +
                'agree and say WHY that set — an unexplained gate cannot be reviewed. Dependencies ' +
                'between tasks are checked now: cycles and references to missing tasks are rejected.',
            parameters: {
                project_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                roles_reason: {
                    type: 'string',
                    required: true,
                    description: 'Why exactly these roles must confirm. Recorded and reviewable.',
                },
                relevant_roles: {
                    type: 'array',
                    required: true,
                    description: 'Every role that must agree before this plan takes effect.',
                    items: { type: 'string', enum: ROLE_ENUM },
                },
                proposed_roles: {
                    type: 'array',
                    description: 'The role set you proposed, if the caller changed it. Supplying this records ' +
                        'that the set was corrected.',
                    items: { type: 'string', enum: ROLE_ENUM },
                },
                tasks: {
                    type: 'array',
                    required: true,
                    description: 'The task changes this plan proposes. May be empty.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ref: {
                                type: 'string',
                                required: true,
                                description: 'Name for this task INSIDE this plan version, used by depends_on. Not a ' +
                                    'task id: two plans may each use "t1".',
                            },
                            task_id: {
                                type: 'string',
                                description: 'REQUIRED for modify/cancel: the id of the existing task being changed. ' +
                                    'MUST be omitted for add — a new task has no id yet.',
                            },
                            role: { type: 'string', required: true, enum: ROLE_ENUM },
                            change: { type: 'string', required: true, enum: ['add', 'modify', 'cancel'] },
                            content: { type: 'string', required: true },
                            depends_on: {
                                type: 'array',
                                required: true,
                                description: 'Refs (not task ids) of tasks whose output this one needs. May name a task ' +
                                    'created by this same plan.',
                                items: { type: 'string' },
                            },
                        },
                    },
                },
                undecided: {
                    type: 'array',
                    required: true,
                    description: 'Open questions carried on the plan. No owner, no status, never resolved.',
                    items: { type: 'string' },
                },
                source_analysis_id: {
                    type: 'string',
                    description: 'The analysis this was transcribed from, if you want it on record.',
                },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve(withSlotsToJson(service.register({
                projectId: args.project_id,
                title: args.title,
                relevantRoles: args.relevant_roles,
                rolesReason: args.roles_reason,
                tasks: args.tasks.map((t) => ({
                    ref: t.ref,
                    taskId: t.task_id ?? null,
                    role: t.role,
                    change: t.change,
                    content: t.content,
                    dependsOn: [...t.depends_on],
                })),
                undecided: [...args.undecided],
                ...(args.source_analysis_id === undefined
                    ? {}
                    : { sourceAnalysisId: args.source_analysis_id }),
                ...(args.proposed_roles === undefined ? {} : { proposedRoles: args.proposed_roles }),
            })))),
            presentCall: (args) => present('Register plan', args.title),
        }),
        defineTool({
            name: 'plan_confirm',
            description: 'Submit ONE role\'s decision on a plan. Confirmation is per role, never per person: ' +
                'if someone holds two roles they must submit twice. A rejection MUST carry a reason. ' +
                'Only when every relevant role has agreed does the plan take effect. A role with no ' +
                'member simply waits — nothing passes automatically and no other role may stand in.',
            parameters: {
                plan_id: { type: 'string', required: true },
                role: { type: 'string', required: true, enum: ROLE_ENUM },
                outcome: { type: 'string', required: true, enum: ['agree', 'reject'] },
                submitted_by: {
                    type: 'string',
                    required: true,
                    description: 'Who is submitting, recorded as a snapshot.',
                },
                reason: { type: 'string', description: 'Required when rejecting.' },
            },
            output: JSON_OUTPUT,
            execute: (args, exec) => runTool(() => Promise.resolve(withSlotsToJson(service.confirm({
                planId: args.plan_id,
                role: args.role,
                outcome: args.outcome,
                reason: args.reason ?? null,
                submittedBy: args.submitted_by,
                // From the SESSION, never from args: otherwise the eligibility check could be
                // satisfied by simply naming whoever holds the role (ADR-0014).
                declaredMember: declaredMemberOf(exec),
            })))),
            presentCall: (args) => present(`Confirm as ${args.role}`, args.plan_id),
        }),
        defineTool({
            name: 'plan_revise',
            description: 'Revise a plan into a NEW version. Allowed at any time before it takes effect, even ' +
                'with some confirmations already collected. Every confirmation already received is ' +
                'VOIDED — kept on record but no longer counting — so the plan must be confirmed all ' +
                'over again. Give a reason: it is recorded on each voided confirmation.',
            parameters: {
                plan_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                roles_reason: { type: 'string', required: true },
                relevant_roles: {
                    type: 'array',
                    required: true,
                    items: { type: 'string', enum: ROLE_ENUM },
                },
                tasks: {
                    type: 'array',
                    required: true,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            ref: { type: 'string', required: true },
                            task_id: {
                                type: 'string',
                                description: 'REQUIRED for modify/cancel, omitted for add. See plan_register.',
                            },
                            role: { type: 'string', required: true, enum: ROLE_ENUM },
                            change: { type: 'string', required: true, enum: ['add', 'modify', 'cancel'] },
                            content: { type: 'string', required: true },
                            depends_on: { type: 'array', required: true, items: { type: 'string' } },
                        },
                    },
                },
                undecided: { type: 'array', required: true, items: { type: 'string' } },
                proposed_roles: {
                    type: 'array',
                    description: 'Your proposed role set, if it differs from relevant_roles.',
                    items: { type: 'string', enum: ROLE_ENUM },
                },
                reason: {
                    type: 'string',
                    required: true,
                    description: 'Why the plan changed. Recorded on every voided confirmation.',
                },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve(withSlotsToJson(service.revise({
                planId: args.plan_id,
                title: args.title,
                relevantRoles: args.relevant_roles,
                rolesReason: args.roles_reason,
                tasks: args.tasks.map((t) => ({
                    ref: t.ref,
                    taskId: t.task_id ?? null,
                    role: t.role,
                    change: t.change,
                    content: t.content,
                    dependsOn: [...t.depends_on],
                })),
                undecided: [...args.undecided],
                reason: args.reason,
                ...(args.proposed_roles === undefined ? {} : { proposedRoles: args.proposed_roles }),
            })))),
            presentCall: (args) => present('Revise plan', args.plan_id),
        }),
        defineTool({
            name: 'plan_get',
            description: 'Read one plan: its tasks, its relevant roles and the reason for them, every ' +
                'confirmation slot with its outcome, and whether it has taken effect.',
            parameters: {
                plan_id: { type: 'string', required: true },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve(withSlotsToJson(service.get(args.plan_id)))),
            presentCall: (args) => present('Get plan', args.plan_id),
        }),
        defineTool({
            name: 'plan_history',
            description: 'Every version of a plan, oldest first, including voided confirmations. Use this to ' +
                'see what was agreed before a revision changed the plan.',
            parameters: {
                plan_id: { type: 'string', required: true },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve({ versions: service.history(args.plan_id).map(withSlotsToJson) })),
            presentCall: (args) => present('Plan history', args.plan_id),
        }),
        defineTool({
            name: 'plan_list',
            description: "List a project's plans at their latest version, with each plan's gate state.",
            parameters: {
                project_id: { type: 'string', required: true },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve({ plans: service.listByProject(args.project_id).map(withSlotsToJson) })),
            presentCall: (args) => present('List plans', args.project_id),
        }),
    ];
}
