/**
 * Internal formatting helpers shared by every nexus renderer family.
 *
 * Kept underscore-prefixed so the family barrels (`graph/index.ts`,
 * `contracts/index.ts`, `audit/index.ts`) do not re-export them — these
 * are migration-internal utilities, not part of the public render API.
 *
 * @epic T10114
 * @task T10132
 */

/**
 * Format a string field or fall back to a default.
 *
 * @param v The candidate value (any shape).
 * @param fallback Replacement used when `v` is `null` or `undefined`.
 */
export function str(v: unknown, fallback = '—'): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

/**
 * Format a number with optional left-padding.
 *
 * @param v The candidate value (any shape coercible by `Number(...)`).
 * @param width Minimum visible width — values shorter than `width` are
 *              left-padded with spaces. `0` disables padding.
 * @param fallback Replacement used when `v` is `null` or `undefined`.
 */
export function num(v: unknown, width = 0, fallback = '—'): string {
  if (v === null || v === undefined) return fallback;
  const s = String(Number(v));
  return width > 0 ? s.padStart(width) : s;
}
