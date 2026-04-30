/**
 * Task Sync Sub-Domain — EngineResult-returning wrappers for external task sync.
 *
 * Provides taskSyncReconcile, taskSyncLinks, and taskSyncLinksRemove as
 * EngineResult-returning functions, moving this logic from task-engine.ts into
 * core/tasks/ per the T1566 engine-migration epic (ADR-057, ADR-058).
 *
 * @task T1568
 * @epic T1566
 * @adr ADR-057
 * @adr ADR-058
 */

import type {
  ConflictPolicy,
  ExternalTask,
  ExternalTaskLink,
  ReconcileResult,
} from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { reconcile } from '../reconciliation/index.js';
import {
  getLinksByProvider,
  getLinksByTaskId,
  removeLinksByProvider,
} from '../reconciliation/link-store.js';
import { getAccessor } from '../store/data-accessor.js';

/**
 * Reconcile external tasks with CLEO as SSoT.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Reconciliation parameters including provider ID and external tasks
 * @returns EngineResult with reconciliation results
 *
 * @task T1568
 * @epic T1566
 */
export async function taskSyncReconcile(
  projectRoot: string,
  params: {
    providerId: string;
    externalTasks: ExternalTask[];
    dryRun?: boolean;
    conflictPolicy?: string;
    defaultPhase?: string;
    defaultLabels?: string[];
  },
): Promise<EngineResult<ReconcileResult>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await reconcile(
      params.externalTasks,
      {
        providerId: params.providerId,
        cwd: projectRoot,
        dryRun: params.dryRun,
        conflictPolicy: params.conflictPolicy as ConflictPolicy | undefined,
        defaultPhase: params.defaultPhase,
        defaultLabels: params.defaultLabels,
      },
      accessor,
    );
    return engineSuccess(result);
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError('E_INTERNAL', e?.message ?? 'Sync reconcile failed');
  }
}

/**
 * List external task links by provider or task ID.
 *
 * @param projectRoot - Absolute path to the project root
 * @param params - Optional provider ID or task ID filter
 * @returns EngineResult with links array and count
 *
 * @task T1568
 * @epic T1566
 */
export async function taskSyncLinks(
  projectRoot: string,
  params?: { providerId?: string; taskId?: string },
): Promise<EngineResult<{ links: ExternalTaskLink[]; count: number }>> {
  try {
    if (params?.taskId) {
      const links = await getLinksByTaskId(params.taskId, projectRoot);
      return engineSuccess({ links, count: links.length });
    }

    if (params?.providerId) {
      const links = await getLinksByProvider(params.providerId, projectRoot);
      return engineSuccess({ links, count: links.length });
    }

    return engineError('E_INVALID_INPUT', 'Either providerId or taskId is required');
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError('E_INTERNAL', e?.message ?? 'Failed to list links');
  }
}

/**
 * Remove all external task links for a provider.
 *
 * @param projectRoot - Absolute path to the project root
 * @param providerId - Provider ID whose links to remove
 * @returns EngineResult with count of removed links
 *
 * @task T1568
 * @epic T1566
 */
export async function taskSyncLinksRemove(
  projectRoot: string,
  providerId: string,
): Promise<EngineResult<{ providerId: string; removed: number }>> {
  try {
    const removed = await removeLinksByProvider(providerId, projectRoot);
    return engineSuccess({ providerId, removed });
  } catch (err: unknown) {
    const e = err as { message?: string };
    return engineError('E_INTERNAL', e?.message ?? 'Failed to remove links');
  }
}
