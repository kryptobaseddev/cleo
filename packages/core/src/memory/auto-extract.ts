/**
 * Transcript and task-completion memory extraction.
 *
 * Historical context:
 *   - Previously contained a keyword-regex `ACTION_PATTERNS` that produced
 *     88% noise in brain.db (T543).
 *   - Previously contained `extractTaskCompletionMemory` and
 *     `extractSessionEndMemory` — both disabled per T523 CA1 spec.
 *
 * Current design (research-backed, replaces keyword gate):
 *   - `extractFromTranscript` forwards to the LLM-driven extraction gate in
 *     `llm-extraction.ts`. The LLM returns typed structured memories
 *     (decision / pattern / learning / constraint / correction) with
 *     importance scores and justifications.
 *   - Only memories above the configured minimum importance are stored.
 *   - Each stored memory is tagged `agent-llm-extracted:<sessionId>` so
 *     downstream dedup, quality scoring, and consolidation can distinguish
 *     it from other write paths.
 *
 * All extraction is best-effort: any error is swallowed so session end
 * cannot be blocked by a failed LLM call.
 *
 * Research: `.cleo/agent-outputs/R-llm-memory-systems-research.md`
 */

import type { Task } from '@cleocode/contracts';

/**
 * Resolve an array of task IDs to their full Task objects.
 * Tasks that cannot be found are silently excluded.
 *
 * Retained from the previous implementation because it is still used by
 * callers that need hydrated task details without coupling to the disabled
 * extraction stubs.
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

/**
 * Extract durable knowledge from a provider session transcript and store it
 * in brain.db via the LLM extraction gate.
 *
 * Replaces the legacy `ACTION_PATTERNS` keyword-regex extractor. The LLM
 * returns typed, structured memories with justification and importance
 * scoring; only high-value items are persisted.
 *
 * Behaviour:
 *   - Returns silently when transcript is empty/non-string.
 *   - Returns silently when `brain.llmExtraction.enabled` is false OR when
 *     `ANTHROPIC_API_KEY` is not set (best-effort degradation).
 *   - Never throws — all errors are swallowed so session end cannot be
 *     blocked by a failed extraction.
 *
 * @param projectRoot - Absolute path to project root.
 * @param sessionId - The CLEO session ID being processed.
 * @param transcript - Plain-text provider transcript (user/assistant turns).
 */
export async function extractFromTranscript(
  projectRoot: string,
  sessionId: string,
  transcript: string,
): Promise<void> {
  try {
    if (typeof transcript !== 'string' || transcript.trim().length === 0) {
      return;
    }
    const { extractFromTranscript: runLlmExtraction } = await import('./llm-extraction.js');
    await runLlmExtraction({ projectRoot, sessionId, transcript });
  } catch {
    // Best-effort: extraction must never throw during session end.
  }
}
