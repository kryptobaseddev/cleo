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

import { eq, or } from 'drizzle-orm';
import * as brainSchema from './brain-schema.js';
import { getBrainDb } from './brain-sqlite.js';

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
 * @param taskId - The ID of the task being deleted from tasks.db
 * @param cwd - Optional working directory
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
 * @param sessionId - The ID of the session being deleted from tasks.db
 * @param cwd - Optional working directory
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
 * @param taskId - Task ID to verify
 * @param tasksDb - The tasks.db drizzle instance
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
 * @param sessionId - Session ID to verify
 * @param tasksDb - The tasks.db drizzle instance
 */
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
