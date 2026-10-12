/**
 * Session identity persistence. No business judgement here — this layer only reads and writes
 * (ADR-0002).
 *
 * One row per session: a session speaks as exactly one member (ADR-0014). Re-declaring updates
 * the row in place and keeps `declared_at`, so "when did this session first say who it was"
 * survives a correction while "what does it say now" stays authoritative.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MemberLabel, SessionIdentity } from '../domain/roles.js'

interface IdentityRow {
  readonly session_id: string
  readonly member_label: string
  readonly declared_at: string
  readonly updated_at: string
}

function toIdentity(row: IdentityRow): SessionIdentity {
  return {
    sessionId: row.session_id,
    member: row.member_label,
    declaredAt: row.declared_at,
    updatedAt: row.updated_at,
  }
}

export class SessionIdentityRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Declare, or re-declare, who this session is.
   *
   * An upsert rather than insert-or-fail: correcting a mistyped name is a normal thing to do,
   * and `declared_at` is preserved so the correction is visible afterwards.
   */
  declare(sessionId: string, member: MemberLabel, at: string): void {
    this.db
      .prepare(
        `INSERT INTO session_members (session_id, member_label, declared_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           member_label = excluded.member_label,
           updated_at   = excluded.updated_at`,
      )
      .run(sessionId, member, at, at)
  }

  find(sessionId: string): SessionIdentity | null {
    const row = this.db
      .prepare('SELECT * FROM session_members WHERE session_id = ?')
      .get(sessionId) as unknown as IdentityRow | undefined
    return row === undefined ? null : toIdentity(row)
  }
}
