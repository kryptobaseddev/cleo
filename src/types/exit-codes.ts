/**
 * CLEO exit codes - all 72 codes from the Bash CLI.
 * Ranges: 0 = success, 1-99 = errors, 100+ = special (non-error) states.
 *
 * @epic T4454
 * @task T4456
 */

export enum ExitCode {
  // === SUCCESS (0) ===
  SUCCESS = 0,

  // === GENERAL ERRORS (1-9) ===
  GENERAL_ERROR = 1,
  INVALID_INPUT = 2,
  FILE_ERROR = 3,
  NOT_FOUND = 4,
  DEPENDENCY_ERROR = 5,
  VALIDATION_ERROR = 6,
  LOCK_TIMEOUT = 7,
  CONFIG_ERROR = 8,

  // === HIERARCHY ERRORS (10-19) ===
  PARENT_NOT_FOUND = 10,
  DEPTH_EXCEEDED = 11,
  SIBLING_LIMIT = 12,
  INVALID_PARENT_TYPE = 13,
  CIRCULAR_REFERENCE = 14,
  ORPHAN_DETECTED = 15,
  HAS_CHILDREN = 16,
  TASK_COMPLETED = 17,
  CASCADE_FAILED = 18,
  HAS_DEPENDENTS = 19,

  // === CONCURRENCY ERRORS (20-29) ===
  CHECKSUM_MISMATCH = 20,
  CONCURRENT_MODIFICATION = 21,
  ID_COLLISION = 22,

  // === SESSION ERRORS (30-39) ===
  SESSION_EXISTS = 30,
  SESSION_NOT_FOUND = 31,
  SCOPE_CONFLICT = 32,
  SCOPE_INVALID = 33,
  TASK_NOT_IN_SCOPE = 34,
  TASK_CLAIMED = 35,
  SESSION_REQUIRED = 36,
  SESSION_CLOSE_BLOCKED = 37,
  FOCUS_REQUIRED = 38,
  NOTES_REQUIRED = 39,

  // === VERIFICATION ERRORS (40-47) ===
  VERIFICATION_INIT_FAILED = 40,
  GATE_UPDATE_FAILED = 41,
  INVALID_GATE = 42,
  INVALID_AGENT = 43,
  MAX_ROUNDS_EXCEEDED = 44,
  GATE_DEPENDENCY = 45,
  VERIFICATION_LOCKED = 46,
  ROUND_MISMATCH = 47,

  // === CONTEXT SAFEGUARD (50-54) ===
  CONTEXT_WARNING = 50,
  CONTEXT_CAUTION = 51,
  CONTEXT_CRITICAL = 52,
  CONTEXT_EMERGENCY = 53,
  CONTEXT_STALE = 54,

  // === ORCHESTRATOR ERRORS (60-67) ===
  PROTOCOL_MISSING = 60,
  INVALID_RETURN_MESSAGE = 61,
  MANIFEST_ENTRY_MISSING = 62,
  SPAWN_VALIDATION_FAILED = 63,
  AUTONOMOUS_BOUNDARY = 64,
  HANDOFF_REQUIRED = 65,
  RESUME_FAILED = 66,
  CONCURRENT_SESSION = 67,

  // === NEXUS ERRORS (70-79) ===
  NEXUS_NOT_INITIALIZED = 70,
  NEXUS_PROJECT_NOT_FOUND = 71,
  NEXUS_PERMISSION_DENIED = 72,
  NEXUS_INVALID_SYNTAX = 73,
  NEXUS_SYNC_FAILED = 74,
  NEXUS_REGISTRY_CORRUPT = 75,
  NEXUS_PROJECT_EXISTS = 76,
  NEXUS_QUERY_FAILED = 77,
  NEXUS_GRAPH_ERROR = 78,
  NEXUS_RESERVED = 79,

  // === LIFECYCLE ENFORCEMENT (80-84) ===
  LIFECYCLE_GATE_FAILED = 80,
  AUDIT_MISSING = 81,
  CIRCULAR_VALIDATION = 82,
  LIFECYCLE_TRANSITION_INVALID = 83,
  PROVENANCE_REQUIRED = 84,

  // === ARTIFACT PUBLISH (85-89) ===
  ARTIFACT_TYPE_UNKNOWN = 85,
  ARTIFACT_VALIDATION_FAILED = 86,
  ARTIFACT_BUILD_FAILED = 87,
  ARTIFACT_PUBLISH_FAILED = 88,
  ARTIFACT_ROLLBACK_FAILED = 89,

  // === PROVENANCE (90-94) ===
  PROVENANCE_CONFIG_INVALID = 90,
  SIGNING_KEY_MISSING = 91,
  SIGNATURE_INVALID = 92,
  DIGEST_MISMATCH = 93,
  ATTESTATION_INVALID = 94,

  // === SPECIAL CODES (100+) - NOT errors ===
  NO_DATA = 100,
  ALREADY_EXISTS = 101,
  NO_CHANGE = 102,
  TESTS_SKIPPED = 103,
}

/** Check if an exit code represents an error (1-99). */
export function isErrorCode(code: ExitCode): boolean {
  return code >= 1 && code < 100;
}

/** Check if an exit code represents success (0 or 100+). */
export function isSuccessCode(code: ExitCode): boolean {
  return code === 0 || code >= 100;
}

/** Check if an exit code indicates no change (idempotent operation). */
export function isNoChangeCode(code: ExitCode): boolean {
  return code === ExitCode.NO_CHANGE;
}

/** Check if an exit code is recoverable (retry may succeed). */
export function isRecoverableCode(code: ExitCode): boolean {
  const nonRecoverable = new Set<ExitCode>([
    ExitCode.FILE_ERROR,
    ExitCode.DEPENDENCY_ERROR,
    ExitCode.CIRCULAR_REFERENCE,
    ExitCode.CASCADE_FAILED,
    ExitCode.SESSION_CLOSE_BLOCKED,
    ExitCode.VERIFICATION_LOCKED,
    ExitCode.CONTEXT_WARNING,
    ExitCode.CONTEXT_CAUTION,
    ExitCode.CONTEXT_CRITICAL,
    ExitCode.CONTEXT_EMERGENCY,
    ExitCode.CONTEXT_STALE,
    ExitCode.AUTONOMOUS_BOUNDARY,
    ExitCode.HANDOFF_REQUIRED,
    ExitCode.NEXUS_PERMISSION_DENIED,
    ExitCode.NEXUS_REGISTRY_CORRUPT,
    ExitCode.CIRCULAR_VALIDATION,
    ExitCode.LIFECYCLE_TRANSITION_INVALID,
    ExitCode.ARTIFACT_TYPE_UNKNOWN,
    ExitCode.ARTIFACT_ROLLBACK_FAILED,
    ExitCode.DIGEST_MISMATCH,
  ]);

  if (!isErrorCode(code)) return false;
  return !nonRecoverable.has(code);
}

/** Human-readable name for an exit code. */
export function getExitCodeName(code: ExitCode): string {
  return ExitCode[code] ?? 'UNKNOWN';
}
