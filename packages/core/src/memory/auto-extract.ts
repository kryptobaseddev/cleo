/**
 * Auto-extract structured memory entries from task completions and session ends.
 *
 * NOTE: The two primary extraction functions in this module —
 * `extractTaskCompletionMemory` and `extractSessionEndMemory` — have been
 * intentionally disabled per T523 CA1 specification to eliminate O(tasks×labels)
 * noise in brain.db. Only `resolveTaskDetails` and `extractFromTranscript`
 * remain active.
 *
 * @task T526
 * @epic T523
 */

import type { Task } from '@cleocode/contracts';
import type { SessionBridgeData } from '../sessions/session-memory-bridge.js';

/**
 * Intentionally disabled per T523 CA1 specification.
 *
 * Previously auto-generated "Completed: <title>" learnings and
 * "Recurring label X seen in N completed tasks" patterns on every
 * task completion. This created O(tasks x labels) noise with no
 * deduplication, resulting in 2,466 duplicate patterns and 327
 * duplicate learnings in brain.db (96.7% noise ratio).
 *
 * Pattern detection is now handled by `cleo brain maintenance`
 * which runs deduplication-aware analysis on a schedule.
 *
 * @see .cleo/agent-outputs/T523-CA1-brain-integrity-spec.md
 */
export async function extractTaskCompletionMemory(
  _projectRoot: string,
  _task: Task,
  _parentTask?: Task,
): Promise<void> {
  // No-op: noise generation disabled
  return;
}

/**
 * Intentionally disabled per T523 CA1 specification.
 *
 * Previously auto-generated session summary decisions, duplicate
 * "Completed:" learnings, and workflow patterns on session end.
 * These duplicated data already stored in the sessions table and
 * task records, adding no signal to brain.db.
 *
 * @see .cleo/agent-outputs/T523-CA1-brain-integrity-spec.md
 */
export async function extractSessionEndMemory(
  _projectRoot: string,
  _sessionData: SessionBridgeData,
  _taskDetails: Task[],
): Promise<void> {
  // No-op: noise generation disabled
  return;
}

/**
 * Resolve an array of task IDs to their full Task objects.
 * Tasks that cannot be found are silently excluded.
 */
export async function resolveTaskDetails(projectRoot: string, taskIds: string[]): Promise<Task[]> {
  if (taskIds.length === 0) {
    return [];
  }

  const { getAccessor } = await import('../store/data-accessor.js');
  const accessor = await getAccessor(projectRoot);
  try {
    return await accessor.loadTasks(taskIds);
  } finally {
    await accessor.close();
  }
}

/** Action words that indicate a meaningful assistant turn worth storing. */
const ACTION_PATTERNS =
  /\b(implement|fix|add|create|update|remove|refactor|extract|migrate|resolve|complete|found|learned|discovered)\b/i;

/**
 * Extract key observations from a provider session transcript and store
 * them in brain.db as learnings.
 *
 * Filters assistant lines that contain action words, stores up to 5 as
 * learnings with 0.6 confidence. Always best-effort — never throws.
 *
 * @param projectRoot - Absolute path to project root.
 * @param sessionId - The CLEO session ID being processed.
 * @param transcript - Plain-text provider transcript (user/assistant turns).
 * @task T144 @epic T134
 */
export async function extractFromTranscript(
  projectRoot: string,
  sessionId: string,
  transcript: string,
): Promise<void> {
  try {
    const lines = transcript.split('\n').filter((l) => l.trim().length > 20);
    const actionLines = lines.filter((l) => ACTION_PATTERNS.test(l)).slice(0, 5);
    if (actionLines.length === 0) return;

    const { storeLearning } = await import('./learnings.js');
    for (const line of actionLines) {
      await storeLearning(projectRoot, {
        insight: line.trim().slice(0, 250),
        source: `transcript:${sessionId}`,
        confidence: 0.6,
        actionable: false,
      });
    }
  } catch {
    // Best-effort: must never throw
  }
}
