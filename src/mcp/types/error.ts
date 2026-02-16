/**
 * Error Code Definitions
 *
 * All CLEO exit codes and their corresponding error constants.
 */

/**
 * General errors (1-9)
 */
export const enum GeneralErrorCode {
  SUCCESS = 0,
  E_GENERAL = 1,
  E_INVALID_INPUT = 2,
  E_FILE_ERROR = 3,
  E_NOT_FOUND = 4,
  E_DEPENDENCY = 5,
  E_VALIDATION = 6,
  E_RETRYABLE = 7,
}

/**
 * Hierarchy errors (10-19)
 */
export const enum HierarchyErrorCode {
  E_PARENT_NOT_FOUND = 10,
  E_DEPTH_EXCEEDED = 11,
  E_SIBLING_LIMIT = 12,
  E_CIRCULAR_DEP = 13,
}

/**
 * Session errors (30-39)
 */
export const enum SessionErrorCode {
  E_FOCUS_REQUIRED = 38,
  E_SESSION_DISCOVERY = 100, // Special: not an error
}

/**
 * Gate errors (40-49)
 */
export const enum GateErrorCode {
  E_GATE_UPDATE_FAILED = 40,
  E_VERIFICATION_LOCKED = 41,
  E_INVALID_GATE = 42,
  E_INVALID_AGENT = 43,
}

/**
 * Context errors (50-59)
 */
export const enum ContextErrorCode {
  E_CONTEXT_CRITICAL = 50,
  E_CONTEXT_HIGH = 51,
  E_CONTEXT_MEDIUM = 52,
}

/**
 * Protocol violations (60-70)
 */
export const enum ProtocolErrorCode {
  E_PROTOCOL_RESEARCH = 60,
  E_PROTOCOL_CONSENSUS = 61,
  E_PROTOCOL_SPECIFICATION = 62,
  E_PROTOCOL_DECOMPOSITION = 63,
  E_PROTOCOL_IMPLEMENTATION = 64,
  E_PROTOCOL_CONTRIBUTION = 65,
  E_PROTOCOL_RELEASE = 66,
  E_PROTOCOL_GENERIC = 67,
  E_PROTOCOL_VALIDATION = 68,
  E_TESTS_SKIPPED = 69,
  E_COVERAGE_INSUFFICIENT = 70,
}

/**
 * Lifecycle errors (75-79)
 */
export const enum LifecycleErrorCode {
  E_LIFECYCLE_GATE_FAILED = 75,
  E_AUDIT_MISSING = 76,
  E_CIRCULAR_VALIDATION = 77,
  E_LIFECYCLE_TRANSITION_INVALID = 78,
  E_PROVENANCE_REQUIRED = 79,
}

/**
 * Special codes (100+)
 */
export const enum SpecialCode {
  E_SESSION_DISCOVERY_MODE = 100,
  E_DUPLICATE_ID = 101,
}

/**
 * All error codes union
 */
export type ErrorCode =
  | GeneralErrorCode
  | HierarchyErrorCode
  | SessionErrorCode
  | GateErrorCode
  | ContextErrorCode
  | ProtocolErrorCode
  | LifecycleErrorCode
  | SpecialCode;

/**
 * Error code to constant name mapping
 */
export const ERROR_CODE_NAMES: Record<number, string> = {
  0: 'SUCCESS',
  1: 'E_GENERAL',
  2: 'E_INVALID_INPUT',
  3: 'E_FILE_ERROR',
  4: 'E_NOT_FOUND',
  5: 'E_DEPENDENCY',
  6: 'E_VALIDATION',
  7: 'E_RETRYABLE',
  10: 'E_PARENT_NOT_FOUND',
  11: 'E_DEPTH_EXCEEDED',
  12: 'E_SIBLING_LIMIT',
  13: 'E_CIRCULAR_DEP',
  38: 'E_FOCUS_REQUIRED',
  40: 'E_GATE_UPDATE_FAILED',
  41: 'E_VERIFICATION_LOCKED',
  42: 'E_INVALID_GATE',
  43: 'E_INVALID_AGENT',
  50: 'E_CONTEXT_CRITICAL',
  51: 'E_CONTEXT_HIGH',
  52: 'E_CONTEXT_MEDIUM',
  60: 'E_PROTOCOL_RESEARCH',
  61: 'E_PROTOCOL_CONSENSUS',
  62: 'E_PROTOCOL_SPECIFICATION',
  63: 'E_PROTOCOL_DECOMPOSITION',
  64: 'E_PROTOCOL_IMPLEMENTATION',
  65: 'E_PROTOCOL_CONTRIBUTION',
  66: 'E_PROTOCOL_RELEASE',
  67: 'E_PROTOCOL_GENERIC',
  68: 'E_PROTOCOL_VALIDATION',
  69: 'E_TESTS_SKIPPED',
  70: 'E_COVERAGE_INSUFFICIENT',
  75: 'E_LIFECYCLE_GATE_FAILED',
  76: 'E_AUDIT_MISSING',
  77: 'E_CIRCULAR_VALIDATION',
  78: 'E_LIFECYCLE_TRANSITION_INVALID',
  79: 'E_PROVENANCE_REQUIRED',
  100: 'E_SESSION_DISCOVERY_MODE',
  101: 'E_DUPLICATE_ID',
};

/**
 * Retryable error codes
 */
export const RETRYABLE_ERROR_CODES: number[] = [
  7, 20, 21, 22, 60, 61, 62, 63,
];

/**
 * Check if error code is retryable
 */
export function isRetryableError(code: number): boolean {
  return RETRYABLE_ERROR_CODES.includes(code);
}
