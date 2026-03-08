/**
 * Memory-session bridge — records session summaries as brain observations.
 *
 * Hooks into the session end flow to persist a summary of the session's
 * work (tasks completed, scope, duration) into brain.db as an observation.
 * This is best-effort: failures do not affect the session end operation.
 *
 * @task T5392
 * @epic T5149
 */

import { observeBrain } from '../memory/brain-retrieval.js';

/** Session data needed to create a memory bridge observation. */
export interface SessionBridgeData {
  sessionId: string;
  scope: string;
  tasksCompleted: string[];
  duration: number;
}

/**
 * Bridge session end data to brain.db as an observation.
 *
 * Builds a summary text from the session metadata and saves it
 * as a 'change' observation with source_type 'agent'.
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param sessionData - Session metadata to record
 */
export async function bridgeSessionToMemory(
  projectRoot: string,
  sessionData: SessionBridgeData,
): Promise<void> {
  try {
    const taskList =
      sessionData.tasksCompleted.length > 0 ? sessionData.tasksCompleted.join(', ') : 'none';

    const durationMinutes = Math.round(sessionData.duration / 60);

    const summary = [
      `Session ${sessionData.sessionId} ended.`,
      `Scope: ${sessionData.scope}.`,
      `Duration: ${durationMinutes} min.`,
      `Tasks completed: ${taskList}.`,
    ].join(' ');

    await observeBrain(projectRoot, {
      text: summary,
      title: `Session summary: ${sessionData.sessionId}`,
      type: 'change',
      sourceSessionId: sessionData.sessionId,
      sourceType: 'agent',
    });
  } catch {
    // Best-effort: session bridge must never fail the session end flow
  }
}
