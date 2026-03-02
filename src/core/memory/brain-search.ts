/**
 * Full-text search across BRAIN memory using SQLite FTS5.
 * Uses raw SQL via nativeDb because drizzle doesn't support FTS5 virtual tables.
 *
 * Falls back to LIKE queries if FTS5 is not available (some SQLite builds lack it).
 *
 * @task T5130
 * @epic T5149
 */

import { getBrainNativeDb, getBrainDb } from '../../store/brain-sqlite.js';
import type { DatabaseSync } from 'node:sqlite';
import type { BrainDecisionRow, BrainPatternRow, BrainLearningRow } from '../../store/brain-schema.js';

/** Search result with BM25 rank. */
export interface BrainSearchResult {
  decisions: BrainDecisionRow[];
  patterns: BrainPatternRow[];
  learnings: BrainLearningRow[];
}

/** Search options. */
export interface BrainSearchOptions {
  /** Max results per table. Default 10. */
  limit?: number;
  /** Which tables to search. Default: all three. */
  tables?: Array<'decisions' | 'patterns' | 'learnings'>;
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
    nativeDb.prepare("CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_check USING fts5(test)").run();
    nativeDb.prepare("DROP TABLE IF EXISTS _fts5_check").run();
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
  execDDL(nativeDb, `
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_decisions_fts
    USING fts5(id, decision, rationale, content=brain_decisions, content_rowid=rowid)
  `);

  // Patterns FTS
  execDDL(nativeDb, `
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_patterns_fts
    USING fts5(id, pattern, context, content=brain_patterns, content_rowid=rowid)
  `);

  // Learnings FTS
  execDDL(nativeDb, `
    CREATE VIRTUAL TABLE IF NOT EXISTS brain_learnings_fts
    USING fts5(id, insight, source, content=brain_learnings, content_rowid=rowid)
  `);

  // Content-sync triggers for decisions
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_decisions_ai AFTER INSERT ON brain_decisions BEGIN
      INSERT INTO brain_decisions_fts(rowid, id, decision, rationale)
      VALUES (new.rowid, new.id, new.decision, new.rationale);
    END
  `);
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_decisions_ad AFTER DELETE ON brain_decisions BEGIN
      INSERT INTO brain_decisions_fts(brain_decisions_fts, rowid, id, decision, rationale)
      VALUES('delete', old.rowid, old.id, old.decision, old.rationale);
    END
  `);
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_decisions_au AFTER UPDATE ON brain_decisions BEGIN
      INSERT INTO brain_decisions_fts(brain_decisions_fts, rowid, id, decision, rationale)
      VALUES('delete', old.rowid, old.id, old.decision, old.rationale);
      INSERT INTO brain_decisions_fts(rowid, id, decision, rationale)
      VALUES (new.rowid, new.id, new.decision, new.rationale);
    END
  `);

  // Content-sync triggers for patterns
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_patterns_ai AFTER INSERT ON brain_patterns BEGIN
      INSERT INTO brain_patterns_fts(rowid, id, pattern, context)
      VALUES (new.rowid, new.id, new.pattern, new.context);
    END
  `);
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_patterns_ad AFTER DELETE ON brain_patterns BEGIN
      INSERT INTO brain_patterns_fts(brain_patterns_fts, rowid, id, pattern, context)
      VALUES('delete', old.rowid, old.id, old.pattern, old.context);
    END
  `);
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_patterns_au AFTER UPDATE ON brain_patterns BEGIN
      INSERT INTO brain_patterns_fts(brain_patterns_fts, rowid, id, pattern, context)
      VALUES('delete', old.rowid, old.id, old.pattern, old.context);
      INSERT INTO brain_patterns_fts(rowid, id, pattern, context)
      VALUES (new.rowid, new.id, new.pattern, new.context);
    END
  `);

  // Content-sync triggers for learnings
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_learnings_ai AFTER INSERT ON brain_learnings BEGIN
      INSERT INTO brain_learnings_fts(rowid, id, insight, source)
      VALUES (new.rowid, new.id, new.insight, new.source);
    END
  `);
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_learnings_ad AFTER DELETE ON brain_learnings BEGIN
      INSERT INTO brain_learnings_fts(brain_learnings_fts, rowid, id, insight, source)
      VALUES('delete', old.rowid, old.id, old.insight, old.source);
    END
  `);
  execDDL(nativeDb, `
    CREATE TRIGGER IF NOT EXISTS brain_learnings_au AFTER UPDATE ON brain_learnings BEGIN
      INSERT INTO brain_learnings_fts(brain_learnings_fts, rowid, id, insight, source)
      VALUES('delete', old.rowid, old.id, old.insight, old.source);
      INSERT INTO brain_learnings_fts(rowid, id, insight, source)
      VALUES (new.rowid, new.id, new.insight, new.source);
    END
  `);

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
    return { decisions: [], patterns: [], learnings: [] };
  }

  // Ensure brain.db is initialized
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { decisions: [], patterns: [], learnings: [] };
  }

  const limit = options?.limit ?? 10;
  const tables = options?.tables ?? ['decisions', 'patterns', 'learnings'];

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
  tables: Array<'decisions' | 'patterns' | 'learnings'>,
  limit: number,
): BrainSearchResult {
  const result: BrainSearchResult = {
    decisions: [],
    patterns: [],
    learnings: [],
  };

  // Escape FTS5 special characters for safety
  const safeQuery = escapeFts5Query(query);

  if (tables.includes('decisions')) {
    try {
      const rows = nativeDb.prepare(`
        SELECT d.*
        FROM brain_decisions_fts fts
        JOIN brain_decisions d ON d.rowid = fts.rowid
        WHERE brain_decisions_fts MATCH ?
        ORDER BY bm25(brain_decisions_fts)
        LIMIT ?
      `).all(safeQuery, limit) as unknown as BrainDecisionRow[];
      result.decisions = rows;
    } catch {
      // FTS query failed, fall back to LIKE for this table
      result.decisions = likeSearchDecisions(nativeDb, query, limit);
    }
  }

  if (tables.includes('patterns')) {
    try {
      const rows = nativeDb.prepare(`
        SELECT p.*
        FROM brain_patterns_fts fts
        JOIN brain_patterns p ON p.rowid = fts.rowid
        WHERE brain_patterns_fts MATCH ?
        ORDER BY bm25(brain_patterns_fts)
        LIMIT ?
      `).all(safeQuery, limit) as unknown as BrainPatternRow[];
      result.patterns = rows;
    } catch {
      result.patterns = likeSearchPatterns(nativeDb, query, limit);
    }
  }

  if (tables.includes('learnings')) {
    try {
      const rows = nativeDb.prepare(`
        SELECT l.*
        FROM brain_learnings_fts fts
        JOIN brain_learnings l ON l.rowid = fts.rowid
        WHERE brain_learnings_fts MATCH ?
        ORDER BY bm25(brain_learnings_fts)
        LIMIT ?
      `).all(safeQuery, limit) as unknown as BrainLearningRow[];
      result.learnings = rows;
    } catch {
      result.learnings = likeSearchLearnings(nativeDb, query, limit);
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
  tables: Array<'decisions' | 'patterns' | 'learnings'>,
  limit: number,
): BrainSearchResult {
  const result: BrainSearchResult = {
    decisions: [],
    patterns: [],
    learnings: [],
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

  return result;
}

function likeSearchDecisions(nativeDb: DatabaseSync, query: string, limit: number): BrainDecisionRow[] {
  const likePattern = `%${query}%`;
  return nativeDb.prepare(`
    SELECT * FROM brain_decisions
    WHERE decision LIKE ? OR rationale LIKE ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(likePattern, likePattern, limit) as unknown as BrainDecisionRow[];
}

function likeSearchPatterns(nativeDb: DatabaseSync, query: string, limit: number): BrainPatternRow[] {
  const likePattern = `%${query}%`;
  return nativeDb.prepare(`
    SELECT * FROM brain_patterns
    WHERE pattern LIKE ? OR context LIKE ?
    ORDER BY frequency DESC
    LIMIT ?
  `).all(likePattern, likePattern, limit) as unknown as BrainPatternRow[];
}

function likeSearchLearnings(nativeDb: DatabaseSync, query: string, limit: number): BrainLearningRow[] {
  const likePattern = `%${query}%`;
  return nativeDb.prepare(`
    SELECT * FROM brain_learnings
    WHERE insight LIKE ? OR source LIKE ?
    ORDER BY confidence DESC
    LIMIT ?
  `).all(likePattern, likePattern, limit) as unknown as BrainLearningRow[];
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
