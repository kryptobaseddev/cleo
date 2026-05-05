/**
 * Memory Engine Compatibility Layer — Brain.db Cognitive Memory
 *
 * Async wrappers around brain.db cognitive memory functions that return
 * EngineResult<T> format for consumption by the dispatch layer.
 *
 * After the memory domain cutover (T5241), this file contains ONLY
 * brain.db-backed operations. Manifest operations moved to
 * pipeline-manifest-compat.ts, and context injection moved to
 * sessions/context-inject.ts.
 *
 * @task T5241
 * @epic T5149
 */

import type { BrainEntrySummary, ContradictionDetail, SupersededEntry } from '@cleocode/contracts';
import type { EngineResult } from '../engine-result.js';
import { getProjectRoot } from '../paths.js';
import { getAccessor } from '../store/data-accessor.js';
// BRAIN accessor for direct table queries (T5241)
import { getBrainAccessor } from '../store/memory-accessor.js';
import { linkMemoryToTask, unlinkMemoryFromTask } from './brain-links.js';
// BRAIN retrieval imports (T5131-T5135)
import {
  fetchBrainEntries,
  type ObserveBrainParams,
  observeBrain,
  searchBrainCompact,
  timelineBrain,
} from './brain-retrieval.js';
// T545: Decision store with quality scoring and graph auto-population
import { storeDecision } from './decisions.js';
import {
  learningStats,
  type SearchLearningParams,
  type StoreLearningParams,
  searchLearnings,
  storeLearning,
} from './learnings.js';
// T419: async reinforcement queue for mental-model writes (ULTRAPLAN L5)
import { isMentalModelObservation, mentalModelQueue } from './mental-model-queue.js';
// BRAIN memory imports (T4770)
import {
  patternStats,
  type SearchPatternParams,
  type StorePatternParams,
  searchPatterns,
  storePattern,
} from './patterns.js';

// ============================================================================
// Internal helpers
// ============================================================================

function resolveRoot(projectRoot?: string): string {
  return projectRoot || getProjectRoot();
}

/**
 * Parse brain.db entry ID prefix to determine the table type.
 *
 * Conventions:
 * - D... -> decision (D001, D-xxx)
 * - P... -> pattern  (P001, P-xxx)
 * - L... -> learning (L001, L-xxx)
 * - O... or CM-... -> observation (O-xxx, CM-xxx)
 */
function parseIdPrefix(id: string): 'decision' | 'pattern' | 'learning' | 'observation' | null {
  if (id.startsWith('D-') || /^D\d/.test(id)) return 'decision';
  if (id.startsWith('P-') || /^P\d/.test(id)) return 'pattern';
  if (id.startsWith('L-') || /^L\d/.test(id)) return 'learning';
  if (id.startsWith('O-') || id.startsWith('O') || id.startsWith('CM-')) return 'observation';
  return null;
}

// ============================================================================
// Brain.db Entry Lookup
// ============================================================================

/**
 * Look up a brain.db entry by ID.
 *
 * @param entryId - Brain entry ID with type prefix (D-, P-, L-, O-, or CM-)
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult containing the typed entry data on success
 *
 * @remarks
 * Parses the ID prefix to determine the entry type (decision, pattern, learning,
 * or observation) and queries the corresponding brain.db table.
 *
 * @example
 * ```typescript
 * const result = await memoryShow('O-abc123', '/project');
 * if (result.success) console.log(result.data.type, result.data.entry);
 * ```
 */
export async function memoryShow(entryId: string, projectRoot?: string): Promise<EngineResult> {
  if (!entryId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'entryId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const entryType = parseIdPrefix(entryId);

    if (!entryType) {
      return {
        success: false,
        error: {
          code: 'E_INVALID_INPUT',
          message: `Unknown entry ID format: '${entryId}'. Expected prefix D-, P-, L-, or O-`,
        },
      };
    }

    const accessor = await getBrainAccessor(root);

    switch (entryType) {
      case 'decision': {
        const row = await accessor.getDecision(entryId);
        if (!row) {
          return {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Decision '${entryId}' not found in brain.db` },
          };
        }
        return { success: true, data: { type: 'decision', entry: row } };
      }
      case 'pattern': {
        const row = await accessor.getPattern(entryId);
        if (!row) {
          return {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Pattern '${entryId}' not found in brain.db` },
          };
        }
        return { success: true, data: { type: 'pattern', entry: row } };
      }
      case 'learning': {
        const row = await accessor.getLearning(entryId);
        if (!row) {
          return {
            success: false,
            error: { code: 'E_NOT_FOUND', message: `Learning '${entryId}' not found in brain.db` },
          };
        }
        return { success: true, data: { type: 'learning', entry: row } };
      }
      case 'observation': {
        const row = await accessor.getObservation(entryId);
        if (!row) {
          return {
            success: false,
            error: {
              code: 'E_NOT_FOUND',
              message: `Observation '${entryId}' not found in brain.db`,
            },
          };
        }
        return { success: true, data: { type: 'observation', entry: row } };
      }
    }
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_BRAIN_SHOW',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// Brain.db Aggregate Stats
// ============================================================================

/**
 * Aggregate stats from brain.db across all tables.
 *
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with observation, decision, pattern, and learning counts
 *
 * @remarks
 * Queries each brain.db table for row counts and returns a combined statistics object.
 * Returns zero counts if brain.db is not initialized.
 *
 * @example
 * ```typescript
 * const result = await memoryBrainStats('/project');
 * if (result.success) console.log(result.data.observations);
 * ```
 */
export async function memoryBrainStats(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(root);
    const nativeDb = getBrainNativeDb();

    if (!nativeDb) {
      return {
        success: true,
        data: {
          observations: 0,
          decisions: 0,
          patterns: 0,
          learnings: 0,
          total: 0,
          message: 'brain.db not initialized',
        },
      };
    }

    const obsCount = (
      nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as { cnt: number }
    ).cnt;
    const decCount = (
      nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_decisions').get() as { cnt: number }
    ).cnt;
    const patCount = (
      nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_patterns').get() as { cnt: number }
    ).cnt;
    const learnCount = (
      nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_learnings').get() as { cnt: number }
    ).cnt;

    return {
      success: true,
      data: {
        observations: obsCount,
        decisions: decCount,
        patterns: patCount,
        learnings: learnCount,
        total: obsCount + decCount + patCount + learnCount,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_BRAIN_STATS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// Brain.db Decision Operations
// ============================================================================

/**
 * Search decisions in brain.db.
 *
 * By default, AGT-* agent dispatch rows are excluded from results so that
 * `cleo memory decision-find` returns only architectural/technical decisions.
 * Pass `includeAgentDispatch: true` to surface execution history as well.
 *
 * @param params - Search parameters (query, limit, includeAgentDispatch, etc.)
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with matching decision entries
 *
 * @remarks
 * Queries the brain.db decisions table with optional text filtering and pagination.
 * T1830: adds `decision_category != 'agent_dispatch'` filter by default.
 *
 * @example
 * ```typescript
 * // Architectural decisions only (default):
 * const result = await memoryDecisionFind({ query: 'auth' }, '/project');
 * // Include AGT-* dispatch rows:
 * const all = await memoryDecisionFind({ query: 'auth', includeAgentDispatch: true }, '/project');
 * ```
 */
export async function memoryDecisionFind(
  params: { query?: string; taskId?: string; limit?: number; includeAgentDispatch?: boolean },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const accessor = await getBrainAccessor(root);
    const includeAgentDispatch = params.includeAgentDispatch === true;

    if (params.query) {
      const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
      await getBrainDb(root);
      const nativeDb = getBrainNativeDb();

      if (!nativeDb) {
        return { success: true, data: { decisions: [], total: 0 } };
      }

      const likePattern = `%${params.query}%`;
      const limit = params.limit ?? 20;
      // T1830: exclude agent_dispatch rows unless explicitly opted-in
      const categoryClause = includeAgentDispatch
        ? ''
        : "AND (decision_category IS NULL OR decision_category != 'agent_dispatch')";
      const rows = nativeDb
        .prepare(
          `SELECT * FROM brain_decisions
        WHERE (decision LIKE ? OR rationale LIKE ?)
        ${categoryClause}
        ORDER BY created_at DESC
        LIMIT ?`,
        )
        .all(likePattern, likePattern, limit);

      return { success: true, data: { decisions: rows, total: rows.length } };
    }

    const decisions = await accessor.findDecisions({
      contextTaskId: params.taskId,
      limit: params.limit ?? 20,
      includeAgentDispatch,
    });

    return { success: true, data: { decisions, total: decisions.length } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_DECISION_FIND',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Store a decision to brain.db.
 *
 * @param params - Decision data including title, rationale, and alternatives
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with the stored decision ID
 *
 * @remarks
 * Creates a new decision entry in brain.db with a D-prefixed ID.
 * Optionally refreshes the memory bridge after storing.
 *
 * @example
 * ```typescript
 * const result = await memoryDecisionStore({ title: 'Use SQLite', rationale: 'Embedded, fast' }, '/project');
 * ```
 */
export async function memoryDecisionStore(
  params: {
    decision: string;
    rationale: string;
    alternatives?: string[];
    taskId?: string;
    sessionId?: string;
    adrPath?: string | null;
    supersedes?: string | null;
    confirmationState?: 'proposed' | 'accepted' | 'superseded';
    decidedBy?: 'owner' | 'council' | 'agent';
  },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.decision) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'decision text is required' },
    };
  }
  if (!params.rationale) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'rationale is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    // Route through storeDecision() so quality scoring and graph auto-population
    // (upsertGraphNode) run on every insert — fixes T545 regression where
    // engine-compat bypassed decisions.ts and wrote directly to the accessor,
    // leaving quality_score NULL and no graph node created.
    const row = await storeDecision(root, {
      type: 'technical',
      decision: params.decision,
      rationale: params.rationale,
      confidence: 'medium',
      outcome: 'pending',
      alternatives: params.alternatives,
      contextTaskId: params.taskId,
      adrPath: params.adrPath ?? undefined,
      supersedes: params.supersedes ?? undefined,
      confirmationState: params.confirmationState,
      decidedBy: params.decidedBy,
    });

    return {
      success: true,
      data: {
        id: row.id,
        type: row.type,
        decision: row.decision,
        createdAt: row.createdAt,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_DECISION_STORE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// BRAIN Retrieval Operations (T5131-T5135) — Renamed from brain.* to flat ops
// ============================================================================

/**
 * Token-efficient brain search returning compact results.
 *
 * @param params - Search parameters including query string and limit
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with compact search hits (IDs and titles)
 *
 * @remarks
 * Designed for the cheapest-first retrieval pattern. Returns minimal fields
 * per hit to conserve tokens. Use memoryFetch for full entry details.
 *
 * @example
 * ```typescript
 * const result = await memoryFind({ query: 'authentication', limit: 10 }, '/project');
 * ```
 */
export async function memoryFind(
  params: {
    query: string;
    limit?: number;
    tables?: string[];
    dateStart?: string;
    dateEnd?: string;
    /** T418: filter results to observations produced by a specific agent. */
    agent?: string;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await searchBrainCompact(root, {
      query: params.query,
      limit: params.limit,
      tables: params.tables as
        | Array<'decisions' | 'patterns' | 'learnings' | 'observations'>
        | undefined,
      dateStart: params.dateStart,
      dateEnd: params.dateEnd,
      agent: params.agent,
    });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_BRAIN_SEARCH',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Chronological context around a brain entry anchor.
 *
 * @param params - Timeline parameters including anchor ID and window size
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with chronologically ordered entries around the anchor
 *
 * @remarks
 * Retrieves entries before and after a given anchor ID for temporal context.
 * Useful for understanding the sequence of observations and decisions.
 *
 * @example
 * ```typescript
 * const result = await memoryTimeline({ anchorId: 'O-abc123', window: 5 }, '/project');
 * ```
 */
export async function memoryTimeline(
  params: { anchor: string; depthBefore?: number; depthAfter?: number },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await timelineBrain(root, {
      anchor: params.anchor,
      depthBefore: params.depthBefore,
      depthAfter: params.depthAfter,
    });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_BRAIN_TIMELINE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Batch fetch brain entries by IDs.
 *
 * @param params - Fetch parameters including an array of entry IDs
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with full entry details for each requested ID
 *
 * @remarks
 * Use after memoryFind to retrieve full details for specific entries.
 * Part of the 3-layer retrieval pattern: search -> filter -> fetch.
 *
 * @example
 * ```typescript
 * const result = await memoryFetch({ ids: ['O-abc123', 'D-def456'] }, '/project');
 * ```
 */
export async function memoryFetch(
  params: { ids: string[] },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await fetchBrainEntries(root, { ids: params.ids });
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_BRAIN_FETCH',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Save an observation to brain.db.
 *
 * @param params - Observation data including text, title, and optional tags
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with the stored observation ID
 *
 * @remarks
 * Creates a new observation entry in brain.db with an O-prefixed ID.
 * Optionally refreshes the memory bridge after storing.
 *
 * @example
 * ```typescript
 * const result = await memoryObserve({ text: 'Auth uses JWT', title: 'Auth discovery' }, '/project');
 * ```
 */
export async function memoryObserve(
  params: {
    text: string;
    title?: string;
    type?: string;
    project?: string;
    sourceSessionId?: string;
    sourceType?: string;
    /** T417: agent provenance — name of the spawned agent producing this observation. */
    agent?: string;
    /**
     * T799: SHA-256 refs of attachments to link to this observation.
     * Passed through to `observeBrain` and stored in `attachments_json`.
     */
    attachmentRefs?: string[];
  },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const observeParams: ObserveBrainParams = {
      text: params.text,
      title: params.title,
      type: params.type as ObserveBrainParams['type'],
      project: params.project,
      sourceSessionId: params.sourceSessionId,
      sourceType: params.sourceType as ObserveBrainParams['sourceType'],
      agent: params.agent,
      attachmentRefs: params.attachmentRefs,
    };

    // T419: route mental-model observations (agent-tagged, relevant type) through
    // the async reinforcement queue for non-blocking writes (ULTRAPLAN L5).
    // All other observations use the existing synchronous path.
    let result: Awaited<ReturnType<typeof observeBrain>>;
    if (isMentalModelObservation(observeParams) && observeParams.agent) {
      result = await mentalModelQueue.enqueue(root, {
        ...observeParams,
        agent: observeParams.agent,
      });
    } else {
      result = await observeBrain(root, observeParams);
    }

    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_BRAIN_OBSERVE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// BRAIN Pattern Operations (T4770)
// ============================================================================

/**
 * Store a pattern to BRAIN memory.
 *
 * @param params - Pattern data including pattern string, type, and confidence
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with the stored pattern ID
 *
 * @remarks
 * Persists a detected pattern (success or failure) to brain.db for future scoring.
 *
 * @example
 * ```typescript
 * const result = await memoryPatternStore({ pattern: 'migration', type: 'success' }, '/project');
 * ```
 */
export async function memoryPatternStore(
  params: StorePatternParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await storePattern(root, params);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_PATTERN_STORE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Search patterns in BRAIN memory.
 *
 * @param params - Search parameters including query and type filter
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with matching pattern entries
 *
 * @remarks
 * Queries the brain.db patterns table with optional type filtering.
 *
 * @example
 * ```typescript
 * const result = await memoryPatternFind({ type: 'success', limit: 10 }, '/project');
 * ```
 */
export async function memoryPatternFind(
  params: SearchPatternParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const results = await searchPatterns(root, params);
    return { success: true, data: { patterns: results, total: results.length } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_PATTERN_SEARCH',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Get pattern memory statistics.
 *
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with pattern counts by type and overall totals
 *
 * @remarks
 * Aggregates pattern data from brain.db to provide type distribution and counts.
 *
 * @example
 * ```typescript
 * const result = await memoryPatternStats('/project');
 * ```
 */
export async function memoryPatternStats(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const stats = await patternStats(root);
    return { success: true, data: stats };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_PATTERN_STATS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// BRAIN Learning Operations (T4770)
// ============================================================================

/**
 * Store a learning to BRAIN memory.
 *
 * @param params - Learning data including text and confidence level
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with the stored learning ID
 *
 * @remarks
 * Creates a new learning entry in brain.db with an L-prefixed ID.
 *
 * @example
 * ```typescript
 * const result = await memoryLearningStore({ text: 'Drizzle v1 requires beta flag' }, '/project');
 * ```
 */
export async function memoryLearningStore(
  params: StoreLearningParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await storeLearning(root, params);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_LEARNING_STORE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Search learnings in BRAIN memory.
 *
 * @param params - Search parameters including query and limit
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with matching learning entries
 *
 * @remarks
 * Queries the brain.db learnings table with optional text filtering.
 *
 * @example
 * ```typescript
 * const result = await memoryLearningFind({ query: 'drizzle' }, '/project');
 * ```
 */
export async function memoryLearningFind(
  params: SearchLearningParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const results = await searchLearnings(root, params);
    return { success: true, data: { learnings: results, total: results.length } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_LEARNING_SEARCH',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Get learning memory statistics.
 *
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with learning counts and confidence distribution
 *
 * @remarks
 * Aggregates learning data from brain.db to provide totals and breakdowns.
 *
 * @example
 * ```typescript
 * const result = await memoryLearningStats('/project');
 * ```
 */
export async function memoryLearningStats(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const stats = await learningStats(root);
    return { success: true, data: stats };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_LEARNING_STATS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// BRAIN Advanced Queries & Links (T5241)
// ============================================================================

/**
 * Find contradictory entries in brain.db.
 *
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with pairs of contradicting observations
 *
 * @remarks
 * Scans brain.db for observations that contradict each other based on
 * semantic similarity and opposing sentiment or content.
 *
 * @example
 * ```typescript
 * const result = await memoryContradictions('/project');
 * if (result.success) console.log(result.data.contradictions);
 * ```
 */
export async function memoryContradictions(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(root);
    const nativeDb = getBrainNativeDb();

    if (!nativeDb) {
      return { success: true, data: { contradictions: [] } };
    }

    // Negation patterns for detecting contradictions (adapted from manifest logic)
    const negationPairs: Array<[RegExp, RegExp]> = [
      [/\bdoes NOT\b/i, /\bdoes\b(?!.*\bnot\b)/i],
      [/\bcannot\b/i, /\bcan\b(?!.*\bnot\b)/i],
      [/\bno\s+\w+\s+required\b/i, /\brequired\b(?!.*\bno\b)/i],
      [
        /\bnot\s+(?:available|supported|possible|recommended)\b/i,
        /\b(?:available|supported|possible|recommended)\b(?!.*\bnot\b)/i,
      ],
      [/\bwithout\b/i, /\brequires?\b/i],
      [/\bavoid\b/i, /\buse\b/i],
      [/\bdeprecated\b/i, /\brecommended\b/i],
      [/\banti-pattern\b/i, /\bbest practice\b/i],
    ];

    // Fetch all decisions with context for comparison
    const decisions = nativeDb
      .prepare(`
      SELECT id, type, decision, rationale, context_task_id, created_at
      FROM brain_decisions
      ORDER BY created_at DESC
    `)
      .all() as Array<{
      id: string;
      type: string;
      decision: string;
      rationale: string;
      context_task_id: string | null;
      created_at: string;
    }>;

    // Fetch all patterns
    const patterns = nativeDb
      .prepare(`
      SELECT id, type, pattern, context, anti_pattern, created_at
      FROM brain_patterns
      ORDER BY created_at DESC
    `)
      .all() as Array<{
      id: string;
      type: string;
      pattern: string;
      context: string;
      anti_pattern: string | null;
      created_at: string;
    }>;

    // Fetch all learnings
    const learnings = nativeDb
      .prepare(`
      SELECT id, insight, source, created_at
      FROM brain_learnings
      ORDER BY created_at DESC
    `)
      .all() as Array<{
      id: string;
      insight: string;
      source: string;
      created_at: string;
    }>;

    const contradictions: ContradictionDetail[] = [];
    const seenPairs = new Set<string>();

    // Helper to create sorted pair key
    const pairKey = (idA: string, idB: string) => (idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`);

    // Check decisions against each other (grouped by task context)
    const decisionsByTask = new Map<string | null, typeof decisions>();
    for (const d of decisions) {
      const key = d.context_task_id;
      if (!decisionsByTask.has(key)) decisionsByTask.set(key, []);
      decisionsByTask.get(key)!.push(d);
    }

    for (const [taskId, taskDecisions] of decisionsByTask) {
      if (taskDecisions.length < 2) continue;

      for (let i = 0; i < taskDecisions.length; i++) {
        for (let j = i + 1; j < taskDecisions.length; j++) {
          const a = taskDecisions[i]!;
          const b = taskDecisions[j]!;
          const key = pairKey(a.id, b.id);
          if (seenPairs.has(key)) continue;

          const contentA = `${a.decision} ${a.rationale}`;
          const contentB = `${b.decision} ${b.rationale}`;

          for (const [patternNeg, patternPos] of negationPairs) {
            if (
              (patternNeg.test(contentA) && patternPos.test(contentB)) ||
              (patternPos.test(contentA) && patternNeg.test(contentB))
            ) {
              seenPairs.add(key);
              contradictions.push({
                entryA: {
                  id: a.id,
                  type: 'decision',
                  content: a.decision,
                  createdAt: a.created_at,
                },
                entryB: {
                  id: b.id,
                  type: 'decision',
                  content: b.decision,
                  createdAt: b.created_at,
                },
                context: taskId || undefined,
                conflictDetails: `Negation pattern: "${contentA.slice(0, 80)}..." vs "${contentB.slice(0, 80)}..."`,
              });
              break;
            }
          }
        }
      }
    }

    // Check patterns with anti-patterns
    for (const p of patterns) {
      if (p.anti_pattern) {
        contradictions.push({
          entryA: { id: p.id, type: 'pattern', content: p.pattern, createdAt: p.created_at },
          entryB: {
            id: p.id,
            type: 'anti-pattern',
            content: p.anti_pattern,
            createdAt: p.created_at,
          },
          conflictDetails: `Pattern defines its own anti-pattern`,
        });
      }
    }

    // Check learnings against each other
    for (let i = 0; i < learnings.length; i++) {
      for (let j = i + 1; j < learnings.length; j++) {
        const a = learnings[i]!;
        const b = learnings[j]!;
        const key = pairKey(a.id, b.id);
        if (seenPairs.has(key)) continue;

        for (const [patternNeg, patternPos] of negationPairs) {
          if (
            (patternNeg.test(a.insight) && patternPos.test(b.insight)) ||
            (patternPos.test(a.insight) && patternNeg.test(b.insight))
          ) {
            seenPairs.add(key);
            contradictions.push({
              entryA: { id: a.id, type: 'learning', content: a.insight, createdAt: a.created_at },
              entryB: { id: b.id, type: 'learning', content: b.insight, createdAt: b.created_at },
              conflictDetails: `Learning contradiction detected`,
            });
            break;
          }
        }
      }
    }

    return { success: true, data: { contradictions } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_CONTRADICTIONS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Find superseded entries in brain.db.
 *
 * Identifies entries that have been superseded by newer entries on the same topic.
 *
 * @param params - Superseded search parameters
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with superseded entry pairs and their replacements
 *
 * @remarks
 * Scans brain.db for entries where a newer observation or decision covers
 * the same topic, rendering the older entry obsolete.
 *
 * For brain.db, we group by:
 * - Decisions: type + contextTaskId/contextEpicId
 * - Patterns: type + context (first 100 chars for similarity)
 * - Learnings: source + applicableTypes
 * - Observations: type + project
 *
 * @example
 * ```typescript
 * const result = await memorySuperseded({ type: 'decision' }, '/project');
 * ```
 */
export async function memorySuperseded(
  params?: { type?: string; project?: string },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(root);
    const nativeDb = getBrainNativeDb();

    if (!nativeDb) {
      return { success: true, data: { superseded: [] } };
    }

    const superseded: SupersededEntry[] = [];

    // Helper to normalize and group by key
    const addSuperseded = (entries: BrainEntrySummary[], groupKey: string) => {
      if (entries.length < 2) return;

      // Sort by creation date (oldest first)
      const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      // All but the newest are superseded by the newest
      const newest = sorted[sorted.length - 1];
      for (let i = 0; i < sorted.length - 1; i++) {
        superseded.push({
          oldEntry: sorted[i],
          replacement: newest,
          grouping: groupKey,
        });
      }
    };

    // === DECISIONS: Group by type + contextTaskId/contextEpicId ===
    const decisionGroups = new Map<string, BrainEntrySummary[]>();
    const decisionQuery = params?.type
      ? `SELECT id, type, decision, context_task_id, context_epic_id, created_at
          FROM brain_decisions WHERE type = ? ORDER BY created_at DESC`
      : `SELECT id, type, decision, context_task_id, context_epic_id, created_at
          FROM brain_decisions ORDER BY created_at DESC`;
    const decisionParams = params?.type ? [params.type] : [];
    const decisions = nativeDb.prepare(decisionQuery).all(...decisionParams) as Array<{
      id: string;
      type: string;
      decision: string;
      context_task_id: string | null;
      context_epic_id: string | null;
      created_at: string;
    }>;

    for (const d of decisions) {
      const contextKey = d.context_task_id || d.context_epic_id || 'general';
      const groupKey = `decision:${d.type}:${contextKey}`;
      if (!decisionGroups.has(groupKey)) decisionGroups.set(groupKey, []);
      decisionGroups.get(groupKey)!.push({
        id: d.id,
        type: d.type,
        createdAt: d.created_at,
        summary: d.decision.slice(0, 100),
      });
    }

    for (const [key, entries] of decisionGroups) {
      addSuperseded(entries, key);
    }

    // === PATTERNS: Group by type + context (first 100 chars for similarity) ===
    const patternGroups = new Map<string, BrainEntrySummary[]>();
    const patternQuery = params?.type
      ? `SELECT id, type, pattern, context, extracted_at
          FROM brain_patterns WHERE type = ? ORDER BY extracted_at DESC`
      : `SELECT id, type, pattern, context, extracted_at
          FROM brain_patterns ORDER BY extracted_at DESC`;
    const patternParams = params?.type ? [params.type] : [];
    const patterns = nativeDb.prepare(patternQuery).all(...patternParams) as Array<{
      id: string;
      type: string;
      pattern: string;
      context: string;
      extracted_at: string;
    }>;

    for (const p of patterns) {
      // Use first 80 chars of context as grouping key for similarity
      const contextKey = p.context?.slice(0, 80) || 'unknown';
      const groupKey = `pattern:${p.type}:${contextKey}`;
      if (!patternGroups.has(groupKey)) patternGroups.set(groupKey, []);
      patternGroups.get(groupKey)!.push({
        id: p.id,
        type: p.type,
        createdAt: p.extracted_at,
        summary: p.pattern.slice(0, 100),
      });
    }

    for (const [key, entries] of patternGroups) {
      addSuperseded(entries, key);
    }

    // === LEARNINGS: Group by source + applicableTypes ===
    const learningGroups = new Map<string, BrainEntrySummary[]>();
    const learningQuery = `SELECT id, source, insight, applicable_types_json, created_at
        FROM brain_learnings ORDER BY created_at DESC`;
    const learnings = nativeDb.prepare(learningQuery).all() as Array<{
      id: string;
      source: string;
      insight: string;
      applicable_types_json: string | null;
      created_at: string;
    }>;

    for (const l of learnings) {
      const applicableTypes = l.applicable_types_json
        ? JSON.parse(l.applicable_types_json).slice(0, 2).join(',')
        : 'general';
      const groupKey = `learning:${l.source}:${applicableTypes}`;
      if (!learningGroups.has(groupKey)) learningGroups.set(groupKey, []);
      learningGroups.get(groupKey)!.push({
        id: l.id,
        type: 'learning',
        createdAt: l.created_at,
        summary: l.insight.slice(0, 100),
      });
    }

    for (const [key, entries] of learningGroups) {
      addSuperseded(entries, key);
    }

    // === OBSERVATIONS: Group by type + project ===
    const observationGroups = new Map<string, BrainEntrySummary[]>();
    const observationQuery = params?.type
      ? `SELECT id, type, title, project, created_at
          FROM brain_observations WHERE type = ? ORDER BY created_at DESC`
      : `SELECT id, type, title, project, created_at
          FROM brain_observations ORDER BY created_at DESC`;
    const observationParams = params?.type ? [params.type] : [];
    const observations = nativeDb.prepare(observationQuery).all(...observationParams) as Array<{
      id: string;
      type: string;
      title: string;
      project: string | null;
      created_at: string;
    }>;

    for (const o of observations) {
      const projectKey = params?.project ? params.project : o.project || 'general';
      const groupKey = `observation:${o.type}:${projectKey}`;
      if (!observationGroups.has(groupKey)) observationGroups.set(groupKey, []);
      observationGroups.get(groupKey)!.push({
        id: o.id,
        type: o.type,
        createdAt: o.created_at,
        summary: o.title.slice(0, 100),
      });
    }

    for (const [key, entries] of observationGroups) {
      addSuperseded(entries, key);
    }

    return { success: true, data: { superseded, total: superseded.length } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MEMORY_SUPERSEDED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Link a brain entry to a task.
 *
 * @param params - Link parameters including entryId and taskId
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult confirming the link was created
 *
 * @remarks
 * Creates an association between a brain.db entry and a task in tasks.db.
 * Used for traceability between memory entries and the work they relate to.
 *
 * @example
 * ```typescript
 * const result = await memoryLink({ entryId: 'O-abc123', taskId: 'T042' }, '/project');
 * ```
 */
export async function memoryLink(
  params: { taskId: string; entryId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId || !params.entryId) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and entryId are required' },
    };
  }

  const entryType = parseIdPrefix(params.entryId);
  if (!entryType) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'Invalid entryId format' },
    };
  }

  try {
    const root = resolveRoot(projectRoot);
    await linkMemoryToTask(root, entryType, params.entryId, params.taskId, 'applies_to');
    return {
      success: true,
      data: { linked: true, taskId: params.taskId, entryId: params.entryId },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MEMORY_LINK',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Remove a link between a brain entry and a task.
 *
 * @param params - Unlink parameters including entryId and taskId
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult confirming the link was removed
 *
 * @remarks
 * Removes the association created by memoryLink. Idempotent if the link
 * does not exist.
 *
 * @example
 * ```typescript
 * const result = await memoryUnlink({ entryId: 'O-abc123', taskId: 'T042' }, '/project');
 * ```
 */
export async function memoryUnlink(
  params: { taskId: string; entryId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId || !params.entryId) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and entryId are required' },
    };
  }

  const entryType = parseIdPrefix(params.entryId);
  if (!entryType) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'Invalid entryId format' },
    };
  }

  try {
    const root = resolveRoot(projectRoot);
    await unlinkMemoryFromTask(root, entryType, params.entryId, params.taskId, 'applies_to');
    return {
      success: true,
      data: { unlinked: true, taskId: params.taskId, entryId: params.entryId },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MEMORY_UNLINK',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// PageIndex Graph Operations (T5385)
// ============================================================================

/**
 * Add a node or edge to the PageIndex graph.
 *
 * @param params - Graph add parameters (node data or edge endpoints)
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult confirming the node or edge was added
 *
 * @remarks
 * Supports adding both nodes (concepts) and edges (relationships) to the
 * brain.db knowledge graph (PageIndex).
 *
 * @example
 * ```typescript
 * const result = await memoryGraphAdd({ type: 'node', label: 'auth', nodeType: 'concept' }, '/project');
 * ```
 */
export async function memoryGraphAdd(
  params: {
    nodeId?: string;
    nodeType?: string;
    label?: string;
    metadataJson?: string;
    fromId?: string;
    toId?: string;
    edgeType?: string;
    weight?: number;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const accessor = await getBrainAccessor(root);

    // Edge mode: fromId + toId + edgeType
    if (params.fromId && params.toId && params.edgeType) {
      const edge = await accessor.addPageEdge({
        fromId: params.fromId,
        toId: params.toId,
        edgeType:
          params.edgeType as typeof import('../store/memory-schema.js').BRAIN_EDGE_TYPES[number],
        weight: params.weight,
      });
      return { success: true, data: { type: 'edge', edge } };
    }

    // Node mode: nodeId + nodeType + label
    if (params.nodeId && params.nodeType && params.label) {
      const node = await accessor.addPageNode({
        id: params.nodeId,
        nodeType:
          params.nodeType as typeof import('../store/memory-schema.js').BRAIN_NODE_TYPES[number],
        label: params.label,
        metadataJson: params.metadataJson,
      });
      return { success: true, data: { type: 'node', node } };
    }

    return {
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        message:
          'Provide (nodeId + nodeType + label) for a node or (fromId + toId + edgeType) for an edge',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_ADD',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Get a node and its edges from the PageIndex graph.
 *
 * @param params - Parameters including the node ID to look up
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with the node data and its connected edges
 *
 * @remarks
 * Returns the full node record plus all edges where the node appears as
 * either source or target.
 *
 * @example
 * ```typescript
 * const result = await memoryGraphShow({ nodeId: 'auth' }, '/project');
 * ```
 */
export async function memoryGraphShow(
  params: { nodeId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.nodeId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'nodeId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const accessor = await getBrainAccessor(root);

    const node = await accessor.getPageNode(params.nodeId);
    if (!node) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Node '${params.nodeId}' not found` },
      };
    }

    const edges = await accessor.getPageEdges(params.nodeId, 'both');
    return { success: true, data: { node, edges } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_SHOW',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Get neighbor nodes from the PageIndex graph.
 *
 * @param params - Parameters including the node ID and optional depth
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with neighboring nodes and connecting edges
 *
 * @remarks
 * Traverses the knowledge graph outward from a given node to find related
 * concepts within the specified depth.
 *
 * @example
 * ```typescript
 * const result = await memoryGraphNeighbors({ nodeId: 'auth', depth: 2 }, '/project');
 * ```
 */
export async function memoryGraphNeighbors(
  params: { nodeId: string; edgeType?: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.nodeId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'nodeId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const accessor = await getBrainAccessor(root);

    const neighbors = await accessor.getNeighbors(
      params.nodeId,
      params.edgeType as
        | typeof import('../store/memory-schema.js').BRAIN_EDGE_TYPES[number]
        | undefined,
    );
    return { success: true, data: { neighbors, total: neighbors.length } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_NEIGHBORS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// BRAIN Reasoning & Hybrid Search Operations (T5388-T5393)
// ============================================================================

/**
 * Causal trace through task dependency chains.
 *
 * @param params - Parameters including the entry or task ID to trace
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with the causal chain explaining why something happened
 *
 * @remarks
 * Traces backward through task dependencies and brain entries to build
 * an explanation chain for a given decision or observation.
 *
 * @example
 * ```typescript
 * const result = await memoryReasonWhy({ id: 'D-abc123' }, '/project');
 * ```
 */
export async function memoryReasonWhy(
  params: { taskId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const taskAccessor = await getAccessor(root);
    const { reasonWhy } = await import('./brain-reasoning.js');
    const result = await reasonWhy(params.taskId, root, taskAccessor);
    return { success: true, data: result };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_REASON_WHY',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Find semantically similar entries.
 *
 * @param params - Parameters including the source entry ID or query text
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with entries ranked by semantic similarity
 *
 * @remarks
 * Uses embedding vectors or text similarity to find brain entries that are
 * semantically close to the given reference.
 *
 * @example
 * ```typescript
 * const result = await memoryReasonSimilar({ id: 'O-abc123', limit: 5 }, '/project');
 * ```
 */
export async function memoryReasonSimilar(
  params: { entryId: string; limit?: number },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.entryId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'entryId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const { reasonSimilar } = await import('./brain-reasoning.js');
    const results = await reasonSimilar(params.entryId, root, params.limit);
    return { success: true, data: { results, total: results.length } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_REASON_SIMILAR',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Hybrid search across FTS5, vector, and graph.
 *
 * @param params - Search parameters including query and optional mode/limit
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with merged and ranked results from all search backends
 *
 * @remarks
 * Combines full-text search (FTS5), vector similarity, and graph traversal
 * to produce comprehensive search results with merged relevance scoring.
 *
 * @example
 * ```typescript
 * const result = await memorySearchHybrid({ query: 'authentication flow' }, '/project');
 * ```
 */
export async function memorySearchHybrid(
  params: {
    query: string;
    limit?: number;
    /**
     * @deprecated Weight parameters are unused — hybrid search now uses
     * Reciprocal Rank Fusion (RRF) which is rank-based and does not require
     * per-source weights. This field is accepted but silently ignored.
     */
    ftsWeight?: number;
    /**
     * @deprecated Weight parameters are unused — hybrid search now uses
     * Reciprocal Rank Fusion (RRF) which is rank-based and does not require
     * per-source weights. This field is accepted but silently ignored.
     */
    vecWeight?: number;
    /**
     * @deprecated Weight parameters are unused — hybrid search now uses
     * Reciprocal Rank Fusion (RRF) which is rank-based and does not require
     * per-source weights. This field is accepted but silently ignored.
     */
    graphWeight?: number;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.query) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'query is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const { hybridSearch } = await import('./brain-search.js');
    const results = await hybridSearch(params.query, root, {
      limit: params.limit,
    });
    return { success: true, data: { results, total: results.length } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_HYBRID_SEARCH',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// Brain Graph Traversal Operations (T535)
// ============================================================================

/**
 * BFS traversal of the brain knowledge graph from a seed node.
 *
 * @param params - Traversal parameters: nodeId and optional maxDepth (default 3)
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with traversal nodes annotated with depth
 *
 * @remarks
 * Uses a recursive CTE against brain_page_nodes / brain_page_edges.
 * Follows edges bidirectionally. Returns the seed node at depth 0.
 *
 * @example
 * ```typescript
 * const result = await memoryGraphTrace({ nodeId: 'decision:D-abc123', maxDepth: 2 }, '/project');
 * ```
 */
export async function memoryGraphTrace(
  params: { nodeId: string; maxDepth?: number },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.nodeId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'nodeId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const { traceBrainGraph } = await import('./graph-queries.js');
    const nodes = await traceBrainGraph(root, params.nodeId, params.maxDepth ?? 3);

    if (nodes.length === 0) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Node '${params.nodeId}' not found in brain graph` },
      };
    }

    return { success: true, data: { nodes, total: nodes.length, seed: params.nodeId } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_TRACE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Return the immediate (1-hop) neighbours of a brain graph node.
 *
 * @param params - Parameters: nodeId, optional edgeType filter
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with neighbour nodes and edge metadata
 *
 * @remarks
 * Follows edges in both directions. Results include direction ('in'/'out'),
 * edge type, and weight.
 *
 * @example
 * ```typescript
 * const result = await memoryGraphRelated({ nodeId: 'decision:D-abc123', edgeType: 'applies_to' }, '/project');
 * ```
 */
export async function memoryGraphRelated(
  params: { nodeId: string; edgeType?: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.nodeId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'nodeId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const { relatedBrainNodes } = await import('./graph-queries.js');
    const related = await relatedBrainNodes(root, params.nodeId, params.edgeType);
    return { success: true, data: { related, total: related.length, seed: params.nodeId } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_RELATED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Return a 360-degree context view of a single brain graph node.
 *
 * @param params - Parameters: nodeId
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with the node, all edges, and neighbouring nodes
 *
 * @remarks
 * Includes the node itself, in-edges, out-edges, and all immediately
 * reachable neighbour nodes with their edge relationships.
 *
 * @example
 * ```typescript
 * const result = await memoryGraphContext({ nodeId: 'decision:D-abc123' }, '/project');
 * ```
 */
export async function memoryGraphContext(
  params: { nodeId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.nodeId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'nodeId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const { contextBrainNode } = await import('./graph-queries.js');
    const context = await contextBrainNode(root, params.nodeId);

    if (!context) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Node '${params.nodeId}' not found in brain graph` },
      };
    }

    return { success: true, data: context };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_CONTEXT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Return aggregate statistics for the brain knowledge graph.
 *
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult with node counts by type, edge counts by type, and totals
 *
 * @example
 * ```typescript
 * const result = await memoryGraphStatsFull('/project');
 * ```
 */
export async function memoryGraphStatsFull(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const { graphStats } = await import('./graph-queries.js');
    const stats = await graphStats(root);
    return { success: true, data: stats };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_STATS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Remove a node or edge from the PageIndex graph.
 *
 * @param params - Parameters specifying the node or edge to remove
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult confirming the removal
 *
 * @remarks
 * Removes a node (and its connected edges) or a specific edge from the
 * brain.db knowledge graph.
 *
 * @example
 * ```typescript
 * const result = await memoryGraphRemove({ type: 'node', nodeId: 'stale-concept' }, '/project');
 * ```
 */
export async function memoryGraphRemove(
  params: {
    nodeId?: string;
    fromId?: string;
    toId?: string;
    edgeType?: string;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const accessor = await getBrainAccessor(root);

    // Edge removal: fromId + toId + edgeType
    if (params.fromId && params.toId && params.edgeType) {
      await accessor.removePageEdge(
        params.fromId,
        params.toId,
        params.edgeType as typeof import('../store/memory-schema.js').BRAIN_EDGE_TYPES[number],
      );
      return {
        success: true,
        data: {
          removed: 'edge',
          fromId: params.fromId,
          toId: params.toId,
          edgeType: params.edgeType,
        },
      };
    }

    // Node removal: nodeId (cascades edges)
    if (params.nodeId) {
      await accessor.removePageNode(params.nodeId);
      return { success: true, data: { removed: 'node', nodeId: params.nodeId } };
    }

    return {
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: 'Provide nodeId to remove a node or (fromId + toId + edgeType) to remove an edge',
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_GRAPH_REMOVE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// Quality Feedback Report (T555)
// ============================================================================

/**
 * Return the BRAIN memory quality dashboard report.
 *
 * Aggregates retrieval log, usage log, and all four typed tables to produce
 * a MemoryQualityReport with tier distribution, top/never-retrieved entries,
 * quality score distribution, and noise ratio.
 *
 * @param projectRoot - Optional project root path; defaults to resolved root
 * @returns EngineResult containing a MemoryQualityReport object
 *
 * @example
 * ```typescript
 * const result = await memoryQualityReport('/project');
 * if (result.success) console.log(result.data.noiseRatio);
 * ```
 */
export async function memoryQualityReport(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const { getMemoryQualityReport } = await import('./quality-feedback.js');
    const report = await getMemoryQualityReport(root);
    return { success: true, data: report };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_QUALITY_REPORT',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
