/**
 * Fan-out worker dispatch (T409 · T433, moved from the CLI in T14359).
 *
 * Spawns one worker per item through {@link orchestrateSpawnExecute} with
 * `Promise.allSettled`, so one failed spawn never aborts the others. Every
 * worker left running gets a durable record (see `worker-records.ts`).
 *
 * @module orchestrate/dispatch-workers
 * @task T14359
 */

import { type EngineResult, engineError } from '../engine-result.js';
import { getLogger } from '../logger.js';
import { type OrchestrateSpawnExecuteOpts, orchestrateSpawnExecute } from './spawn-ops.js';

/** One worker to dispatch. */
export interface DispatchWorkerItem {
  /** Team name the task is routed to. */
  team: string;
  /** Task to spawn a worker for. */
  taskId: string;
  /** Optional skill to inject into the spawn context. */
  skill?: string;
}

/** Outcome of dispatching one worker. */
export interface DispatchWorkerResult {
  /** Task ID. */
  taskId: string;
  /** Outcome status. */
  status: 'spawned' | 'failed';
  /** Adapter instance ID returned by the spawn adapter, when available. */
  instanceId?: string;
  /** Error message if status is failed. */
  error?: string;
  /** Actionable refusal details, retained for failed fanout entries. */
  refusal?: Extract<EngineResult, { success: false }>['error'];
}

/** Data of a successful {@link dispatchWorkers} call. */
export interface DispatchWorkersData {
  /** Id of this fan-out batch. */
  manifestEntryId: string;
  /** Per-item outcomes, in input order. */
  results: DispatchWorkerResult[];
  /** Number of items given. */
  total: number;
  /** Number of workers spawned. */
  spawned: number;
  /** Number of items that failed to spawn. */
  failed: number;
}

/**
 * Dispatch one worker per item in parallel.
 *
 * @param items - Workers to dispatch.
 * @param projectRoot - Project root.
 * @param options - Shared execution port for this batch's workers.
 * @returns Engine result carrying {@link DispatchWorkersData}.
 */
export async function dispatchWorkers(
  items: DispatchWorkerItem[],
  projectRoot: string,
  options: Pick<OrchestrateSpawnExecuteOpts, 'orca'> = {},
): Promise<EngineResult<DispatchWorkersData>> {
  const manifestEntryId = `fanout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const settled = await Promise.allSettled(
      items.map(async (item): Promise<DispatchWorkerResult> => {
        const spawnResult = await orchestrateSpawnExecute(
          item.taskId,
          undefined,
          undefined,
          projectRoot,
          undefined,
          options,
        );
        if (!spawnResult.success) {
          return {
            taskId: item.taskId,
            status: 'failed',
            error: spawnResult.error?.message ?? `Spawn failed for task ${item.taskId}`,
            refusal: spawnResult.error,
          };
        }
        const data = spawnResult.data as Record<string, unknown> | undefined;
        return {
          taskId: item.taskId,
          status: 'spawned',
          instanceId: typeof data?.instanceId === 'string' ? data.instanceId : undefined,
        };
      }),
    );

    const results: DispatchWorkerResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      return {
        taskId: items[i]!.taskId,
        status: 'failed',
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      };
    });

    return {
      success: true,
      data: {
        manifestEntryId,
        results,
        total: items.length,
        spawned: results.filter((r) => r.status === 'spawned').length,
        failed: results.filter((r) => r.status === 'failed').length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('engine:orchestrate').error({ operation: 'fanout', err: error }, message);
    return engineError('E_FANOUT_FAILED', message);
  }
}
