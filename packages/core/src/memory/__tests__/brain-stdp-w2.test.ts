/**
 * Functional tests for STDP Wave 2 (T679) — real SQLite, no mocks.
 *
 * These tests verify that `applyStdpPlasticity` produces plasticity events
 * when retrieval rows are present and within `pairingWindowMs`, and that the
 * T679 fixes are effective:
 *
 *   1. lookbackDays (30d default) is used for the SQL cutoff, NOT pairingWindowMs.
 *      → Rows older than 5 min ARE fetched and DO form pairs.
 *   2. session_id is propagated to brain_plasticity_events.
 *   3. retrieval_log_id (context_id) is populated on events.
 *
 * Time strategy: Rows are inserted with `datetime('now', '-Ns')` so they are
 * a few seconds old at insertion time — guaranteed within ANY reasonable window.
 * No sleep() calls. Tests run in < 2 seconds total.
 *
 * Owner mandate: "Tested functionally for REAL — no fake mock or just vitests,
 * we need automated testing but that doesn't test real world."
 *
 * @task T679
 * @epic T673
 * @see docs/specs/stdp-wire-up-spec.md §6.3
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

let tempDir: string;

async function setupDb(dir: string) {
  const { closeBrainDb, getBrainDb, getBrainNativeDb } = await import(
    '../../store/brain-sqlite.js'
  );
  closeBrainDb();
  await getBrainDb(dir);
  return getBrainNativeDb()!;
}

describe('STDP W2 — T679 functional tests (real SQLite, no mocks)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-stdp-w2-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // STDP-W2-1: Two same-session rows 2 min apart → 1 LTP event
  // ===========================================================================

  it('STDP-W2-1: same-session rows within pairingWindowMs produce LTP event', async () => {
    const nativeDb = await setupDb(tempDir);

    // Insert two retrieval rows 2 min apart, same session, sharing distinct entry_ids
    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_1', datetime('now', '-120 seconds'))`,
      )
      .run('q1', JSON.stringify(['obs:w2-A']), 1);

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_1', datetime('now', '-60 seconds'))`,
      )
      .run('q2', JSON.stringify(['obs:w2-B']), 1);

    const { applyStdpPlasticity } = await import('../brain-stdp.js');
    const result = await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000, // 5 min — both rows fit
    });

    expect(result.ltpEvents).toBeGreaterThanOrEqual(1);
    expect(result.pairsExamined).toBeGreaterThanOrEqual(1);

    // Verify brain_plasticity_events row was written
    const evtCount = nativeDb
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_plasticity_events WHERE kind = 'ltp'`)
      .get() as { cnt: number };
    expect(evtCount.cnt).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // STDP-W2-2: Two rows 10 min apart → 0 events (outside pairingWindowMs=5min)
  // ===========================================================================

  it('STDP-W2-2: rows beyond pairingWindowMs produce 0 events', async () => {
    const nativeDb = await setupDb(tempDir);

    // Insert two retrieval rows 10 min apart — beyond default 5 min pairingWindowMs
    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_2', datetime('now', '-620 seconds'))`,
      )
      .run('q1', JSON.stringify(['obs:w2-C']), 1);

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_2', datetime('now', '-10 seconds'))`,
      )
      .run('q2', JSON.stringify(['obs:w2-D']), 1);

    const { applyStdpPlasticity } = await import('../brain-stdp.js');
    const result = await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000, // 5 min — rows are 10 min apart
    });

    expect(result.ltpEvents).toBe(0);
    expect(result.ltdEvents).toBe(0);
  });

  // ===========================================================================
  // STDP-W2-3: Different session rows 2 min apart → 0 events (pre-Wave-2)
  // When pairingWindowMs=5min, cross-session pairs ARE eligible (pairing is
  // only gated on Δt, not session boundary). Wave 2 semantics match the spec
  // §3.1: "ALL spike pairs within pairingWindowMs are eligible regardless of
  // session boundary." So this test asserts LTP DOES fire cross-session.
  // ===========================================================================

  it('STDP-W2-3: different session_ids within pairingWindowMs still pair (spec §3.1)', async () => {
    const nativeDb = await setupDb(tempDir);

    // Two different sessions, 2 min apart — within pairingWindowMs=5min
    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_3a', datetime('now', '-120 seconds'))`,
      )
      .run('q1', JSON.stringify(['obs:w2-E']), 1);

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_3b', datetime('now', '-60 seconds'))`,
      )
      .run('q2', JSON.stringify(['obs:w2-F']), 1);

    const { applyStdpPlasticity } = await import('../brain-stdp.js');
    const result = await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000,
    });

    // Cross-session pairs within pairingWindowMs DO fire per spec §3.1
    expect(result.ltpEvents).toBeGreaterThanOrEqual(1);
  });

  // ===========================================================================
  // STDP-W2-4: session_id propagated to brain_plasticity_events INSERT
  // ===========================================================================

  it('STDP-W2-4: session_id propagated to brain_plasticity_events rows', async () => {
    const nativeDb = await setupDb(tempDir);

    const sessionId = 'ses_test_w2_session_id_propagation';

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', ?, datetime('now', '-120 seconds'))`,
      )
      .run('q1', JSON.stringify(['obs:w2-G']), 1, sessionId);

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', ?, datetime('now', '-60 seconds'))`,
      )
      .run('q2', JSON.stringify(['obs:w2-H']), 1, sessionId);

    const { applyStdpPlasticity } = await import('../brain-stdp.js');
    await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000,
    });

    // Assert session_id is on plasticity events (T679 requirement)
    const evtRow = nativeDb
      .prepare(`SELECT session_id FROM brain_plasticity_events WHERE kind = 'ltp' LIMIT 1`)
      .get() as { session_id: string | null } | undefined;

    expect(evtRow).toBeDefined();
    expect(evtRow?.session_id).toBe(sessionId);
  });

  // ===========================================================================
  // STDP-W2-5: retrieval_log_id (context_id) populated on events
  // ===========================================================================

  it('STDP-W2-5: retrieval_log_id populated on brain_plasticity_events', async () => {
    const nativeDb = await setupDb(tempDir);

    const rowA = nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_5', datetime('now', '-120 seconds'))`,
      )
      .run('q1', JSON.stringify(['obs:w2-I']), 1);

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_5', datetime('now', '-60 seconds'))`,
      )
      .run('q2', JSON.stringify(['obs:w2-J']), 1);

    const preSpikRowId = Number(rowA.lastInsertRowid);

    const { applyStdpPlasticity } = await import('../brain-stdp.js');
    await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000,
    });

    // Assert retrieval_log_id (context_id) points to the pre-spike's log row
    const evtRow = nativeDb
      .prepare(`SELECT retrieval_log_id FROM brain_plasticity_events WHERE kind = 'ltp' LIMIT 1`)
      .get() as { retrieval_log_id: number | null } | undefined;

    expect(evtRow).toBeDefined();
    expect(evtRow?.retrieval_log_id).toBe(preSpikRowId);
  });

  // ===========================================================================
  // STDP-W2-6: T679 BUG-1 fix — rows older than 5 min ARE fetched with lookbackDays=30
  // ===========================================================================

  it('STDP-W2-6: BUG-1 fix — rows from 1 day ago are fetched with lookbackDays=30', async () => {
    const nativeDb = await setupDb(tempDir);

    // Insert two rows that are 24 hours old — would have been missed by old 5-min cutoff
    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_6', datetime('now', '-86520 seconds'))`,
      )
      .run('q1', JSON.stringify(['obs:w2-K']), 1);

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_6', datetime('now', '-86460 seconds'))`,
      )
      .run('q2', JSON.stringify(['obs:w2-L']), 1);

    const { applyStdpPlasticity } = await import('../brain-stdp.js');

    // With lookbackDays=30, these rows from 24h ago ARE fetched.
    // The two rows are 60 seconds apart — within pairingWindowMs=5min → LTP fires.
    const result = await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000,
    });

    expect(result.ltpEvents).toBeGreaterThanOrEqual(1);

    // Verify: same rows would produce 0 events with old 5-min lookback behavior
    // (simulated by passing a tiny lookbackDays that excludes 24h-old rows)
    const { closeBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();

    const tempDir2 = await mkdtemp(join(tmpdir(), 'cleo-stdp-w2-old-'));
    try {
      process.env['CLEO_DIR'] = join(tempDir2, '.cleo');
      const nativeDb2 = await setupDb(tempDir2);

      nativeDb2
        .prepare(
          `INSERT INTO brain_retrieval_log
             (query, entry_ids, entry_count, source, session_id, created_at)
           VALUES (?, ?, ?, 'find', 'ses_test_w2_6', datetime('now', '-86520 seconds'))`,
        )
        .run('q1', JSON.stringify(['obs:w2-K2']), 1);

      nativeDb2
        .prepare(
          `INSERT INTO brain_retrieval_log
             (query, entry_ids, entry_count, source, session_id, created_at)
           VALUES (?, ?, ?, 'find', 'ses_test_w2_6', datetime('now', '-86460 seconds'))`,
        )
        .run('q2', JSON.stringify(['obs:w2-L2']), 1);

      // Old behavior: lookbackDays equivalent to 5min → rows excluded
      const resultOld = await applyStdpPlasticity(tempDir2, {
        lookbackDays: 0.001, // ~1.4 minutes — 24h rows fall outside this
        pairingWindowMs: 5 * 60 * 1000,
      });

      expect(resultOld.ltpEvents).toBe(0); // confirms BUG-1 root cause
    } finally {
      const { closeBrainDb: close2 } = await import('../../store/brain-sqlite.js');
      close2();
      await rm(tempDir2, { recursive: true, force: true });
      process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    }
  });

  // ===========================================================================
  // STDP-W2-7: comma-separated entry_ids (BUG-2 rows) are skipped gracefully
  // ===========================================================================

  it('STDP-W2-7: comma-separated entry_ids (BUG-2 rows) are skipped, not errored', async () => {
    const nativeDb = await setupDb(tempDir);

    // Insert one row with JSON entry_ids and one with CSV (BUG-2 format)
    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_7', datetime('now', '-120 seconds'))`,
      )
      .run('q1', JSON.stringify(['obs:w2-M']), 1); // valid JSON

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_7', datetime('now', '-60 seconds'))`,
      )
      .run('q2', 'obs:w2-N,obs:w2-O', 2); // BUG-2 CSV format — should be skipped

    const { applyStdpPlasticity } = await import('../brain-stdp.js');

    // Should not throw — BUG-2 rows are skipped silently
    const result = await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000,
    });

    // Only 1 JSON row → only 1 spike → 0 pairs formed → 0 events
    expect(result.ltpEvents).toBe(0);
    expect(result.pairsExamined).toBe(0);
  });

  // ===========================================================================
  // STDP-W2-8: LTD fires when reverse edge already exists
  // ===========================================================================

  it('STDP-W2-8: LTD fires and weakens pre-existing reverse edge', async () => {
    const nativeDb = await setupDb(tempDir);

    // Use observation: prefix IDs directly so spike expansion produces consistent node IDs.
    // The spike expander keeps IDs that already include ':' unchanged:
    //   rawId = 'observation:w2Q' → entryId = 'observation:w2Q' (has colon)
    const idP = 'observation:w2P';
    const idQ = 'observation:w2Q';

    // Pre-insert a reverse edge Q → P at weight=0.8 (LTD should depress this)
    nativeDb
      .prepare(
        `INSERT OR IGNORE INTO brain_page_edges
           (from_id, to_id, edge_type, weight, provenance, plasticity_class, created_at)
         VALUES (?, ?, 'co_retrieved', 0.8, 'test', 'hebbian', datetime('now'))`,
      )
      .run(idQ, idP);

    // Insert rows so P fires before Q (Δt = 60s) → LTP on P→Q, LTD on Q→P
    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_8', datetime('now', '-120 seconds'))`,
      )
      .run('q1', JSON.stringify([idP]), 1);

    nativeDb
      .prepare(
        `INSERT INTO brain_retrieval_log
           (query, entry_ids, entry_count, source, session_id, created_at)
         VALUES (?, ?, ?, 'find', 'ses_test_w2_8', datetime('now', '-60 seconds'))`,
      )
      .run('q2', JSON.stringify([idQ]), 1);

    const { applyStdpPlasticity } = await import('../brain-stdp.js');
    const result = await applyStdpPlasticity(tempDir, {
      lookbackDays: 30,
      pairingWindowMs: 5 * 60 * 1000,
    });

    expect(result.ltdEvents).toBeGreaterThanOrEqual(1);

    // Verify the reverse edge weight decreased
    const edgeRow = nativeDb
      .prepare(
        `SELECT weight FROM brain_page_edges
         WHERE from_id = ? AND to_id = ? AND edge_type = 'co_retrieved'`,
      )
      .get(idQ, idP) as { weight: number } | undefined;

    expect(edgeRow).toBeDefined();
    expect(edgeRow!.weight).toBeLessThan(0.8);
  });
});
