/**
 * BRAIN Retrieval Operations — 3-layer pattern (search -> timeline -> fetch).
 *
 * Provides token-efficient memory access modeled after claude-mem's
 * search/timeline/get_observations workflow:
 *
 * 1. searchBrainCompact — lightweight index (IDs + titles, ~50 tokens/hit)
 * 2. timelineBrain      — chronological context around an anchor entry
 * 3. fetchBrainEntries  — full details for a filtered set of IDs
 * 4. observeBrain       — unified save (observations table)
 *
 * Wave 2A provides the core implementations; Wave 2B wires them through
 * the dispatch layer (engine-compat -> domain handler -> CLI gateway).
 *
 * @task T5131 T5132 T5133 T5134 T5135
 * @epic T5149
 */

import { createHash } from 'node:crypto';
import type { NextDirectives } from '../mvi-helpers.js';
import { memoryFindHitNext } from '../mvi-helpers.js';
import { getBrainAccessor } from '../store/brain-accessor.js';
import type {
  BRAIN_OBSERVATION_SOURCE_TYPES,
  BRAIN_OBSERVATION_TYPES,
  BrainMemoryTier,
  BrainSourceConfidence,
} from '../store/brain-schema.js';
import { sessionExistsInTasksDb } from '../store/cross-db-cleanup.js';
import { getDb } from '../store/sqlite.js';
import { typedAll } from '../store/typed-query.js';
import { embedText, isEmbeddingAvailable } from './brain-embedding.js';
import type {
  BrainAnchor,
  BrainFtsRow,
  BrainNarrativeRow,
  BrainTimelineNeighborRow,
} from './brain-row-types.js';
import { hybridSearch, searchBrain } from './brain-search.js';
import { searchSimilar } from './brain-similarity.js';
import { addGraphEdge, upsertGraphNode } from './graph-auto-populate.js';
import { computeObservationQuality } from './quality-scoring.js';

// ============================================================================
// Types
// ============================================================================

/** Compact search hit — minimal fields for index-level results. */
export interface BrainCompactHit {
  id: string;
  type: 'decision' | 'pattern' | 'learning' | 'observation';
  title: string;
  date: string;
  relevance?: number;
  /**
   * RRF-fused score: sum of 1/(rank+60) across all retrieval sources.
   * Present only when the RRF path is used (useRRF=true, default).
   * Higher = stronger match. Comparable across results in the same query.
   */
  rrfScore?: number;
  /**
   * BM25-derived score, min-max normalized to [0, 1] across the result set.
   * 1.0 = best BM25 rank in this query, 0.0 = worst (or not found via FTS).
   * Present only when the RRF path is used and at least one FTS result exists.
   */
  bm25Score?: number;
  /** Progressive disclosure directives for follow-up operations. */
  _next?: NextDirectives;
}

/** Parameters for searchBrainCompact. */
export interface SearchBrainCompactParams {
  query: string;
  limit?: number;
  tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
  dateStart?: string;
  dateEnd?: string;
  /** T418: filter results to observations produced by a specific agent (Wave 8 mental models). */
  agent?: string;
  /**
   * When true (default), use Reciprocal Rank Fusion to combine FTS5 and
   * vector search results for higher recall and better ranking.
   * When false, fall back to FTS5-only search (faster, no embeddings needed).
   */
  useRRF?: boolean;
}

/** Result from searchBrainCompact. */
export interface SearchBrainCompactResult {
  results: BrainCompactHit[];
  total: number;
  tokensEstimated: number;
}

/** Parameters for timelineBrain. */
export interface TimelineBrainParams {
  anchor: string;
  depthBefore?: number;
  depthAfter?: number;
}

/** Timeline entry — compact id/type/date tuple. */
export interface TimelineNeighbor {
  id: string;
  type: string;
  date: string;
}

/** Result from timelineBrain. */
export interface TimelineBrainResult {
  anchor: BrainAnchor | null;
  before: TimelineNeighbor[];
  after: TimelineNeighbor[];
}

/** Parameters for fetchBrainEntries. */
export interface FetchBrainEntriesParams {
  ids: string[];
}

/** Fetched entry with full data. */
export interface FetchedBrainEntry {
  id: string;
  type: string;
  data: unknown;
}

/** Result from fetchBrainEntries. */
export interface FetchBrainEntriesResult {
  results: FetchedBrainEntry[];
  notFound: string[];
  tokensEstimated: number;
}

/** Observation type from schema. */
export type BrainObservationType = (typeof BRAIN_OBSERVATION_TYPES)[number];

/** Observation source type from schema. */
export type BrainObservationSourceType = (typeof BRAIN_OBSERVATION_SOURCE_TYPES)[number];

/** Parameters for observeBrain. */
export interface ObserveBrainParams {
  text: string;
  title?: string;
  type?: BrainObservationType;
  project?: string;
  sourceSessionId?: string;
  sourceType?: BrainObservationSourceType;
  /** T417: agent provenance — the name of the spawned agent producing this observation. */
  agent?: string;
  /**
   * T549 Wave 1-A: source reliability level.
   * Overrides the default routing. If omitted, routing is determined automatically:
   * - sourceType 'manual' → 'owner'
   * - sourceType 'session-debrief' → 'task-outcome'
   * - otherwise → 'agent'
   */
  sourceConfidence?: BrainSourceConfidence;
  /**
   * T794 BRAIN-05: cross-references to other memory entries or external IDs.
   * When this array has ≥1 entry, the observation is auto-promoted from
   * 'short' to 'medium' tier at write time to protect it from soft-eviction.
   */
  crossRef?: string[];
  /**
   * T799: SHA-256 refs of attachments to link to this observation.
   *
   * Stored as a JSON-encoded string in the `attachments_json` column.
   * Each entry must be a 64-char hex SHA-256 from the tasks.db attachment store.
   */
  attachmentRefs?: string[];
}

/** Result from observeBrain. */
export interface ObserveBrainResult {
  id: string;
  type: string;
  createdAt: string;
}

// ============================================================================
// Layer 1: Compact Search
// ============================================================================

/**
 * Token-efficient compact search across BRAIN tables.
 * Returns index-level hits (~50 tokens per result).
 *
 * Delegates to searchBrain() from brain-search.ts for FTS5/LIKE search,
 * then projects results to a compact format with optional date filtering.
 *
 * @param projectRoot - Project root directory
 * @param params - Search parameters
 * @returns Compact search results with token estimate
 */
export async function searchBrainCompact(
  projectRoot: string,
  params: SearchBrainCompactParams,
): Promise<SearchBrainCompactResult> {
  const { query, limit, tables, dateStart, dateEnd, agent, useRRF = true } = params;

  if (!query?.trim()) {
    return { results: [], total: 0, tokensEstimated: 0 };
  }

  const effectiveLimit = limit ?? 10;

  // T418: agent filter always forces FTS-only on observations table
  const agentFilter = agent !== undefined && agent !== null;

  // ----- RRF path (default) -----
  if (useRRF && !agentFilter) {
    // Run FTS (for dates + table-level data) and RRF fusion in parallel.
    // FTS gives us row-level dates; RRF gives us the fused ranking order.
    const [ftsResult, rrfResults] = await Promise.all([
      searchBrain(projectRoot, query, { limit: effectiveLimit * 3, tables }).catch(() => ({
        decisions: [],
        patterns: [],
        learnings: [],
        observations: [],
      })),
      hybridSearch(query, projectRoot, { limit: effectiveLimit * 2 }),
    ]);

    // Build a date map from FTS rows (id -> date string)
    const dateMap = new Map<string, string>();
    for (const d of ftsResult.decisions) {
      const raw = d as Record<string, unknown>;
      dateMap.set(d.id, (d.createdAt ?? (raw['created_at'] as string)) || '');
    }
    for (const p of ftsResult.patterns) {
      const raw = p as Record<string, unknown>;
      dateMap.set(p.id, (p.extractedAt ?? (raw['extracted_at'] as string)) || '');
    }
    for (const l of ftsResult.learnings) {
      const raw = l as Record<string, unknown>;
      dateMap.set(l.id, (l.createdAt ?? (raw['created_at'] as string)) || '');
    }
    for (const o of ftsResult.observations) {
      const raw = o as Record<string, unknown>;
      dateMap.set(o.id, (o.createdAt ?? (raw['created_at'] as string)) || '');
    }

    // Apply table filter when specified (map singular type names to plural table names)
    const singularToTable: Record<string, string> = {
      decision: 'decisions',
      pattern: 'patterns',
      learning: 'learnings',
      observation: 'observations',
    };

    // Compute min-max normalization bounds for BM25 rank → bm25Score.
    // ftsRank=0 is best; higher rank = worse. We convert to a 0..1 score:
    //   bm25Score = 1 - (ftsRank / maxFtsRank)  when maxFtsRank > 0.
    //   Items not in FTS results (ftsRank undefined) get bm25Score = 0.
    const ftsRanks = rrfResults.map((r) => r.ftsRank ?? undefined).filter((v) => v !== undefined);
    const maxFtsRank = ftsRanks.length > 0 ? Math.max(...ftsRanks) : 0;

    // Compute min-max bounds for rrfScore normalization for `relevance` field.
    const rrfScores = rrfResults.map((r) => r.score);
    const minRrf = rrfScores.length > 0 ? Math.min(...rrfScores) : 0;
    const maxRrf = rrfScores.length > 0 ? Math.max(...rrfScores) : 0;
    const rrfRange = maxRrf - minRrf;

    let results: BrainCompactHit[] = rrfResults
      .map((r) => {
        const bm25Score =
          r.ftsRank !== undefined ? 1 - (maxFtsRank > 0 ? r.ftsRank / maxFtsRank : 0) : 0;
        const rrfScore = r.score;
        const relevance = rrfRange > 0 ? (r.score - minRrf) / rrfRange : r.score;
        return {
          id: r.id,
          type: r.type as 'decision' | 'pattern' | 'learning' | 'observation',
          title: r.title.slice(0, 80),
          date: dateMap.get(r.id) ?? '',
          relevance,
          rrfScore,
          bm25Score,
        };
      })
      .filter((r) => {
        // Only include items that the FTS scan returned (ensures quality gating is respected)
        return dateMap.has(r.id);
      });

    if (tables && tables.length > 0) {
      results = results.filter((r) =>
        tables.includes(
          singularToTable[r.type] as 'decisions' | 'patterns' | 'learnings' | 'observations',
        ),
      );
    }

    // Apply date filters client-side
    if (dateStart) results = results.filter((r) => !r.date || r.date >= dateStart);
    if (dateEnd) results = results.filter((r) => !r.date || r.date <= dateEnd);

    results = results.slice(0, effectiveLimit);

    for (const hit of results) {
      hit._next = memoryFindHitNext(hit.id);
    }

    if (results.length > 0) {
      const returnedIds = results.map((r) => r.id);
      setImmediate(() => {
        incrementCitationCounts(projectRoot, returnedIds).catch(() => {});
        getCurrentSessionId(projectRoot)
          .then((sessionId) => {
            return logRetrieval(
              projectRoot,
              query,
              returnedIds,
              'find-rrf',
              results.length * 50,
              sessionId,
            );
          })
          .catch(() => {});
      });
    }

    return { results, total: results.length, tokensEstimated: results.length * 50 };
  }

  // ----- FTS-only path (useRRF=false or agent filter) -----
  const effectiveTables = agentFilter
    ? (['observations'] as Array<'decisions' | 'patterns' | 'learnings' | 'observations'>)
    : tables;

  const searchResult = await searchBrain(projectRoot, query, {
    limit: effectiveLimit,
    tables: effectiveTables,
  });

  // Project full results to compact format.
  // Note: searchBrain() returns rows from raw SQL (nativeDb) which use
  // snake_case column names, but the TypeScript types are camelCase.
  // We handle both naming conventions for robustness.
  let results: BrainCompactHit[] = [];

  if (!agentFilter) {
    for (const d of searchResult.decisions) {
      const raw = d as Record<string, unknown>;
      results.push({
        id: d.id,
        type: 'decision',
        title: d.decision.slice(0, 80),
        date: (d.createdAt ?? (raw['created_at'] as string)) || '',
      });
    }

    for (const p of searchResult.patterns) {
      const raw = p as Record<string, unknown>;
      results.push({
        id: p.id,
        type: 'pattern',
        title: p.pattern.slice(0, 80),
        date: (p.extractedAt ?? (raw['extracted_at'] as string)) || '',
      });
    }

    for (const l of searchResult.learnings) {
      const raw = l as Record<string, unknown>;
      results.push({
        id: l.id,
        type: 'learning',
        title: l.insight.slice(0, 80),
        date: (l.createdAt ?? (raw['created_at'] as string)) || '',
      });
    }
  }

  for (const o of searchResult.observations) {
    const raw = o as Record<string, unknown>;
    // T418: apply agent post-filter when specified
    if (agentFilter) {
      const rowAgent = o.agent ?? (raw['agent'] as string | null) ?? null;
      if (rowAgent !== agent) continue;
    }
    results.push({
      id: o.id,
      type: 'observation',
      title: o.title.slice(0, 80),
      date: (o.createdAt ?? (raw['created_at'] as string)) || '',
    });
  }

  // Apply date filters client-side if provided
  if (dateStart) results = results.filter((r) => r.date >= dateStart);
  if (dateEnd) results = results.filter((r) => r.date <= dateEnd);

  // Enrich each hit with _next progressive disclosure directives
  for (const hit of results) {
    hit._next = memoryFindHitNext(hit.id);
  }

  // Citation tracking + retrieval logging (non-blocking)
  if (results.length > 0) {
    const returnedIds = results.map((r) => r.id);
    setImmediate(() => {
      incrementCitationCounts(projectRoot, returnedIds).catch(() => {});
      getCurrentSessionId(projectRoot)
        .then((sessionId) => {
          return logRetrieval(
            projectRoot,
            query,
            returnedIds,
            'find',
            results.length * 50,
            sessionId,
          );
        })
        .catch(() => {});
    });
  }

  return {
    results,
    total: results.length,
    tokensEstimated: results.length * 50,
  };
}

// ============================================================================
// Layer 2: Timeline
// ============================================================================

/**
 * Determine the entry type from its ID prefix.
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

/**
 * Get chronological context around an anchor entry.
 * Fetches the anchor's full data, then queries all 4 BRAIN tables
 * via UNION ALL to find chronological neighbors.
 *
 * @param projectRoot - Project root directory
 * @param params - Timeline parameters with anchor ID and depth
 * @returns Anchor entry data with surrounding chronological entries
 */
export async function timelineBrain(
  projectRoot: string,
  params: TimelineBrainParams,
): Promise<TimelineBrainResult> {
  const { anchor: anchorId, depthBefore = 3, depthAfter = 3 } = params;

  // Ensure DB is initialized
  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { anchor: null, before: [], after: [] };
  }

  // Determine anchor type and fetch it via accessor
  const anchorType = parseIdPrefix(anchorId);
  if (!anchorType) {
    return { anchor: null, before: [], after: [] };
  }

  const accessor = await getBrainAccessor(projectRoot);
  let anchorData: unknown = null;
  let anchorDate: string | null = null;

  switch (anchorType) {
    case 'decision': {
      const row = await accessor.getDecision(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.createdAt;
      }
      break;
    }
    case 'pattern': {
      const row = await accessor.getPattern(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.extractedAt;
      }
      break;
    }
    case 'learning': {
      const row = await accessor.getLearning(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.createdAt;
      }
      break;
    }
    case 'observation': {
      const row = await accessor.getObservation(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.createdAt;
      }
      break;
    }
  }

  if (!anchorData || !anchorDate) {
    return { anchor: null, before: [], after: [] };
  }

  // UNION ALL across all 4 tables to get chronological neighbors.
  // Excludes the anchor itself.
  const beforeRows = typedAll<BrainTimelineNeighborRow>(
    nativeDb.prepare(`
    SELECT id, 'decision' AS type, created_at AS date FROM brain_decisions WHERE created_at < ? AND id != ?
    UNION ALL
    SELECT id, 'pattern' AS type, extracted_at AS date FROM brain_patterns WHERE extracted_at < ? AND id != ?
    UNION ALL
    SELECT id, 'learning' AS type, created_at AS date FROM brain_learnings WHERE created_at < ? AND id != ?
    UNION ALL
    SELECT id, 'observation' AS type, created_at AS date FROM brain_observations WHERE created_at < ? AND id != ?
    ORDER BY date DESC
    LIMIT ?
  `),
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    depthBefore,
  );

  const afterRows = typedAll<BrainTimelineNeighborRow>(
    nativeDb.prepare(`
    SELECT id, 'decision' AS type, created_at AS date FROM brain_decisions WHERE created_at > ? AND id != ?
    UNION ALL
    SELECT id, 'pattern' AS type, extracted_at AS date FROM brain_patterns WHERE extracted_at > ? AND id != ?
    UNION ALL
    SELECT id, 'learning' AS type, created_at AS date FROM brain_learnings WHERE created_at > ? AND id != ?
    UNION ALL
    SELECT id, 'observation' AS type, created_at AS date FROM brain_observations WHERE created_at > ? AND id != ?
    ORDER BY date ASC
    LIMIT ?
  `),
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    depthAfter,
  );

  return {
    anchor: { id: anchorId, type: anchorType, data: anchorData },
    before: beforeRows.map((r) => ({ id: r.id, type: r.type, date: r.date })),
    after: afterRows.map((r) => ({ id: r.id, type: r.type, date: r.date })),
  };
}

// ============================================================================
// Layer 3: Batch Fetch
// ============================================================================

/**
 * Batch-fetch full details by IDs.
 * Groups IDs by prefix to query the correct tables via BrainDataAccessor.
 *
 * @param projectRoot - Project root directory
 * @param params - Fetch parameters with IDs
 * @returns Full entry data for each found ID, plus not-found list
 */
export async function fetchBrainEntries(
  projectRoot: string,
  params: FetchBrainEntriesParams,
): Promise<FetchBrainEntriesResult> {
  const { ids } = params;

  if (!ids || ids.length === 0) {
    return { results: [], notFound: [], tokensEstimated: 0 };
  }

  const accessor = await getBrainAccessor(projectRoot);

  // Group IDs by type prefix
  const decisionIds: string[] = [];
  const patternIds: string[] = [];
  const learningIds: string[] = [];
  const observationIds: string[] = [];
  const unknownIds: string[] = [];

  for (const id of ids) {
    const type = parseIdPrefix(id);
    switch (type) {
      case 'decision':
        decisionIds.push(id);
        break;
      case 'pattern':
        patternIds.push(id);
        break;
      case 'learning':
        learningIds.push(id);
        break;
      case 'observation':
        observationIds.push(id);
        break;
      default:
        unknownIds.push(id);
    }
  }

  const results: FetchedBrainEntry[] = [];
  const notFound: string[] = [...unknownIds];

  // Fetch decisions
  for (const id of decisionIds) {
    const row = await accessor.getDecision(id);
    if (row) {
      results.push({ id, type: 'decision', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Fetch patterns
  for (const id of patternIds) {
    const row = await accessor.getPattern(id);
    if (row) {
      results.push({ id, type: 'pattern', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Fetch learnings
  for (const id of learningIds) {
    const row = await accessor.getLearning(id);
    if (row) {
      results.push({ id, type: 'learning', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Fetch observations
  for (const id of observationIds) {
    const row = await accessor.getObservation(id);
    if (row) {
      results.push({ id, type: 'observation', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Citation tracking + retrieval logging (non-blocking)
  if (results.length > 0) {
    const fetchedIds = results.map((r) => r.id);
    setImmediate(() => {
      incrementCitationCounts(projectRoot, fetchedIds).catch(() => {});
      getCurrentSessionId(projectRoot)
        .then((sessionId) => {
          return logRetrieval(
            projectRoot,
            fetchedIds.join(','),
            fetchedIds,
            'fetch',
            results.length * 500,
            sessionId,
          );
        })
        .catch(() => {});
    });
  }

  return {
    results,
    notFound,
    tokensEstimated: results.length * 500,
  };
}

// ============================================================================
// Observe (Unified Save)
// ============================================================================

/**
 * Keyword patterns for auto-classifying observation type from text.
 */
const TYPE_KEYWORDS: Array<{ keywords: string[]; type: BrainObservationType }> = [
  { keywords: ['bug', 'fix', 'error', 'crash'], type: 'bugfix' },
  { keywords: ['refactor', 'rename', 'extract', 'move'], type: 'refactor' },
  { keywords: ['add', 'create', 'implement', 'new'], type: 'feature' },
  { keywords: ['decide', 'chose', 'pick', 'instead'], type: 'decision' },
  { keywords: ['update', 'change', 'modify', 'upgrade'], type: 'change' },
];

/**
 * Auto-classify observation type from text using keyword matching.
 */
function classifyObservationType(text: string): BrainObservationType {
  const lower = text.toLowerCase();
  for (const { keywords, type } of TYPE_KEYWORDS) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        return type;
      }
    }
  }
  return 'discovery';
}

/** Monotonic counter to prevent ID collisions within the same millisecond. */
let observeSeq = 0;

/**
 * Save an observation to the BRAIN observations table.
 * Replaces the external claude-mem save_observation pattern.
 *
 * Auto-classifies type from text if not provided. Generates a
 * unique ID with O- prefix + base36 timestamp.
 *
 * @param projectRoot - Project root directory
 * @param params - Observation data
 * @returns Created observation ID, type, and timestamp
 */
export async function observeBrain(
  projectRoot: string,
  params: ObserveBrainParams,
): Promise<ObserveBrainResult> {
  const {
    text,
    title: titleParam,
    type: typeParam,
    project,
    sourceSessionId,
    sourceType,
    agent,
    sourceConfidence: sourceConfidenceParam,
    crossRef,
    attachmentRefs,
  } = params;

  if (!text?.trim()) {
    throw new Error('Observation text is required');
  }

  const type = typeParam ?? classifyObservationType(text);
  const title = titleParam ?? text.slice(0, 120);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // T549 Wave 1-A: Tier routing for observations.
  // Observations always start as short-term episodic entries.
  // sourceConfidence routing (spec §4.1 Decision Tree):
  //   - sourceType 'manual' → 'owner' (owner-stated facts skip short-term in consolidator)
  //   - sourceType 'session-debrief' → 'task-outcome' (synthesized summaries)
  //   - otherwise → 'agent' (default for all hook/agent writes)
  // Source confidence routing (spec §4.1 Decision Tree):
  //   - sourceType 'manual' → 'owner' (owner-stated facts are ground truth)
  //   - sourceType 'session-debrief' → 'task-outcome' (verified by completion)
  //   - otherwise → 'agent' (default for all hook/agent writes)
  // Owner and task-outcome sources are auto-verified as ground truth.
  // Agent-inferred entries start unverified — consolidator promotes via corroboration.
  const resolvedSourceConfidence: BrainSourceConfidence =
    sourceConfidenceParam ??
    (sourceType === 'manual'
      ? 'owner'
      : sourceType === 'session-debrief'
        ? 'task-outcome'
        : 'agent');
  // T794 BRAIN-05: retention floor — auto-promote to 'medium' when the observation
  // references multiple tasks or has explicit cross-references.
  // Two promotion criteria (either is sufficient):
  //   A. text contains ≥2 distinct task ID patterns (/T\d+/)
  //   B. crossRef param is present with ≥1 entry
  const taskIdMatches = text.match(/T\d+/g) ?? [];
  const distinctTaskIds = new Set(taskIdMatches);
  const hasMultipleTaskRefs = distinctTaskIds.size >= 2;
  const hasCrossRef = Array.isArray(crossRef) && crossRef.length >= 1;
  const memoryTier: BrainMemoryTier = hasMultipleTaskRefs || hasCrossRef ? 'medium' : 'short';
  const memoryType = 'episodic' as const;
  const verified =
    resolvedSourceConfidence === 'owner' || resolvedSourceConfidence === 'task-outcome';

  // Content-hash dedup: SHA-256 prefix of title+text
  const contentHash = createHash('sha256')
    .update(title + text)
    .digest('hex')
    .slice(0, 16);

  // Check for recent duplicate (same content within last 30 seconds)
  const { getBrainNativeDb } = await import('../store/brain-sqlite.js');
  const nativeDb = getBrainNativeDb();
  if (nativeDb) {
    const cutoff = new Date(Date.now() - 30000).toISOString().replace('T', ' ').slice(0, 19);
    const existing = typedAll<BrainFtsRow>(
      nativeDb.prepare(
        'SELECT id, type, created_at FROM brain_observations WHERE content_hash = ? AND created_at > ?',
      ),
      contentHash,
      cutoff,
    );

    if (existing.length > 0) {
      return {
        id: existing[0].id,
        type: existing[0].type,
        createdAt: existing[0].created_at,
      };
    }
  }

  // Write-guard: validate cross-db session reference before inserting
  let validSessionId = sourceSessionId ?? null;
  if (validSessionId) {
    try {
      const tasksDb = await getDb(projectRoot);
      if (!(await sessionExistsInTasksDb(validSessionId, tasksDb))) {
        validSessionId = null;
      }
    } catch {
      // Best-effort: if tasks.db unavailable, null out the reference
      validSessionId = null;
    }
  }

  // Compute quality score from text richness, title length, and T549 source multiplier.
  const qualityScore = computeObservationQuality({
    text,
    title,
    sourceConfidence: resolvedSourceConfidence,
    memoryTier,
  });

  const id = `O-${Date.now().toString(36)}-${(observeSeq++ % 1000).toString(36)}`;
  const accessor = await getBrainAccessor(projectRoot);

  const row = await accessor.addObservation({
    id,
    type,
    title,
    narrative: text,
    contentHash,
    project: project ?? null,
    sourceSessionId: validSessionId,
    sourceType: sourceType ?? 'agent',
    agent: agent ?? null,
    qualityScore,
    createdAt: now,
    // T549 Wave 1-A: tier/type/confidence assigned at write time
    memoryTier,
    memoryType,
    sourceConfidence: resolvedSourceConfidence,
    verified,
    // T799: optional attachment refs stored as JSON array
    ...(attachmentRefs && attachmentRefs.length > 0
      ? { attachmentsJson: JSON.stringify(attachmentRefs) }
      : {}),
  });

  // Populate embedding if provider is available (T5387).
  // Fire-and-forget: embedding runs in the background so it never blocks the CLI.
  // The observation is already saved above — if embedding fails, the observation
  // still exists, just without vector similarity search capability. (T027)
  if (isEmbeddingAvailable()) {
    setImmediate(() => {
      embedText(text)
        .then((vector) => {
          if (vector && nativeDb) {
            nativeDb
              .prepare('INSERT OR REPLACE INTO brain_embeddings (id, embedding) VALUES (?, ?)')
              .run(id, Buffer.from(vector.buffer));
          }
        })
        .catch(() => {
          // Silently skip embedding failures — observation is already persisted
        });
    });
  }

  // Regenerate memory bridge for high-value observation types (T5240).
  // Only learning and decision types trigger bridge refresh to avoid excessive writes.
  if (type === 'decision') {
    import('./memory-bridge.js')
      .then(({ refreshMemoryBridge }) => refreshMemoryBridge(projectRoot))
      .catch(() => {
        /* Memory bridge refresh is best-effort */
      });
  }

  // Auto-link observation to the currently focused task when a session is active. (T141)
  // This is a fire-and-forget side effect — linking failure MUST NOT block the return.
  if (validSessionId) {
    autoLinkObservationToTask(projectRoot, row.id, accessor).catch(() => {
      /* Auto-linking is best-effort */
    });
  }

  // Auto-populate graph node + edges for this observation (best-effort, T537).
  try {
    await upsertGraphNode(
      projectRoot,
      `observation:${row.id}`,
      'observation',
      row.title.substring(0, 200),
      row.qualityScore ?? 0.5,
      row.narrative ?? row.title,
      { sourceType: row.sourceType, agent: row.agent ?? undefined },
    );

    // Link observation → session when the observation has a session context.
    if (validSessionId) {
      await upsertGraphNode(
        projectRoot,
        `session:${validSessionId}`,
        'session',
        validSessionId,
        0.8,
        '',
      );
      await addGraphEdge(
        projectRoot,
        `observation:${row.id}`,
        `session:${validSessionId}`,
        'produced_by',
        1.0,
        'auto:observe',
      );
    }
  } catch {
    /* Graph population is best-effort — never block the primary return */
  }

  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt,
  };
}

/**
 * Auto-link a newly created observation to the currently focused task.
 *
 * Queries the active session via sessionStatus() and reads taskWork.taskId.
 * If a task is focused, inserts a brain_memory_links row linking the
 * observation to that task with linkType 'produced_by'.
 *
 * All failures are silently swallowed — this is a best-effort side effect.
 *
 * @param projectRoot - Project root directory
 * @param observationId - ID of the newly created observation
 * @param accessor - BrainDataAccessor to use for the link insert
 */
async function autoLinkObservationToTask(
  projectRoot: string,
  observationId: string,
  accessor: Awaited<ReturnType<typeof getBrainAccessor>>,
): Promise<void> {
  const { sessionStatus } = await import('../sessions/index.js');
  const session = await sessionStatus(projectRoot);

  if (!session) return;

  const taskId = session.taskWork?.taskId;
  if (!taskId) return;

  await accessor.addLink({
    memoryType: 'observation',
    memoryId: observationId,
    taskId,
    linkType: 'produced_by',
  });
}

// ============================================================================
// Embedding Backfill Pipeline (T5387)
// ============================================================================

/** Result from populateEmbeddings backfill. */
export interface PopulateEmbeddingsResult {
  processed: number;
  skipped: number;
  errors: number;
}

/**
 * Options for the embedding backfill pipeline.
 *
 * @example
 * ```ts
 * await populateEmbeddings(root, {
 *   batchSize: 25,
 *   onProgress: (current, total) => console.log(`${current}/${total}`),
 * });
 * ```
 */
export interface PopulateEmbeddingsOptions {
  /** Maximum items processed per batch cycle. Defaults to 50. */
  batchSize?: number;
  /**
   * Progress callback invoked after each observation is attempted.
   * `current` is the 1-based count of observations attempted so far;
   * `total` is the full count of observations that need embeddings.
   */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Backfill embeddings for existing observations that lack them.
 *
 * Iterates through observations not yet in brain_embeddings and
 * generates vectors using the registered embedding provider.
 * Processes in batches to avoid memory pressure.
 *
 * An optional {@link PopulateEmbeddingsOptions.onProgress} callback is called
 * after each observation is attempted, enabling callers to report progress.
 *
 * @param projectRoot - Project root directory
 * @param options - Optional batch size and progress callback
 * @returns Count of processed, skipped, and errored observations
 *
 * @epic T134
 * @task T142
 */
export async function populateEmbeddings(
  projectRoot: string,
  options?: PopulateEmbeddingsOptions,
): Promise<PopulateEmbeddingsResult> {
  if (!isEmbeddingAvailable()) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  const batchSize = options?.batchSize ?? 50;
  const { onProgress } = options ?? {};
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Find observations without embeddings
  const rows = typedAll<BrainNarrativeRow>(
    nativeDb.prepare(`
    SELECT o.id, o.narrative, o.title
    FROM brain_observations o
    LEFT JOIN brain_embeddings e ON o.id = e.id
    WHERE e.id IS NULL AND o.narrative IS NOT NULL
    ORDER BY o.created_at DESC
  `),
  );

  const total = rows.length;
  let attempted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    for (const row of batch) {
      try {
        const vector = await embedText(row.narrative || row.title);
        if (vector) {
          nativeDb
            .prepare('INSERT OR REPLACE INTO brain_embeddings (id, embedding) VALUES (?, ?)')
            .run(row.id, Buffer.from(vector.buffer));
          processed++;
        } else {
          skipped++;
        }
      } catch {
        errors++;
      }
      attempted++;
      onProgress?.(attempted, total);
    }
  }

  return { processed, skipped, errors };
}

// ============================================================================
// Budget-Aware Retrieval (T549 Wave 3-A)
// ============================================================================

/** Options for budget-aware retrieval. */
export interface BudgetedRetrievalOptions {
  /** Filter by cognitive types (semantic / episodic / procedural). */
  types?: Array<'semantic' | 'episodic' | 'procedural'>;
  /** Filter by memory tiers (short / medium / long). */
  tiers?: Array<'short' | 'medium' | 'long'>;
  /** When true, only return verified entries. Default: false. */
  verified?: boolean;
}

/** A single entry returned by budget-aware retrieval. */
export interface BudgetedEntry {
  id: string;
  type: string;
  title: string;
  text: string;
  /** Fused relevance score: FTS50% + vector40% + graph10% × qualityScore. */
  score: number;
  /** Estimated token cost for this entry (~chars/4). */
  tokensEstimated: number;
  /** Memory tier for this entry. */
  memoryTier?: string;
  /** Cognitive type for this entry. */
  memoryType?: string;
}

/** Result from retrieveWithBudget. */
export interface BudgetedResult {
  entries: BudgetedEntry[];
  /** Total tokens consumed by returned entries. */
  tokensUsed: number;
  /** Tokens remaining from the original budget. */
  tokensRemaining: number;
  /** Number of entries excluded due to budget constraints. */
  excluded: number;
}

/**
 * Budget-aware hybrid retrieval combining FTS5, vector KNN, and graph neighbor scores.
 *
 * Strategy (parallel where possible):
 *   A. FTS5 BM25 search (always)  — keyword precision (50% weight)
 *   B. Vector KNN search (optional) — semantic recall (40% weight, skipped if no embeddings)
 *   C. Graph neighbors (optional) — associative context (10% weight, skipped if graph empty)
 *
 * Score fusion: final = (fts*0.50 + vec*0.40 + graph*0.10) × qualityScore
 * Recency boost: +0.05 for entries updated in last 7 days.
 * Type priority: procedural entries get +0.10 (always-useful rules).
 *
 * Budget enforcement:
 *   - Rank top-50 candidates by fused score.
 *   - Walk list, accumulate token cost (≈ textLen/4), stop at budget.
 *   - Episodic entries dropped first when budget is tight.
 *
 * Citation tracking: increments citationCount for returned entries in background (setImmediate).
 *
 * @param projectRoot - Project root directory
 * @param query - Text to search for
 * @param tokenBudget - Maximum tokens to spend on results (default 500)
 * @param options - Optional filters (types, tiers, verified)
 * @returns Retrieved entries within budget with token accounting
 */
export async function retrieveWithBudget(
  projectRoot: string,
  query: string,
  tokenBudget = 500,
  options?: BudgetedRetrievalOptions,
): Promise<BudgetedResult> {
  if (!query?.trim()) {
    return { entries: [], tokensUsed: 0, tokensRemaining: tokenBudget, excluded: 0 };
  }

  // -------------------------------------------------------------------------
  // Run search strategies in parallel
  // -------------------------------------------------------------------------
  const [ftsResult, vecResults, graphNeighbors] = await Promise.all([
    // A. FTS5
    searchBrain(projectRoot, query, { limit: 30 }).catch(() => ({
      decisions: [],
      patterns: [],
      learnings: [],
      observations: [],
    })),
    // B. Vector KNN (degrades gracefully when unavailable)
    searchSimilar(query, projectRoot, 20).catch(
      () => [] as ReturnType<typeof searchSimilar> extends Promise<infer T> ? T : never[],
    ),
    // C. Graph neighbors from top FTS hit
    Promise.resolve([] as Array<{ id: string; graphScore: number }>),
  ]);

  // -------------------------------------------------------------------------
  // Build ID → score map from FTS results
  // -------------------------------------------------------------------------
  interface ScoredEntry {
    id: string;
    type: string;
    title: string;
    text: string;
    ftsScore: number;
    vecScore: number;
    graphScore: number;
    qualityScore: number;
    memoryTier?: string;
    memoryType?: string;
    updatedAt?: string;
  }

  const candidateMap = new Map<string, ScoredEntry>();

  // FTS results (normalized score 0.5 starting point — BM25 doesn't give 0..1)
  const FTS_BASE = 0.5;
  for (const d of ftsResult.decisions) {
    const raw = d as Record<string, unknown>;
    const id = d.id;
    const tier = (d.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (d.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (d.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'decision',
      title: d.decision.slice(0, 120),
      text: `${d.decision} — ${d.rationale}`,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: d.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  for (const p of ftsResult.patterns) {
    const raw = p as Record<string, unknown>;
    const id = p.id;
    const tier = (p.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (p.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (p.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'pattern',
      title: p.pattern.slice(0, 120),
      text: `${p.pattern} — ${p.context}`,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: p.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  for (const l of ftsResult.learnings) {
    const raw = l as Record<string, unknown>;
    const id = l.id;
    const tier = (l.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (l.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (l.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'learning',
      title: l.insight.slice(0, 120),
      text: `${l.insight} (source: ${l.source})`,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: l.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  for (const o of ftsResult.observations) {
    const raw = o as Record<string, unknown>;
    const id = o.id;
    const tier = (o.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (o.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (o.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'observation',
      title: o.title.slice(0, 120),
      text: o.narrative ?? o.title,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: o.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  // B. Merge vector scores (distance → similarity: similarity = 1 - distance)
  for (const v of vecResults) {
    const simScore = Math.max(0, 1 - v.distance);
    const existing = candidateMap.get(v.id);
    if (existing) {
      existing.vecScore = simScore;
    } else {
      candidateMap.set(v.id, {
        id: v.id,
        type: v.type,
        title: v.title.slice(0, 120),
        text: v.text,
        ftsScore: 0,
        vecScore: simScore,
        graphScore: 0,
        qualityScore: 0.5,
        memoryTier: undefined,
        memoryType: undefined,
      });
    }
  }

  // C. Merge graph scores
  for (const g of graphNeighbors) {
    const existing = candidateMap.get(g.id);
    if (existing) {
      existing.graphScore = g.graphScore;
    }
  }

  // -------------------------------------------------------------------------
  // Score fusion + ranking
  // -------------------------------------------------------------------------
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  const candidates = Array.from(candidateMap.values()).map((c) => {
    // Fused score
    let score = c.ftsScore * 0.5 + c.vecScore * 0.4 + c.graphScore * 0.1;

    // Quality multiplier
    score *= c.qualityScore;

    // Recency boost for recently-updated entries
    if (c.updatedAt && c.updatedAt >= sevenDaysAgo) {
      score += 0.05;
    }

    // Type priority boost for procedural entries (always-useful rules)
    if (c.memoryType === 'procedural' || c.type === 'pattern') {
      score += 0.1;
    }

    return { ...c, score };
  });

  // -------------------------------------------------------------------------
  // Apply option filters (types, tiers, verified)
  // -------------------------------------------------------------------------

  // We'll apply verified filter by checking the DB if requested
  let filtered = candidates;

  if (options?.types && options.types.length > 0) {
    const allowedTypes = new Set(options.types);
    filtered = filtered.filter((c) => {
      if (!c.memoryType) return true; // unknown type — include
      return allowedTypes.has(c.memoryType as 'semantic' | 'episodic' | 'procedural');
    });
  }

  if (options?.tiers && options.tiers.length > 0) {
    const allowedTiers = new Set(options.tiers);
    filtered = filtered.filter((c) => {
      if (!c.memoryTier) return true; // unknown tier — include
      return allowedTiers.has(c.memoryTier as 'short' | 'medium' | 'long');
    });
  }

  // -------------------------------------------------------------------------
  // Sort: procedural first, then by score descending
  // -------------------------------------------------------------------------
  filtered.sort((a, b) => {
    const aProcedural = a.memoryType === 'procedural' || a.type === 'pattern' ? 1 : 0;
    const bProcedural = b.memoryType === 'procedural' || b.type === 'pattern' ? 1 : 0;
    if (aProcedural !== bProcedural) return bProcedural - aProcedural;
    return b.score - a.score;
  });

  // Cap candidate list at top 50
  const topCandidates = filtered.slice(0, 50);

  // -------------------------------------------------------------------------
  // Budget enforcement — episodic entries are dropped first when budget tight
  // -------------------------------------------------------------------------

  // Sort for budget walk: procedural first, semantic second, episodic last
  const typeOrder = (c: ScoredEntry & { score: number }): number => {
    if (c.memoryType === 'procedural' || c.type === 'pattern') return 0;
    if (c.memoryType === 'semantic' || c.type === 'decision' || c.type === 'learning') return 1;
    return 2; // episodic
  };

  const budgetOrdered = [...topCandidates].sort((a, b) => {
    const orderDiff = typeOrder(a) - typeOrder(b);
    if (orderDiff !== 0) return orderDiff;
    return b.score - a.score;
  });

  const result: BudgetedEntry[] = [];
  let tokensUsed = 0;
  let excluded = 0;

  for (const candidate of budgetOrdered) {
    const entryTokens = Math.ceil(candidate.text.length / 4);

    if (tokensUsed + entryTokens > tokenBudget) {
      excluded++;
      continue;
    }

    result.push({
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      text: candidate.text,
      score: candidate.score,
      tokensEstimated: entryTokens,
      memoryTier: candidate.memoryTier,
      memoryType: candidate.memoryType,
    });
    tokensUsed += entryTokens;
  }

  // -------------------------------------------------------------------------
  // Citation tracking — non-blocking background increment
  // -------------------------------------------------------------------------
  if (result.length > 0) {
    const returnedIds = result.map((e) => e.id);
    setImmediate(() => {
      incrementCitationCounts(projectRoot, returnedIds).catch(() => {
        /* best-effort */
      });
    });
  }

  return {
    entries: result,
    tokensUsed,
    tokensRemaining: tokenBudget - tokensUsed,
    excluded,
  };
}

// ============================================================================
// Session ID Retrieval (for logRetrieval)
// ============================================================================

/**
 * Get the current session ID from the session manager.
 *
 * This is a best-effort operation — if no session is active or session
 * manager is unavailable, returns null. Used by logRetrieval to group
 * retrievals by session for STDP analysis.
 *
 * @param projectRoot - Project root directory
 * @returns Current session ID or null if unavailable
 */
async function getCurrentSessionId(projectRoot: string): Promise<string | undefined> {
  try {
    const { sessionStatus } = await import('../sessions/index.js');
    const session = await sessionStatus(projectRoot);
    return session?.id;
  } catch {
    // Session manager unavailable or other error — log retrievals without session
    return undefined;
  }
}

// ============================================================================
// Citation Count Increment (non-blocking helper)
// ============================================================================

/**
 * Increment citationCount for a list of entry IDs.
 *
 * Routes each ID to the correct table based on its ID prefix. All updates
 * are best-effort — errors are silently swallowed.
 *
 * @param projectRoot - Project root for brain.db resolution
 * @param ids - Entry IDs whose citation counts should be incremented
 */
async function incrementCitationCounts(projectRoot: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const id of ids) {
    let table: string;
    if (id.startsWith('D-') || /^D\d/.test(id)) {
      table = 'brain_decisions';
    } else if (id.startsWith('P-') || /^P\d/.test(id)) {
      table = 'brain_patterns';
    } else if (id.startsWith('L-') || /^L\d/.test(id)) {
      table = 'brain_learnings';
    } else {
      table = 'brain_observations';
    }

    try {
      nativeDb
        .prepare(
          `UPDATE ${table} SET citation_count = citation_count + 1, updated_at = ? WHERE id = ?`,
        )
        .run(now, id);
    } catch {
      /* best-effort — column may not exist in older schemas */
    }
  }
}

/**
 * Log a retrieval event to brain_retrieval_log for co-retrieval analysis.
 *
 * Creates the table on first use if it doesn't exist (self-healing).
 * Best-effort: errors are silently swallowed.
 *
 * @param projectRoot - Project root directory
 * @param query - The search query or fetch IDs
 * @param entryIds - Array of entry IDs returned in this retrieval
 * @param source - Retrieval source ('find', 'fetch', 'hybrid', 'timeline', 'budget')
 * @param tokensUsed - Estimated tokens consumed (optional)
 * @param sessionId - Session ID for grouping retrievals by session (optional, soft FK to tasks.db)
 */
async function logRetrieval(
  projectRoot: string,
  query: string,
  entryIds: string[],
  source: string,
  tokensUsed?: number,
  sessionId?: string,
): Promise<void> {
  if (entryIds.length === 0) return;

  const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return;

  // Self-healing: create table if not exists (includes session_id column)
  const createSql =
    'CREATE TABLE IF NOT EXISTS brain_retrieval_log (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    'query TEXT NOT NULL,' +
    'entry_ids TEXT NOT NULL,' +
    'entry_count INTEGER NOT NULL,' +
    'source TEXT NOT NULL,' +
    'tokens_used INTEGER,' +
    'session_id TEXT,' +
    "created_at TEXT NOT NULL DEFAULT (datetime('now'))" +
    ')';
  try {
    nativeDb.prepare(createSql).run();
  } catch {
    return;
  }

  try {
    nativeDb
      .prepare(
        'INSERT INTO brain_retrieval_log (query, entry_ids, entry_count, source, tokens_used, session_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        query,
        JSON.stringify(entryIds),
        entryIds.length,
        source,
        tokensUsed ?? null,
        sessionId ?? null,
      );
  } catch {
    /* best-effort */
  }
}
