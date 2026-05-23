/**
 * `formatLabel` — convert a camelCase identifier to Title Case for human display.
 *
 * Shared by the session, orchestration, and brain renderer families. Extracted
 * from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6) so multiple
 * renderer files can use it without copy-pasting.
 *
 * @task T10131
 */

/** Convert camelCase to Title Case for display (e.g. `totalTasks` → `Total Tasks`). */
export function formatLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
