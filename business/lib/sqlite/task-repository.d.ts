/**
 * Task persistence. Reads and writes only (ADR-0002).
 *
 * Every write happens inside the caller's transaction: activation spans plans AND tasks, so
 * the repository must never open a transaction of its own.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PlanId, PlanVersion } from '../domain/plan.js';
import type { Task, TaskId, TaskOutcome, TaskVersion, TaskVersionRecord, TaskWithVersions } from '../domain/task.js';
import type { ProjectId } from '../domain/project.js';
export declare class TaskRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    insertTask(task: Task): void;
    /**
     * Append a version and advance the task's current pointer.
     *
     * The pointer lives on `tasks` so "what is the current definition" is one lookup, while
     * the versions themselves stay append-only.
     */
    insertVersion(record: TaskVersionRecord, dependsOnTaskIds: readonly TaskId[], isNewTask: boolean): void;
    cancel(taskId: TaskId, planId: PlanId, at: string): void;
    /**
     * Record completion.
     *
     * Called from exactly ONE place — the review that decides `complete` — because completion
     * is a consequence of confirmation, never of submission (MVP-025).
     */
    markCompleted(taskId: TaskId, at: string): void;
    findById(taskId: TaskId): Task | null;
    listByProject(projectId: ProjectId): readonly Task[];
    findVersion(taskId: TaskId, version: TaskVersion): TaskVersionRecord | null;
    versionsOf(taskId: TaskId): readonly TaskVersionRecord[];
    withVersions(taskId: TaskId): TaskWithVersions | null;
    /** Ids a task version depends on, in declaration order. */
    dependsOn(taskId: TaskId, version: TaskVersion): readonly TaskId[];
    /** Every task that depends on the given task at ANY version. Used to refuse a cancel. */
    dependentsOf(taskId: TaskId): readonly TaskId[];
    recordOutcome(outcome: TaskOutcome): void;
    outcomesOfPlan(planId: PlanId, version: PlanVersion): readonly TaskOutcome[];
    /** Which plan created this task. The ledger is the only record of the ref resolution. */
    creatorOf(taskId: TaskId): TaskOutcome | null;
    private hydrateVersion;
}
export type { TaskId, TaskVersion };
