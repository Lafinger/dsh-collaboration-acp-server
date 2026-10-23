export class CollaborationError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'CollaborationError';
        this.code = code;
        this.details = details;
    }
}
/** Error codes that mean "the caller asked for something impossible", not "we broke". */
export const REJECTION_CODES = [
    'INVALID_ARGUMENT',
    'ROLE_UNKNOWN',
    'PROJECT_NOT_FOUND',
    'PROJECT_ARCHIVED',
    'PROJECT_EXISTS',
    'MATERIAL_NOT_FOUND',
    'VERSION_NOT_FOUND',
    'VERSION_CONFLICT',
    'MATERIAL_IDENTITY_CONFLICT',
    'MATERIAL_RESTORE_CONFIRMATION_REQUIRED',
    'FILE_INTEGRITY_MISMATCH',
    'ANALYSIS_NOT_FOUND',
    'SCOPE_REQUIRED',
    'SOURCE_REQUIRED',
    'SOURCE_OUT_OF_SCOPE',
    'PLAN_NOT_FOUND',
    'PLAN_ALREADY_ACTIVE',
    'PLAN_SUSPENDED',
    'ROLES_REQUIRED',
    'ROLE_NOT_RELEVANT',
    'DEPENDENCY_CYCLE',
    'DEPENDENCY_MISSING_TASK',
    'DUPLICATE_TASK_REF',
    'TASK_NOT_FOUND',
    'TASK_TARGET_REQUIRED',
    'ADD_MUST_NOT_NAME_A_TASK',
    'DUPLICATE_TASK_TARGET',
    'TASK_FROZEN',
    'TASK_HAS_DEPENDENTS',
    'RESULT_NOT_FOUND',
    'RESULT_ALREADY_REVIEWED',
    'ACCEPTANCE_NOT_OPEN',
    'ALREADY_DECIDED',
    'NOTICE_NOT_FOUND',
    'VACANT_ROLE_CANNOT_CONFIRM',
    'MEMBER_NOT_DECLARED',
    'NOT_ROLE_MEMBER',
    'REQUIRED_INPUT_NOT_ACCEPTED',
    'SOURCE_NOT_FOUND',
    'SOURCE_NOT_A_FILE',
    'PATH_ESCAPES_FILE_ROOT',
    'STORAGE_CONFLICT',
];
export function isCollaborationError(value) {
    return value instanceof CollaborationError;
}
