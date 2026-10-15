/**
 * Domain error with a stable machine-readable code.
 *
 * Tools convert these into messages the model can act on — never stack traces.
 * Codes are part of the contract: tests and the smoke script assert on them.
 */
export type CollaborationErrorCode =
  // input / validation
  | 'INVALID_ARGUMENT'
  | 'ROLE_UNKNOWN'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ARCHIVED'
  | 'PROJECT_EXISTS'
  // materials
  | 'MATERIAL_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  // analysis
  | 'ANALYSIS_NOT_FOUND'
  | 'SCOPE_REQUIRED'
  | 'SOURCE_REQUIRED'
  | 'SOURCE_OUT_OF_SCOPE'
  // plans
  | 'PLAN_NOT_FOUND'
  | 'PLAN_ALREADY_ACTIVE'
  | 'PLAN_SUSPENDED'
  | 'ROLES_REQUIRED'
  | 'ROLE_NOT_RELEVANT'
  | 'DEPENDENCY_CYCLE'
  | 'DEPENDENCY_MISSING_TASK'
  | 'DUPLICATE_TASK_REF'
  // tasks
  | 'TASK_NOT_FOUND'
  | 'TASK_TARGET_REQUIRED'
  | 'ADD_MUST_NOT_NAME_A_TASK'
  | 'DUPLICATE_TASK_TARGET'
  | 'TASK_FROZEN'
  | 'TASK_HAS_DEPENDENTS'
  // results
  | 'RESULT_NOT_FOUND'
  | 'RESULT_ALREADY_REVIEWED'
  | 'ACCEPTANCE_NOT_OPEN'
  | 'ALREADY_DECIDED'
  // notices
  | 'NOTICE_NOT_FOUND'
  | 'VACANT_ROLE_CANNOT_CONFIRM'
  // identity: acting as a role requires knowing who is speaking, and that it is the right
  // person (MVP-019, ADR-0014)
  | 'MEMBER_NOT_DECLARED'
  | 'NOT_ROLE_MEMBER'
  // M7 traceability
  | 'REQUIRED_INPUT_NOT_ACCEPTED'
  // storage
  | 'STORAGE_SCHEMA_UNSUPPORTED'
  | 'STORAGE_CONFLICT'
  // files
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_NOT_A_FILE'
  | 'PATH_ESCAPES_FILE_ROOT'
  // unexpected
  | 'INTERNAL'

export class CollaborationError extends Error {
  readonly code: CollaborationErrorCode
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: CollaborationErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = 'CollaborationError'
    this.code = code
    this.details = details
  }
}

/** Error codes that mean "the caller asked for something impossible", not "we broke". */
export const REJECTION_CODES: readonly CollaborationErrorCode[] = [
  'INVALID_ARGUMENT',
  'ROLE_UNKNOWN',
  'PROJECT_NOT_FOUND',
  'PROJECT_ARCHIVED',
  'PROJECT_EXISTS',
  'MATERIAL_NOT_FOUND',
  'VERSION_NOT_FOUND',
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
]

export function isCollaborationError(value: unknown): value is CollaborationError {
  return value instanceof CollaborationError
}
