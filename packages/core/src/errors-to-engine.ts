/**
 * Canonical helper for converting caught errors to {@link EngineResult} failures
 * with the real LAFS error code preserved.
 *
 * Generalizes the T9838-D fix that was applied inline in `tasks/update.ts`
 * to ALL engine-result wrappers across the tasks domain. Before this
 * SSoT, every catch block in `tasks/*.ts` was blanket-labelling errors as
 * `E_NOT_INITIALIZED`, hiding the real failure mode whenever a
 * {@link CleoError} (e.g. `T877_INVARIANT_VIOLATION`, validation rejects,
 * DB trigger violations) bubbled out of `coreTask*` functions.
 *
 * Use this helper in every `try { … } catch (err: unknown) { … }` block
 * where the body returns an `EngineResult`. Non-CleoError values fall
 * through to the supplied `fallbackCode`.
 *
 * @task T9940
 * @epic T9862
 */

import { type EngineResult, engineError } from './engine-result.js';
import { CleoError } from './errors.js';

/**
 * Convert a caught value into an {@link EngineResult} failure.
 *
 * - When the caught value is a {@link CleoError}, the LAFS code from
 *   `toLAFSError()` (`E_CLEO_VALIDATION`, `E_CLEO_NOT_FOUND`, etc.) is
 *   used. The original numeric `code` is forwarded as `exitCode`, and the
 *   rich `fix` / `alternatives` / `details` fields are propagated.
 * - When the caught value is NOT a CleoError (e.g. a plain `Error`, a
 *   string, or `null`), the supplied `fallbackCode` and `fallbackMessage`
 *   are used. The default `fallbackCode` is `'E_INTERNAL'`, which is more
 *   diagnostic than the historic `'E_NOT_INITIALIZED'` blanket label.
 *
 * @param err - The caught error value (type `unknown`).
 * @param fallbackCode - LAFS code used when `err` is not a CleoError.
 *   Defaults to `'E_INTERNAL'`.
 * @param fallbackMessage - Human-readable message used when `err.message`
 *   is absent. Defaults to `'Operation failed'`.
 * @returns A failure-shaped {@link EngineResult}.
 *
 * @example
 * ```ts
 * try {
 *   const result = await coreTaskCancel(projectRoot, taskId);
 *   return engineSuccess(result);
 * } catch (err: unknown) {
 *   return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to cancel task');
 * }
 * ```
 *
 * @task T9940
 */
export function cleoErrorToEngineResult<T>(
  err: unknown,
  fallbackCode = 'E_INTERNAL',
  fallbackMessage = 'Operation failed',
): EngineResult<T> {
  if (err instanceof CleoError) {
    const lafs = err.toLAFSError();
    return engineError<T>(lafs.code, err.message, {
      exitCode: err.code,
      ...(err.fix !== undefined ? { fix: err.fix } : {}),
      ...(err.alternatives !== undefined ? { alternatives: err.alternatives } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }
  const e = err as { message?: string };
  return engineError<T>(fallbackCode, e?.message ?? fallbackMessage);
}
