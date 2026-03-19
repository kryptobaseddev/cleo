/**
 * Provider-agnostic task reconciliation engine.
 *
 * Takes normalized ExternalTask[] from any provider adapter and reconciles
 * them against CLEO's authoritative task state. CLEO is always the SSoT.
 *
 * Uses the external_task_links table in tasks.db to track which external
 * tasks map to which CLEO tasks, enabling re-sync, update detection, and
 * bidirectional traceability.
 *
 * Provider-specific parsing is NEVER done here — that lives in the adapter's
 * ExternalTaskProvider implementation.
 */

import type {
  DataAccessor,
  ExternalTask,
  ExternalTaskLink,
  ReconcileAction,
  ReconcileOptions,
  ReconcileResult,
  Task,
} from '@cleocode/contracts';
import { getAccessor } from '../store/data-accessor.js';
import { addTask } from '../tasks/add.js';
import { completeTask } from '../tasks/complete.js';
import { updateTask } from '../tasks/update.js';
import { createLink, getLinksByProvider, touchLink } from './link-store.js';

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
 * Build a lookup map from external ID to existing link for the provider.
 */
function buildLinkMap(links: ExternalTaskLink[]): Map<string, ExternalTaskLink> {
  const map = new Map<string, ExternalTaskLink>();
  for (const link of links) {
    map.set(link.externalId, link);
  }
  return map;
}

/**
 * Compute reconciliation actions by diffing external tasks against CLEO state.
 */
function computeActions(
  externalTasks: ExternalTask[],
  taskMap: Map<string, Task>,
  linkMap: Map<string, ExternalTaskLink>,
): ReconcileAction[] {
  const actions: ReconcileAction[] = [];

  for (const ext of externalTasks) {
    const existingLink = linkMap.get(ext.externalId);

    if (existingLink) {
      // External task has an existing link to a CLEO task
      const cleoTask = taskMap.get(existingLink.taskId);

      if (!cleoTask) {
        // Linked CLEO task was deleted — skip
        actions.push({
          type: 'skip',
          cleoTaskId: existingLink.taskId,
          externalId: ext.externalId,
          summary: `Linked CLEO task ${existingLink.taskId} no longer exists — skipping`,
          applied: false,
        });
        continue;
      }

      // Already terminal in CLEO — skip
      if (cleoTask.status === 'done' || cleoTask.status === 'cancelled') {
        actions.push({
          type: 'skip',
          cleoTaskId: cleoTask.id,
          externalId: ext.externalId,
          summary: `CLEO task ${cleoTask.id} already ${cleoTask.status}`,
          applied: false,
        });
        continue;
      }

      // External says completed → complete CLEO task
      if (ext.status === 'completed') {
        actions.push({
          type: 'complete',
          cleoTaskId: cleoTask.id,
          externalId: ext.externalId,
          summary: `Complete ${cleoTask.id} (${cleoTask.title})`,
          applied: false,
          linkId: existingLink.id,
        });
        continue;
      }

      // External says active, CLEO is pending/blocked → activate
      if (
        ext.status === 'active' &&
        (cleoTask.status === 'pending' || cleoTask.status === 'blocked')
      ) {
        actions.push({
          type: 'activate',
          cleoTaskId: cleoTask.id,
          externalId: ext.externalId,
          summary: `Activate ${cleoTask.id} (${cleoTask.title})`,
          applied: false,
          linkId: existingLink.id,
        });
        continue;
      }

      // Check if title or other properties changed → update
      if (ext.title !== cleoTask.title) {
        actions.push({
          type: 'update',
          cleoTaskId: cleoTask.id,
          externalId: ext.externalId,
          summary: `Update ${cleoTask.id} title: "${cleoTask.title}" → "${ext.title}"`,
          applied: false,
          linkId: existingLink.id,
        });
        continue;
      }

      // No change needed — just touch the link timestamp
      actions.push({
        type: 'skip',
        cleoTaskId: cleoTask.id,
        externalId: ext.externalId,
        summary: `No change needed for ${cleoTask.id}`,
        applied: false,
        linkId: existingLink.id,
      });
    } else {
      // No existing link — this is a new external task
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

  // Load existing links for this provider
  const existingLinks = await getLinksByProvider(providerId, cwd);
  const linkMap = buildLinkMap(existingLinks);

  // Compute actions
  const actions = computeActions(externalTasks, taskMap, linkMap);

  // Summary counters
  const summary = {
    created: 0,
    updated: 0,
    completed: 0,
    activated: 0,
    skipped: 0,
    conflicts: 0,
    total: actions.length,
    applied: 0,
  };

  // Count by type
  for (const action of actions) {
    switch (action.type) {
      case 'create':
        summary.created++;
        break;
      case 'update':
        summary.updated++;
        break;
      case 'complete':
        summary.completed++;
        break;
      case 'activate':
        summary.activated++;
        break;
      case 'skip':
        summary.skipped++;
        break;
      case 'conflict':
        summary.conflicts++;
        break;
    }
  }

  let linksAffected = 0;

  // Apply actions if not dry-run
  if (!dryRun) {
    for (const action of actions) {
      if (action.type === 'skip' || action.type === 'conflict') {
        // Touch link timestamps for skipped items that have links
        if (action.linkId) {
          const ext = externalTasks.find((e) => e.externalId === action.externalId);
          await touchLink(action.linkId, { externalTitle: ext?.title }, cwd);
        }
        continue;
      }

      try {
        switch (action.type) {
          case 'complete': {
            await completeTask(
              {
                taskId: action.cleoTaskId!,
                notes: `Completed via ${providerId} sync`,
              },
              cwd,
              acc,
            );
            if (action.linkId) {
              await touchLink(action.linkId, undefined, cwd);
              linksAffected++;
            }
            action.applied = true;
            summary.applied++;
            break;
          }

          case 'activate': {
            await updateTask(
              {
                taskId: action.cleoTaskId!,
                status: 'active',
                notes: `Activated via ${providerId} sync`,
              },
              cwd,
              acc,
            );
            if (action.linkId) {
              await touchLink(action.linkId, undefined, cwd);
              linksAffected++;
            }
            action.applied = true;
            summary.applied++;
            break;
          }

          case 'update': {
            const ext = externalTasks.find((e) => e.externalId === action.externalId);
            if (!ext) break;

            await updateTask(
              {
                taskId: action.cleoTaskId!,
                title: ext.title,
                notes: `Updated via ${providerId} sync`,
              },
              cwd,
              acc,
            );
            if (action.linkId) {
              await touchLink(action.linkId, { externalTitle: ext.title }, cwd);
              linksAffected++;
            }
            action.applied = true;
            summary.applied++;
            break;
          }

          case 'create': {
            const ext = externalTasks.find((e) => e.externalId === action.externalId);
            if (!ext) break;

            const result = await addTask(
              {
                title: ext.title,
                description: ext.description ?? `Synced from ${providerId}`,
                priority: ext.priority,
                type: ext.type,
                labels: [...(defaultLabels ?? []), ...(ext.labels ?? []), `sync:${providerId}`],
                ...(defaultPhase ? { phase: defaultPhase, addPhase: true } : {}),
              },
              cwd,
              acc,
            );

            // Create a link to track this external → CLEO task mapping
            const newTaskId = result.task.id;
            if (newTaskId) {
              const link = await createLink(
                {
                  taskId: newTaskId,
                  providerId,
                  externalId: ext.externalId,
                  externalUrl: ext.url,
                  externalTitle: ext.title,
                  linkType: 'created',
                  syncDirection: 'inbound',
                  metadata: ext.providerMeta,
                },
                cwd,
              );
              action.cleoTaskId = newTaskId;
              action.linkId = link.id;
              linksAffected++;
            }

            action.applied = true;
            summary.applied++;
            break;
          }
        }
      } catch (err) {
        action.error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  return {
    dryRun,
    providerId,
    actions,
    summary,
    linksAffected,
  };
}
