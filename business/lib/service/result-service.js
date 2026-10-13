import { CollaborationError } from '../domain/error.js';
import { newId } from '../domain/ids.js';
import { assertCanActAsRole, assertWritable } from '../domain/project.js';
import {} from '../domain/result.js';
import { frozenReason } from '../domain/task.js';
import { ProjectRepository } from '../sqlite/project-repository.js';
import { ResultRepository } from '../sqlite/result-repository.js';
import { TaskRepository } from '../sqlite/task-repository.js';
import { inTransaction } from '../sqlite/schema.js';
import { systemClock } from './project-service.js';
const MAX_TEXT = 8_000;
export class ResultService {
    db;
    clock;
    results;
    tasks;
    projects;
    constructor(db, clock = systemClock) {
        this.db = db;
        this.clock = clock;
        this.results = new ResultRepository(db);
        this.tasks = new TaskRepository(db);
        this.projects = new ProjectRepository(db);
    }
    // ---- progress -------------------------------------------------------------
    /**
     * Add a progress note.
     *
     * The note records the CURRENT task version at the time it was written, so progress
     * written against different requirements never mixes (ADR-0010).
     */
    addProgress(input) {
        const task = this.requireTask(input.taskId);
        this.requireWritableProject(task.projectId);
        // Progress on a frozen task is pointless and would misrepresent it as still in flight.
        const frozen = frozenReason(task);
        if (frozen !== null) {
            throw new CollaborationError('TASK_FROZEN', `task ${input.taskId} is ${frozen}`, {
                taskId: input.taskId,
                reason: frozen,
            });
        }
        const entry = {
            id: newId(),
            taskId: input.taskId,
            taskVersion: task.currentVersion,
            note: requireText(input.note, 'progress note', MAX_TEXT),
            submittedBy: requireText(input.submittedBy, 'submitted by', 200),
            createdAt: this.clock.now(),
        };
        this.results.insertProgress(entry);
        return entry;
    }
    // ---- submission -----------------------------------------------------------
    /**
     * Submit a result.
     *
     * IMPORTANT: this does NOT complete the task. It creates an immutable result version and
     * an open confirmation slot. Only a `complete` review sets completed_at (MVP-025/026).
     *
     * The result records the task version in force NOW, which is what makes "what was asked at
     * the time" answerable after a later revision.
     */
    submit(input) {
        const task = this.requireTask(input.taskId);
        this.requireWritableProject(task.projectId);
        const frozen = frozenReason(task);
        if (frozen !== null) {
            throw new CollaborationError('TASK_FROZEN', `task ${input.taskId} is ${frozen}`, {
                taskId: input.taskId,
                reason: frozen,
            });
        }
        const summary = requireText(input.summary, 'result summary', MAX_TEXT);
        const selfCheck = requireText(input.selfCheck, 'self check', MAX_TEXT);
        // The submitting role must have a member; a submission from nobody is not a submission.
        const role = task.role;
        return inTransaction(this.db, () => {
            const version = this.results.latestResultVersion(input.taskId) + 1;
            const record = {
                resultId: newId(),
                version,
                taskId: input.taskId,
                taskVersion: task.currentVersion,
                summary,
                files: normaliseFiles(input.files),
                selfCheck,
                submittedBy: requireText(input.submittedBy, 'submitted by', 200),
                createdAt: this.clock.now(),
            };
            this.results.insertResult(record);
            // A result opens exactly one review slot, held by the task's own role.
            this.results.createConfirmationSlot(record.resultId, version, role);
            return record;
        });
    }
    // ---- review ---------------------------------------------------------------
    /**
     * The owning role's decision on one result version.
     *
     * `complete` is the ONLY thing that sets the task's completed_at — this is what makes
     * "submitted" and "completed" genuinely different events (MVP-025/026).
     */
    review(input) {
        const existing = this.results.findResultVersion(input.resultId, input.version);
        if (existing === null) {
            throw new CollaborationError('RESULT_NOT_FOUND', `no result ${input.resultId} version ${input.version}`, { resultId: input.resultId, version: input.version });
        }
        // Ensures the task exists before touching its result: an unknown task should be
        // TASK_NOT_FOUND, not a confusing storage error.
        const task = this.requireTask(existing.taskId);
        this.requireWritableProject(task.projectId);
        const slot = this.results.confirmationOf(input.resultId, input.version);
        if (slot === null) {
            throw new CollaborationError('RESULT_NOT_FOUND', 'result has no review slot', {
                resultId: input.resultId,
            });
        }
        // Reviewing is per ROLE, exactly like plan confirmation: naming the wrong one is refused
        // rather than silently accepted, or "the owning role decided" would mean nothing.
        if (slot.role !== input.role) {
            throw new CollaborationError('ROLE_NOT_RELEVANT', `result is reviewed by role ${slot.role}, not ${input.role}`, { expected: slot.role, got: input.role });
        }
        if (slot.outcome !== null) {
            throw new CollaborationError('RESULT_ALREADY_REVIEWED', `result ${input.resultId} version ${input.version} was already reviewed as ${slot.outcome}`, { resultId: input.resultId, version: input.version, outcome: slot.outcome });
        }
        /*
         * Who may review (MVP-019's intent, ADR-0014).
         *
         * The role must have a member AND the caller must be that member. The check reads
         * `declaredMember` — what the SESSION declared — not `submittedBy`, which the caller supplies
         * and could set to whatever the role happens to hold.
         */
        const submittedBy = requireText(input.submittedBy, 'submitted by', 200);
        assertCanActAsRole({
            role: slot.role,
            memberOfRole: this.memberOf(task.projectId, slot.role),
            declaredMember: input.declaredMember ?? null,
        });
        // A return MUST say why: an unexplained rejection cannot be acted on.
        const reason = input.outcome === 'return' ? requireText(input.reason ?? '', 'return reason', MAX_TEXT) : null;
        const at = this.clock.now();
        /*
         * MVP-026: completion must verify that required inputs have been ACCEPTED.
         *
         * This check did not exist before M7 and the omission was real, not theoretical: the
         * probe showed a task completing while its required input had not even been decided —
         * its acceptance slot was still open. Since M7 promises "from a result, see which input
         * versions it actually used" (MVP-031), letting a task finish on unconsumed inputs would
         * have made that promise unkeepable.
         *
         * Checked only for COMPLETION. Returning is always allowed, and a rejection is a
         * legitimate downstream conclusion that must not be blocked.
         */
        if (input.outcome === 'complete') {
            this.requireInputsAccepted(existing.taskId, existing.taskVersion);
        }
        return inTransaction(this.db, () => {
            this.results.recordReview(input.resultId, input.version, input.outcome, reason, submittedBy, at);
            if (input.outcome === 'complete') {
                // Completing opens NO acceptance slot and accepts nothing downstream. Accepting is an
                // independent decision the downstream role makes for itself — MVP-027 states it plainly:
                // "接收是独立决定，不由上游完成自动触发". Opening slots is a separate, explicit
                // `openAcceptances` call so that "the upstream finished" and "the downstream consumed it"
                // stay two distinct, separately-traceable events.
                //
                // The task's completion is written ONLY here.
                this.tasks.markCompleted(existing.taskId, at);
            }
            // A return writes no completion record whatsoever (MVP-026).
            const updated = this.results.findResultVersion(input.resultId, input.version);
            if (updated === null) {
                throw new CollaborationError('INTERNAL', 'result vanished during review', {});
            }
            return updated;
        });
    }
    // ---- acceptance -----------------------------------------------------------
    /**
     * A downstream task's decision on a specific result version.
     *
     * Accepting is NOT automatic: an upstream completion never triggers it (MVP-027). And a
     * rejection creates nothing — no task, no plan, no issue. The upstream must itself decide
     * to go through the plan path if it wants a correction.
     */
    decide(input) {
        const result = this.results.findResultVersion(input.resultId, input.version);
        if (result === null) {
            throw new CollaborationError('RESULT_NOT_FOUND', `no result ${input.resultId} version ${input.version}`, { resultId: input.resultId, version: input.version });
        }
        // The deciding task must exist; whether it owns a slot is checked just below.
        const downstream = this.requireTask(input.taskId);
        const downstreamProject = downstream.projectId;
        this.requireWritableProject(downstreamProject);
        if (input.taskId === result.taskId) {
            throw new CollaborationError('INVALID_ARGUMENT', 'a task cannot accept its own result', { taskId: input.taskId });
        }
        const slot = this.results
            .acceptancesOf(input.resultId, input.version)
            .find((a) => a.taskId === input.taskId);
        if (slot === undefined) {
            throw new CollaborationError('ACCEPTANCE_NOT_OPEN', `task ${input.taskId} has no acceptance slot for this result`, { taskId: input.taskId, resultId: input.resultId });
        }
        if (slot.outcome !== null) {
            throw new CollaborationError('ALREADY_DECIDED', `task ${input.taskId} already ${slot.outcome}ed this result`, { taskId: input.taskId, outcome: slot.outcome });
        }
        /*
         * Who may decide (MVP-019's intent, ADR-0014): the deciding role must have a member, AND
         * the caller must BE that member. The first half alone left the vacancy visible while the
         * identity went unchecked, so any name could carry any role.
         */
        const decidingRole = this.tasks.findById(input.taskId)?.role;
        if (decidingRole === undefined) {
            throw new CollaborationError('TASK_NOT_FOUND', `no task with id ${input.taskId}`, {
                taskId: input.taskId,
            });
        }
        const submittedBy = requireText(input.submittedBy, 'submitted by', 200);
        assertCanActAsRole({
            role: decidingRole,
            memberOfRole: this.memberOf(downstreamProject, decidingRole),
            declaredMember: input.declaredMember ?? null,
        });
        const reason = input.outcome === 'reject' ? requireText(input.reason ?? '', 'rejection reason', MAX_TEXT) : null;
        const at = this.clock.now();
        /*
         * Pin the versions this decision consumes (ADR-0012).
         *
         * `result.taskVersion` is the version of the UPSTREAM task that produced the accepted
         * result — the answer to MVP-031's "which input version did it use". The downstream's own
         * current version is pinned alongside it, because a revision between opening the slot and
         * deciding would otherwise let this record describe a definition never worked to.
         *
         * Both are written for a REJECTION as well, so "refused" stays distinguishable from
         * "never decided" — traceability depends on that difference.
         */
        this.results.recordAcceptance(input.resultId, input.version, input.taskId, input.outcome, reason, submittedBy, at, downstream.currentVersion, result.taskVersion);
        const after = this.results
            .acceptancesOf(input.resultId, input.version)
            .find((a) => a.taskId === input.taskId);
        if (after === undefined) {
            throw new CollaborationError('INTERNAL', 'acceptance vanished', {});
        }
        return after;
    }
    /**
     * Open acceptance slots for a result version.
     *
     * Only tasks that DECLARE this task as a required input get a slot (MVP-023). Opening one
     * for every downstream task would mean each completion stirs the whole graph, when most
     * tasks do not consume the output at all.
     */
    openAcceptances(resultId, version) {
        const result = this.results.findResultVersion(resultId, version);
        if (result === null) {
            throw new CollaborationError('RESULT_NOT_FOUND', `no result ${resultId} version ${version}`, {
                resultId,
                version,
            });
        }
        // Opening slots is a write, so an archived project must not gain new ones.
        this.requireWritableProject(this.requireTask(result.taskId).projectId);
        const dependents = this.tasks.dependentsOf(result.taskId);
        for (const d of dependents) {
            this.results.createAcceptanceSlot(resultId, version, d);
        }
        return dependents;
    }
    // ---- reads ----------------------------------------------------------------
    progressOf(taskId) {
        this.requireTask(taskId);
        return this.results.progressOf(taskId);
    }
    resultsOf(taskId) {
        this.requireTask(taskId);
        return this.results.resultsOf(taskId);
    }
    reviewOf(resultId, version) {
        return this.results.confirmationOf(resultId, version);
    }
    acceptancesOf(resultId, version) {
        return this.results.acceptancesOf(resultId, version);
    }
    acceptancesByTask(taskId) {
        this.requireTask(taskId);
        return this.results.acceptancesByTask(taskId);
    }
    projectOf(taskId) {
        return this.requireTask(taskId).projectId;
    }
    /**
     * Refuse completion while a required input has not been ACCEPTED by this task (MVP-026).
     *
     * A REJECTION does not satisfy this, deliberately: rejecting the upstream deliverable means
     * the upstream has not finished, so this task cannot be finished either. The way out is for
     * the downstream to accept, or for the upstream to correct through the plan path — neither
     * of which needs a new mechanism, so this cannot deadlock (ADR-0012).
     *
     * A task with NO required inputs is unaffected: MVP-023 says such a task may run directly.
     */
    requireInputsAccepted(taskId, taskVersion) {
        const required = this.tasks.dependsOn(taskId, taskVersion);
        if (required.length === 0)
            return;
        const decided = new Map(this.results
            .acceptancesByTask(taskId)
            .filter((a) => a.outcome !== null)
            .map((a) => [a.resultId, a]));
        const unmet = [];
        for (const upstreamTaskId of required) {
            // The upstream may have published several versions; ANY accepted one satisfies the
            // input, because accepting is what pins which version this task consumes (ADR-0012).
            const accepted = [...decided.values()].some((a) => a.outcome === 'accept' && a.acceptedResultTaskVersion !== null && this.resultBelongsTo(a, upstreamTaskId));
            if (accepted)
                continue;
            const refused = [...decided.values()].some((a) => a.outcome === 'reject');
            const task = this.tasks.findById(upstreamTaskId);
            unmet.push({
                ref: task === null ? upstreamTaskId : `${task.role}`,
                why: refused ? 'rejected, not accepted' : 'not accepted yet',
            });
        }
        if (unmet.length > 0) {
            throw new CollaborationError('REQUIRED_INPUT_NOT_ACCEPTED', `cannot complete: required input(s) not accepted — ${unmet
                .map((u) => `${u.ref} (${u.why})`)
                .join(', ')}`, { taskId, unmet });
        }
    }
    /** Whether an acceptance was made against a result produced by a given task. */
    resultBelongsTo(a, upstreamTaskId) {
        const r = this.results.findResultVersion(a.resultId, a.resultVersion);
        return r !== null && r.taskId === upstreamTaskId;
    }
    requireTask(taskId) {
        const task = this.tasks.findById(taskId);
        if (task === null) {
            throw new CollaborationError('TASK_NOT_FOUND', `no task with id ${taskId}`, { taskId });
        }
        return task;
    }
    /**
     * The member holding a role in a project, or null when the slot is vacant.
     *
     * A vacant role cannot decide anything: the project has not said who does that job, so
     * there is nobody whose decision it would be.
     */
    memberOf(projectId, role) {
        const slot = this.projects.rolesOf(projectId).find((r) => r.role === role);
        return slot?.member ?? null;
    }
    /**
     * An archived project is read-only (MVP-005), so every write path must refuse. Progress,
     * result submission and acceptance decisions originally each skipped this check, which let an
     * archived project keep collecting new work.
     */
    requireWritableProject(projectId) {
        assertWritable(this.projects.findById(projectId), projectId);
    }
}
function normaliseFiles(files) {
    if (!Array.isArray(files)) {
        throw new CollaborationError('INVALID_ARGUMENT', 'files must be an array', {});
    }
    return files.map((f) => ({
        relPath: requireText(f.relPath, 'file path', 1_000),
        originalName: requireText(f.originalName, 'file name', 500),
        sha256: requireText(f.sha256, 'file hash', 200),
        sizeBytes: Number(f.sizeBytes),
    }));
}
function requireText(value, field, max) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new CollaborationError('INVALID_ARGUMENT', `${field} is required`, { field });
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new CollaborationError('INVALID_ARGUMENT', `${field} is too long`, {
            field,
            max,
            actual: trimmed.length,
        });
    }
    return trimmed;
}
