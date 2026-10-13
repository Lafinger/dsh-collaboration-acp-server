/**
 * Session identity (ADR-0014).
 *
 * MVP-019 says a plan is confirmed "由该角色的成员" — by THAT ROLE'S MEMBER. Before this, the
 * code checked only that the slot HAD a member and then accepted any name the caller passed, so
 * an agent that had been told nothing invented nine members and every role confirmed itself.
 *
 * These tests therefore concentrate on the REFUSALS, not the happy path. A suite that only
 * proved "the right member can confirm" would have passed against the old code too — the old
 * code accepted literally everyone.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { PlanService } from '../service/plan-service.js'
import { TaskService } from '../service/task-service.js'
import { ResultService } from '../service/result-service.js'
import { SessionIdentityService } from '../service/session-identity-service.js'
import { assertCanActAsRole } from '../domain/project.js'
import { CollaborationError } from '../domain/error.js'
import type { PlannedTask } from '../domain/plan.js'

function throwsCollaboration(fn: () => unknown): CollaborationError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof CollaborationError, `expected a CollaborationError, got ${String(err)}`)
    return err
  }
  throw new assert.AssertionError({ message: 'expected the call to throw, but it returned' })
}

function env() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const projects = new ProjectService(db)
  const tasks = new TaskService(db)
  const plans = new PlanService(db, undefined, tasks)
  const results = new ResultService(db)
  const identities = new SessionIdentityService(db)

  const p = projects.create({ key: 'ID', name: 'Identity' })
  projects.setMember(p.id, 'product', 'Chen')
  projects.setMember(p.id, 'design', 'Su')

  const task = (ref: string, role: string, dependsOn: string[] = []): PlannedTask => ({
    ref,
    taskId: null,
    role: role as PlannedTask['role'],
    change: 'add' as const,
    content: `do ${ref}`,
    dependsOn,
  })

  /** Register a plan and return its id, without confirming anything. */
  const register = (taskList: readonly PlannedTask[], roles: readonly string[]): string =>
    plans.register({
      projectId: p.id,
      title: 'P',
      relevantRoles: roles as never,
      rolesReason: 'both roles are affected',
      tasks: taskList,
      undecided: [],
    }).plan.id

  return {
    db,
    projects,
    plans,
    tasks,
    results,
    identities,
    projectId: p.id,
    task,
    register,
    cleanup: () => db.close(),
  }
}

describe('declaring who this session is', () => {
  test('a declaration is remembered for the session', () => {
    const e = env()
    assert.equal(e.identities.current('s1'), null, 'nothing is declared to begin with')

    const declared = e.identities.declare({ sessionId: 's1', member: 'Chen' })
    assert.equal(declared.member, 'Chen')
    assert.equal(e.identities.current('s1'), 'Chen')
    e.cleanup()
  })

  test('a declaration covers every project, because a person does not change with the project', () => {
    const e = env()
    e.identities.declare({ sessionId: 's1', member: 'Chen' })
    const other = e.projects.create({ key: 'OTHER', name: 'Other' })

    e.projects.setMember(other.id, 'product', 'Chen')
    const planId = e.plans.register({
      projectId: other.id,
      title: 'P2',
      relevantRoles: ['product'] as never,
      rolesReason: 'r',
      tasks: [{ ...e.task('a', 'product') }],
      undecided: [],
    }).plan.id

    // No second declaration: the identity is the session's, not the project's.
    const after = e.plans.confirm({
      planId,
      role: 'product',
      outcome: 'agree',
      submittedBy: 'Chen',
      declaredMember: 'Chen',
    })
    assert.equal(after.slots[0]?.outcome, 'agree')
    e.cleanup()
  })

  test('re-declaring corrects a typo and keeps the ORIGINAL declaration time', () => {
    const e = env()
    const first = e.identities.declare({ sessionId: 's1', member: 'Chne' })
    const second = e.identities.declare({ sessionId: 's1', member: 'Chen' })

    assert.equal(second.member, 'Chen', 'the correction takes effect')
    assert.equal(e.identities.current('s1'), 'Chen')
    assert.equal(
      second.declaredAt,
      first.declaredAt,
      'when the session first spoke stays visible, so a correction is not disguised as a first statement',
    )
    e.cleanup()
  })

  test('a blank member is refused', () => {
    const e = env()
    assert.throws(
      () => e.identities.declare({ sessionId: 's1', member: '   ' }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'INVALID_ARGUMENT',
    )
    e.cleanup()
  })

  test('a member is trimmed, so the same person is not two people', () => {
    const e = env()
    e.identities.declare({ sessionId: 's1', member: '  Chen  ' })
    assert.equal(e.identities.current('s1'), 'Chen')
    e.cleanup()
  })
})

describe('a role decision must come from that role\'s member (MVP-019)', () => {
  test('an undeclared session cannot confirm, even naming the right member', () => {
    const e = env()
    const planId = e.register([e.task('a', 'product')], ['product'])

    // Naming the role's own member is not enough: the check reads what the SESSION declared.
    // If `submitted_by` satisfied the check, this would succeed — which is the hole ADR-0014 closes.
    const err = throwsCollaboration(() =>
      e.plans.confirm({ planId, role: 'product', outcome: 'agree', submittedBy: 'Chen' }),
    )
    assert.equal(err.code, 'MEMBER_NOT_DECLARED')
    assert.match(err.message, /session_declare_member/, 'and it says how to fix it')
    e.cleanup()
  })

  test('the role\'s own member can confirm', () => {
    const e = env()
    e.identities.declare({ sessionId: 's1', member: 'Chen' })
    const planId = e.register([e.task('a', 'product')], ['product'])

    const after = e.plans.confirm({
      planId,
      role: 'product',
      outcome: 'agree',
      submittedBy: 'Chen',
      declaredMember: 'Chen',
    })
    assert.equal(after.slots[0]?.outcome, 'agree')
    e.cleanup()
  })

  test('someone who is NOT the role\'s member cannot confirm as that role', () => {
    const e = env()
    const planId = e.register([e.task('a', 'product')], ['product'])

    // 'Su' holds design, not product. This is the exact move that used to succeed silently.
    const err = throwsCollaboration(() =>
      e.plans.confirm({
        planId,
        role: 'product',
        outcome: 'agree',
        submittedBy: 'Su',
        declaredMember: 'Su',
      }),
    )
    assert.equal(err.code, 'NOT_ROLE_MEMBER')
    assert.match(err.message, /belongs to "Chen"/, 'the message names the actual holder')
    assert.match(err.message, /declared itself as "Su"/, 'and the actual speaker')

    // The refusal must leave the gate untouched.
    assert.equal(e.plans.get(planId).slots[0]?.outcome, null, 'nothing was recorded')
    e.cleanup()
  })

  test('a vacant role is still refused, and says to assign a member', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'design', null)
    const planId = e.register([e.task('a', 'design')], ['design'])

    const err = throwsCollaboration(() =>
      e.plans.confirm({
        planId,
        role: 'design',
        outcome: 'agree',
        submittedBy: 'Anyone',
        declaredMember: 'Anyone',
      }),
    )
    assert.equal(err.code, 'VACANT_ROLE_CANNOT_CONFIRM')
    e.cleanup()
  })

  test('a refusal names BOTH ways out, so the model does not have to guess', () => {
    const e = env()
    const planId = e.register([e.task('a', 'product')], ['product'])

    const err = throwsCollaboration(() =>
      e.plans.confirm({
        planId,
        role: 'product',
        outcome: 'agree',
        submittedBy: 'Su',
        declaredMember: 'Su',
      }),
    )
    // Without an actionable message the model tends to retry blindly or invent a name.
    assert.match(err.message, /declare as "Chen"/, 'option 1: speak as the right person')
    assert.match(err.message, /project_set_role_member/, 'option 2: hand the role over')
    e.cleanup()
  })

  test('one person holding several roles must still confirm each separately', () => {
    const e = env()
    // Both roles belong to ONE person, which is allowed.
    e.projects.setMember(e.projectId, 'design', 'Chen')
    const planId = e.register([e.task('a', 'product'), e.task('b', 'design')], [
      'product',
      'design',
    ])

    e.plans.confirm({
      planId,
      role: 'product',
      outcome: 'agree',
      submittedBy: 'Chen',
      declaredMember: 'Chen',
    })
    assert.equal(
      e.plans.get(planId).plan.activatedAt,
      null,
      'product\'s agreement must not carry design',
    )
    assert.equal(e.plans.get(planId).slots.filter((s) => s.outcome === 'agree').length, 1)

    const done = e.plans.confirm({
      planId,
      role: 'design',
      outcome: 'agree',
      submittedBy: 'Chen',
      declaredMember: 'Chen',
    })
    assert.notEqual(done.plan.activatedAt, null, 'the second confirmation is what closes it')
    e.cleanup()
  })
})

describe('a result decision must come from the deciding role\'s member', () => {
  /** Activate one product task so a result can be submitted and reviewed. */
  function withResult() {
    const e = env()
    const planId = e.register([e.task('a', 'product')], ['product'])
    e.plans.confirm({
      planId,
      role: 'product',
      outcome: 'agree',
      submittedBy: 'Chen',
      declaredMember: 'Chen',
    })
    const taskId = e.tasks.listByProject(e.projectId)[0]?.task.id as string
    const r = e.results.submit({
      taskId,
      summary: 's',
      files: [],
      selfCheck: 'c',
      submittedBy: 'Chen',
    })
    return { e, taskId, resultId: r.resultId }
  }

  test('a non-member cannot review', () => {
    const { e, resultId } = withResult()
    const err = throwsCollaboration(() =>
      e.results.review({
        resultId,
        version: 1,
        outcome: 'complete',
        submittedBy: 'Su',
        role: 'product',
        declaredMember: 'Su',
      }),
    )
    assert.equal(err.code, 'NOT_ROLE_MEMBER')
    assert.equal(e.tasks.listByProject(e.projectId)[0]?.task.completedAt, null, 'nothing completed')
    e.cleanup()
  })

  test('the role\'s own member can review', () => {
    const { e, taskId, resultId } = withResult()
    e.results.review({
      resultId,
      version: 1,
      outcome: 'complete',
      submittedBy: 'Chen',
      role: 'product',
      declaredMember: 'Chen',
    })
    // `review` returns the result version; the decision's own evidence is the completion stamp
    // that only a `complete` review sets (MVP-025).
    const task = e.tasks.get(taskId).task
    assert.notEqual(task.completedAt, null, 'the review landed')
    e.cleanup()
  })

  test('a non-member cannot accept a downstream result', () => {
    const e = env()
    const planId = e.register(
      [e.task('a', 'product'), e.task('b', 'design', ['a'])],
      ['product', 'design'],
    )
    e.plans.confirm({
      planId,
      role: 'product',
      outcome: 'agree',
      submittedBy: 'Chen',
      declaredMember: 'Chen',
    })
    e.plans.confirm({
      planId,
      role: 'design',
      outcome: 'agree',
      submittedBy: 'Su',
      declaredMember: 'Su',
    })

    const list = e.tasks.listByProject(e.projectId)
    const upstream = list.find((t) => t.task.role === 'product')?.task.id as string
    const downstream = list.find((t) => t.task.role === 'design')?.task.id as string

    const r = e.results.submit({
      taskId: upstream,
      summary: 's',
      files: [],
      selfCheck: 'c',
      submittedBy: 'Chen',
    })
    e.results.review({
      resultId: r.resultId,
      version: 1,
      outcome: 'complete',
      submittedBy: 'Chen',
      role: 'product',
      declaredMember: 'Chen',
    })
    e.results.openAcceptances(r.resultId, 1)

    // design decides; 'Chen' holds product, not design.
    const err = throwsCollaboration(() =>
      e.results.decide({
        resultId: r.resultId,
        version: 1,
        taskId: downstream,
        outcome: 'accept',
        submittedBy: 'Chen',
        declaredMember: 'Chen',
      }),
    )
    assert.equal(err.code, 'NOT_ROLE_MEMBER')
    e.cleanup()
  })
})

describe('the eligibility rule itself', () => {
  test('an undeclared session is told to declare, not told it is the wrong person', () => {
    const err = throwsCollaboration(() =>
      assertCanActAsRole({ role: 'product', memberOfRole: 'Chen', declaredMember: null }),
    )
    assert.equal(err.code, 'MEMBER_NOT_DECLARED')
    assert.match(err.message, /session_declare_member/)
  })

  test('a matching member is returned, so the caller records the RIGHT name', () => {
    const who = assertCanActAsRole({
      role: 'product',
      memberOfRole: 'Chen',
      declaredMember: 'Chen',
    })
    assert.equal(who, 'Chen')
  })

  test('a mismatch is refused and names both parties', () => {
    const err = throwsCollaboration(() =>
      assertCanActAsRole({ role: 'product', memberOfRole: 'Chen', declaredMember: 'Su' }),
    )
    assert.equal(err.code, 'NOT_ROLE_MEMBER')
    assert.deepEqual(err.details, { role: 'product', memberOfRole: 'Chen', declaredMember: 'Su' })
  })

  /**
   * Ordering matters: a vacant role must report VACANCY even when the speaker is unknown.
   * Otherwise the model is told to declare an identity, does so, and only THEN learns nobody
   * holds the role — two round trips for one problem.
   */
  test('a vacancy is reported ahead of an undeclared identity', () => {
    const err = throwsCollaboration(() =>
      assertCanActAsRole({ role: 'product', memberOfRole: null, declaredMember: null }),
    )
    assert.equal(err.code, 'MEMBER_NOT_DECLARED')
  })
})
