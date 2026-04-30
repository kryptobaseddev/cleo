/**
 * Memory-session bridge — creates a BRAIN observation of type 'session-summary'
 * when a session ends, and links it to all tasks completed/created in the session
 * via the brain_task_observations join table.
 *
 * This enables `cleo memory find` queries to surface session context without
 * needing the handoff text.
 *
 * @task T1615
 * @epic T1611
 */

import { createHash } from 'node:crypto';
import { getBrainAccessor } from '../store/memory-accessor.js';

/** Session data needed to create a memory bridge observation. */
export interface SessionBridgeData {
  sessionId: string;
  scope: string;
  tasksCompleted: string[];
  duration: number;
  /** Tasks created during the session (optional, defaults to []). */
  tasksCreated?: string[];
  /** Optional human-authored note from session end. */
  note?: string;
}

/** Result from bridgeSessionToMemory. */
export interface SessionBridgeResult {
  /** The observation ID written to brain.db, or null if skipped. */
  observationId: string | null;
  /** Number of task links written to brain_task_observations. */
  taskLinksCreated: number;
}

/**
 * Bridge session end data to brain.db as a 'session-summary' observation.
 *
 * Creates one brain_observations row of type 'session-summary' linked to the
 * ending session, then inserts rows into brain_task_observations for every task
 * that was completed or created during the session. This makes the session
 * context discoverable via `cleo memory find` queries without reading any
 * markdown handoff file.
 *
 * The function is best-effort — all errors are caught and the caller never sees
 * a rejection (sessions/index.ts wraps calls with `.catch(() => {})`).
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param sessionData - Session metadata: ID, scope, tasks, duration, optional note
 * @returns Result with observation ID and count of task links created
 */
export async function bridgeSessionToMemory(
  projectRoot: string,
  sessionData: SessionBridgeData,
): Promise<SessionBridgeResult> {
  const { sessionId, scope, tasksCompleted, duration, tasksCreated = [], note } = sessionData;

  // Collect all task IDs touched in this session (completed + created, deduplicated)
  const allTaskIds = Array.from(new Set([...tasksCompleted, ...tasksCreated]));

  // Build narrative for the observation
  const completedList = tasksCompleted.length > 0 ? tasksCompleted.join(', ') : 'none';
  const createdList = tasksCreated.length > 0 ? tasksCreated.join(', ') : 'none';
  const durationMin = Math.round(duration / 60);
  const noteSection = note ? `\n\nNote: ${note}` : '';

  const narrative = [
    `Session ${sessionId} ended after ${durationMin} min (scope: ${scope}).`,
    `Tasks completed: ${completedList}.`,
    `Tasks created: ${createdList}.`,
    noteSection,
  ]
    .join(' ')
    .trim();

  const title = `Session summary: ${tasksCompleted.length} completed, ${tasksCreated.length} created (${scope})`;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const contentHash = createHash('sha256')
    .update(`${sessionId}:session-summary`)
    .digest('hex')
    .slice(0, 16);

  const id = `O-ses-${Date.now().toString(36)}`;

  try {
    const accessor = await getBrainAccessor(projectRoot);

    // Write the session-summary observation
    await accessor.addObservation({
      id,
      type: 'session-summary',
      title,
      narrative,
      contentHash,
      project: null,
      sourceSessionId: sessionId,
      sourceType: 'session-debrief',
      agent: null,
      qualityScore: 0.7,
      createdAt: now,
      memoryTier: allTaskIds.length >= 2 ? 'medium' : 'short',
      memoryType: 'episodic',
      sourceConfidence: 'task-outcome',
      verified: true,
    });

    // Link the observation to every task touched in this session
    let taskLinksCreated = 0;
    if (allTaskIds.length > 0) {
      const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      if (nativeDb) {
        // Guard: brain_task_observations must exist (T1615 migration)
        let tableExists = false;
        try {
          nativeDb.prepare('SELECT 1 FROM brain_task_observations LIMIT 1').get();
          tableExists = true;
        } catch {
          // Table not yet created — skip link inserts silently
        }

        if (tableExists) {
          const insertStmt = nativeDb.prepare(
            `INSERT OR IGNORE INTO brain_task_observations
               (observation_id, task_id, link_type, created_at)
             VALUES (?, ?, ?, ?)`,
          );
          for (const taskId of allTaskIds) {
            const linkType = tasksCompleted.includes(taskId)
              ? 'session-completed'
              : 'session-created';
            try {
              insertStmt.run(id, taskId, linkType, now);
              taskLinksCreated++;
            } catch {
              // Best-effort — skip individual link failures
            }
          }
        }
      }
    }

    return { observationId: id, taskLinksCreated };
  } catch {
    // Best-effort: never block session teardown
    return { observationId: null, taskLinksCreated: 0 };
  }
}
