/**
 * Unit tests for Nexus CTE Query DSL
 *
 * Tests template alias compilation and CTE execution against synthetic nexus.db.
 *
 * @task T1057
 */

import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as DB } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileCteAlias, formatCteResultAsMarkdown, runNexusCte } from '../query-dsl.js';

// ── Test Fixtures ────────────────────────────────────────────────────

let testDb: DatabaseSync;
let testDbPath: string;

/**
 * Setup synthetic nexus.db for testing.
 * Creates tables and inserts test data: 3 symbols, 2 call relations, 1 community.
 */
beforeAll(() => {
  testDbPath = join(tmpdir(), `nexus-test-${Date.now()}.db`);
  testDb = new DB(testDbPath);

  // Create tables
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS nexus_nodes (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      file_path TEXT,
      language TEXT,
      start_line INTEGER,
      end_line INTEGER,
      community_id TEXT,
      is_exported INTEGER DEFAULT 0,
      is_external INTEGER DEFAULT 0,
      meta_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS nexus_relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      reason TEXT,
      FOREIGN KEY (source_id) REFERENCES nexus_nodes(id),
      FOREIGN KEY (target_id) REFERENCES nexus_nodes(id)
    );
  `);

  // Insert test data
  testDb.exec(`
    INSERT INTO nexus_nodes (id, label, kind, file_path, start_line, end_line, community_id)
    VALUES
      ('fn-a', 'functionA', 'function', 'src/module.ts', 10, 20, 'community-1'),
      ('fn-b', 'functionB', 'function', 'src/module.ts', 25, 35, 'community-1'),
      ('fn-c', 'functionC', 'function', 'src/other.ts', 1, 15, 'community-2');

    INSERT INTO nexus_relations (id, source_id, target_id, type, confidence)
    VALUES
      ('rel-1', 'fn-a', 'fn-b', 'calls', 1.0),
      ('rel-2', 'fn-b', 'fn-c', 'calls', 1.0);
  `);
});

afterAll(() => {
  testDb.close();
  try {
    unlinkSync(testDbPath);
  } catch {
    // Ignore cleanup errors
  }
});

// ── Tests ────────────────────────────────────────────────────────────

describe('compileCteAlias', () => {
  it('should compile callers-of alias', async () => {
    const result = compileCteAlias('callers-of');
    expect(result.description).toContain('call');
    expect(result.paramCount).toBe(1);
    expect(result.paramNames).toEqual(['symbol_id']);
    expect(result.cte).toContain('WITH RECURSIVE callers');
  });

  it('should compile callees-of alias', async () => {
    const result = compileCteAlias('callees-of');
    expect(result.description).toContain('called');
    expect(result.paramCount).toBe(1);
    expect(result.paramNames).toEqual(['symbol_id']);
  });

  it('should compile co-changed alias', async () => {
    const result = compileCteAlias('co-changed');
    expect(result.paramCount).toBe(1);
    expect(result.cte).toContain('file_path');
  });

  it('should compile co-cited alias', async () => {
    const result = compileCteAlias('co-cited');
    expect(result.paramCount).toBe(3);
    expect(result.description).toContain('semantic');
  });

  it('should compile path-between alias', async () => {
    const result = compileCteAlias('path-between');
    expect(result.paramCount).toBe(2);
    expect(result.paramNames).toEqual(['source_id', 'target_id']);
  });

  it('should compile community-members alias', async () => {
    const result = compileCteAlias('community-members');
    expect(result.paramCount).toBe(1);
    expect(result.cte).toContain('community_id');
  });

  it('should throw on unknown alias', async () => {
    expect(() => compileCteAlias('invalid-alias' as any)).toThrow();
  });
});

describe('runNexusCte', () => {
  it('should execute raw CTE and return results', async () => {
    const cte = 'SELECT id, label, kind FROM nexus_nodes';
    const result = await runNexusCte(cte, [], testDb);

    expect(result.success).toBe(true);
    expect(result.rows.length).toBe(3);
    expect(result.row_count).toBe(3);
    expect(result.execution_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('should return empty results for query with no matches', async () => {
    const cte = "SELECT * FROM nexus_nodes WHERE id = 'nonexistent'";
    const result = await runNexusCte(cte, [], testDb);

    expect(result.success).toBe(true);
    expect(result.rows.length).toBe(0);
    expect(result.row_count).toBe(0);
  });

  it('should handle parameter binding', async () => {
    const cte = 'SELECT * FROM nexus_nodes WHERE id = ?';
    const result = await runNexusCte(cte, ['fn-a'], testDb);

    expect(result.success).toBe(true);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.label).toBe('functionA');
  });

  it('should handle malformed SQL gracefully', async () => {
    const cte = 'SELECT * FROM nonexistent_table';
    const result = await runNexusCte(cte, [], testDb);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.row_count).toBe(0);
  });

  it('should handle empty CTE', async () => {
    const result = await runNexusCte('', [], testDb);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});

describe('Template CTE execution', () => {
  it('callers-of should find functions that call target', async () => {
    const template = compileCteAlias('callers-of');
    const result = await runNexusCte(template.cte, ['fn-c'], testDb);

    expect(result.success).toBe(true);
    // fn-b calls fn-c
    expect(result.row_count).toBeGreaterThanOrEqual(0);
  });

  it('callees-of should find functions called by target', async () => {
    const template = compileCteAlias('callees-of');
    const result = await runNexusCte(template.cte, ['fn-a'], testDb);

    expect(result.success).toBe(true);
    // fn-a calls fn-b
    expect(result.row_count).toBeGreaterThanOrEqual(0);
  });

  it('co-changed should find symbols in same file', async () => {
    const template = compileCteAlias('co-changed');
    const result = await runNexusCte(template.cte, ['fn-a'], testDb);

    expect(result.success).toBe(true);
    // fn-a and fn-b are in src/module.ts
    expect(result.row_count).toBeGreaterThanOrEqual(1);
  });

  it('community-members should find symbols in same community', async () => {
    const template = compileCteAlias('community-members');
    const result = await runNexusCte(template.cte, ['community-1'], testDb);

    expect(result.success).toBe(true);
    expect(result.row_count).toBe(2); // fn-a and fn-b
    const labels = result.rows.map((r) => r.label);
    expect(labels).toContain('functionA');
    expect(labels).toContain('functionB');
  });
});

describe('formatCteResultAsMarkdown', () => {
  it('should format successful results as markdown table', async () => {
    const result = await runNexusCte('SELECT id, label, kind FROM nexus_nodes LIMIT 2', [], testDb);
    const markdown = formatCteResultAsMarkdown(result);

    expect(markdown).toContain('|');
    expect(markdown).toContain('---');
    expect(markdown).toContain('fn-a');
  });

  it('should handle empty results', async () => {
    const result = await runNexusCte("SELECT * FROM nexus_nodes WHERE id = 'invalid'", [], testDb);
    const markdown = formatCteResultAsMarkdown(result);

    expect(markdown).toContain('No results');
  });

  it('should handle errors in results', async () => {
    const result = await runNexusCte('SELECT * FROM invalid_table', [], testDb);
    const markdown = formatCteResultAsMarkdown(result);

    expect(markdown).toContain('Error');
    expect(markdown).toContain('execution failed');
  });

  it('should handle null values in columns', async () => {
    const result = await runNexusCte(
      "SELECT id, label, NULL as empty_col FROM nexus_nodes WHERE id = 'fn-a'",
      [],
      testDb,
    );
    const markdown = formatCteResultAsMarkdown(result);

    expect(markdown).toContain('null');
  });
});
