/**
 * Analysis persistence. Reads and writes only (ADR-0002).
 *
 * Writes always happen as a unit: an analysis is inserted together with its scope, reads
 * and three content kinds, inside one transaction. There is no partial analysis.
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  Analysis,
  AnalysisId,
  Inference,
  ReadRecord,
  Requirement,
  ScopeEntry,
  Trigger,
  Uncovered,
  UncoveredReason,
  Undecided,
} from '../domain/analysis.js'
import type { ProjectId } from '../domain/project.js'

interface AnalysisRow {
  readonly id: string
  readonly project_id: string
  readonly trigger: string
  readonly created_at: string
}

interface TextRow {
  readonly position: number
  readonly text: string
}

interface SourceRow {
  readonly position: number
  readonly material_id: string
  readonly version: number
}

interface UncoveredRow {
  readonly position: number
  readonly text: string
  readonly reason: string
  readonly material_id: string | null
  readonly version: number | null
}

export class AnalysisRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(analysis: Analysis): void {
    this.db
      .prepare('INSERT INTO analyses (id, project_id, trigger, created_at) VALUES (?, ?, ?, ?)')
      .run(analysis.id, analysis.projectId, analysis.trigger, analysis.createdAt)

    const scope = this.db.prepare(
      'INSERT INTO analysis_scope (analysis_id, material_id, version, position) VALUES (?, ?, ?, ?)',
    )
    analysis.scope.forEach((entry, index) => scope.run(analysis.id, entry.materialId, entry.version, index))

    const read = this.db.prepare(
      `INSERT INTO analysis_reads
         (analysis_id, material_id, version, original_name, sha256, size, ok, reason, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const r of analysis.reads) {
      read.run(
        analysis.id,
        r.entry.materialId,
        r.entry.version,
        r.originalName,
        r.sha256,
        r.size,
        r.ok ? 1 : 0,
        r.reason,
        r.readAt,
      )
    }

    const requirement = this.db.prepare(
      'INSERT INTO analysis_requirements (analysis_id, position, text) VALUES (?, ?, ?)',
    )
    const source = this.db.prepare(
      `INSERT INTO analysis_requirement_sources (analysis_id, position, material_id, version)
       VALUES (?, ?, ?, ?)`,
    )
    analysis.requirements.forEach((req, index) => {
      requirement.run(analysis.id, index, req.text)
      for (const s of req.sources) source.run(analysis.id, index, s.materialId, s.version)
    })

    const undecided = this.db.prepare(
      'INSERT INTO analysis_undecided (analysis_id, position, text) VALUES (?, ?, ?)',
    )
    analysis.undecided.forEach((text, index) => undecided.run(analysis.id, index, text))

    const inference = this.db.prepare(
      'INSERT INTO analysis_inferences (analysis_id, position, text) VALUES (?, ?, ?)',
    )
    analysis.inferences.forEach((text, index) => inference.run(analysis.id, index, text))

    const uncovered = this.db.prepare(
      `INSERT INTO analysis_uncovered (analysis_id, position, text, reason, material_id, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    analysis.uncovered.forEach((u, index) =>
      uncovered.run(analysis.id, index, u.text, u.reason, u.entry?.materialId ?? null, u.entry?.version ?? null),
    )
  }

  findById(id: AnalysisId): Analysis | null {
    const row = this.db.prepare('SELECT * FROM analyses WHERE id = ?').get(id) as unknown as
      | AnalysisRow
      | undefined
    return row === undefined ? null : this.hydrate(row)
  }

  listByProject(projectId: ProjectId): readonly Analysis[] {
    const rows = this.db
      .prepare('SELECT * FROM analyses WHERE project_id = ? ORDER BY created_at ASC, id ASC')
      .all(projectId) as unknown as AnalysisRow[]
    return rows.map((r) => this.hydrate(r))
  }

  private hydrate(row: AnalysisRow): Analysis {
    const id = row.id

    const scope = (
      this.db
        .prepare('SELECT material_id, version FROM analysis_scope WHERE analysis_id = ? ORDER BY position')
        .all(id) as unknown as { material_id: string; version: number }[]
    ).map((r) => ({ materialId: r.material_id, version: Number(r.version) }))

    const reads: ReadRecord[] = (
      this.db
        .prepare('SELECT * FROM analysis_reads WHERE analysis_id = ? ORDER BY material_id, version')
        .all(id) as unknown as {
        material_id: string
        version: number
        original_name: string | null
        sha256: string | null
        size: number | null
        ok: number
        reason: string | null
        read_at: string
      }[]
    ).map((r) => ({
      entry: { materialId: r.material_id, version: Number(r.version) },
      originalName: r.original_name,
      sha256: r.sha256,
      size: r.size === null ? null : Number(r.size),
      ok: Number(r.ok) === 1,
      reason: (r.reason as UncoveredReason | null) ?? null,
      readAt: r.read_at,
    }))

    const sourcesByPosition = new Map<number, ScopeEntry[]>()
    for (const s of this.db
      .prepare('SELECT position, material_id, version FROM analysis_requirement_sources WHERE analysis_id = ?')
      .all(id) as unknown as SourceRow[]) {
      const list = sourcesByPosition.get(Number(s.position)) ?? []
      list.push({ materialId: s.material_id, version: Number(s.version) })
      sourcesByPosition.set(Number(s.position), list)
    }

    const requirements: Requirement[] = (
      this.db
        .prepare('SELECT position, text FROM analysis_requirements WHERE analysis_id = ? ORDER BY position')
        .all(id) as unknown as TextRow[]
    ).map((r) => ({ text: r.text, sources: sourcesByPosition.get(Number(r.position)) ?? [] }))

    const texts = (table: string): Undecided[] | Inference[] =>
      (
        this.db
          .prepare(`SELECT position, text FROM ${table} WHERE analysis_id = ? ORDER BY position`)
          .all(id) as unknown as TextRow[]
      ).map((r) => r.text)

    const uncovered: Uncovered[] = (
      this.db
        .prepare('SELECT * FROM analysis_uncovered WHERE analysis_id = ? ORDER BY position')
        .all(id) as unknown as UncoveredRow[]
    ).map((r) => ({
      text: r.text,
      reason: r.reason as UncoveredReason,
      entry:
        r.material_id === null || r.version === null
          ? null
          : { materialId: r.material_id, version: Number(r.version) },
    }))

    return {
      id,
      projectId: row.project_id,
      trigger: row.trigger as Trigger,
      scope,
      reads,
      requirements,
      undecided: texts('analysis_undecided') as Undecided[],
      inferences: texts('analysis_inferences') as Inference[],
      uncovered,
      createdAt: row.created_at,
    }
  }
}
