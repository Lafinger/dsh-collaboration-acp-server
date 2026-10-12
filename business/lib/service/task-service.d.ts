/**
 * Tasks and the activation resolver (M5 identity layer, ADR-0009).
 *
 * This layer creates tasks and versions them. It deliberately lets NOTHING advance a task:
 * there is no progress, no submission, no completion here. A task created by an activated
 * plan can be read, and that is all.
 *
 * The one interesting operation is `applyActivation`, which turns a plan's proposals into
 * real tasks. Two of its properties are load-bearing:
 *
 *   1. It runs in TWO passes. Dependencies may point at tasks created in the same
 *      activation, so every `add` must exist before any dependency is resolved.
 *   2. It re-validates what registration already checked, because STATE CHANGES during the
 *      window in which confirmations are collected. Without the second check, a plan could
 *      modify a task that was completed while the plan waited — breaking the freeze.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Plan, PlanId, PlanVersion, TaskChange } from '../domain/plan.js';
import type { ProjectId } from '../domain/project.js';
import { type Task, type TaskId, type TaskVersionRecord, type TaskWithVersions } from '../domain/task.js';
import { type Clock } from './project-service.js';
/** The outcome of applying one plan version's proposals. */
export interface ActivationResult {
    readonly created: readonly TaskId[];
    readonly modified: readonly TaskId[];
    readonly cancelled: readonly TaskId[];
}
export declare class TaskService {
    private readonly clock;
    private readonly tasks;
    constructor(db: DatabaseSync, clock?: Clock);
    /**
     * Apply an activated plan's proposals to real tasks.
     *
     * MUST be called inside the activation transaction. Any part of this escaping the
     * transaction would allow a half-activated plan.
     */
    applyActivation(plan: Plan): ActivationResult;
    /**
     * Resolve a version's dependencies and write it.
     *
     * A `depends_on` entry may name a ref created in THIS activation, so resolution goes
     * through refToTask first and falls back to an already-existing task id.
     */
    private writeVersion;
    /** The project owning a task, or null when there is no such task. */
    findTask(taskId: string): string | null;
    get(taskId: TaskId): TaskWithVersions;
    listByProject(projectId: ProjectId): readonly TaskWithVersions[];
    versionsOf(taskId: TaskId): readonly TaskVersionRecord[];
    /** Which plan created a task. Answered from the ledger, never guessed. */
    creatorOf(taskId: TaskId): import("../domain/task.js").TaskOutcome | null;
    /** The ledger for one plan version: what each ref became. */
    outcomesOf(planId: PlanId, version: PlanVersion): readonly import("../domain/task.js").TaskOutcome[];
    /** Does this project have any task at all? Used by tests and status views. */
    countByProject(projectId: ProjectId): number;
}
export type { Task, TaskId, TaskChange };
