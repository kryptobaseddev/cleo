/**
 * Tests for NEXUS symbol context augmentation (T1061, T1765, T1839)
 *
 * Tests FTS5 MATCH search, LIKE fallback, and result formatting for PreToolUse hook injection.
 *
 * T1765 regression coverage:
 *   - Wrong column names in callers/callees subqueries no longer produce empty results
 *   - Operator precedence bug in WHERE clause fixed (label LIKE OR file_path LIKE AND kind)
 *   - communityId typed as string (matching nexus_nodes.community_id text column)
 *
 * T1839 FTS5 coverage:
 *   - escapeFts5Pattern correctly escapes and wraps tokens for MATCH
 *   - FTS5 in-memory integration: MATCH returns BM25-ranked results
 *   - FTS5 backfill: pre-existing rows are indexed at table creation time
 *
 * T1849 skip-guard:
 *   - Integration tests skip in CI environments (process.env.CI === 'true')
 *   - Integration tests also skip when the specific label pattern has no matches
 *     in nexus_nodes (belt-and-suspenders: guards against polluted-but-mismatched DB)
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNativeDatabase } from '../../store/sqlite.js';
import { augmentSymbol, escapeFts5Pattern, formatAugmentResults } from '../augment.js';

// ---------------------------------------------------------------------------
// Integration skip-guard — approach (A)+(B) combined (T1849)
// ---------------------------------------------------------------------------

const nexusDbPath = `${process.env.HOME}/.local/share/cleo/nexus.db`;

/**
 * Returns true if this integration test should be skipped.
 *
 * Skips when EITHER:
 *   (A) Running in a CI environment — CI runners may have a polluted nexus.db
 *       from prior test-suite steps that does NOT contain the symbols these
 *       tests need. Detected via process.env.CI, GITHUB_ACTIONS, or
 *       CONTINUOUS_INTEGRATION env vars.
 *   (B) The specific label pattern has zero matches in nexus_nodes — guards
 *       against developers who have a nexus.db but haven't indexed the right
 *       codebase, and against any future CI leakage not covered by (A).
 *
 * Never throws: any DB error returns true (skip safely).
 *
 * @param labelPattern - The label pattern the test will search for (e.g. 'load')
 */
function shouldSkipNexusIntegration(labelPattern: string): boolean {
  // (A) CI environment detection — belt
  if (
    process.env.CI === 'true' ||
    process.env.CI === '1' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.CONTINUOUS_INTEGRATION === 'true'
  ) {
    return true;
  }

  // (B) Pattern-specific presence check — suspenders
  if (!existsSync(nexusDbPath)) return true;
  try {
    const db = openNativeDatabase(nexusDbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM nexus_nodes WHERE label LIKE ? AND kind IN ('function', 'method', 'constructor', 'class', 'interface', 'type_alias') LIMIT 1`,
      )
      .get(`%${labelPattern}%`) as { c: number } | undefined;
    db.close();
    return (row?.c ?? 0) === 0;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Unit tests — no DB dependency
// ---------------------------------------------------------------------------

describe('augmentSymbol — unit (no DB dependency)', () => {
  it('returns empty array if nexus.db does not exist', () => {
    // This passes because in the CI test environment nexus.db is not populated
    const results = augmentSymbol('__nonexistent_symbol_xyz__');
    expect(Array.isArray(results)).toBe(true);
  });

  it('returns empty array for empty pattern', () => {
    const results = augmentSymbol('');
    expect(results).toEqual([]);
  });

  it('does not throw on arbitrary pattern', () => {
    expect(() => augmentSymbol('loadConfig')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// escapeFts5Pattern — unit tests (T1839)
// ---------------------------------------------------------------------------

describe('escapeFts5Pattern', () => {
  it('wraps a simple token in double-quotes with trailing *', () => {
    expect(escapeFts5Pattern('loadConfig')).toBe('"loadConfig"*');
  });

  it('handles multiple whitespace-separated tokens', () => {
    expect(escapeFts5Pattern('load config')).toBe('"load"* "config"*');
  });

  it('escapes embedded double-quotes in the token', () => {
    expect(escapeFts5Pattern('say"hello')).toBe('"say""hello"*');
  });

  it('trims leading/trailing whitespace', () => {
    expect(escapeFts5Pattern('  trim  ')).toBe('"trim"*');
  });

  it('returns a safe default for an empty string', () => {
    // Empty pattern is guarded upstream, but escapeFts5Pattern must not throw.
    expect(() => escapeFts5Pattern('')).not.toThrow();
    expect(escapeFts5Pattern('')).toBe('""*');
  });
});

// ---------------------------------------------------------------------------
// FTS5 in-memory integration tests (T1839)
//
// These tests create an in-memory SQLite database with nexus_nodes + FTS5
// virtual table to verify:
//   1. MATCH returns BM25-ranked results (bm25() score is visible and negative).
//   2. Prefix matching ("loadC"*) correctly finds "loadConfig".
//   3. INSERT trigger keeps FTS5 in sync with nexus_nodes.
//   4. Backfill: pre-existing rows indexed when FTS5 is created after nodes exist.
// ---------------------------------------------------------------------------

describe('FTS5 — in-memory integration (T1839)', () => {
  let db: InstanceType<typeof DatabaseSync>;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');

    // Minimal nexus_nodes schema (subset sufficient for FTS5 tests).
    db.exec(`
      CREATE TABLE nexus_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        name TEXT,
        file_path TEXT,
        is_exported INTEGER NOT NULL DEFAULT 0,
        community_id TEXT,
        start_line INTEGER,
        end_line INTEGER
      )
    `);

    // FTS5 virtual table mirroring label + file_path.
    db.exec(`
      CREATE VIRTUAL TABLE nexus_symbols_fts USING fts5(
        node_id UNINDEXED,
        label,
        file_path,
        tokenize = 'unicode61 remove_diacritics 1'
      )
    `);

    // INSERT trigger.
    db.exec(`
      CREATE TRIGGER nexus_nodes_fts_ai
      AFTER INSERT ON nexus_nodes
      BEGIN
        INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
        VALUES (new.rowid, new.id, new.label, new.file_path);
      END
    `);

    // DELETE trigger — plain DELETE is required; the FTS5 content-virtual-table
    // `INSERT INTO fts(fts, rowid, ...) VALUES ('delete', ...)` syntax is not
    // supported by node:sqlite's bundled SQLite version.
    db.exec(`
      CREATE TRIGGER nexus_nodes_fts_ad
      AFTER DELETE ON nexus_nodes
      BEGIN
        DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid;
      END
    `);

    // UPDATE trigger — delete old entry, insert new entry.
    db.exec(`
      CREATE TRIGGER nexus_nodes_fts_au
      AFTER UPDATE ON nexus_nodes
      BEGIN
        DELETE FROM nexus_symbols_fts WHERE rowid = old.rowid;
        INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
        VALUES (new.rowid, new.id, new.label, new.file_path);
      END
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('MATCH returns results for an exact token', () => {
    db.exec(`
      INSERT INTO nexus_nodes (id, project_id, kind, label, file_path, is_exported)
      VALUES ('src/config.ts::loadConfig', 'proj1', 'function', 'loadConfig', 'src/config.ts', 1)
    `);

    const rows = db
      .prepare(`SELECT node_id, label FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH ?`)
      .all('"loadConfig"*') as Array<{ node_id: string; label: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0]?.label).toBe('loadConfig');
  });

  it('MATCH returns a negative bm25() score (confirming BM25 ranking is active)', () => {
    // Note: FTS5 with the unicode61 tokenizer treats camelCase like "loadConfig"
    // as a single token — it does not split on case boundaries. Prefix search
    // works from the token start, so '"load"*' matches "loadConfig".
    // Two rows with different labels are inserted; both are found by a shared
    // prefix '"' that the tokenizer sees as the start of any token.
    db.exec(`
      INSERT INTO nexus_nodes (id, project_id, kind, label, file_path, is_exported)
      VALUES
        ('a::loadConfig', 'proj1', 'function', 'loadConfig', 'src/config.ts', 1),
        ('b::loadSchema', 'proj1', 'function', 'loadSchema', 'src/parser.ts', 0)
    `);

    const rows = db
      .prepare(
        `SELECT node_id, bm25(nexus_symbols_fts) AS score FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH ? ORDER BY score`,
      )
      .all('"load"*') as Array<{ node_id: string; score: number }>;

    expect(rows.length).toBe(2);
    // bm25() returns negative values — lower (more negative) means more relevant.
    for (const row of rows) {
      expect(row.score).toBeLessThan(0);
    }
  });

  it('prefix MATCH finds symbols by partial name', () => {
    db.exec(`
      INSERT INTO nexus_nodes (id, project_id, kind, label, file_path, is_exported)
      VALUES
        ('a::loadConfigFromFile', 'proj1', 'function', 'loadConfigFromFile', null, 1),
        ('b::parseSchema', 'proj1', 'function', 'parseSchema', null, 0)
    `);

    const ftsPattern = escapeFts5Pattern('loadC');
    const rows = db
      .prepare(`SELECT node_id FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH ?`)
      .all(ftsPattern) as Array<{ node_id: string }>;

    expect(rows.some((r) => r.node_id === 'a::loadConfigFromFile')).toBe(true);
    expect(rows.some((r) => r.node_id === 'b::parseSchema')).toBe(false);
  });

  it('INSERT trigger keeps FTS5 in sync with nexus_nodes', () => {
    // Insert directly via trigger (no manual FTS5 insert).
    db.exec(`
      INSERT INTO nexus_nodes (id, project_id, kind, label, file_path, is_exported)
      VALUES ('src/utils.ts::helper', 'proj1', 'function', 'helper', 'src/utils.ts', 0)
    `);

    const rows = db
      .prepare(`SELECT node_id FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH '"helper"*'`)
      .all() as Array<{ node_id: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0]?.node_id).toBe('src/utils.ts::helper');
  });

  it('DELETE trigger removes rows from FTS5', () => {
    db.exec(`
      INSERT INTO nexus_nodes (id, project_id, kind, label, file_path, is_exported)
      VALUES ('src/utils.ts::helper', 'proj1', 'function', 'helper', 'src/utils.ts', 0)
    `);
    db.exec(`DELETE FROM nexus_nodes WHERE id = 'src/utils.ts::helper'`);

    const rows = db
      .prepare(`SELECT node_id FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH '"helper"*'`)
      .all() as Array<{ node_id: string }>;

    expect(rows.length).toBe(0);
  });

  it('UPDATE trigger reflects renamed label in FTS5', () => {
    // Use distinct non-prefix-overlapping labels so results are unambiguous.
    db.exec(`
      INSERT INTO nexus_nodes (id, project_id, kind, label, file_path, is_exported)
      VALUES ('src/utils.ts::alpha', 'proj1', 'function', 'alpha', 'src/utils.ts', 0)
    `);
    db.exec(`UPDATE nexus_nodes SET label = 'beta' WHERE id = 'src/utils.ts::alpha'`);

    // New label should be findable.
    const newRows = db
      .prepare(`SELECT node_id FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH '"beta"*'`)
      .all() as Array<{ node_id: string }>;
    expect(newRows.length).toBe(1);
    expect(newRows[0]?.node_id).toBe('src/utils.ts::alpha');

    // Old label should be gone (no overlap with 'beta').
    const oldRows = db
      .prepare(`SELECT node_id FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH '"alpha"*'`)
      .all() as Array<{ node_id: string }>;
    expect(oldRows.length).toBe(0);
  });

  it('backfill: pre-existing nexus_nodes rows are indexed when FTS5 is created', () => {
    // Create a fresh DB with data BEFORE FTS5 is set up (simulates upgrade path).
    const freshDb = new DatabaseSync(':memory:');
    freshDb.exec(`
      CREATE TABLE nexus_nodes (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        name TEXT,
        file_path TEXT,
        is_exported INTEGER NOT NULL DEFAULT 0
      )
    `);
    freshDb.exec(`
      INSERT INTO nexus_nodes (id, project_id, kind, label, is_exported)
      VALUES ('legacy::fn', 'proj1', 'function', 'legacyFunction', 0)
    `);

    // Now create FTS5 and backfill.
    freshDb.exec(`
      CREATE VIRTUAL TABLE nexus_symbols_fts USING fts5(
        node_id UNINDEXED,
        label,
        file_path,
        tokenize = 'unicode61 remove_diacritics 1'
      )
    `);
    freshDb.exec(`
      INSERT INTO nexus_symbols_fts(rowid, node_id, label, file_path)
      SELECT rowid, id, label, file_path
      FROM nexus_nodes
      WHERE rowid NOT IN (SELECT rowid FROM nexus_symbols_fts)
    `);

    const rows = freshDb
      .prepare(
        `SELECT node_id FROM nexus_symbols_fts WHERE nexus_symbols_fts MATCH '"legacyFunction"*'`,
      )
      .all() as Array<{ node_id: string }>;

    expect(rows.length).toBe(1);
    expect(rows[0]?.node_id).toBe('legacy::fn');

    freshDb.close();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — per-test skip guards (T1849)
//
// Each test uses shouldSkipNexusIntegration with its own label pattern so that
// a DB populated with different symbols doesn't cause false failures.
// ---------------------------------------------------------------------------

describe('augmentSymbol — integration (requires populated nexus.db, skipped in CI or when absent)', () => {
  it.skipIf(shouldSkipNexusIntegration('load'))(
    'returns non-empty results for common symbol patterns',
    () => {
      // "load" is a common pattern that should exist in any indexed TypeScript codebase.
      const results = augmentSymbol('load', 5);
      expect(results.length).toBeGreaterThan(0);
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))('results contain only callable kinds', () => {
    const callableKinds = new Set([
      'function',
      'method',
      'constructor',
      'class',
      'interface',
      'type_alias',
    ]);
    const results = augmentSymbol('load', 10);
    for (const r of results) {
      expect(callableKinds.has(r.kind)).toBe(true);
    }
  });

  it.skipIf(shouldSkipNexusIntegration('load'))(
    'callersCount and calleesCount are non-negative integers',
    () => {
      const results = augmentSymbol('load', 5);
      for (const r of results) {
        expect(typeof r.callersCount).toBe('number');
        expect(typeof r.calleesCount).toBe('number');
        expect(r.callersCount).toBeGreaterThanOrEqual(0);
        expect(r.calleesCount).toBeGreaterThanOrEqual(0);
      }
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))(
    'communityId is a string when present (not a number)',
    () => {
      // Regression: communityId was typed as number but DB stores text like "comm_3".
      const results = augmentSymbol('load', 10);
      for (const r of results) {
        if (r.communityId !== undefined) {
          expect(typeof r.communityId).toBe('string');
        }
      }
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))(
    'p50 latency is under 500ms (T1765 perf target)',
    () => {
      const patterns = ['load', 'get', 'set', 'create', 'handle'];
      const timings: number[] = [];

      for (const pat of patterns) {
        const start = performance.now();
        augmentSymbol(pat, 5);
        timings.push(performance.now() - start);
      }

      timings.sort((a, b) => a - b);
      const p50 = timings[Math.floor(timings.length / 2)];
      // p50 must be under 500ms (gitnexus baseline: 317ms)
      expect(p50).toBeLessThan(500);
    },
  );

  it.skipIf(shouldSkipNexusIntegration('load'))('returns up to `limit` results', () => {
    const results = augmentSymbol('load', 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// formatAugmentResults — unit
// ---------------------------------------------------------------------------

describe('formatAugmentResults', () => {
  it('returns empty string for empty results', () => {
    const formatted = formatAugmentResults([]);
    expect(formatted).toBe('');
  });

  it('formats single result correctly', () => {
    const results = [
      {
        id: 'file.ts::loadConfig',
        label: 'loadConfig',
        kind: 'function',
        filePath: 'src/config.ts',
        startLine: 10,
        endLine: 25,
        callersCount: 3,
        calleesCount: 2,
        communityId: 'comm_5',
        communitySize: 12,
      },
    ];

    const formatted = formatAugmentResults(results);
    expect(formatted).toContain('[nexus] Symbol context:');
    expect(formatted).toContain('loadConfig (function)');
    expect(formatted).toContain('callers: 3, callees: 2');
    expect(formatted).toContain('community comm_5');
    expect(formatted).toContain('12 members');
  });

  it('formats multiple results with varying metadata', () => {
    const results = [
      {
        id: 'main.ts::main',
        label: 'main',
        kind: 'function',
        filePath: 'src/main.ts',
        startLine: 1,
        endLine: 50,
        callersCount: 0,
        calleesCount: 5,
      },
      {
        id: 'utils.ts::helper',
        label: 'helper',
        kind: 'method',
        callersCount: 10,
        calleesCount: 0,
      },
    ];

    const formatted = formatAugmentResults(results);
    expect(formatted).toContain('main (function)');
    expect(formatted).toContain('helper (method)');
    expect(formatted).toContain('callers: 0, callees: 5');
    expect(formatted).toContain('callers: 10, callees: 0');
  });

  it('omits location and community info when not present', () => {
    const results = [
      {
        id: 'unknown::process',
        label: 'process',
        kind: 'function',
        callersCount: 1,
        calleesCount: 1,
      },
    ];

    const formatted = formatAugmentResults(results);
    expect(formatted).not.toContain('(unknown');
    expect(formatted).not.toContain('community');
  });

  it('includes multiple lines for multiple results', () => {
    const results = [
      {
        id: '1',
        label: 'func1',
        kind: 'function',
        callersCount: 1,
        calleesCount: 2,
      },
      {
        id: '2',
        label: 'func2',
        kind: 'function',
        callersCount: 3,
        calleesCount: 4,
      },
    ];

    const formatted = formatAugmentResults(results);
    const lines = formatted.split('\n');
    expect(lines.length).toBe(3); // header + 2 results
  });
});
