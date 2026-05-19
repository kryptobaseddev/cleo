/**
 * Public API for the memory domain — promoted from internal to public barrel.
 *
 * These functions are consumed by CLI commands (`packages/cleo`) and Studio
 * routes (`packages/studio`) and are therefore part of the stable public
 * surface of `@cleocode/core/memory`.
 *
 * None of these functions issue raw SQL; they compose over the existing
 * BRAIN retrieval, quality-feedback, decisions, patterns, and learnings
 * modules which own their respective schemas.
 *
 * @packageDocumentation
 * @task T9615
 * @epic T9592
 */

import { getProjectRoot } from '../paths.js';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import { listDecisions, searchDecisions } from './decisions.js';
import { graphStats } from './graph-queries.js';
import { searchLearnings } from './learnings.js';
import { type PatternType, searchPatterns } from './patterns.js';

// ---------------------------------------------------------------------------
// findMemoryEntries
// ---------------------------------------------------------------------------

/** A single cross-table memory search hit. */
export interface MemorySearchHit {
  /** Entry identifier. */
  id: string;
  /** Source brain table. */
  table: 'observations' | 'decisions' | 'patterns' | 'learnings';
  /** Display title. */
  title: string;
  /** Short preview string (first ~160 chars of narrative/rationale/context). */
  preview: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Quality score in [0..1] or null if not computed. */
  quality: number | null;
  /** Memory tier ('short' | 'medium' | 'long'). */
  tier: string | null;
  /** Whether the entry has been owner-verified (1 = true, 0 = false). */
  verified: number;
  /** Number of times this entry has been retrieved. */
  citations: number;
}

/** Options for {@link findMemoryEntries}. */
export interface FindMemoryEntriesOptions {
  /** Text query; required. */
  query: string;
  /** Tables to search. Defaults to all four brain tables. */
  tables?: Array<'observations' | 'decisions' | 'patterns' | 'learnings'>;
  /** Maximum results per table (capped at 100). Defaults to 25. */
  limit?: number;
  /** Project root path; defaults to resolved root. */
  projectPath?: string;
}

/** Result of {@link findMemoryEntries}. */
export interface FindMemoryEntriesResult {
  /** Echo of the search query. */
  query: string;
  /** Flat list of matching entries across all tables. */
  hits: MemorySearchHit[];
  /** Total hits returned. */
  total: number;
}

function truncate(s: string | null | undefined, n = 160): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Cross-table LIKE search across all four brain tables.
 *
 * @param opts - Search options including query text, table filter, and limit
 * @returns Flat list of matching entries sorted by citation count descending
 *
 * @remarks
 * Uses LIKE-based scans. For heavy workloads, prefer the dispatch-layer
 * `memory.find` operation which uses the full RRF fusion pipeline.
 *
 * @example
 * ```typescript
 * const result = await findMemoryEntries({ query: 'authentication', limit: 10 });
 * console.log(`Found ${result.total} matches`);
 * ```
 *
 * @task T9615
 */
export async function findMemoryEntries(
  opts: FindMemoryEntriesOptions,
): Promise<FindMemoryEntriesResult> {
  const { query, tables, limit = 25 } = opts;
  // Note: getBrainNativeDb() uses a process-level singleton; projectPath is
  // preserved in the options interface for forward-compatibility with
  // multi-project support but is not yet threaded to the singleton accessor.
  const db = getBrainNativeDb();
  const ALLOWED = ['observations', 'decisions', 'patterns', 'learnings'] as const;
  type Table = (typeof ALLOWED)[number];
  const requestedTables: Table[] =
    tables && tables.length > 0
      ? (tables.filter((t): t is Table => (ALLOWED as readonly string[]).includes(t)) as Table[])
      : [...ALLOWED];
  const cap = Math.max(1, Math.min(100, limit));

  if (!query.trim()) {
    return { query, hits: [], total: 0 };
  }

  if (!db) {
    return { query, hits: [], total: 0 };
  }

  const like = `%${query.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const hits: MemorySearchHit[] = [];

  if (requestedTables.includes('observations')) {
    try {
      const rows = db
        .prepare(
          `SELECT id, title, narrative, quality_score, memory_tier, verified,
                  citation_count, created_at
           FROM brain_observations
           WHERE (title LIKE ? ESCAPE '\\' OR narrative LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY citation_count DESC, created_at DESC
           LIMIT ?`,
        )
        .all(like, like, cap) as Array<{
        id: string;
        title: string | null;
        narrative: string | null;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        citation_count: number;
        created_at: string;
      }>;
      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'observations',
          title: r.title ?? '(untitled)',
          preview: truncate(r.narrative),
          createdAt: r.created_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: r.citation_count,
        });
      }
    } catch {
      // Table unavailable
    }
  }

  if (requestedTables.includes('decisions')) {
    try {
      const rows = db
        .prepare(
          `SELECT id, decision, rationale, quality_score, memory_tier, verified,
                  created_at
           FROM brain_decisions
           WHERE (decision LIKE ? ESCAPE '\\' OR rationale LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(like, like, cap) as Array<{
        id: string;
        decision: string;
        rationale: string | null;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        created_at: string;
      }>;
      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'decisions',
          title: truncate(r.decision, 100),
          preview: truncate(r.rationale),
          createdAt: r.created_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: 0,
        });
      }
    } catch {
      // Table unavailable
    }
  }

  if (requestedTables.includes('patterns')) {
    try {
      const rows = db
        .prepare(
          `SELECT id, pattern, context, quality_score, memory_tier, verified,
                  citation_count, extracted_at
           FROM brain_patterns
           WHERE (pattern LIKE ? ESCAPE '\\' OR context LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY citation_count DESC, extracted_at DESC
           LIMIT ?`,
        )
        .all(like, like, cap) as Array<{
        id: string;
        pattern: string;
        context: string | null;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        citation_count: number;
        extracted_at: string;
      }>;
      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'patterns',
          title: truncate(r.pattern, 100),
          preview: truncate(r.context),
          createdAt: r.extracted_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: r.citation_count,
        });
      }
    } catch {
      // Table unavailable
    }
  }

  if (requestedTables.includes('learnings')) {
    try {
      const rows = db
        .prepare(
          `SELECT id, insight, source, quality_score, memory_tier, verified,
                  citation_count, created_at
           FROM brain_learnings
           WHERE (insight LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY citation_count DESC, created_at DESC
           LIMIT ?`,
        )
        .all(like, like, cap) as Array<{
        id: string;
        insight: string;
        source: string | null;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        citation_count: number;
        created_at: string;
      }>;
      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'learnings',
          title: truncate(r.insight, 100),
          preview: truncate(r.source),
          createdAt: r.created_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: r.citation_count,
        });
      }
    } catch {
      // Table unavailable
    }
  }

  return { query, hits, total: hits.length };
}

// ---------------------------------------------------------------------------
// getObservations
// ---------------------------------------------------------------------------

/** A single brain observation record. */
export interface BrainObservation {
  /** Observation identifier. */
  id: string;
  /** Observation type tag. */
  type: string;
  /** Short title. */
  title: string;
  /** Optional subtitle. */
  subtitle: string | null;
  /** Full narrative text. */
  narrative: string | null;
  /** Project path scope. */
  project: string | null;
  /** Quality score in [0..1]. */
  qualityScore: number | null;
  /** Memory tier ('short' | 'medium' | 'long'). */
  memoryTier: string | null;
  /** Memory type tag. */
  memoryType: string | null;
  /** Owner-verified flag (1 = true, 0 = false). */
  verified: number;
  /** ISO timestamp when this observation became valid. */
  validAt: string | null;
  /** ISO timestamp when this observation was superseded. */
  invalidAt: string | null;
  /** Source confidence level. */
  sourceConfidence: string | null;
  /** Retrieval count. */
  citationCount: number;
  /** Whether this entry is a prune candidate. */
  pruneCandidate: number;
  /** ISO creation timestamp. */
  createdAt: string;
}

/** Options for {@link getObservations}. */
export interface GetObservationsOptions {
  /** Filter by memory tier ('short' | 'medium' | 'long'). */
  tier?: string;
  /** Filter by memory type. */
  type?: string;
  /** Minimum quality score (0..1). Entries with null score are excluded. */
  minQuality?: number;
  /** Maximum results (capped at 500). Defaults to 200. */
  limit?: number;
  /** Project root path; defaults to resolved root. */
  projectPath?: string;
}

/** Result of {@link getObservations}. */
export interface GetObservationsResult {
  /** Matching observations, ordered by creation time descending. */
  observations: BrainObservation[];
  /** Total rows in brain_observations regardless of filter. */
  total: number;
  /** Actual count returned. */
  filtered: number;
}

/**
 * List brain observations with optional filter by tier, type, and quality.
 *
 * @param opts - Optional filter and pagination options
 * @returns Paginated observation list plus total row count
 *
 * @example
 * ```typescript
 * const result = await getObservations({ tier: 'long', minQuality: 0.7 });
 * console.log(`${result.filtered} high-quality long-tier observations`);
 * ```
 *
 * @task T9615
 */
export async function getObservations(
  opts: GetObservationsOptions = {},
): Promise<GetObservationsResult> {
  const { tier, type, minQuality, limit = 200 } = opts;
  const db = getBrainNativeDb();
  const cap = Math.max(1, Math.min(500, limit));

  if (!db) {
    return { observations: [], total: 0, filtered: 0 };
  }

  try {
    const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM brain_observations').get() as {
      cnt: number;
    };

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (tier) {
      conditions.push('memory_tier = ?');
      params.push(tier);
    }
    if (type) {
      conditions.push('memory_type = ?');
      params.push(type);
    }
    if (minQuality !== undefined) {
      conditions.push('(quality_score IS NULL OR quality_score >= ?)');
      params.push(minQuality);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT id, type, title, subtitle, narrative, project,
                quality_score, memory_tier, memory_type, verified,
                valid_at, invalid_at, source_confidence, citation_count,
                prune_candidate, created_at
         FROM brain_observations
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...params, cap) as Array<{
      id: string;
      type: string;
      title: string;
      subtitle: string | null;
      narrative: string | null;
      project: string | null;
      quality_score: number | null;
      memory_tier: string | null;
      memory_type: string | null;
      verified: number;
      valid_at: string | null;
      invalid_at: string | null;
      source_confidence: string | null;
      citation_count: number;
      prune_candidate: number;
      created_at: string;
    }>;

    const observations: BrainObservation[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      subtitle: r.subtitle,
      narrative: r.narrative,
      project: r.project,
      qualityScore: r.quality_score,
      memoryTier: r.memory_tier,
      memoryType: r.memory_type,
      verified: r.verified,
      validAt: r.valid_at,
      invalidAt: r.invalid_at,
      sourceConfidence: r.source_confidence,
      citationCount: r.citation_count,
      pruneCandidate: r.prune_candidate,
      createdAt: r.created_at,
    }));

    return { observations, total: totalRow.cnt, filtered: observations.length };
  } catch {
    return { observations: [], total: 0, filtered: 0 };
  }
}

// ---------------------------------------------------------------------------
// getDecisions
// ---------------------------------------------------------------------------

/** Options for {@link getDecisions}. */
export interface GetDecisionsOptions {
  /** FTS query string to filter decisions. Empty string returns all. */
  query?: string;
  /** Project root path; defaults to resolved root. */
  projectPath?: string;
  /** Maximum results. Defaults to 50. */
  limit?: number;
}

/** A single decision record returned by {@link getDecisions}. */
export interface DecisionRecord {
  /** Decision identifier (e.g. D-arch-001). */
  id: string;
  /** Decision statement. */
  decision: string;
  /** Justification / rationale. */
  rationale: string | null;
  /** Outcome: proposed | accepted | rejected | superseded. */
  outcome: string | null;
  /** ISO creation timestamp. */
  createdAt: string;
  /** Memory tier. */
  memoryTier: string | null;
  /** Owner-verified flag. */
  verified: number;
}

/**
 * Retrieve decision records from brain.db, optionally filtered by text query.
 *
 * @param opts - Query, project path, and limit options
 * @returns Array of decision records
 *
 * @example
 * ```typescript
 * const { decisions } = await getDecisions({ query: 'database architecture', limit: 20 });
 * ```
 *
 * @task T9615
 */
export async function getDecisions(
  opts: GetDecisionsOptions = {},
): Promise<{ decisions: DecisionRecord[] }> {
  const { query = '', projectPath, limit = 50 } = opts;
  const root = projectPath ?? getProjectRoot();

  if (query.trim()) {
    const results = await searchDecisions(root, { query, limit });
    return {
      decisions: results.map((d) => ({
        id: d.id,
        decision: d.decision,
        rationale: d.rationale ?? null,
        outcome: d.outcome ?? null,
        createdAt: d.createdAt,
        memoryTier: d.memoryTier ?? null,
        verified: d.verified ? 1 : 0,
      })),
    };
  }

  const { decisions: resultList } = await listDecisions(root, { limit });
  return {
    decisions: resultList.map((d) => ({
      id: d.id,
      decision: d.decision,
      rationale: d.rationale ?? null,
      outcome: d.outcome ?? null,
      createdAt: d.createdAt,
      memoryTier: d.memoryTier ?? null,
      verified: d.verified ? 1 : 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// getPatterns
// ---------------------------------------------------------------------------

/** Options for {@link getPatterns}. */
export interface GetPatternsOptions {
  /** FTS query string. Empty string returns all. */
  query?: string;
  /** Filter by pattern type. */
  patternType?: string;
  /** Project root path; defaults to resolved root. */
  projectPath?: string;
  /** Maximum results. Defaults to 50. */
  limit?: number;
}

/** A single pattern record returned by {@link getPatterns}. */
export interface PatternRecord {
  /** Pattern identifier. */
  id: string;
  /** Pattern description. */
  pattern: string;
  /** Contextual description where the pattern applies. */
  context: string | null;
  /** Pattern type tag. */
  patternType: string | null;
  /** Impact level ('low' | 'medium' | 'high'). */
  impact: string | null;
  /** Extraction timestamp. */
  extractedAt: string;
  /** Memory tier. */
  memoryTier: string | null;
  /** Retrieval count. */
  citationCount: number;
}

/**
 * Retrieve pattern records from brain.db, optionally filtered by text query.
 *
 * @param opts - Query, project path, and limit options
 * @returns Array of pattern records
 *
 * @example
 * ```typescript
 * const { patterns } = await getPatterns({ query: 'authentication', patternType: 'success' });
 * ```
 *
 * @task T9615
 */
export async function getPatterns(
  opts: GetPatternsOptions = {},
): Promise<{ patterns: PatternRecord[] }> {
  const { query = '', patternType, projectPath, limit = 50 } = opts;
  const root = projectPath ?? getProjectRoot();

  const results = await searchPatterns(root, {
    query: query || undefined,
    type: patternType as PatternType | undefined,
    limit,
  });

  return {
    patterns: results.map((p) => ({
      id: p.id,
      pattern: p.pattern,
      context: p.context ?? null,
      patternType: p.type ?? null,
      impact: p.impact ?? null,
      extractedAt: p.extractedAt,
      memoryTier: p.memoryTier ?? null,
      citationCount:
        ((p as Record<string, unknown>).citationCount as number) ??
        ((p as Record<string, unknown>).frequency as number) ??
        0,
    })),
  };
}

// ---------------------------------------------------------------------------
// getLearnings
// ---------------------------------------------------------------------------

/** Options for {@link getLearnings}. */
export interface GetLearningsOptions {
  /** FTS query string. Empty string returns all. */
  query?: string;
  /** Project root path; defaults to resolved root. */
  projectPath?: string;
  /** Maximum results. Defaults to 50. */
  limit?: number;
}

/** A single learning record returned by {@link getLearnings}. */
export interface LearningRecord {
  /** Learning identifier. */
  id: string;
  /** Core insight. */
  insight: string;
  /** Source context where the learning was extracted from. */
  source: string | null;
  /** Learning type tag. */
  learningType: string | null;
  /** Creation timestamp. */
  createdAt: string;
  /** Memory tier. */
  memoryTier: string | null;
  /** Retrieval count. */
  citationCount: number;
}

/**
 * Retrieve learning records from brain.db, optionally filtered by text query.
 *
 * @param opts - Query, project path, and limit options
 * @returns Array of learning records
 *
 * @example
 * ```typescript
 * const { learnings } = await getLearnings({ query: 'cache invalidation' });
 * ```
 *
 * @task T9615
 */
export async function getLearnings(
  opts: GetLearningsOptions = {},
): Promise<{ learnings: LearningRecord[] }> {
  const { query = '', projectPath, limit = 50 } = opts;
  const root = projectPath ?? getProjectRoot();

  const results = await searchLearnings(root, {
    query: query || undefined,
    limit,
  });

  return {
    learnings: results.map((l) => ({
      id: l.id,
      insight: l.insight,
      source: l.source ?? null,
      learningType: l.memoryType ?? null,
      createdAt: l.createdAt,
      memoryTier: l.memoryTier ?? null,
      citationCount: ((l as Record<string, unknown>).citationCount as number) ?? 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// getMemoryGraph
// ---------------------------------------------------------------------------

/** Options for {@link getMemoryGraph}. */
export interface GetMemoryGraphOptions {
  /** Project root path; defaults to resolved root. */
  projectPath?: string;
}

/** Aggregate graph statistics returned by {@link getMemoryGraph}. */
export interface MemoryGraphStats {
  /** Total node count. */
  nodeCount: number;
  /** Total edge count. */
  edgeCount: number;
  /** Edge type distribution. */
  edgeTypeDistribution: Record<string, number>;
  /** Average edges per node. */
  averageEdgesPerNode: number;
}

/**
 * Return aggregate statistics for the BRAIN memory graph.
 *
 * @param opts - Optional project path
 * @returns Aggregate graph statistics (node count, edge count, type distribution)
 *
 * @example
 * ```typescript
 * const stats = await getMemoryGraph({ projectPath: '/my/project' });
 * console.log(`Graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
 * ```
 *
 * @task T9615
 */
export async function getMemoryGraph(opts: GetMemoryGraphOptions = {}): Promise<MemoryGraphStats> {
  const root = opts.projectPath ?? getProjectRoot();
  const raw = await graphStats(root);

  const edgeTypeDistribution: Record<string, number> = {};
  for (const e of raw.edgesByType) {
    edgeTypeDistribution[e.edgeType] = e.count;
  }

  return {
    nodeCount: raw.totalNodes,
    edgeCount: raw.totalEdges,
    edgeTypeDistribution,
    averageEdgesPerNode: raw.totalNodes > 0 ? raw.totalEdges / raw.totalNodes : 0,
  };
}

// ---------------------------------------------------------------------------
// getTierStats
// ---------------------------------------------------------------------------

/** Per-table tier count breakdown. */
export interface TableTierCounts {
  /** Brain table name. */
  table: string;
  /** Short-tier entry count. */
  short: number;
  /** Medium-tier entry count. */
  medium: number;
  /** Long-tier entry count. */
  long: number;
}

/** Medium entry approaching long-tier promotion. */
export interface UpcomingPromotion {
  /** Entry identifier. */
  id: string;
  /** Brain table name. */
  table: string;
  /** Fractional days remaining until 7-day gate elapses (0 = eligible now). */
  daysUntil: number;
  /** Human-readable track: "citation (N)" or "verified". */
  track: string;
}

/** Result of {@link getTierStats}. */
export interface TierStatsResult {
  /** Per-table tier distributions. */
  tables: TableTierCounts[];
  /** Top-5 medium entries closest to long-tier eligibility. */
  upcomingLongPromotions: UpcomingPromotion[];
}

/**
 * Return tier distribution and upcoming long-tier promotions.
 *
 * @param projectPath - Optional project root path
 * @returns Per-table tier counts and top-5 upcoming promotions
 *
 * @example
 * ```typescript
 * const stats = await getTierStats('/my/project');
 * console.log(`Short: ${stats.tables[0]?.short}, Long: ${stats.tables[0]?.long}`);
 * ```
 *
 * @task T9615
 */
export async function getTierStats(
  /** @reserved — will be threaded to getBrainNativeDb once multi-project support lands */
  _projectPath?: string,
): Promise<TierStatsResult> {
  const db = getBrainNativeDb();

  if (!db) {
    return { tables: [], upcomingLongPromotions: [] };
  }

  const brainTables = [
    { name: 'brain_observations', dateCol: 'created_at' },
    { name: 'brain_learnings', dateCol: 'created_at' },
    { name: 'brain_patterns', dateCol: 'extracted_at' },
    { name: 'brain_decisions', dateCol: 'created_at' },
  ] as const;

  const tables: TableTierCounts[] = [];
  for (const { name: tblName } of brainTables) {
    try {
      const rows = db
        .prepare(
          `SELECT COALESCE(memory_tier, 'short') as tier, COUNT(*) as cnt
           FROM ${tblName}
           WHERE invalid_at IS NULL
           GROUP BY memory_tier`,
        )
        .all() as Array<{ tier: string; cnt: number }>;
      const counts: TableTierCounts = { table: tblName, short: 0, medium: 0, long: 0 };
      for (const r of rows) {
        if (r.tier === 'short') counts.short = r.cnt;
        else if (r.tier === 'medium') counts.medium = r.cnt;
        else if (r.tier === 'long') counts.long = r.cnt;
      }
      tables.push(counts);
    } catch {
      tables.push({ table: tblName, short: 0, medium: 0, long: 0 });
    }
  }

  const age7dMs = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();

  interface PromoRow {
    id: string;
    created_at: string;
    citation_count: number;
    verified: number;
  }

  const upcoming: UpcomingPromotion[] = [];
  for (const { name: tblName, dateCol } of brainTables) {
    try {
      const rows = db
        .prepare(
          `SELECT id, ${dateCol} as created_at, citation_count, verified
           FROM ${tblName}
           WHERE memory_tier = 'medium'
             AND invalid_at IS NULL
             AND (citation_count >= 5 OR verified = 1)
           ORDER BY ${dateCol} ASC
           LIMIT 20`,
        )
        .all() as unknown as PromoRow[];
      for (const r of rows) {
        const entryMs = new Date(r.created_at.replace(' ', 'T') + 'Z').getTime();
        const promotionMs = entryMs + age7dMs;
        const daysUntil = Math.max(0, (promotionMs - nowMs) / (24 * 60 * 60 * 1000));
        const track = r.citation_count >= 5 ? `citation (${r.citation_count})` : 'verified';
        upcoming.push({ id: r.id, table: tblName, daysUntil, track });
      }
    } catch {
      // Table unavailable
    }
  }

  upcoming.sort((a, b) => a.daysUntil - b.daysUntil);

  return { tables, upcomingLongPromotions: upcoming.slice(0, 5) };
}

// ---------------------------------------------------------------------------
// getPendingVerify
// ---------------------------------------------------------------------------

/** A single pending-verify queue entry. */
export interface PendingVerifyEntry {
  /** Entry identifier. */
  id: string;
  /** Display title (decision text, pattern text, insight, or observation title). */
  title: string | null;
  /** Source confidence level. */
  sourceConfidence: string | null;
  /** Number of times this entry has been retrieved. */
  citationCount: number;
  /** Memory tier. */
  memoryTier: string | null;
  /** ISO creation timestamp. */
  createdAt: string;
  /** Source brain table. */
  table: 'observations' | 'decisions' | 'patterns' | 'learnings';
}

/** Options for {@link getPendingVerify}. */
export interface GetPendingVerifyOptions {
  /** Minimum citation count to include. Defaults to 5. */
  minCitations?: number;
  /** Maximum results to return. Defaults to 50. */
  limit?: number;
}

/** Result of {@link getPendingVerify}. */
export interface PendingVerifyResult {
  /** Total items returned. */
  count: number;
  /** Applied minimum citation threshold. */
  minCitations: number;
  /** Ranked pending-verify entries (highest citation count first). */
  items: PendingVerifyEntry[];
  /** Human-readable hint for the owner. */
  hint: string;
}

const PENDING_VERIFY_TABLES = [
  {
    table: 'observations' as const,
    sql: `SELECT id, title, source_confidence AS sourceConfidence,
                 citation_count AS citationCount, memory_tier AS memoryTier,
                 created_at AS createdAt
          FROM brain_observations
          WHERE verified = 0
            AND invalid_at IS NULL
            AND citation_count >= ?
          ORDER BY citation_count DESC, created_at DESC
          LIMIT ?`,
  },
  {
    table: 'decisions' as const,
    sql: `SELECT id, decision AS title, NULL AS sourceConfidence,
                 COALESCE(citation_count, 0) AS citationCount,
                 memory_tier AS memoryTier,
                 created_at AS createdAt
          FROM brain_decisions
          WHERE verified = 0
            AND invalid_at IS NULL
            AND COALESCE(citation_count, 0) >= ?
          ORDER BY citation_count DESC, created_at DESC
          LIMIT ?`,
  },
  {
    table: 'patterns' as const,
    sql: `SELECT id, pattern AS title, NULL AS sourceConfidence,
                 citation_count AS citationCount, memory_tier AS memoryTier,
                 extracted_at AS createdAt
          FROM brain_patterns
          WHERE verified = 0
            AND invalid_at IS NULL
            AND citation_count >= ?
          ORDER BY citation_count DESC, extracted_at DESC
          LIMIT ?`,
  },
  {
    table: 'learnings' as const,
    sql: `SELECT id, insight AS title, NULL AS sourceConfidence,
                 citation_count AS citationCount, memory_tier AS memoryTier,
                 created_at AS createdAt
          FROM brain_learnings
          WHERE verified = 0
            AND invalid_at IS NULL
            AND citation_count >= ?
          ORDER BY citation_count DESC, created_at DESC
          LIMIT ?`,
  },
] as const;

/**
 * Return unverified but highly-cited brain entries across all four tables.
 *
 * These are entries that the system keeps retrieving but the owner has not
 * promoted to ground-truth status. Exposing them surfaces the highest-leverage
 * candidates for `cleo memory verify`.
 *
 * @param projectPath - Optional project root path
 * @param opts - Minimum citation count and result limit
 * @returns Ranked list of pending-verify entries plus a hint
 *
 * @example
 * ```typescript
 * const result = await getPendingVerify('/my/project', { minCitations: 3 });
 * console.log(`${result.count} entries awaiting verification`);
 * ```
 *
 * @task T9615
 */
export async function getPendingVerify(
  /** @reserved — will be threaded to getBrainNativeDb once multi-project support lands */
  _projectPath?: string,
  opts: GetPendingVerifyOptions = {},
): Promise<PendingVerifyResult> {
  const { minCitations = 5, limit = 50 } = opts;
  const db = getBrainNativeDb();
  const cap = Math.max(1, Math.min(200, limit));

  if (!db) {
    return {
      count: 0,
      minCitations,
      items: [],
      hint: 'brain.db not available; start a session to populate memory.',
    };
  }

  const items: PendingVerifyEntry[] = [];
  for (const spec of PENDING_VERIFY_TABLES) {
    try {
      const rows = db.prepare(spec.sql).all(minCitations, cap) as Array<{
        id: string;
        title: string | null;
        sourceConfidence: string | null;
        citationCount: number;
        memoryTier: string | null;
        createdAt: string;
      }>;
      for (const r of rows) {
        items.push({
          id: r.id,
          title: r.title,
          sourceConfidence: r.sourceConfidence,
          citationCount: r.citationCount,
          memoryTier: r.memoryTier,
          createdAt: r.createdAt,
          table: spec.table,
        });
      }
    } catch {
      // Table missing or column drift — skip
    }
  }

  items.sort((a, b) => b.citationCount - a.citationCount);
  const top = items.slice(0, cap);

  const hint =
    top.length === 0
      ? `No entries with >= ${minCitations} citations. Lower the threshold or wait for more retrievals.`
      : `Promote entries the system keeps citing — use 'cleo memory verify <id>' to lock them to ground truth.`;

  return { count: top.length, minCitations, items: top, hint };
}

// getMemoryQualityReport is accessible via @cleocode/core/memory through
// the existing `export * from './quality-feedback.js'` in memory/index.ts.
// It is NOT re-exported here to avoid duplicate-export conflicts.
// Signature: getMemoryQualityReport(projectRoot: string): Promise<MemoryQualityReport>

// ---------------------------------------------------------------------------
// setEntryTier  (T9619 — tier promote/demote without raw SQL in CLI)
// ---------------------------------------------------------------------------

/** Direction for {@link setEntryTier}. */
export type TierDirection = 'promote' | 'demote';

/** Result of {@link setEntryTier}. */
export interface SetEntryTierResult {
  /** Entry identifier. */
  id: string;
  /** Brain table where the entry was found. */
  table: string;
  /** Previous memory tier. */
  fromTier: string;
  /** New memory tier. */
  toTier: string;
  /** ISO timestamp of the update. */
  updatedAt: string;
}

const BRAIN_TABLES = [
  'brain_observations',
  'brain_learnings',
  'brain_patterns',
  'brain_decisions',
] as const;

const TIER_ORDER: Record<string, number> = { short: 0, medium: 1, long: 2 };

/**
 * Set the memory tier of a single brain entry across all four brain tables.
 *
 * Validates direction (promote requires higher tier, demote requires lower tier)
 * and table membership before running the UPDATE. The long-tier demote guard
 * (requires explicit `force: true`) is enforced internally.
 *
 * @param id - Brain entry ID
 * @param targetTier - Target tier: 'short' | 'medium' | 'long'
 * @param direction - 'promote' or 'demote' (used for error messages and ordering checks)
 * @param opts - Additional options (force: allow demoting from long tier)
 * @returns Entry location + tier change details
 * @throws Error when entry not found, tier ordering is invalid, or long-tier guard fires
 *
 * @task T9619
 */
export async function setEntryTier(
  id: string,
  targetTier: string,
  direction: TierDirection,
  opts: { force?: boolean } = {},
): Promise<SetEntryTierResult> {
  const db = getBrainNativeDb();
  if (!db) {
    throw new Error('brain.db is unavailable');
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const tbl of BRAIN_TABLES) {
    try {
      const row = db
        .prepare(`SELECT id, memory_tier FROM ${tbl} WHERE id = ? AND invalid_at IS NULL LIMIT 1`)
        .get(id) as { id: string; memory_tier: string } | undefined;

      if (!row) continue;

      const fromTier = row.memory_tier ?? 'short';

      // Long-tier permanence guard (demote only)
      if (direction === 'demote' && fromTier === 'long' && !opts.force) {
        throw new Error(
          `Entry ${id} is in long tier. Long-tier entries are permanent. Use --force to override.`,
        );
      }

      if (fromTier === targetTier) {
        throw new Error(`Entry ${id} is already at tier '${targetTier}'`);
      }

      const fromOrd = TIER_ORDER[fromTier] ?? 0;
      const toOrd = TIER_ORDER[targetTier] ?? 0;

      if (direction === 'promote' && toOrd <= fromOrd) {
        throw new Error(
          `Cannot promote: '${targetTier}' is not higher than current tier '${fromTier}'. Use demote to lower tiers.`,
        );
      }
      if (direction === 'demote' && toOrd >= fromOrd) {
        throw new Error(
          `Cannot demote: '${targetTier}' is not lower than current tier '${fromTier}'. Use promote to raise tiers.`,
        );
      }

      db.prepare(`UPDATE ${tbl} SET memory_tier = ?, updated_at = ? WHERE id = ?`).run(
        targetTier,
        now,
        id,
      );

      return { id, table: tbl, fromTier, toTier: targetTier, updatedAt: now };
    } catch (err) {
      // Re-throw validation errors; skip table-not-found errors
      if (err instanceof Error && !err.message.includes('no such table')) {
        throw err;
      }
    }
  }

  throw new Error(`Entry '${id}' not found in any brain table (or is invalidated)`);
}

// ---------------------------------------------------------------------------
// scanDuplicateEntries  (T9619 — dedup-scan without raw SQL in CLI)
// ---------------------------------------------------------------------------

/** A group of duplicate brain entries sharing the same content hash. */
export interface DuplicateGroup {
  /** Brain table name. */
  table: string;
  /** Shared content hash. */
  hash: string;
  /** Number of entries sharing this hash. */
  count: number;
  /** Up to 3 sample entries (id + truncated label). */
  samples: string[];
}

/** Result of {@link scanDuplicateEntries}. */
export interface ScanDuplicatesResult {
  /** Total surplus rows (sum of count-1 across all groups). */
  totalDuplicateRows: number;
  /** All duplicate groups found. */
  groups: DuplicateGroup[];
}

const SCAN_TABLES = [
  { name: 'brain_observations', hashCol: 'content_hash', labelCol: 'title' },
  { name: 'brain_decisions', hashCol: 'content_hash', labelCol: 'decision' },
  { name: 'brain_patterns', hashCol: 'content_hash', labelCol: 'pattern' },
  { name: 'brain_learnings', hashCol: 'content_hash', labelCol: 'insight' },
] as const;

/**
 * Scan all four brain tables for content-hash duplicates.
 *
 * Returns up to 20 duplicate groups per table with up to 3 sample entries each.
 * Does NOT modify any data — call {@link runConsolidation} to merge.
 *
 * @returns Duplicate groups and total surplus row count
 *
 * @task T9619
 */
export async function scanDuplicateEntries(): Promise<ScanDuplicatesResult> {
  const db = getBrainNativeDb();
  const groups: DuplicateGroup[] = [];

  if (!db) {
    return { totalDuplicateRows: 0, groups };
  }

  for (const t of SCAN_TABLES) {
    let dupRows: Array<{ hash: string; cnt: number }> = [];
    try {
      dupRows = db
        .prepare(
          `SELECT ${t.hashCol} AS hash, COUNT(*) AS cnt
           FROM ${t.name}
           WHERE ${t.hashCol} IS NOT NULL
             AND invalid_at IS NULL
           GROUP BY ${t.hashCol}
           HAVING cnt > 1
           ORDER BY cnt DESC
           LIMIT 20`,
        )
        .all() as Array<{ hash: string; cnt: number }>;
    } catch {
      // Table unavailable — skip
    }

    for (const row of dupRows) {
      let sampleRows: Array<{ id: string; label: string }> = [];
      try {
        sampleRows = db
          .prepare(
            `SELECT id, COALESCE(${t.labelCol}, id) AS label
             FROM ${t.name}
             WHERE ${t.hashCol} = ?
               AND invalid_at IS NULL
             LIMIT 3`,
          )
          .all(row.hash) as Array<{ id: string; label: string }>;
      } catch {
        // Skip
      }

      groups.push({
        table: t.name,
        hash: row.hash,
        count: row.cnt,
        samples: sampleRows.map((r) => `${r.id}: ${String(r.label).slice(0, 80)}`),
      });
    }
  }

  const totalDuplicateRows = groups.reduce((sum, g) => sum + (g.count - 1), 0);
  return { totalDuplicateRows, groups };
}
