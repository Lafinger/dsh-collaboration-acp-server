/**
 * The tool OUTPUT contract — the layer where five real gaps were found.
 *
 * Every other test in this suite calls a SERVICE. Nothing tested what a tool actually returns,
 * and that is precisely where these bugs survived:
 *
 *   - MVP-005: only 2 of 5 write paths enforced archive, so an archived project kept accepting
 *              new analyses, progress notes and results (a real write bug, proven at runtime)
 *   - MVP-022: 必交成果 and 完成标准 were stored per task version but NO tool returned them, so an
 *              executor could not see what they owed or what "done" meant
 *   - MVP-027: the rejection notice was addressed to the DECIDING task, so the rejecter was told
 *              about their own decision and the upstream producer was never told
 *   - MVP-003: project_get omitted the current formal plan entirely
 *
 * These tests assert on the JSON a tool produces, so a field silently dropped from a projection
 * fails here instead of surfacing as a confused agent much later.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../sqlite/schema.js'
import { ProjectService } from '../service/project-service.js'
import { PlanService } from '../service/plan-service.js'
import { TaskService } from '../service/task-service.js'
import { ResultService } from '../service/result-service.js'
import { NoticeService } from '../service/notice-service.js'
import { AnalysisService } from '../service/analysis-service.js'
import { MaterialService } from '../service/material-service.js'
import { taskDetailToJson, taskToJson } from '../tool/task-tools.js'
import { activePlansToJson, projectToolDefinitions } from '../tool/project-tools.js'
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
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  const projects = new ProjectService(db)
  const tasks = new TaskService(db)
  const plans = new PlanService(db, undefined, tasks)
  const results = new ResultService(db)
  const notices = new NoticeService(db)
  const materials = new MaterialService(db, '/tmp/unused-tool-output')
  const analyses = new AnalysisService(db, materials)

  const p = projects.create({ key: 'TOOLS', name: 'Tool output' })
  projects.setMember(p.id, 'product', 'Ana')
  projects.setMember(p.id, 'design', 'Bo')

  /**
   * A decision must come from the role's own member (ADR-0014), so the confirming name is read
   * from the same table that staffs the roles rather than written twice.
   */
  const memberOf = (role: RoleId): string => {
    if (role === 'product') return 'Ana'
    if (role === 'design') return 'Bo'
    throw new Error(`this fixture only staffs product and design, not ${role}`)
  }

  const add = (
    ref: string,
    role: RoleId,
    dependsOn: readonly string[] = [],
    requiredResults: string | null = null,
    completionCriteria: string | null = null,
  ): PlannedTask & { requiredResults: string | null; completionCriteria: string | null } => ({
    ref, taskId: null, role, change: 'add', content: `do ${ref}`, dependsOn,
    requiredResults, completionCriteria,
  })

  /** Register and fully confirm, so the plan ACTIVATES and creates tasks. */
  const activate = (taskList: readonly PlannedTask[], roles: readonly RoleId[]): void => {
    const planId = plans.register({
      projectId: p.id, title: 'P', relevantRoles: roles, rolesReason: 'because',
      tasks: taskList, undecided: [],
    }).plan.id
    for (const r of roles) {
      if (r !== 'product' && r !== 'design') {
        throw new Error(`this fixture only staffs product and design, not ${r}`)
      }
      plans.confirm({
        planId,
        role: r,
        outcome: 'agree',
        submittedBy: memberOf(r),
        declaredMember: memberOf(r),
      })
    }
  }

  const taskIdOf = (role: RoleId): string => {
    const found = tasks.listByProject(p.id).find((t) => t.task.role === role)
    if (found === undefined) throw new Error(`no task for role ${role}`)
    return found.task.id
  }

  return {
    db, projects, plans, tasks, results, notices, analyses, materials,
    projectId: p.id, add, activate, taskIdOf,
    cleanup: () => db.close(),
  }
}

describe('MVP-022: a task shows what it owes, not just what it is', () => {
  test('task_get exposes 必交成果 and 完成标准', () => {
    const e = env()
    e.activate(
      [
        e.add('a', 'product', [], 'MUST-DELIVER-SPEC', 'MUST-BE-REVIEWED'),
      ],
      ['product'],
    )
    const id = e.taskIdOf('product')

    const json = taskDetailToJson(e.tasks.get(id), e.projects)
    assert.equal(
      json.required_results, 'MUST-DELIVER-SPEC',
      'the deliverable requirement must be visible to the executor',
    )
    assert.equal(
      json.completion_criteria, 'MUST-BE-REVIEWED',
      'the completion standard must be visible too',
    )
    e.cleanup()
  })

  test('the per-version view carries them as well, so history stays meaningful', () => {
    const e = env()
    e.activate([e.add('a', 'product', [], 'SPEC-V1', 'CRIT-V1')], ['product'])
    const json = taskDetailToJson(e.tasks.get(e.taskIdOf('product')), e.projects)

    const versions = json.versions as readonly Record<string, unknown>[]
    assert.equal(versions[0]?.required_results, 'SPEC-V1')
    assert.equal(versions[0]?.completion_criteria, 'CRIT-V1')
    e.cleanup()
  })

  test('a task with no declared deliverable reports null rather than inventing text', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const json = taskDetailToJson(e.tasks.get(e.taskIdOf('product')), e.projects)

    assert.equal(json.required_results, null, 'absent means absent, never fabricated')
    assert.equal(json.completion_criteria, null)
    e.cleanup()
  })

  test('the executor is derived from the CURRENT member, not a stale snapshot', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const id = e.taskIdOf('product')
    assert.equal(taskToJson(e.tasks.get(id), e.projects).member, 'Ana')

    e.projects.setMember(e.projectId, 'product', 'Replacement')
    assert.equal(
      taskToJson(e.tasks.get(id), e.projects).member, 'Replacement',
      'roles are mutable labels (MVP-004), so the task must follow the change',
    )
    e.cleanup()
  })
})

describe('MVP-003: the project overview names the current formal plan', () => {
  /**
   * Drive the real `project_get` tool rather than its projection helper. The tool body ignores
   * its second argument, so a minimal stub is enough — and going through `execute` is what makes
   * these tests fail if the tool stops WIRING the helper up.
   */
  const projectGet = async (e: ReturnType<typeof env>): Promise<Record<string, unknown>> => {
    const def = projectToolDefinitions(e.projects, e.plans).find((d) => d.name === 'project_get')
    assert.ok(def, 'project_get must be registered')
    const out = await def.execute({ project_id: e.projectId }, {} as never)
    return out as Record<string, unknown>
  }

  test('a project with no active plan reports an empty list, not an error', async () => {
    const e = env()
    // Registered but NOT confirmed: a plan that is merely a proposal is not a 正式计划.
    e.plans.register({
      projectId: e.projectId, title: 'proposal', relevantRoles: ['product'],
      rolesReason: 'r', tasks: [e.add('a', 'product')], undecided: [],
    })
    const out = await projectGet(e)
    assert.deepEqual(out.active_plans, [], 'a proposal is not a plan yet')
    e.cleanup()
  })

  test('after activation the plan appears with its title, version and time', async () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    const out = await projectGet(e)
    const active = out.active_plans as readonly Record<string, unknown>[]

    assert.equal(active.length, 1)
    assert.equal(active[0]?.title, 'P')
    assert.equal(active[0]?.version, 1)
    assert.ok(active[0]?.activated_at, 'the moment it became formal must be shown')
    e.cleanup()
  })

  test('a project with TWO active plans reports BOTH rather than hiding one', async () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    e.activate([e.add('b', 'product')], ['product'])

    const out = await projectGet(e)
    assert.equal(
      (out.active_plans as readonly unknown[]).length, 2,
      'nothing retires an earlier plan, so reporting only one would misrepresent the project',
    )
    e.cleanup()
  })

  test('the overview still carries the project and its role slots', async () => {
    const e = env()
    const out = await projectGet(e)
    assert.ok(out.project, 'project_get must still return the project itself')
    assert.ok(Array.isArray(out.roles), 'and the nine role slots')
    e.cleanup()
  })
})

describe('MVP-005: an archived project is read-only on EVERY write path', () => {
  test('archive refuses a material, a plan, a member change — and an analysis', () => {
    const e = env()
    // A material first, so the analysis below has a valid scope to read.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-tool-'))
    const src = path.join(root, 'm.md')
    fs.writeFileSync(src, 'material')
    const materials = new MaterialService(e.db, root)
    const analyses = new AnalysisService(e.db, materials)

    const up = materials.upload({
      projectId: e.projectId, role: 'product', purpose: 'requirements',
      originalName: 'm.md', sourcePath: src, submittedBy: 'Ana',
    })

    e.projects.archive(e.projectId)

    assert.equal(
      throwsWorkbench(() => materials.upload({
        projectId: e.projectId, role: 'product', purpose: 'requirements',
        originalName: 'm2.md', sourcePath: src, submittedBy: 'Ana',
      })).code,
      'PROJECT_ARCHIVED',
    )
    assert.equal(
      throwsWorkbench(() => e.plans.register({
        projectId: e.projectId, title: 'late', relevantRoles: ['product'],
        rolesReason: 'r', tasks: [e.add('a', 'product')], undecided: [],
      })).code,
      'PROJECT_ARCHIVED',
    )
    assert.equal(
      throwsWorkbench(() => e.projects.setMember(e.projectId, 'backend', 'late')).code,
      'PROJECT_ARCHIVED',
    )
    // The one that was MISSING: an analysis is a new write too. A valid scope is supplied so a
    // SCOPE_REQUIRED refusal cannot be mistaken for archive enforcement.
    assert.equal(
      throwsWorkbench(() => analyses.submit({
        projectId: e.projectId, trigger: 'after archive',
        scope: [{ materialId: up.material.id, version: 1 }],
        requirements: [{ text: 'x', sources: [{ materialId: up.material.id, version: 1 }] }],
        undecided: [], inferences: [], notUnderstood: [], basisMissing: [],
      })).code,
      'PROJECT_ARCHIVED',
      'an archived project must not collect new analyses',
    )
    e.cleanup()
  })

  test('archive refuses progress, submission, review, acceptance and slot opening', () => {
    const e = env()
    // `up` is the upstream task and depends on nothing; `down` consumes `up`.
    e.activate([e.add('up', 'product'), e.add('down', 'design', ['up'])], ['product', 'design'])
    const design = e.taskIdOf('design')
    const product = e.taskIdOf('product')

    // Build real state BEFORE archiving, so each refusal below has something to act on.
    const r = e.results.submit({
      taskId: product, summary: 'the spec', files: [], selfCheck: 'ok', submittedBy: 'Ana',
    })
    e.projects.archive(e.projectId)

    assert.equal(
      throwsWorkbench(() => e.results.addProgress({
        taskId: product, note: 'still going', submittedBy: 'Ana',
      })).code,
      'PROJECT_ARCHIVED',
      'progress is a write',
    )
    assert.equal(
      throwsWorkbench(() => e.results.submit({
        taskId: design, summary: 'x', files: [], selfCheck: 'y', submittedBy: 'Bo',
      })).code,
      'PROJECT_ARCHIVED',
    )
    assert.equal(
      throwsWorkbench(() => e.results.review({
        resultId: r.resultId, version: 1, outcome: 'complete', role: 'product', submittedBy: 'Ana', declaredMember: 'Ana',
      })).code,
      'PROJECT_ARCHIVED',
      'a review is a decision, and decisions are writes',
    )
    assert.equal(
      throwsWorkbench(() => e.results.openAcceptances(r.resultId, 1)).code,
      'PROJECT_ARCHIVED',
    )
    assert.equal(
      throwsWorkbench(() => e.results.decide({
        resultId: r.resultId, version: 1, taskId: design, outcome: 'accept', submittedBy: 'Bo', declaredMember: 'Bo',
      })).code,
      'PROJECT_ARCHIVED',
    )
    e.cleanup()
  })

  test('reads still work on an archived project — read-only, not invisible', () => {
    const e = env()
    e.activate([e.add('a', 'product')], ['product'])
    e.projects.archive(e.projectId)

    assert.equal(e.projects.get(e.projectId).key, 'TOOLS')
    assert.equal(e.tasks.listByProject(e.projectId).length, 1)
    assert.ok(activePlansToJson(e.plans, e.projectId).length === 1, 'its plan is still visible')
    e.cleanup()
  })
})

describe('MVP-027: a rejection notifies the UPSTREAM executor', () => {
  test('the notice names the producer, not the role that rejected', () => {
    const e = env()
    e.activate([e.add('up', 'product'), e.add('down', 'design', ['up'])], ['product', 'design'])
    const up = e.taskIdOf('product')
    const down = e.taskIdOf('design')

    const r = e.results.submit({
      taskId: up, summary: 'upstream deliverable', files: [], selfCheck: 'ok', submittedBy: 'Ana',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', role: 'product', submittedBy: 'Ana', declaredMember: 'Ana',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({
      resultId: r.resultId, version: 1, taskId: down, outcome: 'reject',
      reason: 'does not meet the standard', submittedBy: 'Bo', declaredMember: 'Bo',
    })

    const rejected = e.notices.list({ projectId: e.projectId }).filter(
      (n) => n.kind === 'result_rejected',
    )
    assert.equal(rejected.length, 1, 'a rejection produces exactly one notice')
    assert.equal(
      rejected[0]?.role, 'product',
      'the notice belongs to the role whose work was refused',
    )
    assert.equal(rejected[0]?.member, 'Ana', 'and to the person filling it')
    assert.equal(
      rejected[0]?.taskId, up,
      'the task named must be the PRODUCER, not the rejecter',
    )
    assert.equal(rejected[0]?.detail, 'does not meet the standard', 'the reason travels with it')
    e.cleanup()
  })

  test('a rejection still creates nothing else — no task, no downstream progress', () => {
    const e = env()
    e.activate([e.add('up', 'product'), e.add('down', 'design', ['up'])], ['product', 'design'])
    const up = e.taskIdOf('product')
    const down = e.taskIdOf('design')

    const r = e.results.submit({
      taskId: up, summary: 's', files: [], selfCheck: 'c', submittedBy: 'Ana',
    })
    e.results.review({
      resultId: r.resultId, version: 1, outcome: 'complete', role: 'product', submittedBy: 'Ana', declaredMember: 'Ana',
    })
    e.results.openAcceptances(r.resultId, 1)
    e.results.decide({
      resultId: r.resultId, version: 1, taskId: down, outcome: 'reject',
      reason: 'no', submittedBy: 'Bo', declaredMember: 'Bo',
    })

    assert.equal(e.tasks.listByProject(e.projectId).length, 2, 'rejection invents no task')
    assert.equal(
      e.tasks.get(down).task.completedAt, null,
      'and does not advance the task that rejected',
    )
    e.cleanup()
  })
})
