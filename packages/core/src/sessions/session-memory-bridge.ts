/**
 * Memory-session bridge — no-op placeholder retained for call-site compatibility.
 *
 * Previously this function wrote a session summary observation to brain.db and
 * triggered auto-extraction of structured memory. Both were removed in T527
 * because session data already lives in the sessions table; duplicating it to
 * brain_observations was pure noise.
 *
 * The function is kept (as a no-op) so callers in sessions/index.ts do not need
 * to be updated in this task.
 *
 * @task T5392
 * @epic T5149
 * @see T527 — removal of duplicate session observation writes
 */

/** Session data needed to create a memory bridge observation. */
export interface SessionBridgeData {
  sessionId: string;
  scope: string;
  tasksCompleted: string[];
  duration: number;
}

/**
 * Bridge session end data — currently a no-op.
 *
 * Retained for call-site compatibility. Previously wrote a duplicate summary
 * observation to brain.db and triggered extractSessionEndMemory; both were
 * removed in T527 to reduce brain.db noise.
 *
 * @param _projectRoot - Project root directory (unused)
 * @param _sessionData - Session metadata (unused)
 */
export async function bridgeSessionToMemory(
  _projectRoot: string,
  _sessionData: SessionBridgeData,
): Promise<void> {
  // T527: Intentional no-op. Session data is already in the sessions table.
  // Removed: observeBrain duplicate write and extractSessionEndMemory call.
}
