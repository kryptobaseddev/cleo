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
 * the dispatch layer (engine-compat -> domain handler -> MCP gateway).
 *
 * @task T5131 T5132 T5133 T5134 T5135
 * @epic T5149
 */

import { searchBrain } from './brain-search.js';
import { getBrainAccessor } from '../../store/brain-accessor.js';
import { getBrainDb, getBrainNativeDb } from '../../store/brain-sqlite.js';
import {
  BRAIN_OBSERVATION_TYPES,
  BRAIN_OBSERVATION_SOURCE_TYPES,
} from '../../store/brain-schema.js';

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
}

/** Parameters for searchBrainCompact. */
export interface SearchBrainCompactParams {
  query: string;
  limit?: number;
  tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
  dateStart?: string;
  dateEnd?: string;
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
  anchor: { id: string; type: string; data: unknown } | null;
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
  const { query, limit, tables, dateStart, dateEnd } = params;

  if (!query || !query.trim()) {
    return { results: [], total: 0, tokensEstimated: 0 };
  }

  const searchResult = await searchBrain(projectRoot, query, {
    limit: limit ?? 10,
    tables,
  });

  // Project full results to compact format.
  // Note: searchBrain() returns rows from raw SQL (nativeDb) which use
  // snake_case column names, but the TypeScript types are camelCase.
  // We handle both naming conventions for robustness.
  let results: BrainCompactHit[] = [];

  for (const d of searchResult.decisions) {
    const raw = d as Record<string, unknown>;
    results.push({
      id: d.id,
      type: 'decision',
      title: d.decision.slice(0, 80),
      date: (d.createdAt ?? raw['created_at'] as string) || '',
    });
  }

  for (const p of searchResult.patterns) {
    const raw = p as Record<string, unknown>;
    results.push({
      id: p.id,
      type: 'pattern',
      title: p.pattern.slice(0, 80),
      date: (p.extractedAt ?? raw['extracted_at'] as string) || '',
    });
  }

  for (const l of searchResult.learnings) {
    const raw = l as Record<string, unknown>;
    results.push({
      id: l.id,
      type: 'learning',
      title: l.insight.slice(0, 80),
      date: (l.createdAt ?? raw['created_at'] as string) || '',
    });
  }

  for (const o of searchResult.observations) {
    const raw = o as Record<string, unknown>;
    results.push({
      id: o.id,
      type: 'observation',
      title: o.title.slice(0, 80),
      date: (o.createdAt ?? raw['created_at'] as string) || '',
    });
  }

  // Apply date filters client-side if provided
  if (dateStart) {
    results = results.filter((r) => r.date >= dateStart);
  }
  if (dateEnd) {
    results = results.filter((r) => r.date <= dateEnd);
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
  const beforeRows = nativeDb.prepare(`
    SELECT id, 'decision' AS type, created_at AS date FROM brain_decisions WHERE created_at < ? AND id != ?
    UNION ALL
    SELECT id, 'pattern' AS type, extracted_at AS date FROM brain_patterns WHERE extracted_at < ? AND id != ?
    UNION ALL
    SELECT id, 'learning' AS type, created_at AS date FROM brain_learnings WHERE created_at < ? AND id != ?
    UNION ALL
    SELECT id, 'observation' AS type, created_at AS date FROM brain_observations WHERE created_at < ? AND id != ?
    ORDER BY date DESC
    LIMIT ?
  `).all(
    anchorDate, anchorId,
    anchorDate, anchorId,
    anchorDate, anchorId,
    anchorDate, anchorId,
    depthBefore,
  ) as unknown as TimelineNeighbor[];

  const afterRows = nativeDb.prepare(`
    SELECT id, 'decision' AS type, created_at AS date FROM brain_decisions WHERE created_at > ? AND id != ?
    UNION ALL
    SELECT id, 'pattern' AS type, extracted_at AS date FROM brain_patterns WHERE extracted_at > ? AND id != ?
    UNION ALL
    SELECT id, 'learning' AS type, created_at AS date FROM brain_learnings WHERE created_at > ? AND id != ?
    UNION ALL
    SELECT id, 'observation' AS type, created_at AS date FROM brain_observations WHERE created_at > ? AND id != ?
    ORDER BY date ASC
    LIMIT ?
  `).all(
    anchorDate, anchorId,
    anchorDate, anchorId,
    anchorDate, anchorId,
    anchorDate, anchorId,
    depthAfter,
  ) as unknown as TimelineNeighbor[];

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
  const { text, title: titleParam, type: typeParam, project, sourceSessionId, sourceType } = params;

  if (!text || !text.trim()) {
    throw new Error('Observation text is required');
  }

  const id = `O-${Date.now().toString(36)}`;
  const type = typeParam ?? classifyObservationType(text);
  const title = titleParam ?? text.slice(0, 120);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const accessor = await getBrainAccessor(projectRoot);

  const row = await accessor.addObservation({
    id,
    type,
    title,
    narrative: text,
    project: project ?? null,
    sourceSessionId: sourceSessionId ?? null,
    sourceType: sourceType ?? 'agent',
    createdAt: now,
  });

  return {
    id: row.id,
    type: row.type,
    createdAt: row.createdAt,
  };
}
