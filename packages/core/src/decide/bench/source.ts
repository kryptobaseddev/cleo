/**
 * The store-backed {@link BenchSource}: reads tasks through the task data
 * accessor and observations and decisions through the brain accessor — the
 * core accessors only, never raw SQL on `.cleo/*.db` (T12495).
 *
 * @task T12495
 * @epic T12486
 */

import { TASK_STATUSES } from '@cleocode/contracts';
import type {
  BenchDecisionRecord,
  BenchObservationRecord,
  BenchSource,
  BenchTaskRecord,
} from './types.js';

/**
 * A {@link BenchSource} over the project's stores.
 *
 * Tasks include every status (cancelled and archived too); observations and
 * decisions include history (invalidated and superseded rows), because the
 * labels come from exactly those records.
 *
 * @param projectRoot - Project root whose stores are read.
 * @returns The source; each method opens its accessor lazily.
 */
export function createStoreBenchSource(projectRoot: string): BenchSource {
  return {
    async tasks(): Promise<readonly BenchTaskRecord[]> {
      const { getTaskAccessor } = await import('../../store/data-accessor.js');
      const accessor = await getTaskAccessor(projectRoot);
      const { tasks } = await accessor.queryTasks({ status: [...TASK_STATUSES] });
      return tasks.map((t) => ({
        id: t.id,
        title: t.title ?? '',
        description: t.description ?? '',
        status: t.status,
        parentId: t.parentId ?? null,
        ...(t.cancellationReason ? { cancellationReason: t.cancellationReason } : {}),
        notes: t.notes ?? [],
        relates: (t.relates ?? []).map((r) => ({
          taskId: r.taskId,
          type: r.type,
          ...(r.reason ? { reason: r.reason } : {}),
        })),
      }));
    },
    async observations(): Promise<readonly BenchObservationRecord[]> {
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const accessor = await getBrainAccessor(projectRoot);
      const rows = await accessor.findObservations({ includeHistory: true });
      return rows.map((o) => ({
        id: o.id,
        type: o.type,
        title: o.title,
        narrative: o.narrative ?? '',
      }));
    },
    async decisions(): Promise<readonly BenchDecisionRecord[]> {
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const accessor = await getBrainAccessor(projectRoot);
      const rows = await accessor.findDecisions({ includeHistory: true });
      return rows.map((d) => ({
        id: d.id,
        type: d.type,
        decision: d.decision,
        rationale: d.rationale,
        supersedes: d.supersedes ?? null,
        supersededBy: d.supersededBy ?? null,
      }));
    },
  };
}
