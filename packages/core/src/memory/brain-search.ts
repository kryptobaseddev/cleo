/**
 * Full-text search across BRAIN memory using SQLite FTS5.
 * Uses raw SQL via nativeDb because drizzle doesn't support FTS5 virtual tables.
 *
 * Falls back to LIKE queries if FTS5 is not available (some SQLite builds lack it).
 *
 * @task T5130
 * @epic T5149
 */

import type { DatabaseSync } from 'node:sqlite';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type {
  BrainDecisionRow,
  BrainLearningRow,
  BrainObservationRow,
  BrainPatternRow,
} from '../store/memory-schema.js';
import { typedAll } from '../store/typed-query.js';
import type { SimilarityResult } from './brain-similarity.js';
import { searchSimilar } from './brain-similarity.js';
import { QUALITY_SCORE_THRESHOLD } from './quality-scoring.js';

/** Search result with BM25 rank. */
export interface BrainSearchResult {
  decisions: BrainDecisionRow[];
  patterns: BrainPatternRow[];
  learnings: BrainLearningRow[];
  observations: BrainObservationRow[];
}

/** Search options. */
export interface BrainSearchOptions {
  /** Max results per table. Default 10. */
  limit?: number;
  /** Which tables to search. Default: all four. */
  tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
}

/** Track whether FTS5 is available in the current SQLite build. */
let _fts5Available: boolean | null = null;

/** Track whether FTS tables have been created and indexed this session. */
let _fts5Initialized = false;

/**
 * Check if FTS5 is available in the current SQLite build.
 */
function checkFts5Available(nativeDb: DatabaseSync): boolean {
  if (_fts5Available !== null) return _fts5Available;
  try {
    // Use run() to execute DDL statements
    nativeDb.prepare('CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_check USING fts5(test)').run();
    nativeDb.prepare('DROP TABLE IF EXISTS _fts5_check').run();
    _fts5Available = true;
  } catch {
    _fts5Available = false;
  }
  return _fts5Available;
}

/**
 * Execute a DDL statement using the native database.
 * Wraps nativeDb.prepare().run() for consistent usage.
 */
function execDDL(nativeDb: DatabaseSync, sql: string): void {
  nativeDb.prepare(sql).run();
}

/**
 * Create FTS5 virtual tables and content-sync triggers if they don't exist.
 *
 * Uses content= to sync from main tables, so inserts to main tables
 * auto-populate FTS. UPDATE/DELETE require triggers.
 *
 * @task T5130
 */
export function ensureFts5Tables(nativeDb: DatabaseSync): boolean {
  if (!checkFts5Available(nativeDb)) {
    return false;
  }

  // Decisions FTS
  execDDL(
    nativeDb,
    `
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_decisions_fts
    USING fts5(id, decision, rationale, content=brain_decisions, content_rowid=rowid)
  `,
  );

  // Patterns FTS
  execDDL(
    nativeDb,
    `
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_patterns_fts
    USING fts5(id, pattern, context, content=brain_patterns, content_rowid=rowid)
  `,
  );

  // Learnings FTS
  execDDL(
    nativeDb,
    `
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_learnings_fts
    USING fts5(id, insight, source, content=brain_learnings, content_rowid=rowid)
  `,
  );

  // Content-sync triggers for decisions
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_decisions_ai AFTER INSERT ON brain_decisions BEGIN
      INSERT INTO brain_decisions_fts(rowid, id, decision, rationale)
      VALUES (new.rowid, new.id, new.decision, new.rationale);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_decisions_ad AFTER DELETE ON brain_decisions BEGIN
      INSERT INTO brain_decisions_fts(brain_decisions_fts, rowid, id, decision, rationale)
      VALUES('delete', old.rowid, old.id, old.decision, old.rationale);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_decisions_au AFTER UPDATE ON brain_decisions BEGIN
      INSERT INTO brain_decisions_fts(brain_decisions_fts, rowid, id, decision, rationale)
      VALUES('delete', old.rowid, old.id, old.decision, old.rationale);
      INSERT INTO brain_decisions_fts(rowid, id, decision, rationale)
      VALUES (new.rowid, new.id, new.decision, new.rationale);
    END
  `,
  );

  // Content-sync triggers for patterns
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_patterns_ai AFTER INSERT ON brain_patterns BEGIN
      INSERT INTO brain_patterns_fts(rowid, id, pattern, context)
      VALUES (new.rowid, new.id, new.pattern, new.context);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_patterns_ad AFTER DELETE ON brain_patterns BEGIN
      INSERT INTO brain_patterns_fts(brain_patterns_fts, rowid, id, pattern, context)
      VALUES('delete', old.rowid, old.id, old.pattern, old.context);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_patterns_au AFTER UPDATE ON brain_patterns BEGIN
      INSERT INTO brain_patterns_fts(brain_patterns_fts, rowid, id, pattern, context)
      VALUES('delete', old.rowid, old.id, old.pattern, old.context);
      INSERT INTO brain_patterns_fts(rowid, id, pattern, context)
      VALUES (new.rowid, new.id, new.pattern, new.context);
    END
  `,
  );

  // Content-sync triggers for learnings
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_learnings_ai AFTER INSERT ON brain_learnings BEGIN
      INSERT INTO brain_learnings_fts(rowid, id, insight, source)
      VALUES (new.rowid, new.id, new.insight, new.source);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_learnings_ad AFTER DELETE ON brain_learnings BEGIN
      INSERT INTO brain_learnings_fts(brain_learnings_fts, rowid, id, insight, source)
      VALUES('delete', old.rowid, old.id, old.insight, old.source);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_learnings_au AFTER UPDATE ON brain_learnings BEGIN
      INSERT INTO brain_learnings_fts(brain_learnings_fts, rowid, id, insight, source)
      VALUES('delete', old.rowid, old.id, old.insight, old.source);
      INSERT INTO brain_learnings_fts(rowid, id, insight, source)
      VALUES (new.rowid, new.id, new.insight, new.source);
    END
  `,
  );

  // Observations FTS
  execDDL(
    nativeDb,
    `
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_observations_fts
    USING fts5(id, title, narrative, content=brain_observations, content_rowid=rowid)
  `,
  );

  // Content-sync triggers for observations
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_observations_ai AFTER INSERT ON brain_observations BEGIN
      INSERT INTO brain_observations_fts(rowid, id, title, narrative)
      VALUES (new.rowid, new.id, new.title, new.narrative);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_observations_ad AFTER DELETE ON brain_observations BEGIN
      INSERT INTO brain_observations_fts(brain_observations_fts, rowid, id, title, narrative)
      VALUES('delete', old.rowid, old.id, old.title, old.narrative);
    END
  `,
  );
  execDDL(
    nativeDb,
    `
    CREATE TRIGGER IF NOT EXISTS brain_observations_au AFTER UPDATE ON brain_observations BEGIN
      INSERT INTO brain_observations_fts(brain_observations_fts, rowid, id, title, narrative)
      VALUES('delete', old.rowid, old.id, old.title, old.narrative);
      INSERT INTO brain_observations_fts(rowid, id, title, narrative)
      VALUES (new.rowid, new.id, new.title, new.narrative);
    END
  `,
  );

  return true;
}

/**
 * Rebuild FTS5 indexes from the content tables.
 * Useful after bulk inserts that bypass triggers.
 *
 * @task T5130
 */
export function rebuildFts5Index(nativeDb: DatabaseSync): void {
  if (!checkFts5Available(nativeDb)) {
    return;
  }

  nativeDb.prepare("INSERT INTO brain_decisions_fts(brain_decisions_fts) VALUES('rebuild')").run();
  nativeDb.prepare("INSERT INTO brain_patterns_fts(brain_patterns_fts) VALUES('rebuild')").run();
  nativeDb.prepare("INSERT INTO brain_learnings_fts(brain_learnings_fts) VALUES('rebuild')").run();

  // Observations FTS rebuild — table may not exist yet in older DBs
  try {
    nativeDb
      .prepare("INSERT INTO brain_observations_fts(brain_observations_fts) VALUES('rebuild')")
      .run();
  } catch {
    // brain_observations_fts not created yet — skip
  }
}

/**
 * Unified search across all BRAIN memory tables.
 *
 * Uses FTS5 MATCH for full-text search with BM25 ranking when available,
 * falls back to LIKE queries otherwise.
 *
 * @task T5130
 */
export async function searchBrain(
  projectRoot: string,
  query: string,
  options?: BrainSearchOptions,
): Promise<BrainSearchResult> {
  if (!query?.trim()) {
    return { decisions: [], patterns: [], learnings: [], observations: [] };
  }

  // Ensure brain.db is initialized
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { decisions: [], patterns: [], learnings: [], observations: [] };
  }

  const limit = options?.limit ?? 10;
  const tables = options?.tables ?? ['decisions', 'patterns', 'learnings', 'observations'];

  const ftsAvailable = ensureFts5Tables(nativeDb);

  if (ftsAvailable) {
    // On first initialization, rebuild FTS indexes to sync any data
    // that was inserted before the FTS triggers existed.
    if (!_fts5Initialized) {
      _fts5Initialized = true;
      rebuildFts5Index(nativeDb);
    }
    return searchWithFts5(nativeDb, query, tables, limit);
  }

  return searchWithLike(nativeDb, query, tables, limit);
}

/**
 * Search using FTS5 MATCH with BM25 ranking.
 */
function searchWithFts5(
  nativeDb: DatabaseSync,
  query: string,
  tables: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>,
  limit: number,
): BrainSearchResult {
  const result: BrainSearchResult = {
    decisions: [],
    patterns: [],
    learnings: [],
    observations: [],
  };

  // Escape FTS5 special characters for safety
  const safeQuery = escapeFts5Query(query);

  if (tables.includes('decisions')) {
    try {
      const rows = typedAll<BrainDecisionRow>(
        nativeDb.prepare(`
        SELECT d.*
        FROM brain_decisions_fts fts
        JOIN brain_decisions d ON d.rowid = fts.rowid
        WHERE brain_decisions_fts MATCH ?
          AND (d.quality_score IS NULL OR d.quality_score >= ?)
        ORDER BY bm25(brain_decisions_fts)
        LIMIT ?
      `),
        safeQuery,
        QUALITY_SCORE_THRESHOLD,
        limit,
      );
      result.decisions = rows;
    } catch {
      // FTS query failed, fall back to LIKE for this table
      result.decisions = likeSearchDecisions(nativeDb, query, limit);
    }
  }

  if (tables.includes('patterns')) {
    try {
      const rows = typedAll<BrainPatternRow>(
        nativeDb.prepare(`
        SELECT p.*
        FROM brain_patterns_fts fts
        JOIN brain_patterns p ON p.rowid = fts.rowid
        WHERE brain_patterns_fts MATCH ?
          AND (p.quality_score IS NULL OR p.quality_score >= ?)
        ORDER BY bm25(brain_patterns_fts)
        LIMIT ?
      `),
        safeQuery,
        QUALITY_SCORE_THRESHOLD,
        limit,
      );
      result.patterns = rows;
    } catch {
      result.patterns = likeSearchPatterns(nativeDb, query, limit);
    }
  }

  if (tables.includes('learnings')) {
    try {
      const rows = typedAll<BrainLearningRow>(
        nativeDb.prepare(`
        SELECT l.*
        FROM brain_learnings_fts fts
        JOIN brain_learnings l ON l.rowid = fts.rowid
        WHERE brain_learnings_fts MATCH ?
          AND (l.quality_score IS NULL OR l.quality_score >= ?)
        ORDER BY bm25(brain_learnings_fts)
        LIMIT ?
      `),
        safeQuery,
        QUALITY_SCORE_THRESHOLD,
        limit,
      );
      result.learnings = rows;
    } catch {
      result.learnings = likeSearchLearnings(nativeDb, query, limit);
    }
  }

  if (tables.includes('observations')) {
    try {
      const rows = typedAll<BrainObservationRow>(
        nativeDb.prepare(`
        SELECT o.*
        FROM brain_observations_fts fts
        JOIN brain_observations o ON o.rowid = fts.rowid
        WHERE brain_observations_fts MATCH ?
          AND (o.quality_score IS NULL OR o.quality_score >= ?)
        ORDER BY bm25(brain_observations_fts)
        LIMIT ?
      `),
        safeQuery,
        QUALITY_SCORE_THRESHOLD,
        limit,
      );
      result.observations = rows;
    } catch {
      result.observations = likeSearchObservations(nativeDb, query, limit);
    }
  }

  return result;
}

/**
 * Search using LIKE queries as fallback when FTS5 is unavailable.
 */
function searchWithLike(
  nativeDb: DatabaseSync,
  query: string,
  tables: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>,
  limit: number,
): BrainSearchResult {
  const result: BrainSearchResult = {
    decisions: [],
    patterns: [],
    learnings: [],
    observations: [],
  };

  if (tables.includes('decisions')) {
    result.decisions = likeSearchDecisions(nativeDb, query, limit);
  }

  if (tables.includes('patterns')) {
    result.patterns = likeSearchPatterns(nativeDb, query, limit);
  }

  if (tables.includes('learnings')) {
    result.learnings = likeSearchLearnings(nativeDb, query, limit);
  }

  if (tables.includes('observations')) {
    result.observations = likeSearchObservations(nativeDb, query, limit);
  }

  return result;
}

function likeSearchDecisions(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
): BrainDecisionRow[] {
  const likePattern = `%${query}%`;
  return typedAll<BrainDecisionRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_decisions
    WHERE (decision LIKE ? OR rationale LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
    ORDER BY created_at DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    limit,
  );
}

function likeSearchPatterns(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
): BrainPatternRow[] {
  const likePattern = `%${query}%`;
  return typedAll<BrainPatternRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_patterns
    WHERE (pattern LIKE ? OR context LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
    ORDER BY frequency DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    limit,
  );
}

function likeSearchLearnings(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
): BrainLearningRow[] {
  const likePattern = `%${query}%`;
  return typedAll<BrainLearningRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_learnings
    WHERE (insight LIKE ? OR source LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
    ORDER BY confidence DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    limit,
  );
}

function likeSearchObservations(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
): BrainObservationRow[] {
  const likePattern = `%${query}%`;
  return typedAll<BrainObservationRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_observations
    WHERE (title LIKE ? OR narrative LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
    ORDER BY created_at DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    limit,
  );
}

/**
 * Escape special FTS5 characters in query string.
 *
 * Wraps each meaningful token in double quotes and joins with OR so that
 * partial matches are returned even when some tokens are not indexable
 * (e.g. task prefixes like "EPIC:", em-dashes "—", or short stop-words).
 *
 * Strategy:
 *   1. Split on whitespace.
 *   2. Keep only tokens that contain at least one word character (\w), which
 *      ensures punctuation-only tokens (em dashes, colons standalone, etc.)
 *      are dropped before they zero-out the entire result set.
 *   3. Deduplicate case-insensitively.
 *   4. Join with OR so the query broadens rather than requiring ALL tokens.
 *
 * Using AND (implicit FTS5 join) caused empty results whenever a task title
 * contained non-word tokens such as em dashes ("—") or trailing colons
 * ("EPIC:"), because FTS5's default tokenizer cannot index them and the
 * AND semantics then guaranteed zero matches for the whole query. (T553 bug fix)
 */
function escapeFts5Query(query: string): string {
  const rawTokens = query.trim().split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0) return '""';

  // Keep tokens that have at least one alphanumeric character and are not
  // pure stop-words (length ≥ 2 after stripping leading/trailing punctuation).
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const t of rawTokens) {
    // Strip leading/trailing non-word characters (e.g. "EPIC:" → "EPIC", "—" → "")
    const stripped = t.replace(/^\W+|\W+$/g, '');
    if (stripped.length < 2) continue; // skip very short or empty tokens
    if (!/\w/.test(stripped)) continue; // skip tokens with no word chars
    const lower = stripped.toLowerCase();
    if (seen.has(lower)) continue; // deduplicate
    seen.add(lower);
    tokens.push(`"${stripped.replace(/"/g, '""')}"`);
  }

  if (tokens.length === 0) return '""';

  // OR semantics: any matching token returns the row, ranked by BM25 relevance.
  return tokens.join(' OR ');
}

/**
 * Reset the cached FTS5 availability flag.
 * Used in tests to force re-detection.
 */
export function resetFts5Cache(): void {
  _fts5Available = null;
  _fts5Initialized = false;
}

// ============================================================================
// Reciprocal Rank Fusion (RRF) — Hybrid Retrieval
// ============================================================================

/**
 * The RRF smoothing constant (research-proven at 60).
 *
 * Balances noise vs. signal: small values amplify top-rank differences;
 * large values compress ranks toward a flat distribution. 60 is the
 * standard value from Cormack, Clarke & Buettcher (SIGIR 2009).
 */
export const RRF_K = 60;

/** A single ranked hit from one retrieval source before fusion. */
export interface RrfHit {
  id: string;
  type: string;
  title: string;
  text: string;
}

/** Fused result produced by reciprocalRankFusion. */
export interface RrfResult {
  id: string;
  /** Combined RRF score: sum of 1/(rank+RRF_K) across all source lists. */
  rrfScore: number;
  type: string;
  title: string;
  text: string;
  /** Which retrieval sources contributed to this result. */
  sources: Array<'fts' | 'vec' | 'graph' | 'code'>;
  /** BM25-derived FTS rank (0-based) — undefined if not in FTS results. */
  ftsRank?: number;
  /** Vector distance rank (0-based) — undefined if not in vector results. */
  vecRank?: number;
}

/**
 * Fuse ranked lists from multiple retrieval sources using Reciprocal Rank Fusion.
 *
 * Implements the RRF algorithm from Cormack, Clarke & Buettcher (SIGIR 2009):
 *
 *   score(d) = Σ 1 / (k + rank(d, list))  for each list containing d
 *
 * where k=60 is the research-proven smoothing constant.
 *
 * Properties:
 * - Rank-based: actual scores from each source are ignored (only rank matters).
 * - Additive: items appearing in multiple lists accumulate higher scores.
 * - Robust: the +60 constant prevents rank-1 items from dominating.
 *
 * @param sources - Named arrays of ranked hits (order = rank, index 0 = best)
 * @param k - RRF smoothing constant (default: RRF_K = 60)
 * @returns Array of fused results sorted by rrfScore descending
 *
 * @example
 * ```ts
 * const fused = reciprocalRankFusion([
 *   { source: 'fts', hits: ftsHits },
 *   { source: 'vec', hits: vecHits },
 * ]);
 * ```
 */
export function reciprocalRankFusion(
  sources: Array<{
    source: 'fts' | 'vec' | 'graph' | 'code';
    hits: RrfHit[];
  }>,
  k: number = RRF_K,
): RrfResult[] {
  // Accumulator: id -> mutable result record
  const accum = new Map<
    string,
    {
      rrfScore: number;
      type: string;
      title: string;
      text: string;
      sources: Set<'fts' | 'vec' | 'graph' | 'code'>;
      ftsRank?: number;
      vecRank?: number;
    }
  >();

  for (const { source, hits } of sources) {
    for (let rank = 0; rank < hits.length; rank++) {
      const hit = hits[rank]!;
      const contribution = 1 / (k + rank);

      const existing = accum.get(hit.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.sources.add(source);
        if (source === 'fts') existing.ftsRank = rank;
        if (source === 'vec') existing.vecRank = rank;
      } else {
        accum.set(hit.id, {
          rrfScore: contribution,
          type: hit.type,
          title: hit.title,
          text: hit.text,
          sources: new Set([source]),
          ftsRank: source === 'fts' ? rank : undefined,
          vecRank: source === 'vec' ? rank : undefined,
        });
      }
    }
  }

  return [...accum.entries()]
    .map(([id, data]) => ({
      id,
      rrfScore: data.rrfScore,
      type: data.type,
      title: data.title,
      text: data.text,
      sources: [...data.sources] as Array<'fts' | 'vec' | 'graph' | 'code'>,
      ftsRank: data.ftsRank,
      vecRank: data.vecRank,
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

// ============================================================================
// Hybrid Search (FTS5 + Vector + Graph) — RRF-powered
// ============================================================================

/** Result from hybridSearch combining multiple search signals. */
export interface HybridResult {
  id: string;
  /** RRF-fused score: sum of 1/(rank+60) across all source lists. */
  score: number;
  type: string;
  title: string;
  text: string;
  sources: Array<'fts' | 'vec' | 'graph' | 'code'>;
  /** Raw FTS rank (0-based) for transparency — undefined if FTS did not return this item. */
  ftsRank?: number;
  /** Raw vector rank (0-based) for transparency — undefined if vector did not return this item. */
  vecRank?: number;
}

/** Options for hybridSearch. */
export interface HybridSearchOptions {
  limit?: number;
  /**
   * RRF smoothing constant k. Default: 60 (research-proven).
   * Larger k flattens rank differences; smaller k amplifies top-rank advantage.
   */
  rrfK?: number;
  /**
   * When true, also search code symbols via @cleocode/nexus smartSearch.
   * Default: false. Code symbol hits are mapped to memory-compatible type/title.
   *
   * @task T1058
   */
  includeCode?: boolean;
}

/**
 * Hybrid search across FTS5, vector similarity, graph neighbors, and optionally code symbols.
 * Uses Reciprocal Rank Fusion (RRF) for result combination.
 *
 * Algorithm:
 * 1. Run FTS5 search, vector similarity search, and optionally code symbol search in parallel.
 * 2. Optionally expand via graph neighbors (best-effort).
 * 3. Fuse all ranked lists with RRF: score = Σ 1/(rank+rrfK).
 * 4. Return top-N sorted by fused RRF score.
 *
 * Graceful degradation: vector, graph, and code sources are silently skipped when
 * unavailable — RRF naturally handles partial source lists.
 *
 * @param query - Search query text
 * @param projectRoot - Project root directory
 * @param options - Limit, RRF tuning, and includeCode flag for code symbol search
 * @returns Array of hybrid results ranked by RRF score descending
 *
 * @task T5130 (hybrid search), T1058 (code symbol integration)
 */
export async function hybridSearch(
  query: string,
  projectRoot: string,
  options?: HybridSearchOptions,
): Promise<HybridResult[]> {
  if (!query?.trim()) return [];

  const maxResults = options?.limit ?? 10;
  const rrfK = options?.rrfK ?? RRF_K;
  const includeCode = options?.includeCode ?? false;

  // --- 1. Run FTS5, vector, and code symbol search in parallel ---
  const searches: Promise<unknown>[] = [
    searchBrain(projectRoot, query, { limit: maxResults * 3 }).catch(() => ({
      decisions: [],
      patterns: [],
      learnings: [],
      observations: [],
    })),
    searchSimilar(query, projectRoot, maxResults * 3).catch(() => [] as SimilarityResult[]),
  ];

  // Optionally search code symbols
  let codeSearchPromise: Promise<
    Array<{ id: string; title: string; kind: string; score: number }>
  > | null = null;
  if (includeCode) {
    codeSearchPromise = (async () => {
      try {
        const { smartSearch } = await import('@cleocode/nexus');
        const results = smartSearch(query, {
          maxResults: maxResults * 2,
          rootDir: projectRoot,
        });
        return results.map((r) => ({
          id: `code:${r.symbol.filePath}:${r.symbol.name}:${r.symbol.startLine}`,
          title: r.symbol.name,
          kind: r.symbol.kind,
          score: r.score,
        }));
      } catch {
        return [];
      }
    })();
    searches.push(codeSearchPromise);
  }

  const allResults = await Promise.all(searches);
  const ftsResults = allResults[0] as BrainSearchResult;
  const vecResults = allResults[1] as SimilarityResult[];
  const codeResults = (includeCode ? (allResults[2] ?? []) : []) as Array<{
    id: string;
    title: string;
    kind: string;
    score: number;
  }>;

  // --- 2. Project FTS results into ranked RrfHit list ---
  const ftsHits: RrfHit[] = [];
  for (const d of ftsResults.decisions) {
    ftsHits.push({
      id: d.id,
      type: 'decision',
      title: d.decision,
      text: `${d.decision} — ${d.rationale}`,
    });
  }
  for (const p of ftsResults.patterns) {
    ftsHits.push({
      id: p.id,
      type: 'pattern',
      title: p.pattern,
      text: `${p.pattern} — ${p.context}`,
    });
  }
  for (const l of ftsResults.learnings) {
    ftsHits.push({
      id: l.id,
      type: 'learning',
      title: l.insight,
      text: `${l.insight} (source: ${l.source})`,
    });
  }
  for (const o of ftsResults.observations) {
    ftsHits.push({ id: o.id, type: 'observation', title: o.title, text: o.narrative ?? o.title });
  }

  // --- 3. Project vector results into ranked RrfHit list (ascending distance = descending quality) ---
  const vecHits: RrfHit[] = vecResults.map((r) => ({
    id: r.id,
    type: r.type,
    title: r.title,
    text: r.text,
  }));

  // --- 4. Project code symbol results into RrfHit list ---
  const codeHits: RrfHit[] = codeResults.map((r) => ({
    id: r.id,
    type: 'code-symbol',
    title: r.title,
    text: `${r.title} (${r.kind})`,
  }));

  // --- 5. Build source list for RRF ---
  const rrfSources: Array<{ source: 'fts' | 'vec' | 'graph' | 'code'; hits: RrfHit[] }> = [];
  if (ftsHits.length > 0) rrfSources.push({ source: 'fts', hits: ftsHits });
  if (vecHits.length > 0) rrfSources.push({ source: 'vec', hits: vecHits });
  if (codeHits.length > 0) rrfSources.push({ source: 'code', hits: codeHits });

  // --- 6. Graph neighbor expansion (best-effort) ---
  try {
    const accessor = await getBrainAccessor(projectRoot);
    const possibleNodeIds = [
      `concept:${query.toLowerCase().replace(/\s+/g, '-')}`,
      `task:${query}`,
      `doc:${query}`,
    ];

    const graphHits: RrfHit[] = [];
    for (const nodeId of possibleNodeIds) {
      const node = await accessor.getPageNode(nodeId);
      if (!node) continue;
      const neighbors = await accessor.getNeighbors(nodeId);
      for (const neighbor of neighbors) {
        graphHits.push({
          id: neighbor.id,
          type: neighbor.nodeType,
          title: neighbor.label,
          text: neighbor.label,
        });
      }
    }
    if (graphHits.length > 0) rrfSources.push({ source: 'graph', hits: graphHits });
  } catch {
    // Graph unavailable — RRF handles gracefully with remaining sources
  }

  // --- 7. Fuse with RRF and return top-N ---
  const fused = reciprocalRankFusion(rrfSources, rrfK);

  return fused.slice(0, maxResults).map((r) => ({
    id: r.id,
    score: r.rrfScore,
    type: r.type,
    title: r.title,
    text: r.text,
    sources: r.sources,
    ftsRank: r.ftsRank,
    vecRank: r.vecRank,
  }));
}
