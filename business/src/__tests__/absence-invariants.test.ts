/**
 * Adversarial tests for requirements enforced by ABSENCE.
 *
 * Four requirements are held up not by a guard that returns an error, but by something that must
 * NOT happen: content you cannot obtain (MVP-013), gaps you cannot drop (MVP-015), a mid-state
 * that must never appear (MVP-020), rows that must survive (MVP-021).
 *
 * Absence is what a confident code reading misses — you cannot grep for a thing that is not
 * there. So each test below ATTEMPTS the violation and asserts it did not happen.
 *
 * These began as throwaway probes during a requirements audit. One of them was initially too
 * WEAK to mean anything (it asserted `uncovered.length > 0` while scoping two healthy files, so
 * it passed on an empty array); it is kept here in its corrected form because the weak version is
 * exactly the trap this file exists to avoid.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { MaterialService } from '../service/material-service.js'
import { AnalysisService } from '../service/analysis-service.js'
import { PlanService } from '../service/plan-service.js'
import { TaskService } from '../service/task-service.js'
import { WorkbenchError } from '../domain/error.js'
import type { PlannedTask } from '../domain/plan.js'
import type { RoleId } from '../domain/roles.js'

function throwsWorkbench(fn: () => unknown): WorkbenchError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof WorkbenchError, `expected a WorkbenchError, got ${String(err)}`)
    return err
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' })
}

function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-abs-'))
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const projects = new ProjectService(db)
  const materials = new MaterialService(db, root)
  const analyses = new AnalysisService(db, materials)
  const tasks = new TaskService(db)
  const plans = new PlanService(db, undefined, tasks)

  const p = projects.create({ key: 'ABS', name: 'Absence' })
  for (const r of ['product', 'design'] as const) projects.setMember(p.id, r, `who-${r}`)

  const upload = (name: string, text: string): string => {
    const f = path.join(root, name)
    fs.writeFileSync(f, text)
    return materials.upload({
      projectId: p.id, role: 'product', purpose: 'requirements',
      originalName: name, sourcePath: f, submittedBy: 'who-product',
    }).material.id
  }

  const add = (ref: string, role: RoleId, dependsOn: readonly string[] = []): PlannedTask => ({
    ref, taskId: null, role, change: 'add', content: `do ${ref}`, dependsOn,
  })

  const register = (taskList: readonly PlannedTask[], roles: readonly RoleId[]): string =>
    plans.register({
      projectId: p.id, title: 'P', relevantRoles: roles, rolesReason: 'r',
      tasks: taskList, undecided: [],
    }).plan.id

  return {
    db, root, projects, materials, analyses, tasks, plans, projectId: p.id,
    upload, add, register,
    cleanup: () => {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('MVP-013: scope is enforced, not merely respected', () => {
  test('out-of-scope content is absent from what a scoped read returns', () => {
    const e = env()
    const inside = e.upload('in.txt', 'IN-SCOPE-CONTENT')
    e.upload('out.txt', 'OUT-OF-SCOPE-SECRET')

    const outcome = e.analyses.readScope({
      projectId: e.projectId, scope: [{ materialId: inside, version: 1 }],
    })
    assert.equal(outcome.contents.length, 1, 'only the scoped material is read')
    assert.ok(
      !JSON.stringify(outcome).includes('OUT-OF-SCOPE-SECRET'),
      'the other material was never fetched, so its content cannot leak into the result',
    )
    e.cleanup()
  })

  test('a requirement cannot cite a source outside the scope', () => {
    const e = env()
    const inside = e.upload('in.txt', 'x')
    const outside = e.upload('out.txt', 'y')

    const err = throwsWorkbench(() =>
      e.analyses.submit({
        projectId: e.projectId, trigger: 'smuggle',
        scope: [{ materialId: inside, version: 1 }],
        requirements: [{ text: 'x', sources: [{ materialId: outside, version: 1 }] }],
        undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
      }),
    )
    assert.equal(err.code, 'SOURCE_OUT_OF_SCOPE', 'a source must lie inside the scope')
    e.cleanup()
  })

  test('an empty scope is refused rather than silently reading everything', () => {
    const e = env()
    e.upload('in.txt', 'x')
    const err = throwsWorkbench(() =>
      e.analyses.submit({
        projectId: e.projectId, trigger: 'all', scope: [],
        requirements: [], undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
      }),
    )
    assert.equal(err.code, 'SCOPE_REQUIRED', 'no scope must never mean "the whole project"')
    e.cleanup()
  })
})

describe('MVP-015: objective gaps belong to the system, not the caller', () => {
  test('a caller claiming "nothing unread" still gets the objective gaps recorded', () => {
    const e = env()
    const id = e.upload('in.txt', 'content')

    // A version that does NOT exist is the honest way to force an objective gap: a probe that
    // scoped only readable files would pass with an EMPTY list and prove nothing.
    const a = e.analyses.submit({
      projectId: e.projectId, trigger: 'gaps',
      scope: [
        { materialId: id, version: 1 },
        { materialId: id, version: 999 },
      ],
      requirements: [], undecided: [], inferences: [],
      notUnderstood: [], basisMissing: [],
    })

    const uncovered = e.analyses.get(a.id).uncovered
    assert.ok(uncovered.length > 0, 'the unreadable entry must be reported')
    const reasons = uncovered.map((u) => u.reason)
    assert.ok(
      reasons.includes('version_missing'),
      `the system recorded the cause itself, got: ${JSON.stringify(reasons)}`,
    )
    e.cleanup()
  })

  test("the caller's own gaps sit ALONGSIDE the objective ones", () => {
    const e = env()
    const id = e.upload('in.txt', 'content')

    const a = e.analyses.submit({
      projectId: e.projectId, trigger: 'gaps',
      scope: [{ materialId: id, version: 999 }],
      requirements: [], undecided: [], inferences: [],
      notUnderstood: ['CALLER-NOTE'], basisMissing: [],
    })

    const blob = JSON.stringify(e.analyses.get(a.id).uncovered)
    assert.ok(blob.includes('CALLER-NOTE'), 'the caller\'s own gap is kept')
    assert.ok(blob.includes('version_missing'), 'and the objective one is not replaced by it')
    e.cleanup()
  })
})

describe('MVP-020: activation is all-or-nothing', () => {
  test('all planned tasks appear together, with the plan active', () => {
    const e = env()
    const planId = e.register([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])

    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })
    assert.equal(e.tasks.listByProject(e.projectId).length, 0, 'still nothing on one agreement')

    e.plans.confirm({ planId, role: 'design', outcome: 'agree', submittedBy: 'who-design', declaredMember: 'who-design' })
    const after = e.tasks.listByProject(e.projectId)
    assert.equal(after.length, 2, 'exactly the planned tasks, all at once')
    assert.notEqual(e.plans.get(planId).plan.activatedAt, null, 'and the plan is active')

    const design = after.find((t) => t.task.role === 'design')
    const product = after.find((t) => t.task.role === 'product')
    assert.deepEqual(
      e.tasks.versionsOf(design!.task.id)[0]?.dependsOn, [product!.task.id],
      'the ref was resolved into a real task id in the same transaction',
    )
    e.cleanup()
  })
})

describe('MVP-021: voided confirmations survive a revision', () => {
  test('the row is marked voided, never deleted', () => {
    const e = env()
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })

    const count = (): number =>
      Number(e.db.prepare('SELECT COUNT(*) AS c FROM confirmations').get()!.c)
    const before = count()

    e.plans.revise({
      planId, title: 'revised', relevantRoles: ['product', 'design'], rolesReason: 'changed',
      tasks: [e.add('a2', 'product')], undecided: [], reason: 'scope changed',
    })

    assert.ok(count() >= before, 'a revision must not shrink the confirmation history')
    const voided = Number(
      e.db.prepare('SELECT COUNT(*) AS c FROM confirmations WHERE voided_at IS NOT NULL').get()!.c,
    )
    assert.ok(voided > 0, 'the old agreement is marked voided')
    const reason = e.db
      .prepare('SELECT void_reason FROM confirmations WHERE voided_at IS NOT NULL LIMIT 1')
      .get()
    assert.ok(reason?.void_reason, 'and it records WHY it was voided (MVP-021)')
    e.cleanup()
  })

  test('a revision demands everyone agrees again', () => {
    const e = env()
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })

    e.plans.revise({
      planId, title: 'revised', relevantRoles: ['product', 'design'], rolesReason: 'changed',
      tasks: [e.add('a2', 'product')], undecided: [], reason: 'scope changed',
    })

    // The earlier agreement was voided, so one confirmation must NOT be enough now.
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })
    assert.equal(
      e.plans.get(planId).plan.activatedAt, null,
      'a single agreement cannot activate a revised plan',
    )

    e.plans.confirm({ planId, role: 'design', outcome: 'agree', submittedBy: 'who-design', declaredMember: 'who-design' })
    assert.notEqual(e.plans.get(planId).plan.activatedAt, null, 're-collected in full')
    e.cleanup()
  })
})
