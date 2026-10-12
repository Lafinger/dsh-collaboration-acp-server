/**
 * Plan and confirmation persistence. Reads and writes only (ADR-0002).
 *
 * Every write here happens inside the caller's transaction. The repository never opens one
 * of its own — activation must be able to span several of these calls atomically.
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  ConfirmationOutcome,
  ConfirmationSlot,
  Plan,
  PlanId,
  PlanVersion,
  PlannedTask,
  TaskChange,
} from '../domain/plan.js'
import type { RoleId } from '../domain/roles.js'
import type { ProjectId } from '../domain/project.js'

interface PlanRow {
  readonly id: string
  readonly project_id: string
  readonly version: number
  readonly title: string
  readonly roles_reason: string
  readonly roles_overridden: number
  readonly proposed_roles: string | null
  readonly source_analysis_id: string | null
  readonly activated_at: string | null
  readonly created_at: string
}

interface ConfirmationRow {
  readonly id: string
  readonly plan_id: string
  readonly plan_version: number
  readonly role: string
  readonly outcome: string | null
  readonly reason: string | null
  readonly submitted_by: string | null
  readonly decided_at: string | null
  readonly voided_at: string | null
  readonly void_reason: string | null
}

export class PlanRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Insert a plan version with its roles, tasks, dependencies and undecided marks.
   *
   * Takes the MAX version + 1 itself rather than trusting a caller-supplied number, the
   * same discipline as material versions: the version must be allocated where the write
   * happens or two concurrent revisions collide.
   */
  nextVersion(planId: PlanId): PlanVersion {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM plans WHERE id = ?')
      .get(planId) as { v: number } | undefined
    return Number(row?.v ?? 0) + 1
  }

  insertPlan(plan: Plan): void {
    this.db
      .prepare(
        `INSERT INTO plans
           (id, project_id, version, title, roles_reason, roles_overridden, proposed_roles,
            source_analysis_id, activated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.projectId,
        plan.version,
        plan.title,
        plan.rolesReason,
        plan.rolesOverridden ? 1 : 0,
        plan.proposedRoles === null ? null : JSON.stringify([...plan.proposedRoles]),
        plan.sourceAnalysisId,
        plan.activatedAt,
        plan.createdAt,
      )

    const role = this.db.prepare(
      'INSERT INTO plan_roles (plan_id, version, role, position) VALUES (?, ?, ?, ?)',
    )
    plan.relevantRoles.forEach((r, i) => role.run(plan.id, plan.version, r, i))

    const task = this.db.prepare(
      `INSERT INTO plan_tasks
         (plan_id, version, ref, task_id, role, change, content, position, required_results, completion_criteria)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const dep = this.db.prepare(
      'INSERT INTO plan_task_deps (plan_id, version, task_ref, depends_on) VALUES (?, ?, ?, ?)',
    )
    plan.tasks.forEach((t, i) => {
      task.run(
        plan.id, plan.version, t.ref, t.taskId, t.role, t.change, t.content, i,
        t.requiredResults ?? null, t.completionCriteria ?? null,
      )
      for (const d of t.dependsOn) dep.run(plan.id, plan.version, t.ref, d)
    })

    const undecided = this.db.prepare(
      'INSERT INTO plan_undecided (plan_id, version, position, text) VALUES (?, ?, ?, ?)',
    )
    plan.undecided.forEach((text, i) => undecided.run(plan.id, plan.version, i, text))
  }

  /** The latest version of a plan, which is the only one that can still change. */
  findLatest(planId: PlanId): Plan | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE id = ? ORDER BY version DESC LIMIT 1')
      .get(planId) as unknown as PlanRow | undefined
    return row === undefined ? null : this.hydrate(row)
  }

  findVersion(planId: PlanId, version: PlanVersion): Plan | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE id = ? AND version = ?')
      .get(planId, version) as unknown as PlanRow | undefined
    return row === undefined ? null : this.hydrate(row)
  }

  /** Every version, oldest first — the revision history stays visible (MVP-021). */
  listVersions(planId: PlanId): readonly Plan[] {
    const rows = this.db
      .prepare('SELECT * FROM plans WHERE id = ? ORDER BY version ASC')
      .all(planId) as unknown as PlanRow[]
    return rows.map((r) => this.hydrate(r))
  }

  listByProject(projectId: ProjectId): readonly Plan[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM plans p
         JOIN (SELECT id, MAX(version) AS v FROM plans WHERE project_id = ? GROUP BY id) latest
           ON latest.id = p.id AND latest.v = p.version
         ORDER BY p.created_at ASC, p.id ASC`,
      )
      .all(projectId) as unknown as PlanRow[]
    return rows.map((r) => this.hydrate(r))
  }

  slotsOf(planId: PlanId, version: PlanVersion): readonly ConfirmationSlot[] {
    const rows = this.db
      .prepare('SELECT * FROM confirmations WHERE plan_id = ? AND plan_version = ? ORDER BY role')
      .all(planId, version) as unknown as ConfirmationRow[]
    return rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      planVersion: Number(r.plan_version),
      role: r.role as RoleId,
      outcome: (r.outcome as ConfirmationOutcome | null) ?? null,
      reason: r.reason,
      submittedBy: r.submitted_by,
      decidedAt: r.decided_at,
      voidedAt: r.voided_at,
      voidReason: r.void_reason,
    }))
  }

  /** All slots across all versions — used to prove voided confirmations were kept. */
  allSlots(planId: PlanId): readonly ConfirmationSlot[] {
    const rows = this.db
      .prepare('SELECT * FROM confirmations WHERE plan_id = ? ORDER BY plan_version, role')
      .all(planId) as unknown as ConfirmationRow[]
    return rows.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      planVersion: Number(r.plan_version),
      role: r.role as RoleId,
      outcome: (r.outcome as ConfirmationOutcome | null) ?? null,
      reason: r.reason,
      submittedBy: r.submitted_by,
      decidedAt: r.decided_at,
      voidedAt: r.voided_at,
      voidReason: r.void_reason,
    }))
  }

  createSlot(
    id: string,
    planId: PlanId,
    version: PlanVersion,
    role: RoleId,
  ): void {
    this.db
      .prepare(
        `INSERT INTO confirmations (id, plan_id, plan_version, role, outcome, reason, submitted_by, decided_at, voided_at, void_reason)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(id, planId, version, role)
  }

  /** Void (not delete) every live slot of a version. Returns how many were voided. */
  voidSlots(planId: PlanId, version: PlanVersion, at: string, reason: string): number {
    const result = this.db
      .prepare(
        `UPDATE confirmations SET voided_at = ?, void_reason = ?
         WHERE plan_id = ? AND plan_version = ? AND voided_at IS NULL`,
      )
      .run(at, reason, planId, version)
    return Number(result.changes)
  }

  recordDecision(
    planId: PlanId,
    version: PlanVersion,
    role: RoleId,
    outcome: ConfirmationOutcome,
    reason: string | null,
    submittedBy: string,
    at: string,
  ): void {
    this.db
      .prepare(
        `UPDATE confirmations
            SET outcome = ?, reason = ?, submitted_by = ?, decided_at = ?
          WHERE plan_id = ? AND plan_version = ? AND role = ?`,
      )
      .run(outcome, reason, submittedBy, at, planId, version, role)
  }

  activate(planId: PlanId, version: PlanVersion, at: string, roles: readonly RoleId[]): void {
    this.db
      .prepare('UPDATE plans SET activated_at = ? WHERE id = ? AND version = ?')
      .run(at, planId, version)
    this.db
      .prepare(
        'INSERT INTO plan_activations (plan_id, plan_version, activated_at, roles) VALUES (?, ?, ?, ?)',
      )
      .run(planId, version, at, JSON.stringify([...roles]))
  }

  activationOf(planId: PlanId): { version: number; at: string; roles: readonly string[] } | null {
    const row = this.db
      .prepare('SELECT * FROM plan_activations WHERE plan_id = ?')
      .get(planId) as unknown as { plan_version: number; activated_at: string; roles: string } | undefined
    if (row === undefined) return null
    return {
      version: Number(row.plan_version),
      at: row.activated_at,
      roles: JSON.parse(row.roles) as string[],
    }
  }

  private hydrate(row: PlanRow): Plan {
    const roles = (
      this.db
        .prepare('SELECT role FROM plan_roles WHERE plan_id = ? AND version = ? ORDER BY position')
        .all(row.id, row.version) as unknown as { role: string }[]
    ).map((r) => r.role as RoleId)

    const taskRows = this.db
      .prepare(
        `SELECT ref, task_id, role, change, content, required_results, completion_criteria
           FROM plan_tasks WHERE plan_id = ? AND version = ? ORDER BY position`,
      )
      .all(row.id, row.version) as unknown as {
      ref: string
      task_id: string | null
      role: string
      change: string
      content: string
      required_results: string | null
      completion_criteria: string | null
    }[]

    const depsByRef = new Map<string, string[]>()
    for (const d of this.db
      .prepare('SELECT task_ref, depends_on FROM plan_task_deps WHERE plan_id = ? AND version = ?')
      .all(row.id, row.version) as unknown as { task_ref: string; depends_on: string }[]) {
      const list = depsByRef.get(d.task_ref) ?? []
      list.push(d.depends_on)
      depsByRef.set(d.task_ref, list)
    }

    const tasks: PlannedTask[] = taskRows.map((t) => ({
      ref: t.ref,
      taskId: t.task_id,
      role: t.role as RoleId,
      change: t.change as TaskChange,
      content: t.content,
      requiredResults: t.required_results,
      completionCriteria: t.completion_criteria,
      dependsOn: depsByRef.get(t.ref) ?? [],
    }))

    const undecided = (
      this.db
        .prepare('SELECT text FROM plan_undecided WHERE plan_id = ? AND version = ? ORDER BY position')
        .all(row.id, row.version) as unknown as { text: string }[]
    ).map((r) => r.text)

    return {
      id: row.id,
      projectId: row.project_id,
      version: Number(row.version),
      title: row.title,
      relevantRoles: roles,
      rolesReason: row.roles_reason,
      rolesOverridden: Number(row.roles_overridden) === 1,
      proposedRoles:
        row.proposed_roles === null ? null : (JSON.parse(row.proposed_roles) as RoleId[]),
      tasks,
      undecided,
      sourceAnalysisId: row.source_analysis_id,
      activatedAt: row.activated_at,
      createdAt: row.created_at,
    }
  }
}
