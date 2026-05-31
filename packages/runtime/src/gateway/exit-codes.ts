/**
 * Shared exit-code mapping utilities for the transport-agnostic gateway.
 *
 * Provides a canonical reverse lookup from numeric exit code to string error code,
 * shared between the gateway engine helpers and every transport adapter (CLI,
 * MCP, RPC, HTTP).
 *
 * @remarks
 * Relocated from `packages/cleo/src/dispatch/lib/exit-codes.ts` into
 * `@cleocode/runtime/gateway` (R3-K1 · T11455 · SG-RUNTIME-UNIFICATION) so the
 * runtime can host the shared handler dependencies without importing
 * `@cleocode/cleo`. A thin re-export shim remains at the old path.
 *
 * The forward mapping (string → number) lives in `engine-error.ts` as
 * `STRING_TO_EXIT`. This module derives the inverse on first call and memoises
 * it so engines can resolve a caught `CleoError.code` (numeric) to the
 * string code expected by `engineError()`.
 *
 * @task T374
 * @task T11455
 * @epic T335
 */

import { STRING_TO_EXIT } from './engine-error.js';

/** Lazily built inverse of STRING_TO_EXIT (number → string). */
let _inverseCache: Map<number, string> | null = null;

/**
 * Build and memoize the inverse of STRING_TO_EXIT.
 *
 * When multiple string codes map to the same exit number (e.g. E_GENERAL
 * and E_GENERAL_ERROR both map to 1), the first occurrence wins.
 */
function getInverseMap(): Map<number, string> {
  if (_inverseCache) return _inverseCache;

  const map = new Map<number, string>();
  for (const [key, value] of Object.entries(STRING_TO_EXIT)) {
    if (!map.has(value)) {
      map.set(value, key);
    }
  }
  _inverseCache = map;
  return map;
}

/**
 * Map a numeric CleoError exit code to the canonical string engine error code.
 *
 * @remarks
 * Returns `undefined` when the numeric code is not present in the
 * `STRING_TO_EXIT` map, allowing callers to fall back to their own default.
 *
 * @param numericCode - Numeric exit code from a caught `CleoError.code`
 * @returns Canonical string error code (e.g. `'E_NOT_FOUND'`), or `undefined`
 *
 * @example
 * ```typescript
 * import { mapNumericExitCodeToString } from '../lib/exit-codes.js';
 *
 * const code = mapNumericExitCodeToString(4) ?? 'E_NOT_INITIALIZED';
 * // → 'E_NOT_FOUND'
 * ```
 */
export function mapNumericExitCodeToString(numericCode: number | undefined): string | undefined {
  if (numericCode === undefined) return undefined;
  return getInverseMap().get(numericCode);
}
