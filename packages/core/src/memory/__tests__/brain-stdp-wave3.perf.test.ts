/**
 * T695-1 — STDP session-bucket O(n²) complexity canary.
 *
 * Gated by `RUN_PERF=1`. Not included in the default `pnpm run test` suite
 * because the 6 DB cycles × 3 trials under vitest parallel workers produced
 * ratio spikes of 10.65× on contended CI (T1093/T1517), causing false failures.
 *
 * Run manually:
 *   RUN_PERF=1 pnpm vitest run packages/core/src/memory/__tests__/brain-stdp-wave3.perf.test.ts
 *
 * @task T695
 * @epic T673
 * @see packages/core/src/memory/__tests__/brain-stdp-wave3.test.ts for behavioral coverage
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 300_000 });

vi.mock('../sleep-consolidation.js', () => ({
  runSleepConsolidation: vi.fn().mockResolvedValue({
    ran: false,
    mergeDuplicates: { merged: 0, llmDecisions: 0 },
    pruneStale: { pruned: 0, preserved: 0 },
    strengthenPatterns: { synthesized: 0, patternsGenerated: 0 },
    generateInsights: { clustersProcessed: 0, insightsStored: 0 },
  }),
}));

const RUN_PERF = process.env['RUN_PERF'] === '1';

describe.skipIf(!RUN_PERF)('T695 — STDP O(n²) complexity canary (RUN_PERF=1 required)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-stdp-perf-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  it('T695-1: session-bucket O(n²) guard — ratio-based complexity proof (N=50 vs N=200)', async () => {
    const { closeBrainDb, getBrainDb, getBrainNativeDb } = await import(
      '../../store/memory-sqlite.js'
    );
    const { applyStdpPlasticity } = await import('../brain-stdp.js');

    async function setupDb(dir: string) {
      closeBrainDb();
      await getBrainDb(dir);
      return getBrainNativeDb()!;
    }

    async function measureRun(
      dir: string,
      numSessions: number,
      rowsPerSession: number,
    ): Promise<number> {
      closeBrainDb();
      const nativeDb = await setupDb(dir);

      nativeDb.exec('BEGIN');
      const insertStmt = nativeDb.prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, reward_signal, created_at)
         VALUES ('q', ?, 1, 'test', ?, NULL, datetime('now', ?))`,
      );
      for (let s = 0; s < numSessions; s++) {
        const sessionId = `ses_perf_${s}`;
        const daysBucket = numSessions > 1 ? (s * 29) / (numSessions - 1) : 0;
        for (let r = 0; r < rowsPerSession; r++) {
          const entryId = `obs:perf-s${s}-r${r}`;
          const secondsOffset = Math.round(daysBucket * 86400) + r * 10;
          insertStmt.run(JSON.stringify([entryId]), sessionId, `-${secondsOffset} seconds`);
        }
      }
      nativeDb.exec('COMMIT');

      closeBrainDb();
      const startMs = Date.now();
      await applyStdpPlasticity(dir, {
        lookbackDays: 30,
        pairingWindowMs: 24 * 60 * 60 * 1000,
      });
      return Date.now() - startMs;
    }

    const medianOf = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    };

    // SMALL run: 5 sessions × 10 rows = 50 spikes — 3 trials
    const smallDir = tempDir;
    const smallTrials: number[] = [];
    for (let i = 0; i < 3; i++) smallTrials.push(await measureRun(smallDir, 5, 10));
    const timeSmallMs = medianOf(smallTrials);

    // LARGE run: 20 sessions × 10 rows = 200 spikes (4× input) — 3 trials
    const largeDir = await mkdtemp(join(tmpdir(), 'cleo-stdp-perf-large-'));
    const largeTrials: number[] = [];
    try {
      process.env['CLEO_DIR'] = join(largeDir, '.cleo');
      for (let i = 0; i < 3; i++) largeTrials.push(await measureRun(largeDir, 20, 10));
    } finally {
      closeBrainDb();
      process.env['CLEO_DIR'] = join(smallDir, '.cleo');
      await rm(largeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
    const timeLargeMs = medianOf(largeTrials);

    // Each run must complete within 60 s individually
    expect(timeSmallMs).toBeLessThan(60_000);
    expect(timeLargeMs).toBeLessThan(60_000);

    // 4× input must not cause more than 8× slowdown (proves sub-quadratic)
    const smallFloor = Math.max(timeSmallMs, 1);
    const ratio = timeLargeMs / smallFloor;
    expect(ratio).toBeLessThan(8);
  });
});
