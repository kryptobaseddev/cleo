/**
 * CLEO error types with exit code integration and LAFS error shape.
 *
 * @epic T4654
 * @task T4655
 */

import type { LAFSError, LAFSErrorCategory } from '@cleocode/lafs-protocol';
import { ExitCode, getExitCodeName, isRecoverableCode } from '../types/exit-codes.js';

/**
 * Map numeric exit codes to LAFS error category.
 *
 * @task T4655
 */
function exitCodeToCategory(code: ExitCode): LAFSErrorCategory {
  if (code >= 1 && code <= 9) {
    switch (code) {
      case ExitCode.NOT_FOUND: return 'NOT_FOUND';
      case ExitCode.VALIDATION_ERROR: return 'VALIDATION';
      case ExitCode.CONFIG_ERROR: return 'VALIDATION';
      case ExitCode.LOCK_TIMEOUT: return 'CONFLICT';
      default: return 'INTERNAL';
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
  return 'INTERNAL';
}

/**
 * Map numeric exit code to LAFS string error code (E_CATEGORY_DETAIL).
 *
 * @task T4655
 */
function exitCodeToLafsCode(code: ExitCode): string {
  const name = getExitCodeName(code);
  const category = exitCodeToCategory(code);
  return `E_${category}_${name}`;
}

/**
 * Structured error class for CLEO operations.
 * Carries an exit code, human-readable message, and optional fix suggestions.
 * Produces LAFS-conformant error shapes via toLAFSError().
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
}
