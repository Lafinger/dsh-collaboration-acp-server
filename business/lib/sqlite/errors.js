/**
 * Translating raw SQLite failures into domain-meaningful signals.
 *
 * Constraint violations must be classified at the boundary, because the service needs to
 * distinguish "you asked for something already taken" from "storage is broken". Message
 * text is matched as a last resort since `node:sqlite` surfaces no structured error code.
 */
export class ProjectKeyTakenError extends Error {
    key;
    constructor(key) {
        super(`project key "${key}" is already in use`);
        this.key = key;
        this.name = 'ProjectKeyTakenError';
    }
}
const UNIQUE_PATTERNS = [/UNIQUE constraint failed/i, /SQLITE_CONSTRAINT_UNIQUE/i];
const FOREIGN_KEY_PATTERNS = [/FOREIGN KEY constraint failed/i, /SQLITE_CONSTRAINT_FOREIGNKEY/i];
const BUSY_PATTERNS = [/database is locked/i, /SQLITE_BUSY/i];
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export function isUniqueViolation(error) {
    const message = messageOf(error);
    return UNIQUE_PATTERNS.some((re) => re.test(message));
}
export function isForeignKeyViolation(error) {
    const message = messageOf(error);
    return FOREIGN_KEY_PATTERNS.some((re) => re.test(message));
}
export function isBusy(error) {
    const message = messageOf(error);
    return BUSY_PATTERNS.some((re) => re.test(message));
}
