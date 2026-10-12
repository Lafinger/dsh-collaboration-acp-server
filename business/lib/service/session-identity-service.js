import { WorkbenchError } from '../domain/error.js';
import { SessionIdentityRepository } from '../sqlite/session-identity-repository.js';
import { systemClock } from './project-service.js';
const MAX_MEMBER_LENGTH = 200;
export class SessionIdentityService {
    clock;
    identities;
    constructor(db, clock = systemClock) {
        this.clock = clock;
        this.identities = new SessionIdentityRepository(db);
    }
    /**
     * Declare, or correct, who this session is.
     *
     * Re-declaring is allowed and overwrites: fixing a mistyped name is ordinary, and the
     * correction only affects FUTURE records. It never rewrites a past confirmation, because
     * those stored their own `submitted_by` snapshot (ADR-0010).
     */
    declare(input) {
        const sessionId = requireText(input.sessionId, 'session_id', MAX_MEMBER_LENGTH);
        const member = requireText(input.member, 'member', MAX_MEMBER_LENGTH);
        this.identities.declare(sessionId, member, this.clock.now());
        const stored = this.identities.find(sessionId);
        if (stored === null) {
            // Unreachable unless the write silently failed; reported rather than assumed away.
            throw new WorkbenchError('INTERNAL', 'identity declaration did not persist', { sessionId });
        }
        return stored;
    }
    /** Who this session is, or null when it has not said. */
    current(sessionId) {
        return this.identities.find(sessionId)?.member ?? null;
    }
    /** The full declaration, including when it was first made. */
    find(sessionId) {
        return this.identities.find(sessionId);
    }
}
function requireText(value, field, max) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new WorkbenchError('INVALID_ARGUMENT', `${field} is required`, { field });
    }
    const trimmed = value.trim();
    if (trimmed.length > max) {
        throw new WorkbenchError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field });
    }
    return trimmed;
}
