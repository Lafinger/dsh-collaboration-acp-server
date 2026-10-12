/**
 * Material persistence. Reads and writes only — no business judgement (ADR-0002).
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Material, MaterialId, MaterialVersion } from '../domain/material.js'
import type { ProjectId } from '../domain/project.js'
import type { RoleId } from '../domain/roles.js'

interface MaterialRow {
  readonly id: string
  readonly project_id: string
  readonly original_name: string
  readonly purpose: string
  readonly submitted_by: string
  readonly role: string | null
  readonly created_at: string
}

interface VersionRow {
  readonly material_id: string
  readonly version: number
  readonly rel_path: string
  readonly size: number
  readonly sha256: string
  readonly issue: string | null
  readonly created_at: string
}

function toMaterial(row: MaterialRow): Material {
  return {
    id: row.id,
    projectId: row.project_id,
    originalName: row.original_name,
    purpose: row.purpose,
    submittedBy: row.submitted_by,
    role: (row.role as RoleId | null) ?? null,
    createdAt: row.created_at,
  }
}

function toVersion(row: VersionRow): MaterialVersion {
  return {
    materialId: row.material_id,
    version: Number(row.version),
    relPath: row.rel_path,
    size: Number(row.size),
    sha256: row.sha256,
    issue: row.issue,
    createdAt: row.created_at,
  }
}

export class MaterialRepository {
  constructor(private readonly db: DatabaseSync) {}

  insertMaterial(material: Material): void {
    this.db
      .prepare(
        `INSERT INTO materials (id, project_id, original_name, purpose, submitted_by, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        material.id,
        material.projectId,
        material.originalName,
        material.purpose,
        material.submittedBy,
        material.role,
        material.createdAt,
      )
  }

  findById(id: MaterialId): Material | null {
    const row = this.db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as unknown as
      | MaterialRow
      | undefined
    return row === undefined ? null : toMaterial(row)
  }

  /** Identity is (project, original name, purpose) — so a new purpose starts a new material. */
  findByIdentity(
    projectId: ProjectId,
    originalName: string,
    purpose: string,
  ): Material | null {
    const row = this.db
      .prepare('SELECT * FROM materials WHERE project_id = ? AND original_name = ? AND purpose = ?')
      .get(projectId, originalName, purpose) as unknown as MaterialRow | undefined
    return row === undefined ? null : toMaterial(row)
  }

  listByProject(projectId: ProjectId): readonly Material[] {
    const rows = this.db
      .prepare('SELECT * FROM materials WHERE project_id = ? ORDER BY created_at DESC, id DESC')
      .all(projectId) as unknown as MaterialRow[]
    return rows.map(toMaterial)
  }

  /** Highest existing version for a material, or 0 when it has none yet. */
  latestVersion(materialId: MaterialId): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS v FROM material_versions WHERE material_id = ?')
      .get(materialId) as { v: number }
    return Number(row.v)
  }

  insertVersion(version: MaterialVersion): void {
    this.db
      .prepare(
        `INSERT INTO material_versions (material_id, version, rel_path, size, sha256, issue, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.materialId,
        version.version,
        version.relPath,
        version.size,
        version.sha256,
        version.issue,
        version.createdAt,
      )
  }

  versionsOf(materialId: MaterialId): readonly MaterialVersion[] {
    const rows = this.db
      .prepare('SELECT * FROM material_versions WHERE material_id = ? ORDER BY version ASC')
      .all(materialId) as unknown as VersionRow[]
    return rows.map(toVersion)
  }

  findVersion(materialId: MaterialId, version: number): MaterialVersion | null {
    const row = this.db
      .prepare('SELECT * FROM material_versions WHERE material_id = ? AND version = ?')
      .get(materialId, version) as unknown as VersionRow | undefined
    return row === undefined ? null : toVersion(row)
  }

  /** Count of version rows per material, used to detect unexpected gaps. */
  countVersions(materialId: MaterialId): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM material_versions WHERE material_id = ?')
      .get(materialId) as { c: number }
    return Number(row.c)
  }
}
