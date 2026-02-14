/**
 * CLEO error types with exit code integration.
 * @epic T4454
 * @task T4456
 */

import { ExitCode, getExitCodeName } from '../types/exit-codes.js';

/**
 * Structured error class for CLEO operations.
 * Carries an exit code, human-readable message, and optional fix suggestions.
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

  /** Structured JSON representation for LAFS output. */
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
