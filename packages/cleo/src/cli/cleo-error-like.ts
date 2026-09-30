/**
 * Duck-typed recognition of core `CleoError`s at the CLI entrypoint.
 *
 * Lives in its own module, not in `index.ts`, for the same reason as
 * `citty-error-envelope.ts`: `index.ts` ends in `void bootstrap()`, so
 * importing it from a unit test STARTS THE CLI. It also must not import
 * `@cleocode/core` statically — gate 25 forbids a core barrel in the
 * entrypoint's static import graph — so recognition is structural.
 *
 * @packageDocumentation
 */

/** The parts of a core `CleoError` the entrypoint needs (duck-typed: no core import here). */
export interface CleoErrorLike {
  /** Human-readable message. */
  message: string;
  /** Numeric exit code (`ExitCode`). */
  code: number;
  /** Stable machine-readable name some subclasses declare (e.g. `E_NEXUS_REGISTRY_READ`). */
  codeName?: string;
  /** Copy-paste remedy. */
  fix?: string;
  /** Alternative actions. */
  alternatives?: Array<{ action: string; command: string }>;
  /** Field-level details. */
  details?: Record<string, unknown>;
  /** LAFS error projection; its `code` is the LAFS code name. */
  toLAFSError(): { code: string };
}

/**
 * Narrow a thrown value to a core `CleoError` without importing core.
 *
 * T12512: this used to require `err.name === 'CleoError'`, so every subclass
 * that renames itself (`NexusRegistryReadError`, …) fell through to
 * `E_CLI_UNCAUGHT` with exit 1, losing its exit code, code name and fix.
 * Recognition is now structural: an `Error` with a numeric `code` and a
 * `toLAFSError()` method — the shape every `CleoError` subclass inherits.
 *
 * @param err - Any thrown value.
 * @returns The value typed as {@link CleoErrorLike}, or `null`.
 * @example
 * ```ts
 * const typed = asCleoErrorLike(err);
 * if (typed) process.exit(typed.code);
 * ```
 * @task T12512
 */
export function asCleoErrorLike(err: unknown): CleoErrorLike | null {
  if (!(err instanceof Error)) return null;
  const candidate = err as Error & Partial<CleoErrorLike>;
  return typeof candidate.code === 'number' &&
    Number.isInteger(candidate.code) &&
    typeof candidate.toLAFSError === 'function'
    ? (candidate as CleoErrorLike)
    : null;
}

/**
 * The code name to put in the error envelope: a subclass's own `codeName`
 * when it declares one, else the LAFS code derived from the exit code.
 *
 * @param typed - A recognised CleoError.
 * @returns The envelope `codeName`.
 * @task T12512
 */
export function cleoErrorCodeName(typed: CleoErrorLike): string {
  return typeof typed.codeName === 'string' && typed.codeName.length > 0
    ? typed.codeName
    : typed.toLAFSError().code;
}
