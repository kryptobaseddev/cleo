/**
 * CLEO error types with exit code integration, LAFS error shape,
 * and RFC 9457 Problem Details support.
 *
 * @epic T4654
 * @task T4655
 * @task T5240
 */

import type { LAFSError, LAFSErrorCategory } from '@cleocode/lafs-protocol';
import { ExitCode, getExitCodeName, isRecoverableCode } from '../types/exit-codes.js';
import { getErrorDefinition } from './error-catalog.js';

/**
 * RFC 9457 Problem Details object.
 * Structured error representation for API/MCP responses.
 *
 * @task T5240
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  extensions?: Record<string, unknown>;
}

/**
 * Map numeric exit codes to LAFS error category.
 *
 * @task T4655
 */
function exitCodeToCategory(code: ExitCode): LAFSErrorCategory {
  const def = getErrorDefinition(code);
  if (def) return def.category;

  if (code >= 1 && code <= 9) {
    switch (code) {
      case ExitCode.NOT_FOUND:
        return 'NOT_FOUND';
      case ExitCode.VALIDATION_ERROR:
        return 'VALIDATION';
      case ExitCode.CONFIG_ERROR:
        return 'VALIDATION';
      case ExitCode.LOCK_TIMEOUT:
        return 'CONFLICT';
      default:
        return 'INTERNAL';
    }
  }
  if (code >= 10 && code <= 19) return 'VALIDATION'; // hierarchy
  if (code >= 20 && code <= 29) return 'CONFLICT'; // concurrency
  if (code >= 30 && code <= 39) return 'CONTRACT'; // session
  if (code >= 40 && code <= 47) return 'VALIDATION'; // verification
  if (code >= 50 && code <= 54) return 'CONTRACT'; // context safeguard
  if (code >= 60 && code <= 67) return 'CONTRACT'; // orchestrator
  if (code >= 70 && code <= 79) return 'INTERNAL'; // nexus
  if (code >= 80 && code <= 84) return 'CONTRACT'; // lifecycle
  if (code >= 85 && code <= 89) return 'VALIDATION'; // artifact
  if (code >= 90 && code <= 94) return 'VALIDATION'; // provenance
  if (code >= 95 && code <= 99) return 'INTERNAL'; // adapter
  return 'INTERNAL';
}

/**
 * Map numeric exit code to LAFS string error code (E_CATEGORY_DETAIL).
 *
 * @task T4655
 */
function exitCodeToLafsCode(code: ExitCode): string {
  const def = getErrorDefinition(code);
  if (def) return def.lafsCode;

  const name = getExitCodeName(code);
  const category = exitCodeToCategory(code);
  return `E_${category}_${name}`;
}

/**
 * Structured error class for CLEO operations.
 * Carries an exit code, human-readable message, and optional fix suggestions.
 * Produces LAFS-conformant error shapes via toLAFSError() and RFC 9457
 * Problem Details via toProblemDetails().
 */
export class CleoError extends Error {
  readonly code: ExitCode;
  readonly fix?: string;
  readonly alternatives?: Array<{ action: string; command: string }>;

  constructor(
    code: ExitCode,
    message: string,
    options?: {
      fix?: string;
      alternatives?: Array<{ action: string; command: string }>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'CleoError';
    this.code = code;
    this.fix = options?.fix;
    this.alternatives = options?.alternatives;
  }

  /**
   * Produce a LAFS-conformant error object.
   *
   * @task T4655
   */
  toLAFSError(): LAFSError {
    return {
      code: exitCodeToLafsCode(this.code),
      message: this.message,
      category: exitCodeToCategory(this.code),
      retryable: isRecoverableCode(this.code),
      retryAfterMs: null,
      details: {
        exitCode: this.code,
        name: getExitCodeName(this.code),
        ...(this.fix && { fix: this.fix }),
        ...(this.alternatives && { alternatives: this.alternatives }),
      },
    };
  }

  /**
   * Produce an RFC 9457 Problem Details object.
   *
   * @task T5240
   */
  toProblemDetails(): ProblemDetails {
    const def = getErrorDefinition(this.code);
    return {
      type: `urn:cleo:error:${this.code}`,
      title: getExitCodeName(this.code),
      status: def?.httpStatus ?? this.getHttpStatus(),
      detail: this.message,
      instance: undefined,
      extensions: {
        code: this.code,
        lafsCode: exitCodeToLafsCode(this.code),
        category: exitCodeToCategory(this.code),
        recoverable: isRecoverableCode(this.code),
        ...(this.fix && { fix: this.fix }),
        ...(this.alternatives && { alternatives: this.alternatives }),
      },
    };
  }

  /** Structured JSON representation for LAFS output (backward compatible). */
  toJSON(): Record<string, unknown> {
    return {
      success: false,
      error: {
        code: this.code,
        name: getExitCodeName(this.code),
        message: this.message,
        ...(this.fix && { fix: this.fix }),
        ...(this.alternatives && { alternatives: this.alternatives }),
      },
    };
  }

  /**
   * Derive HTTP status from exit code range.
   * Used as fallback when catalog lookup misses.
   */
  private getHttpStatus(): number {
    const c = this.code;
    if (c === 0 || c >= 100) return 200;
    if (c === ExitCode.NOT_FOUND || c === ExitCode.PARENT_NOT_FOUND || c === ExitCode.SESSION_NOT_FOUND) return 404;
    if (c >= 20 && c <= 29) return 409; // conflict
    if (c === ExitCode.LOCK_TIMEOUT) return 409;
    if (c >= 50 && c <= 54) return 429; // rate limit / context
    if (c >= 1 && c <= 9) return 500;
    return 422;
  }
}
