/**
 * Cross-database cleanup hooks for brain.db → tasks.db soft FK enforcement.
 *
 * SQLite does not support foreign key constraints across database connections.
 * This module provides application-layer guards that maintain referential
 * integrity between brain.db and tasks.db after destructive operations.
 *
 * Implements the recommendations from T030 audit (XFKB-001 through XFKB-005).
 *
 * @task T033
 * @epic T029
 */

import { and, eq, isNotNull, or } from 'drizzle-orm';
import * as brainSchema from './memory-schema.js';
import { getBrainDb } from './memory-sqlite.js';

/**
 * Clean up brain.db references after a task is deleted from tasks.db.
 *
 * Handles:
 * - XFKB-001/002: Nullify brain_decisions.context_epic_id / context_task_id
 * - XFKB-003: Delete brain_memory_links rows where task_id matches
 * - XFKB-005: Delete brain_page_nodes with id='task:<taskId>' and cascade brain_page_edges
 *
 * This is a best-effort cleanup — brain.db is a cognitive store and minor
 * staleness is preferable to failing task deletions due to brain.db errors.
 *
 * @remarks
 * Best-effort: failures in brain.db cleanup do not propagate to the caller.
 * A background reconciliation pass can clean up any residual stale refs.
 *
 * @param taskId - The ID of the task being deleted from tasks.db
 * @param cwd - Optional working directory
 *
 * @example
 * ```ts
 * await cleanupBrainRefsOnTaskDelete('T042');
 * ```
 */
export async function cleanupBrainRefsOnTaskDelete(taskId: string, cwd?: string): Promise<void> {
  let brainDb: Awaited<ReturnType<typeof getBrainDb>> | null = null;

  try {
    brainDb = await getBrainDb(cwd);
  } catch {
    // brain.db may not be initialized — non-fatal
    return;
  }

  const nodeId = `task:${taskId}`;

  try {
    // XFKB-001/002: Nullify context references in brain_decisions
    await brainDb
      .update(brainSchema.brainDecisions)
      .set({ contextEpicId: null })
      .where(eq(brainSchema.brainDecisions.contextEpicId, taskId));

    await brainDb
      .update(brainSchema.brainDecisions)
      .set({ contextTaskId: null })
      .where(eq(brainSchema.brainDecisions.contextTaskId, taskId));

    // XFKB-003: Delete brain_memory_links rows referencing this task
    await brainDb
      .delete(brainSchema.brainMemoryLinks)
      .where(eq(brainSchema.brainMemoryLinks.taskId, taskId));

    // XFKB-005: Delete brain_page_edges first (FK cascade not available cross-DB),
    //            then delete brain_page_nodes for this task
    await brainDb
      .delete(brainSchema.brainPageEdges)
      .where(
        or(
          eq(brainSchema.brainPageEdges.fromId, nodeId),
          eq(brainSchema.brainPageEdges.toId, nodeId),
        ),
      );

    await brainDb
      .delete(brainSchema.brainPageNodes)
      .where(eq(brainSchema.brainPageNodes.id, nodeId));
  } catch {
    // Non-fatal: log silently. Brain.db cleanup is best-effort.
    // A background reconciliation pass can clean up any residual stale refs.
  }
}

/**
 * Clean up brain.db references after a session is deleted from tasks.db.
 *
 * Handles:
 * - XFKB-004: Nullify brain_observations.source_session_id where it matches
 *
 * @remarks
 * Best-effort: failures do not propagate. brain.db may not be initialised.
 *
 * @param sessionId - The ID of the session being deleted from tasks.db
 * @param cwd - Optional working directory
 *
 * @example
 * ```ts
 * await cleanupBrainRefsOnSessionDelete('ses_20260321_abc');
 * ```
 */
export async function cleanupBrainRefsOnSessionDelete(
  sessionId: string,
  cwd?: string,
): Promise<void> {
  let brainDb: Awaited<ReturnType<typeof getBrainDb>> | null = null;

  try {
    brainDb = await getBrainDb(cwd);
  } catch {
    return;
  }

  try {
    // XFKB-004: Nullify source_session_id in brain_observations
    await brainDb
      .update(brainSchema.brainObservations)
      .set({ sourceSessionId: null })
      .where(eq(brainSchema.brainObservations.sourceSessionId, sessionId));
  } catch {
    // Non-fatal best-effort cleanup
  }
}

/**
 * Verify a task ID exists in tasks.db before writing a cross-DB reference to brain.db.
 * Returns true if the task exists, false otherwise.
 *
 * Provides write-guard for XFKB-001/002/003 on brain.db insert.
 *
 * @remarks
 * Used as a write-guard before inserting cross-DB references into brain.db.
 *
 * @param taskId - Task ID to verify
 * @param tasksDb - The tasks.db drizzle instance
 * @returns True if the task exists in tasks.db
 *
 * @example
 * ```ts
 * if (await taskExistsInTasksDb('T042', db)) { /* safe to reference *\/ }
 * ```
 */
export async function taskExistsInTasksDb(
  taskId: string,
  tasksDb: Awaited<ReturnType<typeof import('./sqlite.js').getDb>>,
): Promise<boolean> {
  const { tasks } = await import('./tasks-schema.js');
  const { eq: eqOp } = await import('drizzle-orm');
  const result = await tasksDb
    .select({ id: tasks.id })
    .from(tasks)
    .where(eqOp(tasks.id, taskId))
    .all();
  return result.length > 0;
}

/**
 * Verify a session ID exists in tasks.db before writing a cross-DB reference to brain.db.
 * Returns true if the session exists, false otherwise.
 *
 * Provides write-guard for XFKB-004 on brain.db insert.
 *
 * @remarks
 * Used as a write-guard before inserting cross-DB references into brain.db.
 *
 * @param sessionId - Session ID to verify
 * @param tasksDb - The tasks.db drizzle instance
 * @returns True if the session exists in tasks.db
 *
 * @example
 * ```ts
 * if (await sessionExistsInTasksDb('ses_abc', db)) { /* safe to reference *\/ }
 * ```
 */
/**
 * Reconcile orphaned cross-DB references in brain.db.
 *
 * Scans brain.db for references to tasks/sessions that no longer exist in
 * tasks.db and cleans them up:
 * - brain_decisions with stale context_task_id or context_epic_id → nullify
 * - brain_observations with stale source_session_id → nullify
 * - brain_memory_links with stale task_id → delete row
 *
 * This is the background reconciliation pass mentioned in the module doc.
 * Safe to run at any frequency — idempotent.
 *
 * @param cwd - Optional working directory
 * @returns Counts of orphaned references cleaned up
 */
export async function reconcileOrphanedRefs(cwd?: string): Promise<{
  decisionsFixed: number;
  observationsFixed: number;
  linksRemoved: number;
}> {
  let brainDb: Awaited<ReturnType<typeof getBrainDb>> | null = null;
  const result = { decisionsFixed: 0, observationsFixed: 0, linksRemoved: 0 };

  try {
    brainDb = await getBrainDb(cwd);
  } catch {
    return result;
  }

  const { getDb } = await import('./sqlite.js');
  let tasksDb: Awaited<ReturnType<typeof getDb>>;
  try {
    tasksDb = await getDb(cwd);
  } catch {
    return result;
  }

  try {
    // 1. Find decisions with stale context_task_id
    const decisionsWithTaskRef = await brainDb
      .select({
        id: brainSchema.brainDecisions.id,
        contextTaskId: brainSchema.brainDecisions.contextTaskId,
        contextEpicId: brainSchema.brainDecisions.contextEpicId,
      })
      .from(brainSchema.brainDecisions)
      .where(
        or(
          isNotNull(brainSchema.brainDecisions.contextTaskId),
          isNotNull(brainSchema.brainDecisions.contextEpicId),
        ),
      )
      .all();

    for (const d of decisionsWithTaskRef) {
      if (d.contextTaskId) {
        const exists = await taskExistsInTasksDb(d.contextTaskId, tasksDb);
        if (!exists) {
          await brainDb
            .update(brainSchema.brainDecisions)
            .set({ contextTaskId: null })
            .where(eq(brainSchema.brainDecisions.id, d.id));
          result.decisionsFixed++;
        }
      }
      if (d.contextEpicId) {
        const exists = await taskExistsInTasksDb(d.contextEpicId, tasksDb);
        if (!exists) {
          await brainDb
            .update(brainSchema.brainDecisions)
            .set({ contextEpicId: null })
            .where(eq(brainSchema.brainDecisions.id, d.id));
          result.decisionsFixed++;
        }
      }
    }

    // 2. Find observations with stale source_session_id
    const obsWithSessionRef = await brainDb
      .select({
        id: brainSchema.brainObservations.id,
        sourceSessionId: brainSchema.brainObservations.sourceSessionId,
      })
      .from(brainSchema.brainObservations)
      .where(isNotNull(brainSchema.brainObservations.sourceSessionId))
      .all();

    for (const o of obsWithSessionRef) {
      {
        const exists = o.sourceSessionId
          ? await sessionExistsInTasksDb(o.sourceSessionId, tasksDb)
          : false;
        if (!exists) {
          await brainDb
            .update(brainSchema.brainObservations)
            .set({ sourceSessionId: null })
            .where(eq(brainSchema.brainObservations.id, o.id));
          result.observationsFixed++;
        }
      }
    }

    // 3. Find memory links with stale task_id
    const allLinks = await brainDb
      .select({
        memoryType: brainSchema.brainMemoryLinks.memoryType,
        memoryId: brainSchema.brainMemoryLinks.memoryId,
        taskId: brainSchema.brainMemoryLinks.taskId,
        linkType: brainSchema.brainMemoryLinks.linkType,
      })
      .from(brainSchema.brainMemoryLinks)
      .all();

    for (const link of allLinks) {
      const exists = await taskExistsInTasksDb(link.taskId, tasksDb);
      if (!exists) {
        await brainDb
          .delete(brainSchema.brainMemoryLinks)
          .where(
            and(
              eq(brainSchema.brainMemoryLinks.memoryType, link.memoryType),
              eq(brainSchema.brainMemoryLinks.memoryId, link.memoryId),
              eq(brainSchema.brainMemoryLinks.taskId, link.taskId),
              eq(brainSchema.brainMemoryLinks.linkType, link.linkType),
            ),
          );
        result.linksRemoved++;
      }
    }
  } catch {
    // Non-fatal best-effort reconciliation
  }

  return result;
}

export async function sessionExistsInTasksDb(
  sessionId: string,
  tasksDb: Awaited<ReturnType<typeof import('./sqlite.js').getDb>>,
): Promise<boolean> {
  const { sessions } = await import('./tasks-schema.js');
  const { eq: eqOp } = await import('drizzle-orm');
  const result = await tasksDb
    .select({ id: sessions.id })
    .from(sessions)
    .where(eqOp(sessions.id, sessionId))
    .all();
  return result.length > 0;
}

/**
 * Verify an agent exists in signaldock.db before creating cross-DB references.
 * Returns true if the agent_id exists in signaldock.db agents table.
 *
 * Provides write-guard for agent_instances and agent_error_log in tasks.db
 * that reference agents whose identity lives in signaldock.db.
 *
 * @param agentId - Agent slug (e.g. 'cleo-db-lead') to verify
 * @param cwd - Optional working directory
 * @returns True if the agent exists in signaldock.db
 *
 * @task T238
 */
export async function agentExistsInSignaldockDb(agentId: string, cwd?: string): Promise<boolean> {
  try {
    const { getSignaldockDbPath } = await import('./signaldock-sqlite.js');
    const { existsSync } = await import('node:fs');
    const dbPath = getSignaldockDbPath(cwd);
    if (!existsSync(dbPath)) return false;

    const { createRequire } = await import('node:module');
    const _require = createRequire(import.meta.url);
    const { DatabaseSync } = _require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare('SELECT id FROM agents WHERE agent_id = ?').get(agentId) as
        | { id: string }
        | undefined;
      return !!row;
    } finally {
      db.close();
    }
  } catch {
    // signaldock.db may not exist yet — non-fatal
    return false;
  }
}
