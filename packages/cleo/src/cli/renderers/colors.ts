/**
 * Re-export shim — color and symbol utilities now live in `@cleocode/core/render`.
 *
 * Kept as a thin shim so that `packages/cleo/src/cli/commands/status.ts` and
 * `packages/cleo/src/cli/renderers/tasks.ts` (the B8 worker's domain) continue
 * to import from their historical location without B6 needing to coordinate
 * a cross-file rename.
 *
 * Migrated by T10131 (B6). Delete this shim once status.ts and tasks.ts have
 * been updated to import directly from `@cleocode/core`.
 *
 * @task T10131
 */

export {
  BLUE,
  BOLD,
  BOX,
  CYAN,
  DIM,
  GREEN,
  hRule,
  MAGENTA,
  NC,
  priorityColor,
  prioritySymbol,
  RED,
  shortDate,
  statusColor,
  statusSymbol,
  YELLOW,
} from '@cleocode/core';
