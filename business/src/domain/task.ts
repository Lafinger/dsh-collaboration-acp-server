/**
 * Tasks and task versions (M5, identity layer).
 *
 * A task is an execution unit that OUTLIVES the plan that created it. A plan proposes
 * changes; the task is the durable thing being changed (ADR-0008).
 *
 * Two identifiers coexist and are NOT interchangeable:
 *   - `ref`  — a name scoped to ONE plan version, so dependencies can point at tasks that
 *              do not exist yet. It is not an identity.
 *   - `id`   — the task's identity, stable across every version it ever has.
 *
 * Deliberately absent from a task version: who executes it. That is derived from the role
 * and the project's members, so storing it would go stale the moment someone is replaced.
 */
import type { PlanId, PlanVersion, TaskChange } from './plan.js'
import type { ProjectId } from './project.js'
import type { RoleId } from './roles.js'

export type TaskId = string
export type TaskVersion = number

export type { TaskChange }

/**
 * One snapshot of a task's definition.
 *
 * Append-only: a later version never overwrites an earlier one, because a result records
 * the task version it was produced under and that reference must stay resolvable.
 */
export interface TaskVersionRecord {
  readonly taskId: TaskId
  readonly version: TaskVersion
  /** What the task is. */
  readonly content: string
  /** What must be handed in, as free text. Display-only; see ADR-0010. */
  readonly requiredResults: string | null
  /** What "done" means, as free text. Nothing validates against it in the MVP. */
  readonly completionCriteria: string | null
  /** Refs of other tasks in the SAME plan version whose output this one needs. */
  readonly dependsOn: readonly string[]
  /** The plan version that produced this task version. */
  readonly createdByPlanId: PlanId
  readonly createdByPlanVersion: PlanVersion
  readonly createdAt: string
}

/** A task at its current version, with its history. */
export interface Task {
  readonly id: TaskId
  readonly projectId: ProjectId
  /** Which role owns it. People are resolved from this, not stored. */
  readonly role: RoleId
  readonly currentVersion: TaskVersion
  readonly createdAt: string
  /** Set when a plan terminated it. A task can be cancelled without ever completing. */
  readonly cancelledAt: string | null
  readonly cancelledByPlanId: PlanId | null
  /**
   * Set when the task is completed. Not produced by this layer — nothing here advances a
   * task — but the column exists so completion and cancellation are distinguishable
   * terminal states rather than "some flag or other".
   */
  readonly completedAt: string | null
}

export interface TaskWithVersions {
  readonly task: Task
  /** Oldest first. Every version ever written is here. */
  readonly versions: readonly TaskVersionRecord[]
  /** The version the task currently points at. */
  readonly current: TaskVersionRecord
}

/** One line of the activation ledger: which ref became which task. */
export interface TaskOutcome {
  readonly planId: PlanId
  readonly planVersion: PlanVersion
  /** The ref used INSIDE that plan version. */
  readonly ref: string
  readonly change: TaskChange
  readonly taskId: TaskId
  readonly taskVersion: TaskVersion
}

/** The resolved result of applying one proposal during activation. */
export interface ResolvedTask {
  readonly taskId: TaskId
  readonly role: RoleId
  readonly version: TaskVersionRecord
}

export function isCancelled(task: Task): boolean {
  return task.cancelledAt !== null
}

export function isCompleted(task: Task): boolean {
  return task.completedAt !== null
}

/**
 * A task that can no longer be changed.
 *
 * Both terminal states freeze the definition, for the same reason: the record of what was
 * asked must not move under the feet of what was delivered. Restoring means creating a NEW
 * task, not un-cancelling or un-completing this one.
 */
export function isFrozen(task: Task): boolean {
  return isCancelled(task) || isCompleted(task)
}

export function frozenReason(task: Task): 'cancelled' | 'completed' | null {
  if (isCancelled(task)) return 'cancelled'
  if (isCompleted(task)) return 'completed'
  return null
}
