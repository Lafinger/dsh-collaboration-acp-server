/**
 * Project-facing tools (read / write split, per the tool-naming rule in the design doc).
 *
 * `project_create` is a WRITE: it has side effects but produces no formal decision.
 * `project_get` / `project_list` are READ: safe for the model to call freely.
 *
 * All three are wrapped with `defineTool` and declare `output` — a bare object literal is
 * silently dropped by this SDK version (ADR-0001).
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonObject, JsonValue } from './json.js'
import { runTool } from './result.js'
import type { ProjectService } from '../service/project-service.js'
import type { PlanService } from '../service/plan-service.js'
import type { ProjectView } from '../domain/project.js'
import type { RoleAssignment } from '../domain/roles.js'

const JSON_OUTPUT = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
}

function projectToJson(project: ProjectView): JsonObject {
  return {
    id: project.id,
    key: project.key,
    name: project.name,
    background: project.background,
    goal: project.goal,
    archived: project.archivedAt !== null,
    pending_fields: [...project.pendingFields],
    created_at: project.createdAt,
  }
}

function rolesToJson(roles: readonly RoleAssignment[]): JsonValue[] {
  return roles.map((r) => ({
    role: r.role,
    label: r.label,
    member: r.member,
    vacant: r.member === null,
  }))
}

function present(title: string, rawInput?: unknown) {
  return {
    card: 'generic' as const,
    title,
    kind: 'other' as const,
    ...(rawInput === undefined ? {} : { rawInput }),
  }
}

/**
 * MVP-003 wants the overview to show the project's 当前正式计划. A project CAN have more than one
 * activated plan — each activation creates its own tasks and nothing retires the previous one —
 * so this reports EVERY active plan rather than silently picking one. With a single active plan
 * the caller sees a one-element list, which is the ordinary case.
 *
 * Exported for tests: the overview's plan field is exactly what MVP-003's acceptance criterion
 * names, so it is tested directly rather than only through `execute`.
 */
export function activePlansToJson(
  plans: PlanService,
  projectId: string,
): readonly JsonValue[] {
  return plans
    .listByProject(projectId)
    .filter((v) => v.plan.activatedAt !== null)
    .map((v) => ({
      plan_id: v.plan.id,
      version: v.plan.version,
      title: v.plan.title,
      activated_at: v.plan.activatedAt,
      relevant_roles: [...v.plan.relevantRoles],
    }))
}

export function projectToolDefinitions(
  service: ProjectService,
  plans: PlanService,
): ToolDefinition[] {
  return [
    defineTool({
      name: 'project_create',
      description:
        'Create a project. Provide a short unique key and a name. Omit background or goal ' +
        'if they are not known yet — they are recorded as pending and never invented.',
      parameters: {
        key: { type: 'string', required: true, description: 'Short unique id, e.g. "ALPHA".' },
        name: { type: 'string', required: true },
        background: { type: 'string', description: 'Omit when unknown.' },
        goal: { type: 'string', description: 'Omit when unknown.' },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const project = service.create({
            key: args.key,
            name: args.name,
            background: args.background,
            goal: args.goal,
          })
          return Promise.resolve({ project: projectToJson(project) })
        }),
      presentCall: (args) => present('Create project', args.key),
    }),

    defineTool({
      name: 'project_get',
      description:
        "Read one project, including its nine role slots and its current formal plan(s). A " +
        'vacant role blocks plan confirmation, so check this before expecting a plan to be ' +
        'confirmable. A fresh project has no active plan — that is normal, not an error.',
      parameters: {
        project_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const project = service.getWithRoles(args.project_id)
          return Promise.resolve({
            project: projectToJson(project),
            roles: rolesToJson(project.roles),
            active_plans: [...activePlansToJson(plans, args.project_id)],
          })
        }),
      presentCall: (args) => present('Read project', args.project_id),
    }),

    defineTool({
      name: 'project_list',
      description: 'List projects. Archived projects are excluded unless explicitly requested.',
      parameters: {
        include_archived: { type: 'boolean' },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const projects = service.list(args.include_archived ?? false)
          return Promise.resolve({ projects: projects.map(projectToJson) })
        }),
      presentCall: () => present('List projects'),
    }),

    defineTool({
      name: 'project_set_role_member',
      description:
        'Set or clear the member occupying one role slot. This is a plain label change: ' +
        'no handover or approval is recorded. Pass null to vacate the slot.',
      parameters: {
        project_id: { type: 'string', required: true },
        role: {
          type: 'string',
          required: true,
          enum: [
            'pm',
            'product',
            'design',
            'scenemodel',
            'sceneart',
            'data',
            'frontend',
            'backend',
            'ue',
          ] as const,
        },
        member: { type: 'string', description: 'Omit to vacate the slot.' },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          service.setMember(args.project_id, args.role, args.member ?? null)
          const project = service.getWithRoles(args.project_id)
          return Promise.resolve({ roles: rolesToJson(project.roles) })
        }),
      presentCall: (args) => present('Set role member', args.role),
    }),

    defineTool({
      name: 'project_archive',
      description:
        'Archive a project. Business content becomes read-only; nothing is deleted and ' +
        'history stays queryable.',
      parameters: {
        project_id: { type: 'string', required: true },
      },
      output: JSON_OUTPUT,
      execute: (args) =>
        runTool(() => {
          const project = service.archive(args.project_id)
          return Promise.resolve({ project: projectToJson(project) })
        }),
      presentCall: (args) => present('Archive project', args.project_id),
    }),
  ]
}
