/**
 * Traceability (M7, MVP-031).
 *
 * The requirement asks one question: "who, on which version, decided what, when, and why".
 * So this layer is a READER — it creates nothing, and it is the only layer in the MVP that
 * writes no rows at all.
 *
 * Why an object is the entry point rather than a timeline: a timeline answers "what happened
 * when", but MVP-031 asks "on which version", and a caller would have to reassemble that
 * from a stream. Asking per object answers it directly.
 *
 * Version discipline is the point:
 *   - CURRENT vs HISTORICAL are distinguished, never blended
 *   - history is read-only; changing something means a NEW version, never an edit
 *   - an archived project still reads
 *
 * The chain is stitched from records that already exist. M7 added no business object; the
 * only thing it needed that was missing was WHICH INPUT VERSION was consumed (ADR-0012).
 */
import type { DatabaseSync } from 'node:sqlite'
import { WorkbenchError } from '../domain/error.js'
import type { ProjectId } from '../domain/project.js'
import type { TaskId, TaskVersion } from '../domain/task.js'
import type { ResultId, ResultVersion } from '../domain/result.js'
import { PlanRepository } from '../sqlite/plan-repository.js'
import { TaskRepository } from '../sqlite/task-repository.js'
import { ResultRepository } from '../sqlite/result-repository.js'

/** One thing that happened, with everything MVP-031 asks for. */
export interface TraceDecision {
  /** What kind of record this is. */
  readonly kind:
    | 'plan_confirmation'
    | 'result_review'
    | 'result_acceptance'
    | 'plan_activation'
    | 'task_version'
    | 'result_version'
  /** Which version this decision was made against. */
  readonly version: number
  readonly role: string | null
  readonly outcome: string | null
  readonly reason: string | null
  /** Who submitted it. A SNAPSHOT, not a credential. */
  readonly submittedBy: string | null
  readonly at: string | null
  /** The input version consumed, where the record pins one (ADR-0012). */
  readonly basedOn: { readonly kind: string; readonly version: number } | null
  readonly detail: string | null
}

/** Everything knowable about one object, split into current and history. */
export interface Trace {
  readonly object: { readonly type: string; readonly id: string; readonly projectId: ProjectId }
  /** The version in force now, or null when nothing is current. */
  readonly currentVersion: number | null
  /** Up to and including the current version. */
  readonly decisions: readonly TraceDecision[]
  /** Superseded versions, kept readable. Never blended into `decisions`. */
  readonly history: readonly TraceDecision[]
  /** What this object consumed, and what consumed it. */
  readonly chain: {
    readonly inputs: readonly { readonly taskId: TaskId; readonly version: number | null; readonly resultVersion: number | null }[]
    readonly consumers: readonly { readonly taskId: TaskId; readonly outcome: string; readonly version: number }[]
  }
}

export class TraceService {
  private readonly plans: PlanRepository
  private readonly tasks: TaskRepository
  private readonly results: ResultRepository

  constructor(db: DatabaseSync) {
    this.plans = new PlanRepository(db)
    this.tasks = new TaskRepository(db)
    this.results = new ResultRepository(db)
  }

  /** Trace one task: its versions, the decisions on them, and what it consumed. */
  traceTask(taskId: TaskId): Trace {
    const task = this.tasks.findById(taskId)
    if (task === null) {
      throw new WorkbenchError('TASK_NOT_FOUND', `no task with id ${taskId}`, { taskId })
    }
    const versions = this.tasks.versionsOf(taskId)
    const decisions: TraceDecision[] = []
    const history: TraceDecision[] = []

    for (const v of versions) {
      const row: TraceDecision = {
        kind: 'task_version',
        version: v.version,
        role: task.role,
        outcome: null,
        reason: null,
        submittedBy: null,
        at: v.createdAt,
        basedOn: v.createdByPlanId === null
          ? null
          : { kind: 'plan', version: v.createdByPlanVersion },
        detail: v.content,
      }
      // A version above the current one cannot exist; equal means current.
      if (v.version <= task.currentVersion) decisions.push(row)
      else history.push(row)
    }

    // Progress and results were written against a specific version, so they are historical
    // facts too — each is filed under the version it was written to.
    const results = this.results.resultsOf(taskId)
    for (const r of results) {
      const row: TraceDecision = {
        kind: 'result_version',
        version: r.version,
        role: task.role,
        outcome: null,
        reason: null,
        // The SUBMITTER, not the reviewer: creating a version and deciding on it are two
        // different acts, and MVP-031 asks who did each.
        submittedBy: r.submittedBy,
        at: r.createdAt,
        basedOn: { kind: 'task', version: r.taskVersion },
        detail: r.summary,
      }
      if (r.taskVersion <= task.currentVersion) decisions.push(row)
      else history.push(row)

      /*
       * The review is its own decision, not a field of the submission.
       *
       * Folding it into the row above loses the distinction between "submitted and not yet
       * reviewed" and "submitted and judged" — and a return in particular is a decision
       * WITH a reason that must stay independently visible.
       */
      const reviewed = this.results.confirmationOf(r.resultId, r.version)
      if (reviewed !== null && reviewed.outcome !== null) {
        const reviewRow: TraceDecision = {
          kind: 'result_review',
          version: r.version,
          role: reviewed.role,
          outcome: reviewed.outcome,
          reason: reviewed.reason,
          submittedBy: reviewed.submittedBy,
          at: reviewed.decidedAt,
          basedOn: { kind: 'result', version: r.version },
          detail: null,
        }
        if (r.taskVersion <= task.currentVersion) decisions.push(reviewRow)
        else history.push(reviewRow)
      }
    }

    return {
      object: { type: 'task', id: taskId, projectId: task.projectId },
      currentVersion: task.currentVersion,
      decisions,
      history,
      chain: {
        inputs: this.inputsOf(taskId, task.currentVersion),
        consumers: this.consumersOf(taskId),
      },
    }
  }

  /**
   * The latest version of a result, or null when it has none.
   *
   * Lets a caller ask "trace this result" without having to know its version number first.
   */
  latestResultVersion(resultId: ResultId): ResultVersion | null {
    const taskId = this.results.ownerOf(resultId)
    if (taskId === null) return null
    return this.results.resultsOf(taskId).at(-1)?.version ?? null
  }

  /** Trace one result version: how it was produced, and every decision made on it. */
  traceResult(resultId: ResultId, version: ResultVersion): Trace {
    const r = this.results.findResultVersion(resultId, version)
    if (r === null) {
      throw new WorkbenchError(
        'RESULT_NOT_FOUND',
        `no result ${resultId} version ${version}`,
        { resultId, version },
      )
    }
    const task = this.tasks.findById(r.taskId)
    if (task === null) {
      throw new WorkbenchError('TASK_NOT_FOUND', `no task with id ${r.taskId}`, { taskId: r.taskId })
    }
    const decisions: TraceDecision[] = [
      {
        kind: 'result_version',
        version: r.version,
        role: task.role,
        outcome: null,
        reason: null,
        submittedBy: r.submittedBy,
        at: r.createdAt,
        // The answer to "which version of the task produced this".
        basedOn: { kind: 'task', version: r.taskVersion },
        detail: r.summary,
      },
    ]
    const review = this.results.confirmationOf(resultId, version)
    if (review !== null) {
      decisions.push({
        kind: 'result_review',
        version: r.version,
        role: review.role,
        outcome: review.outcome,
        reason: review.reason,
        submittedBy: review.submittedBy,
        at: review.decidedAt,
        basedOn: { kind: 'task', version: r.taskVersion },
        detail: null,
      })
    }

    // Superseded result versions of the same task are history, not current state.
    const history: TraceDecision[] = this.results
      .resultsOf(r.taskId)
      .filter((other) => other.version > r.version)
      .map((other) => ({
        kind: 'result_version' as const,
        version: other.version,
        role: task.role,
        outcome: null,
        reason: null,
        submittedBy: other.submittedBy,
        at: other.createdAt,
        basedOn: { kind: 'task', version: other.taskVersion },
        detail: other.summary,
      }))

    return {
      object: { type: 'result', id: resultId, projectId: task.projectId },
      currentVersion: r.version,
      decisions,
      history,
      chain: { inputs: this.inputsOf(r.taskId, r.taskVersion), consumers: this.consumersOf(r.taskId) },
    }
  }

  /** Trace one plan: every confirmation, whether it is still in force, and when it activated. */
  tracePlan(planId: string): Trace {
    const latest = this.plans.findLatest(planId)
    if (latest === null) {
      throw new WorkbenchError('PLAN_NOT_FOUND', `no plan with id ${planId}`, { id: planId })
    }
    // Every version that still exists, oldest first, so the history reads in order.
    const versions: { version: number; activatedAt: string | null }[] = []
    for (let v = 1; v <= latest.version; v++) {
      const row = this.plans.findVersion(planId, v)
      if (row !== null) versions.push({ version: row.version, activatedAt: row.activatedAt })
    }
    const decisions: TraceDecision[] = []
    const history: TraceDecision[] = []

    for (const v of versions) {
      const slots = this.plans.slotsOf(planId, v.version)
      for (const s of slots) {
        const row: TraceDecision = {
          kind: 'plan_confirmation',
          version: v.version,
          role: s.role,
          outcome: s.outcome,
          reason: s.reason,
          submittedBy: s.submittedBy,
          at: s.decidedAt,
          basedOn: { kind: 'plan', version: v.version },
          // A voided confirmation is history even on the current version: it was superseded
          // by a revision, which is exactly what "keep it readable but not in force" means.
          detail: s.voidedAt === null ? null : `voided: ${s.voidReason ?? 'superseded'}`,
        }
        if (v.version === latest.version && s.voidedAt === null) decisions.push(row)
        else history.push(row)
      }
      if (v.activatedAt !== null) {
        decisions.push({
          kind: 'plan_activation',
          version: v.version,
          role: null,
          outcome: 'activated',
          reason: null,
          submittedBy: null,
          at: v.activatedAt,
          basedOn: { kind: 'plan', version: v.version },
          detail: null,
        })
      }
    }

    return {
      object: { type: 'plan', id: planId, projectId: latest.projectId },
      currentVersion: latest.version,
      decisions,
      history,
      chain: { inputs: [], consumers: [] },
    }
  }

  /**
   * What a task consumed, per required input.
   *
   * Reads ACCEPTANCES rather than dependency rows, because the dependency only names a task
   * while the acceptance pins the version (ADR-0012). An input with no accepted version
   * reports nulls — that is the honest answer, and it is what blocks completion.
   */
  private inputsOf(taskId: TaskId, version: TaskVersion) {
    const required = this.tasks.dependsOn(taskId, version)
    const mine = this.results.acceptancesByTask(taskId).filter((a) => a.outcome === 'accept')
    return required.map((upstreamTaskId) => {
      const accepted = mine.find((a) => {
        const r = this.results.findResultVersion(a.resultId, a.resultVersion)
        return r !== null && r.taskId === upstreamTaskId
      })
      return {
        taskId: upstreamTaskId,
        version: accepted?.acceptedResultTaskVersion ?? null,
        resultVersion: accepted?.resultVersion ?? null,
      }
    })
  }

  /** Which tasks consumed this one, and how they decided. */
  private consumersOf(taskId: TaskId) {
    const out: { taskId: TaskId; outcome: string; version: number }[] = []
    for (const dep of this.tasks.dependentsOf(taskId)) {
      for (const a of this.results.acceptancesByTask(dep)) {
        const r = this.results.findResultVersion(a.resultId, a.resultVersion)
        if (r === null || r.taskId !== taskId || a.outcome === null) continue
        out.push({ taskId: dep, outcome: a.outcome, version: a.resultVersion })
      }
    }
    return out
  }
}
