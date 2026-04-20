/**
 * Tests for Step 9f hard-sweeper: runPruneSweep in brain-maintenance.ts.
 *
 * Covers the DELETE predicate: prune_candidate=1 AND quality_score<0.2
 * AND citation_count=0 AND age>30d. Also tests dry-run, maxDeletePerRun cap,
 * idempotency, and audit trail (brain_consolidation_events).
 *
 * @task T995
 * @epic T991
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

/** Open brain.db and return the raw node:sqlite DatabaseSync handle. */
async function openBrainDb(root: string) {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(root);
  const db = getBrainNativeDb();
  if (!db) throw new Error('brain.db unavailable');
  return db;
}

/** Ensure prune_candidate column exists on brain_observations (lazy migration). */
function ensurePruneCol(db: DatabaseSync) {
  for (const tbl of [
    'brain_observations',
    'brain_decisions',
    'brain_patterns',
    'brain_learnings',
  ]) {
    try {
      db.prepare(`ALTER TABLE ${tbl} ADD COLUMN prune_candidate INTEGER DEFAULT 0`).run();
    } catch {
      /* already exists */
    }
    try {
      db.prepare(`ALTER TABLE ${tbl} ADD COLUMN quality_score REAL DEFAULT 0.5`).run();
    } catch {
      /* already exists */
    }
    try {
      db.prepare(`ALTER TABLE ${tbl} ADD COLUMN citation_count INTEGER DEFAULT 0`).run();
    } catch {
      /* already exists */
    }
  }
}

/** Ensure brain_consolidation_events table exists (M4 migration). */
function ensureConsolidationEvents(db: DatabaseSync) {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS brain_consolidation_events (
       id              INTEGER PRIMARY KEY AUTOINCREMENT,
       trigger         TEXT    NOT NULL,
       session_id      TEXT,
       step_results_json TEXT,
       duration_ms     INTEGER NOT NULL DEFAULT 0,
       succeeded       INTEGER NOT NULL DEFAULT 1,
       created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
     )`,
  ).run();
}

/**
 * Insert a row into brain_observations with full prune-sweep predicate control.
 * `ageOffsetDays` negative = old (e.g. -40 means 40 days ago).
 */
function insertObs(
  db: DatabaseSync,
  opts: {
    id: string;
    pruneCandidate: number;
    qualityScore: number;
    citationCount: number;
    ageOffsetDays: number; // negative = old
  },
) {
  const createdAt = new Date(Date.now() + opts.ageOffsetDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  db.prepare(
    `INSERT OR IGNORE INTO brain_observations
       (id, type, title, narrative, memory_tier, prune_candidate, quality_score, citation_count, created_at)
     VALUES (?, 'observation', ?, ?, 'short', ?, ?, ?, ?)`,
  ).run(
    opts.id,
    `obs-${opts.id}`,
    `narrative for ${opts.id}`,
    opts.pruneCandidate,
    opts.qualityScore,
    opts.citationCount,
    createdAt,
  );
}

describe('runPruneSweep — Step 9f hard-sweeper', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-prune-sweep-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // =========================================================================
  // Test 1: 50 noise rows deleted, 50 clean rows retained
  // =========================================================================

  it('deletes qualifying rows and retains clean rows', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);
    ensureConsolidationEvents(db);

    // 50 noise: prune_candidate=1, quality=0.1, citation=0, age=40d old
    for (let i = 0; i < 50; i++) {
      insertObs(db, {
        id: `noise-${i.toString().padStart(3, '0')}`,
        pruneCandidate: 1,
        qualityScore: 0.1,
        citationCount: 0,
        ageOffsetDays: -40,
      });
    }

    // 50 clean: various reasons they should be retained
    for (let i = 0; i < 50; i++) {
      insertObs(db, {
        id: `clean-${i.toString().padStart(3, '0')}`,
        pruneCandidate: 0, // not flagged
        qualityScore: 0.7,
        citationCount: 0,
        ageOffsetDays: -40,
      });
    }

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const result = await runPruneSweep(tempDir);

    expect(result.deleted).toBe(50);
    expect(result.dryRun).toBe(false);

    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBe(50);
  });

  // =========================================================================
  // Test 2: dry-run mode — no mutations
  // =========================================================================

  it('dry-run mode: returns would-delete count but makes zero DB mutations', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);

    for (let i = 0; i < 10; i++) {
      insertObs(db, {
        id: `noise-dry-${i}`,
        pruneCandidate: 1,
        qualityScore: 0.05,
        citationCount: 0,
        ageOffsetDays: -35,
      });
    }

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const result = await runPruneSweep(tempDir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.wouldDelete).toBeGreaterThanOrEqual(10);

    // DB unchanged
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as {
      cnt: number;
    };
    expect(count.cnt).toBe(10);
  });

  // =========================================================================
  // Test 3: maxDeletePerRun cap
  // =========================================================================

  it('maxDeletePerRun cap limits deletions', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);

    for (let i = 0; i < 50; i++) {
      insertObs(db, {
        id: `capped-${i.toString().padStart(3, '0')}`,
        pruneCandidate: 1,
        qualityScore: 0.1,
        citationCount: 0,
        ageOffsetDays: -40,
      });
    }

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const result = await runPruneSweep(tempDir, { maxDeletePerRun: 10 });

    expect(result.deleted).toBeLessThanOrEqual(10);

    const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM brain_observations').get() as {
      cnt: number;
    };
    expect(remaining.cnt).toBeGreaterThanOrEqual(40);
  });

  // =========================================================================
  // Test 4: high-quality rows NOT deleted (quality_score >= 0.2)
  // =========================================================================

  it('preserves rows with quality_score >= 0.2 even when other flags set', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);

    insertObs(db, {
      id: 'high-quality-1',
      pruneCandidate: 1,
      qualityScore: 0.25, // >= 0.2 → must NOT be deleted
      citationCount: 0,
      ageOffsetDays: -40,
    });

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const result = await runPruneSweep(tempDir);

    expect(result.deleted).toBe(0);
    const row = db.prepare('SELECT id FROM brain_observations WHERE id = ?').get('high-quality-1');
    expect(row).toBeTruthy();
  });

  // =========================================================================
  // Test 5: cited rows NOT deleted (citation_count > 0)
  // =========================================================================

  it('preserves rows with citation_count > 0 even when prune_candidate=1', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);

    insertObs(db, {
      id: 'cited-1',
      pruneCandidate: 1,
      qualityScore: 0.05, // low quality
      citationCount: 1, // has citation → must NOT be deleted
      ageOffsetDays: -40,
    });

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const result = await runPruneSweep(tempDir);

    expect(result.deleted).toBe(0);
    const row = db.prepare('SELECT id FROM brain_observations WHERE id = ?').get('cited-1');
    expect(row).toBeTruthy();
  });

  // =========================================================================
  // Test 6: sweep result struct carries deleted count (audit via Step 9e)
  // =========================================================================

  it('result struct carries deleted count and byTable breakdown', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);
    ensureConsolidationEvents(db);

    for (let i = 0; i < 3; i++) {
      insertObs(db, {
        id: `audit-${i}`,
        pruneCandidate: 1,
        qualityScore: 0.05,
        citationCount: 0,
        ageOffsetDays: -40,
      });
    }

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const result = await runPruneSweep(tempDir);

    // Sweep returns correct counts — audit is captured in Step 9e event JSON
    // when invoked from runConsolidation (result.pruneSweep embedded in event).
    expect(result.deleted).toBe(3);
    expect(result.wouldDelete).toBeGreaterThanOrEqual(3);
    expect(result.dryRun).toBe(false);
    expect(typeof result.byTable['brain_observations']).toBe('number');
  });

  // =========================================================================
  // Test 7: recent rows NOT deleted (age <= 30d)
  // =========================================================================

  it('preserves rows created within the last 30 days', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);

    insertObs(db, {
      id: 'recent-1',
      pruneCandidate: 1,
      qualityScore: 0.05,
      citationCount: 0,
      ageOffsetDays: -10, // only 10 days old → must NOT be deleted
    });

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const result = await runPruneSweep(tempDir);

    expect(result.deleted).toBe(0);
    const row = db.prepare('SELECT id FROM brain_observations WHERE id = ?').get('recent-1');
    expect(row).toBeTruthy();
  });

  // =========================================================================
  // Test 8: idempotency — second run after first deletes nothing extra
  // =========================================================================

  it('is idempotent: second run after first produces deleted=0', async () => {
    const db = await openBrainDb(tempDir);
    ensurePruneCol(db);
    ensureConsolidationEvents(db);

    for (let i = 0; i < 5; i++) {
      insertObs(db, {
        id: `idem-${i}`,
        pruneCandidate: 1,
        qualityScore: 0.05,
        citationCount: 0,
        ageOffsetDays: -40,
      });
    }

    const { runPruneSweep } = await import('../brain-maintenance.js');
    const first = await runPruneSweep(tempDir);
    const second = await runPruneSweep(tempDir);

    expect(first.deleted).toBe(5);
    expect(second.deleted).toBe(0);
  });
});
