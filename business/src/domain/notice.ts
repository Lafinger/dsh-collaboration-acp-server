/**
 * Todos and notifications (M6, ADR-0011).
 *
 * A todo is NOT a stored row — it is a PROJECTION of an undecided slot that already exists:
 *
 *   plan confirmation  -> confirmations        (plan_id, plan_version, role)
 *   result review      -> result_confirmations (result_id, version)
 *   result acceptance  -> acceptances          (result_id, version, task_id)
 *
 * Those tables are the authority. Storing a separate todo list would immediately raise
 * "the task was cancelled, who deletes the todo?", and that question has no cheap answer in
 * the MVP. Deriving cannot go out of sync.
 *
 * The ONE thing that cannot be derived is READ state: nothing else in the database records
 * who looked at what, so it is the necessary exception and does live in a table.
 */
import type { RoleId } from './roles.js'
import type { ProjectId } from './project.js'
import type { PlanId } from './plan.js'
import type { TaskId } from './task.js'
import type { ResultId, ResultVersion } from './result.js'

/** What kind of decision a todo is waiting for. */
export type TodoKind = 'plan_confirmation' | 'result_review' | 'result_acceptance'

/** Not a todo: information only. Reading it decides nothing. */
export type NoticeKind = 'result_rejected' | 'task_completed'

export type ItemKind = TodoKind | NoticeKind

export const TODO_KINDS: readonly TodoKind[] = [
  'plan_confirmation',
  'result_review',
  'result_acceptance',
]

export const NOTICE_KINDS: readonly NoticeKind[] = ['result_rejected', 'task_completed']

export function isTodoKind(kind: ItemKind): kind is TodoKind {
  return (TODO_KINDS as readonly string[]).includes(kind)
}

/**
 * A stable address for one slot.
 *
 * Both the todo list and the read table are keyed by this, so a read can be recorded against
 * a todo that was DERIVED rather than stored. Every source already has a natural unique key,
 * which is why no surrogate id is needed.
 */
export interface SlotRef {
  readonly kind: ItemKind
  readonly projectId: ProjectId
  /** plan id, or result id, depending on the kind. */
  readonly objectId: string
  /** Plan version, or result version. */
  readonly version: number
  /** The role that must act. */
  readonly role: RoleId
  /** For acceptance: which downstream task decides. */
  readonly taskId: TaskId | null
}

/** `kind:objectId:version:role:taskId` — one string, so it can be a primary key. */
export function slotKey(ref: SlotRef): string {
  return [ref.kind, ref.objectId, ref.version, ref.role, ref.taskId ?? ''].join(':')
}

/** An undecided slot, presented to the role that must act on it. */
export interface Todo {
  readonly kind: TodoKind
  readonly projectId: ProjectId
  readonly objectId: string
  readonly version: number
  readonly role: RoleId
  readonly taskId: TaskId | null
  /** Human-readable summary of what is being decided. */
  readonly summary: string
  readonly createdAt: string
  /**
   * Whether this role currently HAS a member.
   *
   * A vacant role still sees its todos — nobody else can decide for it — but it produces no
   * unread count, because there is nobody to be behind.
   */
  readonly member: string | null
  readonly read: boolean
}

/** Information only. */
export interface Notice {
  readonly kind: NoticeKind
  readonly projectId: ProjectId
  readonly objectId: string
  readonly version: number
  readonly role: RoleId
  readonly taskId: TaskId | null
  readonly summary: string
  readonly detail: string | null
  readonly createdAt: string
  readonly member: string | null
  readonly read: boolean
}

/** What one role currently owes. */
export interface UnreadCount {
  readonly role: RoleId
  /** Undecided todos for this role. */
  readonly pending: number
  /** Of those, how many this role has already read. */
  readonly read: number
  /**
   * `pending - read`, never negative.
   *
   * A role with no member reports 0: the slots exist and are listed, but there is nobody to
   * be behind (MVP-030).
   */
  readonly unread: number
}

export function unreadOf(pending: number, read: number, member: string | null): number {
  if (member === null) return 0
  return Math.max(0, pending - read)
}

export type { PlanId, ResultId, ResultVersion }
