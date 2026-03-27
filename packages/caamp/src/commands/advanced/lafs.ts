/**
 * LAFS-compliant output helpers for advanced CLI commands.
 */

import { randomUUID } from 'node:crypto';
import {
  isRegisteredErrorCode,
  type LAFSError,
  type LAFSErrorCategory,
  type LAFSMeta,
  type LAFSPage,
} from '@cleocode/lafs';
import type { MVILevel } from '../../core/lafs.js';

/**
 * Generic LAFS result envelope for advanced commands.
 * Uses protocol types directly for full compliance.
 */
type LAFSResultEnvelope<T> = {
  $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json';
  _meta: LAFSMeta;
  success: boolean;
  result: T | null;
  error: LAFSError | null;
  page: LAFSPage | null;
};

/**
 * Structured error class for LAFS-compliant command failures with error codes and recovery hints.
 *
 * @remarks
 * Automatically infers the LAFS error category from the error code string pattern.
 * Used by advanced commands to produce machine-readable error envelopes.
 *
 * @public
 */
export class LAFSCommandError extends Error {
  /** LAFS error code identifying the failure type. */
  code: string;
  /** LAFS error category inferred from the error code. */
  category: LAFSErrorCategory;
  /** Whether the operation can be retried after fixing the root cause. */
  recoverable: boolean;
  /** Human-readable suggestion for resolving the error. */
  suggestion: string;
  /** Optional delay in milliseconds before retrying, or null. */
  retryAfterMs: number | null;
  /** Optional additional error details payload. */
  details?: unknown;

  constructor(
    code: string,
    message: string,
    suggestion: string,
    recoverable = true,
    details?: unknown,
  ) {
    super(message);
    this.name = 'LAFSCommandError';
    this.code = code;
    this.category = inferErrorCategory(code);
    this.recoverable = recoverable;
    this.suggestion = suggestion;
    this.retryAfterMs = null;
    this.details = details;
  }
}

function inferErrorCategory(code: string): LAFSErrorCategory {
  if (code.includes('VALIDATION')) return 'VALIDATION';
  if (code.includes('NOT_FOUND')) return 'NOT_FOUND';
  if (code.includes('CONFLICT')) return 'CONFLICT';
  if (code.includes('AUTH')) return 'AUTH';
  if (code.includes('PERMISSION')) return 'PERMISSION';
  if (code.includes('RATE_LIMIT')) return 'RATE_LIMIT';
  if (code.includes('MIGRATION')) return 'MIGRATION';
  if (code.includes('CONTRACT')) return 'CONTRACT';
  return 'INTERNAL';
}

function baseMeta(operation: string, mvi: MVILevel): LAFSMeta {
  return {
    specVersion: '1.0.0',
    schemaVersion: '1.0.0',
    timestamp: new Date().toISOString(),
    operation,
    requestId: randomUUID(),
    transport: 'cli',
    strict: true,
    mvi,
    contextVersion: 0,
  };
}

/**
 * Emits a successful LAFS result envelope to stdout.
 *
 * @remarks
 * Wraps the result in a fully compliant LAFS envelope with auto-generated metadata including
 * requestId, timestamp, and transport identifiers.
 *
 * @typeParam T - The type of the result payload
 * @param operation - The LAFS operation identifier
 * @param result - The result payload to include in the envelope
 * @param mvi - The minimum viable information level, defaults to "standard"
 *
 * @example
 * ```typescript
 * emitSuccess("advanced.providers", { providers: [...] });
 * ```
 *
 * @public
 */
export function emitSuccess<T>(operation: string, result: T, mvi: MVILevel = 'standard'): void {
  const envelope: LAFSResultEnvelope<T> = {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: {
      ...baseMeta(operation, mvi),
    },
    success: true,
    result,
    error: null,
    page: null,
  };
  console.log(JSON.stringify(envelope, null, 2));
}

/**
 * Emits a failed LAFS error envelope to stderr.
 *
 * @remarks
 * Handles both LAFSCommandError instances (with structured codes and categories) and generic
 * errors (wrapped as E_INTERNAL_UNEXPECTED). Registered error codes are preserved; unregistered
 * codes are normalized to the internal fallback.
 *
 * @param operation - The LAFS operation identifier
 * @param error - The error to serialize, either a LAFSCommandError or generic Error/unknown
 * @param mvi - The minimum viable information level, defaults to "standard"
 *
 * @example
 * ```typescript
 * emitError("advanced.apply", new LAFSCommandError("E_VALIDATION", "bad input", "fix it"));
 * ```
 *
 * @public
 */
export function emitError(operation: string, error: unknown, mvi: MVILevel = 'standard'): void {
  let envelope: LAFSResultEnvelope<null>;

  if (error instanceof LAFSCommandError) {
    envelope = {
      $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      _meta: {
        ...baseMeta(operation, mvi),
      },
      success: false,
      result: null,
      error: {
        code: isRegisteredErrorCode(error.code) ? error.code : 'E_INTERNAL_UNEXPECTED',
        message: error.message,
        category: error.category,
        retryable: error.recoverable,
        retryAfterMs: error.retryAfterMs,
        details: {
          hint: error.suggestion,
          ...(error.details !== undefined ? { payload: error.details } : {}),
        },
      },
      page: null,
    };
  } else {
    envelope = {
      $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
      _meta: {
        ...baseMeta(operation, mvi),
      },
      success: false,
      result: null,
      error: {
        code: 'E_INTERNAL_UNEXPECTED',
        message: error instanceof Error ? error.message : String(error),
        category: 'INTERNAL',
        retryable: false,
        retryAfterMs: null,
        details: {
          hint: 'Rerun with --verbose and validate your inputs.',
        },
      },
      page: null,
    };
  }

  console.error(JSON.stringify(envelope, null, 2));
}

/**
 * Runs an async action and emits the result as a LAFS success or error envelope.
 *
 * @remarks
 * Wraps the action in a try/catch. On success, calls emitSuccess. On failure, calls emitError
 * and exits with code 1. This is the standard execution wrapper for all advanced commands.
 *
 * @typeParam T - The type of the result returned by the action
 * @param command - The LAFS operation identifier
 * @param mvi - The minimum viable information level
 * @param action - The async function to execute
 * @returns Resolves when the action completes and output is emitted
 *
 * @example
 * ```typescript
 * await runLafsCommand("advanced.batch", "standard", async () => {
 *   return { installed: 3 };
 * });
 * ```
 *
 * @public
 */
export async function runLafsCommand<T>(
  command: string,
  mvi: MVILevel,
  action: () => Promise<T>,
): Promise<void> {
  try {
    const result = await action();
    emitSuccess(command, result, mvi);
  } catch (error) {
    emitError(command, error, mvi);
    process.exit(1);
  }
}
