/**
 * Tasks and the activation resolver (M5 identity layer).
 *
 * The interesting behaviour is all in activation: it is where a proposal becomes a durable
 * object, and where a plan can still fail AFTER its confirmations were collected. Several
 * tests exist specifically to pin down that late failure rather than the happy path.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { PlanService } from '../service/plan-service.js'
import { TaskService } from '../service/task-service.js'
import { CollaborationError } from '../domain/error.js'
import type { PlannedTask } from '../domain/plan.js'
import type { RoleId } from '../domain/roles.js'
import type { TaskVersionRecord } from '../domain/task.js'

const ROLES = [
  'pm', 'product', 'design', 'scenemodel', 'sceneart', 'data', 'frontend', 'backend', 'ue',
] as const

interface Env {
  db: DatabaseSync
  projects: ProjectService
  plans: PlanService
  tasks: TaskService
  projectId: string
  add(ref: string, role: string, dependsOn?: string[]): PlannedTask
  modify(ref: string, taskId: string, role: string, dependsOn?: string[]): PlannedTask
  cancel(ref: string, taskId: string, role: string): PlannedTask
  activate(tasks: PlannedTask[], roles?: readonly RoleId[]): readonly string[]
  cleanup(): void
}

function env(): Env {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const projects = new ProjectService(db)
  const tasks = new TaskService(db)
  const plans = new PlanService(db, undefined, tasks)
  const project = projects.create({ key: 'ALPHA', name: 'Alpha' })

  return {
    db,
    projects,
    plans,
    tasks,
    projectId: project.id,
    add: (ref, role, dependsOn = []) => ({
      ref, taskId: null, role: role as RoleId,
      change: 'add' as const, content: `do ${ref}`, dependsOn,
    }),
    modify: (ref, taskId, role, dependsOn = []) => ({
      ref, taskId, role: role as RoleId,
      change: 'modify' as const, content: `redo ${ref}`, dependsOn,
    }),
    cancel: (ref, taskId, role) => ({
      ref, taskId, role: role as RoleId,
      change: 'cancel' as const, content: `cancel ${ref}`, dependsOn: [],
    }),
    activate(taskList, roles = ['product']) {
      for (const r of roles) projects.setMember(project.id, r, `who-${r}`)
      const before = tasks.listByProject(project.id).map((t) => t.task.id)
      const { plan } = plans.register({
        projectId: project.id, title: 'p', relevantRoles: roles as never,
        rolesReason: 'r', tasks: taskList, undecided: [],
      })
      for (const r of roles) {
        plans.confirm({
          planId: plan.id,
          role: r,
          outcome: 'agree',
          submittedBy: `who-${r}`,
          declaredMember: `who-${r}`,
        })
      }
      return tasks
        .listByProject(project.id)
        .map((t) => t.task.id)
        .filter((id) => !before.includes(id))
    },
    cleanup() {
      db.close()
    },
  }
}

function versionOf(e: Env, taskId: string, version: number): TaskVersionRecord {
  const found = e.tasks.get(taskId).versions.find((v) => v.version === version)
  assert.ok(found !== undefined, `task ${taskId} should have version ${version}`)
  return found
}

/**
 * Capture a thrown CollaborationError.
 *
 * `assert.throws` does not hand the error back, so reading `.code` off its result is always
 * undefined. This wraps it so the code and details can actually be asserted on.
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

describe('tasks come into being only at activation', () => {
  test('registering a plan creates no task', () => {
    const e = env()
    e.plans.register({
      projectId: e.projectId, title: 'p', relevantRoles: ['product'] as never,
      rolesReason: 'r', tasks: [e.add('a', 'product')], undecided: [],
    })
    assert.equal(e.tasks.listByProject(e.projectId).length, 0, 'a proposal is not a task')
    e.cleanup()
  })

  test('partial agreement creates no task', () => {
    const e = env()
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 'p', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r', tasks: [e.add('a', 'product')], undecided: [],
    })
    e.projects.setMember(e.projectId, 'product', 'Z')
    e.projects.setMember(e.projectId, 'design', 'L')
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    assert.equal(e.tasks.listByProject(e.projectId).length, 0)
    e.cleanup()
  })

  test('activation creates one task per add, at version 1', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product'), e.add('b', 'design')])
    assert.equal(ids.length, 2)

    const first = e.tasks.listByProject(e.projectId)[0]
    assert.ok(first !== undefined)
    assert.equal(first.task.currentVersion, 1)
    assert.equal(first.versions.length, 1)
    assert.equal(first.task.completedAt, null)
    assert.equal(first.task.cancelledAt, null)
    e.cleanup()
  })

  test('a task carries the role but NOT a person', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const t = e.tasks.get(ids[0] as string)
    assert.equal(t.task.role, 'product')
    // The person is derived from the role and the project's members; storing it would go
    // stale the moment someone is replaced. Assert the field is genuinely absent.
    assert.equal(Object.prototype.hasOwnProperty.call(t.task, 'member'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(t.task, 'assignee'), false)
    e.cleanup()
  })

  test('the ledger records which ref became which task', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design')])
    const all = e.tasks.listByProject(e.projectId)
    for (const t of all) {
      const creator = e.tasks.creatorOf(t.task.id)
      assert.ok(creator !== null, 'every task was created by a plan and the ledger says so')
      assert.equal(creator.change, 'add')
      assert.equal(creator.taskVersion, 1)
    }
    // Refs are preserved, which is the whole reason the ledger exists.
    const refs = all.map((t) => e.tasks.creatorOf(t.task.id)?.ref).sort()
    assert.deepEqual(refs, ['a', 'b'])
    e.cleanup()
  })
})

describe('dependency resolution runs in two passes', () => {
  test('a task can depend on another task created by the SAME activation', () => {
    const e = env()
    // b depends on a, and BOTH are new. One pass could not resolve a's id yet.
    const ids = e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])])
    assert.equal(ids.length, 2)

    const list = e.tasks.listByProject(e.projectId)
    const b = list.find((t) => t.task.role === 'design')
    const a = list.find((t) => t.task.role === 'product')
    assert.ok(a !== undefined && b !== undefined)

    // Rows from node:sqlite have a null prototype, so deepEqual against an object literal
    // fails even when the values match. Compare the extracted ids instead.
    const depIds = (
      e.db
        .prepare('SELECT depends_on_task_id FROM task_version_deps WHERE task_id = ?')
        .all(b.task.id) as unknown as { depends_on_task_id: string }[]
    ).map((r) => r.depends_on_task_id)
    assert.deepEqual(depIds, [a.task.id], "b's dependency must point at the real id of a")
    e.cleanup()
  })

  test('a dependency on a nonexistent ref is refused and nothing is created', () => {
    const e = env()
    const err = throwsCollaboration(() => e.activate([e.add('a', 'product', ['ghost'])]))
    assert.equal(err.code, 'DEPENDENCY_MISSING_TASK')
    assert.equal(e.tasks.listByProject(e.projectId).length, 0, 'no half-created task survives')
    e.cleanup()
  })
})

describe('the two identifiers are enforced (ADR-0008)', () => {
  test('add must not name a task', () => {
    const e = env()
    const bad = { ...e.add('a', 'product'), taskId: 'some-existing-task' }
    const err = throwsCollaboration(() =>
      e.plans.register({
        projectId: e.projectId, title: 'p', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [bad], undecided: [],
      }),
    )
    assert.equal(err.code, 'ADD_MUST_NOT_NAME_A_TASK')
    e.cleanup()
  })

  test('modify must name a task', () => {
    const e = env()
    const bad = { ...e.add('a', 'product'), change: 'modify' as const }
    const err = throwsCollaboration(() =>
      e.plans.register({
        projectId: e.projectId, title: 'p', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [bad], undecided: [],
      }),
    )
    assert.equal(err.code, 'TASK_TARGET_REQUIRED')
    e.cleanup()
  })

  test('cancelling one task twice in a plan is refused', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const err = throwsCollaboration(() =>
      e.plans.register({
        projectId: e.projectId, title: 'p', relevantRoles: ['product'] as never,
        rolesReason: 'r',
        tasks: [
          e.cancel('x', ids[0] as string, 'product'),
          e.cancel('y', ids[0] as string, 'product'),
        ],
        undecided: [],
      }),
    )
    assert.equal(err.code, 'DUPLICATE_TASK_TARGET')
    e.cleanup()
  })

  test('modify and cancel of the same task in one plan is refused', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const err = throwsCollaboration(() =>
      e.plans.register({
        projectId: e.projectId, title: 'p', relevantRoles: ['product'] as never,
        rolesReason: 'r',
        tasks: [
          e.modify('m', ids[0] as string, 'product'),
          e.cancel('c', ids[0] as string, 'product'),
        ],
        undecided: [],
      }),
    )
    assert.equal(err.code, 'DUPLICATE_TASK_TARGET')
    e.cleanup()
  })

  /**
   * Two different tasks, each targeted once, is perfectly legal — the duplicate check must
   * not be so broad that it refuses this. Added because a mutation that disabled the check
   * entirely was caught, but nothing pinned down the boundary it must NOT cross.
   */
  test('targeting two DIFFERENT tasks once each is allowed', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design')])
    const list = e.tasks.listByProject(e.projectId)
    const taskA = list.find((t) => t.task.role === 'product')?.task.id as string
    const taskB = list.find((t) => t.task.role === 'design')?.task.id as string

    e.activate([e.modify('ma', taskA, 'product'), e.cancel('cb', taskB, 'design')])

    assert.equal(e.tasks.get(taskA).task.currentVersion, 2, 'a was modified')
    assert.notEqual(e.tasks.get(taskB).task.cancelledAt, null, 'b was cancelled')
    e.cleanup()
  })

  /**
   * The duplicate check must also apply ACROSS the two directions when the SAME task is
   * named by two modifies.
   */
  test('two modifies of the same task in one plan is refused', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const err = throwsCollaboration(() =>
      e.plans.register({
        projectId: e.projectId, title: 'p', relevantRoles: ['product'] as never,
        rolesReason: 'r',
        tasks: [
          e.modify('m1', ids[0] as string, 'product'),
          e.modify('m2', ids[0] as string, 'product'),
        ],
        undecided: [],
      }),
    )
    assert.equal(err.code, 'DUPLICATE_TASK_TARGET')
    e.cleanup()
  })
})

describe('modify appends a version, never overwrites', () => {
  test('a modify produces version 2 and version 1 remains readable', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string
    assert.equal(e.tasks.get(taskId).task.currentVersion, 1)

    e.activate([e.modify('a2', taskId, 'product')])

    const after = e.tasks.get(taskId)
    assert.equal(after.task.currentVersion, 2, 'the pointer advanced')
    assert.equal(after.versions.length, 2, 'both versions survive')

    // The ORIGINAL content is still there, unmodified. This is the property that lets a
    // result record its task version and still be interpretable later.
    assert.equal(versionOf(e, taskId, 1).content, 'do a')
    assert.equal(versionOf(e, taskId, 2).content, 'redo a2')
    e.cleanup()
  })

  test('a version records the plan version that produced it', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string
    e.activate([e.modify('a2', taskId, 'product')])

    const v1 = versionOf(e, taskId, 1)
    const v2 = versionOf(e, taskId, 2)
    // Each `activate` call registers a fresh plan, so both versions record version 1 — but
    // of DIFFERENT plans. Asserting the plan id differs is what actually distinguishes them.
    assert.equal(v1.createdByPlanVersion, 1)
    assert.equal(v2.createdByPlanVersion, 1)
    assert.notEqual(v1.createdByPlanId, v2.createdByPlanId, 'two different plans')
    e.cleanup()
  })

  test('a revision within one plan records the plan version that produced it', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string

    // A NEW plan that modifies the task, revised once BEFORE it activates. Revising the
    // already-active plan is refused (MVP-021), so the revision must happen while the gate
    // is still open — which is also the realistic case.
    const firstPlanId = e.tasks.creatorOf(taskId)?.planId
    assert.ok(firstPlanId !== undefined)
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 'p1', relevantRoles: ['product'] as never,
      rolesReason: 'r', tasks: [e.modify('m', taskId, 'product')], undecided: [],
    })
    const revised = e.plans.revise({
      planId: plan.id, title: 'p2', relevantRoles: ['product'] as never, rolesReason: 'r',
      tasks: [e.modify('m', taskId, 'product')], undecided: [], reason: 'grow',
    })
    assert.equal(revised.plan.version, 2)
    e.plans.confirm({
      planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product',
    })

    // Version 1 of the task came from the first plan; version 2 from revision 2 of this one.
    assert.equal(versionOf(e, taskId, 1).createdByPlanId, firstPlanId)
    assert.equal(versionOf(e, taskId, 2).createdByPlanId, plan.id)
    assert.equal(versionOf(e, taskId, 2).createdByPlanVersion, 2)
    e.cleanup()
  })

  test('a modify can change the dependencies, and the old version keeps its own', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design')])

    // Look up by ROLE: both tasks share a created_at, so list order is not guaranteed.
    const list = e.tasks.listByProject(e.projectId)
    const taskA = list.find((t) => t.task.role === 'product')?.task.id
    const taskB = list.find((t) => t.task.role === 'design')?.task.id
    assert.ok(taskA !== undefined && taskB !== undefined)

    e.activate([e.modify('a2', taskA, 'product', [taskB])])

    assert.deepEqual(versionOf(e, taskA, 1).dependsOn, [], 'version 1 had no inputs')
    assert.deepEqual(versionOf(e, taskA, 2).dependsOn, [taskB], 'version 2 does')
    e.cleanup()
  })
})

describe('cancellation is terminal and keeps history', () => {
  test('a cancelled task keeps every version and is marked, not deleted', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string
    e.activate([e.modify('a2', taskId, 'product')])
    e.activate([e.cancel('a3', taskId, 'product')])

    const t = e.tasks.get(taskId)
    assert.notEqual(t.task.cancelledAt, null)
    assert.equal(t.versions.length, 2, 'cancelling does not remove the definition history')
    e.cleanup()
  })

  test('a cancelled task cannot be modified again', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string
    e.activate([e.cancel('a2', taskId, 'product')])

    const err = throwsCollaboration(() => e.activate([e.modify('a3', taskId, 'product')]))
    assert.equal(err.code, 'TASK_FROZEN')
    assert.equal(err.details?.reason, 'cancelled')
    e.cleanup()
  })

  test('a completed task cannot be modified', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string
    // Completion belongs to a later layer; simulate the state it will produce.
    e.db
      .prepare('UPDATE tasks SET completed_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', taskId)

    const err = throwsCollaboration(() => e.activate([e.modify('a2', taskId, 'product')]))
    assert.equal(err.code, 'TASK_FROZEN')
    assert.equal(err.details?.reason, 'completed')
    e.cleanup()
  })

  test('cancelling a task that something depends on is refused', () => {
    const e = env()
    // b depends on a (by REF, so both are created together), then a cannot be cancelled.
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])])

    // Look the task up by ROLE, not by position: both are created in the same activation
    // with the same timestamp, so list order is not guaranteed.
    const list = e.tasks.listByProject(e.projectId)
    const taskA = list.find((t) => t.task.role === 'product')?.task.id
    assert.ok(taskA !== undefined, 'the product task exists')

    const err = throwsCollaboration(() => e.activate([e.cancel('a2', taskA, 'product')]))
    assert.equal(err.code, 'TASK_HAS_DEPENDENTS')

    // And the rollback left it alone.
    assert.equal(e.tasks.get(taskA).task.cancelledAt, null, 'the cancel did not take effect')
    e.cleanup()
  })
})

describe('a plan can fail AFTER its confirmations are collected', () => {
  /**
   * The decisive test for ADR-0009's second check.
   *
   * Registration validated the target when it was fine. The task then completed while the
   * plan waited for agreement. Without re-validating at activation, the modify would land on
   * a completed task and the freeze guarantee would silently fail.
   */
  test('a modify that becomes illegal while the gate is open is refused at activation', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string

    // Register a plan that modifies it, requiring TWO roles so the gate stays open.
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 'p', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r', tasks: [e.modify('a2', taskId, 'product')], undecided: [],
    })
    e.projects.setMember(e.projectId, 'product', 'Z')
    e.projects.setMember(e.projectId, 'design', 'L')

    // One agreement so far: the gate is still open.
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    assert.equal(e.tasks.get(taskId).task.currentVersion, 1, 'nothing changed yet')

    // The task completes WHILE the plan waits.
    e.db
      .prepare('UPDATE tasks SET completed_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', taskId)

    // The second agreement closes the gate — and activation must refuse.
    const err = throwsCollaboration(() =>
      e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'L', declaredMember: 'L' }),
    )
    assert.equal(err.code, 'TASK_FROZEN')
    assert.equal(err.details?.reason, 'completed')

    // Crucially the plan did NOT activate, so it is not claiming to be in effect.
    assert.equal(e.tasks.get(taskId).task.currentVersion, 1, 'the task was left untouched')
    assert.equal(e.plans.get(plan.id).plan.activatedAt, null, 'the plan must not be marked active')
    e.cleanup()
  })

  test('the failure is atomic: no task version, no ledger line, no activation', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string

    // Two proposals: a valid modify AND a second modify of the same task is refused at
    // registration, so use an add whose dependency is valid at registration but whose
    // target is frozen by activation time.
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 'p', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r',
      // First proposal succeeds, second one targets a task that will be frozen by then.
      tasks: [e.add('b', 'design'), e.modify('m', taskId, 'product')],
      undecided: [],
    })
    e.projects.setMember(e.projectId, 'product', 'Z')
    e.projects.setMember(e.projectId, 'design', 'L')
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })

    // Freeze the modify target while the gate is still open.
    e.db
      .prepare('UPDATE tasks SET completed_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', taskId)

    throwsCollaboration(() =>
      e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'L', declaredMember: 'L' }),
    )

    // The `add` that would have succeeded must have been rolled back with everything else.
    assert.equal(e.tasks.get(taskId).task.currentVersion, 1, 'the modify was rolled back')
    assert.equal(e.tasks.get(taskId).versions.length, 1)
    assert.equal(e.tasks.outcomesOf(plan.id, 1).length, 0, 'no ledger lines survive')
    assert.equal(
      e.tasks.listByProject(e.projectId).length,
      1,
      'the task that WOULD have been created must not survive the rollback',
    )
    assert.equal(e.plans.get(plan.id).plan.activatedAt, null)
    e.cleanup()
  })

  test('after a failed activation the plan can be revised and activated', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    const taskId = ids[0] as string

    const { plan } = e.plans.register({
      projectId: e.projectId, title: 'p', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r', tasks: [e.modify('m', taskId, 'product')], undecided: [],
    })
    e.projects.setMember(e.projectId, 'product', 'Z')
    e.projects.setMember(e.projectId, 'design', 'L')
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })

    // Freeze the target during the gate, so activation fails.
    e.db
      .prepare('UPDATE tasks SET completed_at = ? WHERE id = ?')
      .run('2026-01-01T00:00:00.000Z', taskId)
    throwsCollaboration(() =>
      e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'L', declaredMember: 'L' }),
    )

    // Recovery: the task is un-frozen (as if the completion were corrected elsewhere), then
    // the plan is revised. The failure must not have wedged the plan.
    e.db.prepare('UPDATE tasks SET completed_at = NULL WHERE id = ?').run(taskId)
    const revised = e.plans.revise({
      planId: plan.id, title: 'p2', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r', tasks: [e.modify('m', taskId, 'product')], undecided: [],
      reason: 'retry now that the target is editable',
    })
    assert.equal(revised.plan.version, 2)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'L', declaredMember: 'L' })

    assert.equal(e.tasks.get(taskId).task.currentVersion, 2, 'the revision activated cleanly')
    e.cleanup()
  })
})

describe('reads', () => {
  test('listing a project returns tasks with their history', () => {
    const e = env()
    const ids = e.activate([e.add('a', 'product')])
    e.activate([e.modify('a2', ids[0] as string, 'product')])

    const list = e.tasks.listByProject(e.projectId)
    assert.equal(list.length, 1)
    assert.equal(list[0]?.versions.length, 2)
    assert.equal(list[0]?.current.version, 2)
    e.cleanup()
  })

  test('an unknown task is TASK_NOT_FOUND, not an empty result', () => {
    const e = env()
    const err = throwsCollaboration(() => e.tasks.get('nope'))
    assert.equal(err.code, 'TASK_NOT_FOUND')
    e.cleanup()
  })

  test('tasks are scoped to their project', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const other = e.projects.create({ key: 'BETA', name: 'Beta' })
    assert.equal(e.tasks.listByProject(other.id).length, 0)
    e.cleanup()
  })

  test('a task in another project cannot be a dependency', () => {
    const e = env()
    const other = e.projects.create({ key: 'BETA', name: 'Beta' })
    // 'X' holds every role in the other project and confirms as 'X' below (ADR-0014).
    for (const r of ROLES) e.projects.setMember(other.id, r, 'X')
    const foreignPlans = new PlanService(e.db, undefined, e.tasks)
    const { plan: foreign } = foreignPlans.register({
      projectId: other.id, title: 'o', relevantRoles: ['product'] as never,
      rolesReason: 'r', tasks: [e.add('z', 'product')], undecided: [],
    })
    foreignPlans.confirm({
      planId: foreign.id, role: 'product', outcome: 'agree', submittedBy: 'X', declaredMember: 'X',
    })
    const foreignTask = e.tasks.listByProject(other.id)[0]?.task.id as string

    const err = throwsCollaboration(() => e.activate([e.add('a', 'product', [foreignTask])]))
    assert.equal(err.code, 'DEPENDENCY_MISSING_TASK', 'a cross-project dependency is not allowed')
    e.cleanup()
  })

  test('an unknown role in a proposal is refused', () => {
    const e = env()
    const err = throwsCollaboration(() =>
      e.plans.register({
        projectId: e.projectId, title: 'p', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [e.add('a', 'wizard')], undecided: [],
      }),
    )
    assert.equal(err.code, 'ROLE_UNKNOWN')
    e.cleanup()
  })
})
