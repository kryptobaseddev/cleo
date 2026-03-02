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
  BrainObservationType,
  ObserveBrainResult,
  BrainCompactHit,
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
    const nextPart = Array.isArray(nextSuggested) && nextSuggested.length > 0
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
    result.errors.push(`Failed to load brain modules: ${err instanceof Error ? err.message : String(err)}`);
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
      result.errors.push(`Failed to create observation: ${err instanceof Error ? err.message : String(err)}`);
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
        result.errors.push(`Failed to link observation ${obsResult.id} to task ${item.linkTaskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
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
    const [decisionsResult, patternsResult, observationsResult] = await Promise.all([
      // Decisions: scope-filtered if we have a task ID, otherwise recent
      scopeQuery
        ? searchBrainCompact(projectRoot, {
            query: scopeQuery,
            limit,
            tables: ['decisions'],
          })
        : Promise.resolve({ results: [], total: 0, tokensEstimated: 0 } as SearchBrainCompactResult),

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
    ]);

    const tokensEstimated =
      decisionsResult.tokensEstimated +
      patternsResult.tokensEstimated +
      observationsResult.tokensEstimated;

    return {
      recentDecisions: decisionsResult.results,
      relevantPatterns: patternsResult.results,
      recentObservations: observationsResult.results,
      tokensEstimated,
    };
  } catch {
    return emptyContext;
  }
}
