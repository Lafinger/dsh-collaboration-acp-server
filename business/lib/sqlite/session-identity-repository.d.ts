/**
 * Session identity persistence. No business judgement here — this layer only reads and writes
 * (ADR-0002).
 *
 * One row per session: a session speaks as exactly one member (ADR-0014). Re-declaring updates
 * the row in place and keeps `declared_at`, so "when did this session first say who it was"
 * survives a correction while "what does it say now" stays authoritative.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemberLabel, SessionIdentity } from '../domain/roles.js';
export declare class SessionIdentityRepository {
    private readonly db;
    constructor(db: DatabaseSync);
    /**
     * Declare, or re-declare, who this session is.
     *
     * An upsert rather than insert-or-fail: correcting a mistyped name is a normal thing to do,
     * and `declared_at` is preserved so the correction is visible afterwards.
     */
    declare(sessionId: string, member: MemberLabel, at: string): void;
    find(sessionId: string): SessionIdentity | null;
}
