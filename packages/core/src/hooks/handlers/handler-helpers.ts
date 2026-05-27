/**
 * Shared helpers for hook handler modules.
 *
 * Centralises the two patterns repeated across all brain-capture handlers:
 *
 * 1. `isMissingBrainSchemaError` — detects the "no such table: brain_*" error
 *    thrown when brain.db has not been migrated yet, so handlers can swallow
 *    it silently instead of crashing agent workflows.
 *
 * 2. `isAutoCaptureEnabled` — reads `brain.autoCapture` from the cascaded
 *    project config and returns false when the config is unreadable.
 *
 * Import these instead of redefining them in each handler file.
 *
 * @task T166
 * @epic T134
 */

// ---------------------------------------------------------------------------
// Brain schema error guard
// ---------------------------------------------------------------------------

/**
 * Return true when the error is the "no such table: brain_*" SQLite error
 * thrown before brain.db has been migrated.
 *
 * Hook handlers use this to swallow migration-lag errors without hiding
 * genuine failures: if the error is NOT a missing-schema error it is
 * re-thrown so it propagates normally.
 *
 * @param err - The caught error value (may be any type).
 */
export function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

// ---------------------------------------------------------------------------
// Auto-capture config gate
// ---------------------------------------------------------------------------

/**
 * Return true when `brain.autoCapture` is enabled for the given project.
 *
 * Resolution order (first truthy wins):
 *   1. `brain.autoCapture` project config value (via `loadConfig` cascade)
 *
 * Defaults to `false` when the config is unreadable or the key is absent,
 * so handlers are safely disabled in environments where brain.db is not set up.
 *
 * @param projectRoot - Absolute path to the project root directory.
 */
export async function isAutoCaptureEnabled(projectRoot: string): Promise<boolean> {
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    return config.brain?.autoCapture ?? false;
  } catch {
    return false;
  }
}
