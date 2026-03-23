/**
 * Shared memory bridge refresh helper for hook handlers.
 *
 * Provides a config-gated, debounced wrapper around refreshMemoryBridge().
 * Prevents rapid regeneration of .cleo/memory-bridge.md when multiple
 * lifecycle events fire in quick succession (e.g. session end + task complete).
 *
 * Debounce: max one refresh per 30 seconds across all callers in the process.
 *
 * @task T138
 * @epic T134
 */

/** Debounce window in milliseconds. */
const DEBOUNCE_MS = 30_000;

/** Timestamp of the last successful refresh call (module-level singleton). */
let lastRefreshTime = 0;

/**
 * Refresh the memory bridge if autoRefresh is enabled and the debounce window
 * has elapsed. Reads config via loadConfig() (cascaded). Never throws.
 *
 * @param projectRoot - Absolute path to the project root directory.
 */
export async function maybeRefreshMemoryBridge(projectRoot: string): Promise<void> {
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);

    if (!config.brain?.memoryBridge?.autoRefresh) {
      return;
    }

    const now = Date.now();
    if (now - lastRefreshTime < DEBOUNCE_MS) {
      return;
    }

    lastRefreshTime = now;

    const { refreshMemoryBridge } = await import('../../memory/memory-bridge.js');
    await refreshMemoryBridge(projectRoot);
  } catch {
    // Best-effort: never block lifecycle events
  }
}
