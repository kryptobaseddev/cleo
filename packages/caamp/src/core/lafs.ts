/**
 * Shared LAFS utilities for CAAMP commands
 *
 * Provides standardized LAFS envelope creation, error handling, and format resolution
 * to ensure all commands follow the LAFS (Language-Agnostic Format Specification) protocol.
 *
 * @module lafs
 * @requires @cleocode/lafs
 * @requires ../logger.js
 */

import { randomUUID } from 'node:crypto';
import type { LAFSError, LAFSErrorCategory, LAFSMeta, LAFSPage, Warning } from '@cleocode/lafs';
import { resolveOutputFormat } from '@cleocode/lafs';
import { isHuman, isQuiet } from './logger.js';

/**
 * LAFS MVI disclosure level - defined locally to avoid CI module resolution issues with re-exported types.
 *
 * @public
 */
export type MVILevel = 'minimal' | 'standard' | 'full' | 'custom';

// Re-export protocol types under CAAMP's naming conventions
export type { LAFSMeta };

/**
 * LAFS Error structure - re-exported from protocol as LAFSErrorShape for CAAMP compatibility.
 *
 * @public
 */
export type LAFSErrorShape = LAFSError;

/**
 * LAFS Warning structure - re-exported from protocol.
 *
 * @public
 */
export type LAFSWarning = Warning;

/**
 * Generic LAFS Envelope structure for type-safe command results.
 *
 * @remarks
 * Extends the protocol's envelope with TypeScript generics for compile-time
 * safety when constructing or consuming command results.
 *
 * @public
 */
export interface LAFSEnvelope<T> {
  /** JSON Schema URI for envelope validation. */
  $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json';
  /** Envelope metadata (timestamps, request IDs, MVI level). */
  _meta: LAFSMeta;
  /** Whether the operation succeeded. */
  success: boolean;
  /** Operation result payload, or `null` on error. */
  result: T | null;
  /** Error details, or `null` on success. */
  error: LAFSErrorShape | null;
  /** Pagination metadata, or `null` when not applicable. */
  page: LAFSPage | null;
}

/**
 * Format resolution options.
 *
 * @public
 */
export interface FormatOptions {
  /** Whether `--json` was explicitly passed. @defaultValue `false` */
  jsonFlag?: boolean;
  /** Whether `--human` was explicitly passed. @defaultValue `false` */
  humanFlag?: boolean;
  /** Project-level default format when no flag is given. @defaultValue `"json"` */
  projectDefault?: 'json' | 'human';
}

/**
 * Resolves output format based on flags and defaults.
 *
 * @remarks
 * Delegates to the LAFS protocol's `resolveOutputFormat` function, layering
 * in the global `isHuman()` state so that `--human` set at the CLI root
 * propagates to all subcommands.
 *
 * @param options - Format resolution options
 * @returns `"json"` or `"human"`
 * @throws Error if format flags conflict
 *
 * @example
 * ```typescript
 * const format = resolveFormat({ jsonFlag: true });
 * ```
 *
 * @public
 */
export function resolveFormat(options: FormatOptions): 'json' | 'human' {
  return resolveOutputFormat({
    jsonFlag: options.jsonFlag ?? false,
    humanFlag: (options.humanFlag ?? false) || isHuman(),
    projectDefault: options.projectDefault ?? 'json',
  }).format;
}

/**
 * Builds a standard LAFS envelope.
 *
 * @remarks
 * Populates `_meta` with a fresh UUID, ISO timestamp, and the provided
 * operation/MVI values. The `success` flag is derived from whether `error`
 * is `null`.
 *
 * @param operation - Operation identifier (e.g., `"skills.list"`, `"doctor.check"`)
 * @param mvi - Machine-Verified Instruction disclosure level
 * @param result - Operation result data (`null` if error)
 * @param error - Error details (`null` if success)
 * @param page - Pagination info (`null` if not applicable)
 * @param sessionId - Optional session identifier
 * @param warnings - Optional array of warnings to attach
 * @typeParam T - The type of the result data payload
 * @returns LAFS-compliant envelope
 *
 * @example
 * ```typescript
 * const envelope = buildEnvelope(
 *   "skills.list",
 *   "full",
 *   { skills: [], count: 0 },
 *   null,
 * );
 * ```
 *
 * @public
 */
export function buildEnvelope<T>(
  operation: string,
  mvi: MVILevel,
  result: T | null,
  error: LAFSErrorShape | null,
  page: LAFSPage | null = null,
  sessionId?: string,
  warnings?: LAFSWarning[],
): LAFSEnvelope<T> {
  return {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: {
      specVersion: '1.0.0',
      schemaVersion: '1.0.0',
      timestamp: new Date().toISOString(),
      operation,
      requestId: randomUUID(),
      transport: 'cli',
      strict: true,
      mvi,
      contextVersion: 0,
      ...(sessionId && { sessionId }),
      ...(warnings && warnings.length > 0 && { warnings }),
    },
    success: error === null,
    result,
    error,
    page,
  };
}

/**
 * Emits a JSON error envelope to stderr and exits the process.
 *
 * @remarks
 * Wraps the error in a full LAFS envelope and writes it to stderr as
 * pretty-printed JSON before calling `process.exit`. The `retryable` flag
 * is automatically set for `TRANSIENT` and `RATE_LIMIT` categories.
 *
 * @param operation - Operation identifier
 * @param mvi - Machine-Verified Instruction disclosure level
 * @param code - Error code
 * @param message - Error message
 * @param category - Error category from LAFS protocol
 * @param details - Additional error details
 * @param exitCode - Process exit code (default: 1)
 *
 * @example
 * ```typescript
 * emitError(
 *   "skills.install",
 *   "full",
 *   "E_SKILL_NOT_FOUND",
 *   "Skill not found",
 *   "NOT_FOUND",
 *   { skillName: "my-skill" },
 *   1,
 * );
 * ```
 *
 * @public
 */
export function emitError(
  operation: string,
  mvi: MVILevel,
  code: string,
  message: string,
  category: LAFSErrorCategory,
  details: Record<string, unknown> = {},
  exitCode: number = 1,
): never {
  const envelope = buildEnvelope(operation, mvi, null, {
    code,
    message,
    category,
    retryable: category === 'TRANSIENT' || category === 'RATE_LIMIT',
    retryAfterMs: null,
    details,
  });
  console.error(JSON.stringify(envelope, null, 2));
  process.exit(exitCode);
}

/**
 * Emits a JSON error envelope without exiting (for catch blocks).
 *
 * @remarks
 * Identical to {@link emitError} except it does not call `process.exit`,
 * allowing callers to perform cleanup or additional logging before exiting.
 *
 * @param operation - Operation identifier
 * @param mvi - Machine-Verified Instruction disclosure level
 * @param code - Error code
 * @param message - Error message
 * @param category - Error category from LAFS protocol
 * @param details - Additional error details
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   emitJsonError("operation", "full", "E_FAILED", "Operation failed", "INTERNAL", {});
 *   process.exit(1);
 * }
 * ```
 *
 * @public
 */
export function emitJsonError(
  operation: string,
  mvi: MVILevel,
  code: string,
  message: string,
  category: LAFSErrorCategory,
  details: Record<string, unknown> = {},
): void {
  const envelope = buildEnvelope(operation, mvi, null, {
    code,
    message,
    category,
    retryable: category === 'TRANSIENT' || category === 'RATE_LIMIT',
    retryAfterMs: null,
    details,
  });
  console.error(JSON.stringify(envelope, null, 2));
}

/**
 * Outputs a successful LAFS envelope to stdout.
 *
 * @remarks
 * In quiet mode the output is suppressed unless there is an error. The
 * envelope is serialized as pretty-printed JSON.
 *
 * @param operation - Operation identifier
 * @param mvi - Machine-Verified Instruction disclosure level
 * @param result - Operation result data
 * @param page - Optional pagination info
 * @param sessionId - Optional session identifier
 * @param warnings - Optional warnings to attach
 * @typeParam T - The type of the result data payload
 *
 * @example
 * ```typescript
 * outputSuccess("skills.list", "full", { skills: [], count: 0 });
 * ```
 *
 * @public
 */
export function outputSuccess<T>(
  operation: string,
  mvi: MVILevel,
  result: T,
  page?: LAFSPage,
  sessionId?: string,
  warnings?: LAFSWarning[],
): void {
  const envelope = buildEnvelope(operation, mvi, result, null, page ?? null, sessionId, warnings);

  // In quiet mode, only output if there's an error or if explicitly requested
  if (isQuiet() && !envelope.error) {
    // Suppress non-essential output in quiet mode
    return;
  }

  console.log(JSON.stringify(envelope, null, 2));
}

/**
 * Standard command options interface for LAFS-compliant commands.
 *
 * @public
 */
export interface LAFSCommandOptions {
  /** Whether to force JSON output. @defaultValue `false` */
  json?: boolean;
  /** Whether to force human-readable output. @defaultValue `false` */
  human?: boolean;
  [key: string]: unknown;
}

/**
 * Handles format resolution errors consistently.
 *
 * @remarks
 * When `jsonFlag` is true the error is emitted as a LAFS JSON envelope to
 * stderr; otherwise a plain text message is written. The process always
 * exits with code 1.
 *
 * @param error - The error that occurred during format resolution
 * @param operation - Operation identifier
 * @param mvi - Machine-Verified Instruction disclosure level
 * @param jsonFlag - Whether `--json` flag was explicitly set
 * @returns never (exits process)
 *
 * @example
 * ```typescript
 * try {
 *   format = resolveFormat({ jsonFlag: opts.json, humanFlag: opts.human });
 * } catch (error) {
 *   handleFormatError(error, "skills.list", "full", opts.json);
 * }
 * ```
 *
 * @public
 */
export function handleFormatError(
  error: unknown,
  operation: string,
  mvi: MVILevel,
  jsonFlag: boolean | undefined,
): never {
  const message = error instanceof Error ? error.message : String(error);

  if (jsonFlag) {
    emitJsonError(operation, mvi, 'E_FORMAT_CONFLICT', message, 'VALIDATION');
  } else {
    // eslint-disable-next-line no-console
    console.error(message);
  }
  process.exit(1);
}

/**
 * Common error categories mapping for convenience.
 *
 * @public
 */
export const ErrorCategories = {
  VALIDATION: 'VALIDATION' as LAFSErrorCategory,
  AUTH: 'AUTH' as LAFSErrorCategory,
  PERMISSION: 'PERMISSION' as LAFSErrorCategory,
  NOT_FOUND: 'NOT_FOUND' as LAFSErrorCategory,
  CONFLICT: 'CONFLICT' as LAFSErrorCategory,
  RATE_LIMIT: 'RATE_LIMIT' as LAFSErrorCategory,
  TRANSIENT: 'TRANSIENT' as LAFSErrorCategory,
  INTERNAL: 'INTERNAL' as LAFSErrorCategory,
  CONTRACT: 'CONTRACT' as LAFSErrorCategory,
  MIGRATION: 'MIGRATION' as LAFSErrorCategory,
} as const;

/**
 * Common error codes for consistency.
 *
 * @public
 */
export const ErrorCodes = {
  // Format errors
  FORMAT_CONFLICT: 'E_FORMAT_CONFLICT',
  INVALID_JSON: 'E_INVALID_JSON',

  // Not found errors
  SKILL_NOT_FOUND: 'E_SKILL_NOT_FOUND',
  PROVIDER_NOT_FOUND: 'E_PROVIDER_NOT_FOUND',
  MCP_SERVER_NOT_FOUND: 'E_MCP_SERVER_NOT_FOUND',
  FILE_NOT_FOUND: 'E_FILE_NOT_FOUND',

  // Validation errors
  INVALID_INPUT: 'E_INVALID_INPUT',
  INVALID_CONSTRAINT: 'E_INVALID_CONSTRAINT',
  INVALID_FORMAT: 'E_INVALID_FORMAT',

  // Operation errors
  INSTALL_FAILED: 'E_INSTALL_FAILED',
  REMOVE_FAILED: 'E_REMOVE_FAILED',
  UPDATE_FAILED: 'E_UPDATE_FAILED',
  VALIDATION_FAILED: 'E_VALIDATION_FAILED',
  AUDIT_FAILED: 'E_AUDIT_FAILED',

  // System errors
  NETWORK_ERROR: 'E_NETWORK_ERROR',
  FILE_SYSTEM_ERROR: 'E_FILE_SYSTEM_ERROR',
  PERMISSION_DENIED: 'E_PERMISSION_DENIED',
  INTERNAL_ERROR: 'E_INTERNAL_ERROR',
} as const;
