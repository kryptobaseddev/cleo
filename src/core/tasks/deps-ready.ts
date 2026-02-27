/**
 * Shared dependency-readiness check.
 *
 * Used by plan, task-ops, and briefing modules to determine
 * if a task's dependencies are all satisfied.
 *
 * Accepts a loosely-typed map (including Map<string, unknown>) so all
 * consumers can use it without unsafe casts.
 *
 * @epic T4454
 */

/** Completed/cancelled statuses that satisfy dependencies. */
const SATISFIED_STATUSES = new Set<string>(['done', 'cancelled']);

/**
 * Check if all dependencies of a task are satisfied.
 *
 * @param depends - Array of dependency task IDs (may be undefined/empty)
 * @param taskLookup - Map from task ID to a task-like object with at least { status: string }
 * @returns true if all dependencies are done/cancelled, or if no dependencies exist
 */
export function depsReady(
  depends: string[] | undefined,
  taskLookup: ReadonlyMap<string, { status?: string } | unknown>,
): boolean {
  if (!depends || depends.length === 0) return true;
  return depends.every((depId) => {
    const dep = taskLookup.get(depId);
    if (dep === undefined || dep === null || typeof dep !== 'object') return false;
    const status = (dep as { status?: string }).status;
    return typeof status === 'string' && SATISFIED_STATUSES.has(status);
  });
}
