/**
 * Translating raw SQLite failures into domain-meaningful signals.
 *
 * Constraint violations must be classified at the boundary, because the service needs to
 * distinguish "you asked for something already taken" from "storage is broken". Message
 * text is matched as a last resort since `node:sqlite` surfaces no structured error code.
 */

export class ProjectKeyTakenError extends Error {
  constructor(readonly key: string) {
    super(`project key "${key}" is already in use`)
    this.name = 'ProjectKeyTakenError'
  }
}

const UNIQUE_PATTERNS = [/UNIQUE constraint failed/i, /SQLITE_CONSTRAINT_UNIQUE/i]
const FOREIGN_KEY_PATTERNS = [/FOREIGN KEY constraint failed/i, /SQLITE_CONSTRAINT_FOREIGNKEY/i]
const BUSY_PATTERNS = [/database is locked/i, /SQLITE_BUSY/i]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isUniqueViolation(error: unknown): boolean {
  const message = messageOf(error)
  return UNIQUE_PATTERNS.some((re) => re.test(message))
}

export function isForeignKeyViolation(error: unknown): boolean {
  const message = messageOf(error)
  return FOREIGN_KEY_PATTERNS.some((re) => re.test(message))
}

export function isBusy(error: unknown): boolean {
  const message = messageOf(error)
  return BUSY_PATTERNS.some((re) => re.test(message))
}
