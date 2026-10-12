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
import type { DatabaseSync } from 'node:sqlite'
import { WorkbenchError } from '../domain/error.js'
import type { MemberLabel, SessionIdentity } from '../domain/roles.js'
import { SessionIdentityRepository } from '../sqlite/session-identity-repository.js'
import type { Clock } from './project-service.js'
import { systemClock } from './project-service.js'

const MAX_MEMBER_LENGTH = 200

export class SessionIdentityService {
  private readonly identities: SessionIdentityRepository

  constructor(
    db: DatabaseSync,
    private readonly clock: Clock = systemClock,
  ) {
    this.identities = new SessionIdentityRepository(db)
  }

  /**
   * Declare, or correct, who this session is.
   *
   * Re-declaring is allowed and overwrites: fixing a mistyped name is ordinary, and the
   * correction only affects FUTURE records. It never rewrites a past confirmation, because
   * those stored their own `submitted_by` snapshot (ADR-0010).
   */
  declare(input: { readonly sessionId: string; readonly member: string }): SessionIdentity {
    const sessionId = requireText(input.sessionId, 'session_id', MAX_MEMBER_LENGTH)
    const member = requireText(input.member, 'member', MAX_MEMBER_LENGTH)
    this.identities.declare(sessionId, member, this.clock.now())
    const stored = this.identities.find(sessionId)
    if (stored === null) {
      // Unreachable unless the write silently failed; reported rather than assumed away.
      throw new WorkbenchError('INTERNAL', 'identity declaration did not persist', { sessionId })
    }
    return stored
  }

  /** Who this session is, or null when it has not said. */
  current(sessionId: string): MemberLabel | null {
    return this.identities.find(sessionId)?.member ?? null
  }

  /** The full declaration, including when it was first made. */
  find(sessionId: string): SessionIdentity | null {
    return this.identities.find(sessionId)
  }
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkbenchError('INVALID_ARGUMENT', `${field} is required`, { field })
  }
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new WorkbenchError('INVALID_ARGUMENT', `${field} exceeds ${max} characters`, { field })
  }
  return trimmed
}
