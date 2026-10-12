/**
 * Progress, results and acceptance (M5 result layer, ADR-0010).
 *
 * The rules enforced here, all from the requirements:
 *
 *   - saving progress completes nothing and drives nothing (MVP-024)
 *   - SUBMITTING is not COMPLETING: only a review decision sets completed_at (MVP-025/026)
 *   - a return must give a reason and produces no completion record
 *   - completion is not acceptance: each downstream decides separately (MVP-027)
 *   - rejecting records a reason and triggers NOTHING (MVP-027)
 *
 * The last one is the easiest to violate by accident: it is tempting to auto-create a
 * follow-up task on rejection. MVP forbids it, and MVP-016 forbids automatic task creation
 * generally.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectId } from '../domain/project.js';
import { type Acceptance, type AcceptanceOutcome, type ProgressEntry, type ResultFile, type ResultId, type ResultVersion, type ResultVersionRecord, type ReviewOutcome } from '../domain/result.js';
import type { RoleId } from '../domain/roles.js';
import type { TaskId } from '../domain/task.js';
import { type Clock } from './project-service.js';
export interface AddProgressInput {
    readonly taskId: TaskId;
    readonly note: string;
    readonly submittedBy: string;
}
export interface SubmitResultInput {
    readonly taskId: TaskId;
    readonly summary: string;
    readonly files: readonly ResultFile[];
    readonly selfCheck: string;
    readonly submittedBy: string;
}
export interface ReviewInput {
    readonly resultId: ResultId;
    readonly version: ResultVersion;
    readonly outcome: ReviewOutcome;
    readonly reason?: string | null;
    readonly submittedBy: string;
    /** The reviewing role. Cross-checked against the slot, like M4's per-role confirmation. */
    readonly role: RoleId;
    /** What the SESSION declared itself to be; the eligibility check reads this (ADR-0014). */
    readonly declaredMember?: string | null;
}
export interface AcceptInput {
    readonly resultId: ResultId;
    readonly version: ResultVersion;
    readonly taskId: TaskId;
    readonly outcome: AcceptanceOutcome;
    readonly reason?: string | null;
    readonly submittedBy: string;
    /** What the SESSION declared itself to be; the eligibility check reads this (ADR-0014). */
    readonly declaredMember?: string | null;
}
export declare class ResultService {
    private readonly db;
    private readonly clock;
    private readonly results;
    private readonly tasks;
    private readonly projects;
    constructor(db: DatabaseSync, clock?: Clock);
    /**
     * Add a progress note.
     *
     * The note records the CURRENT task version at the time it was written, so progress
     * written against different requirements never mixes (ADR-0010).
     */
    addProgress(input: AddProgressInput): ProgressEntry;
    /**
     * Submit a result.
     *
     * IMPORTANT: this does NOT complete the task. It creates an immutable result version and
     * an open confirmation slot. Only a `complete` review sets completed_at (MVP-025/026).
     *
     * The result records the task version in force NOW, which is what makes "what was asked at
     * the time" answerable after a later revision.
     */
    submit(input: SubmitResultInput): ResultVersionRecord;
    /**
     * The owning role's decision on one result version.
     *
     * `complete` is the ONLY thing that sets the task's completed_at — this is what makes
     * "submitted" and "completed" genuinely different events (MVP-025/026).
     */
    review(input: ReviewInput): ResultVersionRecord;
    /**
     * A downstream task's decision on a specific result version.
     *
     * Accepting is NOT automatic: an upstream completion never triggers it (MVP-027). And a
     * rejection creates nothing — no task, no plan, no issue. The upstream must itself decide
     * to go through the plan path if it wants a correction.
     */
    decide(input: AcceptInput): Acceptance;
    /**
     * Open acceptance slots for a result version.
     *
     * Only tasks that DECLARE this task as a required input get a slot (MVP-023). Opening one
     * for every downstream task would mean each completion stirs the whole graph, when most
     * tasks do not consume the output at all.
     */
    openAcceptances(resultId: ResultId, version: ResultVersion): readonly TaskId[];
    progressOf(taskId: TaskId): readonly ProgressEntry[];
    resultsOf(taskId: TaskId): readonly ResultVersionRecord[];
    reviewOf(resultId: ResultId, version: ResultVersion): import("../domain/result.js").ResultConfirmation | null;
    acceptancesOf(resultId: ResultId, version: ResultVersion): readonly Acceptance[];
    acceptancesByTask(taskId: TaskId): readonly Acceptance[];
    projectOf(taskId: TaskId): ProjectId;
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
    private requireInputsAccepted;
    /** Whether an acceptance was made against a result produced by a given task. */
    private resultBelongsTo;
    private requireTask;
    /**
     * The member holding a role in a project, or null when the slot is vacant.
     *
     * A vacant role cannot decide anything: the project has not said who does that job, so
     * there is nobody whose decision it would be.
     */
    private memberOf;
    /**
     * An archived project is read-only (MVP-005), so every write path must refuse. Progress,
     * result submission and acceptance decisions originally each skipped this check, which let an
     * archived project keep collecting new work.
     */
    private requireWritableProject;
}
