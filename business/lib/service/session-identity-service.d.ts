/**
 * Session identity business rules (ADR-0002: rules live in service, not in SQL).
 *
 * ADR-0014: this service answers ONE question — "who is speaking in this session" — and
 * deliberately knows nothing about which role owns which slot. Keeping the two apart is what
 * stops the model from turning circular ("I declare myself pm, therefore I am pm's member").
 *
 * Why a session rather than every call: the client's identity cannot be taken from the ACP
 * connection (DSH does not read `clientInfo`), so it has to be stated in-band. Stating it once
 * per session is the least intrusive form that still makes the statement checkable.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MemberLabel, SessionIdentity } from '../domain/roles.js';
import type { Clock } from './project-service.js';
export declare class SessionIdentityService {
    private readonly clock;
    private readonly identities;
    constructor(db: DatabaseSync, clock?: Clock);
    /**
     * Declare, or correct, who this session is.
     *
     * Re-declaring is allowed and overwrites: fixing a mistyped name is ordinary, and the
     * correction only affects FUTURE records. It never rewrites a past confirmation, because
     * those stored their own `submitted_by` snapshot (ADR-0010).
     */
    declare(input: {
        readonly sessionId: string;
        readonly member: string;
    }): SessionIdentity;
    /** Who this session is, or null when it has not said. */
    current(sessionId: string): MemberLabel | null;
    /** The full declaration, including when it was first made. */
    find(sessionId: string): SessionIdentity | null;
}
