/**
 * Flag semantics for LAFS output format resolution.
 *
 * Implements the precedence chain defined in LAFS spec sections 5.1-5.3:
 * explicit flag > project config > user config > TTY detection > default (json).
 *
 * @remarks
 * This module is the single-layer resolver for format flags. For cross-layer
 * resolution that also includes field extraction, use {@link resolveFlags} from
 * `flagResolver.ts`.
 *
 * @since 1.0.0
 */

import { getRegistryCode } from './errorRegistry.js';
import type { FlagInput, LAFSError, LAFSErrorCategory } from './types.js';

/**
 * Result of resolving output format flags.
 *
 * @remarks
 * Captures both the resolved format and which configuration layer determined it,
 * enabling diagnostics and cross-layer validation in the unified resolver.
 */
export interface FlagResolution {
  /** The resolved output format: `'json'` for machine-readable or `'human'` for human-readable. */
  format: 'json' | 'human';
  /** Which configuration layer determined the format value. */
  source: 'flag' | 'project' | 'user' | 'default';
  /** When true, suppress non-essential output for scripting. */
  quiet: boolean;
}

/**
 * Error thrown when LAFS flag validation fails.
 *
 * @remarks
 * Wraps a registered LAFS error code with category and retryability information
 * looked up from the error registry. The most common error is `E_FORMAT_CONFLICT`
 * when `--human` and `--json` are used together.
 */
export class LAFSFlagError extends Error implements LAFSError {
  /** The LAFS error code (e.g. `'E_FORMAT_CONFLICT'`). */
  code: string;
  /** The error category resolved from the error registry. */
  category: LAFSErrorCategory;
  /** Whether the operation that produced this error can be retried. */
  retryable: boolean;
  /** Milliseconds to wait before retrying, or `null` if not applicable. */
  retryAfterMs: number | null;
  /** Additional structured details about the error. */
  details: Record<string, unknown>;

  /**
   * Create a new LAFSFlagError.
   *
   * @param code - A registered LAFS error code (e.g. `'E_FORMAT_CONFLICT'`)
   * @param message - Human-readable description of the error
   * @param details - Optional structured details to attach to the error
   *
   * @remarks
   * Looks up the error code in the LAFS error registry to populate
   * `category` and `retryable`. Falls back to `'CONTRACT'` category
   * and non-retryable if the code is not found.
   *
   * @example
   * ```ts
   * throw new LAFSFlagError(
   *   'E_FORMAT_CONFLICT',
   *   'Cannot combine --human and --json.',
   * );
   * ```
   */
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LAFSFlagError';
    this.code = code;
    const entry = getRegistryCode(code);
    this.category = (entry?.category ?? 'CONTRACT') as LAFSErrorCategory;
    this.retryable = entry?.retryable ?? false;
    this.retryAfterMs = null;
    this.details = details;
  }
}

/**
 * Resolve the output format from flag inputs using the LAFS precedence chain.
 *
 * @param input - The flag inputs including explicit flags, project/user defaults, and TTY state
 * @returns The resolved format, its source layer, and quiet mode status
 *
 * @remarks
 * Precedence (highest to lowest): explicit `requestedFormat` > `--human`/`--json` flag >
 * project default > user default > TTY detection > protocol default (`'json'`).
 * Throws `LAFSFlagError` with code `E_FORMAT_CONFLICT` if both `--human` and `--json`
 * are set simultaneously.
 *
 * @example
 * ```ts
 * const resolution = resolveOutputFormat({ humanFlag: true });
 * // => { format: 'human', source: 'flag', quiet: false }
 * ```
 *
 * @throws {@link LAFSFlagError} When `humanFlag` and `jsonFlag` are both truthy.
 */
export function resolveOutputFormat(input: FlagInput): FlagResolution {
  if (input.humanFlag && input.jsonFlag) {
    throw new LAFSFlagError(
      'E_FORMAT_CONFLICT',
      'Cannot combine --human and --json in the same invocation.',
    );
  }

  const quiet = input.quiet ?? false;

  if (input.requestedFormat) {
    return { format: input.requestedFormat, source: 'flag', quiet };
  }
  if (input.humanFlag) {
    return { format: 'human', source: 'flag', quiet };
  }
  if (input.jsonFlag) {
    return { format: 'json', source: 'flag', quiet };
  }
  if (input.projectDefault) {
    return { format: input.projectDefault, source: 'project', quiet };
  }
  if (input.userDefault) {
    return { format: input.userDefault, source: 'user', quiet };
  }
  // TTY terminals default to human-readable output for usability.
  // Non-TTY (piped, CI, agents) defaults to JSON per LAFS protocol.
  if (input.tty) {
    return { format: 'human', source: 'default', quiet };
  }
  return { format: 'json', source: 'default', quiet };
}
