import { WorkbenchError } from '../domain/error.js';
import { newId } from '../domain/ids.js';
import { isRoleId } from '../domain/roles.js';
import { frozenReason, } from '../domain/task.js';
import { TaskRepository } from '../sqlite/task-repository.js';
import { systemClock } from './project-service.js';
export class TaskService {
    clock;
    tasks;
    constructor(db, clock = systemClock) {
        this.clock = clock;
        this.tasks = new TaskRepository(db);
    }
    /**
     * Apply an activated plan's proposals to real tasks.
     *
     * MUST be called inside the activation transaction. Any part of this escaping the
     * transaction would allow a half-activated plan.
     */
    applyActivation(plan) {
        const at = this.clock.now();
        const proposals = plan.tasks;
        // ---- pass 0: validate, against CURRENT state -------------------------------
        // Registration validated the same things, but a task may have completed or been
        // cancelled while this plan waited for its confirmations. Re-check, or the freeze
        // guarantee silently fails.
        const seenTargets = new Set();
        for (const p of proposals) {
            if (p.change === 'add') {
                if (p.taskId !== null) {
                    throw new WorkbenchError('INVALID_ARGUMENT', `proposal "${p.ref}" is an add, so it must not name an existing task`, { ref: p.ref });
                }
                continue;
            }
            if (p.taskId === null) {
                throw new WorkbenchError('TASK_TARGET_REQUIRED', `proposal "${p.ref}" is a ${p.change}, so it must name the task it changes`, { ref: p.ref, change: p.change });
            }
            // Defence in depth. Registration ALREADY refuses a duplicate target, so through the
            // public API this branch is unreachable — mutation testing confirmed it can be deleted
            // without any test noticing. It stays because this function is the thing that would
            // write two versions of one task, and it must not depend on a check made elsewhere
            // (and much earlier) to avoid doing that.
            if (seenTargets.has(p.taskId)) {
                throw new WorkbenchError('DUPLICATE_TASK_TARGET', `task ${p.taskId} is targeted more than once in this plan version`, { taskId: p.taskId });
            }
            seenTargets.add(p.taskId);
            const target = this.tasks.findById(p.taskId);
            if (target === null) {
                throw new WorkbenchError('TASK_NOT_FOUND', `no task with id ${p.taskId}`, {
                    taskId: p.taskId,
                });
            }
            const frozen = frozenReason(target);
            if (frozen !== null) {
                throw new WorkbenchError('TASK_FROZEN', `task ${p.taskId} is ${frozen} and its definition can no longer change`, { taskId: p.taskId, reason: frozen });
            }
            // Cancelling something a downstream task depends on would strand that dependency.
            if (p.change === 'cancel') {
                const dependents = this.tasks.dependentsOf(p.taskId);
                if (dependents.length > 0) {
                    throw new WorkbenchError('TASK_HAS_DEPENDENTS', `task ${p.taskId} cannot be cancelled: ${dependents.length} task(s) depend on it`, { taskId: p.taskId, dependents: [...dependents] });
                }
            }
        }
        // ---- pass 1: create every `add`, building ref -> task id --------------------
        const refToTask = new Map();
        const created = [];
        for (const p of proposals) {
            if (p.change !== 'add')
                continue;
            const taskId = newId();
            const role = requireRole(p.role, p.ref);
            this.tasks.insertTask({
                id: taskId,
                projectId: plan.projectId,
                role,
                currentVersion: 1,
                createdAt: at,
                cancelledAt: null,
                cancelledByPlanId: null,
                completedAt: null,
            });
            refToTask.set(p.ref, taskId);
            created.push(taskId);
        }
        // ---- pass 2: write versions, resolving dependencies through refToTask -------
        // `add` tasks first (their version 1 is written here), then modify/cancel.
        const modified = [];
        for (const p of proposals) {
            if (p.change === 'add') {
                const taskId = refToTask.get(p.ref);
                if (taskId === undefined) {
                    throw new WorkbenchError('INTERNAL', `ref "${p.ref}" was not mapped`, { ref: p.ref });
                }
                this.writeVersion(plan, p, taskId, 1, at, refToTask);
                this.tasks.recordOutcome({
                    planId: plan.id, planVersion: plan.version, ref: p.ref,
                    change: 'add', taskId, taskVersion: 1,
                });
                continue;
            }
            const taskId = p.taskId;
            if (taskId === null) {
                throw new WorkbenchError('INTERNAL', `proposal "${p.ref}" lost its target`, { ref: p.ref });
            }
            if (p.change === 'cancel') {
                this.tasks.cancel(taskId, plan.id, at);
                const current = this.tasks.findById(taskId);
                this.tasks.recordOutcome({
                    planId: plan.id, planVersion: plan.version, ref: p.ref,
                    change: 'cancel', taskId, taskVersion: current?.currentVersion ?? 0,
                });
                continue;
            }
            // modify: append a version
            const existing = this.tasks.findById(taskId);
            if (existing === null) {
                throw new WorkbenchError('INTERNAL', `task ${taskId} vanished mid-activation`, { taskId });
            }
            const next = existing.currentVersion + 1;
            this.writeVersion(plan, p, taskId, next, at, refToTask);
            this.tasks.recordOutcome({
                planId: plan.id, planVersion: plan.version, ref: p.ref,
                change: 'modify', taskId, taskVersion: next,
            });
            modified.push(taskId);
        }
        return { created, modified, cancelled: proposals.filter((p) => p.change === 'cancel').map((p) => p.taskId) };
    }
    /**
     * Resolve a version's dependencies and write it.
     *
     * A `depends_on` entry may name a ref created in THIS activation, so resolution goes
     * through refToTask first and falls back to an already-existing task id.
     */
    writeVersion(plan, proposal, taskId, version, at, refToTask) {
        const resolved = [];
        for (const dep of proposal.dependsOn) {
            const fromThisPlan = refToTask.get(dep);
            if (fromThisPlan !== undefined) {
                resolved.push(fromThisPlan);
                continue;
            }
            // Not created here: it must be an existing task in the same project.
            const existing = this.tasks.findById(dep);
            if (existing === null || existing.projectId !== plan.projectId) {
                throw new WorkbenchError('DEPENDENCY_MISSING_TASK', `task "${proposal.ref}" depends on "${dep}", which resolved to no task in this project`, { ref: proposal.ref, dependsOn: dep });
            }
            resolved.push(dep);
        }
        const record = {
            taskId,
            version,
            content: proposal.content,
            requiredResults: proposal.requiredResults ?? null,
            completionCriteria: proposal.completionCriteria ?? null,
            dependsOn: [...proposal.dependsOn],
            createdByPlanId: plan.id,
            createdByPlanVersion: plan.version,
            createdAt: at,
        };
        this.tasks.insertVersion(record, resolved, version === 1);
    }
    /** The project owning a task, or null when there is no such task. */
    findTask(taskId) {
        return this.tasks.findById(taskId)?.projectId ?? null;
    }
    // ---- reads ----------------------------------------------------------------
    get(taskId) {
        const found = this.tasks.withVersions(taskId);
        if (found === null) {
            throw new WorkbenchError('TASK_NOT_FOUND', `no task with id ${taskId}`, { taskId });
        }
        return found;
    }
    listByProject(projectId) {
        return this.tasks
            .listByProject(projectId)
            .map((t) => this.tasks.withVersions(t.id))
            .filter((t) => t !== null);
    }
    versionsOf(taskId) {
        this.get(taskId); // ensures existence, so callers get TASK_NOT_FOUND not an empty list
        return this.tasks.versionsOf(taskId);
    }
    /** Which plan created a task. Answered from the ledger, never guessed. */
    creatorOf(taskId) {
        this.get(taskId);
        return this.tasks.creatorOf(taskId);
    }
    /** The ledger for one plan version: what each ref became. */
    outcomesOf(planId, version) {
        return this.tasks.outcomesOfPlan(planId, version);
    }
    /** Does this project have any task at all? Used by tests and status views. */
    countByProject(projectId) {
        return this.tasks.listByProject(projectId).length;
    }
}
function requireRole(role, ref) {
    if (!isRoleId(role)) {
        throw new WorkbenchError('ROLE_UNKNOWN', `task "${ref}" has unknown role ${String(role)}`, {
            ref,
            role,
        });
    }
    return role;
}
