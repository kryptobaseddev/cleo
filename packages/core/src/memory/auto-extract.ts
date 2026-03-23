/**
 * Auto-extract structured memory entries from task completions and session ends.
 *
 * Best-effort extraction: all functions wrap their logic in try/catch and
 * must never throw — memory extraction must never block the calling flow.
 *
 * @task T-auto-extract
 * @epic T5149
 */

import type { Task } from '@cleocode/contracts';
import type { SessionBridgeData } from '../sessions/session-memory-bridge.js';
import { storeDecision } from './decisions.js';
import { storeLearning } from './learnings.js';
import { storePattern } from './patterns.js';

/**
 * Extract and store memory entries when a task is completed.
 *
 * - Always stores a learning for the completed task.
 * - Stores a second learning if the task had dependencies.
 * - Detects recurring label patterns across recent completed tasks
 *   and stores a success pattern when any label appears 3+ times.
 */
export async function extractTaskCompletionMemory(
  projectRoot: string,
  task: Task,
  _parentTask?: Task,
): Promise<void> {
  try {
    // Always store a learning for this completion
    await storeLearning(projectRoot, {
      insight: `Completed: ${task.title} — ${task.description ?? ''}`,
      source: `task-completion:${task.id}`,
      confidence: 0.7,
      actionable: true,
    });

    // Dependency chain learning
    const deps = task.depends ?? [];
    if (deps.length > 0) {
      await storeLearning(projectRoot, {
        insight: `Task ${task.id} depended on ${deps.join(', ')} — dependency chain completed successfully`,
        source: `task-completion:${task.id}`,
        confidence: 0.7,
      });
    }

    // Pattern detection: look for recurring labels across recent done tasks
    const { getAccessor } = await import('../store/data-accessor.js');
    const accessor = await getAccessor(projectRoot);
    let doneTasks: Task[];
    try {
      const { tasks } = await accessor.queryTasks({ status: 'done' });
      doneTasks = tasks;
    } finally {
      await accessor.close();
    }

    const recentDone = doneTasks.slice(-50);

    const labelCounts = new Map<string, string[]>();
    for (const t of recentDone) {
      for (const label of t.labels ?? []) {
        const existing = labelCounts.get(label) ?? [];
        existing.push(t.id);
        labelCounts.set(label, existing);
      }
    }

    for (const [label, taskIds] of labelCounts.entries()) {
      if (taskIds.length >= 3) {
        await storePattern(projectRoot, {
          type: 'success',
          pattern: `Recurring label "${label}" seen in ${taskIds.length} completed tasks`,
          context: `Auto-detected from task completion of ${task.id}`,
          impact: 'medium',
          examples: taskIds,
        });
      }
    }
  } catch {
    // Best-effort: must never throw
  }
}

/**
 * Extract and store memory entries when a session ends.
 *
 * - Stores a process decision summarising the session.
 * - Stores a per-task learning for each completed task.
 * - Stores a workflow pattern when 2+ completed tasks share a label.
 */
export async function extractSessionEndMemory(
  projectRoot: string,
  sessionData: SessionBridgeData,
  taskDetails: Task[],
): Promise<void> {
  try {
    if (taskDetails.length > 0) {
      await storeDecision(projectRoot, {
        type: 'process',
        decision: `Session ${sessionData.sessionId} completed ${taskDetails.length} tasks: ${taskDetails.map((t) => t.id).join(', ')}`,
        rationale: `Session scope: ${sessionData.scope}. Duration: ${Math.round(sessionData.duration / 60)} min.`,
        confidence: 'medium',
      });
    }

    // Per-task learnings
    for (const t of taskDetails) {
      await storeLearning(projectRoot, {
        insight: `Completed: ${t.title} — ${t.description ?? ''}`,
        source: `session-end:${sessionData.sessionId}`,
        confidence: 0.7,
        actionable: true,
      });
    }

    // Workflow pattern when 2+ tasks share a label
    const labelCounts = new Map<string, string[]>();
    for (const t of taskDetails) {
      for (const label of t.labels ?? []) {
        const existing = labelCounts.get(label) ?? [];
        existing.push(t.id);
        labelCounts.set(label, existing);
      }
    }

    for (const [label, taskIds] of labelCounts.entries()) {
      if (taskIds.length >= 2) {
        await storePattern(projectRoot, {
          type: 'workflow',
          pattern: `Session ${sessionData.sessionId} completed ${taskIds.length} tasks with label "${label}"`,
          context: `Auto-detected from session end: ${sessionData.sessionId}`,
          impact: 'medium',
          examples: taskIds,
        });
      }
    }
  } catch {
    // Best-effort: must never throw
  }
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
