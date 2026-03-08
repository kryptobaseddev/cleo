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
import { getBrainAccessor } from '../../store/brain-accessor.js';
import type {
  BrainDecisionRow,
  BrainLearningRow,
  BrainObservationRow,
  BrainPatternRow,
} from '../../store/brain-schema.js';
import { getBrainDb, getBrainNativeDb } from '../../store/brain-sqlite.js';
import type { SimilarityResult } from './brain-similarity.js';
import { searchSimilar } from './brain-similarity.js';

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
  if (!query || !query.trim()) {
    return { decisions: [], patterns: [], learnings: [], observations: [] };
  }

  // Ensure brain.db is initialized
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
      const rows = nativeDb
        .prepare(`
        SELECT d.*
        FROM brain_decisions_fts fts
        JOIN brain_decisions d ON d.rowid = fts.rowid
        WHERE brain_decisions_fts MATCH ?
        ORDER BY bm25(brain_decisions_fts)
        LIMIT ?
      `)
        .all(safeQuery, limit) as unknown as BrainDecisionRow[];
      result.decisions = rows;
    } catch {
      // FTS query failed, fall back to LIKE for this table
      result.decisions = likeSearchDecisions(nativeDb, query, limit);
    }
  }

  if (tables.includes('patterns')) {
    try {
      const rows = nativeDb
        .prepare(`
        SELECT p.*
        FROM brain_patterns_fts fts
        JOIN brain_patterns p ON p.rowid = fts.rowid
        WHERE brain_patterns_fts MATCH ?
        ORDER BY bm25(brain_patterns_fts)
        LIMIT ?
      `)
        .all(safeQuery, limit) as unknown as BrainPatternRow[];
      result.patterns = rows;
    } catch {
      result.patterns = likeSearchPatterns(nativeDb, query, limit);
    }
  }

  if (tables.includes('learnings')) {
    try {
      const rows = nativeDb
        .prepare(`
        SELECT l.*
        FROM brain_learnings_fts fts
        JOIN brain_learnings l ON l.rowid = fts.rowid
        WHERE brain_learnings_fts MATCH ?
        ORDER BY bm25(brain_learnings_fts)
        LIMIT ?
      `)
        .all(safeQuery, limit) as unknown as BrainLearningRow[];
      result.learnings = rows;
    } catch {
      result.learnings = likeSearchLearnings(nativeDb, query, limit);
    }
  }

  if (tables.includes('observations')) {
    try {
      const rows = nativeDb
        .prepare(`
        SELECT o.*
        FROM brain_observations_fts fts
        JOIN brain_observations o ON o.rowid = fts.rowid
        WHERE brain_observations_fts MATCH ?
        ORDER BY bm25(brain_observations_fts)
        LIMIT ?
      `)
        .all(safeQuery, limit) as unknown as BrainObservationRow[];
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
  return nativeDb
    .prepare(`
    SELECT * FROM brain_decisions
    WHERE decision LIKE ? OR rationale LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `)
    .all(likePattern, likePattern, limit) as unknown as BrainDecisionRow[];
}

function likeSearchPatterns(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
): BrainPatternRow[] {
  const likePattern = `%${query}%`;
  return nativeDb
    .prepare(`
    SELECT * FROM brain_patterns
    WHERE pattern LIKE ? OR context LIKE ?
    ORDER BY frequency DESC
    LIMIT ?
  `)
    .all(likePattern, likePattern, limit) as unknown as BrainPatternRow[];
}

function likeSearchLearnings(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
): BrainLearningRow[] {
  const likePattern = `%${query}%`;
  return nativeDb
    .prepare(`
    SELECT * FROM brain_learnings
    WHERE insight LIKE ? OR source LIKE ?
    ORDER BY confidence DESC
    LIMIT ?
  `)
    .all(likePattern, likePattern, limit) as unknown as BrainLearningRow[];
}

function likeSearchObservations(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
): BrainObservationRow[] {
  const likePattern = `%${query}%`;
  return nativeDb
    .prepare(`
    SELECT * FROM brain_observations
    WHERE title LIKE ? OR narrative LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `)
    .all(likePattern, likePattern, limit) as unknown as BrainObservationRow[];
}

/**
 * Escape special FTS5 characters in query string.
 * Wraps each token in quotes to prevent syntax errors from special chars.
 */
function escapeFts5Query(query: string): string {
  // Split on whitespace, wrap each token in double quotes
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
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
// Hybrid Search (FTS5 + Vector + Graph)
// ============================================================================

/** Result from hybridSearch combining multiple search signals. */
export interface HybridResult {
  id: string;
  score: number;
  type: string;
  title: string;
  text: string;
  sources: Array<'fts' | 'vec' | 'graph'>;
}

/** Options for hybridSearch weighting and limits. */
export interface HybridSearchOptions {
  ftsWeight?: number;
  vecWeight?: number;
  graphWeight?: number;
  limit?: number;
}

/**
 * Hybrid search across FTS5, vector similarity, and graph neighbors.
 *
 * 1. Runs FTS5 search via existing searchBrain.
 * 2. Runs vector similarity via searchSimilar (if available).
 * 3. Runs graph neighbor expansion via getNeighbors (if query matches a node).
 * 4. Normalizes scores to 0-1 using min-max normalization.
 * 5. Combines with configurable weights.
 * 6. Deduplicates by ID, keeping highest combined score.
 * 7. Returns top-N sorted by score descending.
 *
 * Graceful fallback: if vec unavailable, redistributes weight to FTS5.
 *
 * @param query - Search query text
 * @param projectRoot - Project root directory
 * @param options - Weight and limit configuration
 * @returns Array of hybrid results ranked by combined score
 */
export async function hybridSearch(
  query: string,
  projectRoot: string,
  options?: HybridSearchOptions,
): Promise<HybridResult[]> {
  if (!query || !query.trim()) return [];

  const maxResults = options?.limit ?? 10;
  let ftsWeight = options?.ftsWeight ?? 0.5;
  let vecWeight = options?.vecWeight ?? 0.4;
  const graphWeight = options?.graphWeight ?? 0.1;

  // Score accumulators: id -> { score, sources, type, title, text }
  const scoreMap = new Map<
    string,
    {
      score: number;
      type: string;
      title: string;
      text: string;
      sources: Set<'fts' | 'vec' | 'graph'>;
    }
  >();

  const addScore = (
    id: string,
    normalizedScore: number,
    weight: number,
    source: 'fts' | 'vec' | 'graph',
    type: string,
    title: string,
    text: string,
  ) => {
    const existing = scoreMap.get(id);
    if (existing) {
      existing.score += normalizedScore * weight;
      existing.sources.add(source);
    } else {
      scoreMap.set(id, {
        score: normalizedScore * weight,
        type,
        title,
        text,
        sources: new Set([source]),
      });
    }
  };

  // --- 1. FTS5 search ---
  const ftsResults = await searchBrain(projectRoot, query, { limit: maxResults * 2 });

  // Collect all FTS hits into a flat list with position-based scores
  const ftsHits: Array<{ id: string; type: string; title: string; text: string }> = [];

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

  // Normalize FTS: position-based (first result = 1.0, last = near 0)
  for (let i = 0; i < ftsHits.length; i++) {
    const hit = ftsHits[i]!;
    const normalizedScore = ftsHits.length > 1 ? 1.0 - i / (ftsHits.length - 1) : 1.0;
    addScore(hit.id, normalizedScore, ftsWeight, 'fts', hit.type, hit.title, hit.text);
  }

  // --- 2. Vector similarity search ---
  let vecResults: SimilarityResult[] = [];
  try {
    vecResults = await searchSimilar(query, projectRoot, maxResults * 2);
  } catch {
    // Vector search unavailable
  }

  if (vecResults.length > 0) {
    // Normalize vector: distance-based (smaller distance = higher score)
    const maxDist = Math.max(...vecResults.map((r) => r.distance), 0.001);
    for (const r of vecResults) {
      const normalizedScore = 1.0 - r.distance / maxDist;
      addScore(r.id, normalizedScore, vecWeight, 'vec', r.type, r.title, r.text);
    }
  } else {
    // Redistribute vec weight to FTS if vector unavailable
    ftsWeight += vecWeight;
    vecWeight = 0;

    // Re-score FTS hits with updated weight
    scoreMap.clear();
    for (let i = 0; i < ftsHits.length; i++) {
      const hit = ftsHits[i]!;
      const normalizedScore = ftsHits.length > 1 ? 1.0 - i / (ftsHits.length - 1) : 1.0;
      addScore(hit.id, normalizedScore, ftsWeight, 'fts', hit.type, hit.title, hit.text);
    }
  }

  // --- 3. Graph neighbor expansion ---
  try {
    const accessor = await getBrainAccessor(projectRoot);

    // Check if query matches a known graph node ID pattern
    const possibleNodeIds = [
      `concept:${query.toLowerCase().replace(/\s+/g, '-')}`,
      `task:${query}`,
      `doc:${query}`,
    ];

    for (const nodeId of possibleNodeIds) {
      const node = await accessor.getPageNode(nodeId);
      if (!node) continue;

      const neighbors = await accessor.getNeighbors(nodeId);
      for (let i = 0; i < neighbors.length; i++) {
        const neighbor = neighbors[i]!;
        const normalizedScore = neighbors.length > 1 ? 1.0 - i / (neighbors.length - 1) : 1.0;
        addScore(
          neighbor.id,
          normalizedScore,
          graphWeight,
          'graph',
          neighbor.nodeType,
          neighbor.label,
          neighbor.label,
        );
      }
    }
  } catch {
    // Graph search unavailable — no redistribution needed (small weight)
  }

  // --- 4. Sort and return top-N ---
  const sorted = [...scoreMap.entries()]
    .map(([id, data]) => ({
      id,
      score: data.score,
      type: data.type,
      title: data.title,
      text: data.text,
      sources: [...data.sources] as Array<'fts' | 'vec' | 'graph'>,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);

  return sorted;
}
