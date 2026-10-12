/**
 * Task persistence. Reads and writes only (ADR-0002).
 *
 * Every write happens inside the caller's transaction: activation spans plans AND tasks, so
 * the repository must never open a transaction of its own.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { PlanId, PlanVersion, TaskChange } from '../domain/plan.js'
import type { RoleId } from '../domain/roles.js'
import type {
  Task,
  TaskId,
  TaskOutcome,
  TaskVersion,
  TaskVersionRecord,
  TaskWithVersions,
} from '../domain/task.js'
import type { ProjectId } from '../domain/project.js'

interface TaskRow {
  readonly id: string
  readonly project_id: string
  readonly role: string
  readonly current_version: number
  readonly created_at: string
  readonly cancelled_at: string | null
  readonly cancelled_by_plan_id: string | null
  readonly completed_at: string | null
}

interface VersionRow {
  readonly task_id: string
  readonly version: number
  readonly content: string
  readonly required_results: string | null
  readonly completion_criteria: string | null
  readonly created_by_plan_id: string
  readonly created_by_plan_version: number
  readonly created_at: string
}

export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertTask(task: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks
           (id, project_id, role, current_version, created_at, cancelled_at, cancelled_by_plan_id, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.projectId,
        task.role,
        task.currentVersion,
        task.createdAt,
        task.cancelledAt,
        task.cancelledByPlanId,
        task.completedAt,
      )
  }

  /**
   * Append a version and advance the task's current pointer.
   *
   * The pointer lives on `tasks` so "what is the current definition" is one lookup, while
   * the versions themselves stay append-only.
   */
  insertVersion(
    record: TaskVersionRecord,
    dependsOnTaskIds: readonly TaskId[],
    isNewTask: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT INTO task_versions
           (task_id, version, content, required_results, completion_criteria,
            created_by_plan_id, created_by_plan_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.taskId,
        record.version,
        record.content,
        record.requiredResults,
        record.completionCriteria,
        record.createdByPlanId,
        record.createdByPlanVersion,
        record.createdAt,
      )

    const dep = this.db.prepare(
      'INSERT INTO task_version_deps (task_id, version, depends_on_task_id, position) VALUES (?, ?, ?, ?)',
    )
    dependsOnTaskIds.forEach((id, i) => dep.run(record.taskId, record.version, id, i))

    if (isNewTask) {
      // The INSERT already carried version 1; nothing to advance.
      return
    }
    this.db
      .prepare('UPDATE tasks SET current_version = ? WHERE id = ?')
      .run(record.version, record.taskId)
  }

  cancel(taskId: TaskId, planId: PlanId, at: string): void {
    this.db
      .prepare('UPDATE tasks SET cancelled_at = ?, cancelled_by_plan_id = ? WHERE id = ?')
      .run(at, planId, taskId)
  }

  /**
   * Record completion.
   *
   * Called from exactly ONE place — the review that decides `complete` — because completion
   * is a consequence of confirmation, never of submission (MVP-025).
   */
  markCompleted(taskId: TaskId, at: string): void {
    this.db.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?').run(at, taskId)
  }

  findById(taskId: TaskId): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as unknown as
      | TaskRow
      | undefined
    return row === undefined ? null : hydrateTask(row)
  }

  listByProject(projectId: ProjectId): readonly Task[] {
    const rows = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, id ASC')
      .all(projectId) as unknown as TaskRow[]
    return rows.map(hydrateTask)
  }

  findVersion(taskId: TaskId, version: TaskVersion): TaskVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_versions WHERE task_id = ? AND version = ?')
      .get(taskId, version) as unknown as VersionRow | undefined
    return row === undefined ? null : this.hydrateVersion(row)
  }

  versionsOf(taskId: TaskId): readonly TaskVersionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM task_versions WHERE task_id = ? ORDER BY version ASC')
      .all(taskId) as unknown as VersionRow[]
    return rows.map((r) => this.hydrateVersion(r))
  }

  withVersions(taskId: TaskId): TaskWithVersions | null {
    const task = this.findById(taskId)
    if (task === null) return null
    const versions = this.versionsOf(taskId)
    const current = versions.find((v) => v.version === task.currentVersion)
    if (current === undefined) {
      // The pointer must always resolve; a missing one means the data is inconsistent.
      return null
    }
    return { task, versions, current }
  }

  /** Ids a task version depends on, in declaration order. */
  dependsOn(taskId: TaskId, version: TaskVersion): readonly TaskId[] {
    return (
      this.db
        .prepare(
          'SELECT depends_on_task_id FROM task_version_deps WHERE task_id = ? AND version = ? ORDER BY position',
        )
        .all(taskId, version) as unknown as { depends_on_task_id: string }[]
    ).map((r) => r.depends_on_task_id)
  }

  /** Every task that depends on the given task at ANY version. Used to refuse a cancel. */
  dependentsOf(taskId: TaskId): readonly TaskId[] {
    return (
      this.db
        .prepare('SELECT DISTINCT task_id FROM task_version_deps WHERE depends_on_task_id = ?')
        .all(taskId) as unknown as { task_id: string }[]
    ).map((r) => r.task_id)
  }

  recordOutcome(outcome: TaskOutcome): void {
    this.db
      .prepare(
        `INSERT INTO plan_task_outcomes (plan_id, plan_version, ref, change, task_id, task_version)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        outcome.planId,
        outcome.planVersion,
        outcome.ref,
        outcome.change,
        outcome.taskId,
        outcome.taskVersion,
      )
  }

  outcomesOfPlan(planId: PlanId, version: PlanVersion): readonly TaskOutcome[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM plan_task_outcomes WHERE plan_id = ? AND plan_version = ? ORDER BY ref',
        )
        .all(planId, version) as unknown as {
        plan_id: string
        plan_version: number
        ref: string
        change: string
        task_id: string
        task_version: number
      }[]
    ).map((r) => ({
      planId: r.plan_id,
      planVersion: Number(r.plan_version),
      ref: r.ref,
      change: r.change as TaskChange,
      taskId: r.task_id,
      taskVersion: Number(r.task_version),
    }))
  }

  /** Which plan created this task. The ledger is the only record of the ref resolution. */
  creatorOf(taskId: TaskId): TaskOutcome | null {
    const row = this.db
      .prepare(
        "SELECT * FROM plan_task_outcomes WHERE task_id = ? AND change = 'add' ORDER BY plan_version ASC LIMIT 1",
      )
      .get(taskId) as unknown as
      | {
          plan_id: string
          plan_version: number
          ref: string
          change: string
          task_id: string
          task_version: number
        }
      | undefined
    if (row === undefined) return null
    return {
      planId: row.plan_id,
      planVersion: Number(row.plan_version),
      ref: row.ref,
      change: row.change as TaskChange,
      taskId: row.task_id,
      taskVersion: Number(row.task_version),
    }
  }

  private hydrateVersion(row: VersionRow): TaskVersionRecord {
    return {
      taskId: row.task_id,
      version: Number(row.version),
      content: row.content,
      requiredResults: row.required_results,
      completionCriteria: row.completion_criteria,
      dependsOn: this.dependsOn(row.task_id, Number(row.version)).map((id) => id),
      createdByPlanId: row.created_by_plan_id,
      createdByPlanVersion: Number(row.created_by_plan_version),
      createdAt: row.created_at,
    }
  }
}

function hydrateTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    role: row.role as RoleId,
    currentVersion: Number(row.current_version),
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    cancelledByPlanId: row.cancelled_by_plan_id,
    completedAt: row.completed_at,
  }
}

export type { TaskId, TaskVersion }
