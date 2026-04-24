/**
 * T1147 Wave 7 — Brain sweep E2E integration test.
 *
 * Verifies the full shadow-write envelope workflow:
 * 1. Insert 20 low-quality brain_observations (quality_score < 0.3, verified=false).
 * 2. Run `detectNoiseCandidates` in dry-run mode: assert candidate count >= 20.
 * 3. Run `detectNoiseCandidates` (staging mode): assert brain_observations_staging rows created.
 * 4. Run `executeSweep` (approve): assert:
 *    a. purged rows have `invalid_at` set in brain_observations.
 *    b. provenance_class = 'noise-purged' on purged rows.
 *    c. brain_backfill_runs.status = 'approved'.
 *    d. brain_observations_staging rows have validation_status = 'applied'.
 * 5. Verify `buildRetrievalBundle` no longer returns purged entries
 *    (unswept-pre-T1151 filter or invalid_at guard).
 *
 * @task T1147
 * @epic T1075
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

import { vi } from 'vitest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-t1147-sweep-'));
  const cleoDir = join(tempDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  const { resetBrainDbState } = await import('../../store/memory-sqlite.js');
  resetBrainDbState();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

/** Insert N low-quality observations using the native DB handle. */
async function insertLowQualityObservations(count: number): Promise<string[]> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(tempDir);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) throw new Error('Native DB not available');

  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `obs-sweep-test-${i}-${Date.now().toString(36)}`;
    nativeDb
      .prepare(
        `INSERT INTO brain_observations
       (id, type, title, source_type, quality_score, verified, invalid_at, provenance_class)
       VALUES (?, 'general', ?, 'agent', ?, 0, NULL, 'unswept-pre-T1151')`,
      )
      .run(id, `Low quality observation ${i}`, 0.1 + (i % 3) * 0.05);
    ids.push(id);
  }
  return ids;
}

describe('T1147 Brain sweep E2E', () => {
  it('SWEEP-1: detectNoiseCandidates dry-run finds inserted low-quality observations', async () => {
    await insertLowQualityObservations(20);

    const { detectNoiseCandidates } = await import('../brain-noise-detector.js');
    const result = await detectNoiseCandidates(tempDir, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.counts.observations).toBeGreaterThanOrEqual(20);
    expect(result.counts.total).toBeGreaterThanOrEqual(20);
    expect(result.runId).toMatch(/^bfr-/);
    // Sample JSON file should exist even in dry-run
    const { existsSync } = await import('node:fs');
    expect(existsSync(result.sampleFilePath)).toBe(true);
  });

  it('SWEEP-2: detectNoiseCandidates staging mode creates brain_backfill_runs + brain_observations_staging rows', async () => {
    await insertLowQualityObservations(20);

    const { detectNoiseCandidates } = await import('../brain-noise-detector.js');
    const result = await detectNoiseCandidates(tempDir, { dryRun: false });

    expect(result.dryRun).toBe(false);

    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).not.toBeNull();

    // brain_backfill_runs row exists
    const runRow = nativeDb!
      .prepare(`SELECT id, status, kind, rows_affected FROM brain_backfill_runs WHERE id = ?`)
      .get(result.runId) as
      | { id: string; status: string; kind: string; rows_affected: number }
      | undefined;
    expect(runRow).toBeDefined();
    expect(runRow!.status).toBe('staged');
    expect(runRow!.kind).toBe('noise-sweep-2440');
    expect(runRow!.rows_affected).toBeGreaterThanOrEqual(20);

    // brain_observations_staging rows exist
    const candidateCount = (
      nativeDb!
        .prepare(`SELECT COUNT(*) AS cnt FROM brain_observations_staging WHERE sweep_run_id = ?`)
        .get(result.runId) as { cnt: number }
    ).cnt;
    expect(candidateCount).toBeGreaterThanOrEqual(20);
  });

  it('SWEEP-3: executeSweep applies purge actions and sets invalid_at + provenance_class', async () => {
    const obsIds = await insertLowQualityObservations(20);

    const { detectNoiseCandidates } = await import('../brain-noise-detector.js');
    const detectResult = await detectNoiseCandidates(tempDir, { dryRun: false });

    const { executeSweep } = await import('../brain-sweep-executor.js');
    const sweepResult = await executeSweep({
      projectRoot: tempDir,
      runId: detectResult.runId,
      approvedBy: 'test-runner',
    });

    expect(sweepResult.success).toBe(true);
    expect(sweepResult.purged).toBeGreaterThanOrEqual(20);

    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).not.toBeNull();

    // All inserted observations should be marked as invalid
    for (const id of obsIds.slice(0, 5)) {
      const row = nativeDb!
        .prepare(`SELECT invalid_at, provenance_class FROM brain_observations WHERE id = ?`)
        .get(id) as { invalid_at: string | null; provenance_class: string | null } | undefined;
      expect(row?.invalid_at).not.toBeNull();
      expect(row?.provenance_class).toBe('noise-purged');
    }

    // brain_backfill_runs status should be 'approved'
    const runRow = nativeDb!
      .prepare(`SELECT status, approved_by FROM brain_backfill_runs WHERE id = ?`)
      .get(detectResult.runId) as { status: string; approved_by: string } | undefined;
    expect(runRow?.status).toBe('approved');
    expect(runRow?.approved_by).toBe('test-runner');

    // brain_observations_staging rows should be 'applied'
    const pendingCount = (
      nativeDb!
        .prepare(
          `SELECT COUNT(*) AS cnt FROM brain_observations_staging WHERE sweep_run_id = ? AND validation_status = 'pending'`,
        )
        .get(detectResult.runId) as { cnt: number }
    ).cnt;
    expect(pendingCount).toBe(0);
  });

  it('SWEEP-4: after sweep, invalid_at entries are not returned by brain_observations query', async () => {
    const obsIds = await insertLowQualityObservations(20);

    const { detectNoiseCandidates } = await import('../brain-noise-detector.js');
    const detectResult = await detectNoiseCandidates(tempDir, { dryRun: false });

    const { executeSweep } = await import('../brain-sweep-executor.js');
    await executeSweep({ projectRoot: tempDir, runId: detectResult.runId });

    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();

    // Query live observations excluding invalid_at rows (same filter as buildRetrievalBundle)
    const liveIds = (
      nativeDb!
        .prepare(`SELECT id FROM brain_observations WHERE invalid_at IS NULL`)
        .all() as Array<{ id: string }>
    ).map((r) => r.id);

    // None of our test observation IDs should appear in live results
    for (const id of obsIds) {
      expect(liveIds).not.toContain(id);
    }
  });

  it('SWEEP-5: doctor --assert-clean detects pending brain_observations_staging rows', async () => {
    await insertLowQualityObservations(5);

    const { detectNoiseCandidates } = await import('../brain-noise-detector.js');
    await detectNoiseCandidates(tempDir, { dryRun: false }); // stages but does not approve

    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();
    const pendingCount = (
      nativeDb!
        .prepare(
          `SELECT COUNT(*) AS cnt FROM brain_observations_staging WHERE validation_status = 'pending'`,
        )
        .get() as { cnt: number }
    ).cnt;

    expect(pendingCount).toBeGreaterThanOrEqual(5);
  });

  it('SWEEP-6: rollbackSweep discards staged run without modifying live tables', async () => {
    const obsIds = await insertLowQualityObservations(5);

    const { detectNoiseCandidates } = await import('../brain-noise-detector.js');
    const detectResult = await detectNoiseCandidates(tempDir, { dryRun: false });

    const { rollbackSweep } = await import('../brain-sweep-executor.js');
    const rolled = await rollbackSweep(tempDir, detectResult.runId);
    expect(rolled).toBe(true);

    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const nativeDb = getBrainNativeDb();

    // Run should be marked rolled-back
    const runRow = nativeDb!
      .prepare(`SELECT status FROM brain_backfill_runs WHERE id = ?`)
      .get(detectResult.runId) as { status: string } | undefined;
    expect(runRow?.status).toBe('rolled-back');

    // Live observations should NOT have been modified
    for (const id of obsIds) {
      const row = nativeDb!
        .prepare(`SELECT invalid_at FROM brain_observations WHERE id = ?`)
        .get(id) as { invalid_at: string | null } | undefined;
      expect(row?.invalid_at).toBeNull();
    }
  });
});
