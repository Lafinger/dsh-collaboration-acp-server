/**
 * Notice storage (M6, ADR-0011).
 *
 * Only READ state is stored. Todos and notices are derived by querying the slot tables that
 * are already the authority, so there is no second copy to keep in sync.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { SlotRef } from '../domain/notice.js'
import { slotKey } from '../domain/notice.js'

interface SlotRow {
  readonly kind: string
  readonly project_id: string
  readonly object_id: string
  readonly version: number
  readonly role: string
  readonly task_id: string | null
  readonly summary: string
  readonly detail: string | null
  readonly created_at: string
}

export class NoticeRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Every UNDECIDED slot in a project, as todos.
   *
   * The three branches are unioned because they are three different tables with a common
   * shape: something is waiting for a role to decide. A LEFT JOIN on `reads` marks the ones
   * already looked at.
   *
   * `voided_at IS NULL` is load-bearing for plan confirmations: a revision VOIDS slots
   * rather than deleting them, and a voided slot is not awaiting anyone.
   */
  pendingTodos(projectId: string): readonly SlotRow[] {
    return this.db
      .prepare(
        `
        SELECT 'plan_confirmation' AS kind,
               p.project_id        AS project_id,
               c.plan_id           AS object_id,
               c.plan_version      AS version,
               c.role              AS role,
               NULL                AS task_id,
               p.title             AS summary,
               NULL                AS detail,
               p.created_at        AS created_at
          FROM confirmations c
          JOIN plans p ON p.id = c.plan_id AND p.version = c.plan_version
         WHERE p.project_id = ?
           AND c.outcome IS NULL
           AND c.voided_at IS NULL
           AND p.activated_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM plan_suspensions s WHERE s.plan_id=p.id AND s.plan_version=p.version)

        UNION ALL

        SELECT 'result_review'         AS kind,
               t.project_id            AS project_id,
               rc.result_id            AS object_id,
               rc.version              AS version,
               rc.role                 AS role,
               t.id                    AS task_id,
               rv.summary              AS summary,
               NULL                    AS detail,
               rv.created_at           AS created_at
          FROM result_confirmations rc
          JOIN result_versions rv
            ON rv.result_id = rc.result_id AND rv.version = rc.version
          JOIN tasks t ON t.id = rv.task_id
         WHERE t.project_id = ?
           AND rc.outcome IS NULL

        UNION ALL

        SELECT 'result_acceptance'     AS kind,
               t.project_id            AS project_id,
               a.result_id             AS object_id,
               a.version               AS version,
               t.role                  AS role,
               a.task_id               AS task_id,
               rv.summary              AS summary,
               NULL                    AS detail,
               rv.created_at           AS created_at
          FROM acceptances a
          JOIN result_versions rv
            ON rv.result_id = a.result_id AND rv.version = a.version
          JOIN tasks t ON t.id = a.task_id
         WHERE t.project_id = ?
           AND a.outcome IS NULL
        `,
      )
      .all(projectId, projectId, projectId) as unknown as SlotRow[]
  }

  /**
   * Notices: things that already happened and need no decision.
   *
   * Only two exist in the MVP, both derived:
   *   - a result was completed (the task's own role has nothing left to do)
   *   - a result was rejected (informational; rejection triggers NOTHING else, MVP-027)
   *
   * The rejection notice is addressed to the UPSTREAM task — the one whose result was turned
   * down — because MVP-027 says the notice goes to "上游任务的主执行人": the point is to tell
   * the producer their work was refused. Addressing it to `a.task_id` (the DECIDING task) sent
   * the notice back to the very role that made the decision, who learns nothing from it.
   * `rv.task_id` is the task that PRODUCED the result under review.
   */
  notices(projectId: string): readonly SlotRow[] {
    return this.db
      .prepare(
        `
        SELECT 'result_rejected'        AS kind,
               t.project_id             AS project_id,
               a.result_id              AS object_id,
               a.version                AS version,
               t.role                   AS role,
               rv.task_id               AS task_id,
               rv.summary               AS summary,
               a.reason                 AS detail,
               COALESCE(a.decided_at, rv.created_at) AS created_at
          FROM acceptances a
          JOIN result_versions rv
            ON rv.result_id = a.result_id AND rv.version = a.version
          JOIN tasks t ON t.id = rv.task_id
         WHERE t.project_id = ?
           AND a.outcome = 'reject'

        UNION ALL

        SELECT 'task_completed'         AS kind,
               t.project_id             AS project_id,
               rv.result_id             AS object_id,
               rv.version               AS version,
               t.role                   AS role,
               t.id                     AS task_id,
               rv.summary               AS summary,
               NULL                     AS detail,
               COALESCE(rc.decided_at, rv.created_at) AS created_at
          FROM result_confirmations rc
          JOIN result_versions rv
            ON rv.result_id = rc.result_id AND rv.version = rc.version
          JOIN tasks t ON t.id = rv.task_id
         WHERE t.project_id = ?
           AND rc.outcome = 'complete'
        `,
      )
      .all(projectId, projectId) as unknown as SlotRow[]
  }

  /** Which of these slot keys the given role has already read. */
  readKeys(keys: readonly string[]): ReadonlySet<string> {
    if (keys.length === 0) return new Set()
    const placeholders = keys.map(() => '(?, ?, ?, ?, ?)').join(',')
    const params: string[] = []
    for (const key of keys) {
      const [kind, objectId, version, role, taskId] = key.split(':')
      params.push(kind ?? '', objectId ?? '', version ?? '0', role ?? '', taskId ?? '')
    }
    const rows = this.db
      .prepare(
        `SELECT kind, object_id, version, role, task_id FROM reads
          WHERE (kind, object_id, version, role, task_id) IN (${placeholders})`,
      )
      .all(...params) as unknown as {
      kind: string
      object_id: string
      version: number
      role: string
      task_id: string
    }[]
    return new Set(
      rows.map((r) => [r.kind, r.object_id, r.version, r.role, r.task_id].join(':')),
    )
  }

  /**
   * Record a read.
   *
   * `INSERT OR IGNORE` is what makes "reading twice does not count twice" true: it is the
   * primary key doing the work, not counting logic that could drift.
   */
  markRead(ref: SlotRef, at: string, readBy: string | null): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO reads (kind, object_id, version, role, task_id, read_at, read_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ref.kind, ref.objectId, ref.version, ref.role, ref.taskId ?? '', at, readBy)
    return result.changes > 0
  }

  isRead(ref: SlotRef): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM reads
          WHERE kind = ? AND object_id = ? AND version = ? AND role = ? AND task_id = ?`,
      )
      .get(ref.kind, ref.objectId, ref.version, ref.role, ref.taskId ?? '') as unknown as
      | { x: number }
      | undefined
    return row !== undefined
  }

  /**
   * Whether the addressed slot exists AT ALL — pending, decided or voided.
   *
   * This asks the SLOT TABLES, not the derived todo lists. A decided slot is still a real
   * record, so reading it is legitimate even though it is no longer work to do: "does this
   * exist" and "is this still a todo" are different questions.
   */
  slotExists(ref: SlotRef): boolean {
    if (ref.kind === 'plan_confirmation') {
      return this.rowExists(
        'SELECT 1 AS x FROM confirmations WHERE plan_id = ? AND plan_version = ? AND role = ?',
        [ref.objectId, ref.version, ref.role],
      )
    }
    if (ref.kind === 'result_review') {
      return this.rowExists(
        'SELECT 1 AS x FROM result_confirmations WHERE result_id = ? AND version = ?',
        [ref.objectId, ref.version],
      )
    }
    if (ref.kind === 'result_acceptance') {
      return this.rowExists(
        'SELECT 1 AS x FROM acceptances WHERE result_id = ? AND version = ? AND task_id = ?',
        [ref.objectId, ref.version, ref.taskId ?? ''],
      )
    }
    // Notices describe events rather than slots, so a matching result version is the address.
    return this.rowExists(
      'SELECT 1 AS x FROM result_versions WHERE result_id = ? AND version = ?',
      [ref.objectId, ref.version],
    )
  }

  private rowExists(sql: string, params: readonly (string | number)[]): boolean {
    const row = this.db.prepare(sql).get(...params) as unknown as { x: number } | undefined
    return row !== undefined
  }
}

export type { SlotRow }
export { slotKey }
