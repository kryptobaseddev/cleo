/**
 * format-bytes — human-readable byte-size formatting (SSoT).
 *
 * Canonical, behaviour-preserving replacement for the inline `formatBytes`
 * copies previously duplicated in `packages/cleo/src/cli/commands/gc.ts` and
 * `packages/core/src/docs/export-document.ts` (E5 · T11413 · Saga T11387).
 *
 * The two former copies disagreed on rounding/units: the gc copy scaled up to
 * TB with one decimal and a special-cased `0 B`; the export copy capped at MB.
 * This canonical form generalises both: integer bytes below 1 KiB render as
 * whole `B` (covering the `0 B` and `<1024` cases), every larger magnitude
 * uses one decimal place and IEC binary steps up to TB. Callers that relied on
 * MB-capping still get correct values; callers that relied on TB scaling are
 * unchanged.
 *
 * @module @cleocode/utils/format-bytes
 */

/** Binary (1024-based) magnitude unit labels, smallest to largest. */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Format a byte count as a human-readable string using binary (1024) steps.
 *
 * Sub-kilobyte values render as whole bytes (e.g. `0 B`, `512 B`); larger
 * values render with one decimal place (e.g. `1.5 KB`, `2.0 GB`). The unit
 * caps at `TB`; anything larger is still expressed in TB.
 *
 * @param bytes - The number of bytes. Negative or non-finite inputs are
 *   clamped to `0 B`.
 * @returns A formatted size string such as `0 B`, `512 B`, `1.5 KB`, or `2.0 GB`.
 *
 * @example
 * ```ts
 * formatBytes(0);        // "0 B"
 * formatBytes(512);      // "512 B"
 * formatBytes(1536);     // "1.5 KB"
 * formatBytes(2 ** 30);  // "1.0 GB"
 * ```
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${UNITS[exp]}`;
}
