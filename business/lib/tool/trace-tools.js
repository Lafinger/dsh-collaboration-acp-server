/**
 * The trace tool (M7, MVP-031).
 *
 * ONE tool taking an object, rather than three taking a task/result/plan: the caller knows
 * what it has, and MVP-031's question — "who, on which version, decided what, when, why" — is
 * the same question whatever the object.
 *
 * Read-only by construction. It is the only tool in the MVP that writes nothing, and it can
 * therefore never violate the "no automatic advancement" rules.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runTool } from './result.js';
const JSON_OUTPUT = {
    schema: { type: 'json' },
    render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) },
    ],
};
function decisionToJson(d) {
    return {
        kind: d.kind,
        version: d.version,
        role: d.role,
        outcome: d.outcome,
        reason: d.reason,
        submitted_by: d.submittedBy,
        at: d.at,
        // The "based on which version" half of MVP-031, kept explicit rather than folded into
        // the prose so a caller can compare versions programmatically.
        based_on: d.basedOn === null ? null : { kind: d.basedOn.kind, version: d.basedOn.version },
        detail: d.detail,
    };
}
function traceToJson(t) {
    return {
        object: { type: t.object.type, id: t.object.id, project_id: t.object.projectId },
        current_version: t.currentVersion,
        decisions: t.decisions.map(decisionToJson),
        history: t.history.map(decisionToJson),
        chain: {
            inputs: t.chain.inputs.map((i) => ({
                task_id: i.taskId,
                task_version: i.version,
                result_version: i.resultVersion,
            })),
            consumers: t.chain.consumers.map((c) => ({
                task_id: c.taskId,
                outcome: c.outcome,
                result_version: c.version,
            })),
        },
    };
}
export function traceToolDefinitions(services) {
    return [
        defineTool({
            name: 'trace',
            description: 'Trace who decided what, on which version, when and why. Answers MVP-031 for one ' +
                'task, result version or plan. Returns CURRENT decisions separately from HISTORY: ' +
                'history is superseded but kept readable, and old decisions are never rewritten by ' +
                'later ones. For a task it also reports the chain — which input versions it consumed ' +
                '(null when not yet accepted, which is why completion would be refused) and which ' +
                'downstream tasks consumed it. Read-only: tracing changes nothing.',
            parameters: {
                object_type: {
                    type: 'string',
                    required: true,
                    enum: ['task', 'result', 'plan'],
                    description: 'What kind of object the id refers to.',
                },
                object_id: {
                    type: 'string',
                    required: true,
                    description: 'Task id, result id or plan id.',
                },
                version: {
                    type: 'number',
                    description: 'For a result: which result version to trace. Defaults to the latest. Ignored for tasks and plans, which trace all their versions.',
                },
            },
            output: JSON_OUTPUT,
            async execute(args) {
                return runTool(() => {
                    if (args.object_type === 'task') {
                        return { ok: true, trace: traceToJson(services.traces.traceTask(args.object_id)) };
                    }
                    if (args.object_type === 'plan') {
                        return { ok: true, trace: traceToJson(services.traces.tracePlan(args.object_id)) };
                    }
                    const version = args.version ?? services.traces.latestResultVersion(args.object_id) ?? undefined;
                    if (version === undefined) {
                        return {
                            ok: false,
                            code: 'RESULT_NOT_FOUND',
                            message: `no result versions for ${args.object_id}`,
                        };
                    }
                    return {
                        ok: true,
                        trace: traceToJson(services.traces.traceResult(args.object_id, version)),
                    };
                });
            },
        }),
    ];
}
