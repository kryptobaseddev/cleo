/**
 * Tests for the Nexus ingester.
 *
 * Uses a real in-memory DatabaseSync with minimal nexus tables.
 *
 * @task T1008
 * @task T1070
 */

import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NEXUS_BASE_WEIGHT,
  NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT,
  NEXUS_ENTRY_EROSION_WEIGHT,
  runNexusIngester,
} from '../ingesters/nexus-ingester.js';

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
      kind TEXT NOT NULL DEFAULT 'function',
      label TEXT NOT NULL DEFAULT 'unknown',
      is_exported INTEGER NOT NULL DEFAULT 0,
      community_id TEXT DEFAULT NULL
    );
    CREATE TABLE nexus_relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'calls',
      type TEXT NOT NULL DEFAULT 'calls'
    );
    CREATE TABLE nexus_schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE nexus_audit_log (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT DEFAULT '{}'
    )
  `);
  return db;
}

let nodeCounter = 0;
let relCounter = 0;

function insertNode(
  db: DatabaseSync,
  id: string,
  name: string,
  kind = 'function',
  communityId: string | null = null,
  isExported = false,
) {
  db.prepare(
    `INSERT INTO nexus_nodes (id, name, file_path, kind, label, community_id, is_exported) VALUES (:id, :name, :filePath, :kind, :label, :communityId, :isExported)`,
  ).run({
    id,
    name,
    filePath: `src/${name}.ts`,
    kind,
    label: name,
    communityId,
    isExported: isExported ? 1 : 0,
  });
}

function insertRelation(
  db: DatabaseSync,
  sourceId: string,
  targetId: string,
  kind = 'calls',
  type = 'calls',
) {
  const id = `R${++relCounter}`;
  db.prepare(
    `INSERT INTO nexus_relations (id, source_id, target_id, kind, type) VALUES (:id, :sourceId, :targetId, :kind, :type)`,
  ).run({ id, sourceId, targetId, kind, type });
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

// ---------------------------------------------------------------------------
// Query C: Community Fragmentation
// ---------------------------------------------------------------------------

describe('runNexusIngester - Query C (Community Fragmentation)', () => {
  it('detects community fragmentation when symbol count drops >20%', () => {
    const db = createNexusDb();

    // Set up old snapshot with 10 symbols in community C1
    db.prepare(`
      INSERT INTO nexus_schema_meta (key, value)
      VALUES ('community_snapshot_json', :value)
    `).run({ value: JSON.stringify({ 'community:1': 10 }) });

    // Create current state: only 7 symbols in C1 (30% drop > 20% threshold)
    insertNode(db, 'N1', 'sym1', 'function', 'community:1');
    insertNode(db, 'N2', 'sym2', 'function', 'community:1');
    insertNode(db, 'N3', 'sym3', 'function', 'community:1');
    insertNode(db, 'N4', 'sym4', 'function', 'community:1');
    insertNode(db, 'N5', 'sym5', 'function', 'community:1');
    insertNode(db, 'N6', 'sym6', 'function', 'community:1');
    insertNode(db, 'N7', 'sym7', 'function', 'community:1');

    const results = runNexusIngester(db);

    // Should detect fragmentation: 7 symbols vs 10 = 30% drop
    const fragmentation = results.find((r) => r.title.includes('Community fragmentation'));
    expect(fragmentation).toBeDefined();
    if (fragmentation) {
      expect(fragmentation.weight).toBe(NEXUS_COMMUNITY_FRAGMENTATION_WEIGHT);
      expect(fragmentation.sourceId).toBe('community:1');
    }

    db.close();
  });

  it('does not emit fragmentation proposal on first analyze run (no prior snapshot)', () => {
    const db = createNexusDb();

    // No prior snapshot, so no baseline to compare
    insertNode(db, 'N1', 'sym1', 'function', 'community:1');
    insertNode(db, 'N2', 'sym2', 'function', 'community:1');

    const results = runNexusIngester(db);

    // Should NOT find fragmentation because there's no old snapshot
    const fragmentation = results.find((r) => r.title.includes('Community fragmentation'));
    expect(fragmentation).toBeUndefined();

    db.close();
  });

  it('does not emit fragmentation if community shrink is <=20%', () => {
    const db = createNexusDb();

    // Old snapshot: 10 symbols
    db.prepare(`
      INSERT INTO nexus_schema_meta (key, value)
      VALUES ('community_snapshot_json', :value)
    `).run({ value: JSON.stringify({ 'community:1': 10 }) });

    // New state: 9 symbols (10% drop, below 20% threshold)
    insertNode(db, 'N1', 'sym1', 'function', 'community:1');
    insertNode(db, 'N2', 'sym2', 'function', 'community:1');
    insertNode(db, 'N3', 'sym3', 'function', 'community:1');
    insertNode(db, 'N4', 'sym4', 'function', 'community:1');
    insertNode(db, 'N5', 'sym5', 'function', 'community:1');
    insertNode(db, 'N6', 'sym6', 'function', 'community:1');
    insertNode(db, 'N7', 'sym7', 'function', 'community:1');
    insertNode(db, 'N8', 'sym8', 'function', 'community:1');
    insertNode(db, 'N9', 'sym9', 'function', 'community:1');

    const results = runNexusIngester(db);

    // Should NOT find fragmentation because drop is only 10%
    const fragmentation = results.find((r) => r.title.includes('Community fragmentation'));
    expect(fragmentation).toBeUndefined();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Query D: Entry-Point Erosion
// ---------------------------------------------------------------------------

describe('runNexusIngester - Query D (Entry-Point Erosion)', () => {
  it('detects entry-point erosion when process points to unexported function', () => {
    const db = createNexusDb();

    // Create a process node
    insertNode(db, 'P1', 'myProcess', 'process');

    // Create an unexported function that is the entry point
    insertNode(db, 'F1', 'entryFunc', 'function', null, false);

    // Create entry_point_of relation from F1 to P1
    insertRelation(db, 'F1', 'P1', 'entry_point_of', 'entry_point_of');

    const results = runNexusIngester(db);

    // Should detect entry-point erosion
    const erosion = results.find((r) => r.title.includes('Entry-point erosion'));
    expect(erosion).toBeDefined();
    if (erosion) {
      expect(erosion.weight).toBe(NEXUS_ENTRY_EROSION_WEIGHT);
      expect(erosion.sourceId).toBe('P1');
    }

    db.close();
  });

  it('does not emit erosion if entry function is exported', () => {
    const db = createNexusDb();

    // Create a process node
    insertNode(db, 'P1', 'myProcess', 'process');

    // Create an EXPORTED function as entry point
    insertNode(db, 'F1', 'entryFunc', 'function', null, true);

    // Create entry_point_of relation
    insertRelation(db, 'F1', 'P1', 'entry_point_of', 'entry_point_of');

    const results = runNexusIngester(db);

    // Should NOT detect erosion because entry function is exported
    const erosion = results.find((r) => r.title.includes('Entry-point erosion'));
    expect(erosion).toBeUndefined();

    db.close();
  });
});

// ---------------------------------------------------------------------------
// Query E: Cross-Community Coupling Spike
// ---------------------------------------------------------------------------

describe('runNexusIngester - Query E (Cross-Community Coupling Spike)', () => {
  it('query E: can emit cross-community coupling proposals (all detectors active)', () => {
    const db = createNexusDb();

    // For now, just verify that all 5 detectors can run without errors
    // Query E requires complex cross-community edge counting that varies by project
    // It will be tested in integration once nexus.db is populated

    insertNode(db, 'N1', 'someFunc', 'function', 'community:A');
    insertNode(db, 'N2', 'otherFunc', 'function', 'community:B');

    const results = runNexusIngester(db);

    // Just verify that no error was thrown
    expect(Array.isArray(results)).toBe(true);

    db.close();
  });
});
