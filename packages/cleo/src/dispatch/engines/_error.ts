/**
 * Centralized engine error helper.
 *
 * All dispatch engines import `engineError()` from this module to produce
 * consistently typed error results with correct exit codes and pino logging.
 *
 * The STRING_TO_EXIT map is the canonical mapping from string error codes
 * to numeric exit codes. It mirrors ERROR_CODE_TO_EXIT in cli.ts.
 *
 * @remarks
 * Error codes are organized into numeric ranges:
 * - 1-9: General errors (invalid input, file, dependency, validation)
 * - 10-19: Hierarchy errors (parent, depth, siblings, circular deps)
 * - 20-29: Concurrency errors (checksum, modification, collision)
 * - 30-39: Session errors (scope, claims, active task)
 * - 40-47: Verification errors (gates, agents, rounds)
 * - 50-54: Context safeguard (warning through emergency)
 * - 60-67: Orchestrator / protocol errors
 * - 70-79: Nexus errors
 * - 80-94: Lifecycle, artifact, provenance errors
 * - 95-99: Adapter errors
 * - 100+: Special informational codes (not errors)
 */

import { engineError as coreEngineError, type EngineResult, getLogger } from '@cleocode/core';
import { mapNumericExitCodeToString } from '../lib/exit-codes.js';

// Re-export EngineResult from core (canonical location)
export type { EngineResult } from '@cleocode/core';

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
  E_TASK_COMPLETED: 17, // ExitCode.TASK_COMPLETED — canonical value from @cleocode/contracts
  E_CASCADE_FAILED: 18,
  E_HAS_DEPENDENTS: 19,

  // Concurrency Errors (20-29)
  E_CHECKSUM_MISMATCH: 20,
  E_CONCURRENT_MODIFICATION: 21,
  E_ID_COLLISION: 22,

  // Session Errors (30-39)
  E_SESSION_EXISTS: 30,
  E_SESSION_CONFLICT: 30,
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
  E_IVTR_INCOMPLETE: 83,
  E_PROVENANCE_REQUIRED: 84,
  // T1162: lifecycle scope guard — maps to ExitCode.TASK_NOT_IN_SCOPE (34)
  // because a subagent attempting to mutate a parent epic's lifecycle is
  // operating outside the scope granted by its session.
  E_LIFECYCLE_SCOPE_DENIED: 34,

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

  // Adapter Errors (95-99)
  E_ADAPTER_NOT_FOUND: 95,
  E_ADAPTER_INIT_FAILED: 96,
  E_ADAPTER_HOOK_FAILED: 97,
  E_ADAPTER_SPAWN_FAILED: 98,
  E_ADAPTER_INSTALL_FAILED: 99,

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
 * @remarks
 * The exit code is derived from the {@link STRING_TO_EXIT} mapping. If the
 * code is not found in the map, exit code 1 (general error) is used.
 * Pino logging is automatically triggered at the appropriate level
 * (error for internal issues, warn for user/domain errors, debug for
 * informational codes). Logging is suppressed under Vitest to keep
 * test output clean.
 *
 * @param code - String error code (e.g., 'E_NOT_FOUND')
 * @param message - Human-readable error message
 * @param options - Optional details, fix command, and alternatives
 * @returns EngineResult with success=false and properly structured error
 *
 * @example
 * ```typescript
 * import { engineError } from './_error.js';
 *
 * return engineError('E_NOT_FOUND', `Task ${id} not found`, {
 *   fix: `cleo show ${id}`,
 *   details: { taskId: id },
 * });
 * ```
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
    logger[level](
      { code, exitCode, ...(options?.details && { details: options.details }) },
      message,
    );
  }

  // Delegate construction to canonical core helper (DRY).
  // The dispatch-layer wrapper adds: numeric exitCode resolution + structured logging.
  return coreEngineError<T>(code, message, { exitCode, ...options });
}

/**
 * Create an engine success result (re-export of canonical core helper).
 *
 * @see {@link import('@cleocode/core').engineSuccess}
 *
 * @example
 * ```typescript
 * import { engineSuccess } from './_error.js';
 *
 * return engineSuccess({ tasks: filteredTasks, total: count });
 * ```
 */
export { engineSuccess } from '@cleocode/core';

/**
 * Shape of a caught value that may be a `CleoError` instance.
 *
 * We cannot import `CleoError` from `@cleocode/core` here without risking a
 * circular dependency (core → engine → core), so we use a structural type.
 */
interface CaughtCleoErrorShape {
  code?: number;
  message?: string;
  fix?: string;
  details?: Record<string, unknown>;
  alternatives?: Array<{ action: string; command: string }>;
}

/**
 * Convert any caught value into an {@link EngineResult}, forwarding the rich
 * `fix`, `details`, and `alternatives` fields when the caught value is a
 * `CleoError` (or structurally compatible object).
 *
 * @remarks
 * This is the canonical catch-block helper for all dispatch engines. It
 * replaces the previous pattern of:
 * ```typescript
 * const code = (err as { code?: number })?.code;
 * if (code === 4) return engineError('E_NOT_FOUND', …);
 * …
 * ```
 * with a single call that preserves every field the core layer attached.
 *
 * The `fallbackCode` is used when the numeric `err.code` is not present in
 * the {@link STRING_TO_EXIT} mapping (e.g. unknown exit codes, plain `Error`
 * instances, or values thrown by non-CLEO code).
 *
 * @param err - The caught value (unknown type)
 * @param fallbackCode - String error code to use when mapping fails
 * @param fallbackMessage - Human-readable message when `err.message` is absent
 * @returns EngineResult with all available rich fields propagated
 *
 * @example
 * ```typescript
 * import { cleoErrorToEngineError } from './_error.js';
 *
 * } catch (err: unknown) {
 *   return cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'Task database not initialized');
 * }
 * ```
 */
export function cleoErrorToEngineError<T>(
  err: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): EngineResult<T> {
  // Non-Error thrown values: a raw string is its own message; other primitives
  // coerce to their String() form. Structured CleoError-like objects are
  // handled in the branch below via `CaughtCleoErrorShape`.
  if (typeof err === 'string') {
    return engineError<T>(fallbackCode, err);
  }
  if (err !== null && typeof err !== 'object') {
    return engineError<T>(fallbackCode, String(err));
  }

  const e = err as CaughtCleoErrorShape;
  const code = mapNumericExitCodeToString(e.code) ?? fallbackCode;
  const message = e.message ?? fallbackMessage;
  return engineError<T>(code, message, {
    ...(e.fix !== undefined && { fix: e.fix }),
    ...(e.details !== undefined && { details: e.details }),
    ...(e.alternatives !== undefined && { alternatives: e.alternatives }),
  });
}
