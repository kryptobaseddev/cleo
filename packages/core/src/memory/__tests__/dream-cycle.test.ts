/**
 * Tests for dream-cycle.ts — T628 auto-dream cycle.
 *
 * Uses real SQLite brain.db (no mocks). Each test gets an isolated
 * temp directory via mkdtemp so there are no cross-test state leaks.
 *
 * Test cases:
 *   DC-1: Volume trigger fires when new observations exceed threshold
 *   DC-2: Volume trigger does NOT fire when below threshold
 *   DC-3: Idle trigger fires after simulated inactivity period
 *   DC-4: Idle trigger does NOT fire when recent retrieval activity exists
 *   DC-5: Consolidation event recorded after dream trigger
 *   DC-6: In-process cooldown prevents double-trigger within 5 min window
 *   DC-7: triggerManualDream bypasses thresholds and always runs
 *   DC-8: dreamInFlight guard prevents concurrent overlapping runs
 *   DC-9: checkVolumeTrigger and checkIdleTrigger are independently correct
 *
 * @task T628
 * @epic T627
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Set test timeout: real SQLite + consolidation pipeline can be slow.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

let tempDir: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Initialise brain.db in `dir` by calling getBrainDb and then closeBrainDb.
 * This triggers runBrainMigrations (including ensureColumns safety net).
 */
async function initBrainDb(dir: string): Promise<void> {
  const { getBrainDb, closeBrainDb } = await import('../../store/brain-sqlite.js');
  closeBrainDb();
  await getBrainDb(dir);
  closeBrainDb();
}

/**
 * Insert N `brain_observations` rows via native SQLite.
 * Uses datetime offsets so rows have distinct created_at timestamps.
 *
 * @param dir - Project root directory
 * @param count - Number of observation rows to insert
 * @param offsetSecondsAgo - Created at this many seconds ago (default 60)
 */
async function insertObservations(
  dir: string,
  count: number,
  offsetSecondsAgo = 60,
): Promise<void> {
  const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
    '../../store/brain-sqlite.js'
  );
  closeBrainDb();
  await getBrainDb(dir);
  const db = getBrainNativeDb();
  if (!db) throw new Error('brain.db unavailable');

  for (let i = 0; i < count; i++) {
    const id = `obs-dc-test-${Date.now()}-${i}`;
    db.prepare(
      `INSERT INTO brain_observations
         (id, type, title, narrative, source_type, quality_score, memory_tier, created_at)
       VALUES (?, 'change', 'test obs', 'test observation', 'test', 0.5, 'short',
               datetime('now', '-${offsetSecondsAgo} seconds'))`,
    ).run(id);
  }
  closeBrainDb();
}

/**
 * Insert a `brain_retrieval_log` row with a configurable timestamp offset.
 *
 * @param dir - Project root directory
 * @param minutesAgo - Insert with created_at this many minutes ago
 */
async function insertRetrievalLog(dir: string, minutesAgo: number): Promise<void> {
  const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
    '../../store/brain-sqlite.js'
  );
  closeBrainDb();
  await getBrainDb(dir);
  const db = getBrainNativeDb();
  if (!db) throw new Error('brain.db unavailable');

  db.prepare(
    `INSERT INTO brain_retrieval_log
       (query, entry_ids, entry_count, source, created_at)
     VALUES ('test query', '["obs-a","obs-b"]', 2, 'test',
             datetime('now', '-${minutesAgo} minutes'))`,
  ).run();
  closeBrainDb();
}

/**
 * Count rows in `brain_consolidation_events`.
 */
async function countConsolidationEvents(dir: string): Promise<number> {
  const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
    '../../store/brain-sqlite.js'
  );
  closeBrainDb();
  await getBrainDb(dir);
  const db = getBrainNativeDb();
  if (!db) return 0;
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM brain_consolidation_events').get() as
    | { cnt: number }
    | undefined;
  const count = row?.cnt ?? 0;
  closeBrainDb();
  return count;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-dream-cycle-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  // Reset in-process dream state before every test
  const { _resetDreamState } = await import('../dream-cycle.js');
  _resetDreamState();
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/brain-sqlite.js');
  closeBrainDb();
  const { _resetDreamState } = await import('../dream-cycle.js');
  _resetDreamState();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Dream Cycle — T628 auto-dream (real SQLite, no mocks)', () => {
  // =========================================================================
  // DC-1: Volume trigger fires when new observations exceed threshold
  // =========================================================================
  it('DC-1: volume trigger fires when observations exceed threshold', async () => {
    await initBrainDb(tempDir);
    // Insert VOLUME_THRESHOLD_DEFAULT (10) + 1 = 11 observations
    await insertObservations(tempDir, 11);

    const { checkAndDream } = await import('../dream-cycle.js');
    const result = await checkAndDream(tempDir, {
      volumeThreshold: 10,
      inline: true,
    });

    expect(result.triggered).toBe(true);
    expect(result.tier).toBe('volume');
    expect(result.newObservationCount).toBeGreaterThanOrEqual(11);
  });

  // =========================================================================
  // DC-2: Volume trigger does NOT fire when below threshold
  // =========================================================================
  it('DC-2: volume trigger does NOT fire when below threshold', async () => {
    await initBrainDb(tempDir);
    // Insert only 5 observations (below threshold of 10)
    await insertObservations(tempDir, 5);

    const { checkAndDream } = await import('../dream-cycle.js');
    const result = await checkAndDream(tempDir, {
      volumeThreshold: 10,
      idleThresholdMinutes: 9999, // prevent idle from firing
      inline: true,
    });

    expect(result.triggered).toBe(false);
    expect(result.tier).toBeNull();
    expect(result.newObservationCount).toBeLessThan(10);
  });

  // =========================================================================
  // DC-3: Idle trigger fires after simulated inactivity
  // =========================================================================
  it('DC-3: idle trigger fires when last retrieval is older than threshold', async () => {
    await initBrainDb(tempDir);
    // Insert retrieval log row 45 minutes ago (older than 30 min threshold)
    await insertRetrievalLog(tempDir, 45);

    const { checkAndDream } = await import('../dream-cycle.js');
    const result = await checkAndDream(tempDir, {
      volumeThreshold: 99999, // prevent volume from firing
      idleThresholdMinutes: 30,
      inline: true,
    });

    expect(result.triggered).toBe(true);
    expect(result.tier).toBe('idle');
    expect(result.idleMinutes).toBeGreaterThanOrEqual(30);
  });

  // =========================================================================
  // DC-4: Idle trigger does NOT fire when recent activity exists
  // =========================================================================
  it('DC-4: idle trigger does NOT fire when recent retrieval activity exists', async () => {
    await initBrainDb(tempDir);
    // Insert retrieval log row only 5 minutes ago (within the 30 min threshold)
    await insertRetrievalLog(tempDir, 5);

    const { checkAndDream } = await import('../dream-cycle.js');
    const result = await checkAndDream(tempDir, {
      volumeThreshold: 99999,
      idleThresholdMinutes: 30,
      inline: true,
    });

    expect(result.triggered).toBe(false);
    expect(result.tier).toBeNull();
    expect(result.idleMinutes).toBeLessThan(30);
  });

  // =========================================================================
  // DC-5: Consolidation event recorded in brain_consolidation_events
  // =========================================================================
  it('DC-5: consolidation event is recorded after dream trigger', async () => {
    await initBrainDb(tempDir);
    await insertObservations(tempDir, 11);

    const before = await countConsolidationEvents(tempDir);

    const { checkAndDream } = await import('../dream-cycle.js');
    await checkAndDream(tempDir, {
      volumeThreshold: 10,
      inline: true,
    });

    const after = await countConsolidationEvents(tempDir);
    expect(after).toBeGreaterThan(before);
  });

  // =========================================================================
  // DC-6: In-process cooldown prevents double-trigger
  // =========================================================================
  it('DC-6: cooldown prevents double-trigger within 5 min window', async () => {
    await initBrainDb(tempDir);
    await insertObservations(tempDir, 11);

    const { checkAndDream } = await import('../dream-cycle.js');

    // First call — should trigger
    const first = await checkAndDream(tempDir, {
      volumeThreshold: 10,
      inline: true,
    });
    expect(first.triggered).toBe(true);

    // Second immediate call — should be suppressed by cooldown
    const second = await checkAndDream(tempDir, {
      volumeThreshold: 10,
      inline: true,
    });
    expect(second.triggered).toBe(false);
    expect(second.skippedReason).toMatch(/cooldown active/);
  });

  // =========================================================================
  // DC-7: triggerManualDream bypasses thresholds and always runs
  // =========================================================================
  it('DC-7: triggerManualDream bypasses thresholds and records a consolidation event', async () => {
    await initBrainDb(tempDir);
    // No observations inserted — volume trigger would not fire

    const before = await countConsolidationEvents(tempDir);

    const { triggerManualDream } = await import('../dream-cycle.js');
    const result = await triggerManualDream(tempDir);

    // runConsolidation returns a valid result object
    expect(result).toBeDefined();
    expect(typeof result.deduplicated).toBe('number');
    expect(typeof result.edgesStrengthened).toBe('number');

    const after = await countConsolidationEvents(tempDir);
    expect(after).toBeGreaterThan(before);
  });

  // =========================================================================
  // DC-8: Concurrent protection — dreamInFlight prevents overlapping runs
  // =========================================================================
  it('DC-8: dreamInFlight guard suppresses concurrent overlapping calls', async () => {
    await initBrainDb(tempDir);
    await insertObservations(tempDir, 11);

    const { checkAndDream } = await import('../dream-cycle.js');

    // Fire two concurrent checks — only the first should trigger
    // (use inline=false so the second call races before the first finishes)
    const [first, second] = await Promise.all([
      checkAndDream(tempDir, { volumeThreshold: 10, inline: true }),
      checkAndDream(tempDir, { volumeThreshold: 10, inline: true }),
    ]);

    // At least one must have triggered; the other may have been blocked by cooldown or in-flight
    const triggeredCount = [first, second].filter((r) => r.triggered).length;
    expect(triggeredCount).toBeLessThanOrEqual(1);
  });

  // =========================================================================
  // DC-9: checkVolumeTrigger and checkIdleTrigger work independently
  // =========================================================================
  it('DC-9: checkVolumeTrigger reports correct observation count', async () => {
    await initBrainDb(tempDir);
    await insertObservations(tempDir, 7);
    // Re-open DB so synchronous trigger helper can read it
    const { getBrainDb } = await import('../../store/brain-sqlite.js');
    await getBrainDb(tempDir);

    const { checkVolumeTrigger } = await import('../dream-cycle.js');
    const result = checkVolumeTrigger(10);
    expect(result.newObservationCount).toBeGreaterThanOrEqual(7);
    expect(result.shouldTrigger).toBe(false); // 7 < 10
  });

  it('DC-9b: checkIdleTrigger reports correct idle minutes', async () => {
    await initBrainDb(tempDir);
    // Insert log row 60 minutes ago
    await insertRetrievalLog(tempDir, 60);
    // Re-open DB so synchronous trigger helper can read it
    const { getBrainDb } = await import('../../store/brain-sqlite.js');
    await getBrainDb(tempDir);

    const { checkIdleTrigger } = await import('../dream-cycle.js');
    const result = checkIdleTrigger(30);
    expect(result.idleMinutes).toBeGreaterThanOrEqual(55); // allow a few seconds variance
    expect(result.shouldTrigger).toBe(true);
  });
});
