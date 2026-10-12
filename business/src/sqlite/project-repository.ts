/**
 * Project persistence. No business judgement here — this layer only reads and writes
 * (ADR-0002). Uniqueness of `key` is enforced by the schema, not by a pre-check.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Project, ProjectId } from '../domain/project.js'
import type { RoleAssignment, RoleId } from '../domain/roles.js'
import { ROLE_IDS, ROLE_LABELS } from '../domain/roles.js'

interface ProjectRow {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly background: string | null
  readonly goal: string | null
  readonly archived_at: string | null
  readonly created_at: string
}

interface RoleRow {
  readonly role: string
  readonly member_label: string | null
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    background: row.background,
    goal: row.goal,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
  }
}

export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(project: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, key, name, background, goal, archived_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.key,
        project.name,
        project.background,
        project.goal,
        project.archivedAt,
        project.createdAt,
      )
  }

  findById(id: ProjectId): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as
      | ProjectRow
      | undefined
    return row === undefined ? null : toProject(row)
  }

  findByKey(key: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE key = ?').get(key) as unknown as
      | ProjectRow
      | undefined
    return row === undefined ? null : toProject(row)
  }

  list(includeArchived: boolean): readonly Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY created_at DESC, id DESC'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC, id DESC'
    const rows = this.db.prepare(sql).all() as unknown as ProjectRow[]
    return rows.map(toProject)
  }

  /**
   * All nine roles, with the member label joined in. Roles without a row in
   * project_roles are reported as vacant rather than omitted — the caller always needs
   * the full picture to decide whether a plan can be confirmed (ADR-0004).
   */
  rolesOf(projectId: ProjectId): readonly RoleAssignment[] {
    const rows = this.db
      .prepare('SELECT role, member_label FROM project_roles WHERE project_id = ?')
      .all(projectId) as unknown as RoleRow[]
    const byRole = new Map(rows.map((r) => [r.role, r.member_label]))

    return ROLE_IDS.map((role: RoleId) => ({
      role,
      label: ROLE_LABELS[role],
      member: byRole.get(role) ?? null,
    }))
  }

  setMember(projectId: ProjectId, role: RoleId, member: string | null, at: string): void {
    this.db
      .prepare(
        `INSERT INTO project_roles (project_id, role, member_label, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, role)
         DO UPDATE SET member_label = excluded.member_label, updated_at = excluded.updated_at`,
      )
      .run(projectId, role, member, at)
  }

  archive(projectId: ProjectId, at: string): void {
    this.db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(at, projectId)
  }
}
