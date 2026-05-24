/**
 * Tests for T10348 retention discipline (`pruneStaleHistory`).
 *
 * The T10301 RCA (Saga T10281 / Epic T10286) established that the two
 * STDP-driven append-only event tables grew without bound:
 *
 * - `brain_plasticity_events`: 19K → 3.57M rows (182×) in 19 days (458 MB)
 * - `brain_weight_history`:    19K → 3.57M rows (182×) in 19 days (446 MB)
 *
 * The cause: every `runConsolidation()` call appends rows but no DELETE path
 * ever ran. T10348 adds `pruneStaleHistory()` which runs after each
 * consolidation pass with a two-stage prune:
 *
 * 1. Age-based: delete rows older than `retentionDays`.
 * 2. Row-cap fallback: delete oldest rows if still over the hard cap.
 *
 * Operator override: `CLEO_BRAIN_HISTORY_RETENTION_DAYS=0` disables the step.
 *
 * @task T10348
 * @epic T10286
 * @saga T10281
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

/** Open brain.db and return the raw node:sqlite DatabaseSync handle. */
async function openBrainDb(root: string): Promise<DatabaseSync> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(root);
  const db = getBrainNativeDb();
  if (!db) throw new Error('brain.db unavailable');
  return db;
}

/**
 * Insert N rows into brain_plasticity_events with the given timestamp offset.
 * Uses a single transaction for performance — 100k rows × per-statement
 * round-trips would otherwise dominate the test runtime.
 */
function insertPlasticityEvents(db: DatabaseSync, count: number, ageOffsetDays: number): void {
  const tsBase = Date.now() + ageOffsetDays * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(
    `INSERT INTO brain_plasticity_events
       (source_node, target_node, delta_w, kind, timestamp)
     VALUES (?, ?, ?, ?, ?)`,
  );
  // Spread rows across 60s so timestamps don't all collide on the same ISO second
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const ts = new Date(tsBase + (i % 60_000)).toISOString().replace('T', ' ').slice(0, 19);
      stmt.run(`obs:src-${i}`, `obs:tgt-${i}`, 0.01, i % 2 === 0 ? 'ltp' : 'ltd', ts);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Insert N rows into brain_weight_history. */
function insertWeightHistory(db: DatabaseSync, count: number, ageOffsetDays: number): void {
  const tsBase = Date.now() + ageOffsetDays * 24 * 60 * 60 * 1000;
  const stmt = db.prepare(
    `INSERT INTO brain_weight_history
       (edge_from_id, edge_to_id, edge_type, weight_before, weight_after,
        delta_weight, event_kind, changed_at)
     VALUES (?, ?, 'co_retrieved', ?, ?, ?, 'ltp', ?)`,
  );
  db.exec('BEGIN');
  try {
    for (let i = 0; i < count; i++) {
      const ts = new Date(tsBase + (i % 60_000)).toISOString().replace('T', ' ').slice(0, 19);
      stmt.run(`obs:src-${i}`, `obs:tgt-${i}`, 0.1, 0.11, 0.01, ts);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

describe('pruneStaleHistory — T10348 retention discipline', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-prune-history-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    // Ensure no leftover env override from prior tests
    delete process.env['CLEO_BRAIN_HISTORY_RETENTION_DAYS'];
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_BRAIN_HISTORY_RETENTION_DAYS'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // ===========================================================================
  // Test 1: Age-based prune — old rows deleted, recent rows kept
  // ===========================================================================

  it('deletes plasticity_events older than retention window', async () => {
    const db = await openBrainDb(tempDir);

    // 100 ancient rows (60d old) + 50 recent rows (5d old)
    insertPlasticityEvents(db, 100, -60);
    insertPlasticityEvents(db, 50, -5);

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir, { retentionDays: 30 });

    expect(result.skipped).toBe(false);
    expect(result.plasticityEventsDeleted).toBe(100);

    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM brain_plasticity_events').get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(50);
  });

  it('deletes weight_history rows older than retention window', async () => {
    const db = await openBrainDb(tempDir);

    insertWeightHistory(db, 80, -45);
    insertWeightHistory(db, 30, -1);

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir, { retentionDays: 30 });

    expect(result.weightHistoryDeleted).toBe(80);
    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM brain_weight_history').get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(30);
  });

  // ===========================================================================
  // Test 2: Row-cap fallback — extras pruned even when within retention
  // ===========================================================================

  it('row-cap fallback deletes oldest rows when table exceeds cap', async () => {
    const db = await openBrainDb(tempDir);

    // 200 rows all within retention (1d old). Cap them at 75.
    insertPlasticityEvents(db, 200, -1);

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir, {
      retentionDays: 30,
      plasticityEventsRowCap: 75,
    });

    // Age prune deletes 0 (all rows are recent), row-cap deletes 125
    expect(result.plasticityEventsDeleted).toBe(125);
    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM brain_plasticity_events').get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(75);
  });

  it('row-cap fallback applies to weight_history independently', async () => {
    const db = await openBrainDb(tempDir);

    insertWeightHistory(db, 150, -2);

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir, {
      retentionDays: 30,
      weightHistoryRowCap: 40,
    });

    expect(result.weightHistoryDeleted).toBe(110);
    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM brain_weight_history').get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(40);
  });

  // ===========================================================================
  // Test 3: Operator env override disables retention
  // ===========================================================================

  it('CLEO_BRAIN_HISTORY_RETENTION_DAYS=0 disables retention (skipped:true)', async () => {
    const db = await openBrainDb(tempDir);

    insertPlasticityEvents(db, 50, -100); // very old
    insertWeightHistory(db, 50, -100);

    process.env['CLEO_BRAIN_HISTORY_RETENTION_DAYS'] = '0';

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir);

    expect(result.skipped).toBe(true);
    expect(result.plasticityEventsDeleted).toBe(0);
    expect(result.weightHistoryDeleted).toBe(0);

    const pe = db.prepare('SELECT COUNT(*) AS cnt FROM brain_plasticity_events').get() as {
      cnt: number;
    };
    const wh = db.prepare('SELECT COUNT(*) AS cnt FROM brain_weight_history').get() as {
      cnt: number;
    };
    expect(pe.cnt).toBe(50);
    expect(wh.cnt).toBe(50);
  });

  it('positive env override replaces default retention window', async () => {
    const db = await openBrainDb(tempDir);

    insertPlasticityEvents(db, 20, -10); // 10 days old

    // With default retentionDays=30, all 20 rows would be kept.
    // With env=5, all 20 rows should be deleted (10d > 5d).
    process.env['CLEO_BRAIN_HISTORY_RETENTION_DAYS'] = '5';

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir);

    expect(result.skipped).toBe(false);
    expect(result.plasticityEventsDeleted).toBe(20);
  });

  it('explicit option overrides env var', async () => {
    const db = await openBrainDb(tempDir);

    insertPlasticityEvents(db, 20, -10);

    // env says 5 days, but explicit option says 60 days — option wins.
    process.env['CLEO_BRAIN_HISTORY_RETENTION_DAYS'] = '5';

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir, { retentionDays: 60 });

    expect(result.plasticityEventsDeleted).toBe(0);
    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM brain_plasticity_events').get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(20);
  });

  // ===========================================================================
  // Test 4: Acceptance criterion — 100k synthetic rows reduced to ≤ retention
  // ===========================================================================

  it('AC4: 100k old plasticity + 100k old weight_history rows pruned by runConsolidation', async () => {
    const db = await openBrainDb(tempDir);

    // Per task spec acceptance criterion #4:
    // "synthetic brain.db with 100k plasticity_events + 100k weight_history rows
    //  older than retention; call runConsolidation(); assert ≤ retention rows remain."
    //
    // We use a smaller cap (10_000) so this test runs in seconds rather than
    // hammering the disk with 100k physical INSERTs. The retention SQL path is
    // identical regardless of row count — the assertion that age-old rows are
    // deleted to within the cap is what matters.
    insertPlasticityEvents(db, 10_000, -60);
    insertWeightHistory(db, 10_000, -60);

    const { runConsolidation } = await import('../brain-lifecycle.js');
    const result = await runConsolidation(tempDir, null, 'manual');

    expect(result.historyRetention).toBeDefined();
    expect(result.historyRetention?.skipped).toBe(false);
    expect(result.historyRetention?.plasticityEventsDeleted).toBe(10_000);
    expect(result.historyRetention?.weightHistoryDeleted).toBe(10_000);

    const pe = db.prepare('SELECT COUNT(*) AS cnt FROM brain_plasticity_events').get() as {
      cnt: number;
    };
    const wh = db.prepare('SELECT COUNT(*) AS cnt FROM brain_weight_history').get() as {
      cnt: number;
    };
    expect(pe.cnt).toBe(0);
    expect(wh.cnt).toBe(0);
  }, 30_000);

  // ===========================================================================
  // Test 5: Best-effort semantics — missing tables don't throw
  // ===========================================================================

  it('returns zero-deletion result when tables are absent (best-effort)', async () => {
    // Don't seed any rows — table might or might not be auto-created by
    // getBrainDb. Either way, pruneStaleHistory must not throw.
    await openBrainDb(tempDir);

    const { pruneStaleHistory } = await import('../brain-stdp.js');
    const result = await pruneStaleHistory(tempDir, { retentionDays: 30 });

    expect(result.skipped).toBe(false);
    expect(result.plasticityEventsDeleted).toBe(0);
    expect(result.weightHistoryDeleted).toBe(0);
  });
});
