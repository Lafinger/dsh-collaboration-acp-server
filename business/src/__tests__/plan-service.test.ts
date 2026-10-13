import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { migrate, inTransaction } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { PlanService, findCycle } from '../service/plan-service.js'
import { CollaborationError } from '../domain/error.js'
import type { PlannedTask } from '../domain/plan.js'

interface Env {
  db: DatabaseSync
  projects: ProjectService
  plans: PlanService
  projectId: string
  task(ref: string, role: string, dependsOn?: string[]): PlannedTask
  cleanup(): void
}

function env(): Env {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)

  const projects = new ProjectService(db)
  const plans = new PlanService(db)
  const project = projects.create({ key: 'ALPHA', name: 'Alpha' })

  return {
    db,
    projects,
    plans,
    projectId: project.id,
    task: (ref, role, dependsOn = []) => ({
      ref,
      taskId: null,
      role: role as PlannedTask['role'],
      change: 'add' as const,
      content: `do ${ref}`,
      dependsOn,
    }),
    cleanup() {
      db.close()
    },
  }
}

/** Register a two-role plan, the common shape in these tests. */
function twoRolePlan(e: Env, roles: string[] = ['product', 'design']) {
  return e.plans.register({
    projectId: e.projectId,
    title: 'Ship v1',
    relevantRoles: roles as never,
    rolesReason: 'both roles own a deliverable',
    tasks: [e.task('t1', 'product')],
    undecided: [],
  })
}

/**
 * Staff every listed role with one member.
 *
 * The default is 'Z' because that is the name most tests in this file decide as — and ADR-0014
 * requires the deciding name to be the role's member, so the fixture has to agree with itself.
 * Tests that decide as somebody else pass that name here.
 */
function staffAll(e: Env, roles: readonly string[], member = 'Z'): void {
  for (const r of roles) {
    e.projects.setMember(e.projectId, r, member)
  }
}

/**
 * Staff individual roles with individual people.
 *
 * Needed because a decision must come from its own role's member (ADR-0014), so a test that has two
 * roles decide as two different names must give each role that name. `staffAll` cannot express that.
 */
function staff(e: Env, byRole: Readonly<Record<string, string>>): void {
  for (const [role, member] of Object.entries(byRole)) {
    e.projects.setMember(e.projectId, role, member)
  }
}

describe('registration (MVP-017)', () => {
  test('a plan gets one slot per relevant role and starts pending', () => {
    const e = env()
    const { plan, slots, gate } = twoRolePlan(e)

    assert.equal(plan.version, 1)
    assert.deepEqual(plan.relevantRoles, ['product', 'design'])
    assert.equal(slots.length, 2)
    assert.ok(slots.every((s) => s.outcome === null && s.voidedAt === null))
    assert.equal(gate.kind, 'waiting')
    assert.equal(plan.activatedAt, null)
    e.cleanup()
  })

  test('the roles reason is required', () => {
    const e = env()
    assert.throws(
      () => e.plans.register({
        projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
        rolesReason: '   ', tasks: [], undecided: [],
      }),
      /roles reason is required/,
    )
    e.cleanup()
  })

  test('at least one relevant role is required', () => {
    const e = env()
    assert.throws(
      () => e.plans.register({
        projectId: e.projectId, title: 't', relevantRoles: [] as never,
        rolesReason: 'because', tasks: [], undecided: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'ROLES_REQUIRED',
    )
    e.cleanup()
  })

  test('an unknown role is refused', () => {
    const e = env()
    assert.throws(
      () => e.plans.register({
        projectId: e.projectId, title: 't', relevantRoles: ['wizard'] as never,
        rolesReason: 'because', tasks: [], undecided: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'ROLE_UNKNOWN',
    )
    e.cleanup()
  })

  test('overriding the Agent proposal keeps the original (MVP-018)', () => {
    const e = env()
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 't',
      relevantRoles: ['product', 'design'] as never,
      rolesReason: 'corrected by the caller',
      tasks: [], undecided: [],
      proposedRoles: ['product'] as never,
    })

    assert.equal(plan.rolesOverridden, true)
    assert.deepEqual(plan.proposedRoles, ['product'])
    assert.deepEqual(plan.relevantRoles, ['product', 'design'])
    e.cleanup()
  })

  test('an unchanged proposal is not marked as overridden', () => {
    const e = env()
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
      rolesReason: 'because', tasks: [], undecided: [], proposedRoles: ['product'] as never,
    })
    assert.equal(plan.rolesOverridden, false)
    assert.deepEqual(plan.proposedRoles, ['product'])
    e.cleanup()
  })

  /**
   * MVP-018 requires the REASON for the role set to be recorded, not just that a reason was
   * supplied. A mutation that truncated `rolesReason` to the empty string SURVIVED the whole
   * suite: `rolesReason` is passed in ~50 call sites, but every one of them only relied on it
   * being non-empty, and nothing ever asserted its value. A field nobody reads is a field that
   * can silently stop carrying information.
   */
  test('the roles reason is stored verbatim, not merely required', () => {
    const e = env()
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 't', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'design owns the interaction spec, so both roles are relevant',
      tasks: [], undecided: [],
    })
    assert.equal(
      plan.rolesReason, 'design owns the interaction spec, so both roles are relevant',
      'the reason must survive intact — it is the evidence for WHY these roles',
    )

    // And it survives a revision: the plan's history must show how the reasoning changed.
    const revised = e.plans.revise({
      planId: plan.id, title: 't2', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'design dropped out after the spec was signed off',
      tasks: [], undecided: [], reason: 'narrowed',
    })
    assert.equal(
      revised.plan.rolesReason, 'design dropped out after the spec was signed off',
      'a revision records its OWN reasoning, not the previous one',
    )
    e.cleanup()
  })
})

describe('dependency validation at registration (MVP-017)', () => {
  test('a dangling dependency is refused', () => {
    const e = env()
    assert.throws(
      () => e.plans.register({
        projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [e.task('t1', 'product', ['nope'])], undecided: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'DEPENDENCY_MISSING_TASK',
    )
    e.cleanup()
  })

  test('a two-node cycle is refused, and the error names it', () => {
    const e = env()
    try {
      e.plans.register({
        projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
        rolesReason: 'r',
        tasks: [e.task('a', 'product', ['b']), e.task('b', 'design', ['a'])],
        undecided: [],
      })
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(err instanceof CollaborationError)
      assert.equal(err.code, 'DEPENDENCY_CYCLE')
      // Naming the cycle is what makes the error actionable.
      assert.match(err.message, /a -> b -> a/)
    }
    e.cleanup()
  })

  test('a self-dependency is refused', () => {
    const e = env()
    assert.throws(
      () => e.plans.register({
        projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [e.task('a', 'product', ['a'])], undecided: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'DEPENDENCY_CYCLE',
    )
    e.cleanup()
  })

  test('duplicate task refs are refused', () => {
    const e = env()
    assert.throws(
      () => e.plans.register({
        projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [e.task('a', 'product'), e.task('a', 'design')], undecided: [],
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'DUPLICATE_TASK_REF',
    )
    e.cleanup()
  })

  test('a diamond is NOT a cycle', () => {
    const e = env()
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
      rolesReason: 'r',
      tasks: [
        e.task('a', 'product'),
        e.task('b', 'design', ['a']),
        e.task('c', 'frontend', ['a']),
        e.task('d', 'backend', ['b', 'c']),
      ],
      undecided: [],
    })
    assert.equal(plan.tasks.length, 4)
    e.cleanup()
  })

  test('a rejected registration leaves nothing behind', () => {
    const e = env()
    assert.throws(() => e.plans.register({
      projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
      rolesReason: 'r', tasks: [e.task('a', 'product', ['b']), e.task('b', 'design', ['a'])],
      undecided: [],
    }))
    for (const t of ['plans', 'plan_roles', 'plan_tasks', 'plan_task_deps', 'confirmations']) {
      const c = Number((e.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c)
      assert.equal(c, 0, `${t} must be empty`)
    }
    e.cleanup()
  })

  test('findCycle is exercised directly on a longer ring', () => {
    const ring: PlannedTask[] = [
      { ref: 'a', taskId: null, role: 'product', change: 'add', content: 'x', dependsOn: ['b'] },
      { ref: 'b', taskId: null, role: 'product', change: 'add', content: 'x', dependsOn: ['c'] },
      { ref: 'c', taskId: null, role: 'product', change: 'add', content: 'x', dependsOn: ['a'] },
    ]
    const cycle = findCycle(ring)
    assert.ok(cycle !== null)
    assert.equal(cycle[0], cycle[cycle.length - 1], 'the path starts and ends at the same ref')
    assert.equal(findCycle([{ ref: 'a', taskId: null, role: 'product', change: 'add', content: 'x', dependsOn: [] }]), null)
  })
})

describe('the gate: all roles must agree (MVP-019, MVP-020)', () => {
  test('one agreement is not enough', () => {
    const e = env()
    staffAll(e, ['product', 'design'], 'Zhang')
    const { plan } = twoRolePlan(e)

    const after = e.plans.confirm({
      planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang',
    })

    assert.equal(after.plan.activatedAt, null, 'a single agreement must not activate')
    assert.equal(after.gate.kind, 'waiting')
    e.cleanup()
  })

  test('all agreements activate the plan exactly once', () => {
    const e = env()
    staff(e, { product: 'Zhang', design: 'Li' })
    const { plan } = twoRolePlan(e)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })
    const done = e.plans.confirm({
      planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li',
    })

    assert.notEqual(done.plan.activatedAt, null)
    assert.equal(done.gate.kind, 'unanimous')
    // Order follows the plan's own role list, not alphabetical.
    assert.deepEqual(done.gate.kind === 'unanimous' ? done.gate.agreed : [], ['product', 'design'])

    // Activation is recorded once, as a fact.
    const activations = Number(
      (e.db.prepare('SELECT COUNT(*) c FROM plan_activations').get() as { c: number }).c,
    )
    assert.equal(activations, 1)
    e.cleanup()
  })

  test('a rejection blocks just as hard as silence, and is reported separately', () => {
    const e = env()
    staff(e, { product: 'Z', design: 'Li' })
    const { plan } = twoRolePlan(e)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    const after = e.plans.confirm({
      planId: plan.id, role: 'design', outcome: 'reject', reason: 'no capacity this sprint',
      submittedBy: 'Li', declaredMember: 'Li',
    })

    assert.equal(after.plan.activatedAt, null)
    assert.equal(after.gate.kind, 'waiting')
    if (after.gate.kind === 'waiting') {
      assert.deepEqual(after.gate.rejected, ['design'])
      assert.deepEqual(after.gate.pending, [])
    }
    // Even after everyone has spoken, a rejection keeps it shut.
    const again = e.plans.confirm({
      planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li',
    })
    assert.notEqual(again.plan.activatedAt, null, 'changing the mind to agree does open it')
    e.cleanup()
  })

  test('a rejection requires a reason', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)

    assert.throws(
      () => e.plans.confirm({
        planId: plan.id, role: 'product', outcome: 'reject', reason: '  ', submittedBy: 'Z', declaredMember: 'Z',
      }),
      /rejection reason is required/,
    )
    e.cleanup()
  })

  test('agreement does NOT require a reason', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)
    const after = e.plans.confirm({
      planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z',
    })
    assert.equal(after.slots.find((s) => s.role === 'product')?.outcome, 'agree')
    e.cleanup()
  })

  test('a role that is not relevant cannot confirm', () => {
    const e = env()
    staffAll(e, ['product', 'design', 'frontend'])
    const { plan } = twoRolePlan(e, ['product', 'design'])

    assert.throws(
      () => e.plans.confirm({
        planId: plan.id, role: 'frontend', outcome: 'agree', submittedBy: 'Wang', declaredMember: 'Wang',
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'ROLE_NOT_RELEVANT',
    )
    e.cleanup()
  })

  test('an unknown role cannot confirm', () => {
    const e = env()
    const { plan } = twoRolePlan(e)
    assert.throws(
      () => e.plans.confirm({
        planId: plan.id, role: 'wizard' as never, outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z',
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'ROLE_UNKNOWN',
    )
    e.cleanup()
  })

  test('the submitter snapshot is recorded', () => {
    const e = env()
    staffAll(e, ['product', 'design'], 'Zhang Wei')
    const { plan } = twoRolePlan(e)
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang Wei', declaredMember: 'Zhang Wei' })

    const slot = e.plans.get(plan.id).slots.find((s) => s.role === 'product')
    assert.equal(slot?.submittedBy, 'Zhang Wei')
    assert.notEqual(slot?.decidedAt, null)
    e.cleanup()
  })

  /**
   * MVP-004's actual point: the record keeps the member *snapshot*, not a live pointer.
   *
   * The test above cannot tell the two apart — nothing changes between the decision and the
   * read. This one changes the member AFTERWARDS, which is the only way to distinguish a stored
   * snapshot from a join against the CURRENT roster. A live pointer would silently rewrite
   * history the moment someone is replaced, and the requirement exists precisely to prevent
   * that ("记录须保存当时的成员快照，以便追溯'当时是谁做的'").
   */
  test('a decision keeps the member from the time it was made, after the member changes', () => {
    const e = env()
    staffAll(e, ['product', 'design'], 'Zhang Wei')
    const { plan } = twoRolePlan(e)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang Wei', declaredMember: 'Zhang Wei' })
    // Replace the person in that role. The roster now says someone else entirely.
    e.projects.setMember(e.projectId, 'product', 'Li Lei')

    const slot = e.plans.get(plan.id).slots.find((s) => s.role === 'product')
    assert.equal(
      slot?.submittedBy, 'Zhang Wei',
      'the decision must still name whoever actually made it, not the current member',
    )

    // And the live roster really did change, so the assertion above is not vacuous.
    const current = e.projects.getWithRoles(e.projectId).roles.find((r) => r.role === 'product')
    assert.equal(current?.member, 'Li Lei', 'the replacement took effect, making the test meaningful')
    e.cleanup()
  })

  test('a rejection reason and its submitter both survive a member change', () => {
    const e = env()
    staffAll(e, ['product', 'design'], 'Zhang Wei')
    const { plan } = twoRolePlan(e)

    e.plans.confirm({
      planId: plan.id, role: 'product', outcome: 'reject',
      reason: 'the scope is wrong', submittedBy: 'Zhang Wei', declaredMember: 'Zhang Wei',
    })
    e.projects.setMember(e.projectId, 'product', 'Li Lei')

    const slot = e.plans.get(plan.id).slots.find((s) => s.role === 'product')
    assert.equal(slot?.submittedBy, 'Zhang Wei', 'the rejecter is still named')
    assert.equal(slot?.reason, 'the scope is wrong', 'and the reason is not lost')
    assert.equal(slot?.outcome, 'reject', 'the conclusion itself is unchanged')
    e.cleanup()
  })
})

describe('one person, several roles (MVP-019)', () => {
  test('holding every role still means submitting every role separately', () => {
    const e = env()
    // A single person occupies BOTH roles. This is exactly the case where a lazy
    // implementation would let one submission satisfy the whole gate.
    staffAll(e, ['product', 'design'], 'Zhang')

    const { plan } = twoRolePlan(e)
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })

    const after = e.plans.get(plan.id)
    assert.equal(after.plan.activatedAt, null, 'one submission must not cover two roles')
    assert.equal(after.slots.filter((s) => s.outcome === 'agree').length, 1)
    assert.equal(after.slots.length, 2, 'the second role keeps its own untouched slot')

    e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })
    assert.notEqual(e.plans.get(plan.id).plan.activatedAt, null)
    e.cleanup()
  })
})

describe('a vacant role waits, it never passes (MVP-019)', () => {
  test('a plan whose role has no member never activates', () => {
    const e = env()
    // Only product is staffed; design is empty.
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const { plan } = twoRolePlan(e)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })
    const after = e.plans.get(plan.id)

    assert.equal(after.plan.activatedAt, null)
    assert.equal(after.gate.kind, 'waiting')
    if (after.gate.kind === 'waiting') {
      assert.deepEqual(after.gate.vacancies, ['design'], 'the vacancy is reported, not hidden')
      assert.deepEqual(after.gate.pending, ['design'])
    }
    e.cleanup()
  })

  test('another role cannot stand in for the vacant one', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const { plan } = twoRolePlan(e)

    // product agrees. design is vacant. The guarantee is NOT that design cannot be
    // confirmed later (a vacancy gets filled and then confirmed) — it is that product's
    // agreement does not, and cannot, count for design.
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })

    const after = e.plans.get(plan.id)
    assert.equal(after.plan.activatedAt, null, 'the vacant role must not ride on product')
    assert.equal(after.slots.find((s) => s.role === 'design')?.outcome, null)
    if (after.gate.kind === 'waiting') {
      assert.deepEqual(after.gate.vacancies, ['design'])
    } else {
      assert.fail('a vacancy must keep the gate waiting')
    }
    e.cleanup()
  })

  test('filling the vacancy afterwards lets the plan close normally', () => {
    const e = env()
    e.projects.setMember(e.projectId, 'product', 'Zhang')
    const { plan } = twoRolePlan(e)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })
    assert.equal(e.plans.get(plan.id).plan.activatedAt, null)

    e.projects.setMember(e.projectId, 'design', 'Li')
    const after = e.plans.confirm({
      planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li',
    })
    assert.notEqual(after.plan.activatedAt, null)
    e.cleanup()
  })
})

describe('revision voids, never deletes (MVP-021)', () => {
  test('a revision creates a new version and voids prior confirmations', () => {
    const e = env()
    staffAll(e, ['product', 'design'], 'Zhang')
    const { plan } = twoRolePlan(e)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Zhang', declaredMember: 'Zhang' })

    const revised = e.plans.revise({
      planId: plan.id, title: 'Ship v1.1',
      relevantRoles: ['product', 'design'] as never,
      rolesReason: 'same owners',
      tasks: [e.task('t1', 'product'), e.task('t2', 'design')],
      undecided: [],
      reason: 'split the work',
    })

    assert.equal(revised.plan.version, 2)
    assert.equal(revised.plan.activatedAt, null)
    // The new version starts from nothing collected.
    assert.ok(revised.slots.every((s) => s.outcome === null && s.voidedAt === null))

    // The old confirmation is KEPT, marked void, with the reason.
    const all = e.plans.history(plan.id)
    const v1 = all.find((h) => h.plan.version === 1)
    const voided = v1?.slots.find((s) => s.role === 'product')
    assert.equal(voided?.outcome, 'agree', 'the decision itself survives')
    assert.notEqual(voided?.voidedAt, null, 'but it is marked void')
    assert.equal(voided?.voidReason, 'split the work')
    e.cleanup()
  })

  test('after a revision the plan must be confirmed all over again', () => {
    const e = env()
    staff(e, { product: 'Z', design: 'Li' })
    const { plan } = twoRolePlan(e)
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li' })
    // Version 1 would be active now, so revise the stock case instead: a fresh plan.
    const fresh = twoRolePlan(e)
    e.plans.confirm({ planId: fresh.plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })

    e.plans.revise({
      planId: fresh.plan.id, title: 'changed',
      relevantRoles: ['product', 'design'] as never, rolesReason: 'r',
      tasks: [], undecided: [], reason: 'scope grew',
    })

    e.plans.confirm({ planId: fresh.plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    const after = e.plans.get(fresh.plan.id)
    assert.equal(after.plan.activatedAt, null, 'design has not re-confirmed')
    assert.equal(after.slots.filter((s) => s.outcome === 'agree').length, 1)
    e.cleanup()
  })

  test('an active plan cannot be revised', () => {
    const e = env()
    staff(e, { product: 'Z', design: 'Li' })
    const { plan } = twoRolePlan(e)
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li' })
    assert.notEqual(e.plans.get(plan.id).plan.activatedAt, null)

    assert.throws(
      () => e.plans.revise({
        planId: plan.id, title: 'x', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [], undecided: [], reason: 'y',
      }),
      (err: unknown) => err instanceof CollaborationError && err.code === 'PLAN_ALREADY_ACTIVE',
    )
    e.cleanup()
  })

  test('revision is allowed with partial confirmations collected', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)
    // product agreed, design silent — MVP-021 says this must still be revisable.
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })

    const revised = e.plans.revise({
      planId: plan.id, title: 'v2', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r', tasks: [], undecided: [], reason: 'needed a tweak',
    })
    assert.equal(revised.plan.version, 2)
    e.cleanup()
  })

  test('a revision changing the role set creates exactly the new slots', () => {
    const e = env()
    staffAll(e, ['product', 'design', 'frontend'])
    const { plan } = twoRolePlan(e, ['product', 'design'])

    const revised = e.plans.revise({
      planId: plan.id, title: 'v2',
      relevantRoles: ['product', 'frontend'] as never,
      rolesReason: 'design no longer involved',
      tasks: [], undecided: [], reason: 'roles changed',
    })

    assert.deepEqual(revised.plan.relevantRoles, ['product', 'frontend'])
    assert.deepEqual(revised.slots.map((s) => s.role).sort(), ['frontend', 'product'])
    e.cleanup()
  })

  test('a revision without a reason is refused', () => {
    const e = env()
    const { plan } = twoRolePlan(e)
    assert.throws(
      () => e.plans.revise({
        planId: plan.id, title: 'x', relevantRoles: ['product'] as never,
        rolesReason: 'r', tasks: [], undecided: [], reason: ' ',
      }),
      /revision reason is required/,
    )
    e.cleanup()
  })

  /**
   * Regression: the smoke test surfaced this by *reading the output*, not by failing.
   *
   * `gateStateOf` ignores voided slots, so a superseded version — whose every decision was
   * voided by the revision — recomputed to "everyone pending". That reads as though nobody
   * had ever acted, which erases exactly the history `plan_history` exists to show.
   */
  test('a superseded version reports superseded, not "everyone pending"', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    e.plans.revise({
      planId: plan.id, title: 'v2', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r', tasks: [], undecided: [], reason: 'scope grew',
    })

    const v1 = e.plans.history(plan.id).find((h) => h.plan.version === 1)
    assert.ok(v1 !== undefined)
    assert.equal(
      v1.gate.kind,
      'superseded',
      'version 1 had a decision; it must not be reported as never having had one',
    )
    if (v1.gate.kind === 'superseded') {
      assert.equal(v1.gate.voidReason, 'scope grew')
      assert.notEqual(v1.gate.voidedAt, null)
    }
    // The decision itself is still visible in the slots.
    assert.equal(v1.slots.find((s) => s.role === 'product')?.outcome, 'agree')
    e.cleanup()
  })

  test('an untouched version still reports waiting', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)
    // No decisions, no revision: this one genuinely has nobody acting yet.
    assert.equal(e.plans.get(plan.id).gate.kind, 'waiting')
    e.cleanup()
  })
})

describe('no half-active plan (MVP-020)', () => {
  test('the whole activation lands together, or none of it does', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)
    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })

    // Force the last step of activation to fail. If any part of activation were outside the
    // transaction, plan_activations or activated_at would survive this.
    const original = e.db.prepare.bind(e.db)
    assert.ok(typeof original === 'function')

    const drop = 'DROP TABLE plan_activations'
    e.db.exec(drop)
    assert.throws(() =>
      e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li' }),
    )

    // The rollback must have undone the design confirmation as well as the activation.
    const slots = e.db
      .prepare('SELECT role, outcome FROM confirmations WHERE plan_id = ? ORDER BY role')
      .all(plan.id) as unknown as { role: string; outcome: string | null }[]
    const design = slots.find((s) => s.role === 'design')
    assert.equal(design?.outcome, null, 'the failed activation must not leave the slot agreed')

    const plans = e.db
      .prepare('SELECT activated_at FROM plans WHERE id = ?')
      .all(plan.id) as unknown as { activated_at: string | null }[]
    assert.ok(plans.every((p) => p.activated_at === null), 'no version may be left active')
    e.cleanup()
  })

  test('the plan is active iff every relevant role agreed', () => {
    const e = env()
    // One person holds all three roles; each still confirms separately, as 'X' (MVP-019, ADR-0014).
    staffAll(e, ['product', 'design', 'frontend'], 'X')
    const { plan } = twoRolePlan(e, ['product', 'design', 'frontend'])

    const step = (role: string): boolean => {
      e.plans.confirm({ planId: plan.id, role: role as never, outcome: 'agree', submittedBy: 'X', declaredMember: 'X' })
      return e.plans.get(plan.id).plan.activatedAt !== null
    }

    assert.equal(step('product'), false)
    assert.equal(step('design'), false)
    assert.equal(step('frontend'), true, 'the last agreement is the one that closes it')
    e.cleanup()
  })
})

describe('the plan records advice without becoming it', () => {
  test('undecided marks survive activation', () => {
    const e = env()
    staff(e, { product: 'Z', design: 'Li' })
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 't', relevantRoles: ['product', 'design'] as never,
      rolesReason: 'r', tasks: [], undecided: ['budget unknown', 'no deadline'],
    })

    e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
    const done = e.plans.confirm({
      planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'Li', declaredMember: 'Li',
    })

    assert.notEqual(done.plan.activatedAt, null)
    assert.deepEqual(done.plan.undecided, ['budget unknown', 'no deadline'])
    e.cleanup()
  })

  test('a plan with no tasks can still be registered and activated', () => {
    const e = env()
    staffAll(e, ['product'])
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
      rolesReason: 'r', tasks: [], undecided: [],
    })
    const done = e.plans.confirm({
      planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z',
    })
    assert.notEqual(done.plan.activatedAt, null)
    assert.deepEqual(done.plan.tasks, [])
    e.cleanup()
  })

  /**
   * M4's version of this test asserted the `tasks` table did not exist at all. M5 adds it,
   * so the test now checks the property that was always the point: a plan that has NOT
   * activated creates no tasks.
   */
  test('a plan that has not activated creates no task rows', () => {
    const e = env()
    staffAll(e, ['product'])
    const { plan } = e.plans.register({
      projectId: e.projectId, title: 't', relevantRoles: ['product'] as never,
      rolesReason: 'r', tasks: [e.task('a', 'product')], undecided: [],
    })

    // Registered, gate open, nobody has agreed yet.
    assert.equal(
      (e.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as unknown as { n: number }).n,
      0,
      'registering a plan must not create tasks',
    )
    assert.equal(
      (e.db.prepare('SELECT COUNT(*) AS n FROM task_versions').get() as unknown as { n: number }).n,
      0,
    )

    const done = e.plans.confirm({
      planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z',
    })
    assert.notEqual(done.plan.activatedAt, null, 'the plan did activate')
    e.cleanup()
  })
})

describe('nested transactions (savepoints)', () => {
  test('a revision inside a caller transaction still commits as one unit', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)

    // Compose two transactional operations: the point of savepoint support.
    const result = inTransaction(e.db, () => {
      e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
      return e.plans.revise({
        planId: plan.id, title: 'v2', relevantRoles: ['product', 'design'] as never,
        rolesReason: 'r', tasks: [], undecided: [], reason: 'nested',
      })
    })
    assert.equal(result.plan.version, 2)
    assert.equal(e.plans.history(plan.id).length, 2, 'both the confirm and the revision persisted')
    e.cleanup()
  })

  test('an inner failure rolls back only the inner work', () => {
    const e = env()
    staffAll(e, ['product', 'design'])
    const { plan } = twoRolePlan(e)

    inTransaction(e.db, () => {
      e.plans.confirm({ planId: plan.id, role: 'product', outcome: 'agree', submittedBy: 'Z', declaredMember: 'Z' })
      try {
        inTransaction(e.db, () => {
          e.plans.confirm({ planId: plan.id, role: 'design', outcome: 'agree', submittedBy: 'L', declaredMember: 'L' })
          throw new Error('inner boom')
        })
      } catch {
        // swallowed: the OUTER transaction must survive
      }
    })

    const slots = e.plans.get(plan.id).slots
    assert.equal(slots.find((s) => s.role === 'product')?.outcome, 'agree', 'outer work kept')
    assert.equal(slots.find((s) => s.role === 'design')?.outcome, null, 'inner work rolled back')
    e.cleanup()
  })
})
