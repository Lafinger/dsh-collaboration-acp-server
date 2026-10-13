/**
 * Project business rules (ADR-0002: rules live in service, not in SQL).
 *
 * MVP-001: never invent a missing background or goal.
 * MVP-004: members are mutable labels — changing one is a plain update with no
 *          handover, approval or history requirement.
 * MVP-005: archiving is a one-way stop on writes.
 */
import type { DatabaseSync } from 'node:sqlite'
import { CollaborationError } from '../domain/error.js'
import { newId } from '../domain/ids.js'
import type {
  CreateProjectInput,
  Project,
  ProjectId,
  ProjectView,
  ProjectWithRolesView,
} from '../domain/project.js'
import { assertWritable, isArchived, pendingFields } from '../domain/project.js'
import { isRoleId, type MemberLabel, type RoleId } from '../domain/roles.js'
import { ProjectRepository } from '../sqlite/project-repository.js'
import { inTransaction } from '../sqlite/schema.js'
import { isUniqueViolation } from '../sqlite/errors.js'

const MAX_KEY_LENGTH = 64
const MAX_NAME_LENGTH = 200

export interface Clock {
  now(): string
}

export const systemClock: Clock = { now: () => new Date().toISOString() }

export function toView(project: Project): ProjectView {
  return { ...project, pendingFields: pendingFields(project) }
}

export class ProjectService {
  private readonly projects: ProjectRepository

  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.projects = new ProjectRepository(db)
  }

  create(input: CreateProjectInput): ProjectView {
    const key = normaliseKey(input.key)
    const name = requireText(input.name, 'name', MAX_NAME_LENGTH)

    // Absent stays absent. An empty string is normalised to null so "not provided" has
    // exactly one representation downstream (MVP-001).
    const background = optionalText(input.background, MAX_NAME_LENGTH * 10)
    const goal = optionalText(input.goal, MAX_NAME_LENGTH * 10)

    const project: Project = {
      id: newId(),
      key,
      name,
      background,
      goal,
      archivedAt: null,
      createdAt: this.clock.now(),
    }

    try {
      this.projects.insert(project)
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new CollaborationError('PROJECT_EXISTS', `project key "${key}" is already in use`, { key })
      }
      throw error
    }
    return toView(project)
  }

  get(id: ProjectId): ProjectView {
    return toView(this.requireProject(id))
  }

  getWithRoles(id: ProjectId): ProjectWithRolesView {
    const project = this.requireProject(id)
    return { ...toView(project), roles: this.projects.rolesOf(id) }
  }

  list(includeArchived = false): readonly ProjectView[] {
    return this.projects.list(includeArchived).map(toView)
  }

  /**
   * Set or clear a role's member. No approval, no history — by design (ADR-0004).
   * `null` vacates the slot, which later blocks plan confirmation.
   */
  setMember(projectId: ProjectId, role: string, member: string | null): void {
    this.requireWritable(projectId)
    if (!isRoleId(role)) {
      throw new CollaborationError('ROLE_UNKNOWN', `unknown role "${role}"`, { role })
    }
    const label: MemberLabel | null = member === null ? null : requireText(member, 'member', 120)
    this.projects.setMember(projectId, role as RoleId, label, this.clock.now())
  }

  archive(projectId: ProjectId): ProjectView {
    const project = this.requireProject(projectId)
    if (isArchived(project)) return toView(project)
    inTransaction(this.db, () => this.projects.archive(projectId, this.clock.now()))
    return this.get(projectId)
  }

  private requireProject(id: ProjectId): Project {
    const project = this.projects.findById(id)
    if (project === null) {
      throw new CollaborationError('PROJECT_NOT_FOUND', `no project with id ${id}`, { id })
    }
    return project
  }

  private requireWritable(id: ProjectId): Project {
    // The shared gate, so every service refuses an archived project identically.
    return assertWritable(this.requireProject(id), id)
  }
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CollaborationError('INVALID_ARGUMENT', `${field} is required`, { field })
  }
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new CollaborationError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field })
  }
  return trimmed
}

function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new CollaborationError('INVALID_ARGUMENT', 'expected a string', {})
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) {
    throw new CollaborationError('INVALID_ARGUMENT', `value exceeds ${max} characters`, {})
  }
  return trimmed
}

/** Project keys appear in paths and queries, so restrict them to a safe alphabet. */
function normaliseKey(value: unknown): string {
  const raw = requireText(value, 'key', MAX_KEY_LENGTH)
  const key = raw.toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(key)) {
    throw new CollaborationError(
      'INVALID_ARGUMENT',
      'key must start with a letter or digit and contain only letters, digits, "-" or "_"',
      { key: raw },
    )
  }
  return key
}
