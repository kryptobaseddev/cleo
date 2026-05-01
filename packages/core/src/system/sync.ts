/**
 * Sync operation core module.
 *
 * Provides the `systemSync` function and `SyncData` interface for the
 * `cleo admin sync` CLI command. In native mode there are no external sync
 * targets, so this is a no-op that reports zero synced items.
 *
 * @task T4631
 * @task T1571
 */

/** Result of a sync operation. */
export interface SyncData {
  /** Sync direction (up, down, both). */
  direction: string;
  /** Number of items synced. */
  synced: number;
  /** Number of sync conflicts detected. */
  conflicts: number;
  /** Human-readable status message. */
  message: string;
}

/**
 * Sync check (no-op in native mode).
 *
 * Reports that sync is unavailable because there are no external sync
 * targets configured in native mode. This is the canonical no-op
 * implementation moved from system-engine.ts.
 *
 * @param _projectRoot - Absolute path to the project root (unused)
 * @param params - Optional parameters including sync direction
 * @returns Sync result with zero synced items
 *
 * @task T4631
 * @task T1571
 */
export function systemSync(_projectRoot: string, params?: { direction?: string }): SyncData {
  return {
    direction: params?.direction ?? 'up',
    synced: 0,
    conflicts: 0,
    message: 'Sync is a no-op in native mode (no external sync targets configured)',
  };
}
