/**
 * Task tools (M5 identity layer).
 *
 * There is deliberately no tool here that advances a task: no progress, no submission, no
 * completion. Those belong to the next layer. What exists is the ability to see what an
 * activated plan produced.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runTool } from './result.js';
const JSON_OUTPUT = {
    schema: { type: 'json' },
    render: (_args, value) => [
        { type: 'text', text: JSON.stringify(value) },
    ],
};
function present(title, rawInput) {
    return {
        card: 'generic',
        title,
        kind: 'other',
        ...(rawInput === undefined ? {} : { rawInput }),
    };
}
/**
 * Exported for tests. The tool OUTPUT is the contract a caller actually sees, and two MVP-022
 * fields were once stored but missing from it — so the projection is worth testing on its own
 * rather than only through `execute`, which needs host plumbing.
 */
export function taskToJson(t, projects) {
    return view(t, projects);
}
function view(t, projects) {
    // The executor is DERIVED from the role and the project's members, never stored. That way
    // replacing the person on a role immediately changes who a task shows as belonging to,
    // instead of leaving a stale snapshot behind.
    let member = null;
    try {
        member =
            projects.getWithRoles(t.task.projectId).roles.find((r) => r.role === t.task.role)?.member ??
                null;
    }
    catch {
        member = null;
    }
    return {
        task_id: t.task.id,
        project_id: t.task.projectId,
        role: t.task.role,
        member,
        current_version: t.task.currentVersion,
        content: t.current.content,
        depends_on: [...t.current.dependsOn],
        cancelled_at: t.task.cancelledAt,
        completed_at: t.task.completedAt,
        created_at: t.task.createdAt,
    };
}
/** The `task_get` projection, exported for tests. See `taskToJson` above. */
export function taskDetailToJson(t, projects) {
    return detail(t, projects);
}
function detail(t, projects) {
    // MVP-022 requires a task to show its 必交成果 and 完成标准, not just its work content.
    // Both are captured at registration and stored per task version, so the CURRENT version's
    // values belong at the top level alongside `content` — a reader asking "what does this task
    // owe?" should not have to dig through the version history to find out.
    return {
        ...view(t, projects),
        required_results: t.current.requiredResults,
        completion_criteria: t.current.completionCriteria,
        versions: t.versions.map((v) => ({
            version: v.version,
            content: v.content,
            required_results: v.requiredResults,
            completion_criteria: v.completionCriteria,
            depends_on: [...v.dependsOn],
            created_by_plan_id: v.createdByPlanId,
            created_by_plan_version: v.createdByPlanVersion,
            created_at: v.createdAt,
        })),
    };
}
export function taskToolDefinitions(service, projects) {
    return [
        defineTool({
            name: 'task_list',
            description: "List a project's tasks at their current version. Each task shows the role that owns " +
                'it and the member currently filling that role. A task exists only because a plan ' +
                'was activated — plans that are merely registered or awaiting agreement produce none.',
            parameters: {
                project_id: { type: 'string', required: true },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve({
                tasks: service.listByProject(args.project_id).map((t) => view(t, projects)),
            })),
            presentCall: (args) => present('List tasks', args.project_id),
        }),
        defineTool({
            name: 'task_get',
            description: 'Read one task with its full version history. Shows what the task owes (required ' +
                'results and completion criteria) alongside its work content. Every version is kept: a ' +
                'result records the task version it was produced under, so an older version must stay ' +
                'readable.',
            parameters: {
                task_id: { type: 'string', required: true },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve(detail(service.get(args.task_id), projects))),
            presentCall: (args) => present('Get task', args.task_id),
        }),
        defineTool({
            name: 'task_versions',
            description: 'Every version of a task, oldest first, including which plan version produced each. ' +
                'Use this to see what was asked at the time something was delivered.',
            parameters: {
                task_id: { type: 'string', required: true },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => Promise.resolve({
                task_id: args.task_id,
                versions: service.versionsOf(args.task_id).map((v) => ({
                    version: v.version,
                    content: v.content,
                    depends_on: [...v.dependsOn],
                    created_by_plan_id: v.createdByPlanId,
                    created_by_plan_version: v.createdByPlanVersion,
                    created_at: v.createdAt,
                })),
            })),
            presentCall: (args) => present('Task versions', args.task_id),
        }),
        defineTool({
            name: 'task_origin',
            description: 'Which plan created a task, and under which ref. Answered from the activation ledger, ' +
                'which is the only record of how a ref resolved.',
            parameters: {
                task_id: { type: 'string', required: true },
            },
            output: JSON_OUTPUT,
            execute: (args) => runTool(() => {
                const origin = service.creatorOf(args.task_id);
                // Domain objects are not JsonValue, so map explicitly rather than hoping the
                // structure survives serialization untouched.
                return Promise.resolve({
                    origin: origin === null
                        ? null
                        : {
                            plan_id: origin.planId,
                            plan_version: origin.planVersion,
                            ref: origin.ref,
                            change: origin.change,
                            task_id: origin.taskId,
                            task_version: origin.taskVersion,
                        },
                });
            }),
            presentCall: (args) => present('Task origin', args.task_id),
        }),
    ];
}
