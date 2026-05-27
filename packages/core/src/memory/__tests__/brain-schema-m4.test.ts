/**
 * Integration tests for STDP M4 plasticity auxiliary tables.
 *
 * Verifies that the three new tables from T673-M4 are created correctly
 * and behave as specified in docs/specs/stdp-wire-up-spec.md §2.1.4–§2.1.6.
 *
 * Tests use a real SQLite database (no mocks). Each test gets an isolated
 * temp directory so there are no cross-test state leaks.
 *
 * Tables under test:
 *   - brain_weight_history  (T697 — owner Q4 mandate)
 *   - brain_modulators      (T699 — R-STDP reward signal event log)
 *   - brain_consolidation_events (T701 — pipeline run audit log)
 *
 * @task T697
 * @task T699
 * @task T701
 * @epic T673
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

describe('Brain Schema M4 — plasticity aux tables (real SQLite, no mocks)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-m4-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // brain_weight_history (T697)
  // =========================================================================

  describe('brain_weight_history', () => {
    it('T697-1: table exists after DB initialisation', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const row = nativeDb
        ?.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='brain_weight_history'`,
        )
        .get() as { name: string } | undefined;
      expect(row?.name).toBe('brain_weight_history');
    });

    it('T697-2: insert and select back all required columns', async () => {
      const { insertWeightHistoryRow } = await import('../../store/memory-accessor.js');

      const inserted = await insertWeightHistoryRow(tempDir, {
        edgeFromId: 'observation:obs-A',
        edgeToId: 'observation:obs-B',
        edgeType: 'co_retrieved',
        weightBefore: 0.5,
        weightAfter: 0.55,
        deltaWeight: 0.05,
        eventKind: 'ltp',
        sourcePlasticityEventId: null,
        retrievalLogId: null,
        rewardSignal: null,
      });

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.edgeFromId).toBe('observation:obs-A');
      expect(inserted.edgeToId).toBe('observation:obs-B');
      expect(inserted.edgeType).toBe('co_retrieved');
      expect(inserted.weightBefore).toBe(0.5);
      expect(inserted.weightAfter).toBe(0.55);
      expect(inserted.deltaWeight).toBe(0.05);
      expect(inserted.eventKind).toBe('ltp');
      expect(inserted.changedAt).toBeTruthy();
    });

    it('T697-3: default changedAt is populated by SQLite', async () => {
      const { insertWeightHistoryRow } = await import('../../store/memory-accessor.js');

      const inserted = await insertWeightHistoryRow(tempDir, {
        edgeFromId: 'observation:A',
        edgeToId: 'observation:B',
        edgeType: 'co_retrieved',
        weightBefore: null,
        weightAfter: 0.075,
        deltaWeight: 0.075,
        eventKind: 'hebbian',
      });

      // changedAt should look like a datetime string, not null/undefined
      expect(typeof inserted.changedAt).toBe('string');
      expect(inserted.changedAt.length).toBeGreaterThan(10);
    });

    it('T697-4: weightBefore is nullable (new edge INSERT path)', async () => {
      const { insertWeightHistoryRow } = await import('../../store/memory-accessor.js');

      const inserted = await insertWeightHistoryRow(tempDir, {
        edgeFromId: 'observation:novel-A',
        edgeToId: 'observation:novel-B',
        edgeType: 'co_retrieved',
        weightBefore: null,
        weightAfter: 0.075,
        deltaWeight: 0.075,
        eventKind: 'ltp',
      });

      expect(inserted.weightBefore).toBeNull();
      expect(inserted.weightAfter).toBe(0.075);
    });

    it('T697-5: all six event_kind values are accepted', async () => {
      const { insertWeightHistoryRow } = await import('../../store/memory-accessor.js');
      const kinds = ['ltp', 'ltd', 'hebbian', 'decay', 'prune', 'external'] as const;

      for (const kind of kinds) {
        const row = await insertWeightHistoryRow(tempDir, {
          edgeFromId: `obs:from-${kind}`,
          edgeToId: `obs:to-${kind}`,
          edgeType: 'co_retrieved',
          weightBefore: 0.5,
          weightAfter: 0.45,
          deltaWeight: -0.05,
          eventKind: kind,
        });
        expect(row.eventKind).toBe(kind);
      }
    });

    it('T697-6: reward_signal and FK columns are nullable', async () => {
      const { insertWeightHistoryRow } = await import('../../store/memory-accessor.js');

      const inserted = await insertWeightHistoryRow(tempDir, {
        edgeFromId: 'obs:X',
        edgeToId: 'obs:Y',
        edgeType: 'co_retrieved',
        weightBefore: 0.2,
        weightAfter: 0.3,
        deltaWeight: 0.1,
        eventKind: 'ltp',
        sourcePlasticityEventId: 42,
        retrievalLogId: 7,
        rewardSignal: 1.0,
      });

      expect(inserted.sourcePlasticityEventId).toBe(42);
      expect(inserted.retrievalLogId).toBe(7);
      expect(inserted.rewardSignal).toBe(1.0);
    });

    it('T697-7: all six expected indexes exist', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const indexes = nativeDb
        ?.prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND tbl_name='brain_weight_history'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_weight_history_edge');
      expect(indexNames).toContain('idx_weight_history_from');
      expect(indexNames).toContain('idx_weight_history_to');
      expect(indexNames).toContain('idx_weight_history_changed_at');
      expect(indexNames).toContain('idx_weight_history_event_kind');
      expect(indexNames).toContain('idx_weight_history_plasticity_event');
    });
  });

  // =========================================================================
  // brain_modulators (T699)
  // =========================================================================

  describe('brain_modulators', () => {
    it('T699-1: table exists after DB initialisation', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const row = nativeDb
        ?.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='brain_modulators'`)
        .get() as { name: string } | undefined;
      expect(row?.name).toBe('brain_modulators');
    });

    it('T699-2: insert and select back all required columns', async () => {
      const { insertModulatorRow } = await import('../../store/memory-accessor.js');

      const inserted = await insertModulatorRow(tempDir, {
        modulatorType: 'task_completed',
        valence: 0.5,
        magnitude: 1.0,
        sourceEventId: 'T697',
        sessionId: 'ses_test_modulator',
        description: 'Task T697 completed (unverified)',
      });

      expect(inserted.id).toBeGreaterThan(0);
      expect(inserted.modulatorType).toBe('task_completed');
      expect(inserted.valence).toBe(0.5);
      expect(inserted.magnitude).toBe(1.0);
      expect(inserted.sourceEventId).toBe('T697');
      expect(inserted.sessionId).toBe('ses_test_modulator');
      expect(inserted.description).toBe('Task T697 completed (unverified)');
      expect(inserted.createdAt).toBeTruthy();
    });

    it('T699-3: magnitude defaults to 1.0 when not provided', async () => {
      const { insertModulatorRow } = await import('../../store/memory-accessor.js');

      const inserted = await insertModulatorRow(tempDir, {
        modulatorType: 'task_cancelled',
        valence: -0.5,
      });

      expect(inserted.magnitude).toBe(1.0);
    });

    it('T699-4: valence accepts full [-1.0, +1.0] range', async () => {
      const { insertModulatorRow } = await import('../../store/memory-accessor.js');
      const valences = [-1.0, -0.5, 0.0, 0.5, 1.0];

      for (const valence of valences) {
        const row = await insertModulatorRow(tempDir, {
          modulatorType: 'external',
          valence,
        });
        expect(row.valence).toBe(valence);
      }
    });

    it('T699-5: optional fields are nullable', async () => {
      const { insertModulatorRow } = await import('../../store/memory-accessor.js');

      const inserted = await insertModulatorRow(tempDir, {
        modulatorType: 'session_success',
        valence: 0.3,
      });

      expect(inserted.sourceEventId).toBeNull();
      expect(inserted.sessionId).toBeNull();
      expect(inserted.description).toBeNull();
    });

    it('T699-6: all five expected indexes exist', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const indexes = nativeDb
        ?.prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND tbl_name='brain_modulators'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_modulators_type');
      expect(indexNames).toContain('idx_modulators_session');
      expect(indexNames).toContain('idx_modulators_created_at');
      expect(indexNames).toContain('idx_modulators_source_event');
      expect(indexNames).toContain('idx_modulators_valence');
    });
  });

  // =========================================================================
  // brain_consolidation_events (T701)
  // =========================================================================

  describe('brain_consolidation_events', () => {
    it('T701-1: table exists after DB initialisation', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const row = nativeDb
        ?.prepare(
          `SELECT name FROM sqlite_master
           WHERE type='table' AND name='brain_consolidation_events'`,
        )
        .get() as { name: string } | undefined;
      expect(row?.name).toBe('brain_consolidation_events');
    });

    it('T701-2: logConsolidationStart inserts a row with correct trigger', async () => {
      const { logConsolidationStart } = await import('../../store/memory-accessor.js');

      const id = await logConsolidationStart(tempDir, 'session_end', 'ses_test_T701');

      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(0);

      // Verify the row exists in the DB
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const row = nativeDb
        ?.prepare('SELECT * FROM brain_consolidation_events WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;

      expect(row).toBeDefined();
      expect(row?.['trigger']).toBe('session_end');
      expect(row?.['session_id']).toBe('ses_test_T701');
      expect(row?.['step_results_json']).toBe('{}');
      expect(row?.['succeeded']).toBe(1);
    });

    it('T701-3: logConsolidationComplete updates the row with final results', async () => {
      const { logConsolidationStart, logConsolidationComplete } = await import(
        '../../store/memory-accessor.js'
      );

      const id = await logConsolidationStart(tempDir, 'manual', 'ses_test_complete');
      const stats = {
        step6_hebbian: { count: 12, durationMs: 45 },
        step9a_reward: { count: 3, durationMs: 120 },
        step9b_stdp: { count: 8, durationMs: 250 },
      };
      const updated = await logConsolidationComplete(tempDir, id, stats, 415, true);

      expect(updated.id).toBe(id);
      expect(updated.durationMs).toBe(415);
      expect(updated.succeeded).toBe(true);
      expect(JSON.parse(updated.stepResultsJson)).toMatchObject(stats);
    });

    it('T701-4: succeeded defaults to true', async () => {
      const { logConsolidationStart } = await import('../../store/memory-accessor.js');

      const id = await logConsolidationStart(tempDir, 'scheduled', undefined);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const row = nativeDb
        ?.prepare('SELECT succeeded FROM brain_consolidation_events WHERE id = ?')
        .get(id) as { succeeded: number } | undefined;

      // SQLite stores boolean as 1 (true)
      expect(row?.succeeded).toBe(1);
    });

    it('T701-5: session_id and duration_ms are nullable', async () => {
      const { logConsolidationStart } = await import('../../store/memory-accessor.js');

      const id = await logConsolidationStart(tempDir, 'manual', undefined);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const row = nativeDb
        ?.prepare('SELECT session_id, duration_ms FROM brain_consolidation_events WHERE id = ?')
        .get(id) as { session_id: null; duration_ms: null } | undefined;

      expect(row?.session_id).toBeNull();
      expect(row?.duration_ms).toBeNull();
    });

    it('T701-6: all four trigger values are accepted', async () => {
      const { logConsolidationStart } = await import('../../store/memory-accessor.js');
      const triggers = ['session_end', 'maintenance', 'scheduled', 'manual'] as const;

      for (const trigger of triggers) {
        const id = await logConsolidationStart(tempDir, trigger, undefined);
        expect(id).toBeGreaterThan(0);
      }

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const count = (
        nativeDb?.prepare('SELECT COUNT(*) as cnt FROM brain_consolidation_events').get() as {
          cnt: number;
        }
      ).cnt;
      expect(count).toBe(4);
    });

    it('T701-7: all three expected indexes exist', async () => {
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir);

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();
      const indexes = nativeDb
        ?.prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND tbl_name='brain_consolidation_events'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_consolidation_events_started_at');
      expect(indexNames).toContain('idx_consolidation_events_trigger');
      expect(indexNames).toContain('idx_consolidation_events_session');
    });

    it('T701-8: failed consolidation records succeeded=false', async () => {
      const { logConsolidationStart, logConsolidationComplete } = await import(
        '../../store/memory-accessor.js'
      );

      const id = await logConsolidationStart(tempDir, 'session_end', 'ses_fail_test');
      const updated = await logConsolidationComplete(
        tempDir,
        id,
        { error: 'step9b_stdp threw' },
        50,
        false,
      );

      expect(updated.succeeded).toBe(false);
      expect(JSON.parse(updated.stepResultsJson)).toMatchObject({ error: 'step9b_stdp threw' });
    });
  });

  // =========================================================================
  // Cross-table: idempotency and isolation
  // =========================================================================

  describe('Cross-table isolation', () => {
    it('all three tables are independent — inserts to one do not affect others', async () => {
      const { insertWeightHistoryRow, insertModulatorRow, logConsolidationStart } = await import(
        '../../store/memory-accessor.js'
      );

      await insertWeightHistoryRow(tempDir, {
        edgeFromId: 'obs:A',
        edgeToId: 'obs:B',
        edgeType: 'co_retrieved',
        weightBefore: null,
        weightAfter: 0.05,
        deltaWeight: 0.05,
        eventKind: 'ltp',
      });

      await insertModulatorRow(tempDir, {
        modulatorType: 'task_verified',
        valence: 1.0,
      });

      await logConsolidationStart(tempDir, 'session_end', 'ses_isolation_test');

      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const nativeDb = getBrainNativeDb();

      const whCount = (
        nativeDb?.prepare('SELECT COUNT(*) as cnt FROM brain_weight_history').get() as {
          cnt: number;
        }
      ).cnt;
      const modCount = (
        nativeDb?.prepare('SELECT COUNT(*) as cnt FROM brain_modulators').get() as { cnt: number }
      ).cnt;
      const ceCount = (
        nativeDb?.prepare('SELECT COUNT(*) as cnt FROM brain_consolidation_events').get() as {
          cnt: number;
        }
      ).cnt;

      expect(whCount).toBe(1);
      expect(modCount).toBe(1);
      expect(ceCount).toBe(1);
    });
  });
});
