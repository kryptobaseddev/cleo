/**
 * Session Memory Auto-Capture
 *
 * When a session ends, automatically persists decisions, patterns,
 * and learnings to brain.db as observations with source_type='session-debrief'.
 *
 * Also provides getSessionMemoryContext() for enriching session start/resume
 * with relevant brain memory.
 *
 * @epic T5149
 */

import type { DebriefData, DebriefDecision } from '../sessions/handoff.js';
import type {
  BrainCompactHit,
  BrainObservationType,
  ObserveBrainResult,
  SearchBrainCompactResult,
} from './brain-retrieval.js';

// ============================================================================
// Types
// ============================================================================

/** Result of persisting session memory to brain.db. */
export interface SessionMemoryResult {
  /** Number of observations created */
  observationsCreated: number;
  /** Number of links created */
  linksCreated: number;
  /** IDs of created observations */
  observationIds: string[];
  /** Whether any errors occurred (best-effort -- errors don't fail the operation) */
  errors: string[];
}

/** A memory item to be persisted to brain.db. */
export interface MemoryItem {
  text: string;
  title: string;
  type: BrainObservationType;
  sourceSessionId: string;
  sourceType: 'session-debrief';
  /** Optional task ID to link this observation to */
  linkTaskId?: string;
}

/** Memory context returned for session start/resume enrichment. */
export interface SessionMemoryContext {
  /** Recent decisions relevant to this scope */
  recentDecisions: BrainCompactHit[];
  /** Patterns relevant to this scope */
  relevantPatterns: BrainCompactHit[];
  /** Recent observations from prior sessions */
  recentObservations: BrainCompactHit[];
  /** Recent learnings relevant to this scope */
  recentLearnings: BrainCompactHit[];
  /** Total token estimate for this context */
  tokensEstimated: number;
}

// ============================================================================
// extractMemoryItems (pure function)
// ============================================================================

/**
 * Extract memory-worthy items from debrief data.
 * Pure function -- no side effects.
 *
 * Items extracted:
 * - Decisions (from debrief.decisions[]) -> observations with type='decision'
 * - Tasks completed summary -> observation with type='change'
 * - Session-level note (if present) -> observation with type='discovery'
 */
export function extractMemoryItems(
  sessionId: string,
  debrief: DebriefData | null | undefined,
): MemoryItem[] {
  if (!debrief) return [];

  const items: MemoryItem[] = [];

  // 1. Decisions
  if (Array.isArray(debrief.decisions)) {
    for (const d of debrief.decisions) {
      const decision = d as DebriefDecision;
      if (!decision.decision) continue;

      const text = `Decision: ${decision.decision}\nRationale: ${decision.rationale ?? 'N/A'}`;
      items.push({
        text,
        title: decision.decision.slice(0, 120),
        type: 'decision',
        sourceSessionId: sessionId,
        sourceType: 'session-debrief',
        linkTaskId: decision.taskId || undefined,
      });
    }
  }

  // 2. Session summary (when tasks were completed)
  const tasksCompleted = debrief.handoff?.tasksCompleted;
  if (Array.isArray(tasksCompleted) && tasksCompleted.length > 0) {
    const taskList = tasksCompleted.join(', ');
    const nextSuggested = debrief.handoff?.nextSuggested;
    const nextPart =
      Array.isArray(nextSuggested) && nextSuggested.length > 0
        ? ` Next suggested: ${nextSuggested.join(', ')}`
        : '';
    const text = `Session ${sessionId} completed ${tasksCompleted.length} tasks: ${taskList}.${nextPart}`;
    items.push({
      text,
      title: `Session ${sessionId} summary: ${tasksCompleted.length} tasks completed`.slice(0, 120),
      type: 'change',
      sourceSessionId: sessionId,
      sourceType: 'session-debrief',
    });
  }

  // 3. Session note
  const note = debrief.handoff?.note;
  if (typeof note === 'string' && note.trim()) {
    items.push({
      text: note,
      title: `Session note: ${note.slice(0, 100)}`.slice(0, 120),
      type: 'discovery',
      sourceSessionId: sessionId,
      sourceType: 'session-debrief',
    });
  }

  return items;
}

// ============================================================================
// persistSessionMemory
// ============================================================================

/**
 * Main entry point -- called from session.end handler.
 * Extracts memory-worthy content from debrief data and persists to brain.db.
 *
 * ALL errors are caught and accumulated in result.errors -- never throws.
 *
 * @param projectRoot - Project root directory
 * @param sessionId - The session that just ended
 * @param debrief - Rich debrief data from sessionComputeDebrief()
 * @returns Summary of what was persisted
 */
export async function persistSessionMemory(
  projectRoot: string,
  sessionId: string,
  debrief: DebriefData | null | undefined,
): Promise<SessionMemoryResult> {
  const result: SessionMemoryResult = {
    observationsCreated: 0,
    linksCreated: 0,
    observationIds: [],
    errors: [],
  };

  if (!debrief) return result;

  const items = extractMemoryItems(sessionId, debrief);
  if (items.length === 0) return result;

  // Dynamic imports to avoid circular dependencies and loading brain.db
  // unless actually needed
  let observeBrain: typeof import('./brain-retrieval.js').observeBrain;
  let linkMemoryToTask: typeof import('./brain-links.js').linkMemoryToTask;

  try {
    const retrieval = await import('./brain-retrieval.js');
    observeBrain = retrieval.observeBrain;
    const links = await import('./brain-links.js');
    linkMemoryToTask = links.linkMemoryToTask;
  } catch (err) {
    result.errors.push(
      `Failed to load brain modules: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  for (const item of items) {
    // Create observation
    let obsResult: ObserveBrainResult | null = null;
    try {
      obsResult = await observeBrain(projectRoot, {
        text: item.text,
        title: item.title,
        type: item.type,
        sourceSessionId: item.sourceSessionId,
        sourceType: item.sourceType,
      });
      result.observationsCreated++;
      result.observationIds.push(obsResult.id);
    } catch (err) {
      result.errors.push(
        `Failed to create observation: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue; // Skip linking if observation creation failed
    }

    // Create cross-link if there's a task ID
    if (item.linkTaskId && obsResult) {
      try {
        await linkMemoryToTask(
          projectRoot,
          'observation',
          obsResult.id,
          item.linkTaskId,
          'produced_by',
        );
        result.linksCreated++;
      } catch (err) {
        result.errors.push(
          `Failed to link observation ${obsResult.id} to task ${item.linkTaskId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return result;
}

// ============================================================================
// buildSummarizationPrompt (T140)
// ============================================================================

/**
 * Build a summarization prompt from debrief data.
 *
 * Returns a formatted prompt string that guides an LLM to produce a structured
 * session summary (key learnings, decisions, patterns, next actions). The result
 * can be passed to an LLM or stored directly as a `memoryPrompt` in the session
 * end result.
 *
 * Returns null when debrief contains no meaningful content to summarize.
 *
 * @param sessionId - The session ID to summarize.
 * @param debrief - Rich debrief data from sessionComputeDebrief().
 * @task T140 @epic T134
 */
export function buildSummarizationPrompt(
  sessionId: string,
  debrief: DebriefData | null | undefined,
): string | null {
  if (!debrief) return null;

  const tasksCompleted = debrief.handoff?.tasksCompleted ?? [];
  const decisions = (debrief.decisions ?? []) as DebriefDecision[];
  const note = debrief.handoff?.note ?? '';
  const nextSuggested = debrief.handoff?.nextSuggested ?? [];

  if (tasksCompleted.length === 0 && decisions.length === 0 && !note) {
    return null;
  }

  const parts: string[] = [
    `Summarize session ${sessionId} for brain memory storage.`,
    '',
    `Tasks completed: ${tasksCompleted.join(', ') || 'none'}`,
  ];

  if (decisions.length > 0) {
    parts.push('');
    parts.push('Decisions made:');
    for (const d of decisions) {
      parts.push(`- ${d.decision ?? 'unknown'} (rationale: ${d.rationale ?? 'N/A'})`);
    }
  }

  if (note) {
    parts.push('');
    parts.push(`Session note: ${note}`);
  }

  if (nextSuggested.length > 0) {
    parts.push('');
    parts.push(`Suggested next: ${nextSuggested.join(', ')}`);
  }

  parts.push('');
  parts.push(
    'Produce a JSON object with keys: keyLearnings (string[]), decisions (string[]), patterns (string[]), nextActions (string[]).',
  );

  return parts.join('\n');
}

/**
 * Ingest a structured session summary directly into brain.db.
 *
 * Stores each field as a typed brain observation. Best-effort — never throws.
 *
 * @param projectRoot - Absolute path to project root.
 * @param sessionId - The session ID the summary belongs to.
 * @param summary - Structured summary with key learnings, decisions, patterns, next actions.
 * @task T140 @epic T134
 */
export async function ingestStructuredSummary(
  projectRoot: string,
  sessionId: string,
  summary: import('@cleocode/contracts').SessionSummaryInput,
): Promise<void> {
  try {
    const { observeBrain } = await import('./brain-retrieval.js');

    // Ingest key learnings
    for (const learning of summary.keyLearnings) {
      if (!learning.trim()) continue;
      await observeBrain(projectRoot, {
        text: learning,
        title: learning.slice(0, 120),
        type: 'discovery',
        sourceSessionId: sessionId,
        sourceType: 'agent',
      });
    }

    // Ingest decisions
    for (const decision of summary.decisions) {
      if (!decision.trim()) continue;
      await observeBrain(projectRoot, {
        text: decision,
        title: decision.slice(0, 120),
        type: 'decision',
        sourceSessionId: sessionId,
        sourceType: 'agent',
      });
    }

    // Ingest patterns
    for (const pattern of summary.patterns) {
      if (!pattern.trim()) continue;
      await observeBrain(projectRoot, {
        text: pattern,
        title: pattern.slice(0, 120),
        type: 'discovery',
        sourceSessionId: sessionId,
        sourceType: 'agent',
      });
    }
  } catch {
    // Best-effort: must never throw
  }
}

// ============================================================================
// getSessionMemoryContext
// ============================================================================

/**
 * Retrieve session memory for a given scope.
 * Used by briefing/handoff to enrich response with brain context.
 *
 * @param projectRoot - Project root directory
 * @param scope - Session scope for filtering (epic:T### or global)
 * @param options - Retrieval options
 * @returns Relevant brain memory entries
 */
export async function getSessionMemoryContext(
  projectRoot: string,
  scope?: { type: string; epicId?: string; rootTaskId?: string },
  options?: { limit?: number; includeDecisions?: boolean; includePatterns?: boolean },
): Promise<SessionMemoryContext> {
  const emptyContext: SessionMemoryContext = {
    recentDecisions: [],
    relevantPatterns: [],
    recentObservations: [],
    recentLearnings: [],
    tokensEstimated: 0,
  };

  let searchBrainCompact: typeof import('./brain-retrieval.js').searchBrainCompact;
  try {
    const retrieval = await import('./brain-retrieval.js');
    searchBrainCompact = retrieval.searchBrainCompact;
  } catch {
    return emptyContext;
  }

  const limit = options?.limit ?? 5;
  const scopeQuery = scope?.rootTaskId ?? scope?.epicId ?? '';

  try {
    // Run parallel searches across brain tables
    const [decisionsResult, patternsResult, observationsResult, learningsResult] =
      await Promise.all([
        // Decisions: scope-filtered if we have a task ID, otherwise recent
        scopeQuery
          ? searchBrainCompact(projectRoot, {
              query: scopeQuery,
              limit,
              tables: ['decisions'],
            })
          : Promise.resolve({
              results: [],
              total: 0,
              tokensEstimated: 0,
            } as SearchBrainCompactResult),

        // Patterns: recent patterns
        searchBrainCompact(projectRoot, {
          query: scopeQuery || 'pattern',
          limit: Math.min(limit, 3),
          tables: ['patterns'],
        }),

        // Observations: recent session-debrief observations
        searchBrainCompact(projectRoot, {
          query: scopeQuery || 'session',
          limit,
          tables: ['observations'],
        }),

        // Learnings: recent learnings
        searchBrainCompact(projectRoot, {
          query: scopeQuery || 'learning',
          limit: Math.min(limit, 5),
          tables: ['learnings'],
        }),
      ]);

    const tokensEstimated =
      decisionsResult.tokensEstimated +
      patternsResult.tokensEstimated +
      observationsResult.tokensEstimated +
      learningsResult.tokensEstimated;

    return {
      recentDecisions: decisionsResult.results,
      relevantPatterns: patternsResult.results,
      recentObservations: observationsResult.results,
      recentLearnings: learningsResult.results,
      tokensEstimated,
    };
  } catch {
    return emptyContext;
  }
}
