/**
 * Plan confirmation (M4). The MVP's only gate.
 *
 * The rule is one sentence: every relevant role must agree, and until it does, nothing
 * happens. Everything below exists to keep that sentence true under pressure:
 *
 *   - A confirmation belongs to a ROLE, never to a person. One person holding two roles
 *     must submit twice, or "all roles agreed" would be vacuously satisfiable.
 *   - A vacant role WAITS. It never passes, and no other role may stand in for it.
 *   - Activation happens in ONE transaction, so there is no half-active plan.
 *   - A revision VOIDS prior confirmations rather than deleting them. The history of what
 *     was agreed before the change is what makes the change auditable.
 */
import type { DatabaseSync } from 'node:sqlite'
import { WorkbenchError } from '../domain/error.js'
import { newId } from '../domain/ids.js'
import type { ProjectId } from '../domain/project.js'
import { assertCanActAsRole } from '../domain/project.js'
import { isRoleId, type RoleId } from '../domain/roles.js'
import {
  gateStateOf,
  type ConfirmInput,
  type ConfirmationSlot,
  type GateState,
  type Plan,
  type PlanId,
  type PlannedTask,
  type PlanWithSlots,
  type RegisterPlanInput,
  type RevisePlanInput,
  type TaskChange,
} from '../domain/plan.js'
import { PlanRepository } from '../sqlite/plan-repository.js'
import { ProjectRepository } from '../sqlite/project-repository.js'
import { inTransaction } from '../sqlite/schema.js'
import { systemClock, type Clock } from './project-service.js'

const MAX_TITLE = 300
const MAX_REASON = 2000
const MAX_CONTENT = 4000
const MAX_TASKS = 200
const MAX_ROLES = 9

const CHANGES: readonly TaskChange[] = ['add', 'modify', 'cancel']

/**
 * What the plan layer needs from the task layer: apply this plan's proposals.
 *
 * Declared structurally so `plan-service` does not import `task-service`, avoiding a cycle
 * while still letting the plan layer drive task creation.
 */
export interface TaskActivator {
  applyActivation(plan: Plan): unknown
  /** Project id owning a task, or null if there is no such task. Used to validate deps. */
  findTask(taskId: string): string | null
}

export class PlanService {
  private readonly plans: PlanRepository
  private readonly projects: ProjectRepository
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
    /**
     * Turns this plan's proposals into real tasks at activation (ADR-0009).
     *
     * Injected rather than constructed here so the direction of dependency stays one-way:
     * the plan layer drives task creation, the task layer knows nothing about plans.
     * Optional so the M4 tests that predate tasks keep working unchanged.
     */
    private readonly tasks: TaskActivator | null = null,
  ) {
    this.plans = new PlanRepository(db)
    this.projects = new ProjectRepository(db)
  }

  /**
   * Register a plan from an analysis.
   *
   * Dependency cycles are rejected HERE, at registration, before any confirmation has been
   * collected — which is the cheapest possible moment to find them (MVP-017).
   */
  register(input: RegisterPlanInput): PlanWithSlots {
    const project = this.requireProject(input.projectId)
    const draft = validateDraft(input, {
      projectId: input.projectId,
      findTask: (id) => this.tasks?.findTask(id) ?? null,
    })

    return inTransaction(this.db, () => {
      const id = newId() // plan identity, stable across all its versions
      const plan: Plan = {
        id,
        projectId: project.id,
        version: 1,
        title: draft.title,
        relevantRoles: draft.roles,
        rolesReason: draft.rolesReason,
        rolesOverridden: draft.overridden,
        proposedRoles: draft.proposedRoles,
        tasks: draft.tasks,
        undecided: draft.undecided,
        sourceAnalysisId: input.sourceAnalysisId ?? null,
        activatedAt: null,
        createdAt: this.clock.now(),
      }

      this.plans.insertPlan(plan)
      for (const role of plan.relevantRoles) {
        this.plans.createSlot(newId(), plan.id, plan.version, role)
      }
      return this.view(plan)
    })
  }

  /**
   * Revise a plan into a NEW version.
   *
   * Allowed at any time, including with confirmations already collected (MVP-021):
   * forbidding it while the gate is open would freeze the plan exactly when it most needs
   * correcting. The cost is that every prior confirmation is voided.
   */
  revise(input: RevisePlanInput): PlanWithSlots {
    const latest = this.plans.findLatest(input.planId)
    if (latest === null) {
      throw new WorkbenchError('PLAN_NOT_FOUND', `no plan with id ${input.planId}`, { id: input.planId })
    }
    if (latest.activatedAt !== null) {
      throw new WorkbenchError(
        'PLAN_ALREADY_ACTIVE',
        `plan ${input.planId} is already active and cannot be revised`,
        { id: input.planId, version: latest.version },
      )
    }

    const reason = requireText(input.reason, 'revision reason', MAX_REASON)
    const existingPlan = this.plans.findLatest(input.planId)
    if (existingPlan === null) {
      throw new WorkbenchError('PLAN_NOT_FOUND', `no plan with id ${input.planId}`, {
        id: input.planId,
      })
    }
    const draft = validateDraft(input, {
      projectId: existingPlan.projectId,
      findTask: (id) => this.tasks?.findTask(id) ?? null,
    })
    const at = this.clock.now()

    return inTransaction(this.db, () => {
      const version = this.plans.nextVersion(input.planId)
      const revised: Plan = {
        id: latest.id,
        projectId: latest.projectId,
        version,
        title: draft.title,
        relevantRoles: draft.roles,
        rolesReason: draft.rolesReason,
        rolesOverridden: draft.overridden,
        proposedRoles: draft.proposedRoles,
        tasks: draft.tasks,
        undecided: draft.undecided,
        sourceAnalysisId: latest.sourceAnalysisId,
        activatedAt: null,
        createdAt: at,
      }

      // Void first, then append: the old version's slots stay as evidence, and the new
      // version starts from nothing collected.
      this.plans.voidSlots(input.planId, latest.version, at, reason)
      this.plans.insertPlan(revised)
      for (const role of revised.relevantRoles) {
        this.plans.createSlot(newId(), revised.id, version, role)
      }
      return this.view(revised)
    })
  }

  /**
   * Record one role's decision on the latest version.
   *
   * MVP-019 says a plan is confirmed "由该角色的成员" — by THAT ROLE'S MEMBER. So this asks two
   * things, not one: that the role has a member, AND that the caller IS that member (ADR-0014).
   *
   * `submittedBy` remains a snapshot for the record, but it must agree with what the session
   * declared. Keeping the parameter while checking it stops a caller from silently recording a
   * decision under a name it invented, which is exactly how nine fabricated members once
   * confirmed a nine-role plan.
   */
  confirm(input: ConfirmInput): PlanWithSlots {
    const latest = this.plans.findLatest(input.planId)
    if (latest === null) {
      throw new WorkbenchError('PLAN_NOT_FOUND', `no plan with id ${input.planId}`, { id: input.planId })
    }
    if (!isRoleId(input.role)) {
      throw new WorkbenchError('ROLE_UNKNOWN', `unknown role: ${String(input.role)}`, { role: input.role })
    }
    if (!latest.relevantRoles.includes(input.role)) {
      throw new WorkbenchError(
        'ROLE_NOT_RELEVANT',
        `role "${input.role}" is not among this plan's relevant roles`,
        { role: input.role, relevantRoles: [...latest.relevantRoles] },
      )
    }
    if (latest.activatedAt !== null) {
      throw new WorkbenchError(
        'PLAN_ALREADY_ACTIVE',
        `plan ${input.planId} is already active`,
        { id: input.planId },
      )
    }

    /*
     * Who may confirm (MVP-019, ADR-0014).
     *
     * Two distinct questions, and both must be asked:
     *   - does the role HAVE a member?  (a vacant role waits, it is not carried by whoever calls)
     *   - IS THE CALLER that member?    (otherwise any name confirms any role)
     *
     * Only the first was asked before, which made "confirmed by that role's member" a sentence
     * with no implementation behind it.
     *
     * The check reads `declaredMember` — what the SESSION declared — not `submittedBy`, which the
     * caller supplies and could simply set to whatever name the role happens to hold.
     */
    const submittedBy = requireText(input.submittedBy, 'submitted_by', MAX_TITLE)
    assertCanActAsRole({
      role: input.role,
      memberOfRole: this.memberOf(latest.projectId, input.role),
      declaredMember: input.declaredMember ?? null,
    })

    // A refusal must say why. An unexplained rejection is not actionable.
    const reason =
      input.outcome === 'reject'
        ? requireText(input.reason ?? '', 'rejection reason', MAX_REASON)
        : optionalText(input.reason ?? null, 'reason', MAX_REASON)

    return inTransaction(this.db, () => {
      this.plans.recordDecision(
        latest.id,
        latest.version,
        input.role,
        input.outcome,
        reason,
        submittedBy,
        this.clock.now(),
      )

      // Re-read inside the transaction so the gate is judged on committed state, then
      // activate in the same transaction if it just closed.
      const refreshed = this.plans.findVersion(latest.id, latest.version)
      if (refreshed === null) {
        throw new WorkbenchError('INTERNAL', 'plan version vanished mid-confirmation', {
          id: latest.id,
          version: latest.version,
        })
      }
      const slots = this.plans.slotsOf(refreshed.id, refreshed.version)
      const gate = gateStateOf(refreshed.relevantRoles, slots, (r) =>
        this.memberOf(refreshed.projectId, r),
      )

      if (gate.kind === 'unanimous') {
        this.activate(refreshed, gate.agreed)
      }
      return this.view(this.plans.findVersion(refreshed.id, refreshed.version) ?? refreshed)
    })
  }

  /**
   * Close the gate: mark the plan active and record the formal plan.
   *
   * MUST run inside the caller's transaction. Splitting any part of this out would create
   * the half-active state MVP-020 forbids.
   *
   * Task creation is part of THIS transaction (ADR-0009). The order matters: tasks are
   * created first, so that if the resolver refuses — a target completed while the plan
   * waited, a dependency that no longer resolves — the plan is left untouched and still
   * awaiting activation. Marking the plan active first would strand a plan that claims to
   * be in effect while producing no tasks.
   */
  private activate(plan: Plan, agreed: readonly RoleId[]): void {
    const at = this.clock.now()
    this.tasks?.applyActivation(plan)
    this.plans.activate(plan.id, plan.version, at, agreed)
  }

  get(planId: PlanId): PlanWithSlots {
    const latest = this.plans.findLatest(planId)
    if (latest === null) {
      throw new WorkbenchError('PLAN_NOT_FOUND', `no plan with id ${planId}`, { id: planId })
    }
    return this.view(latest)
  }

  /** Every version, oldest first. Voided confirmations remain visible. */
  history(planId: PlanId): readonly PlanWithSlots[] {
    const versions = this.plans.listVersions(planId)
    if (versions.length === 0) {
      throw new WorkbenchError('PLAN_NOT_FOUND', `no plan with id ${planId}`, { id: planId })
    }
    return versions.map((p) => this.view(p))
  }

  listByProject(projectId: ProjectId): readonly PlanWithSlots[] {
    return this.plans.listByProject(projectId).map((p) => this.view(p))
  }

  private view(plan: Plan): PlanWithSlots {
    const slots = this.plans.slotsOf(plan.id, plan.version)
    const projectId = plan.projectId

    // A SUPERSEDED version's gate must not be recomputed as if nothing had happened.
    // gateStateOf ignores voided slots, so a version whose decisions were all voided by a
    // revision would report "everyone still pending" — which reads as though nobody had
    // ever acted, losing the very history plan_history exists to show. Report it as
    // superseded instead.
    const superseded = slots.length > 0 && slots.every((s) => s.voidedAt !== null)

    return {
      plan,
      slots,
      gate: superseded
        ? { kind: 'superseded', voidedAt: slots[0]?.voidedAt ?? null, voidReason: slots[0]?.voidReason ?? null }
        : gateStateOf(plan.relevantRoles, slots, (r) => this.memberOf(projectId, r)),
    }
  }

  private memberOf(projectId: ProjectId, role: RoleId): string | null {
    const roles = this.projects.rolesOf(projectId)
    return roles.find((r) => r.role === role)?.member ?? null
  }

  private requireProject(projectId: ProjectId) {
    const project = this.projects.findById(projectId)
    if (project === null) {
      throw new WorkbenchError('PROJECT_NOT_FOUND', `no project with id ${projectId}`, { id: projectId })
    }
    if (project.archivedAt !== null) {
      throw new WorkbenchError('PROJECT_ARCHIVED', `project ${projectId} is archived`, { id: projectId })
    }
    return project
  }
}

interface Draft {
  readonly title: string
  readonly roles: readonly RoleId[]
  readonly rolesReason: string
  readonly overridden: boolean
  readonly proposedRoles: readonly RoleId[] | null
  readonly tasks: readonly PlannedTask[]
  readonly undecided: readonly string[]
}

function validateDraft(
  input: {
    title: string
    relevantRoles: readonly RoleId[]
    rolesReason: string
    tasks: readonly PlannedTask[]
    undecided: readonly string[]
    proposedRoles?: readonly RoleId[] | null | undefined
  },
  /**
   * Project the plan belongs to, and a way to look up an existing task's project.
   *
   * Passed in because `validateDraft` is a free function: it has no `this` and no database.
   * When no task layer is wired (the M4-only tests), lookups return null and a dependency
   * must then be a ref in this plan — which is exactly the old behaviour.
   */
  owner: {
    projectId: string
    findTask(taskId: string): string | null
  },
): Draft {
  const title = requireText(input.title, 'title', MAX_TITLE)
  const rolesReason = requireText(input.rolesReason, 'roles reason', MAX_REASON)

  if (!Array.isArray(input.relevantRoles) || input.relevantRoles.length === 0) {
    throw new WorkbenchError('ROLES_REQUIRED', 'a plan must name the roles that must confirm it', {})
  }
  if (input.relevantRoles.length > MAX_ROLES) {
    throw new WorkbenchError('INVALID_ARGUMENT', `too many relevant roles`, {
      count: input.relevantRoles.length,
    })
  }
  const roles: RoleId[] = []
  for (const r of input.relevantRoles) {
    if (!isRoleId(r)) {
      throw new WorkbenchError('ROLE_UNKNOWN', `unknown role: ${String(r)}`, { role: r })
    }
    if (roles.includes(r)) {
      throw new WorkbenchError('INVALID_ARGUMENT', `role "${r}" listed twice`, { role: r })
    }
    roles.push(r)
  }

  // The Agent's proposal is kept whenever the caller changed it, so "who decided the set"
  // stays answerable (MVP-018).
  const proposedRoles = input.proposedRoles ?? null
  const overridden =
    proposedRoles !== null && !sameRoles(proposedRoles, roles)

  if (input.tasks.length > MAX_TASKS) {
    throw new WorkbenchError('INVALID_ARGUMENT', `too many tasks`, { count: input.tasks.length })
  }

  const tasks = input.tasks.map((t) => {
    const ref = requireText(t.ref, 'task ref', 100)
    if (!isRoleId(t.role)) {
      throw new WorkbenchError('ROLE_UNKNOWN', `task "${ref}" has unknown role ${String(t.role)}`, {
        ref,
        role: t.role,
      })
    }
    if (!CHANGES.includes(t.change)) {
      throw new WorkbenchError('INVALID_ARGUMENT', `task "${ref}" has invalid change ${String(t.change)}`, {
        ref,
        change: t.change,
      })
    }

    // The two identifiers (ADR-0008): `ref` names something inside THIS plan version,
    // `taskId` names a durable task. Getting the pairing wrong is the mistake most likely
    // to silently do the wrong thing, so both directions are rejected explicitly.
    const taskId = t.taskId ?? null
    if (t.change === 'add') {
      if (taskId !== null) {
        throw new WorkbenchError(
          'ADD_MUST_NOT_NAME_A_TASK',
          `task "${ref}" is an add, so it must not name an existing task (got ${taskId})`,
          { ref, taskId },
        )
      }
    } else if (taskId === null) {
      throw new WorkbenchError(
        'TASK_TARGET_REQUIRED',
        `task "${ref}" is a ${t.change}, so it must name the task it changes`,
        { ref, change: t.change },
      )
    }

    return {
      ref,
      taskId,
      role: t.role,
      change: t.change,
      content: requireText(t.content, `task "${ref}" content`, MAX_CONTENT),
      requiredResults: optionalText(t.requiredResults ?? null, `task "${ref}" required results`, MAX_CONTENT),
      completionCriteria: optionalText(t.completionCriteria ?? null, `task "${ref}" completion criteria`, MAX_CONTENT),
      dependsOn: [...(t.dependsOn ?? [])],
    }
  })

  const refs = tasks.map((t) => t.ref)
  const refSet = new Set(refs)
  if (refSet.size !== refs.length) {
    throw new WorkbenchError('DUPLICATE_TASK_REF', 'task refs must be unique within a plan', {
      refs,
    })
  }

  // Targeting one task twice is rejected rather than applied in sequence: two edits to the
  // same task in one plan is ambiguous (叠加 or a mistake?), and MVP has no notion of
  // merging edits.
  const targets = new Set<string>()
  for (const t of tasks) {
    if (t.taskId === null) continue
    if (targets.has(t.taskId)) {
      throw new WorkbenchError(
        'DUPLICATE_TASK_TARGET',
        `task ${t.taskId} is targeted more than once in this plan version`,
        { taskId: t.taskId },
      )
    }
    targets.add(t.taskId)
  }

  // Dangling references and self-loops are rejected here, before the plan can collect a
  // single confirmation.
  //
  // A dependency is EITHER a ref defined in this same plan version (so one plan can chain
  // tasks it is creating) OR the id of a task that already exists (ADR-0009). Refusing the
  // second case here would make it impossible to express "this new task consumes the output
  // of that task over there", which is the normal case once a project is under way.
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.ref) {
        throw new WorkbenchError('DEPENDENCY_CYCLE', `task "${t.ref}" depends on itself`, {
          ref: t.ref,
        })
      }
      if (refSet.has(d)) continue
      // Not a ref here: it must name an existing task, in this project.
      const ownerProject = owner.findTask(d)
      if (ownerProject === null) {
        throw new WorkbenchError(
          'DEPENDENCY_MISSING_TASK',
          `task "${t.ref}" depends on "${d}", which is neither a task in this plan nor an existing task`,
          { ref: t.ref, dependsOn: d },
        )
      }
      if (ownerProject !== owner.projectId) {
        throw new WorkbenchError(
          'DEPENDENCY_MISSING_TASK',
          `task "${t.ref}" depends on "${d}", which belongs to another project`,
          { ref: t.ref, dependsOn: d },
        )
      }
    }
  }

  const cycle = findCycle(tasks)
  if (cycle !== null) {
    throw new WorkbenchError('DEPENDENCY_CYCLE', `dependency cycle: ${cycle.join(' -> ')}`, {
      cycle,
    })
  }

  const undecided = input.undecided.map((t) => requireText(t, 'undecided', MAX_CONTENT))

  return { title, roles, rolesReason, overridden, proposedRoles, tasks, undecided }
}

/**
 * Depth-first cycle detection over task refs.
 *
 * Returns the cycle path so the error can name it — "there is a cycle somewhere" is not
 * actionable, whereas "a -> b -> a" tells the caller exactly what to break.
 */
export function findCycle(tasks: readonly PlannedTask[]): readonly string[] | null {
  const edges = new Map<string, readonly string[]>()
  for (const t of tasks) edges.set(t.ref, t.dependsOn)

  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (ref: string): readonly string[] | null => {
    const current = state.get(ref)
    if (current === 'done') return null
    if (current === 'visiting') {
      const start = stack.indexOf(ref)
      return [...stack.slice(start), ref]
    }

    state.set(ref, 'visiting')
    stack.push(ref)
    for (const next of edges.get(ref) ?? []) {
      const found = visit(next)
      if (found !== null) return found
    }
    stack.pop()
    state.set(ref, 'done')
    return null
  }

  for (const t of tasks) {
    const found = visit(t.ref)
    if (found !== null) return found
  }
  return null
}

function sameRoles(a: readonly RoleId[], b: readonly RoleId[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((r, i) => r === sortedB[i])
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkbenchError('INVALID_ARGUMENT', `${field} is required`, { field })
  }
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new WorkbenchError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field })
  }
  return trimmed
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') {
    throw new WorkbenchError('INVALID_ARGUMENT', `${field} must be a string`, { field })
  }
  if (value.length > max) {
    throw new WorkbenchError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field })
  }
  return value
}

export type { ConfirmationSlot, GateState }
