/**
 * Todos and notifications (M6, ADR-0011).
 *
 * A todo is DERIVED from an undecided slot, so most of what matters is what does NOT appear:
 *   - a slot that has been decided is gone
 *   - a slot VOIDED by a revision is gone (the mutation-prone case — void, not delete)
 *   - a notice never counts as owed
 *   - a vacant role lists its todos but owes nothing
 *
 * Reading is the only thing stored, so the read tests focus on the two claims MVP-030 makes:
 * repeated reads do not double count, and unread never goes negative.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { PlanService } from '../service/plan-service.js'
import { TaskService } from '../service/task-service.js'
import { ResultService } from '../service/result-service.js'
import { NoticeService } from '../service/notice-service.js'
import type { PlannedTask } from '../domain/plan.js'
import type { RoleId } from '../domain/roles.js'
import type { SlotRef } from '../domain/notice.js'
import { CollaborationError } from '../domain/error.js'

/**
 * Capture a thrown CollaborationError.
 *
 * `assert.throws` does not hand the error back, so reading `.code` off its result is always
 * undefined — a trap that produced 13 silently-broken assertions earlier in this project.
 */
function throwsCollaboration(fn: () => unknown): CollaborationError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof CollaborationError, `expected a CollaborationError, got ${String(err)}`)
    return err
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' })
}

/**
 * Who holds each role in these fixtures (ADR-0014: a decision must come from the role's own
 * member, and `submittedBy` must name that same person).
 *
 * `Z` is deliberately NOT a member: several tests here submit as 'Z' to stand for "somebody", and
 * those are submissions, not decisions. Only the deciding roles are staffed.
 */
const MEMBER_OF: Readonly<Record<string, string>> = { product: 'Zhang', design: 'Li' }
const memberOf = (role: string): string => MEMBER_OF[role] ?? `who-${role}`

interface Env {
  db: DatabaseSync
  projects: ProjectService
  plans: PlanService
  tasks: TaskService
  results: ResultService
  notices: NoticeService
  projectId: string
  add(ref: string, role: string, dependsOn?: string[]): PlannedTask
  register(taskList: PlannedTask[], roles: readonly RoleId[], title?: string): string
  activate(taskList: PlannedTask[], roles?: readonly RoleId[]): readonly string[]
  taskIdOf(role: RoleId): string
  ref(kind: string, objectId: string, version: number, role: string, taskId?: string | null): SlotRef
  cleanup(): void
}

function env(): Env {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const projects = new ProjectService(db)
  const tasks = new TaskService(db)
  const plans = new PlanService(db, undefined, tasks)
  const results = new ResultService(db)
  const notices = new NoticeService(db)
  const project = projects.create({ key: 'NT', name: 'Notices' })

  const e: Env = {
    db, projects, plans, tasks, results, notices,
    projectId: project.id,
    add: (ref, role, dependsOn = []) => ({
      ref, taskId: null, role: role as RoleId,
      change: 'add' as const, content: `do ${ref}`, dependsOn,
    }),
    register(taskList, roles, title = 'p') {
      const { plan } = plans.register({
        projectId: project.id, title, relevantRoles: roles as never,
        rolesReason: 'r', tasks: taskList, undecided: [],
      })
      return plan.id
    },
    activate(taskList, roles = ['product']) {
      for (const r of roles) projects.setMember(project.id, r, memberOf(r))
      const id = e.register(taskList, roles)
      for (const r of roles) {
        plans.confirm({
          planId: id,
          role: r,
          outcome: 'agree',
          submittedBy: memberOf(r),
          declaredMember: memberOf(r),
        })
      }
      return tasks.listByProject(project.id).map((t) => t.task.id)
    },
    taskIdOf(role) {
      const found = tasks.listByProject(project.id).find((t) => t.task.role === role)
      assert.ok(found !== undefined, `expected a task for role ${role}`)
      return found.task.id
    },
    ref: (kind, objectId, version, role, taskId = null) => ({
      kind: kind as SlotRef['kind'],
      projectId: project.id,
      objectId,
      version,
      role: role as RoleId,
      taskId,
    }),
    cleanup() {
      db.close()
    },
  }
  return e
}

describe('todos are derived from undecided slots', () => {
  test('an unconfirmed plan produces one todo per relevant role', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.projects.setMember(e.projectId, 'design', 'Li')
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])

    const todos = e.notices.todos({ projectId: e.projectId })
    assert.equal(todos.length, 2, 'one per role that must agree')
    assert.deepEqual(todos.map((t) => t.role).sort(), ['design', 'product'])
    assert.ok(todos.every((t) => t.kind === 'plan_confirmation'))
    assert.ok(todos.every((t) => t.objectId === planId), 'each points at the plan')
    assert.ok(todos.every((t) => t.version === 1))
    e.cleanup()
  })

  test('a confirmed role no longer has a todo, the others still do', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.projects.setMember(e.projectId, 'design', 'Li')
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })

    const todos = e.notices.todos({ projectId: e.projectId })
    assert.deepEqual(todos.map((t) => t.role), ['design'], 'only the outstanding role')
    e.cleanup()
  })

  test('activating the plan clears every confirmation todo', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    assert.equal(e.notices.todos({ projectId: e.projectId }).length, 0)
    e.cleanup()
  })

  /**
   * The mutation-prone case: a revision VOIDS slots rather than deleting them, so a query
   * that forgets `voided_at IS NULL` would resurrect a todo nobody can act on.
   */
  test('a slot voided by a revision is NOT a todo', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.projects.setMember(e.projectId, 'design', 'Li')
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])
    e.plans.confirm({ planId, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li' })

    // Revise: this voids BOTH existing slots and creates fresh ones.
    e.plans.revise({
      planId, title: 'p2', relevantRoles: ['product', 'design'],
      rolesReason: 'r', tasks: [e.add('a', 'product')], undecided: [],
      reason: 'scope changed',
    })

    const todos = e.notices.todos({ projectId: e.projectId })
    // Version 1 must contribute nothing, even though its rows still exist.
    assert.equal(
      todos.filter((t) => t.version === 1).length,
      0,
      'voided slots must not appear as todos',
    )
    assert.equal(todos.filter((t) => t.version === 2).length, 2, 'only the live version')
    e.cleanup()
  })

  test('a submitted result produces a review todo for the owning role', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'here', files: [], selfCheck: 'ok', submittedBy: 'Zhang',
    })

    const todos = e.notices.todos({ projectId: e.projectId })
    assert.equal(todos.length, 1, 'submitting creates exactly one thing to do')
    assert.equal(todos[0]?.kind, 'result_review')
    assert.equal(todos[0]?.role, 'product', 'and it belongs to the owning role')
    assert.equal(todos[0]?.objectId, r.resultId)

    // Reviewing it clears the todo.
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'return', reason: 'no',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    assert.equal(e.notices.todos({ projectId: e.projectId }).length, 0)
    e.cleanup()
  })

  test('an open acceptance slot produces a todo for the downstream task role', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)

    const todos = e.notices.todos({ projectId: e.projectId })
    const accepting = todos.filter((t) => t.kind === 'result_acceptance')
    assert.equal(accepting.length, 1)
    assert.equal(accepting[0]?.role, 'design', 'the downstream role owes the decision')
    assert.equal(accepting[0]?.taskId, e.taskIdOf('design'))
    e.cleanup()
  })

  /**
   * Added because a mutation that dropped the `outcome IS NULL` filter on acceptances
   * SURVIVED: the suite covered a decided rejection producing a NOTICE, but never asserted
   * that a decided acceptance stops being a TODO.
   */
  test('a DECIDED acceptance is no longer a todo', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)
    assert.equal(e.notices.todos({ projectId: e.projectId }).length, 1, 'it starts as a todo')

    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'accept',
      submittedBy: 'Li', declaredMember: 'Li',
    })

    assert.equal(
      e.notices.todos({ projectId: e.projectId }).length,
      0,
      'deciding closes it — a decided acceptance must not linger as work to do',
    )
    // And a rejection is the same: decided is decided.
    e.cleanup()
  })

  test('a REJECTED acceptance is also no longer a todo', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)

    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'reject',
      reason: 'not good enough', submittedBy: 'Li', declaredMember: 'Li',
    })

    assert.equal(
      e.notices.todos({ projectId: e.projectId, kinds: ['result_acceptance'] }).length,
      0,
      'the decision is made, so there is nothing left to decide',
    )
    e.cleanup()
  })
})

describe('filtering', () => {
  test('by role, without leaking another role\'s todos', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.projects.setMember(e.projectId, 'design', 'Li')
    e.register([e.add('a', 'product')], ['product', 'design'])

    const mine = e.notices.todos({ projectId: e.projectId, roles: ['design'] })
    assert.equal(mine.length, 1)
    assert.ok(mine.every((t) => t.role === 'design'), 'no other role leaks in')
    e.cleanup()
  })

  test('by kind', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    // Two plans left WAITING, so there is something of the filtered kind to find.
    e.register([e.add('a', 'product')], ['product'])
    e.register([e.add('b', 'product')], ['product'])
    assert.equal(
      e.notices.todos({ projectId: e.projectId, kinds: ['plan_confirmation'] }).length,
      2,
    )

    // A result review is a DIFFERENT kind, so filtering it out yields nothing here.
    assert.equal(e.notices.todos({ projectId: e.projectId, kinds: ['result_review'] }).length, 0)
    e.cleanup()
  })

  test('kind filtering separates todos from notices', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    // task_completed is a NOTICE, so asking for todos never returns it.
    assert.equal(e.notices.todos({ projectId: e.projectId, kinds: ['task_completed'] }).length, 0)
    assert.equal(e.notices.list({ projectId: e.projectId, kinds: ['task_completed'] }).length, 1)
    e.cleanup()
  })

  test('unreadOnly returns only what has not been read', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.projects.setMember(e.projectId, 'design', 'Li')
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])

    e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'design'))

    const unread = e.notices.todos({ projectId: e.projectId, unreadOnly: true })
    assert.deepEqual(unread.map((t) => t.role), ['product'], 'the read one is filtered out')
    e.cleanup()
  })

  test('an unknown project is refused', () => {
    const e = env()
    assert.throws(() => e.notices.todos({ projectId: 'nope' }))
    e.cleanup()
  })

  /**
   * Found by a probe, not by a test: `markRead` used to accept ANY address and store a row
   * for it, reporting success. That row could never be matched by any query, so the caller
   * was told a read was recorded when nothing observable had happened.
   */
  test('marking a NON-EXISTENT slot read is refused', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const err = throwsCollaboration(() =>
      e.notices.markRead(e.ref('plan_confirmation', 'no-such-plan', 1, 'product')),
    )
    assert.equal(err.code, 'NOTICE_NOT_FOUND')

    // And nothing was written.
    assert.equal(e.notices.isRead(e.ref('plan_confirmation', 'no-such-plan', 1, 'product')), false)
    e.cleanup()
  })

  test('a decided slot still EXISTS, so reading it is allowed', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })

    // The plan activated, so this is no longer a todo — but it is still a real record.
    const { changed } = e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'product'))
    assert.equal(changed, true)
    e.cleanup()
  })
})

describe('unread counts', () => {
  test('counts what a role owes', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.register([e.add('a', 'product')], ['product'])
    e.register([e.add('b', 'product')], ['product'])

    const counts = e.notices.unread(e.projectId)
    const product = counts.find((c) => c.role === 'product')
    assert.equal(product?.pending, 2)
    assert.equal(product?.read, 0)
    assert.equal(product?.unread, 2)

    const design = counts.find((c) => c.role === 'design')
    assert.equal(design?.unread, 0, 'a role with nothing outstanding owes nothing')
    e.cleanup()
  })

  test('a vacant role lists its todos but owes NO unread', () => {
    const e = env()
    // Deliberately no member set for design.
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.register([e.add('a', 'product')], ['product', 'design'])

    const todos = e.notices.todos({ projectId: e.projectId, roles: ['design'] })
    assert.equal(todos.length, 1, 'the todo is still listed')
    assert.equal(todos[0]?.member, null, 'and shows as vacant')

    const design = e.notices.unread(e.projectId).find((c) => c.role === 'design')
    assert.equal(design?.pending, 1, 'the slot exists')
    assert.equal(design?.unread, 0, 'but nobody can be behind on it')
    e.cleanup()
  })

  test('reading reduces unread', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])

    e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'product'))
    const product = e.notices.unread(e.projectId).find((c) => c.role === 'product')
    assert.equal(product?.pending, 1)
    assert.equal(product?.read, 1)
    assert.equal(product?.unread, 0)
    e.cleanup()
  })

  test('unread never goes negative, even when everything is read', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])

    e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'product'))
    e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'product'))
    e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'product'))

    const product = e.notices.unread(e.projectId).find((c) => c.role === 'product')
    assert.equal(product?.unread, 0)
    assert.ok((product?.unread ?? -1) >= 0, 'never negative')
    e.cleanup()
  })

  test('a notice is never owed', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    // Completing produces a completion NOTICE (it happened, nothing to decide).
    assert.equal(e.notices.list({ projectId: e.projectId }).length, 1)
    const product = e.notices.unread(e.projectId).find((c) => c.role === 'product')
    assert.equal(product?.pending, 0, 'a notice contributes nothing to pending')
    e.cleanup()
  })
})

describe('reading is not deciding', () => {
  test('marking a plan todo read leaves the plan unconfirmed', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])
    const before = e.plans.get(planId)

    const { changed } = e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'product'))
    assert.equal(changed, true)

    const after = e.plans.get(planId)
    assert.equal(after.plan.activatedAt, null, 'reading did NOT activate it')
    assert.equal(after.gate.kind, 'waiting', 'and the gate is untouched')
    assert.equal(
      after.slots.find((s) => s.role === 'product')?.outcome,
      before.slots.find((s) => s.role === 'product')?.outcome,
      'the decision is unchanged',
    )
    e.cleanup()
  })

  test('marking a result todo read leaves the task incomplete', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })

    e.notices.markRead(e.ref('result_review', r.resultId, 1, 'product'))

    assert.equal(e.tasks.get(taskId).task.completedAt, null, 'reading is not completing')
    assert.equal(e.results.reviewOf(r.resultId, 1)?.outcome, null, 'the review is still undecided')
    e.cleanup()
  })

  test('a read todo does NOT disappear — only deciding closes it', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])

    e.notices.markRead(e.ref('plan_confirmation', planId, 1, 'product'))
    assert.equal(e.notices.todos({ projectId: e.projectId }).length, 1, 'still listed')

    // Only the decision removes it.
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })
    assert.equal(e.notices.todos({ projectId: e.projectId }).length, 0)
    e.cleanup()
  })

  test('reading twice counts once', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])
    const ref = e.ref('plan_confirmation', planId, 1, 'product')

    assert.equal(e.notices.markRead(ref).changed, true, 'the first read is a change')
    assert.equal(e.notices.markRead(ref).changed, false, 'the second is not')
    assert.equal(e.notices.markRead(ref).changed, false)

    const product = e.notices.unread(e.projectId).find((c) => c.role === 'product')
    assert.equal(product?.read, 1, 'counted once, not three times')
    e.cleanup()
  })

  test('markAllRead clears everything a role owes and nothing else', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    e.projects.setMember(e.projectId, 'design', 'Li')
    e.register([e.add('a', 'product')], ['product', 'design'])
    e.register([e.add('b', 'product')], ['product', 'design'])

    const changed = e.notices.markAllRead(e.projectId, 'product')
    assert.equal(changed, 2)

    const counts = e.notices.unread(e.projectId)
    assert.equal(counts.find((c) => c.role === 'product')?.unread, 0)
    assert.equal(counts.find((c) => c.role === 'design')?.unread, 2, 'design is untouched')
    e.cleanup()
  })

  test('a rejection produces a notice carrying the reason, and no todo', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'reject',
      reason: 'missing the edge cases', submittedBy: 'Li', declaredMember: 'Li',
    })

    const rejected = e.notices.list({ projectId: e.projectId }).filter((n) => n.kind === 'result_rejected')
    assert.equal(rejected.length, 1, 'the rejection is announced')
    assert.equal(rejected[0]?.detail, 'missing the edge cases', 'and carries the reason')
    e.cleanup()
  })
})

/**
 * A VACANT role cannot decide anything.
 *
 * Found by the M6 smoke test, not by a test: the live model observed that `design` had no
 * member anywhere in `project_roles`, yet its confirmation was accepted on the strength of a
 * `submitted_by` name alone. MVP-019 requires a plan with a vacant role to WAIT and be
 * flagged — which is only true if the vacant slot cannot be filled by whoever calls.
 */
describe('a vacant role cannot decide', () => {
  test('a vacant role cannot confirm a plan', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    // design is left vacant.
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])

    const err = throwsCollaboration(() =>
      e.plans.confirm({ planId, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li' }),
    )
    assert.equal(err.code, 'VACANT_ROLE_CANNOT_CONFIRM')

    // And the plan really does stay waiting — the vacancy is a hard stop, not a display.
    const view = e.plans.get(planId)
    assert.equal(view.plan.activatedAt, null)
    assert.equal(view.slots.find((s) => s.role === 'design')?.outcome, null)
    e.cleanup()
  })

  test('assigning a member unblocks the confirmation', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])

    assert.equal(
      throwsCollaboration(() =>
        e.plans.confirm({ planId, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li' }),
      ).code,
      'VACANT_ROLE_CANNOT_CONFIRM',
    )

    // The fix is to say WHO holds the role, not to pass a different name.
    e.projects.setMember(e.projectId, 'design', 'Li')
    e.plans.confirm({ planId, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li' })
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })
    assert.notEqual(e.plans.get(planId).plan.activatedAt, null, 'now it can take effect')
    e.cleanup()
  })

  test('a vacant role cannot review a result', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })

    // Vacate the role AFTER the task exists, so the slot is real but unstaffed.
    e.db
      .prepare('DELETE FROM project_roles WHERE project_id = ? AND role = ?')
      .run(e.projectId, 'product')

    const err = throwsCollaboration(() =>
      e.results.review({
        resultId: r.resultId, version: 1, outcome: 'complete',
        submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
      }),
    )
    assert.equal(err.code, 'VACANT_ROLE_CANNOT_CONFIRM')
    assert.equal(e.tasks.get(taskId).task.completedAt, null, 'nothing was completed')
    e.cleanup()
  })

  test('a vacant role cannot decide an acceptance', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)

    e.db
      .prepare('DELETE FROM project_roles WHERE project_id = ? AND role = ?')
      .run(e.projectId, 'design')

    const err = throwsCollaboration(() =>
      e.results.decide({
        resultId: r.resultId, version: 1, taskId: b, outcome: 'accept', submittedBy: 'Li', declaredMember: 'Li',
      }),
    )
    assert.equal(err.code, 'VACANT_ROLE_CANNOT_CONFIRM')
    e.cleanup()
  })
})

/**
 * Two invariants that mutation testing flagged as SURVIVING, i.e. no test distinguished them.
 *
 * A survivor is either a missing test or code that no reachable state can exercise. These
 * are the second kind, and the tests below pin down WHY, by asserting the structural reason
 * rather than the filter — so if the reason ever stops holding, these fail.
 */
describe('invariants that no reachable state can violate', () => {
  test('an activated plan cannot have an undecided slot, so the filter is structural', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })

    // Activation required every slot agreed, so there is nothing undecided left.
    const view = e.plans.get(planId)
    assert.equal(view.plan.activatedAt !== null, true, 'it activated')
    assert.equal(view.gate.kind, 'unanimous')
    assert.equal(
      view.slots.filter((s) => s.outcome === null && s.voidedAt === null).length,
      0,
      'no undecided, unvoided slot can exist on an activated plan',
    )

    // The only way to create fresh undecided slots is a revision, and that is refused.
    const err = throwsCollaboration(() =>
      e.plans.revise({
        planId, title: 'x', relevantRoles: ['product'],
        rolesReason: 'r', tasks: [e.add('a', 'product')], undecided: [], reason: 'try',
      }),
    )
    assert.equal(err.code, 'PLAN_ALREADY_ACTIVE', 'so the state is unreachable')
    e.cleanup()
  })

  test('reads can never exceed pending, so the clamp is unreachable', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const planId = e.register([e.add('a', 'product')], ['product'])
    const ref = e.ref('plan_confirmation', planId, 1, 'product')

    // Read it, then decide it: the todo disappears, and the read stops being counted
    // because it is only counted against slots that are STILL todos.
    e.notices.markRead(ref)
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })

    const product = e.notices.unread(e.projectId).find((c) => c.role === 'product')
    assert.equal(product?.pending, 0)
    assert.equal(product?.read, 0, 'a read on a closed todo does not count as read-of-pending')
    assert.equal(product?.unread, 0)
    assert.ok(
      (product?.read ?? 0) <= (product?.pending ?? 0),
      'read can never exceed pending, which is why the clamp is unreachable',
    )
    e.cleanup()
  })
})
