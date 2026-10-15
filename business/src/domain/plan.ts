/**
 * Plans and confirmations (M4).
 *
 * This is the MVP's only gate. A plan becomes binding only when EVERY relevant role has
 * agreed — and "every" means every, with no timeout pass, no substitute confirmer, and no
 * partial effect.
 *
 * Two shapes are deliberately absent:
 *   - There is no "approved by anyone" concept. Confirmation is always per ROLE.
 *   - There is no partial activation. The plan is pending or active, never half of each.
 */
import type { AnalysisId } from './analysis.js'
import type { RoleId } from './roles.js'
import type { ProjectId } from './project.js'

export type PlanId = string
export type PlanVersion = number
export type ConfirmationId = string

/** A task as the plan proposes it. M4 stores the proposal; activation gives it a life. */
export interface PlannedTask {
  /** Stable within a plan version, so dependencies can point at it. */
  readonly ref: string
  /**
   * The task this proposal acts on, for `modify` and `cancel`.
   *
   * `add` MUST leave this null — the task does not exist yet. This is the second of the two
   * identifiers (ADR-0008): `ref` names something inside THIS plan version, `taskId` names
   * a durable task. They are not interchangeable.
   */
  readonly taskId: string | null
  readonly role: RoleId
  readonly change: TaskChange
  readonly content: string
  /**
   * What must be handed in, as free text. Part of the task DEFINITION, so changing it is a
   * definition change and produces a new task version.
   *
   * Display-only: the system cannot tell whether a submitted file is the document that was
   * asked for, so completeness can only mean "something was submitted" (ADR-0010).
   */
  readonly requiredResults?: string | null
  /** What "done" means, as free text. Nothing validates against it in the MVP. */
  readonly completionCriteria?: string | null
  /** Refs of tasks this one consumes output from. */
  readonly dependsOn: readonly string[]
}

export type TaskChange = 'add' | 'modify' | 'cancel'

export type ConfirmationOutcome = 'agree' | 'reject'

/** One role's slot on one plan version. Exactly one per relevant role. */
export interface ConfirmationSlot {
  readonly id: ConfirmationId
  readonly planId: PlanId
  readonly planVersion: PlanVersion
  readonly role: RoleId
  readonly outcome: ConfirmationOutcome | null
  readonly reason: string | null
  /** Snapshot of who submitted it. Not an identity check — the role is what counts. */
  readonly submittedBy: string | null
  readonly decidedAt: string | null
  /**
   * Set when a revision invalidated this confirmation. Voided confirmations are KEPT, not
   * deleted (MVP-021) — the history of what was agreed before a change is exactly what
   * makes the change auditable.
   */
  readonly voidedAt: string | null
  readonly voidReason: string | null
}

export interface Plan {
  readonly id: PlanId
  readonly projectId: ProjectId
  readonly version: PlanVersion
  readonly title: string
  /** The roles that must ALL agree. Proposed by the Agent, correctable at registration. */
  readonly relevantRoles: readonly RoleId[]
  /** Why that set. Required — an unexplained gate is an unaccountable one. */
  readonly rolesReason: string
  /** True when the caller overrode the Agent's proposal; the original is kept below. */
  readonly rolesOverridden: boolean
  readonly proposedRoles: readonly RoleId[] | null
  readonly tasks: readonly PlannedTask[]
  /** Marks on the plan. No status, no owner, never resolved. */
  readonly undecided: readonly string[]
  /** The analysis this was transcribed from, if the caller chose to record it. */
  readonly sourceAnalysisId: AnalysisId | null
  readonly activatedAt: string | null
  readonly createdAt: string
}

export interface PlanWithSlots {
  readonly plan: Plan
  readonly slots: readonly ConfirmationSlot[]
  /** Derived, never stored: the plan is active iff all slots agreed and none are voided. */
  readonly gate: GateState
}

/**
 * Where a plan stands. Derived from the slots every time rather than stored, so the state
 * can never drift from the evidence.
 */
export type GateState =
  /** Qualification changed: human revision, not another decision, must reopen the gate. */
  | { readonly kind: 'suspended'; readonly at: string; readonly reason: string }
  /** At least one relevant role has no member — it waits, and says so. */
  | { readonly kind: 'waiting'; readonly pending: readonly RoleId[]; readonly vacancies: readonly RoleId[]; readonly rejected: readonly RoleId[] }
  /** Every relevant role agreed. */
  | { readonly kind: 'unanimous'; readonly agreed: readonly RoleId[] }
  /**
   * A revision superseded this version, voiding every confirmation it had.
   *
   * This is a distinct state on purpose. Recomputing the gate from the surviving slots would
   * report "everyone pending", which reads as though nobody ever acted — erasing the history
   * that `plan_history` exists to show.
   */
  | { readonly kind: 'superseded'; readonly voidedAt: string | null; readonly voidReason: string | null }

export function isActive(plan: Plan): boolean {
  return plan.activatedAt !== null
}

/**
 * Compute the gate from the slots.
 *
 * A role counts as agreed only if it has a non-voided `agree` slot. Rejection is reported
 * separately: it blocks just as hard as silence, but it is a different fact and a caller
 * needs to be able to tell "nobody looked" from "someone objected".
 */
export function gateStateOf(
  relevantRoles: readonly RoleId[],
  slots: readonly ConfirmationSlot[],
  memberOf: (role: RoleId) => string | null,
): GateState {
  const live = slots.filter((s) => s.voidedAt === null)
  const agreed: RoleId[] = []
  const rejected: RoleId[] = []
  const pending: RoleId[] = []
  const vacancies: RoleId[] = []

  for (const role of relevantRoles) {
    const slot = live.find((s) => s.role === role)
    if (slot === undefined || slot.outcome === null) {
      pending.push(role)
      if (memberOf(role) === null) vacancies.push(role)
    } else if (slot.outcome === 'agree') {
      agreed.push(role)
    } else {
      rejected.push(role)
    }
  }

  if (pending.length === 0 && rejected.length === 0) {
    return { kind: 'unanimous', agreed }
  }
  return { kind: 'waiting', pending, vacancies, rejected }
}

export interface RegisterPlanInput {
  readonly projectId: ProjectId
  readonly title: string
  readonly relevantRoles: readonly RoleId[]
  readonly rolesReason: string
  readonly tasks: readonly PlannedTask[]
  readonly undecided: readonly string[]
  readonly sourceAnalysisId?: AnalysisId | null
  /** The Agent's original proposal, when the caller changed it. */
  readonly proposedRoles?: readonly RoleId[] | null
}

export interface RevisePlanInput {
  readonly planId: PlanId
  readonly title: string
  readonly relevantRoles: readonly RoleId[]
  readonly rolesReason: string
  readonly tasks: readonly PlannedTask[]
  readonly undecided: readonly string[]
  readonly proposedRoles?: readonly RoleId[] | null
  /** Recorded on every voided confirmation, so the invalidation itself is explainable. */
  readonly reason: string
}

export interface ConfirmInput {
  readonly planId: PlanId
  readonly role: RoleId
  readonly outcome: ConfirmationOutcome
  /** Required for a rejection (MVP-019): a refusal must say why. */
  readonly reason?: string | null
  readonly submittedBy: string
  /**
   * Who the SESSION has declared itself to be, or null when it has not declared (ADR-0014).
   *
   * Separate from `submittedBy` on purpose. `submittedBy` is a name the CALLER supplies and is
   * only a snapshot for the record; this is what the session actually declared, and it is what
   * the eligibility check compares against the role's member. Taking the check's input from
   * `submittedBy` would let a caller pass any name and satisfy itself — the very hole this
   * closes.
   */
  readonly declaredMember?: string | null
}
