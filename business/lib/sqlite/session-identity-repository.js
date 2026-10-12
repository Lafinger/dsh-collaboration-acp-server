function toIdentity(row) {
    return {
        sessionId: row.session_id,
        member: row.member_label,
        declaredAt: row.declared_at,
        updatedAt: row.updated_at,
    };
}
export class SessionIdentityRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    /**
     * Declare, or re-declare, who this session is.
     *
     * An upsert rather than insert-or-fail: correcting a mistyped name is a normal thing to do,
     * and `declared_at` is preserved so the correction is visible afterwards.
     */
    declare(sessionId, member, at) {
        this.db
            .prepare(`INSERT INTO session_members (session_id, member_label, declared_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           member_label = excluded.member_label,
           updated_at   = excluded.updated_at`)
            .run(sessionId, member, at, at);
    }
    find(sessionId) {
        const row = this.db
            .prepare('SELECT * FROM session_members WHERE session_id = ?')
            .get(sessionId);
        return row === undefined ? null : toIdentity(row);
    }
}
