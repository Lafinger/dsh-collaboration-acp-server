/**
 * Result persistence (M5 result layer, ADR-0010).
 *
 * All three tables hang off a task version. Reads and writes only (ADR-0002); every write
 * happens inside the caller's transaction.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { RoleId } from '../domain/roles.js'
import type {
  Acceptance,
  AcceptanceOutcome,
  ProgressEntry,
  ResultConfirmation,
  ResultFile,
  ResultId,
  ResultVersion,
  ResultVersionRecord,
  ReviewOutcome,
} from '../domain/result.js'
import type { TaskId, TaskVersion } from '../domain/task.js'

interface VersionRow {
  readonly result_id: string
  readonly version: number
  readonly task_id: string
  readonly task_version: number
  readonly summary: string
  readonly self_check: string
  readonly submitted_by: string
  readonly created_at: string
}

export class ResultRepository {
  constructor(private readonly db: DatabaseSync) {}

  // ---- progress -------------------------------------------------------------

  insertProgress(entry: ProgressEntry): void {
    this.db
      .prepare(
        `INSERT INTO progress (id, task_id, task_version, note, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.taskId,
        entry.taskVersion,
        entry.note,
        entry.submittedBy,
        entry.createdAt,
      )
  }

  progressOf(taskId: TaskId): readonly ProgressEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM progress WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(taskId) as unknown as {
        id: string
        task_id: string
        task_version: number
        note: string
        submitted_by: string
        created_at: string
      }[]
    ).map((r) => ({
      id: r.id,
      taskId: r.task_id,
      taskVersion: Number(r.task_version),
      note: r.note,
      submittedBy: r.submitted_by,
      createdAt: r.created_at,
    }))
  }

  // ---- results --------------------------------------------------------------

  /** Highest existing version for a task's result, or 0 when it has none. */
  latestResultVersion(taskId: TaskId): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM result_versions WHERE task_id = ?')
      .get(taskId) as unknown as { v: number | null } | undefined
    return row?.v === null || row?.v === undefined ? 0 : Number(row.v)
  }

  insertResult(record: ResultVersionRecord): void {
    this.db
      .prepare(
        `INSERT INTO result_versions
           (result_id, version, task_id, task_version, summary, self_check, submitted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.resultId,
        record.version,
        record.taskId,
        record.taskVersion,
        record.summary,
        record.selfCheck,
        record.submittedBy,
        record.createdAt,
      )

    const file = this.db.prepare(
      `INSERT INTO result_files (result_id, version, position, rel_path, original_name, sha256, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    record.files.forEach((f, i) => {
      file.run(record.resultId, record.version, i, f.relPath, f.originalName, f.sha256, f.sizeBytes)
    })
  }

  /** An open confirmation slot for a freshly submitted result. */
  createConfirmationSlot(
    resultId: ResultId,
    version: ResultVersion,
    role: RoleId,
  ): void {
    this.db
      .prepare(
        `INSERT INTO result_confirmations (result_id, version, role, outcome, reason, submitted_by, decided_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(resultId, version, role)
  }

  recordReview(
    resultId: ResultId,
    version: ResultVersion,
    outcome: ReviewOutcome,
    reason: string | null,
    submittedBy: string,
    at: string,
  ): void {
    this.db
      .prepare(
        `UPDATE result_confirmations
            SET outcome = ?, reason = ?, submitted_by = ?, decided_at = ?
          WHERE result_id = ? AND version = ?`,
      )
      .run(outcome, reason, submittedBy, at, resultId, version)
  }

  confirmationOf(resultId: ResultId, version: ResultVersion): ResultConfirmation | null {
    const row = this.db
      .prepare('SELECT * FROM result_confirmations WHERE result_id = ? AND version = ?')
      .get(resultId, version) as unknown as
      | {
          result_id: string
          version: number
          role: string
          outcome: string | null
          reason: string | null
          submitted_by: string | null
          decided_at: string | null
        }
      | undefined
    if (row === undefined) return null
    return {
      id: `${row.result_id}:${row.version}`,
      resultId: row.result_id,
      resultVersion: Number(row.version),
      role: row.role as RoleId,
      outcome: (row.outcome as ReviewOutcome | null) ?? null,
      reason: row.reason,
      submittedBy: row.submitted_by,
      decidedAt: row.decided_at,
    }
  }

  findResultVersion(resultId: ResultId, version: ResultVersion): ResultVersionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM result_versions WHERE result_id = ? AND version = ?')
      .get(resultId, version) as unknown as VersionRow | undefined
    return row === undefined ? null : this.hydrate(row)
  }

  /**
   * Every result version of a task, oldest first.
   *
   * A returned submission is still here: it is the basis for the correction, so discarding
   * it would destroy the record of what was rejected.
   */
  resultsOf(taskId: TaskId): readonly ResultVersionRecord[] {
    return (
      this.db
        .prepare('SELECT * FROM result_versions WHERE task_id = ? ORDER BY version ASC')
        .all(taskId) as unknown as VersionRow[]
    ).map((r) => this.hydrate(r))
  }

  // ---- acceptance -----------------------------------------------------------

  createAcceptanceSlot(resultId: ResultId, version: ResultVersion, taskId: TaskId): void {
    this.db
      .prepare(
        `INSERT INTO acceptances (result_id, version, task_id, outcome, reason, submitted_by, decided_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(resultId, version, taskId)
  }

  recordAcceptance(
    resultId: ResultId,
    version: ResultVersion,
    taskId: TaskId,
    outcome: AcceptanceOutcome,
    reason: string | null,
    submittedBy: string,
    at: string,
    /**
     * The versions this decision pins down (ADR-0012). Recorded HERE, at decision time,
     * rather than when the slot opened: a revision in between would otherwise make the
     * record describe a definition that was never used.
     *
     * A REJECTION records them too, which keeps "refused" distinguishable from "never
     * decided" — traceability needs that difference.
     */
    acceptedTaskVersion: TaskVersion,
    acceptedResultTaskVersion: TaskVersion,
  ): void {
    this.db
      .prepare(
        `UPDATE acceptances
            SET outcome = ?, reason = ?, submitted_by = ?, decided_at = ?,
                accepted_task_version = ?, accepted_result_task_version = ?
          WHERE result_id = ? AND version = ? AND task_id = ?`,
      )
      .run(
        outcome,
        reason,
        submittedBy,
        at,
        acceptedTaskVersion,
        acceptedResultTaskVersion,
        resultId,
        version,
        taskId,
      )
  }

  /**
   * The task that owns a result id, or null when no such result exists.
   *
   * A result id is minted per submission, so its owner is a lookup rather than something
   * encoded in the id.
   */
  ownerOf(resultId: ResultId): TaskId | null {
    const row = this.db
      .prepare('SELECT task_id FROM result_versions WHERE result_id = ? LIMIT 1')
      .get(resultId) as unknown as { task_id: string } | undefined
    return row?.task_id ?? null
  }

  acceptancesOf(resultId: ResultId, version: ResultVersion): readonly Acceptance[] {    return this.hydrateAcceptances(
      'SELECT * FROM acceptances WHERE result_id = ? AND version = ? ORDER BY task_id',
      [resultId, version],
    )
  }

  /** Every acceptance decision made BY a task, so a task can see what it decided. */
  acceptancesByTask(taskId: TaskId): readonly Acceptance[] {
    return this.hydrateAcceptances(
      'SELECT * FROM acceptances WHERE task_id = ? ORDER BY result_id, version',
      [taskId],
    )
  }

  /**
   * One hydrator, so the two acceptance readers cannot drift apart.
   *
   * They were separate copies until M7 added two columns; had they stayed separate, adding a
   * field to one and not the other would have produced two subtly different objects for the
   * same row.
   */
  private hydrateAcceptances(sql: string, params: readonly (string | number)[]): readonly Acceptance[] {
    return (
      this.db.prepare(sql).all(...params) as unknown as {
        result_id: string
        version: number
        task_id: string
        outcome: string | null
        reason: string | null
        submitted_by: string | null
        decided_at: string | null
        accepted_task_version: number | null
        accepted_result_task_version: number | null
      }[]
    ).map((r) => ({
      id: `${r.result_id}:${r.version}:${r.task_id}`,
      resultId: r.result_id,
      resultVersion: Number(r.version),
      taskId: r.task_id,
      acceptedTaskVersion:
        r.accepted_task_version === null ? null : Number(r.accepted_task_version),
      acceptedResultTaskVersion:
        r.accepted_result_task_version === null ? null : Number(r.accepted_result_task_version),
      outcome: (r.outcome as AcceptanceOutcome | null) ?? null,
      reason: r.reason,
      submittedBy: r.submitted_by,
      decidedAt: r.decided_at,
    }))
  }

  private hydrate(row: VersionRow): ResultVersionRecord {
    return {
      resultId: row.result_id,
      version: Number(row.version),
      taskId: row.task_id,
      taskVersion: Number(row.task_version),
      summary: row.summary,
      selfCheck: row.self_check,
      files: this.filesOf(row.result_id, Number(row.version)),
      submittedBy: row.submitted_by,
      createdAt: row.created_at,
    }
  }

  private filesOf(resultId: ResultId, version: ResultVersion): readonly ResultFile[] {
    return (
      this.db
        .prepare('SELECT * FROM result_files WHERE result_id = ? AND version = ? ORDER BY position')
        .all(resultId, version) as unknown as {
        rel_path: string
        original_name: string
        sha256: string
        size_bytes: number
      }[]
    ).map((r) => ({
      relPath: r.rel_path,
      originalName: r.original_name,
      sha256: r.sha256,
      sizeBytes: Number(r.size_bytes),
    }))
  }
}

export type { TaskId, TaskVersion }
