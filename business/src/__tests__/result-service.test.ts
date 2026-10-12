/**
 * Progress, results and acceptance (M5 result layer).
 *
 * The rules with teeth, all restated from the requirements:
 *   - saving progress completes nothing
 *   - SUBMITTING is not COMPLETING
 *   - a return needs a reason and leaves no completion record
 *   - completion is not acceptance; each downstream decides separately
 *   - rejecting creates NOTHING
 *
 * Several tests exist purely to pin down what must NOT happen, because the tempting
 * implementation (auto-complete on submit, auto-create work on reject) is the wrong one.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { PlanService } from '../service/plan-service.js'
import { TaskService } from '../service/task-service.js'
import { ResultService } from '../service/result-service.js'
import { WorkbenchError } from '../domain/error.js'
import type { PlannedTask } from '../domain/plan.js'
import type { RoleId } from '../domain/roles.js'
import type { ResultFile } from '../domain/result.js'

interface Env {
  db: DatabaseSync
  projects: ProjectService
  plans: PlanService
  tasks: TaskService
  results: ResultService
  projectId: string
  add(ref: string, role: string, dependsOn?: string[]): PlannedTask
  activate(taskList: PlannedTask[], roles?: readonly RoleId[]): readonly string[]
  taskIdOf(role: RoleId): string
  file(name: string): ResultFile
  cleanup(): void
}

/**
 * Who holds each role in this fixture (ADR-0014: a decision must come from the role's own member).
 *
 * One table, used both to staff the roles and to name the decider, so the two can never drift.
 * Roles absent here keep the generic `who-<role>` label — those tests never decide as them.
 */
const MEMBER_OF: Readonly<Record<string, string>> = {
  product: 'Zhang',
  design: 'Li',
  backend: 'Wang',
  frontend: 'Wu',
}
const memberOf = (role: string): string => MEMBER_OF[role] ?? `who-${role}`

function env(): Env {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const projects = new ProjectService(db)
  const tasks = new TaskService(db)
  const plans = new PlanService(db, undefined, tasks)
  const results = new ResultService(db)
  const project = projects.create({ key: 'ALPHA', name: 'Alpha' })

  const e: Env = {
    db, projects, plans, tasks, results,
    projectId: project.id,
    add: (ref, role, dependsOn = []) => ({
      ref, taskId: null, role: role as RoleId,
      change: 'add' as const, content: `do ${ref}`, dependsOn,
    }),
    activate(taskList, roles = ['product']) {
      for (const r of roles) projects.setMember(project.id, r, memberOf(r))
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
          submittedBy: memberOf(r),
          declaredMember: memberOf(r),
        })
      }
      return tasks
        .listByProject(project.id)
        .map((t) => t.task.id)
        .filter((id) => !before.includes(id))
    },
    taskIdOf(role) {
      const found = tasks.listByProject(project.id).find((t) => t.task.role === role)
      assert.ok(found !== undefined, `expected a task for role ${role}`)
      return found.task.id
    },
    file: (name) => ({
      relPath: `ALPHA/_shared/results/${name}`,
      originalName: name,
      sha256: 'a'.repeat(64),
      sizeBytes: 1234,
    }),
    cleanup() {
      db.close()
    },
  }
  return e
}

function throwsWorkbench(fn: () => unknown): WorkbenchError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof WorkbenchError, `expected a WorkbenchError, got ${String(err)}`)
    return err
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' })
}

describe('progress records but completes nothing', () => {
  test('progress can be saved repeatedly and never completes the task', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')

    e.results.addProgress({ taskId, note: 'started', submittedBy: 'Zhang' })
    e.results.addProgress({ taskId, note: 'still going', submittedBy: 'Zhang' })
    e.results.addProgress({ taskId, note: 'nearly there', submittedBy: 'Zhang' })

    const t = e.tasks.get(taskId)
    assert.equal(t.task.completedAt, null, 'progress must not complete a task')
    assert.equal(e.results.progressOf(taskId).length, 3, 'all three were kept')
    assert.equal(e.results.resultsOf(taskId).length, 0, 'progress is not a result')
    e.cleanup()
  })

  test('progress records the task version it was written against', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    e.results.addProgress({ taskId, note: 'v1 work', submittedBy: 'Z' })

    // Modify the task, then write more progress.
    e.activate([
      { ...e.add('a2', 'product'), taskId, change: 'modify' as const, content: 'do a differently' },
    ])
    e.results.addProgress({ taskId, note: 'v2 work', submittedBy: 'Z' })

    const all = e.results.progressOf(taskId)
    assert.deepEqual(all.map((p) => p.taskVersion), [1, 2], 'progress is stamped per version')
    assert.deepEqual(all.map((p) => p.note), ['v1 work', 'v2 work'])
    e.cleanup()
  })

  test('progress on a cancelled task is refused', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    e.activate([
      { ...e.add('c', 'product'), taskId, change: 'cancel' as const, content: 'stop' },
    ])

    const err = throwsWorkbench(() =>
      e.results.addProgress({ taskId, note: 'too late', submittedBy: 'Z' }),
    )
    assert.equal(err.code, 'TASK_FROZEN')
    e.cleanup()
  })

  test('an empty note is refused', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const err = throwsWorkbench(() =>
      e.results.addProgress({ taskId: e.taskIdOf('product'), note: '   ', submittedBy: 'Z' }),
    )
    assert.equal(err.code, 'INVALID_ARGUMENT')
    e.cleanup()
  })
})

describe('submitting is NOT completing', () => {
  test('a submission creates a result version and opens a review slot, but sets no completion', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')

    const r = e.results.submit({
      taskId, summary: 'here it is', files: [e.file('spec.md')],
      selfCheck: 'checked', submittedBy: 'Zhang',
    })

    assert.equal(r.version, 1)
    assert.equal(r.files.length, 1, 'the file was attached to THIS version')
    assert.equal(e.tasks.get(taskId).task.completedAt, null, 'submitting never completes')

    const slot = e.results.reviewOf(r.resultId, 1)
    assert.ok(slot !== null, 'a review slot was opened')
    assert.equal(slot.outcome, null, 'and it is undecided')
    assert.equal(slot.role, 'product', 'held by the task own role')
    e.cleanup()
  })

  test('the result records the task version in force at submission time', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const first = e.results.submit({
      taskId, summary: 'under v1', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    assert.equal(first.taskVersion, 1, 'recorded against v1')

    // Revise the task, then submit again.
    e.activate([
      { ...e.add('a2', 'product'), taskId, change: 'modify' as const, content: 'do a differently' },
    ])
    const second = e.results.submit({
      taskId, summary: 'under v2', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    assert.equal(second.taskVersion, 2, 'recorded against v2')
    assert.equal(second.version, 2, 'it is the second RESULT version')

    // This is the whole point: after a revision we can still say what was asked at the time.
    const all = e.results.resultsOf(taskId)
    assert.deepEqual(all.map((r) => [r.version, r.taskVersion]), [[1, 1], [2, 2]])
    e.cleanup()
  })

  test('submitting to a cancelled task is refused', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    e.activate([{ ...e.add('c', 'product'), taskId, change: 'cancel' as const, content: 'stop' }])

    const err = throwsWorkbench(() =>
      e.results.submit({ taskId, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z' }),
    )
    assert.equal(err.code, 'TASK_FROZEN')
    e.cleanup()
  })

  test('a submitted result cannot be edited afterwards', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'original', files: [e.file('a.md')], selfCheck: 'ok', submittedBy: 'Z',
    })

    // A second submission is a NEW version, leaving the first untouched.
    e.results.submit({
      taskId, summary: 'revised', files: [e.file('b.md')], selfCheck: 'ok', submittedBy: 'Z',
    })

    const first = e.results.resultsOf(taskId).find((x) => x.version === 1)
    assert.ok(first !== undefined)
    assert.equal(first.summary, 'original')
    assert.equal(first.files[0]?.originalName, 'a.md')
    assert.equal(r.resultId, first.resultId, 'same result identity across versions')
    e.cleanup()
  })
})

describe('review decides completion', () => {
  test('a complete review sets completed_at', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'done', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })

    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    assert.notEqual(e.tasks.get(taskId).task.completedAt, null, 'the review completed it')
    assert.equal(e.results.reviewOf(r.resultId, 1)?.outcome, 'complete')
    e.cleanup()
  })

  test('a return needs a reason, and writes no completion record', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'attempt', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })

    const blank = throwsWorkbench(() =>
      e.results.review({
        resultId: r.resultId, version: 1, outcome: 'return', reason: '  ',
        submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
      }),
    )
    assert.equal(blank.code, 'INVALID_ARGUMENT')

    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'return', reason: 'missing the spec',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    assert.equal(e.tasks.get(taskId).task.completedAt, null, 'a return never completes')
    const slot = e.results.reviewOf(r.resultId, 1)
    assert.equal(slot?.outcome, 'return')
    assert.equal(slot?.reason, 'missing the spec')
    e.cleanup()
  })

  test('a returned result version is KEPT, because it is the basis for the correction', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'attempt one', files: [e.file('draft.md')],
      selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'return', reason: 'not enough detail',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    const kept = e.results.resultsOf(taskId)
    assert.equal(kept.length, 1, 'the returned submission was not discarded')
    assert.equal(kept[0]?.summary, 'attempt one')
    assert.equal(e.results.reviewOf(r.resultId, 1)?.reason, 'not enough detail')
    e.cleanup()
  })

  test('the wrong role cannot review', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })

    const err = throwsWorkbench(() =>
      e.results.review({
        resultId: r.resultId, version: 1, outcome: 'complete',
        submittedBy: 'Li', declaredMember: 'Li', role: 'design',
      }),
    )
    assert.equal(err.code, 'ROLE_NOT_RELEVANT')
    assert.equal(e.tasks.get(taskId).task.completedAt, null, 'and nothing was completed')
    e.cleanup()
  })

  test('a result cannot be reviewed twice', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'return', reason: 'no',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    const err = throwsWorkbench(() =>
      e.results.review({
        resultId: r.resultId, version: 1, outcome: 'complete',
        submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
      }),
    )
    assert.equal(err.code, 'RESULT_ALREADY_REVIEWED')
    e.cleanup()
  })

  test('a completion cannot be walked back into a return', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    const err = throwsWorkbench(() =>
      e.results.review({
        resultId: r.resultId, version: 1, outcome: 'return', reason: 'actually no',
        submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
      }),
    )
    assert.equal(err.code, 'RESULT_ALREADY_REVIEWED')
    assert.notEqual(e.tasks.get(taskId).task.completedAt, null, 'the completion stands')
    e.cleanup()
  })

  test('a later submission opens its own fresh slot', () => {
    const e = env()
    e.activate([e.add('a', 'product')])
    const taskId = e.taskIdOf('product')
    const first = e.results.submit({
      taskId, summary: 'one', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.review({
      resultId: first.resultId, version: 1, outcome: 'return', reason: 'redo',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    const second = e.results.submit({
      taskId, summary: 'two', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })

    assert.equal(second.version, 2, 'a new RESULT version, not a reopening of version 1')
    assert.equal(e.results.reviewOf(second.resultId, 2)?.outcome, null, 'a fresh undecided slot')
    assert.equal(e.results.reviewOf(first.resultId, 1)?.outcome, 'return', 'the old decision stays')
    e.cleanup()
  })
})

/**
 * Two tasks where b declares a as its input. Both roles have a member, so both can decide.
 *
 * At FILE scope rather than inside one describe, because M7 added two more suites that need
 * the same fixture; nesting it in the first user made it invisible to them.
 */
function twoWithInput(): { e: Env; a: string; b: string } {
  const e = env()
  e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
  return { e, a: e.taskIdOf('product'), b: e.taskIdOf('design') }
}

describe('acceptance is separate from completion', () => {
  test('only tasks that declared the input get an acceptance slot', () => {
    const { e, a, b } = twoWithInput()
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    const opened = e.results.openAcceptances(r.resultId, 1)
    assert.deepEqual([...opened], [b], 'exactly the declared dependent, nobody else')

    const slots = e.results.acceptancesOf(r.resultId, 1)
    assert.equal(slots.length, 1)
    assert.equal(slots[0]?.outcome, null, 'undecided: completion does NOT auto-accept')
    e.cleanup()
  })

  /**
   * The boundary the rule must NOT cross: a task that does not consume this output gets no
   * slot even though it lives in the same project. Added because a mutation that opened a
   * slot for EVERY task in the project initially survived — the two-task fixture had no
   * unrelated task to distinguish them.
   */
  test('a task that did not declare the input gets no slot', () => {
    const e = env()
    // b consumes a's output; c is unrelated and merely shares the project.
    e.activate([
      e.add('a', 'product'),
      e.add('b', 'design', ['a']),
      e.add('c', 'frontend'),
    ])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')
    const c = e.taskIdOf('frontend')

    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.openAcceptances(r.resultId, 1)

    const slotTaskIds = e.results.acceptancesOf(r.resultId, 1).map((s) => s.taskId)
    assert.deepEqual(slotTaskIds, [b], 'only the declared dependent')
    assert.equal(slotTaskIds.includes(c), false, 'the unrelated task got nothing')

    // And it cannot decide, because it has no slot.
    const err = throwsWorkbench(() =>
      e.results.decide({
        resultId: r.resultId, version: 1, taskId: c, outcome: 'accept', submittedBy: 'Wang', declaredMember: 'Wang',
      }),
    )
    assert.equal(err.code, 'ACCEPTANCE_NOT_OPEN')
    e.cleanup()
  })

  test('a task with no declared dependent opens no slots', () => {
    const e = env()
    e.activate([e.add('solo', 'product')])
    const taskId = e.taskIdOf('product')
    const r = e.results.submit({
      taskId, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    assert.deepEqual([...e.results.openAcceptances(r.resultId, 1)], [])
    e.cleanup()
  })

  test('a downstream can accept, and rejecting needs a reason', () => {
    const { e, a, b } = twoWithInput()
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.openAcceptances(r.resultId, 1)

    const blank = throwsWorkbench(() =>
      e.results.decide({
        resultId: r.resultId, version: 1, taskId: b, outcome: 'reject',
        reason: '', submittedBy: 'Li', declaredMember: 'Li',
      }),
    )
    assert.equal(blank.code, 'INVALID_ARGUMENT')

    const decided = e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'reject',
      reason: 'does not cover the edge case', submittedBy: 'Li', declaredMember: 'Li',
    })
    assert.equal(decided.outcome, 'reject')
    assert.equal(decided.reason, 'does not cover the edge case')
    e.cleanup()
  })

  /**
   * MVP-027 is explicit: rejecting produces a record and nothing else. The tempting
   * implementation — spawn a correction task — is forbidden.
   */
  test('rejecting creates NO new task, plan or issue', () => {
    const { e, a, b } = twoWithInput()
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)

    const tasksBefore = e.tasks.listByProject(e.projectId).length
    const resultsBefore = e.results.resultsOf(a).length

    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'reject',
      reason: 'not acceptable', submittedBy: 'Li', declaredMember: 'Li',
    })

    assert.equal(e.tasks.listByProject(e.projectId).length, tasksBefore, 'no task appeared')
    assert.equal(e.results.resultsOf(a).length, resultsBefore, 'no result appeared')
    // And the upstream completion is untouched.
    assert.notEqual(e.tasks.get(a).task.completedAt, null, 'the completion stands')
    e.cleanup()
  })

  test('a task cannot accept its own result', () => {
    const { e, a } = twoWithInput()
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    const err = throwsWorkbench(() =>
      e.results.decide({
        resultId: r.resultId, version: 1, taskId: a, outcome: 'accept', submittedBy: 'Z', declaredMember: 'Z',
      }),
    )
    assert.equal(err.code, 'INVALID_ARGUMENT')
    e.cleanup()
  })

  test('a task with no slot cannot decide', () => {
    const { e, a } = twoWithInput()
    const other = e.projects.create({ key: 'BETA', name: 'Beta' })
    assert.equal(other.id !== e.projectId, true)
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    // No slots opened at all.
    const err = throwsWorkbench(() =>
      e.results.decide({
        resultId: r.resultId, version: 1, taskId: e.taskIdOf('design'), outcome: 'accept',
        submittedBy: 'Li', declaredMember: 'Li',
      }),
    )
    assert.equal(err.code, 'ACCEPTANCE_NOT_OPEN')
    e.cleanup()
  })

  test('accepting twice is refused', () => {
    const { e, a, b } = twoWithInput()
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'accept', submittedBy: 'Li', declaredMember: 'Li',
    })

    const err = throwsWorkbench(() =>
      e.results.decide({
        resultId: r.resultId, version: 1, taskId: b, outcome: 'reject',
        reason: 'changed my mind', submittedBy: 'Li', declaredMember: 'Li',
      }),
    )
    assert.equal(err.code, 'ALREADY_DECIDED')
    e.cleanup()
  })

  test('one downstream decision does not affect another', () => {
    const e = env()
    // a feeds both b and c.
    e.activate([
      e.add('a', 'product'),
      e.add('b', 'design', ['a']),
      e.add('c', 'frontend', ['a']),
    ], ['product', 'design', 'frontend'])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')
    const c = e.taskIdOf('frontend')

    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'reject',
      reason: 'not for me', submittedBy: 'Li', declaredMember: 'Li',
    })

    const slots = e.results.acceptancesOf(r.resultId, 1)
    assert.equal(slots.find((s) => s.taskId === b)?.outcome, 'reject')
    assert.equal(slots.find((s) => s.taskId === c)?.outcome, null, 'c is still undecided')
    e.cleanup()
  })

  test('acceptance is visible from the deciding task too', () => {
    const { e, a, b } = twoWithInput()
    const r = e.results.submit({
      taskId: a, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Z',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'accept', submittedBy: 'Li', declaredMember: 'Li',
    })

    const byTask = e.results.acceptancesByTask(b)
    assert.equal(byTask.length, 1)
    assert.equal(byTask[0]?.outcome, 'accept')
    e.cleanup()
  })
})

/**
 * Required inputs gate COMPLETION (MVP-026), and the consumed input version is PINNED at
 * acceptance so "which version did it actually use" is answerable (MVP-031, ADR-0012).
 *
 * Both were missing before M7, and the omission survived 213 tests because NO existing test
 * completed a task that declares a required input — every dependency test exercised the
 * acceptance side only. The check was absent and so was the case.
 */
describe('completion requires accepted inputs', () => {
  /** Runs `a` to completion, opens acceptance slots, and returns both task ids. */
  function upstreamDone(): { e: Env; a: string; b: string; resultId: string } {
    const { e, a, b } = twoWithInput()
    const r = e.results.submit({
      taskId: a, summary: 'spec', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)
    return { e, a, b, resultId: r.resultId }
  }

  test('a dependent CANNOT complete while its input is undecided', () => {
    const { e, b } = upstreamDone()
    const mine = e.results.submit({
      taskId: b, summary: 'built', files: [], selfCheck: 'ok', submittedBy: 'Li',
    })

    const err = throwsWorkbench(() =>
      e.results.review({
        resultId: mine.resultId, version: 1, outcome: 'complete',
        submittedBy: 'Li', declaredMember: 'Li', role: 'design',
      }),
    )
    assert.equal(err.code, 'REQUIRED_INPUT_NOT_ACCEPTED')
    assert.equal(e.tasks.get(b).task.completedAt, null, 'nothing was completed')
    e.cleanup()
  })

  test('a dependent CANNOT complete when its input was REJECTED', () => {
    const { e, b, resultId } = upstreamDone()
    e.results.decide({
      resultId, version: 1, taskId: b, outcome: 'reject', reason: 'not what I need',
      submittedBy: 'Li', declaredMember: 'Li',
    })
    const mine = e.results.submit({
      taskId: b, summary: 'built', files: [], selfCheck: 'ok', submittedBy: 'Li',
    })

    const err = throwsWorkbench(() =>
      e.results.review({
        resultId: mine.resultId, version: 1, outcome: 'complete',
        submittedBy: 'Li', declaredMember: 'Li', role: 'design',
      }),
    )
    assert.equal(err.code, 'REQUIRED_INPUT_NOT_ACCEPTED')
    // A rejection is recorded as rejected, not silently treated as accepted.
    assert.match(err.message, /rejected/)
    e.cleanup()
  })

  test('accepting the input unblocks completion', () => {
    const { e, b, resultId } = upstreamDone()
    e.results.decide({ resultId, version: 1, taskId: b, outcome: 'accept', submittedBy: 'Li', declaredMember: 'Li' })
    const mine = e.results.submit({
      taskId: b, summary: 'built', files: [], selfCheck: 'ok', submittedBy: 'Li',
    })
    e.results.review({
      resultId: mine.resultId, version: 1, outcome: 'complete',
      submittedBy: 'Li', declaredMember: 'Li', role: 'design',
    })
    assert.notEqual(e.tasks.get(b).task.completedAt, null, 'now it can finish')
    e.cleanup()
  })

  test('a RETURN is never blocked by an unaccepted input', () => {
    const { e, b } = upstreamDone()
    const mine = e.results.submit({
      taskId: b, summary: 'built', files: [], selfCheck: 'ok', submittedBy: 'Li',
    })
    // Returning is always allowed — only completion is gated.
    const returned = e.results.review({
      resultId: mine.resultId, version: 1, outcome: 'return', reason: 'redo',
      submittedBy: 'Li', declaredMember: 'Li', role: 'design',
    })
    assert.equal(returned.taskId, b)
    assert.equal(e.tasks.get(b).task.completedAt, null, 'a return completes nothing (MVP-026)')
    e.cleanup()
  })

  test('a task with NO required inputs is unaffected (MVP-023)', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const a = e.taskIdOf('product')
    const r = e.results.submit({
      taskId: a, summary: 'spec', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    assert.notEqual(e.tasks.get(a).task.completedAt, null)
    e.cleanup()
  })
})

describe('the consumed input version is pinned', () => {
  function twoVersions(): { e: Env; a: string; b: string; v1: string; v2: string } {
    const { e, a, b } = twoWithInput()
    // v1 is returned (so it does not freeze `a`); v2 is then the live submission.
    const r1 = e.results.submit({
      taskId: a, summary: 'v1', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r1.resultId, version: 1, outcome: 'return', reason: 'redo',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })
    const r2 = e.results.submit({
      taskId: a, summary: 'v2', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.openAcceptances(r1.resultId, 1)
    e.results.openAcceptances(r2.resultId, 2)
    return { e, a, b, v1: r1.resultId, v2: r2.resultId }
  }

  test('accepting v1 pins v1, not the latest version', () => {
    const { e, b, v1 } = twoVersions()
    e.results.decide({ resultId: v1, version: 1, taskId: b, outcome: 'accept', submittedBy: 'Li', declaredMember: 'Li' })

    const accepted = e.results.acceptancesByTask(b).find((x) => x.outcome === 'accept')
    assert.equal(accepted?.resultVersion, 1, 'the version it actually took')
    assert.equal(accepted?.acceptedResultTaskVersion, 1, 'and the upstream task version behind it')
    assert.equal(accepted?.acceptedTaskVersion, 1, 'plus its own version at decision time')
    e.cleanup()
  })

  test('accepting the LATEST version pins that one instead', () => {
    const { e, b, v2 } = twoVersions()
    e.results.decide({ resultId: v2, version: 2, taskId: b, outcome: 'accept', submittedBy: 'Li', declaredMember: 'Li' })

    const accepted = e.results.acceptancesByTask(b).find((x) => x.outcome === 'accept')
    assert.equal(accepted?.resultVersion, 2)
    e.cleanup()
  })

  test('a REJECTION also records the version, so "refused" differs from "undecided"', () => {
    const { e, b, v1 } = twoVersions()
    e.results.decide({
      resultId: v1, version: 1, taskId: b, outcome: 'reject', reason: 'no', submittedBy: 'Li', declaredMember: 'Li',
    })

    const row = e.results.acceptancesByTask(b).find((x) => x.resultVersion === 1)
    assert.equal(row?.outcome, 'reject')
    assert.equal(row?.acceptedResultTaskVersion, 1, 'the refused version is still recorded')

    // And the other slot stays genuinely undecided — a different state entirely.
    const stillOpen = e.results.acceptancesByTask(b).find((x) => x.resultVersion === 2)
    assert.equal(stillOpen?.outcome, null)
    assert.equal(stillOpen?.acceptedResultTaskVersion, null)
    e.cleanup()
  })

  test('an undecided slot pins nothing', () => {
    const { e, b } = twoVersions()
    for (const a of e.results.acceptancesByTask(b)) {
      assert.equal(a.outcome, null)
      assert.equal(a.acceptedTaskVersion, null, 'nothing is claimed before the decision')
      assert.equal(a.acceptedResultTaskVersion, null)
    }
    e.cleanup()
  })
})
