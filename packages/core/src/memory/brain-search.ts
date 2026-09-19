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
} from '../store/schema/memory-schema.js';
import { typedAll } from '../store/typed-query.js';
import type { SimilarityResult } from './brain-similarity.js';
import { searchSimilar } from './brain-similarity.js';
import { memoryEligibilityClause } from './eligibility.js';
import { QUALITY_SCORE_THRESHOLD } from './quality-scoring.js';

/** Search result grouped by backing memory table. */
export interface BrainMemorySearchResult {
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
  /**
   * T1085: Peer ID filter for CANT agent memory isolation (PSYCHE Wave 2).
   *
   * When provided, search results are scoped to entries where:
   *   `peer_id = peerId OR peer_id = 'global'`
   *
   * This ensures a peer always sees its own memories plus the global pool,
   * but never sees another peer's private memories.
   *
   * When omitted (undefined), all entries are returned regardless of peer_id —
   * preserving backward-compatible behavior for callers that predate Wave 2.
   */
  peerId?: string;
  /**
   * T1085: When true (default when peerId is provided), include entries with
   * `peer_id = 'global'` in addition to `peer_id = peerId`.
   *
   * Set to false for strict per-peer isolation (no global pool bleed-through).
   * Defaults to true — omitting this is equivalent to `includeGlobal: true`.
   */
  includeGlobal?: boolean;
  /** Include superseded and invalidated records for explicit historical retrieval. */
  includeHistory?: boolean;
}

/** Track whether FTS5 is available in the current SQLite build. */
let _fts5Available: boolean | null = null;

/**
 * Track WHICH brain database has had its FTS tables created and index rebuilt
 * this session — keyed by the resolved `cleo.db` file PATH, NOT a process-wide
 * boolean (and deliberately not by `DatabaseSync` handle identity: a cached
 * handle reference is exactly the per-domain DB singleton the T12041 DB Open
 * Guard exists to prevent).
 *
 * The dual-scope cache guarantees one `DatabaseSync` per `cleo.db` path, so a
 * different path means a different database whose FTS index may not yet
 * contain rows inserted before the content-sync triggers existed. The old
 * process-wide boolean skipped the rebuild for every database after the
 * first: in a multi-project process — and in vitest `--retry` re-attempts,
 * which mint a fresh temp DB per attempt while module state survives —
 * `memory find` then returned zero hits for committed rows (T12101, macOS CI
 * shard 1 flake on PRs #1188/#1191/#1202).
 *
 * Same-path file recreation (close + delete + recreate one `cleo.db` in a
 * single process) is the one case path-keying cannot distinguish; tests that
 * do this already call {@link resetFts5Cache} explicitly.
 *
 * Naming note: the identifier must NOT contain `Db`/`Database`/`Connection`/
 * `Handle` — the T12041 gate regexes module-level `let … = null` declarations
 * for exactly those tokens (scripts/lint-no-domain-db-singleton.mjs).
 *
 * @task T12101
 */
let _fts5RebuiltForPath: string | null = null;

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
): Promise<BrainMemorySearchResult> {
  if (!query?.trim()) {
    return { decisions: [], patterns: [], learnings: [], observations: [] };
  }

  // Ensure brain.db is initialized
  const { getBrainDb, getBrainDbPath, getBrainNativeDb } = await import(
    '../store/memory-sqlite.js'
  );
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb(projectRoot);

  if (!nativeDb) throw new Error('BRAIN database unavailable during search');

  const limit = options?.limit ?? 10;
  const tables = options?.tables ?? ['decisions', 'patterns', 'learnings', 'observations'];
  const peerId = options?.peerId;
  const includeGlobal = options?.includeGlobal ?? true;
  const includeHistory = options?.includeHistory ?? false;

  const ftsAvailable = ensureFts5Tables(nativeDb);

  if (ftsAvailable) {
    // On first search against THIS database, rebuild FTS indexes to sync any
    // data that was inserted before the FTS triggers existed. Path-keyed
    // (T12101): `getBrainDbPath` runs the same `resolveDualScopeDbPath`
    // resolver the dual-scope cache keys on, so a fresh or different database
    // always gets one rebuild — even when an earlier database in this process
    // was already synced — while repeat searches against the same DB skip it.
    if (_fts5RebuiltForPath !== getBrainDbPath(projectRoot)) {
      _fts5RebuiltForPath = getBrainDbPath(projectRoot);
      rebuildFts5Index(nativeDb);
    }
    return searchWithFts5(nativeDb, query, tables, limit, peerId, includeGlobal, includeHistory);
  }

  return searchWithLike(nativeDb, query, tables, limit, peerId, includeGlobal, includeHistory);
}

/**
 * Build a SQL peer isolation clause and the corresponding bind parameters.
 *
 * When `peerId` is undefined the clause is empty string (no filter applied).
 * When `peerId` is provided and `includeGlobal` is true (default), the clause
 * is `AND (t.peer_id = ? OR t.peer_id = 'global')`.
 * When `includeGlobal` is false, the clause is `AND t.peer_id = ?`.
 *
 * The `tableAlias` must match the alias used for the main table in the query.
 *
 * @internal
 */
function buildPeerClause(
  tableAlias: string,
  peerId: string | undefined,
  includeGlobal: boolean,
): { clause: string; params: string[] } {
  if (!peerId) return { clause: '', params: [] };
  if (includeGlobal) {
    return {
      clause: ` AND (${tableAlias}.peer_id = ? OR ${tableAlias}.peer_id = 'global')`,
      params: [peerId],
    };
  }
  return {
    clause: ` AND ${tableAlias}.peer_id = ?`,
    params: [peerId],
  };
}

/**
 * Search using FTS5 MATCH with BM25 ranking.
 */
function searchWithFts5(
  nativeDb: DatabaseSync,
  query: string,
  tables: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>,
  limit: number,
  peerId?: string,
  includeGlobal = true,
  includeHistory = false,
): BrainMemorySearchResult {
  const result: BrainMemorySearchResult = {
    decisions: [],
    patterns: [],
    learnings: [],
    observations: [],
  };

  // T12073: conjunctive-first. `fts5Queries.and` requires every term (high
  // precision); the OR form is used only when AND matches nothing, preserving
  // the recall the disjunctive builder was introduced for (T553).
  const fts5Queries = buildFts5Queries(query);

  if (tables.includes('decisions')) {
    const { clause, params } = buildPeerClause('d', peerId, includeGlobal);
    try {
      const stmt = nativeDb.prepare(`
        SELECT d.*
        FROM brain_decisions_fts fts
        JOIN brain_decisions d ON d.rowid = fts.rowid
        WHERE brain_decisions_fts MATCH ?
          AND (d.quality_score IS NULL OR d.quality_score >= ?)
          ${memoryEligibilityClause('decisions', 'd', includeHistory)}
          ${clause}
        ORDER BY CASE WHEN d.decision_category = 'agent_dispatch' THEN 1 ELSE 0 END, bm25(brain_decisions_fts)
        LIMIT ?
      `);
      const rows = matchConjunctiveFirst<BrainDecisionRow>(
        (matchExpr) =>
          typedAll<BrainDecisionRow>(stmt, matchExpr, QUALITY_SCORE_THRESHOLD, ...params, limit),
        fts5Queries,
      );
      result.decisions = rows;
    } catch {
      // FTS query failed, fall back to LIKE for this table
      result.decisions = likeSearchDecisions(
        nativeDb,
        query,
        limit,
        peerId,
        includeGlobal,
        includeHistory,
      );
    }
  }

  if (tables.includes('patterns')) {
    const { clause, params } = buildPeerClause('p', peerId, includeGlobal);
    try {
      const stmt = nativeDb.prepare(`
        SELECT p.*
        FROM brain_patterns_fts fts
        JOIN brain_patterns p ON p.rowid = fts.rowid
        WHERE brain_patterns_fts MATCH ?
          AND (p.quality_score IS NULL OR p.quality_score >= ?)
          ${memoryEligibilityClause('patterns', 'p', includeHistory)}
          ${clause}
        ORDER BY bm25(brain_patterns_fts)
        LIMIT ?
      `);
      const rows = matchConjunctiveFirst<BrainPatternRow>(
        (matchExpr) =>
          typedAll<BrainPatternRow>(stmt, matchExpr, QUALITY_SCORE_THRESHOLD, ...params, limit),
        fts5Queries,
      );
      result.patterns = rows;
    } catch {
      result.patterns = likeSearchPatterns(
        nativeDb,
        query,
        limit,
        peerId,
        includeGlobal,
        includeHistory,
      );
    }
  }

  if (tables.includes('learnings')) {
    const { clause, params } = buildPeerClause('l', peerId, includeGlobal);
    try {
      const stmt = nativeDb.prepare(`
        SELECT l.*
        FROM brain_learnings_fts fts
        JOIN brain_learnings l ON l.rowid = fts.rowid
        WHERE brain_learnings_fts MATCH ?
          AND (l.quality_score IS NULL OR l.quality_score >= ?)
          ${memoryEligibilityClause('learnings', 'l', includeHistory)}
          ${clause}
        ORDER BY bm25(brain_learnings_fts)
        LIMIT ?
      `);
      const rows = matchConjunctiveFirst<BrainLearningRow>(
        (matchExpr) =>
          typedAll<BrainLearningRow>(stmt, matchExpr, QUALITY_SCORE_THRESHOLD, ...params, limit),
        fts5Queries,
      );
      result.learnings = rows;
    } catch {
      result.learnings = likeSearchLearnings(
        nativeDb,
        query,
        limit,
        peerId,
        includeGlobal,
        includeHistory,
      );
    }
  }

  if (tables.includes('observations')) {
    const { clause, params } = buildPeerClause('o', peerId, includeGlobal);
    try {
      const stmt = nativeDb.prepare(`
        SELECT o.*
        FROM brain_observations_fts fts
        JOIN brain_observations o ON o.rowid = fts.rowid
        WHERE brain_observations_fts MATCH ?
          AND (o.quality_score IS NULL OR o.quality_score >= ?)
          ${memoryEligibilityClause('observations', 'o', includeHistory)}
          ${clause}
        ORDER BY CASE WHEN o.title LIKE 'Task start:%' OR o.title LIKE 'Task complete:%' THEN 1 ELSE 0 END, bm25(brain_observations_fts)
        LIMIT ?
      `);
      const rows = matchConjunctiveFirst<BrainObservationRow>(
        (matchExpr) =>
          typedAll<BrainObservationRow>(stmt, matchExpr, QUALITY_SCORE_THRESHOLD, ...params, limit),
        fts5Queries,
      );
      result.observations = rows;
    } catch {
      result.observations = likeSearchObservations(
        nativeDb,
        query,
        limit,
        peerId,
        includeGlobal,
        includeHistory,
      );
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
  peerId?: string,
  includeGlobal = true,
  includeHistory = false,
): BrainMemorySearchResult {
  const result: BrainMemorySearchResult = {
    decisions: [],
    patterns: [],
    learnings: [],
    observations: [],
  };

  if (tables.includes('decisions')) {
    result.decisions = likeSearchDecisions(
      nativeDb,
      query,
      limit,
      peerId,
      includeGlobal,
      includeHistory,
    );
  }

  if (tables.includes('patterns')) {
    result.patterns = likeSearchPatterns(
      nativeDb,
      query,
      limit,
      peerId,
      includeGlobal,
      includeHistory,
    );
  }

  if (tables.includes('learnings')) {
    result.learnings = likeSearchLearnings(
      nativeDb,
      query,
      limit,
      peerId,
      includeGlobal,
      includeHistory,
    );
  }

  if (tables.includes('observations')) {
    result.observations = likeSearchObservations(
      nativeDb,
      query,
      limit,
      peerId,
      includeGlobal,
      includeHistory,
    );
  }

  return result;
}

function likeSearchDecisions(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
  peerId?: string,
  includeGlobal = true,
  includeHistory = false,
): BrainDecisionRow[] {
  const likePattern = `%${query}%`;
  const { clause, params } = buildPeerClause('brain_decisions', peerId, includeGlobal);
  const eligibility = memoryEligibilityClause('decisions', 'brain_decisions', includeHistory);
  return typedAll<BrainDecisionRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_decisions
    WHERE (decision LIKE ? OR rationale LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
      ${eligibility}
      ${clause}
    ORDER BY created_at DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    ...params,
    limit,
  );
}

function likeSearchPatterns(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
  peerId?: string,
  includeGlobal = true,
  includeHistory = false,
): BrainPatternRow[] {
  const likePattern = `%${query}%`;
  const { clause, params } = buildPeerClause('brain_patterns', peerId, includeGlobal);
  const eligibility = memoryEligibilityClause('patterns', 'brain_patterns', includeHistory);
  return typedAll<BrainPatternRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_patterns
    WHERE (pattern LIKE ? OR context LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
      ${eligibility}
      ${clause}
    ORDER BY frequency DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    ...params,
    limit,
  );
}

function likeSearchLearnings(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
  peerId?: string,
  includeGlobal = true,
  includeHistory = false,
): BrainLearningRow[] {
  const likePattern = `%${query}%`;
  const { clause, params } = buildPeerClause('brain_learnings', peerId, includeGlobal);
  const eligibility = memoryEligibilityClause('learnings', 'brain_learnings', includeHistory);
  return typedAll<BrainLearningRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_learnings
    WHERE (insight LIKE ? OR source LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
      ${eligibility}
      ${clause}
    ORDER BY confidence DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    ...params,
    limit,
  );
}

function likeSearchObservations(
  nativeDb: DatabaseSync,
  query: string,
  limit: number,
  peerId?: string,
  includeGlobal = true,
  includeHistory = false,
): BrainObservationRow[] {
  const likePattern = `%${query}%`;
  const { clause, params } = buildPeerClause('brain_observations', peerId, includeGlobal);
  const eligibility = memoryEligibilityClause('observations', 'brain_observations', includeHistory);
  return typedAll<BrainObservationRow>(
    nativeDb.prepare(`
    SELECT * FROM brain_observations
    WHERE (title LIKE ? OR narrative LIKE ?)
      AND (quality_score IS NULL OR quality_score >= ?)
      ${eligibility}
      ${clause}
    ORDER BY created_at DESC
    LIMIT ?
  `),
    likePattern,
    likePattern,
    QUALITY_SCORE_THRESHOLD,
    ...params,
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
export function escapeFts5Query(query: string): string {
  return buildFts5Queries(query).or;
}

/**
 * The two MATCH expressions used by the conjunctive-first retrieval strategy.
 *
 * @task T12073
 */
export interface Fts5QueryPair {
  /** All terms required — high precision, may return nothing. */
  readonly and: string;
  /** Any term matches — high recall, used only as a fallback. */
  readonly or: string;
  /** Number of usable terms extracted from the query. */
  readonly termCount: number;
}

/**
 * Build the AND and OR MATCH expressions for a natural-language query.
 *
 * ## Why both, and why prefixes (T12073)
 *
 * The previous builder emitted `"tok1" OR "tok2"` — quoted terms joined by OR.
 * Measured against the live 6,985-observation corpus, that has two failure
 * modes that together make recall useless for anything but an exact rare token:
 *
 * **Quoted terms are exact, so morphological variants are invisible.** A search
 * for `orphan` matched 113 documents; `orphan*` matched 189. Seventy-six
 * documents saying "orphaned" or "orphans" could not be found by searching for
 * "orphan". SQLite FTS5 has no stemmer on the `unicode61` tokenizer, so a
 * prefix wildcard is the available substitute — and it is a good one, because
 * it costs nothing on a prefix-indexed b-tree.
 *
 * **Pure OR plus BM25 ranks by term rarity, not by term coverage.** A short
 * document matching ONE query term outranks a long one matching ALL of them,
 * because BM25 normalises for length. On this corpus that is catastrophic:
 * 30% of observations are sub-60-character auto-capture stubs, so the
 * shortest, emptiest records win. Searching `nexus_symbols_fts orphan` under
 * the old builder returned *"Consolidated: change observations (5 entries)"*
 * as the top hit — a record with no content at all — while the conjunctive
 * form returns only documents about orphans in nexus.
 *
 * So: require all terms first, and fall back to ANY only when the conjunction
 * finds nothing. That preserves the recall the OR form was introduced for
 * (T553: non-word tokens like em dashes zeroing out an implicit-AND query)
 * without letting it dominate the common case.
 *
 * @param query - the raw user query.
 * @returns AND/OR MATCH expressions and the usable term count.
 *
 * @example
 * ```ts
 * const q = buildFts5Queries('nexus_symbols_fts orphan');
 * // q.and === 'nexus_symbols_fts* AND orphan*'
 * // q.or  === 'nexus_symbols_fts* OR orphan*'
 * ```
 *
 * @task T553
 * @task T12073
 */
export function buildFts5Queries(query: string): Fts5QueryPair {
  const rawTokens = query.trim().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const t of rawTokens) {
    // Strip leading/trailing non-word characters (e.g. "EPIC:" → "EPIC", "—" → "")
    const stripped = t.replace(/^\W+|\W+$/g, '');
    if (stripped.length < 2) continue; // skip very short or empty tokens
    if (!/\w/.test(stripped)) continue; // skip tokens with no word chars
    const lower = stripped.toLowerCase();
    if (seen.has(lower)) continue; // deduplicate
    seen.add(lower);

    // Quote to neutralise FTS5 syntax characters, then append the prefix
    // operator OUTSIDE the quotes — `"foo"*` is the documented way to combine
    // a quoted string with a prefix match.
    terms.push(`"${stripped.replace(/"/g, '""')}"*`);
  }

  if (terms.length === 0) return { and: '""', or: '""', termCount: 0 };
  return { and: terms.join(' AND '), or: terms.join(' OR '), termCount: terms.length };
}

/**
 * Run an FTS5-backed query conjunctively, falling back to disjunctive.
 *
 * Single-term queries skip the fallback entirely (AND and OR are identical).
 *
 * @param run - executes one MATCH expression and returns its rows.
 * @param queries - the pair from {@link buildFts5Queries}.
 * @returns conjunctive rows when non-empty, else disjunctive rows.
 *
 * @task T12073
 */
export function matchConjunctiveFirst<T>(
  run: (matchExpr: string) => T[],
  queries: Fts5QueryPair,
): T[] {
  const conjunctive = run(queries.and);
  if (conjunctive.length > 0 || queries.termCount < 2) return conjunctive;
  return run(queries.or);
}

/**
 * Reset the cached FTS5 availability flag and the initialized-path marker.
 * Used in tests to force re-detection and a rebuild on the next search.
 *
 * @task T12101 — also clears the per-path rebuild marker (was a
 * process-wide boolean before T12101).
 */
export function resetFts5Cache(): void {
  _fts5Available = null;
  _fts5RebuiltForPath = null;
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

/**
 * Round-robin interleave several independently-ranked lists.
 *
 * Takes rank 1 from every list, then rank 2 from every list, and so on, so a
 * downstream consumer that scores by array position does not systematically
 * favour whichever list happened to be concatenated first.
 *
 * @param lists - per-source lists, each already ordered best-first.
 * @returns a single list preserving each source's internal order.
 *
 * @example
 * ```ts
 * interleaveRanked([['a1', 'a2'], ['b1'], ['c1', 'c2', 'c3']]);
 * // ['a1', 'b1', 'c1', 'a2', 'c2', 'c3']
 * ```
 *
 * @task T12073
 */
export function interleaveRanked<T>(lists: ReadonlyArray<readonly T[]>): T[] {
  const out: T[] = [];
  const longest = lists.reduce((max, l) => Math.max(max, l.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
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
    searchBrain(projectRoot, query, { limit: maxResults * 3 }),
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
  const ftsResults = allResults[0] as BrainMemorySearchResult;
  const vecResults = allResults[1] as SimilarityResult[];
  const codeResults = (includeCode ? (allResults[2] ?? []) : []) as Array<{
    id: string;
    title: string;
    kind: string;
    score: number;
  }>;

  // --- 2. Project FTS results into ranked RrfHit list ---
  //
  // T12073: INTERLEAVE the four tables instead of concatenating them.
  //
  // RRF scores a hit by its POSITION in this array. Concatenating
  // decisions → patterns → learnings → observations therefore encoded a fixed
  // precedence that has nothing to do with relevance: every decision outranked
  // every observation, always. With 128 decisions and 6,985 observations, the
  // largest and most recent store was structurally the least reachable —
  // `cleo memory find "caamp marker"` returned unrelated learnings while the
  // ONE observation matching both terms (verified by direct MATCH) never
  // placed.
  //
  // Each table is already BM25-ordered internally. Round-robin interleaving
  // preserves that intra-table ordering while removing the inter-table bias,
  // and avoids comparing BM25 scores across separate indexes — which is not
  // meaningful, since each has its own corpus statistics.
  const ftsRanked: RrfHit[][] = [
    ftsResults.decisions.map((d) => ({
      id: d.id,
      type: 'decision' as const,
      title: d.decision,
      text: `${d.decision} — ${d.rationale}`,
    })),
    ftsResults.patterns.map((p) => ({
      id: p.id,
      type: 'pattern' as const,
      title: p.pattern,
      text: `${p.pattern} — ${p.context}`,
    })),
    ftsResults.learnings.map((l) => ({
      id: l.id,
      type: 'learning' as const,
      title: l.insight,
      text: `${l.insight} (source: ${l.source})`,
    })),
    ftsResults.observations.map((o) => ({
      id: o.id,
      type: 'observation' as const,
      title: o.title,
      text: o.narrative ?? o.title,
    })),
  ];
  const ftsHits: RrfHit[] = interleaveRanked(ftsRanked);

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
          id: neighbor.id.startsWith(`${neighbor.nodeType}:`)
            ? neighbor.id.slice(neighbor.nodeType.length + 1)
            : neighbor.id,
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

  const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb(projectRoot);
  if (!nativeDb) throw new Error('BRAIN database unavailable while checking retrieval eligibility');
  const eligible = fused.filter((hit) => {
    const table =
      hit.type === 'decision'
        ? 'decisions'
        : hit.type === 'pattern'
          ? 'patterns'
          : hit.type === 'learning'
            ? 'learnings'
            : hit.type === 'observation'
              ? 'observations'
              : undefined;
    if (!table) return true;
    return (
      nativeDb
        .prepare(`SELECT id FROM main.brain_${table} WHERE id = ?${memoryEligibilityClause(table)}`)
        .get(hit.id) !== undefined
    );
  });

  return eligible.slice(0, maxResults).map((r) => ({
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
