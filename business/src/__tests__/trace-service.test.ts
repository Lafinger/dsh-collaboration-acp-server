/**
 * Traceability (M7, MVP-031).
 *
 * The acceptance criterion is specific: "pick any decision, and you can find its submitter,
 * time, based-on version and reason; after a material update the old references and old
 * decisions do NOT change."
 *
 * So the tests below care about three things a naive reader would get wrong:
 *   - current and history are SEPARATE, never blended
 *   - old decisions survive a new version UNCHANGED
 *   - the chain says which input VERSION was consumed, not just which task
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { PlanService } from '../service/plan-service.js'
import { TaskService } from '../service/task-service.js'
import { ResultService } from '../service/result-service.js'
import { TraceService } from '../service/trace-service.js'
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

interface Env {
  db: DatabaseSync
  projects: ProjectService
  plans: PlanService
  tasks: TaskService
  results: ResultService
  traces: TraceService
  projectId: string
  add(ref: string, role: RoleId, dependsOn?: readonly string[]): PlannedTask
  register(taskList: PlannedTask[], roles: readonly RoleId[]): string
  activate(taskList: PlannedTask[], roles: readonly RoleId[]): readonly string[]
  taskIdOf(role: RoleId): string
  cleanup(): void
}

function env(): Env {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const projects = new ProjectService(db)
  const plans = new PlanService(db, undefined, new TaskService(db))
  const tasks = new TaskService(db)
  const results = new ResultService(db)
  const traces = new TraceService(db)

  const p = projects.create({ key: 'T', name: 'Trace' })
  const ALL: readonly RoleId[] = ['pm', 'product', 'design', 'scenemodel', 'sceneart', 'data', 'frontend', 'backend', 'ue']
  for (const r of ALL) projects.setMember(p.id, r, `who-${r}`)

  return {
    db, projects, plans, tasks, results, traces,
    projectId: p.id,
    add: (ref, role, dependsOn = []) => ({
      ref, taskId: null, role, change: 'add', content: `do ${ref}`, dependsOn,
    }),
    register(taskList, roles) {
      const { plan } = plans.register({
        projectId: p.id, title: 'P', relevantRoles: roles, rolesReason: 'because',
        tasks: taskList, undecided: [],
      })
      return plan.id
    },
    activate(taskList, roles) {
      const planId = this.register(taskList, roles)
      for (const r of roles) {
        plans.confirm({
          planId,
          role: r,
          outcome: 'agree',
          submittedBy: `who-${r}`,
          declaredMember: `who-${r}`,
        })
      }
      return this.tasks.listByProject(p.id).map((t) => t.task.id)
    },
    taskIdOf(role) {
      const found = tasks.listByProject(p.id).find((t) => t.task.role === role)
      if (found === undefined) throw new Error(`no task for role ${role}`)
      return found.task.id
    },
    cleanup: () => db.close(),
  }
}

describe('trace answers MVP-031 for a task', () => {
  test('a fresh task traces its version and where that version came from', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const a = e.taskIdOf('product')

    const t = e.traces.traceTask(a)
    assert.equal(t.object.type, 'task')
    assert.equal(t.currentVersion, 1)
    assert.equal(t.decisions.length, 1, 'the task version itself is the only record so far')
    assert.equal(t.decisions[0]?.kind, 'task_version')
    assert.equal(t.decisions[0]?.basedOn?.kind, 'plan', 'and it says which plan produced it')
    assert.equal(t.history.length, 0)
    e.cleanup()
  })

  test('a result and its review both appear, with submitter, time and reason', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    // The reviewer must be the role's own member (ADR-0014), and here it is deliberately NOT the
    // submitter — that divergence is the point of this test.
    e.projects.setMember(e.projectId, 'product', 'Li')
    const a = e.taskIdOf('product')
    // DIFFERENT names on purpose: submitting and reviewing are two acts by two parties, and
    // using one name for both made "who submitted" indistinguishable from "who reviewed".
    // A mutation that swapped them survived until these names diverged.
    const r = e.results.submit({
      taskId: a, summary: 'the spec', files: [], selfCheck: 'checked', submittedBy: 'Zhang',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'return', reason: 'too vague',
      submittedBy: 'Li', declaredMember: 'Li', role: 'product',
    })

    const t = e.traces.traceTask(a)
    const result = t.decisions.find((d) => d.kind === 'result_version')
    assert.equal(result?.submittedBy, 'Zhang', 'the SUBMITTER is recorded on the submission')
    assert.equal(result?.outcome, null, 'a submission is not itself a decision')
    assert.ok(result?.at, 'it records when')
    assert.equal(result?.basedOn?.kind, 'task', 'and which task version it was written against')
    assert.equal(result?.basedOn?.version, 1)

    const review = t.decisions.find((d) => d.kind === 'result_review')
    assert.equal(review?.outcome, 'return')
    assert.equal(review?.reason, 'too vague', 'the reason survives, which is the point')
    assert.equal(review?.submittedBy, 'Li', 'and the REVIEWER is a separate record')
    assert.equal(review?.role, 'product')
    e.cleanup()
  })

  /**
   * MVP-004 + MVP-031 together: "pick any decision and you can find its submitter". That is only
   * true if the submitter is a SNAPSHOT. Nothing in the tests above can tell a stored snapshot
   * from a join against the current roster, because nothing changes in between.
   *
   * Replacing the member afterwards is the decisive case: a live pointer would silently rewrite
   * who did what, which is exactly the corruption traceability exists to prevent.
   */
  test('a past decision is NOT rewritten when the member is replaced', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    // The reviewer must be the role's member when the decision is made (ADR-0014); the
    // replacement below happens AFTERWARDS, which is what makes the snapshot claim testable.
    e.projects.setMember(e.projectId, 'product', 'Li')
    const a = e.taskIdOf('product')

    const r = e.results.submit({
      taskId: a, summary: 'the spec', files: [], selfCheck: 'ok', submittedBy: 'Zhang',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', submittedBy: 'Li', declaredMember: 'Li', role: 'product',
    })

    const before = JSON.stringify(e.traces.traceTask(a).decisions)
    // The person filling the role is replaced AFTER both decisions were made.
    e.projects.setMember(e.projectId, 'product', 'Wang')

    const after = JSON.stringify(e.traces.traceTask(a).decisions)
    assert.equal(after, before, 'history must be byte-identical after a roster change')

    const t = e.traces.traceTask(a)
    assert.equal(
      t.decisions.find((d) => d.kind === 'result_version')?.submittedBy, 'Zhang',
      'the submitter is still whoever actually submitted',
    )
    assert.equal(
      t.decisions.find((d) => d.kind === 'result_review')?.submittedBy, 'Li',
      'and the reviewer is still whoever actually reviewed',
    )
    // The roster really did change, so the assertions above are not vacuous.
    assert.equal(
      e.projects.getWithRoles(e.projectId).roles.find((r2) => r2.role === 'product')?.member,
      'Wang',
    )
    e.cleanup()
  })

  test('the chain reports which INPUT VERSION was consumed', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')

    // Before accepting, the input is required but nothing is pinned.
    const before = e.traces.traceTask(b)
    assert.equal(before.chain.inputs.length, 1)
    assert.equal(before.chain.inputs[0]?.taskId, a)
    assert.equal(before.chain.inputs[0]?.version, null, 'not accepted yet, so nothing is claimed')

    const r = e.results.submit({
      taskId: a, summary: 'spec', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', submittedBy: 'who-product', declaredMember: 'who-product', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({ resultId: r.resultId, version: 1, taskId: b, outcome: 'accept', submittedBy: 'who-design', declaredMember: 'who-design' })

    const after = e.traces.traceTask(b)
    assert.equal(after.chain.inputs[0]?.version, 1, 'now it names the upstream version it took')
    assert.equal(after.chain.inputs[0]?.resultVersion, 1)

    // And the upstream sees who consumed it.
    assert.equal(e.traces.traceTask(a).chain.consumers.length, 1)
    assert.equal(e.traces.traceTask(a).chain.consumers[0]?.outcome, 'accept')
    e.cleanup()
  })

  /**
   * The version above is 1, which makes "reports the real version" indistinguishable from
   * "always reports 1". A mutation that hardcoded 1 SURVIVED until this test existed, so the
   * upstream is deliberately driven to version 2 and the assertion demands a 2.
   *
   * A second, separate plan is the only route: revising a plan BEFORE activation does not
   * help, because no task exists yet to carry a version.
   */
  test('the chain reports the REAL input version, not merely the first', () => {
    const e = env()
    // Plan 1 creates `a` at version 1.
    e.activate([e.add('a', 'product')], ['product'])
    const a = e.taskIdOf('product')
    assert.equal(e.tasks.get(a).task.currentVersion, 1)

    // Plan 2 MODIFIES `a`, which is what produces task version 2.
    const p2 = e.register(
      [{ ref: 'a', taskId: a, role: 'product', change: 'modify', content: 'do a v2', dependsOn: [] }],
      ['product'],
    )
    e.plans.confirm({ planId: p2, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })
    assert.equal(e.tasks.get(a).task.currentVersion, 2, 'the upstream really is on version 2')

    // Plan 3 creates the downstream `b`, declaring `a` as its input. A dependency on a task
    // that already exists is named by TASK ID, not by a ref in this plan.
    const p3 = e.register(
      [{ ref: 'b', taskId: null, role: 'design', change: 'add', content: 'do b', dependsOn: [a] }],
      ['design'],
    )
    e.plans.confirm({ planId: p3, role: 'design', outcome: 'agree', submittedBy: 'who-design', declaredMember: 'who-design' })
    const b = e.taskIdOf('design')

    const r = e.results.submit({
      taskId: a, summary: 'spec', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    assert.equal(r.taskVersion, 2, 'and its result was produced against version 2')
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', submittedBy: 'who-product', declaredMember: 'who-product', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({ resultId: r.resultId, version: 1, taskId: b, outcome: 'accept', submittedBy: 'who-design', declaredMember: 'who-design' })

    const t = e.traces.traceTask(b)
    assert.equal(t.chain.inputs[0]?.version, 2, 'the chain must say 2, not merely "some version"')

    const accepted = e.results.acceptancesByTask(b).find((x) => x.outcome === 'accept')
    assert.equal(accepted?.acceptedResultTaskVersion, 2)
    assert.equal(accepted?.acceptedTaskVersion, 1, 'b itself was only ever on version 1')
    e.cleanup()
  })

  test('the chain distinguishes accepted from merely decided', () => {
    const e = env()
    e.activate([e.add('a', 'product'), e.add('b', 'design', ['a'])], ['product', 'design'])
    const a = e.taskIdOf('product')
    const b = e.taskIdOf('design')
    const r = e.results.submit({
      taskId: a, summary: 'spec', files: [], selfCheck: 'ok', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', submittedBy: 'who-product', declaredMember: 'who-product', role: 'product',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({
      resultId: r.resultId, version: 1, taskId: b, outcome: 'reject', reason: 'no',
      submittedBy: 'who-design', declaredMember: 'who-design',
    })

    // A rejection is NOT a consumed input, so the version stays unclaimed.
    const t = e.traces.traceTask(b)
    assert.equal(t.chain.inputs[0]?.version, null, 'rejecting does not pin a version to use')
    assert.equal(
      e.traces.traceTask(a).chain.consumers[0]?.outcome,
      'reject',
      'but the rejection is recorded as a decision',
    )
    e.cleanup()
  })
})

describe('current and history are never blended', () => {
  test('a revised plan keeps the old confirmations as history, marked voided', () => {
    const e = env()
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })
    e.plans.revise({
      planId, title: 'P2', relevantRoles: ['product', 'design'], rolesReason: 'changed',
      tasks: [e.add('a', 'product')], undecided: [], reason: 'scope changed',
    })

    const t = e.traces.tracePlan(planId)
    assert.equal(t.currentVersion, 2, 'the current version is the revision')
    // v1's agreement was voided by the revision, so it is history rather than current.
    const voided = t.history.find((d) => d.version === 1 && d.role === 'product')
    assert.equal(voided?.outcome, 'agree', 'the old decision is still readable')
    assert.match(String(voided?.detail), /voided/, 'and is marked as no longer in force')

    // v2's slots are current but UNDECIDED: the revision reset the gate, so nothing is
    // agreed yet. Reporting them with a null outcome is the honest state.
    const current = t.decisions.filter((d) => d.kind === 'plan_confirmation')
    assert.equal(current.length, 2, 'both roles must agree again')
    assert.ok(current.every((d) => d.outcome === null), 'and neither has agreed yet')
    assert.ok(current.every((d) => d.version === 2), 'all on the new version')
    e.cleanup()
  })

  test('after activation, the plan shows when it took effect and keeps every confirmation', () => {
    const e = env()
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })
    e.plans.confirm({ planId, role: 'design', outcome: 'agree', submittedBy: 'who-design', declaredMember: 'who-design' })

    const t = e.traces.tracePlan(planId)
    const activation = t.decisions.find((d) => d.kind === 'plan_activation')
    assert.ok(activation, 'activation is itself a recorded decision')
    assert.ok(activation.at, 'with a timestamp')
    assert.equal(t.decisions.filter((d) => d.kind === 'plan_confirmation').length, 2)
    e.cleanup()
  })

  test('an OLD decision does not change when a new version is created', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    // This test reviews as 'Zhang', so the role must belong to 'Zhang' (ADR-0014).
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const a = e.taskIdOf('product')

    // First submission: returned.
    const r1 = e.results.submit({
      taskId: a, summary: 'first', files: [], selfCheck: 'ok', submittedBy: 'Zhang',
    })
    e.results.review({
      resultId: r1.resultId, version: 1, outcome: 'return', reason: 'redo it',
      submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    const before = e.traces.traceTask(a)
    const beforeReview = before.decisions.find((d) => d.kind === 'result_review')
    const snapshot = JSON.stringify(beforeReview)

    // Second submission: completes. This must not rewrite the first record.
    const r2 = e.results.submit({
      taskId: a, summary: 'second', files: [], selfCheck: 'ok', submittedBy: 'Zhang',
    })
    e.results.review({
      resultId: r2.resultId, version: 2, outcome: 'complete', submittedBy: 'Zhang', declaredMember: 'Zhang', role: 'product',
    })

    const after = e.traces.traceTask(a)
    const afterReview = after.decisions.find(
      (d) => d.kind === 'result_review' && d.reason === 'redo it',
    )
    assert.equal(JSON.stringify(afterReview), snapshot, 'the old decision is byte-for-byte unchanged')
    e.cleanup()
  })

  test('a task revision moves the previous version into history', () => {
    const e = env()
    // Revise BEFORE activating: an activated plan cannot be revised (PLAN_ALREADY_ACTIVE),
    // which is itself a traceability guarantee — history stops moving once work has begun.
    const planId = e.register([e.add('a', 'product')], ['product'])
    e.plans.revise({
      planId, title: 'P2', relevantRoles: ['product'], rolesReason: 'changed',
      tasks: [{ ref: 'a', taskId: null, role: 'product', change: 'add', content: 'do a better', dependsOn: [] }],
      undecided: [], reason: 'clarify',
    })
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })
    const a = e.taskIdOf('product')

    const t = e.traces.traceTask(a)
    assert.equal(t.currentVersion, 1, 'the task was created by the activated v2 plan')
    assert.equal(t.decisions[0]?.detail, 'do a better', 'and carries v2 content')
    assert.equal(t.decisions[0]?.basedOn?.kind, 'plan')
    // The task records WHICH plan version produced it — the audit trail for "why".
    const origin = t.decisions[0]?.basedOn?.version
    assert.equal(origin, 2, 'v1 was superseded before it ever created a task')
    e.cleanup()
  })
})

describe('trace is read-only and honest about what it cannot find', () => {
  test('an unknown task is refused', () => {
    const e = env()
    assert.equal(throwsWorkbench(() => e.traces.traceTask('nope')).code, 'TASK_NOT_FOUND')
    e.cleanup()
  })

  test('an unknown plan is refused', () => {
    const e = env()
    assert.equal(throwsWorkbench(() => e.traces.tracePlan('nope')).code, 'PLAN_NOT_FOUND')
    e.cleanup()
  })

  test('an unknown result is refused', () => {
    const e = env()
    assert.equal(throwsWorkbench(() => e.traces.traceResult('nope', 1)).code, 'RESULT_NOT_FOUND')
    assert.equal(e.traces.latestResultVersion('nope'), null)
    e.cleanup()
  })

  test('tracing writes nothing at all', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const a = e.taskIdOf('product')
    const count = () =>
      (e.db.prepare(
        `SELECT (SELECT COUNT(*) FROM tasks) + (SELECT COUNT(*) FROM result_versions)
              + (SELECT COUNT(*) FROM progress) + (SELECT COUNT(*) FROM reads) AS n`,
      ).get() as unknown as { n: number }).n

    const before = count()
    e.traces.traceTask(a)
    e.traces.traceTask(a)
    assert.equal(count(), before, 'tracing is a pure read')
    e.cleanup()
  })

  test('tracing an archived project still works', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const a = e.taskIdOf('product')
    e.projects.archive(e.projectId)

    const t = e.traces.traceTask(a)
    assert.equal(t.object.projectId, e.projectId, 'an archived project remains traceable')
    assert.equal(t.currentVersion, 1)
    e.cleanup()
  })
})

/**
 * Two invariants that mutation testing flagged as SURVIVING, i.e. no test distinguished them.
 *
 * A survivor is either a missing test or code no reachable state can exercise. These are the
 * second kind; the tests assert the STRUCTURAL reason, so if that reason ever stops holding
 * they fail.
 */
describe('invariants that make two trace guards redundant', () => {
  test('revise always writes a NEWER version, so a voided slot is never the latest', () => {
    const e = env()
    // TWO roles, only one confirmed: confirming every role would ACTIVATE the plan, and an
    // activated plan cannot be revised at all (PLAN_ALREADY_ACTIVE).
    const planId = e.register([e.add('a', 'product')], ['product', 'design'])
    e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'who-product', declaredMember: 'who-product' })

    const revised = e.plans.revise({
      planId, title: 'P2', relevantRoles: ['product', 'design'], rolesReason: 'changed',
      tasks: [e.add('a', 'product')], undecided: [], reason: 'changed',
    })
    assert.equal(revised.plan.version, 2, 'a revision is a new version')

    // Every voided slot belongs to a version BELOW the latest, so checking `version === latest`
    // already excludes them and the extra `voidedAt === null` can never change the answer.
    const voided = e.plans.history(planId).flatMap((v) => v.slots).filter((s) => s.voidedAt !== null)
    assert.ok(voided.length > 0, 'the revision did void the old agreement')
    assert.ok(
      voided.every((s) => s.planVersion < revised.plan.version),
      'and none of them is on the latest version',
    )
    e.cleanup()
  })

  test('a task with no required inputs has an empty unmet list by construction', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    e.projects.setMember(e.projectId, 'product', 'Li')
    const a = e.taskIdOf('product')

    // The gate iterates over the required inputs, so having none yields no failures — which
    // is why an explicit early return is defensive rather than load-bearing.
    assert.equal(e.traces.traceTask(a).chain.inputs.length, 0, 'no inputs are declared')

    const r = e.results.submit({
      taskId: a, summary: 's', files: [], selfCheck: 'c', submittedBy: 'Z',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', submittedBy: 'Li', declaredMember: 'Li', role: 'product',
    })
    assert.notEqual(e.tasks.get(a).task.completedAt, null, 'so completion is unblocked')
    e.cleanup()
  })
})
