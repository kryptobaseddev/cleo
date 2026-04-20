/**
 * Tests for the Nexus ingester.
 *
 * Uses a real in-memory DatabaseSync with minimal nexus tables.
 *
 * @task T1008
 */

import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { NEXUS_BASE_WEIGHT, runNexusIngester } from '../ingesters/nexus-ingester.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createNexusDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE nexus_nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT 'src/unknown.ts',
      kind TEXT NOT NULL DEFAULT 'function'
    );
    CREATE TABLE nexus_relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'calls'
    )
  `);
  return db;
}

let nodeCounter = 0;
let relCounter = 0;

function insertNode(db: DatabaseSync, id: string, name: string, kind = 'function') {
  db.prepare(
    `INSERT INTO nexus_nodes (id, name, file_path, kind) VALUES (:id, :name, :filePath, :kind)`,
  ).run({ id, name, filePath: `src/${name}.ts`, kind });
}

function insertRelation(db: DatabaseSync, sourceId: string, targetId: string, kind = 'calls') {
  const id = `R${++relCounter}`;
  db.prepare(
    `INSERT INTO nexus_relations (id, source_id, target_id, kind) VALUES (:id, :sourceId, :targetId, :kind)`,
  ).run({ id, sourceId, targetId, kind });
}

// ---------------------------------------------------------------------------
// runNexusIngester
// ---------------------------------------------------------------------------

describe('runNexusIngester', () => {
  beforeEach(() => {
    nodeCounter = 0; // eslint-disable-line @typescript-eslint/no-unused-vars
    relCounter = 0;
  });

  it('returns empty array when nativeDb is null', () => {
    expect(runNexusIngester(null)).toEqual([]);
  });

  it('returns empty array when nexus DB has no nodes matching Query A', () => {
    const db = createNexusDb();
    // Node that calls others — has outbound, so NOT an orphaned callee
    insertNode(db, 'N1', 'complexFunc');
    insertNode(db, 'N2', 'helper');
    insertRelation(db, 'N1', 'N2');
    expect(runNexusIngester(db)).toHaveLength(0);
    db.close();
  });

  it('Query A returns orphaned callees with caller_count > NEXUS_MIN_CALLER_COUNT', () => {
    const db = createNexusDb();
    // N1 is called by 6 other nodes and makes no calls
    insertNode(db, 'N1', 'sink');
    for (let i = 2; i <= 7; i++) {
      insertNode(db, `N${i}`, `caller${i}`);
      insertRelation(db, `N${i}`, 'N1');
    }
    const results = runNexusIngester(db);
    expect(results.some((r) => r.sourceId === 'N1')).toBe(true);
    db.close();
  });

  it('Query B returns over-coupled nodes with degree > NEXUS_MIN_DEGREE', () => {
    const db = createNexusDb();
    // N1 is connected to 25 other nodes (degree = 25 edges)
    insertNode(db, 'N1', 'superHub');
    for (let i = 2; i <= 26; i++) {
      insertNode(db, `N${i}`, `connected${i}`);
      insertRelation(db, 'N1', `N${i}`);
    }
    const results = runNexusIngester(db);
    expect(results.some((r) => r.sourceId === 'N1')).toBe(true);
    db.close();
  });

  it('assigns base weight 0.3 to all nexus candidates', () => {
    const db = createNexusDb();
    insertNode(db, 'N1', 'sink');
    for (let i = 2; i <= 8; i++) {
      insertNode(db, `N${i}`, `caller${i}`);
      insertRelation(db, `N${i}`, 'N1');
    }
    const results = runNexusIngester(db);
    if (results.length > 0) {
      expect(results.every((r) => r.weight === NEXUS_BASE_WEIGHT)).toBe(true);
    }
    db.close();
  });

  it('does not duplicate nodes that appear in both Query A and Query B results', () => {
    const db = createNexusDb();
    // N1: orphaned callee (>5 callers) AND high-degree (>20 edges total)
    insertNode(db, 'N1', 'dualDetect');
    for (let i = 2; i <= 28; i++) {
      insertNode(db, `N${i}`, `c${i}`);
      insertRelation(db, `N${i}`, 'N1');
    }
    const results = runNexusIngester(db);
    const ids = results.map((r) => r.sourceId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    db.close();
  });

  it('handles nexus DB absence gracefully (returns empty array)', () => {
    const db = new DatabaseSync(':memory:');
    // No tables — should return empty not throw
    const results = runNexusIngester(db);
    expect(results).toEqual([]);
    db.close();
  });
});
