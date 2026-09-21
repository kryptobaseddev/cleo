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

import { isReadinessDependencySatisfied } from './dependency-check.js';

/**
 * Check if all dependencies of a task are satisfied.
 *
 * @param depends - Array of dependency task IDs (may be undefined/empty)
 * @param taskLookup - Map from task ID to a task-like object with at least { status: string }
 * @returns True if every dependency is done or archived, or no dependencies exist.
 *
 * @remarks
 * Uses the same execution-readiness policy as spawn validation. Cancelled work
 * remains a blocker; completion waivers do not authorize execution. Missing and
 * malformed dependency records are not evidence of satisfaction. Callers must
 * supply canonical dependency records, including archived records when relevant,
 * and surface read failures rather than passing an incomplete healthy lookup.
 *
 * @example
 * ```ts
 * depsReady(['T1'], new Map([['T1', { status: 'archived' }]])); // true
 * ```
 */
export function depsReady(
  depends: string[] | undefined,
  taskLookup: ReadonlyMap<string, { status?: string } | unknown>,
): boolean {
  if (!depends || depends.length === 0) return true;
  return depends.every((depId) => {
    const dep = taskLookup.get(depId);
    if (dep === undefined || dep === null || typeof dep !== 'object') return false;
    const status = 'status' in dep ? dep.status : undefined;
    return typeof status === 'string' && isReadinessDependencySatisfied(status);
  });
}
