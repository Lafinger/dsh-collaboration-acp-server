/**
 * Todos and notifications (M6, ADR-0011).
 *
 * A todo is a PROJECTION of an undecided slot, not a stored row. This service reads the
 * slots and presents them; it writes nothing except read state.
 *
 * Consequences worth stating plainly:
 *   - there is no "create todo" operation, so MVP-016's ban on automatically creating work
 *     cannot be violated here — this layer never writes a business object
 *   - marking something read changes NO business state (MVP-030); the only way to close a
 *     todo is to submit the corresponding decision
 *   - a todo does not disappear when read
 */
import type { DatabaseSync } from 'node:sqlite'
import { WorkbenchError } from '../domain/error.js'
import {
  type ItemKind,
  type Notice,
  type NoticeKind,
  type SlotRef,
  type Todo,
  type TodoKind,
  type UnreadCount,
  slotKey,
  unreadOf,
} from '../domain/notice.js'
import type { ProjectId } from '../domain/project.js'
import { ROLE_IDS, type RoleId } from '../domain/roles.js'
import { NoticeRepository } from '../sqlite/notice-repository.js'
import { ProjectRepository } from '../sqlite/project-repository.js'
import { systemClock, type Clock } from './project-service.js'

export interface TodoFilter {
  readonly projectId: ProjectId
  /** Only these roles. Empty/absent means every role. */
  readonly roles?: readonly RoleId[]
  /** Only these kinds. Empty/absent means both todos and notices. */
  readonly kinds?: readonly ItemKind[]
  /** Only unread items. */
  readonly unreadOnly?: boolean
}

export class NoticeService {
  private readonly notices: NoticeRepository
  private readonly projects: ProjectRepository

  constructor(
    db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.notices = new NoticeRepository(db)
    this.projects = new ProjectRepository(db)
  }

  /** Every undecided slot in a project, as todos. */
  todos(filter: TodoFilter): readonly Todo[] {
    this.requireProject(filter.projectId)
    const members = this.membersOf(filter.projectId)
    const kinds = filter.kinds
    const roles = filter.roles

    const rows = this.notices.pendingTodos(filter.projectId).filter((r) => {
      if (kinds !== undefined && kinds.length > 0 && !kinds.includes(r.kind as ItemKind)) return false
      if (roles !== undefined && roles.length > 0 && !roles.includes(r.role as RoleId)) return false
      return true
    })

    const read = this.notices.readKeys(rows.map((r) => slotKeyOf(r)))
    const todos: Todo[] = rows.map((r) => {
      const ref = slotRefOf(r)
      const isRead = read.has(slotKey(ref))
      return {
        kind: r.kind as TodoKind,
        projectId: r.project_id,
        objectId: r.object_id,
        version: Number(r.version),
        role: r.role as RoleId,
        taskId: r.task_id,
        summary: r.summary,
        createdAt: r.created_at,
        member: members.get(r.role as RoleId) ?? null,
        read: isRead,
      }
    })

    return filter.unreadOnly === true ? todos.filter((t) => !t.read) : todos
  }

  /** Informational items. Reading one decides nothing. */
  list(filter: TodoFilter): readonly Notice[] {
    this.requireProject(filter.projectId)
    const members = this.membersOf(filter.projectId)
    const kinds = filter.kinds
    const roles = filter.roles

    const rows = this.notices.notices(filter.projectId).filter((r) => {
      if (kinds !== undefined && kinds.length > 0 && !kinds.includes(r.kind as ItemKind)) return false
      if (roles !== undefined && roles.length > 0 && !roles.includes(r.role as RoleId)) return false
      return true
    })

    const read = this.notices.readKeys(rows.map((r) => slotKeyOf(r)))
    const notices: Notice[] = rows.map((r) => {
      const ref = slotRefOf(r)
      return {
        kind: r.kind as NoticeKind,
        projectId: r.project_id,
        objectId: r.object_id,
        version: Number(r.version),
        role: r.role as RoleId,
        taskId: r.task_id,
        summary: r.summary,
        detail: r.detail,
        createdAt: r.created_at,
        member: members.get(r.role as RoleId) ?? null,
        read: read.has(slotKey(ref)),
      }
    })

    return filter.unreadOnly === true ? notices.filter((n) => !n.read) : notices
  }

  /**
   * What each role currently owes.
   *
   * Only todos count. A notice is never "owed", so it never contributes to unread.
   */
  unread(projectId: ProjectId): readonly UnreadCount[] {
    this.requireProject(projectId)
    const members = this.membersOf(projectId)
    const rows = this.notices.pendingTodos(projectId)
    const read = this.notices.readKeys(rows.map((r) => slotKeyOf(r)))

    return ROLE_IDS.map((role) => {
      const mine = rows.filter((r) => r.role === role)
      const alreadyRead = mine.filter((r) => read.has(slotKey(slotRefOf(r)))).length
      const member = members.get(role) ?? null
      return {
        role,
        pending: mine.length,
        read: alreadyRead,
        unread: unreadOf(mine.length, alreadyRead, member),
      }
    })
  }

  /**
   * Mark one slot as read for the role it belongs to.
   *
   * Reading changes NO business state — that is the whole point of MVP-030. It does not
   * approve a plan, complete a task, or accept a result.
   *
   * The slot MUST currently exist, which is checked rather than assumed: without that check,
   * marking a mistyped id read stored a row nothing could ever match while reporting success.
   * A read nobody can observe is worse than a rejection.
   */
  markRead(ref: SlotRef): { readonly changed: boolean } {
    this.requireProject(ref.projectId)
    if (!this.slotExists(ref)) {
      throw new WorkbenchError(
        'NOTICE_NOT_FOUND',
        `no todo or notice at ${ref.kind} ${ref.objectId} v${ref.version} for role ${ref.role}`,
        {
          kind: ref.kind,
          objectId: ref.objectId,
          version: ref.version,
          role: ref.role,
        },
      )
    }
    const changed = this.notices.markRead(ref, this.clock.now(), null)
    return { changed }
  }

  /**
   * Whether this address corresponds to a slot that currently exists.
   *
   * Checks the SLOT TABLES rather than the derived lists, because a decided or voided slot
   * still exists as a record while correctly no longer being a todo. Deriving existence from
   * the todo list alone would reject a legitimate read of history.
   */
  private slotExists(ref: SlotRef): boolean {
    return this.notices.slotExists(ref)
  }

  /** Mark everything a role currently owes in a project as read. */
  markAllRead(projectId: ProjectId, role: RoleId): number {
    this.requireProject(projectId)
    const at = this.clock.now()
    let changed = 0
    for (const t of this.todos({ projectId, roles: [role] })) {
      if (this.notices.markRead(slotRefOfTodo(t), at, null)) changed++
    }
    return changed
  }

  isRead(ref: SlotRef): boolean {
    return this.notices.isRead(ref)
  }

  private membersOf(projectId: ProjectId): Map<RoleId, string | null> {
    const map = new Map<RoleId, string | null>()
    for (const slot of this.projects.rolesOf(projectId)) {
      map.set(slot.role, slot.member)
    }
    return map
  }

  private requireProject(projectId: ProjectId): void {
    if (this.projects.findById(projectId) === null) {
      throw new WorkbenchError('PROJECT_NOT_FOUND', `no project with id ${projectId}`, {
        projectId,
      })
    }
  }
}

function slotRefOf(row: {
  kind: string
  object_id: string
  version: number
  role: string
  task_id: string | null
}): SlotRef {
  return {
    kind: row.kind as ItemKind,
    projectId: '',
    objectId: row.object_id,
    version: Number(row.version),
    role: row.role as RoleId,
    taskId: row.task_id,
  }
}

function slotRefOfTodo(t: Todo): SlotRef {
  return {
    kind: t.kind,
    projectId: t.projectId,
    objectId: t.objectId,
    version: t.version,
    role: t.role,
    taskId: t.taskId,
  }
}

function slotKeyOf(row: {
  kind: string
  object_id: string
  version: number
  role: string
  task_id: string | null
}): string {
  return slotKey(slotRefOf(row))
}
