/**
 * Provider-agnostic task reconciliation engine.
 *
 * Takes normalized ExternalTask[] from any provider adapter and reconciles
 * them against CLEO's authoritative task state. CLEO is always the SSoT.
 *
 * Provider-specific parsing is NEVER done here — that lives in the adapter's
 * AdapterTaskSyncProvider implementation.
 *
 * @task T5800
 */

import type {
  DataAccessor,
  ExternalTask,
  ReconcileAction,
  ReconcileOptions,
  ReconcileResult,
  SyncSessionState,
  Task,
} from '@cleocode/contracts';
import { getAccessor } from '../store/data-accessor.js';
import { addTask } from '../tasks/add.js';
import { completeTask } from '../tasks/complete.js';
import { updateTask } from '../tasks/update.js';
import { clearSyncState, readSyncState } from './sync-state.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a lookup map from CLEO task ID to Task for quick access.
 */
function buildTaskMap(tasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of tasks) {
    map.set(t.id, t);
  }
  return map;
}

/**
 * Compute reconciliation actions by diffing external tasks against CLEO state.
 */
function computeActions(
  externalTasks: ExternalTask[],
  taskMap: Map<string, Task>,
  injectedIds: Set<string>,
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];
  const seenCleoIds = new Set<string>();

  for (const ext of externalTasks) {
    // Case 1: External task maps to an existing CLEO task
    if (ext.cleoTaskId) {
      seenCleoIds.add(ext.cleoTaskId);
      const cleoTask = taskMap.get(ext.cleoTaskId);

      if (!cleoTask) {
        // Mapped to a CLEO ID that doesn't exist — skip
        actions.push({
          type: 'skip',
          cleoTaskId: ext.cleoTaskId,
          externalId: ext.externalId,
          summary: `CLEO task ${ext.cleoTaskId} not found — skipping`,
          applied: false,
        });
        continue;
      }

      // Already done in CLEO — skip
      if (cleoTask.status === 'done' || cleoTask.status === 'cancelled') {
        actions.push({
          type: 'skip',
          cleoTaskId: ext.cleoTaskId,
          externalId: ext.externalId,
          summary: `CLEO task ${ext.cleoTaskId} already ${cleoTask.status}`,
          applied: false,
        });
        continue;
      }

      // External says completed
      if (ext.status === 'completed') {
        actions.push({
          type: 'complete',
          cleoTaskId: ext.cleoTaskId,
          externalId: ext.externalId,
          summary: `Complete ${ext.cleoTaskId} (${cleoTask.title})`,
          applied: false,
        });
        continue;
      }

      // External says active, CLEO is pending/blocked
      if (
        ext.status === 'active' &&
        (cleoTask.status === 'pending' || cleoTask.status === 'blocked')
      ) {
        actions.push({
          type: 'activate',
          cleoTaskId: ext.cleoTaskId,
          externalId: ext.externalId,
          summary: `Activate ${ext.cleoTaskId} (${cleoTask.title})`,
          applied: false,
        });
        continue;
      }

      // External says removed
      if (ext.status === 'removed') {
        actions.push({
          type: 'remove',
          cleoTaskId: ext.cleoTaskId,
          externalId: ext.externalId,
          summary: `Task ${ext.cleoTaskId} removed from provider`,
          applied: false,
        });
        continue;
      }

      // No change needed
      actions.push({
        type: 'skip',
        cleoTaskId: ext.cleoTaskId,
        externalId: ext.externalId,
        summary: `No change needed for ${ext.cleoTaskId}`,
        applied: false,
      });
      continue;
    }

    // Case 2: New task (no cleoTaskId)
    if (ext.status !== 'removed') {
      actions.push({
        type: 'create',
        cleoTaskId: null,
        externalId: ext.externalId,
        summary: `Create new task: ${ext.title}`,
        applied: false,
      });
    }
  }

  // Case 3: Injected tasks that are no longer present in external state
  for (const injectedId of injectedIds) {
    if (!seenCleoIds.has(injectedId)) {
      actions.push({
        type: 'remove',
        cleoTaskId: injectedId,
        externalId: `injected:${injectedId}`,
        summary: `Injected task ${injectedId} no longer in provider`,
        applied: false,
      });
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reconcile external task state with CLEO's authoritative task store.
 *
 * @param externalTasks - Normalized tasks from a provider adapter.
 * @param options - Reconciliation options.
 * @param accessor - Optional DataAccessor override (for testing).
 * @returns Reconciliation result with actions taken.
 */
export async function reconcile(
  externalTasks: ExternalTask[],
  options: ReconcileOptions,
  accessor?: DataAccessor,
): Promise<ReconcileResult> {
  const { providerId, cwd, dryRun = false, defaultPhase, defaultLabels } = options;
  const acc = accessor ?? (await getAccessor(cwd));

  // Load current CLEO task state
  const { tasks: allTasks } = await acc.queryTasks({});
  const taskMap = buildTaskMap(allTasks);

  // Load sync session state for this provider
  const syncState: SyncSessionState | null = await readSyncState(providerId, cwd);
  const injectedIds = new Set(syncState?.injectedTaskIds ?? []);

  // Compute actions
  const actions = computeActions(externalTasks, taskMap, injectedIds);

  // Summary counters
  const summary = {
    completed: 0,
    activated: 0,
    created: 0,
    removed: 0,
    skipped: 0,
    conflicts: 0,
    applied: 0,
  };

  // Count by type
  for (const action of actions) {
    switch (action.type) {
      case 'complete':
        summary.completed++;
        break;
      case 'activate':
        summary.activated++;
        break;
      case 'create':
        summary.created++;
        break;
      case 'remove':
        summary.removed++;
        break;
      case 'skip':
        summary.skipped++;
        break;
      case 'conflict':
        summary.conflicts++;
        break;
    }
  }

  // Apply actions if not dry-run
  if (!dryRun) {
    for (const action of actions) {
      if (action.type === 'skip' || action.type === 'conflict') {
        continue;
      }

      try {
        switch (action.type) {
          case 'complete': {
            await completeTask(
              {
                taskId: action.cleoTaskId!,
                notes: `Completed via ${providerId} task sync`,
              },
              cwd,
              acc,
            );
            action.applied = true;
            summary.applied++;
            break;
          }

          case 'activate': {
            await updateTask(
              {
                taskId: action.cleoTaskId!,
                status: 'active',
                notes: `Activated during ${providerId} task sync`,
              },
              cwd,
              acc,
            );
            action.applied = true;
            summary.applied++;
            break;
          }

          case 'create': {
            // Find the external task for metadata
            const ext = externalTasks.find((e) => e.externalId === action.externalId);
            if (!ext) break;

            await addTask(
              {
                title: ext.title,
                description: ext.description ?? `Created during ${providerId} task sync`,
                labels: [...(defaultLabels ?? []), ...(ext.labels ?? []), 'sync-created'],
                ...(defaultPhase ? { phase: defaultPhase, addPhase: true } : {}),
              },
              cwd,
              acc,
            );
            action.applied = true;
            summary.applied++;
            break;
          }

          case 'remove': {
            // Removals are informational — we don't delete CLEO tasks
            // just because a provider removed them. Log but don't act.
            action.applied = true;
            summary.applied++;
            break;
          }
        }
      } catch (err) {
        action.error = err instanceof Error ? err.message : String(err);
      }
    }

    // Clear sync session state after successful apply
    await clearSyncState(providerId, cwd);
  }

  return {
    dryRun,
    providerId,
    actions,
    summary,
    sessionCleared: !dryRun,
  };
}
