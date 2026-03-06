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

// BRAIN memory imports (T4770)
import {
  storePattern,
  searchPatterns,
  patternStats,
  type StorePatternParams,
  type SearchPatternParams,
} from './patterns.js';
import {
  storeLearning,
  searchLearnings,
  learningStats,
  type StoreLearningParams,
  type SearchLearningParams,
} from './learnings.js';

// BRAIN retrieval imports (T5131-T5135)
import {
  searchBrainCompact,
  timelineBrain,
  fetchBrainEntries,
  observeBrain,
  type ObserveBrainParams,
} from './brain-retrieval.js';

// BRAIN accessor for direct table queries (T5241)
import { getBrainAccessor } from '../../store/brain-accessor.js';
import { linkMemoryToTask, unlinkMemoryFromTask } from './brain-links.js';
import { getBrainDb, getBrainNativeDb } from '../../store/brain-sqlite.js';
import { getProjectRoot } from '../paths.js';

import type { EngineResult } from '../../dispatch/engines/_error.js';

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

/** memory.show - Look up a brain.db entry by ID */
export async function memoryShow(
  entryId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!entryId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'entryId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const entryType = parseIdPrefix(entryId);

    if (!entryType) {
      return {
        success: false,
        error: { code: 'E_INVALID_INPUT', message: `Unknown entry ID format: '${entryId}'. Expected prefix D-, P-, L-, or O-` },
      };
    }

    const accessor = await getBrainAccessor(root);

    switch (entryType) {
      case 'decision': {
        const row = await accessor.getDecision(entryId);
        if (!row) {
          return { success: false, error: { code: 'E_NOT_FOUND', message: `Decision '${entryId}' not found in brain.db` } };
        }
        return { success: true, data: { type: 'decision', entry: row } };
      }
      case 'pattern': {
        const row = await accessor.getPattern(entryId);
        if (!row) {
          return { success: false, error: { code: 'E_NOT_FOUND', message: `Pattern '${entryId}' not found in brain.db` } };
        }
        return { success: true, data: { type: 'pattern', entry: row } };
      }
      case 'learning': {
        const row = await accessor.getLearning(entryId);
        if (!row) {
          return { success: false, error: { code: 'E_NOT_FOUND', message: `Learning '${entryId}' not found in brain.db` } };
        }
        return { success: true, data: { type: 'learning', entry: row } };
      }
      case 'observation': {
        const row = await accessor.getObservation(entryId);
        if (!row) {
          return { success: false, error: { code: 'E_NOT_FOUND', message: `Observation '${entryId}' not found in brain.db` } };
        }
        return { success: true, data: { type: 'observation', entry: row } };
      }
    }
  } catch (error) {
    return { success: false, error: { code: 'E_BRAIN_SHOW', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// Brain.db Aggregate Stats
// ============================================================================

/** memory.stats - Aggregate stats from brain.db across all tables */
export async function memoryBrainStats(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
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

    const obsCount = (nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as { cnt: number }).cnt;
    const decCount = (nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_decisions').get() as { cnt: number }).cnt;
    const patCount = (nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_patterns').get() as { cnt: number }).cnt;
    const learnCount = (nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_learnings').get() as { cnt: number }).cnt;

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
    return { success: false, error: { code: 'E_BRAIN_STATS', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// Brain.db Decision Operations
// ============================================================================

/** memory.decision.find - Search decisions in brain.db */
export async function memoryDecisionFind(
  params: { query?: string; taskId?: string; limit?: number },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const accessor = await getBrainAccessor(root);

    if (params.query) {
      await getBrainDb(root);
      const nativeDb = getBrainNativeDb();

      if (!nativeDb) {
        return { success: true, data: { decisions: [], total: 0 } };
      }

      const likePattern = `%${params.query}%`;
      const limit = params.limit ?? 20;
      const rows = nativeDb.prepare(`
        SELECT * FROM brain_decisions
        WHERE decision LIKE ? OR rationale LIKE ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(likePattern, likePattern, limit) as unknown as Array<Record<string, unknown>>;

      return { success: true, data: { decisions: rows, total: rows.length } };
    }

    const decisions = await accessor.findDecisions({
      contextTaskId: params.taskId,
      limit: params.limit ?? 20,
    });

    return { success: true, data: { decisions, total: decisions.length } };
  } catch (error) {
    return { success: false, error: { code: 'E_DECISION_FIND', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.decision.store - Store a decision to brain.db */
export async function memoryDecisionStore(
  params: { decision: string; rationale: string; alternatives?: string[]; taskId?: string; sessionId?: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.decision) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'decision text is required' } };
  }
  if (!params.rationale) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'rationale is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const accessor = await getBrainAccessor(root);
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const id = `D-${Date.now().toString(36)}`;

    const row = await accessor.addDecision({
      id,
      type: 'technical',
      decision: params.decision,
      rationale: params.rationale,
      confidence: 'medium',
      outcome: 'pending',
      alternativesJson: params.alternatives ? JSON.stringify(params.alternatives) : null,
      contextTaskId: params.taskId ?? null,
      contextEpicId: null,
      contextPhase: null,
      createdAt: now,
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
    return { success: false, error: { code: 'E_DECISION_STORE', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// BRAIN Retrieval Operations (T5131-T5135) — Renamed from brain.* to flat ops
// ============================================================================

/** memory.find - Token-efficient brain search */
export async function memoryFind(
  params: { query: string; limit?: number; tables?: string[]; dateStart?: string; dateEnd?: string },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await searchBrainCompact(root, {
      query: params.query,
      limit: params.limit,
      tables: params.tables as Array<'decisions' | 'patterns' | 'learnings' | 'observations'> | undefined,
      dateStart: params.dateStart,
      dateEnd: params.dateEnd,
    });
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_BRAIN_SEARCH', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.timeline - Chronological context around anchor */
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
    return { success: false, error: { code: 'E_BRAIN_TIMELINE', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.fetch - Batch fetch brain entries by IDs */
export async function memoryFetch(
  params: { ids: string[] },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await fetchBrainEntries(root, { ids: params.ids });
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_BRAIN_FETCH', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.observe - Save observation to brain */
export async function memoryObserve(
  params: { text: string; title?: string; type?: string; project?: string; sourceSessionId?: string; sourceType?: string },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await observeBrain(root, {
      text: params.text,
      title: params.title,
      type: params.type as ObserveBrainParams['type'],
      project: params.project,
      sourceSessionId: params.sourceSessionId,
      sourceType: params.sourceType as ObserveBrainParams['sourceType'],
    });
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_BRAIN_OBSERVE', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// BRAIN Pattern Operations (T4770)
// ============================================================================

/** memory.pattern.store - Store a pattern to BRAIN memory */
export async function memoryPatternStore(
  params: StorePatternParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await storePattern(root, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_PATTERN_STORE', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.pattern.find - Search patterns in BRAIN memory */
export async function memoryPatternFind(
  params: SearchPatternParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const results = await searchPatterns(root, params);
    return { success: true, data: { patterns: results, total: results.length } };
  } catch (error) {
    return { success: false, error: { code: 'E_PATTERN_SEARCH', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.pattern.stats - Get pattern memory statistics */
export async function memoryPatternStats(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const stats = await patternStats(root);
    return { success: true, data: stats };
  } catch (error) {
    return { success: false, error: { code: 'E_PATTERN_STATS', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// BRAIN Learning Operations (T4770)
// ============================================================================

/** memory.learning.store - Store a learning to BRAIN memory */
export async function memoryLearningStore(
  params: StoreLearningParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const result = await storeLearning(root, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_LEARNING_STORE', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.learning.find - Search learnings in BRAIN memory */
export async function memoryLearningFind(
  params: SearchLearningParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const results = await searchLearnings(root, params);
    return { success: true, data: { learnings: results, total: results.length } };
  } catch (error) {
    return { success: false, error: { code: 'E_LEARNING_SEARCH', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.learning.stats - Get learning memory statistics */
export async function memoryLearningStats(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    const stats = await learningStats(root);
    return { success: true, data: stats };
  } catch (error) {
    return { success: false, error: { code: 'E_LEARNING_STATS', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// BRAIN Advanced Queries & Links (T5241)
// ============================================================================

/** memory.contradictions - Find contradictory entries in brain.db */
export async function memoryContradictions(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
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
      [/\bnot\s+(?:available|supported|possible|recommended)\b/i, /\b(?:available|supported|possible|recommended)\b(?!.*\bnot\b)/i],
      [/\bwithout\b/i, /\brequires?\b/i],
      [/\bavoid\b/i, /\buse\b/i],
      [/\bdeprecated\b/i, /\brecommended\b/i],
      [/\banti-pattern\b/i, /\bbest practice\b/i],
    ];

    // Fetch all decisions with context for comparison
    const decisions = nativeDb.prepare(`
      SELECT id, type, decision, rationale, context_task_id, created_at
      FROM brain_decisions
      ORDER BY created_at DESC
    `).all() as Array<{
      id: string;
      type: string;
      decision: string;
      rationale: string;
      context_task_id: string | null;
      created_at: string;
    }>;

    // Fetch all patterns
    const patterns = nativeDb.prepare(`
      SELECT id, type, pattern, context, anti_pattern, created_at
      FROM brain_patterns
      ORDER BY created_at DESC
    `).all() as Array<{
      id: string;
      type: string;
      pattern: string;
      context: string;
      anti_pattern: string | null;
      created_at: string;
    }>;

    // Fetch all learnings
    const learnings = nativeDb.prepare(`
      SELECT id, insight, source, created_at
      FROM brain_learnings
      ORDER BY created_at DESC
    `).all() as Array<{
      id: string;
      insight: string;
      source: string;
      created_at: string;
    }>;

    interface ContradictionDetail {
      entryA: { id: string; type: string; content: string; createdAt: string };
      entryB: { id: string; type: string; content: string; createdAt: string };
      context?: string;
      conflictDetails: string;
    }

    const contradictions: ContradictionDetail[] = [];
    const seenPairs = new Set<string>();

    // Helper to create sorted pair key
    const pairKey = (idA: string, idB: string) => idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;

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
                entryA: { id: a.id, type: 'decision', content: a.decision, createdAt: a.created_at },
                entryB: { id: b.id, type: 'decision', content: b.decision, createdAt: b.created_at },
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
          entryB: { id: p.id, type: 'anti-pattern', content: p.anti_pattern, createdAt: p.created_at },
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
    return { success: false, error: { code: 'E_CONTRADICTIONS', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.superseded - Find superseded entries in brain.db
 *
 * Identifies entries that have been superseded by newer entries on the same topic.
 * For brain.db, we group by:
 * - Decisions: type + contextTaskId/contextEpicId
 * - Patterns: type + context (first 100 chars for similarity)
 * - Learnings: source + applicableTypes
 * - Observations: type + project
 */
export async function memorySuperseded(
  params?: { type?: string; project?: string },
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = resolveRoot(projectRoot);
    await getBrainDb(root);
    const nativeDb = getBrainNativeDb();

    if (!nativeDb) {
      return { success: true, data: { superseded: [] } };
    }

    const superseded: Array<{
      oldEntry: { id: string; type: string; createdAt: string; summary: string };
      replacement: { id: string; type: string; createdAt: string; summary: string };
      grouping: string;
    }> = [];

    // Helper to normalize and group by key
    const addSuperseded = (
      entries: Array<{ id: string; type: string; createdAt: string; summary: string }>,
      groupKey: string,
    ) => {
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
    const decisionGroups = new Map<string, Array<{ id: string; type: string; createdAt: string; summary: string }>>();
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
    const patternGroups = new Map<string, Array<{ id: string; type: string; createdAt: string; summary: string }>>();
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
    const learningGroups = new Map<string, Array<{ id: string; type: string; createdAt: string; summary: string }>>();
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
    const observationGroups = new Map<string, Array<{ id: string; type: string; createdAt: string; summary: string }>>();
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
      const projectKey = params?.project ? params.project : (o.project || 'general');
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
    return { success: false, error: { code: 'E_MEMORY_SUPERSEDED', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.link - Link a brain entry to a task */
export async function memoryLink(
  params: { taskId: string; entryId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId || !params.entryId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId and entryId are required' } };
  }

  const entryType = parseIdPrefix(params.entryId);
  if (!entryType) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'Invalid entryId format' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    await linkMemoryToTask(root, entryType, params.entryId, params.taskId, 'applies_to');
    return { success: true, data: { linked: true, taskId: params.taskId, entryId: params.entryId } };
  } catch (error) {
    return { success: false, error: { code: 'E_MEMORY_LINK', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.unlink - Remove a link between a brain entry and a task */
export async function memoryUnlink(
  params: { taskId: string; entryId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId || !params.entryId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId and entryId are required' } };
  }

  const entryType = parseIdPrefix(params.entryId);
  if (!entryType) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'Invalid entryId format' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    await unlinkMemoryFromTask(root, entryType, params.entryId, params.taskId, 'applies_to');
    return { success: true, data: { unlinked: true, taskId: params.taskId, entryId: params.entryId } };
  } catch (error) {
    return { success: false, error: { code: 'E_MEMORY_UNLINK', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// PageIndex Graph Operations (T5385)
// ============================================================================

/** memory.graph.add - Add a node or edge to the PageIndex graph */
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
        edgeType: params.edgeType as typeof import('../../store/brain-schema.js').BRAIN_EDGE_TYPES[number],
        weight: params.weight,
      });
      return { success: true, data: { type: 'edge', edge } };
    }

    // Node mode: nodeId + nodeType + label
    if (params.nodeId && params.nodeType && params.label) {
      const node = await accessor.addPageNode({
        id: params.nodeId,
        nodeType: params.nodeType as typeof import('../../store/brain-schema.js').BRAIN_NODE_TYPES[number],
        label: params.label,
        metadataJson: params.metadataJson,
      });
      return { success: true, data: { type: 'node', node } };
    }

    return {
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: 'Provide (nodeId + nodeType + label) for a node or (fromId + toId + edgeType) for an edge',
      },
    };
  } catch (error) {
    return { success: false, error: { code: 'E_GRAPH_ADD', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.graph.show - Get a node and its edges from the PageIndex graph */
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
      return { success: false, error: { code: 'E_NOT_FOUND', message: `Node '${params.nodeId}' not found` } };
    }

    const edges = await accessor.getPageEdges(params.nodeId, 'both');
    return { success: true, data: { node, edges } };
  } catch (error) {
    return { success: false, error: { code: 'E_GRAPH_SHOW', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.graph.neighbors - Get neighbor nodes from the PageIndex graph */
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
      params.edgeType as typeof import('../../store/brain-schema.js').BRAIN_EDGE_TYPES[number] | undefined,
    );
    return { success: true, data: { neighbors, total: neighbors.length } };
  } catch (error) {
    return { success: false, error: { code: 'E_GRAPH_NEIGHBORS', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// BRAIN Reasoning & Hybrid Search Operations (T5388-T5393)
// ============================================================================

/** memory.reason.why - Causal trace through task dependency chains */
export async function memoryReasonWhy(
  params: { taskId: string },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  try {
    const root = resolveRoot(projectRoot);
    const { reasonWhy } = await import('./brain-reasoning.js');
    const result = await reasonWhy(params.taskId, root);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_REASON_WHY', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.reason.similar - Find semantically similar entries */
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
    return { success: false, error: { code: 'E_REASON_SIMILAR', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.search.hybrid - Hybrid search across FTS5, vector, and graph */
export async function memorySearchHybrid(
  params: {
    query: string;
    ftsWeight?: number;
    vecWeight?: number;
    graphWeight?: number;
    limit?: number;
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
      ftsWeight: params.ftsWeight,
      vecWeight: params.vecWeight,
      graphWeight: params.graphWeight,
      limit: params.limit,
    });
    return { success: true, data: { results, total: results.length } };
  } catch (error) {
    return { success: false, error: { code: 'E_HYBRID_SEARCH', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.graph.remove - Remove a node or edge from the PageIndex graph */
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
        params.edgeType as typeof import('../../store/brain-schema.js').BRAIN_EDGE_TYPES[number],
      );
      return { success: true, data: { removed: 'edge', fromId: params.fromId, toId: params.toId, edgeType: params.edgeType } };
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
    return { success: false, error: { code: 'E_GRAPH_REMOVE', message: error instanceof Error ? error.message : String(error) } };
  }
}
