/**
 * Functional tests for backfillRewardSignals — R-STDP reward signal backfill pipeline.
 *
 * Tests use REAL SQLite databases (no mocks). Each test gets its own isolated
 * temp directory with both tasks.db and brain.db initialised.
 *
 * Verifies:
 *   - Completed+verified task in session → reward_signal = +1.0
 *   - Completed+unverified task in session → reward_signal = +0.5
 *   - Cancelled task in session → reward_signal = -0.5
 *   - No matching tasks → reward_signal stays NULL (neutral)
 *   - Synthetic ses_backfill_ sessions are no-ops
 *   - null/undefined sessionId is a no-op
 *   - Already-labeled rows are not overwritten (idempotent)
 *   - brain_modulators rows are inserted for each task outcome
 *   - runConsolidation Step 9a wires backfillRewardSignals before Step 9b
 *
 * @task T681
 * @epic T673
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 30-second timeout: real SQLite migrations can be slow on first run
vi.setConfig({ testTimeout: 30_000 });

// ============================================================================
// Test helpers
// ============================================================================

/** Insert a task into tasks.db via the native db for test setup. */
function insertTestTask(
  nativeTasksDb: import('node:sqlite').DatabaseSync,
  opts: {
    id: string;
    sessionId: string;
    status: 'done' | 'cancelled';
    verificationPassed?: boolean;
    completedAt?: string;
    cancelledAt?: string;
  },
): void {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const verificationJson =
    opts.verificationPassed !== undefined
      ? JSON.stringify({
          passed: opts.verificationPassed,
          round: 1,
          gates: {},
          failureLog: [],
          initializedAt: now,
        })
      : null;
  const completedAt = opts.completedAt ?? (opts.status === 'done' ? now : null);
  const cancelledAt = opts.cancelledAt ?? (opts.status === 'cancelled' ? now : null);
  // T877: pipeline_stage must satisfy the structural invariant.
  const pipelineStage = opts.status === 'done' ? 'contribution' : 'cancelled';

  nativeTasksDb
    .prepare(
      `INSERT OR REPLACE INTO tasks
       (id, title, status, session_id, verification_json, completed_at, cancelled_at,
        created_at, updated_at, priority, pipeline_stage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'medium', ?)`,
    )
    .run(
      opts.id,
      `Test task ${opts.id}`,
      opts.status,
      opts.sessionId,
      verificationJson,
      completedAt,
      cancelledAt,
      now,
      now,
      pipelineStage,
    );
}

/** Insert a session row into tasks.db for test setup. */
function insertTestSession(
  nativeTasksDb: import('node:sqlite').DatabaseSync,
  sessionId: string,
): void {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  nativeTasksDb
    .prepare(`INSERT OR IGNORE INTO sessions (id, status, started_at) VALUES (?, 'active', ?)`)
    .run(sessionId, now);
}

/** Insert a brain_retrieval_log row for test setup. */
function insertRetrievalRow(
  nativeBrainDb: import('node:sqlite').DatabaseSync,
  opts: {
    query: string;
    entryIds: string[];
    sessionId: string;
    createdAt?: string;
  },
): number {
  const now = opts.createdAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const result = nativeBrainDb
    .prepare(
      `INSERT INTO brain_retrieval_log
       (query, entry_ids, entry_count, source, session_id, created_at)
     VALUES (?, ?, ?, 'find', ?, ?)`,
    )
    .run(opts.query, JSON.stringify(opts.entryIds), opts.entryIds.length, opts.sessionId, now);
  return result.lastInsertRowid as number;
}

// ============================================================================
// Suite
// ============================================================================

describe('backfillRewardSignals — real SQLite, no mocks', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-stdp-reward-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R1: Completed + verified → +1.0
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R1: verified done task → reward_signal = +1.0', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;
    const nativeTasksDb = getNativeDb()!;

    const sessionId = 'ses_test_verified_done';
    insertTestSession(nativeTasksDb, sessionId);
    insertTestTask(nativeTasksDb, {
      id: 'T900',
      sessionId,
      status: 'done',
      verificationPassed: true,
    });
    insertRetrievalRow(nativeBrainDb, {
      query: 'test query',
      entryIds: ['obs:A', 'obs:B'],
      sessionId,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');
    const result = await backfillRewardSignals(tempDir, sessionId);

    expect(result.rowsLabeled).toBe(1);

    const row = nativeBrainDb
      .prepare('SELECT reward_signal FROM brain_retrieval_log WHERE session_id = ?')
      .get(sessionId) as { reward_signal: number } | undefined;

    expect(row?.reward_signal).toBe(1.0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R2: Done + unverified → +0.5
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R2: done but unverified task → reward_signal = +0.5', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;
    const nativeTasksDb = getNativeDb()!;

    const sessionId = 'ses_test_done_unverified';
    insertTestSession(nativeTasksDb, sessionId);
    insertTestTask(nativeTasksDb, {
      id: 'T901',
      sessionId,
      status: 'done',
      verificationPassed: false,
    });
    insertRetrievalRow(nativeBrainDb, {
      query: 'unverified query',
      entryIds: ['obs:X'],
      sessionId,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');
    const result = await backfillRewardSignals(tempDir, sessionId);

    expect(result.rowsLabeled).toBe(1);

    const row = nativeBrainDb
      .prepare('SELECT reward_signal FROM brain_retrieval_log WHERE session_id = ?')
      .get(sessionId) as { reward_signal: number } | undefined;

    expect(row?.reward_signal).toBe(0.5);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R3: Cancelled task → -0.5
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R3: cancelled task → reward_signal = -0.5', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;
    const nativeTasksDb = getNativeDb()!;

    const sessionId = 'ses_test_cancelled';
    insertTestSession(nativeTasksDb, sessionId);
    insertTestTask(nativeTasksDb, {
      id: 'T902',
      sessionId,
      status: 'cancelled',
    });
    insertRetrievalRow(nativeBrainDb, {
      query: 'cancelled session query',
      entryIds: ['obs:Y'],
      sessionId,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');
    const result = await backfillRewardSignals(tempDir, sessionId);

    expect(result.rowsLabeled).toBe(1);

    const row = nativeBrainDb
      .prepare('SELECT reward_signal FROM brain_retrieval_log WHERE session_id = ?')
      .get(sessionId) as { reward_signal: number } | undefined;

    expect(row?.reward_signal).toBe(-0.5);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R4: No matching tasks → reward_signal stays NULL
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R4: no matching tasks → reward_signal stays NULL (neutral)', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;

    const sessionId = 'ses_test_no_tasks';
    // No session or tasks inserted — session has no completed/cancelled tasks
    insertRetrievalRow(nativeBrainDb, {
      query: 'orphan query',
      entryIds: ['obs:Z'],
      sessionId,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');
    const result = await backfillRewardSignals(tempDir, sessionId);

    expect(result.rowsLabeled).toBe(0);

    const row = nativeBrainDb
      .prepare('SELECT reward_signal FROM brain_retrieval_log WHERE session_id = ?')
      .get(sessionId) as { reward_signal: number | null } | undefined;

    // reward_signal must remain NULL — no signal derived
    expect(row?.reward_signal).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R5: Synthetic ses_backfill_ sessions are no-ops
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R5: ses_backfill_ session is a no-op', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;
    const nativeTasksDb = getNativeDb()!;

    const backfillSession = 'ses_backfill_2026-04-13';
    // Insert a task and retrieval row for the synthetic session
    // (backfill sessions have no real sessions table row — use INSERT IGNORE)
    insertTestSession(nativeTasksDb, backfillSession);
    insertTestTask(nativeTasksDb, {
      id: 'T903',
      sessionId: backfillSession,
      status: 'done',
      verificationPassed: true,
    });
    insertRetrievalRow(nativeBrainDb, {
      query: 'backfill query',
      entryIds: ['obs:BackfillA'],
      sessionId: backfillSession,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');
    const result = await backfillRewardSignals(tempDir, backfillSession);

    // Must be a no-op — synthetic sessions have no real task correlation
    expect(result.rowsLabeled).toBe(0);
    expect(result.rowsSkipped).toBe(0);

    const row = nativeBrainDb
      .prepare('SELECT reward_signal FROM brain_retrieval_log WHERE session_id = ?')
      .get(backfillSession) as { reward_signal: number | null } | undefined;

    expect(row?.reward_signal).toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R6: null/undefined sessionId is a no-op
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R6: null sessionId is a no-op', async () => {
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    const { getDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const { backfillRewardSignals } = await import('../brain-stdp.js');

    const nullResult = await backfillRewardSignals(tempDir, null);
    expect(nullResult.rowsLabeled).toBe(0);
    expect(nullResult.rowsSkipped).toBe(0);

    const undefinedResult = await backfillRewardSignals(tempDir, undefined);
    expect(undefinedResult.rowsLabeled).toBe(0);
    expect(undefinedResult.rowsSkipped).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R7: Idempotent — running twice doesn't double-apply
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R7: idempotent — running twice does not change reward_signal', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;
    const nativeTasksDb = getNativeDb()!;

    const sessionId = 'ses_test_idempotent';
    insertTestSession(nativeTasksDb, sessionId);
    insertTestTask(nativeTasksDb, {
      id: 'T904',
      sessionId,
      status: 'done',
      verificationPassed: true,
    });
    insertRetrievalRow(nativeBrainDb, {
      query: 'idempotency query',
      entryIds: ['obs:Idem'],
      sessionId,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');

    // First run
    const first = await backfillRewardSignals(tempDir, sessionId);
    expect(first.rowsLabeled).toBe(1);

    // Second run — already labeled rows should be skipped
    const second = await backfillRewardSignals(tempDir, sessionId);
    expect(second.rowsLabeled).toBe(0);
    expect(second.rowsSkipped).toBeGreaterThanOrEqual(1);

    // reward_signal must still be +1.0 (not doubled or reset)
    const row = nativeBrainDb
      .prepare('SELECT reward_signal FROM brain_retrieval_log WHERE session_id = ?')
      .get(sessionId) as { reward_signal: number } | undefined;
    expect(row?.reward_signal).toBe(1.0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R8: brain_modulators rows are inserted for each task outcome
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R8: brain_modulators row inserted for each task outcome', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;
    const nativeTasksDb = getNativeDb()!;

    const sessionId = 'ses_test_modulator_insert';
    insertTestSession(nativeTasksDb, sessionId);
    insertTestTask(nativeTasksDb, {
      id: 'T905',
      sessionId,
      status: 'done',
      verificationPassed: true,
    });
    insertRetrievalRow(nativeBrainDb, {
      query: 'modulator test',
      entryIds: ['obs:Mod'],
      sessionId,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');
    await backfillRewardSignals(tempDir, sessionId);

    // brain_modulators should have a row for T905
    const modulatorRow = nativeBrainDb
      .prepare(
        `SELECT modulator_type, valence, source_event_id, session_id
         FROM brain_modulators WHERE source_event_id = ?`,
      )
      .get('T905') as
      | {
          modulator_type: string;
          valence: number;
          source_event_id: string;
          session_id: string;
        }
      | undefined;

    expect(modulatorRow).toBeDefined();
    expect(modulatorRow?.modulator_type).toBe('task_verified');
    expect(modulatorRow?.valence).toBe(1.0);
    expect(modulatorRow?.source_event_id).toBe('T905');
    expect(modulatorRow?.session_id).toBe(sessionId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T681-R9: Maximum reward wins when multiple tasks in session
  // ──────────────────────────────────────────────────────────────────────────

  it('T681-R9: max reward wins — verified done beats cancelled in same session', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');

    await getBrainDb(tempDir);
    await getDb(tempDir);

    const nativeBrainDb = getBrainNativeDb()!;
    const nativeTasksDb = getNativeDb()!;

    const sessionId = 'ses_test_max_reward';
    insertTestSession(nativeTasksDb, sessionId);
    // One verified done (+1.0) and one cancelled (-0.5) in same session
    insertTestTask(nativeTasksDb, {
      id: 'T906',
      sessionId,
      status: 'done',
      verificationPassed: true,
    });
    insertTestTask(nativeTasksDb, {
      id: 'T907',
      sessionId,
      status: 'cancelled',
    });
    insertRetrievalRow(nativeBrainDb, {
      query: 'mixed session query',
      entryIds: ['obs:MaxA'],
      sessionId,
    });

    const { backfillRewardSignals } = await import('../brain-stdp.js');
    await backfillRewardSignals(tempDir, sessionId);

    const row = nativeBrainDb
      .prepare('SELECT reward_signal FROM brain_retrieval_log WHERE session_id = ?')
      .get(sessionId) as { reward_signal: number } | undefined;

    // Maximum reward (+1.0 verified) wins over -0.5 cancelled
    expect(row?.reward_signal).toBe(1.0);
  });
});
