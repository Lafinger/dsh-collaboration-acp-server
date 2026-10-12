/**
 * Translating raw SQLite failures into domain-meaningful signals.
 *
 * Constraint violations must be classified at the boundary, because the service needs to
 * distinguish "you asked for something already taken" from "storage is broken". Message
 * text is matched as a last resort since `node:sqlite` surfaces no structured error code.
 */
export declare class ProjectKeyTakenError extends Error {
    readonly key: string;
    constructor(key: string);
}
export declare function isUniqueViolation(error: unknown): boolean;
export declare function isForeignKeyViolation(error: unknown): boolean;
export declare function isBusy(error: unknown): boolean;
