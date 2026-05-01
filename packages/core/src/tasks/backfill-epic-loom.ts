/**
 * Backfill LOOM lifecycle pipelines for existing active epics.
 *
 * Scans all epics whose `status` is not `done` or `cancelled` and initializes
 * the RCASD-IVTR lifecycle pipeline (research stage / in_progress) for any
 * that have not already been initialized.
 *
 * This is a one-shot migration helper for epics created before T1634 wired
 * LOOM auto-init into `cleo add --type epic`. Re-running on an already-
 * initialized epic is a no-op (idempotent via `initLoomForEpic`).
 *
 * @task T1634
 */

import { initLoomForEpic } from '../orchestrate/lifecycle-ops.js';
import { getAccessor } from '../store/data-accessor.js';

/** Result for a single epic during backfill. */
export interface BackfillEpicResult {
  /** Epic task ID. */
  epicId: string;
  /** Whether LOOM was freshly initialized during this run. */
  initialized: boolean;
  /** Whether LOOM was already initialized (no-op). */
  alreadyInitialized: boolean;
  /** Non-fatal error message, if initialization failed for this epic. */
  error?: string;
}

/** Aggregate result of the backfill operation. */
export interface BackfillLoomResult {
  /** Total number of active epics scanned. */
  total: number;
  /** Epics that had LOOM newly initialized. */
  initialized: number;
  /** Epics that were already initialized (skipped). */
  skipped: number;
  /** Epics that encountered an error during initialization. */
  errors: number;
  /** Per-epic breakdown. */
  results: BackfillEpicResult[];
}

/**
 * Backfill LOOM for all active epics in the project.
 *
 * Queries all epics where `status` is not `done` or `cancelled`, then calls
 * `initLoomForEpic` for each one. `initLoomForEpic` is idempotent — already-
 * initialized epics are skipped silently.
 *
 * @param projectRoot - Project root directory (where `.cleo/` lives).
 * @returns Aggregate backfill result with per-epic breakdown.
 *
 * @example
 * ```ts
 * const result = await backfillEpicLoom('/mnt/projects/myapp');
 * console.log(`Initialized ${result.initialized} / ${result.total} epics`);
 * ```
 */
export async function backfillEpicLoom(projectRoot: string): Promise<BackfillLoomResult> {
  const accessor = await getAccessor(projectRoot);

  // Query all epics (type=epic) that are not terminal.
  // excludeStatus filters done+cancelled so we only process active epics.
  const { tasks } = await accessor.queryTasks({
    type: 'epic',
    excludeStatus: ['done', 'cancelled'],
  });
  const activeEpics = tasks;

  const results: BackfillEpicResult[] = [];
  let initialized = 0;
  let skipped = 0;
  let errors = 0;

  for (const epic of activeEpics) {
    const result = await initLoomForEpic(epic.id, projectRoot);
    const entry: BackfillEpicResult = {
      epicId: epic.id,
      initialized: result.initialized,
      alreadyInitialized: result.alreadyInitialized,
      error: result.error,
    };
    results.push(entry);

    if (result.error) {
      errors++;
    } else if (result.initialized) {
      initialized++;
    } else {
      skipped++;
    }
  }

  return {
    total: activeEpics.length,
    initialized,
    skipped,
    errors,
    results,
  };
}
