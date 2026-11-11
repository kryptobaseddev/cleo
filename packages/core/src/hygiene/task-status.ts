/**
 * Census task-status reads with immutable snapshots for foreign projects.
 * @packageDocumentation
 */

import type { EngineResult } from '@cleocode/contracts';
import { engineError, engineSuccess } from '@cleocode/contracts/engine-result.js';
import { computeProjectHash } from '@cleocode/paths';
import { projectStoreReadVerdict } from '../doctor/migrations.js';
import { worktreeScope } from '../project-scope.js';
import { openProjectTasksReadOnly } from '../store/sqlite.js';
import { claimClockNow, DERIVED_STATUS_SQL } from '../store/task-claim.js';
import { loadOwningTaskStatuses } from '../worktree/list.js';

/**
 * Read census task statuses after ownership has been established. Foreign
 * results are immutable display snapshots and confer no disposal authority.
 *
 * @param taskIds - Tasks named by the project's worktrees.
 * @param projectRoot - The project whose store will be read.
 * @param own - Ownership decided before any store access.
 * @returns Task statuses, or a failure that the census labels status unknown.
 * @remarks Foreign snapshots may omit uncheckpointed WAL writes and never authorize disposal.
 * @example
 * ```ts
 * const result = await loadCensusTaskStatuses(['T1'], '/workspace/project', false);
 * ```
 */
export async function loadCensusTaskStatuses(
  taskIds: string[],
  projectRoot: string,
  own: boolean,
): Promise<EngineResult<Map<string, string>>> {
  if (own) return loadOwningTaskStatuses(taskIds, projectRoot);
  try {
    // Scope the explicit foreign target so an ambient CLEO_DIR cannot redirect it.
    const snapshot = worktreeScope.run(
      { worktreeRoot: projectRoot, projectHash: computeProjectHash(projectRoot) },
      () =>
        projectStoreReadVerdict(projectRoot) === 'readable'
          ? openProjectTasksReadOnly(projectRoot)
          : null,
    );
    if (snapshot !== null) {
      try {
        const statuses = new Map<string, string>();
        if (taskIds.length > 0) {
          const placeholders = taskIds.map(() => '?').join(', ');
          const rows = snapshot.db
            .prepare(
              `SELECT id, ${DERIVED_STATUS_SQL} AS status FROM tasks_tasks WHERE id IN (${placeholders})`,
            )
            .all(claimClockNow(), ...taskIds);
          for (const row of rows) {
            if (typeof row.id === 'string' && typeof row.status === 'string')
              statuses.set(row.id, row.status);
          }
        }
        return engineSuccess(statuses);
      } finally {
        snapshot.close();
      }
    }
  } catch {
    // An incompatible or unavailable foreign snapshot never falls back to getDb.
  }
  // @sync-invariant none:local-only foreign census snapshots provide display status only
  return engineError('E_TASK_STATE_UNAVAILABLE', 'Foreign task snapshot unavailable', {
    fix: 'Run cleo doctor in the owning project to diagnose its store.',
  });
}
