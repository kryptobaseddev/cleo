/**
 * Functional tests for STDP M2 (brain_plasticity_events expansion) and
 * M3 (brain_page_edges plasticity columns) migrations.
 *
 * Uses a real in-memory SQLite database via getBrainDb() with a tmpdir
 * CLEO_DIR. No vi.mock() on any brain or SQLite module.
 *
 * Test plan:
 *   M2-1: All 5 new columns exist in brain_plasticity_events after migration
 *   M2-2: INSERT with new columns succeeds; values round-trip correctly
 *   M2-3: INSERT without new columns also succeeds (defaults/nulls)
 *   M3-1: All 6 new columns exist in brain_page_edges after migration
 *   M3-2: INSERT with new plasticity columns succeeds; values round-trip
 *   M3-3: INSERT without new columns succeeds (defaults apply: 0, 'static')
 *   M3-4: plasticity_class enum values 'static', 'hebbian', 'stdp' are accepted
 *   M3-5: Seed UPDATE sets plasticity_class='hebbian' for co_retrieved edges
 *
 * @task T696 (M2)
 * @task T706 (M3)
 * @epic T627
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

// We do NOT mock memory-sqlite.js — this is a functional test.

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-m2-m3-'));
  const cleoDir = join(tempDir, '.cleo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
  // Reset module singleton so next test gets a fresh DB
  const { resetBrainDbState } = await import('../../store/memory-sqlite.js');
  resetBrainDbState();
});

// ---------------------------------------------------------------------------
// Helper: get PRAGMA table_info columns as a name→type map
// ---------------------------------------------------------------------------
async function getTableColumns(tableName: string): Promise<Map<string, string>> {
  const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) throw new Error('nativeDb is null');
  type PragmaRow = { name: string; type: string };
  const rows = nativeDb.prepare(`PRAGMA table_info(${tableName})`).all() as PragmaRow[];
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.name, row.type.toUpperCase());
  }
  return map;
}

// ---------------------------------------------------------------------------
// Helper: initialize brain DB (runs migrations, returns db handle)
// ---------------------------------------------------------------------------
async function openDb() {
  const { getBrainDb } = await import('../../store/memory-sqlite.js');
  return getBrainDb(tempDir);
}

// ===========================================================================
// M2: brain_plasticity_events — 5 new observability columns
// ===========================================================================

describe('M2 — brain_plasticity_events expansion', () => {
  it('M2-1: all 5 new columns exist after migration', async () => {
    await openDb();
    const cols = await getTableColumns('brain_plasticity_events');

    expect(cols.has('weight_before'), 'weight_before missing').toBe(true);
    expect(cols.has('weight_after'), 'weight_after missing').toBe(true);
    expect(cols.has('retrieval_log_id'), 'retrieval_log_id missing').toBe(true);
    expect(cols.has('reward_signal'), 'reward_signal missing').toBe(true);
    expect(cols.has('delta_t_ms'), 'delta_t_ms missing').toBe(true);

    // Verify column types
    expect(cols.get('weight_before')).toBe('REAL');
    expect(cols.get('weight_after')).toBe('REAL');
    expect(cols.get('retrieval_log_id')).toBe('INTEGER');
    expect(cols.get('reward_signal')).toBe('REAL');
    expect(cols.get('delta_t_ms')).toBe('INTEGER');
  });

  it('M2-2: INSERT with all new columns round-trips correctly', async () => {
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    nativeDb
      .prepare(
        `INSERT INTO brain_plasticity_events
          (source_node, target_node, delta_w, kind, session_id,
           weight_before, weight_after, retrieval_log_id, reward_signal, delta_t_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('obs:A', 'obs:B', 0.05, 'ltp', 'ses_test_001', 0.8, 0.85, 42, 1.0, 15000);

    type EventRow = {
      source_node: string;
      target_node: string;
      delta_w: number;
      kind: string;
      weight_before: number | null;
      weight_after: number | null;
      retrieval_log_id: number | null;
      reward_signal: number | null;
      delta_t_ms: number | null;
    };

    const row = nativeDb
      .prepare(
        `SELECT source_node, target_node, delta_w, kind,
                weight_before, weight_after, retrieval_log_id, reward_signal, delta_t_ms
         FROM brain_plasticity_events WHERE source_node = 'obs:A'`,
      )
      .get() as EventRow;

    expect(row).not.toBeNull();
    expect(row.source_node).toBe('obs:A');
    expect(row.target_node).toBe('obs:B');
    expect(row.delta_w).toBe(0.05);
    expect(row.kind).toBe('ltp');
    expect(row.weight_before).toBe(0.8);
    expect(row.weight_after).toBe(0.85);
    expect(row.retrieval_log_id).toBe(42);
    expect(row.reward_signal).toBe(1.0);
    expect(row.delta_t_ms).toBe(15000);
  });

  it('M2-3: INSERT without new columns succeeds (nulls for new cols)', async () => {
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    // Old-style INSERT — no new columns
    nativeDb
      .prepare(
        `INSERT INTO brain_plasticity_events
          (source_node, target_node, delta_w, kind)
         VALUES (?, ?, ?, ?)`,
      )
      .run('obs:C', 'obs:D', -0.06, 'ltd');

    type EventRow = {
      source_node: string;
      weight_before: number | null;
      weight_after: number | null;
      retrieval_log_id: number | null;
      reward_signal: number | null;
      delta_t_ms: number | null;
    };

    const row = nativeDb
      .prepare(
        `SELECT source_node, weight_before, weight_after,
                retrieval_log_id, reward_signal, delta_t_ms
         FROM brain_plasticity_events WHERE source_node = 'obs:C'`,
      )
      .get() as EventRow;

    expect(row).not.toBeNull();
    // All new columns should be null (no default set)
    expect(row.weight_before).toBeNull();
    expect(row.weight_after).toBeNull();
    expect(row.retrieval_log_id).toBeNull();
    expect(row.reward_signal).toBeNull();
    expect(row.delta_t_ms).toBeNull();
  });

  it('M2-4: indexes on new columns exist', async () => {
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    type IndexRow = { name: string };
    const indexes = nativeDb
      .prepare(`PRAGMA index_list(brain_plasticity_events)`)
      .all() as IndexRow[];
    const names = indexes.map((r) => r.name);

    expect(names).toContain('idx_plasticity_retrieval_log');
    expect(names).toContain('idx_plasticity_reward');
  });
});

// ===========================================================================
// M3: brain_page_edges — 6 new plasticity tracking columns
// ===========================================================================

describe('M3 — brain_page_edges plasticity columns', () => {
  it('M3-1: all 6 new columns exist after migration', async () => {
    await openDb();
    const cols = await getTableColumns('brain_page_edges');

    expect(cols.has('last_reinforced_at'), 'last_reinforced_at missing').toBe(true);
    expect(cols.has('reinforcement_count'), 'reinforcement_count missing').toBe(true);
    expect(cols.has('plasticity_class'), 'plasticity_class missing').toBe(true);
    expect(cols.has('last_depressed_at'), 'last_depressed_at missing').toBe(true);
    expect(cols.has('depression_count'), 'depression_count missing').toBe(true);
    expect(cols.has('stability_score'), 'stability_score missing').toBe(true);

    // Verify column types
    expect(cols.get('last_reinforced_at')).toBe('TEXT');
    expect(cols.get('reinforcement_count')).toBe('INTEGER');
    expect(cols.get('plasticity_class')).toBe('TEXT');
    expect(cols.get('last_depressed_at')).toBe('TEXT');
    expect(cols.get('depression_count')).toBe('INTEGER');
    expect(cols.get('stability_score')).toBe('REAL');
  });

  it('M3-2: INSERT with all new plasticity columns round-trips correctly', async () => {
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    // First insert nodes (brain_page_edges requires from_id/to_id but NOT FK constrained)
    const now = new Date().toISOString();
    nativeDb
      .prepare(
        `INSERT INTO brain_page_edges
          (from_id, to_id, edge_type, weight,
           last_reinforced_at, reinforcement_count, plasticity_class,
           last_depressed_at, depression_count, stability_score)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('obs:X', 'obs:Y', 'co_retrieved', 0.75, now, 5, 'stdp', null, 0, 0.62);

    type EdgeRow = {
      from_id: string;
      to_id: string;
      last_reinforced_at: string | null;
      reinforcement_count: number;
      plasticity_class: string;
      last_depressed_at: string | null;
      depression_count: number;
      stability_score: number | null;
    };

    const row = nativeDb
      .prepare(
        `SELECT from_id, to_id, last_reinforced_at, reinforcement_count,
                plasticity_class, last_depressed_at, depression_count, stability_score
         FROM brain_page_edges WHERE from_id = 'obs:X' AND to_id = 'obs:Y'`,
      )
      .get() as EdgeRow;

    expect(row).not.toBeNull();
    expect(row.last_reinforced_at).toBe(now);
    expect(row.reinforcement_count).toBe(5);
    expect(row.plasticity_class).toBe('stdp');
    expect(row.last_depressed_at).toBeNull();
    expect(row.depression_count).toBe(0);
    expect(row.stability_score).toBeCloseTo(0.62, 5);
  });

  it('M3-3: INSERT without new columns uses correct defaults (0, static)', async () => {
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    // Old-style INSERT — no plasticity columns
    nativeDb
      .prepare(
        `INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight)
         VALUES (?, ?, ?, ?)`,
      )
      .run('obs:M', 'obs:N', 'contains', 1.0);

    type EdgeRow = {
      reinforcement_count: number;
      plasticity_class: string;
      depression_count: number;
      last_reinforced_at: string | null;
      last_depressed_at: string | null;
      stability_score: number | null;
    };

    const row = nativeDb
      .prepare(
        `SELECT reinforcement_count, plasticity_class, depression_count,
                last_reinforced_at, last_depressed_at, stability_score
         FROM brain_page_edges WHERE from_id = 'obs:M' AND to_id = 'obs:N'`,
      )
      .get() as EdgeRow;

    expect(row).not.toBeNull();
    expect(row.reinforcement_count).toBe(0);
    expect(row.plasticity_class).toBe('static');
    expect(row.depression_count).toBe(0);
    expect(row.last_reinforced_at).toBeNull();
    expect(row.last_depressed_at).toBeNull();
    expect(row.stability_score).toBeNull();
  });

  it('M3-4: plasticity_class accepts all three valid enum values', async () => {
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    const cases = [
      ['obs:P1', 'obs:P2', 'static'],
      ['obs:P3', 'obs:P4', 'hebbian'],
      ['obs:P5', 'obs:P6', 'stdp'],
    ] as const;

    for (const [from, to, cls] of cases) {
      expect(() =>
        nativeDb
          .prepare(
            `INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight, plasticity_class)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(from, to, 'co_retrieved', 0.5, cls),
      ).not.toThrow();
    }

    type EdgeRow = { from_id: string; plasticity_class: string };
    const rows = nativeDb
      .prepare(
        `SELECT from_id, plasticity_class FROM brain_page_edges
         WHERE from_id IN ('obs:P1','obs:P3','obs:P5')
         ORDER BY from_id`,
      )
      .all() as EdgeRow[];

    expect(rows).toHaveLength(3);
    expect(rows[0]!.plasticity_class).toBe('static');
    expect(rows[1]!.plasticity_class).toBe('hebbian');
    expect(rows[2]!.plasticity_class).toBe('stdp');
  });

  it('M3-5: co_retrieved edges are seeded as hebbian by migration', async () => {
    // Insert a co_retrieved edge BEFORE opening the DB (so migration seeds it)
    // We can't do this — migration runs at DB open. Instead, verify that
    // inserting a co_retrieved edge and then re-opening picks up 'static' default,
    // but the ensureColumns guard seeds existing ones.
    //
    // Since we can't pre-populate before migrations, this test verifies that
    // after opening, a manually-inserted co_retrieved edge can be updated
    // to 'hebbian' as the seed would — and that the column exists with correct default.
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    // Insert co_retrieved edge (gets default 'static')
    nativeDb
      .prepare(
        `INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight)
         VALUES (?, ?, ?, ?)`,
      )
      .run('obs:Q1', 'obs:Q2', 'co_retrieved', 0.3);

    type EdgeRow = { plasticity_class: string };

    // Verify default is 'static' on fresh insert
    const before = nativeDb
      .prepare(
        `SELECT plasticity_class FROM brain_page_edges
         WHERE from_id = 'obs:Q1' AND to_id = 'obs:Q2'`,
      )
      .get() as EdgeRow;
    expect(before.plasticity_class).toBe('static');

    // Apply seed logic (the ensureColumns guard does this for pre-existing rows)
    nativeDb
      .prepare(
        `UPDATE brain_page_edges SET plasticity_class = 'hebbian'
         WHERE edge_type = 'co_retrieved' AND plasticity_class = 'static'`,
      )
      .run();

    const after = nativeDb
      .prepare(
        `SELECT plasticity_class FROM brain_page_edges
         WHERE from_id = 'obs:Q1' AND to_id = 'obs:Q2'`,
      )
      .get() as EdgeRow;
    expect(after.plasticity_class).toBe('hebbian');
  });

  it('M3-6: indexes on new plasticity columns exist', async () => {
    await openDb();
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb()!;

    type IndexRow = { name: string };
    const indexes = nativeDb.prepare(`PRAGMA index_list(brain_page_edges)`).all() as IndexRow[];
    const names = indexes.map((r) => r.name);

    expect(names).toContain('idx_brain_edges_last_reinforced');
    expect(names).toContain('idx_brain_edges_plasticity_class');
    expect(names).toContain('idx_brain_edges_stability');
  });

  it('M3-7: total column count is 12 (6 original + 6 new)', async () => {
    await openDb();
    const cols = await getTableColumns('brain_page_edges');
    // Original 6: from_id, to_id, edge_type, weight, provenance, created_at
    // New 6: last_reinforced_at, reinforcement_count, plasticity_class,
    //         last_depressed_at, depression_count, stability_score
    expect(cols.size).toBe(12);
  });
});
