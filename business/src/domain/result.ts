/**
 * Progress, results and acceptance (M5 result layer, ADR-0010).
 *
 * Three objects, all hanging off a TASK VERSION rather than the task:
 *
 *   progress  — "what I am doing", attached to the definition I am working to
 *   result    — a submission: explanation + files + self-check, forming ONE immutable version
 *   acceptance— a downstream task's decision on one specific result version
 *
 * Progress hangs off the version for the same reason the version exists at all: after a
 * revision there are two different sets of requirements, and mixing their progress makes
 * "what was I asked to do at the time" unanswerable.
 *
 * Deliberately NOT modelled here: any notion of quality. Required results are display-only
 * text, and "completeness" can only mean "something was submitted" — the system cannot know
 * whether a given file is the document it was asked for (ADR-0010).
 */
import type { RoleId } from './roles.js'
import type { TaskId, TaskVersion } from './task.js'

export type ResultId = string
export type ResultVersion = number

/** One progress note. Append-only; saving progress never completes anything (MVP-024). */
export interface ProgressEntry {
  readonly id: string
  readonly taskId: TaskId
  /** The task definition this was written against. */
  readonly taskVersion: TaskVersion
  readonly note: string
  /** Snapshot of who wrote it. NOT an authorisation check — MVP has no permissions. */
  readonly submittedBy: string
  readonly createdAt: string
}

/** A file attached to a result version. Bytes live in the material store, not here. */
export interface ResultFile {
  /** Path relative to the file root. */
  readonly relPath: string
  readonly originalName: string
  readonly sha256: string
  readonly sizeBytes: number
}

/**
 * One submission, frozen.
 *
 * Explanation, files and self-check together form ONE version — not three — because
 * completeness is a property of "this version has what it needed", which presupposes they
 * belong to the same version.
 */
export interface ResultVersionRecord {
  readonly resultId: ResultId
  readonly version: ResultVersion
  readonly taskId: TaskId
  /**
   * The task version in force when this was submitted. MVP-025 requires this: without it,
   * a revision leaves "what was asked at the time" unanswerable.
   */
  readonly taskVersion: TaskVersion
  readonly summary: string
  readonly files: readonly ResultFile[]
  readonly selfCheck: string
  readonly submittedBy: string
  readonly createdAt: string
}

/** The outcome of the owning role's review of one result version. */
export type ReviewOutcome = 'complete' | 'return'

export interface ResultConfirmation {
  readonly id: string
  readonly resultId: ResultId
  readonly resultVersion: ResultVersion
  readonly role: RoleId
  readonly outcome: ReviewOutcome | null
  /** Required when returning. MVP-026: a return must say why. */
  readonly reason: string | null
  readonly submittedBy: string | null
  readonly decidedAt: string | null
}

/** A downstream task's decision on one result version (MVP-027). */
export type AcceptanceOutcome = 'accept' | 'reject'

export interface Acceptance {
  readonly id: string
  readonly resultId: ResultId
  readonly resultVersion: ResultVersion
  /** The downstream task making the decision. */
  readonly taskId: TaskId
  /**
   * The downstream task's OWN version at the moment it decided.
   *
   * Pinned when the decision is recorded, not when the slot is opened: a revision between
   * the two would otherwise make this claim about a definition that was never used.
   */
  readonly acceptedTaskVersion: TaskVersion | null
  /**
   * The upstream task version that produced the accepted result.
   *
   * This is the answer to MVP-031's "which input versions did it actually use" (ADR-0012).
   * Denormalised so a chain is walkable without re-deriving it from the result row.
   */
  readonly acceptedResultTaskVersion: TaskVersion | null
  readonly outcome: AcceptanceOutcome | null
  /** Required when rejecting. */
  readonly reason: string | null
  readonly submittedBy: string | null
  readonly decidedAt: string | null
}

/** Whether this acceptance was actually decided, as opposed to still open. */
export function isDecided(a: Acceptance): boolean {
  return a.outcome !== null
}

/** A task's full result picture. */
export interface TaskResults {
  readonly taskId: TaskId
  readonly progress: readonly ProgressEntry[]
  readonly results: readonly ResultWithConfirmations[]
  readonly completedAt: string | null
}

export interface ResultWithConfirmations {
  readonly result: ResultVersionRecord
  readonly confirmation: ResultConfirmation | null
  readonly acceptances: readonly Acceptance[]
}

export function isAcceptanceDecided(a: Acceptance): boolean {
  return a.outcome !== null
}

/**
 * Whether a task's latest result has been confirmed complete.
 *
 * Completion is a CONSEQUENCE of confirmation, never of submission (MVP-025).
 */
export function isConfirmedComplete(results: ResultWithConfirmations): boolean {
  return results.confirmation?.outcome === 'complete'
}
