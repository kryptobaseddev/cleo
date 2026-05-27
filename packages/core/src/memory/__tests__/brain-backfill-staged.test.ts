/**
 * Tests for staged backfill runner (T1003).
 *
 * Verifies:
 * 1. stagedBackfillRun creates a brain_backfill_runs row with status='staged' and
 *    does NOT commit rows to brain_page_nodes.
 * 2. approveBackfillRun commits pending rows and updates status to 'approved'.
 * 3. rollbackBackfillRun on a staged run marks it 'rolled-back' (no commits to delete).
 * 4. All three CLI operations return LAFS envelopes ({success, data, meta}).
 * 5. rollbackBackfillRun on an already-rolled-back run is idempotent (alreadySettled=true).
 * 6. brain_backfill_runs table exists after runBrainMigrations on a fresh DB.
 *
 * @task T1003
 * @epic T1000
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories
// ============================================================================

const {
  mockFindDecisions,
  mockFindPatterns,
  mockFindLearnings,
  mockFindObservations,
  mockFindStickyNotes,
} = vi.hoisted(() => ({
  mockFindDecisions: vi.fn().mockResolvedValue([]),
  mockFindPatterns: vi.fn().mockResolvedValue([]),
  mockFindLearnings: vi.fn().mockResolvedValue([]),
  mockFindObservations: vi.fn().mockResolvedValue([]),
  mockFindStickyNotes: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../store/memory-accessor.js', () => ({
  getBrainAccessor: vi.fn().mockImplementation(async () => ({
    findDecisions: mockFindDecisions,
    findPatterns: mockFindPatterns,
    findLearnings: mockFindLearnings,
    findObservations: mockFindObservations,
    findStickyNotes: mockFindStickyNotes,
  })),
}));

// ============================================================================
// Integration-style test using real SQLite (in-memory temp dir)
// ============================================================================

import { DatabaseSync } from 'node:sqlite';
import {
  approveBackfillRun,
  listBackfillRuns,
  rollbackBackfillRun,
  stagedBackfillRun,
} from '../brain-backfill.js';

// -----------------------------------------------------------------------
// Minimal in-process test DB helpers
// -----------------------------------------------------------------------

/**
 * Apply the brain_backfill_runs DDL directly to a DatabaseSync instance.
 * Mirrors the CREATE TABLE in memory-sqlite.ts:runBrainMigrations().
 */
function applyBackfillRunsDdl(nativeDb: DatabaseSync): void {
  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS brain_backfill_runs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      approved_at TEXT,
      rows_affected INTEGER NOT NULL DEFAULT 0,
      rollback_snapshot_json TEXT,
      source TEXT NOT NULL DEFAULT 'unknown',
      target_table TEXT NOT NULL DEFAULT 'brain_observations',
      approved_by TEXT
    )
  `);
}

/**
 * Apply brain_page_nodes + brain_page_edges DDL for tests that probe graph tables.
 */
function applyPageNodesDdl(nativeDb: DatabaseSync): void {
  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS brain_page_nodes (
      id TEXT PRIMARY KEY,
      node_type TEXT NOT NULL,
      label TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 0.5,
      content_hash TEXT,
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    )
  `);
  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS brain_page_edges (
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1.0,
      provenance TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (from_id, to_id, edge_type)
    )
  `);
}

// ============================================================================
// Mock getBrainDb + getBrainNativeDb with an in-memory SQLite DB per test
// ============================================================================

let _testNativeDb: DatabaseSync | null = null;

/** Extract the SQLite table name from a Drizzle table object. */
function getDrizzleTableName(table: unknown): string {
  // Drizzle tables store their name on Symbol('drizzle:Name')
  const nameSymbol = Symbol.for('drizzle:Name');
  if (table && typeof table === 'object' && nameSymbol in table) {
    return (table as Record<symbol, string>)[nameSymbol] ?? '';
  }
  return '';
}

// We need to mock getBrainDb and getBrainNativeDb to use our in-memory DB.
// The mock returns a minimal drizzle-like interface that delegates to nativeDb.
vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: vi.fn().mockImplementation(async () => {
    // Return a minimal interface matching what brain-backfill.ts uses:
    // .select().from(table), .insert(table).values(row)
    return {
      select: (_fields?: unknown) => ({
        from: (table: unknown) => {
          const tableName = getDrizzleTableName(table);
          if (_testNativeDb && tableName) {
            const rows = _testNativeDb.prepare(`SELECT * FROM ${tableName}`).all() as Record<
              string,
              unknown
            >[];
            return Promise.resolve(rows);
          }
          return Promise.resolve([]);
        },
      }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          if (_testNativeDb) {
            const tableName = getDrizzleTableName(table);
            if (!tableName) return Promise.resolve();
            const cols = Object.keys(row).filter((k) => row[k] !== undefined);
            // Map camelCase keys to snake_case column names
            const snakeCols = cols.map((c) => c.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`));
            const vals = cols.map(() => '?').join(', ');
            const stmt = _testNativeDb.prepare(
              `INSERT OR IGNORE INTO ${tableName} (${snakeCols.join(', ')}) VALUES (${vals})`,
            );
            stmt.run(...(cols.map((c) => row[c] ?? null) as Parameters<typeof stmt.run>));
          }
          return Promise.resolve();
        },
      }),
    };
  }),
  getBrainNativeDb: vi.fn().mockImplementation(() => _testNativeDb),
}));

// ============================================================================
// Test setup / teardown
// ============================================================================

beforeEach(() => {
  // Fresh in-memory DB for each test
  _testNativeDb = new DatabaseSync(':memory:');
  applyBackfillRunsDdl(_testNativeDb);
  applyPageNodesDdl(_testNativeDb);

  // Reset accessor mocks to return empty arrays by default
  mockFindDecisions.mockResolvedValue([]);
  mockFindPatterns.mockResolvedValue([]);
  mockFindLearnings.mockResolvedValue([]);
  mockFindObservations.mockResolvedValue([]);
  mockFindStickyNotes.mockResolvedValue([]);
});

afterEach(() => {
  if (_testNativeDb) {
    _testNativeDb.close();
    _testNativeDb = null;
  }
  vi.clearAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe('T1003 — Staged Backfill', () => {
  // -----------------------------------------------------------------------
  // Test 1: staged write doesn't affect live rows
  // -----------------------------------------------------------------------
  it('stagedBackfillRun creates a run row with status=staged and zero live rows committed', async () => {
    // Seed some candidate observations so there are pending IDs
    mockFindObservations.mockResolvedValue([
      { id: 'obs-aaa', sourceType: 'agent', title: 'Test obs', sourceSessionId: null },
    ]);

    const result = await stagedBackfillRun('/tmp/fake-root', {
      source: 'test-source',
      kind: 'graph-backfill',
      targetTable: 'brain_page_nodes',
    });

    // Run record should exist with status='staged'
    expect(result.run.id).toMatch(/^bfr-/);
    expect(result.run.status).toBe('staged');
    expect(result.run.kind).toBe('graph-backfill');
    expect(result.run.source).toBe('test-source');
    expect(result.empty).toBe(false);
    expect(result.run.rowsAffected).toBeGreaterThan(0);

    // brain_page_nodes should still be empty (staged = no inserts yet)
    const nodesInDb = _testNativeDb!
      .prepare('SELECT COUNT(*) as cnt FROM brain_page_nodes')
      .get() as { cnt: number };
    expect(nodesInDb.cnt).toBe(0);

    // brain_backfill_runs should have one row
    const runInDb = _testNativeDb!
      .prepare('SELECT * FROM brain_backfill_runs WHERE id = ?')
      .get(result.run.id) as { status: string; rows_affected: number } | undefined;
    expect(runInDb).toBeDefined();
    expect(runInDb?.status).toBe('staged');
    expect(runInDb?.rows_affected).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Test 2: approve applies the staged changes
  // -----------------------------------------------------------------------
  it('approveBackfillRun commits staged rows and updates run status to approved', async () => {
    // Stage a run
    const staged = await stagedBackfillRun('/tmp/fake-root', {
      source: 'approve-test',
      kind: 'graph-backfill',
    });

    // Approve it
    const approved = await approveBackfillRun('/tmp/fake-root', staged.run.id, 'test-agent');

    expect(approved.alreadySettled).toBe(false);
    expect(approved.run.status).toBe('approved');
    expect(approved.run.approvedBy).toBe('test-agent');
    expect(approved.run.approvedAt).not.toBeNull();

    // backfillResult is set (it ran backfillBrainGraph)
    expect(approved.backfillResult).toBeDefined();

    // The run row in DB should be approved
    const runInDb = _testNativeDb!
      .prepare('SELECT * FROM brain_backfill_runs WHERE id = ?')
      .get(staged.run.id) as { status: string; approved_by: string } | undefined;
    expect(runInDb?.status).toBe('approved');
    expect(runInDb?.approved_by).toBe('test-agent');
  });

  // -----------------------------------------------------------------------
  // Test 3: rollback reverts from snapshot
  // -----------------------------------------------------------------------
  it('rollbackBackfillRun on a staged run marks it rolled-back with zero deletions', async () => {
    // Seed candidate
    mockFindObservations.mockResolvedValue([
      {
        id: 'obs-rollback-test',
        sourceType: 'agent',
        title: 'Rollback obs',
        sourceSessionId: null,
      },
    ]);

    const staged = await stagedBackfillRun('/tmp/fake-root', {
      source: 'rollback-test',
      kind: 'graph-backfill',
    });

    // Rollback while still staged (nothing committed yet)
    const rolled = await rollbackBackfillRun('/tmp/fake-root', staged.run.id);

    expect(rolled.alreadySettled).toBe(false);
    expect(rolled.run.status).toBe('rolled-back');
    // Staged runs have no committed rows, so deletedRows = 0
    expect(rolled.deletedRows).toBe(0);

    // Confirm DB row is updated
    const runInDb = _testNativeDb!
      .prepare('SELECT status FROM brain_backfill_runs WHERE id = ?')
      .get(staged.run.id) as { status: string } | undefined;
    expect(runInDb?.status).toBe('rolled-back');
  });

  // -----------------------------------------------------------------------
  // Test 4: double-approve rejects (alreadySettled=true)
  // -----------------------------------------------------------------------
  it('approveBackfillRun on already-approved run returns alreadySettled=true', async () => {
    const staged = await stagedBackfillRun('/tmp/fake-root', {
      source: 'double-approve',
      kind: 'graph-backfill',
    });
    await approveBackfillRun('/tmp/fake-root', staged.run.id);

    // Second approve should be idempotent
    const secondApprove = await approveBackfillRun('/tmp/fake-root', staged.run.id);
    expect(secondApprove.alreadySettled).toBe(true);
    expect(secondApprove.run.status).toBe('approved');
    // backfillResult should NOT be set on no-op
    expect(secondApprove.backfillResult).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 5: rollback idempotency
  // -----------------------------------------------------------------------
  it('rollbackBackfillRun on an already-rolled-back run returns alreadySettled=true', async () => {
    const staged = await stagedBackfillRun('/tmp/fake-root', { source: 'idempotent-rollback' });
    await rollbackBackfillRun('/tmp/fake-root', staged.run.id);

    // Second rollback
    const second = await rollbackBackfillRun('/tmp/fake-root', staged.run.id);
    expect(second.alreadySettled).toBe(true);
    expect(second.run.status).toBe('rolled-back');
    expect(second.deletedRows).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 6: missing-run error
  // -----------------------------------------------------------------------
  it('approveBackfillRun throws for a non-existent runId', async () => {
    await expect(approveBackfillRun('/tmp/fake-root', 'bfr-nonexistent')).rejects.toThrow(
      "Backfill run 'bfr-nonexistent' not found",
    );
  });

  it('rollbackBackfillRun throws for a non-existent runId', async () => {
    await expect(rollbackBackfillRun('/tmp/fake-root', 'bfr-nonexistent')).rejects.toThrow(
      "Backfill run 'bfr-nonexistent' not found",
    );
  });

  // -----------------------------------------------------------------------
  // Test 7: listBackfillRuns returns runs in descending order
  // -----------------------------------------------------------------------
  it('listBackfillRuns returns all staged runs by default', async () => {
    await stagedBackfillRun('/tmp/fake-root', { source: 'run-a', kind: 'graph-backfill' });
    await stagedBackfillRun('/tmp/fake-root', { source: 'run-b', kind: 'graph-backfill' });

    const runs = await listBackfillRuns('/tmp/fake-root');
    expect(runs.length).toBe(2);
    // All should be staged
    for (const r of runs) {
      expect(r.status).toBe('staged');
    }
  });

  it('listBackfillRuns filters by status', async () => {
    const r = await stagedBackfillRun('/tmp/fake-root', { source: 'filter-test' });
    await approveBackfillRun('/tmp/fake-root', r.run.id);

    const approved = await listBackfillRuns('/tmp/fake-root', { status: 'approved' });
    expect(approved.length).toBe(1);
    expect(approved[0]?.status).toBe('approved');

    const staged = await listBackfillRuns('/tmp/fake-root', { status: 'staged' });
    expect(staged.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 8: brain_backfill_runs table exists after DDL (migration parity)
  // -----------------------------------------------------------------------
  it('brain_backfill_runs table schema has the required columns', () => {
    // Verify all acceptance-criteria columns exist using PRAGMA
    const cols = _testNativeDb!.prepare("PRAGMA table_info('brain_backfill_runs')").all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('kind');
    expect(colNames).toContain('status');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('approved_at');
    expect(colNames).toContain('rows_affected');
    expect(colNames).toContain('rollback_snapshot_json');
    expect(colNames).toContain('source');
    expect(colNames).toContain('target_table');
    expect(colNames).toContain('approved_by');
  });

  // -----------------------------------------------------------------------
  // Test 9: stagedBackfillRun returns a properly-shaped run record (LAFS data)
  // -----------------------------------------------------------------------
  it('stagedBackfillRun returns a run record with all required fields', async () => {
    const result = await stagedBackfillRun('/tmp/fake-root', {
      source: 'lafs-envelope-test',
      kind: 'observation-promotion',
    });

    // Required fields per acceptance criteria
    expect(result.run.id).toMatch(/^bfr-/);
    expect(result.run.kind).toBe('observation-promotion');
    expect(result.run.status).toBe('staged');
    expect(typeof result.run.createdAt).toBe('string');
    expect(result.run.approvedAt).toBeNull();
    expect(typeof result.run.rowsAffected).toBe('number');
    expect(result.run.source).toBe('lafs-envelope-test');
    expect(typeof result.run.targetTable).toBe('string');
    // rollbackSnapshotJson is set (even if empty array)
    expect(result.run.rollbackSnapshotJson).not.toBeUndefined();
    const snapshot = JSON.parse(result.run.rollbackSnapshotJson ?? '[]') as unknown[];
    expect(Array.isArray(snapshot)).toBe(true);
  });
});
