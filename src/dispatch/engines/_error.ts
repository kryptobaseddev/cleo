/**
 * Centralized engine error helper.
 *
 * All dispatch engines import `engineError()` from this module to produce
 * consistently typed error results with correct exit codes and pino logging.
 *
 * The STRING_TO_EXIT map is the canonical mapping from string error codes
 * to numeric exit codes. It mirrors ERROR_CODE_TO_EXIT in cli.ts.
 */

import { getLogger } from '../../core/logger.js';

/**
 * Canonical EngineResult type used by all engines.
 * Replaces the per-engine EngineResult interface definitions.
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    exitCode?: number;
    details?: unknown;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  };
}

/**
 * Canonical mapping from string error codes to numeric exit codes.
 *
 * Source of truth: src/types/exit-codes.ts (ExitCode enum).
 * Must stay in sync with ERROR_CODE_TO_EXIT in src/dispatch/adapters/cli.ts.
 */
export const STRING_TO_EXIT: Record<string, number> = {
  // General Errors (1-9)
  E_GENERAL: 1,
  E_GENERAL_ERROR: 1,
  E_INVALID_INPUT: 2,
  E_MISSING_PARAMS: 2,
  E_INVALID_OPERATION: 2,
  E_FILE_ERROR: 3,
  E_NOT_FOUND: 4,
  E_DEPENDENCY: 5,
  E_DEPENDENCY_ERROR: 5,
  E_VALIDATION: 6,
  E_VALIDATION_FAILED: 6,
  E_VALIDATION_ERROR: 6,
  E_RETRYABLE: 7,
  E_LOCK_TIMEOUT: 7,
  E_CONFIG_ERROR: 8,

  // Hierarchy Errors (10-19)
  E_PARENT_NOT_FOUND: 10,
  E_DEPTH_EXCEEDED: 11,
  E_SIBLING_LIMIT: 12,
  E_INVALID_PARENT_TYPE: 13,
  E_INVALID_PARENT: 13,
  E_CIRCULAR_DEP: 14,
  E_CIRCULAR_REFERENCE: 14,
  E_ORPHAN_DETECTED: 15,
  E_HAS_CHILDREN: 16,
  E_CASCADE_FAILED: 18,
  E_HAS_DEPENDENTS: 19,

  // Concurrency Errors (20-29)
  E_CHECKSUM_MISMATCH: 20,
  E_CONCURRENT_MODIFICATION: 21,
  E_ID_COLLISION: 22,

  // Session Errors (30-39)
  E_SESSION_EXISTS: 30,
  E_SESSION_NOT_FOUND: 31,
  E_SCOPE_CONFLICT: 32,
  E_SCOPE_INVALID: 33,
  E_TASK_NOT_IN_SCOPE: 34,
  E_TASK_CLAIMED: 35,
  E_SESSION_REQUIRED: 36,
  E_SESSION_CLOSE_BLOCKED: 37,
  E_ACTIVE_TASK_REQUIRED: 38,
  E_NOTES_REQUIRED: 39,

  // Verification Errors (40-47)
  E_VERIFICATION_INIT_FAILED: 40,
  E_GATE_UPDATE_FAILED: 41,
  E_INVALID_GATE: 42,
  E_INVALID_AGENT: 43,
  E_MAX_ROUNDS_EXCEEDED: 44,
  E_GATE_DEPENDENCY: 45,
  E_VERIFICATION_LOCKED: 46,
  E_ROUND_MISMATCH: 47,

  // Context Safeguard (50-54)
  E_CONTEXT_WARNING: 50,
  E_CONTEXT_CAUTION: 51,
  E_CONTEXT_CRITICAL: 52,
  E_CONTEXT_EMERGENCY: 53,
  E_CONTEXT_STALE: 54,

  // Orchestrator / Protocol Errors (60-67)
  E_PROTOCOL_MISSING: 60,
  E_PROTOCOL_RESEARCH: 60,
  E_INVALID_RETURN_MESSAGE: 61,
  E_PROTOCOL_CONSENSUS: 61,
  E_MANIFEST_ENTRY_MISSING: 62,
  E_PROTOCOL_SPECIFICATION: 62,
  E_SPAWN_VALIDATION_FAILED: 63,
  E_PROTOCOL_DECOMPOSITION: 63,
  E_AUTONOMOUS_BOUNDARY: 64,
  E_PROTOCOL_IMPLEMENTATION: 64,
  E_HANDOFF_REQUIRED: 65,
  E_PROTOCOL_CONTRIBUTION: 65,
  E_RESUME_FAILED: 66,
  E_PROTOCOL_RELEASE: 66,
  E_CONCURRENT_SESSION: 67,
  E_PROTOCOL_GENERIC: 67,

  // Nexus Errors (70-79)
  E_NEXUS_NOT_INITIALIZED: 70,
  E_NEXUS_PROJECT_NOT_FOUND: 71,
  E_NEXUS_PERMISSION_DENIED: 72,
  E_NEXUS_INVALID_SYNTAX: 73,
  E_NEXUS_SYNC_FAILED: 74,
  E_NEXUS_REGISTRY_CORRUPT: 75,
  E_NEXUS_PROJECT_EXISTS: 76,
  E_NEXUS_QUERY_FAILED: 77,
  E_NEXUS_GRAPH_ERROR: 78,

  // Lifecycle Enforcement (80-84)
  E_LIFECYCLE_GATE_FAILED: 80,
  E_AUDIT_MISSING: 81,
  E_CIRCULAR_VALIDATION: 82,
  E_LIFECYCLE_TRANSITION_INVALID: 83,
  E_PROVENANCE_REQUIRED: 84,

  // Artifact Publish (85-89)
  E_ARTIFACT_TYPE_UNKNOWN: 85,
  E_ARTIFACT_VALIDATION_FAILED: 86,
  E_ARTIFACT_BUILD_FAILED: 87,
  E_ARTIFACT_PUBLISH_FAILED: 88,
  E_ARTIFACT_ROLLBACK_FAILED: 89,

  // Provenance (90-94)
  E_PROVENANCE_CONFIG_INVALID: 90,
  E_SIGNING_KEY_MISSING: 91,
  E_SIGNATURE_INVALID: 92,
  E_DIGEST_MISMATCH: 93,
  E_ATTESTATION_INVALID: 94,

  // Special Codes (100+) - NOT errors
  E_NO_DATA: 100,
  E_ALREADY_EXISTS: 101,
  E_NO_CHANGE: 102,
  E_TESTS_SKIPPED: 103,
  E_TASK_COMPLETED: 104,

  // Common engine-specific aliases
  E_NOT_INITIALIZED: 3,
  E_NO_HANDLER: 1,
  E_INTERNAL: 1,
  E_LIST_FAILED: 3,
  E_READ_FAILED: 3,
  E_WRITE_FAILED: 3,
  E_PARSE_ERROR: 2,
  E_TEMPLATE_ERROR: 2,
};

/**
 * Derive pino log level from exit code.
 *
 * - 100+: special/informational -> 'debug'
 * - 1-9 internal errors (1, 3): -> 'error'
 * - 10-99 user/domain errors: -> 'warn'
 * - 0: success (should not be called for errors) -> 'debug'
 */
function logLevel(exitCode: number): 'error' | 'warn' | 'debug' {
  if (exitCode === 0 || exitCode >= 100) return 'debug';
  // Internal errors: general (1), file (3) — these indicate bugs or system issues
  if (exitCode === 1 || exitCode === 3) return 'error';
  // Everything else is a user/domain error
  return 'warn';
}

/**
 * Create a typed engine error result with pino logging and correct exit code.
 *
 * @param code - String error code (e.g., 'E_NOT_FOUND')
 * @param message - Human-readable error message
 * @param options - Optional details, fix command, and alternatives
 * @returns EngineResult with success=false and properly structured error
 */
export function engineError<T>(
  code: string,
  message: string,
  options?: {
    details?: Record<string, unknown>;
    fix?: string;
    alternatives?: Array<{ action: string; command: string }>;
  },
): EngineResult<T> {
  const exitCode = STRING_TO_EXIT[code] ?? 1;
  const level = logLevel(exitCode);

  // Keep test output clean: skip engine logging under Vitest.
  const isVitest = process.env['VITEST'] === 'true';
  if (!isVitest) {
    // Lazy logger acquisition: avoids capturing the stderr fallback logger
    // at module load time (before CLI's preAction hook calls initLogger()).
    // This prevents the double-output envelope bug (T5148).
    const logger = getLogger('engine');
    logger[level]({ code, exitCode, ...(options?.details && { details: options.details }) }, message);
  }

  return {
    success: false,
    error: {
      code,
      message,
      exitCode,
      ...(options?.details && { details: options.details }),
      ...(options?.fix && { fix: options.fix }),
      ...(options?.alternatives && { alternatives: options.alternatives }),
    },
  };
}

/**
 * Create an engine success result.
 *
 * @param data - The result data
 * @returns EngineResult with success=true
 */
export function engineSuccess<T>(data: T): EngineResult<T> {
  return { success: true, data };
}
