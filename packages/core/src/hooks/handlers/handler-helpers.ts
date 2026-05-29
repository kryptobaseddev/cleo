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

/**
 * Return true when the error is the "No CLEO project found" resolution error
 * thrown by `resolveCleoDir` (CleoError `NEXUS_PROJECT_NOT_FOUND`) when no CLEO
 * project is resolvable from the current context.
 *
 * Brain-capture hooks are best-effort: an observation with no project to write
 * into is a no-op, not a crash. Handlers swallow this exactly like the
 * missing-schema case, so a context with no resolvable project never fails the
 * agent flow.
 *
 * This also closes a cross-file test-isolation leak (T11281): the
 * `brain-tool-complete` PostToolUse capture could resolve with no anchor inside a
 * shared vitest fork — most acutely in CI, where the gitignored
 * `.cleo/project-info.json` is absent — and the uncaught throw collateral-failed
 * sibling test files (saga-audit / invariant-audit). Swallowing it at the source
 * fixes the leak without a global env / resolution-precedence change.
 *
 * @param err - The caught error value (may be any type).
 */
export function isNoProjectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return String(err.message || '').includes('No CLEO project found');
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
