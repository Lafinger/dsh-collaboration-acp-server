/**
 * Material business rules (M2).
 *
 * The two properties that matter most here, both established by real defects during
 * pre-implementation verification:
 *
 *   1. Version allocation and the row insert happen in ONE transaction, using MAX+1 on the
 *      material's own versions. A `COUNT(*)+1` outside a transaction let two uploads both
 *      claim version 1, producing identical filenames — one file silently overwrote the
 *      other, breaking the immutability guarantee (MVP-007).
 *
 *   2. The destination path is resolved and checked against the storage root BEFORE any
 *      bytes are written. A crafted project id wrote a real file outside fileRoot
 *      (ADR-0004).
 *
 * A refusal must leave NOTHING behind: no file, no row.
 */
import { createHash } from 'node:crypto'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { CollaborationError } from '../domain/error.js'
import { newId } from '../domain/ids.js'
import type {
  Material,
  MaterialId,
  MaterialReference,
  MaterialVersion,
  MaterialWithVersions,
  UploadMaterialInput,
} from '../domain/material.js'
import { roleDirOf } from '../domain/material.js'
import { assertWritable } from '../domain/project.js'
import type { ProjectId } from '../domain/project.js'
import { isRoleId, type RoleId } from '../domain/roles.js'
import { MaterialRepository } from '../sqlite/material-repository.js'
import { ProjectRepository } from '../sqlite/project-repository.js'
import { inTransaction } from '../sqlite/schema.js'
import { FileRoot, versionFileName } from './file-root.js'
import { systemClock, type Clock } from './project-service.js'

const MAX_NAME_LENGTH = 300
const MAX_PURPOSE_LENGTH = 200

/** Everything a caller needs to act on the result. */
export interface UploadResult {
  readonly material: Material
  readonly version: MaterialVersion
  /** True when this upload created a NEW material rather than a new version of one. */
  readonly created: boolean
  /** True only when identical current bytes reused an existing immutable version. */
  readonly deduplicated?: boolean
  /** Absolute path of the stored file, for the uploader's own confirmation. */
  readonly absolutePath: string
}

/** Runtime-owned evidence, never accepted from a model tool argument. */
export interface MaterialUploadAuthorization {
  readonly restore?: {
    readonly materialId: MaterialId
    readonly version: number
    readonly expectedLatestVersion: number
  }
}

export interface ParsedMaterialContent {
  readonly content: string | null
  readonly issue: string | null
  readonly warnings: readonly string[]
}

export class MaterialService {
  /** Trusted runtime-owned extraction reader; never accepted from a tool argument. */
  contentProvider?: (material: Material, version: MaterialVersion) => ParsedMaterialContent | undefined
  private readonly materials: MaterialRepository
  private readonly projects: ProjectRepository
  private readonly files: FileRoot

  constructor(
    private readonly db: DatabaseSync,
    fileRoot: string,
    private readonly clock: Clock = systemClock,
  ) {
    this.materials = new MaterialRepository(db)
    this.projects = new ProjectRepository(db)
    this.files = new FileRoot(fileRoot)
  }

  get root(): string {
    return this.files.root
  }

  /** Append changed content; reuse identical latest bytes, never overwrite history. */
  upload(
    input: UploadMaterialInput,
    commitMetadata?: (result: UploadResult) => void,
    authorization?: MaterialUploadAuthorization,
  ): UploadResult {
    this.requireWritableProject(input.projectId)
    const originalName = requireText(input.originalName ?? basename(input.sourcePath), 'original name', MAX_NAME_LENGTH)
    const purpose = requireText(input.purpose, 'purpose', MAX_PURPOSE_LENGTH)
    const submittedBy = requireText(input.submittedBy, 'submittedBy', MAX_NAME_LENGTH)
    const targetId = input.targetMaterialId === undefined ? undefined : requireText(input.targetMaterialId, 'target material', MAX_NAME_LENGTH)
    for (const [field, value] of [['expectedLatestVersion', input.expectedLatestVersion], ['restoreVersion', input.restoreVersion]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new CollaborationError('INVALID_ARGUMENT', `${field} must be a positive integer`, { field })
      }
    }
    let requestedRole: RoleId | null = null
    if (input.role !== undefined && input.role !== null) {
      if (!isRoleId(input.role)) throw new CollaborationError('ROLE_UNKNOWN', `unknown role "${input.role}"`, { role: input.role })
      requestedRole = input.role
    }
    const payload = this.readSource(input.sourcePath)
    let writtenPath: string | null = null
    try {
      return inTransaction(this.db, (): UploadResult => {
        // Resolve identity and latest inside the same write transaction as allocation.
        const project = this.requireWritableProject(input.projectId)
        const existing = targetId === undefined
          ? this.materials.findByIdentity(project.id, originalName, purpose)
          : this.requireMaterial(targetId)
        if (existing !== null && (existing.projectId !== project.id || existing.purpose !== purpose)) {
          throw new CollaborationError('MATERIAL_IDENTITY_CONFLICT', '所选资料不属于本次项目或用途，请确认目标。')
        }
        const materialId = existing?.id ?? newId()
        const versions = existing === null ? [] : this.materials.versionsOf(materialId)
        const latest = versions[versions.length - 1] ?? null
        const latestVersion = latest?.version ?? 0
        if (input.expectedLatestVersion !== undefined && input.expectedLatestVersion !== latestVersion) {
          throw new CollaborationError('VERSION_CONFLICT', '资料已出现不同版本，请核对后再决定本次更新。', { materialId, expectedLatestVersion: input.expectedLatestVersion, latestVersion })
        }
        const matches = (row: MaterialVersion) => payload.issue === null && row.issue === null && /^[a-f0-9]{64}$/.test(payload.sha256) && row.sha256 === payload.sha256 && row.size === payload.size
        if (existing !== null && latest !== null && matches(latest)) {
          const absolutePath = this.requireIntactOriginal(latest)
          const result: UploadResult = { material: existing, version: latest, created: false, absolutePath, deduplicated: true }
          // A new receipt still needs its own association. No old content/metadata changes.
          commitMetadata?.(result)
          return result
        }
        const historical = versions.find(matches)
        if (historical !== undefined) {
          const chosen = input.restoreVersion === undefined ? historical : versions.find(row => row.version === input.restoreVersion && matches(row))
          const trusted = authorization?.restore
          if (chosen === undefined || trusted === undefined || trusted.materialId !== materialId || trusted.version !== chosen.version || trusted.expectedLatestVersion !== latestVersion || input.expectedLatestVersion !== latestVersion || input.restoreVersion !== chosen.version) {
            throw new CollaborationError('MATERIAL_RESTORE_CONFIRMATION_REQUIRED', '本次内容与历史旧版相同。是否确实要将旧内容恢复为一个新版本？', { materialId, historicalVersion: chosen?.version ?? historical.version, latestVersion, originalName: existing?.originalName ?? originalName })
          }
        } else if (input.restoreVersion !== undefined || authorization?.restore !== undefined) {
          throw new CollaborationError('INVALID_ARGUMENT', '本次文件内容与指定历史版本不符，尚未恢复。')
        }
        const now = this.clock.now()
        const material: Material = existing ?? { id: materialId, projectId: project.id, originalName, purpose, submittedBy, role: requestedRole, createdAt: now }
        if (existing === null) this.materials.insertMaterial(material)
        const next = latestVersion + 1
        const dir = this.files.resolve(project.key, roleDirOf(material.role), 'materials', materialId)
        const target = this.files.resolve(project.key, roleDirOf(material.role), 'materials', materialId, versionFileName(next, material.originalName))
        mkdirSync(dir, { recursive: true })
        // Refuse an existing destination, including orphan files, rather than overwrite.
        copyFileSync(payload.path, target, constants.COPYFILE_EXCL)
        writtenPath = target
        if (payload.issue === null) {
          const stored = this.readSource(target)
          if (stored.issue !== null || stored.sha256 !== payload.sha256 || stored.size !== payload.size) {
            throw new CollaborationError('FILE_INTEGRITY_MISMATCH', '本次原件在保存过程中发生变化，尚未登记新版本。')
          }
        }
        const row: MaterialVersion = { materialId, version: next, relPath: this.files.relativeOf(target), size: payload.size, sha256: payload.sha256, issue: payload.issue, createdAt: now }
        this.materials.insertVersion(row)
        const result: UploadResult = { material, version: row, created: existing === null, absolutePath: target }
        commitMetadata?.(result)
        return result
      })
    } catch (error) {
      if (writtenPath !== null) {
        try { unlinkSync(writtenPath) } catch { /* The failed transaction retains no row. */ }
      }
      throw error
    }
  }

  private requireIntactOriginal(version: MaterialVersion): string {
    const path = this.absolutePathOf(version.relPath)
    try {
      const stat = lstatSync(path)
      const actual = realpathSync(path)
      const within = relative(realpathSync(this.files.root), actual)
      if (!stat.isFile() || stat.isSymbolicLink() || within === '' || within.startsWith('..') || isAbsolute(within)) throw new Error('unsafe stored original')
      const bytes = readFileSync(actual)
      if (bytes.byteLength !== version.size || createHash('sha256').update(bytes).digest('hex') !== version.sha256) throw new Error('stored original mismatch')
      return path
    } catch {
      throw new CollaborationError('FILE_INTEGRITY_MISMATCH', '已有资料原件缺失或校验失败，请先核对原件。', { materialId: version.materialId, version: version.version })
    }
  }

  getWithVersions(materialId: MaterialId): MaterialWithVersions {
    const material = this.requireMaterial(materialId)
    const versions = this.materials.versionsOf(materialId)
    return {
      ...material,
      versions,
      latestVersion: versions.length === 0 ? 0 : (versions[versions.length - 1]?.version ?? 0),
    }
  }

  listByProject(projectId: ProjectId): readonly MaterialWithVersions[] {
    return this.materials.listByProject(projectId).map((m) => this.getWithVersions(m.id))
  }

  /**
   * Resolve a fixed reference (MVP-009).
   *
   * A reference names ONE version and this never falls back to the latest — silently
   * substituting a newer version is exactly the failure this rule exists to prevent.
   */
  resolveReference(reference: MaterialReference): { material: Material; version: MaterialVersion } {
    const material = this.requireMaterial(reference.materialId)
    const version = this.materials.findVersion(reference.materialId, reference.version)
    if (version === null) {
      throw new CollaborationError(
        'VERSION_NOT_FOUND',
        `material "${material.originalName}" has no version ${reference.version}`,
        { materialId: reference.materialId, version: reference.version },
      )
    }
    return { material, version }
  }

  /**
   * Read one version's bytes (MVP-008).
   *
   * MVP-011: when the file cannot be read, say WHY and keep the original retrievable —
   * never report an unreadable material as empty content.
   */
  read(reference: MaterialReference): {
    material: Material
    version: MaterialVersion
    absolutePath: string
    content: string | null
    issue: string | null
    warnings?: readonly string[]
  } {
    const { material, version } = this.resolveReference(reference)
    const absolutePath = this.absolutePathOf(version.relPath)

    if (!existsSync(absolutePath)) {
      return {
        material,
        version,
        absolutePath,
        content: null,
        issue: `stored file is missing at ${version.relPath}`,
      }
    }

    try {
      const parsed = this.contentProvider?.(material, version)
      if (parsed !== undefined) return { material, version, absolutePath, ...parsed }
      const buf = readFileSync(absolutePath)
      if (/\.(docx|png|jpe?g|webp|gif)$/i.test(material.originalName)) {
        return { material, version, absolutePath, content: null, issue: 'No trusted parsed text for this binary material; do not decode as UTF-8' }
      }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      return { material, version, absolutePath, content, issue: null }
    } catch (error) {
      return {
        material,
        version,
        absolutePath,
        content: null,
        issue: `stored file could not be read: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  absolutePathOf(relPath: string): string {
    // relPath came from us, but re-validate anyway: a corrupted row must not become a
    // read outside the root.
    return this.files.resolve(...relPath.split('/'))
  }

  /**
   * Read the source file before any store mutation.
   *
   * A file that cannot be read is still accepted IF it exists — the version is recorded
   * with an `issue`, so the failed read is visible rather than hidden as empty content
   * (MVP-011). A file that does not exist at all is refused outright.
   */
  private readSource(sourcePath: string): { path: string; size: number; sha256: string; issue: string | null } {
    const path = resolve(sourcePath)

    if (!existsSync(path)) {
      throw new CollaborationError('SOURCE_NOT_FOUND', `source file does not exist: ${path}`, { path })
    }

    let stat
    try {
      stat = statSync(path)
    } catch (error) {
      throw new CollaborationError(
        'SOURCE_NOT_FOUND',
        `source file could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        { path },
      )
    }

    if (!stat.isFile()) {
      throw new CollaborationError('SOURCE_NOT_A_FILE', `source is not a regular file: ${path}`, { path })
    }

    try {
      const buf = readFileSync(path)
      return {
        path,
        size: buf.byteLength,
        sha256: createHash('sha256').update(buf).digest('hex'),
        issue: null,
      }
    } catch (error) {
      // Keep the original: record the failure, do not pretend the file was empty.
      return {
        path,
        size: stat.size,
        sha256: '',
        issue: `could not read source: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  private requireMaterial(materialId: MaterialId): Material {
    const material = this.materials.findById(materialId)
    if (material === null) {
      throw new CollaborationError('MATERIAL_NOT_FOUND', `no material with id ${materialId}`, {
        materialId,
      })
    }
    return material
  }

  private requireWritableProject(projectId: ProjectId) {
    // Delegates to the shared gate so "archived is read-only" has exactly ONE definition.
    return assertWritable(this.projects.findById(projectId), projectId)
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
