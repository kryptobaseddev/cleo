/**
 * Central error utilities for CLEO.
 *
 * Provides consistent error handling patterns across the codebase.
 * DRY error formatting, normalization, and transformation utilities.
 *
 * @task T5702
 */

import { ExitCode } from './exit-codes.js';

/**
 * Thrown when a non-orchestrator role attempts to spawn another agent,
 * violating the thin-agent inversion-of-control rule (ORC-012).
 *
 * Only orchestrators may spawn subagents. Leads and workers must escalate
 * via the playbook approval gate defined in T889 Orchestration Coherence v3.
 *
 * @remarks
 * Emitted by the spawn-guard middleware when an agent's declared role does
 * not satisfy the orchestrator precondition. Carries `exitCode` aligned with
 * {@link ExitCode.THIN_AGENT_VIOLATION} so the CLI can surface exit 68 to
 * callers without additional mapping.
 *
 * @example
 * ```typescript
 * throw new ThinAgentViolationError('worker-42', 'lead', 'orchestrate spawn');
 * ```
 *
 * @task T889 Orchestration Coherence v3
 * @task T907 Thin-agent enforcement
 */
export class ThinAgentViolationError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code = 'E_THIN_AGENT_VIOLATION';
  /** Numeric exit code aligned with {@link ExitCode.THIN_AGENT_VIOLATION}. */
  readonly exitCode: ExitCode = ExitCode.THIN_AGENT_VIOLATION;

  /**
   * @param agentId - The offending agent's unique identifier.
   * @param role - The offending agent's declared role (lead, worker, etc.).
   * @param attemptedAction - The spawn action that was blocked.
   */
  constructor(
    public readonly agentId: string,
    public readonly role: string,
    public readonly attemptedAction: string,
  ) {
    super(
      `E_THIN_AGENT_VIOLATION: agent '${agentId}' (role=${role}) attempted '${attemptedAction}'. ` +
        'Only orchestrators may spawn. Escalate via playbook approval gate.',
    );
    this.name = 'ThinAgentViolationError';
  }
}

/**
 * Thrown when a subagent (or any non-owner session) attempts to advance a
 * parent epic's lifecycle stages while its session is scoped to a child task.
 *
 * Lifecycle stage mutations (progress / skip / reset) for an epic MUST come
 * from a session that is:
 *   (a) scoped to the epic itself (`epic:<epicId>`), OR
 *   (b) a global-scope session (owner-level), OR
 *   (c) accompanied by `CLEO_OWNER_OVERRIDE=1` (audited escape hatch).
 *
 * Root incident: during T1150 orchestration a subagent advanced all 9 lifecycle
 * stages within 75 seconds to bypass `E_LIFECYCLE_GATE_FAILED`. This error
 * class closes that vector (T1162).
 *
 * @remarks
 * Carries `exitCode` aligned with {@link ExitCode.TASK_NOT_IN_SCOPE} (34)
 * because the attempted lifecycle mutation is semantically outside the scope
 * granted by the current session.
 *
 * @example
 * ```typescript
 * throw new LifecycleScopeDeniedError('T1150', 'epic:T1162');
 * ```
 *
 * @task T1162
 * @adr ADR-054 (scope-guard addendum)
 */
export class LifecycleScopeDeniedError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code = 'E_LIFECYCLE_SCOPE_DENIED';
  /** Numeric exit code aligned with {@link ExitCode.TASK_NOT_IN_SCOPE} (34). */
  readonly exitCode: ExitCode = ExitCode.TASK_NOT_IN_SCOPE;

  /**
   * @param epicId      - The epic whose lifecycle mutation was blocked.
   * @param sessionScope - Human-readable description of the current session scope.
   */
  constructor(
    public readonly epicId: string,
    public readonly sessionScope: string,
  ) {
    super(
      `E_LIFECYCLE_SCOPE_DENIED: lifecycle stage advancement for epic '${epicId}' requires ` +
        `a session scoped to that epic or an owner override. ` +
        `Current session scope: ${sessionScope}. ` +
        `Use CLEO_OWNER_OVERRIDE=1 if this is an authorized operation.`,
    );
    this.name = 'LifecycleScopeDeniedError';
  }
}

/**
 * Thrown when the task classifier emits an agent ID that is not present in
 * the registry vocabulary it was configured with.
 *
 * The classifier's output space MUST be a strict subset of the registered
 * agent IDs (Council 2026-04-24 FP atomic truth #3). This error is raised
 * at classification time — before any spawn attempt — so that broken routing
 * is caught as early as possible and callers receive a fix-hint listing the
 * currently valid agent IDs.
 *
 * @remarks
 * Carry `exitCode` aligned with {@link ExitCode.SPAWN_VALIDATION_FAILED} (63)
 * because the failure occurs in the pre-spawn validation chain and callers
 * mapping exit codes to envelope errors already handle 63 for spawn failures.
 *
 * @example
 * ```typescript
 * throw new ClassifierUnregisteredAgentError(
 *   'project-dev-lead',
 *   ['project-orchestrator', 'project-code-worker', 'cleo-subagent'],
 * );
 * ```
 *
 * @task T1326
 * @epic T1323
 */
export class ClassifierUnregisteredAgentError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code = 'E_CLASSIFIER_UNREGISTERED_AGENT';
  /** Numeric exit code aligned with {@link ExitCode.SPAWN_VALIDATION_FAILED} (63). */
  readonly exitCode: ExitCode = ExitCode.SPAWN_VALIDATION_FAILED;

  /**
   * @param emittedAgentId  - The agent ID the classifier tried to emit.
   * @param registeredIds   - The set of valid, registry-backed agent IDs.
   */
  constructor(
    public readonly emittedAgentId: string,
    public readonly registeredIds: readonly string[],
  ) {
    super(
      `E_CLASSIFIER_UNREGISTERED_AGENT: classifier emitted '${emittedAgentId}' which is not in ` +
        `the registered agent vocabulary. ` +
        `Valid agent IDs: [${registeredIds.join(', ')}]. ` +
        `Add this agent to the registry or remove it from the classifier rules.`,
    );
    this.name = 'ClassifierUnregisteredAgentError';
  }
}

/**
 * Thrown when an ADR-typed decision write is rejected by the LLM
 * conflict-validator hook because the overall confidence score fell below the
 * configured threshold (`decisions.validatorConfidenceThreshold`, default 0.7).
 *
 * The hook runs before the `verifyCandidate` gate and checks for:
 *   - Collision: near-identical decisions already stored
 *   - Contradiction: decisions that contradict existing architectural choices
 *   - Supersession-graph violations: circular or inconsistent supersedes chains
 *
 * Exit code aligns with {@link ExitCode.DECISION_VALIDATOR_FAILED} (106).
 *
 * @example
 * ```typescript
 * throw new DecisionValidatorFailedError('D042', 0.45, ['collision:D017']);
 * ```
 *
 * @task T1828
 */
export class DecisionValidatorFailedError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code = 'E_DECISION_VALIDATOR_FAILED';
  /** Numeric exit code. */
  readonly exitCode = 106;

  /**
   * @param decisionText  - The decision text that was rejected (truncated for safety).
   * @param confidence    - The computed confidence score from the LLM validator.
   * @param violations    - Short labels describing detected violations (e.g. 'collision:D017').
   */
  constructor(
    public readonly decisionText: string,
    public readonly confidence: number,
    public readonly violations: string[],
  ) {
    super(
      `E_DECISION_VALIDATOR_FAILED: decision write rejected (confidence=${confidence.toFixed(3)}). ` +
        `Violations: [${violations.join(', ')}]. ` +
        `Revise the decision/rationale or explicitly supersede conflicting entries.`,
    );
    this.name = 'DecisionValidatorFailedError';
  }
}

/**
 * Normalize any thrown value into a standardized error object.
 *
 * Handles:
 * - Error instances (preserves stack trace info)
 * - Strings (wraps in Error)
 * - Objects with message property
 * - null/undefined (provides fallback)
 *
 * @param error - The thrown value to normalize
 * @param fallbackMessage - Message to use if error provides none
 * @returns Normalized error with consistent shape
 *
 * @remarks
 * This function is safe to call on any value thrown by a `catch` clause.
 * It guarantees the returned object is always an `Error` instance with a
 * non-empty `message` property.
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   const error = normalizeError(err, 'Operation failed');
 *   console.error(error.message);
 * }
 * ```
 */
export function normalizeError(
  error: unknown,
  fallbackMessage = 'An unexpected error occurred',
): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message);
  }

  return new Error(fallbackMessage);
}

/**
 * Extract a human-readable message from any error value.
 *
 * Safe to use on unknown thrown values without type guards.
 *
 * @param error - The error value
 * @param fallback - Fallback message if extraction fails
 * @returns The error message string
 *
 * @remarks
 * Inspects the value for an `Error` instance, a plain string, or an object
 * with a `message` property before falling back to the provided default.
 *
 * @example
 * ```typescript
 * const message = getErrorMessage(err, 'Unknown error');
 * ```
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }

  return fallback;
}

/**
 * Format error details for logging or display.
 *
 * Includes stack trace for Error instances when includeStack is true.
 *
 * @param error - The error to format
 * @param context - Optional context to prepend
 * @param includeStack - Whether to include stack traces (default: false)
 * @returns Formatted error string
 *
 * @remarks
 * When `context` is provided it is prefixed in square brackets (e.g.
 * `[Database] Connection refused`). Stack traces are appended on a new line
 * only when `includeStack` is `true` and the value is an `Error` with a stack.
 *
 * @example
 * ```typescript
 * console.error(formatError(err, 'Database connection'));
 * // Output: [Database connection] Connection refused
 * ```
 */
export function formatError(error: unknown, context?: string, includeStack = false): string {
  const message = getErrorMessage(error);
  const prefix = context ? `[${context}] ` : '';
  let result = `${prefix}${message}`;

  if (includeStack && error instanceof Error && error.stack) {
    result += `\n${error.stack}`;
  }

  return result;
}

/**
 * Check if an error represents a specific error type by code or name.
 *
 * Useful for conditional error handling based on error types.
 *
 * @param error - The error to check
 * @param codeOrName - The error code or name to match
 * @returns True if the error matches
 *
 * @remarks
 * Checks both `Error.name` and a custom `code` property, supporting both
 * standard and LAFS-style error codes (e.g. `"E_NOT_FOUND"`).
 *
 * @example
 * ```typescript
 * if (isErrorType(err, 'E_NOT_FOUND')) {
 *   // Handle not found specifically
 * }
 * ```
 */
export function isErrorType(error: unknown, codeOrName: string): boolean {
  if (error instanceof Error) {
    if (error.name === codeOrName) {
      return true;
    }
    // Check for custom code property
    if ('code' in error && error.code === codeOrName) {
      return true;
    }
  }
  return false;
}

/**
 * Create a standardized error result object.
 *
 * Common pattern for operations that return { success: boolean, error?: string }
 *
 * @param error - The error value
 * @returns Error result object
 *
 * @remarks
 * Pairs with {@link createSuccessResult} and {@link isErrorResult} to provide
 * a consistent result-or-error pattern without exceptions.
 *
 * @example
 * ```typescript
 * return createErrorResult(err);
 * // Returns: { success: false, error: "Something went wrong" }
 * ```
 */
export function createErrorResult(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: getErrorMessage(error),
  };
}

/**
 * Create a standardized success result object.
 *
 * @returns Success result object
 *
 * @remarks
 * Pairs with {@link createErrorResult} and {@link isErrorResult} to provide
 * a consistent result-or-error pattern without exceptions.
 *
 * @example
 * ```typescript
 * return createSuccessResult();
 * // Returns: { success: true }
 * ```
 */
export function createSuccessResult(): { success: true } {
  return { success: true };
}

/**
 * Type guard for error results.
 *
 * @param result - The result to check
 * @returns True if the result is an error result
 *
 * @remarks
 * Narrows the result type so that `result.error` is guaranteed to be a string
 * after the guard returns `true`.
 *
 * @example
 * ```typescript
 * const result = await someOperation();
 * if (isErrorResult(result)) {
 *   console.error(result.error);
 * }
 * ```
 */
export function isErrorResult(result: {
  success: boolean;
  error?: string;
}): result is { success: false; error: string } {
  return !result.success;
}
