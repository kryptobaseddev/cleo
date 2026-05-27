/**
 * Tests for `sagaList` (T10117) and `repairSaga` (T10117).
 *
 * Asserts:
 * - `sagaList()` returns all `type='saga'` rows, including the saga IDs that
 *   were historically hidden by the legacy label/parent filter.
 * - Canonical saga rows have no `parentId`, so no I5 warnings are emitted.
 * - When no I5 violators are present, the `warnings` array is omitted
 *   entirely (AC5: unchanged envelope shape for the well-formed case).
 * - `repairSaga()` is idempotent and:
 *     - leaves canonical root sagas untouched,
 *     - never writes legacy `groups` edges,
 *     - returns `repaired: false` for already-canonical rows.
 *
 * @task T10117
 * @saga T10113
 * @epic T10209
 * @see ADR-073-above-epic-naming.md §1.2 — invariant I5
 */

import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { sagaList } from '../list.js';
import { repairSaga } from '../repair.js';

/**
 * Five saga task IDs that the historical `!parentId` filter hid in the
 * production database (per T10117 dispatch contract). They are now canonical
 * root `type='saga'` rows because the DB parent-type trigger rejects sagas
 * with a non-null `parentId`.
 */
const HIDDEN_SAGAS = ['T9855', 'T9862', 'T9863', 'T9977', 'T10099'] as const;

/** Two well-formed sagas (no parentId) to exercise the happy path. */
const WELL_FORMED_SAGAS = ['T9831', 'T10113'] as const;

/**
 * Seed the 5 historically-hidden saga IDs as canonical root Saga rows.
 */
async function seedFormerlyHiddenSagas(accessor: DataAccessor): Promise<void> {
  const now = new Date().toISOString();
  const sagas = HIDDEN_SAGAS.map((id) => ({
    id,
    title: `Hidden saga ${id}`,
    status: 'active' as const,
    priority: 'high' as const,
    type: 'saga' as const,
    createdAt: now,
  }));
  await seedTasks(accessor, sagas);
}

/** Seed well-formed sagas (no parentId). */
async function seedWellFormedSagas(accessor: DataAccessor): Promise<void> {
  const now = new Date().toISOString();
  await seedTasks(
    accessor,
    WELL_FORMED_SAGAS.map((id) => ({
      id,
      title: `Well-formed saga ${id}`,
      status: 'active' as const,
      priority: 'high' as const,
      type: 'saga' as const,
      createdAt: now,
    })),
  );
}

describe('sagaList (T10117)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await env.cleanup();
  });

  it('returns all canonical saga rows including historically hidden saga IDs (AC1)', async () => {
    await seedWellFormedSagas(accessor);
    await seedFormerlyHiddenSagas(accessor);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sagaIds = result.data.sagas.map((s) => s.id).sort();
    // 2 well-formed + 5 historically hidden = 7 sagas total
    expect(result.data.total).toBe(7);
    expect(sagaIds).toEqual([...WELL_FORMED_SAGAS, ...HIDDEN_SAGAS].sort());
  });

  it('includes each previously hidden saga (T9855, T9862, T9863, T9977, T10099) (AC1)', async () => {
    await seedFormerlyHiddenSagas(accessor);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sagaIds = new Set(result.data.sagas.map((s) => s.id));
    for (const hidden of HIDDEN_SAGAS) {
      expect(sagaIds.has(hidden)).toBe(true);
    }
  });

  it('omits I5 warnings for canonical formerly hidden sagas', async () => {
    await seedFormerlyHiddenSagas(accessor);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.total).toBe(HIDDEN_SAGAS.length);
    expect(result.data.warnings).toBeUndefined();
  });

  it('does not push I5 warnings into the active WarningCollector for canonical rows', async () => {
    await seedFormerlyHiddenSagas(accessor);

    const collector = new WarningCollector();
    await withWarningCollector(collector, async () => {
      const result = await sagaList(env.tempDir);
      expect(result.success).toBe(true);
    });

    const drained = collector.drain();
    expect(drained ?? []).toHaveLength(0);
  });

  it('omits the warnings array when no I5 violators are present (AC5)', async () => {
    await seedWellFormedSagas(accessor);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.total).toBe(WELL_FORMED_SAGAS.length);
    // AC5: pre-T10117 envelope shape preserved — no `warnings` field at all.
    expect(result.data.warnings).toBeUndefined();
  });

  it('returns an empty payload when no sagas exist', async () => {
    // No seeded sagas at all.
    await seedTasks(accessor, []);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.sagas).toHaveLength(0);
    expect(result.data.total).toBe(0);
    expect(result.data.warnings).toBeUndefined();
  });

  it('returns more than the default taskList limit (10) when many sagas exist (T10236)', async () => {
    // Seed 25 well-formed sagas to exceed the historical default limit of 10
    // that was silently truncating sagaList output in production (T10236).
    const now = new Date().toISOString();
    const manySagas = Array.from({ length: 25 }, (_, idx) => ({
      id: `T${20000 + idx}`,
      title: `Bulk saga ${idx}`,
      status: 'active' as const,
      priority: 'high' as const,
      type: 'saga' as const,
      createdAt: now,
    }));
    await seedTasks(accessor, manySagas);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    // The bug was: total=10 (silent default-limit truncation). Fix returns all 25.
    expect(result.data.total).toBe(25);
    expect(result.data.sagas).toHaveLength(25);
    const seededIds = new Set(manySagas.map((s) => s.id));
    const returnedIds = new Set(result.data.sagas.map((s) => s.id));
    for (const id of seededIds) {
      expect(returnedIds.has(id)).toBe(true);
    }
  });
});

describe('repairSaga (T10117) — AC3', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await env.cleanup();
  });

  it('leaves canonical sagas untouched without writing legacy groups edges', async () => {
    await seedFormerlyHiddenSagas(accessor);
    const sagaId = 'T9855';

    const result = await repairSaga(env.tempDir, { sagaId });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.repaired).toBe(false);
    expect(result.data.detachedParentId).toBeNull();

    // Verify on-disk: saga has no parentId; no legacy relation is written.
    const repaired = await accessor.loadSingleTask(sagaId);
    expect(repaired?.parentId ?? null).toBeNull();
    expect(repaired?.relates?.filter((r) => r.type === 'groups')).toHaveLength(0);
  });

  it('is idempotent: a second call on the same saga reports repaired=false', async () => {
    await seedFormerlyHiddenSagas(accessor);
    const sagaId = 'T9855';

    const first = await repairSaga(env.tempDir, { sagaId });
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.repaired).toBe(false);

    const second = await repairSaga(env.tempDir, { sagaId });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.repaired).toBe(false);
    expect(second.data.detachedParentId).toBeNull();
  });

  it('returns E_NOT_FOUND when sagaId does not exist', async () => {
    await seedWellFormedSagas(accessor);

    const result = await repairSaga(env.tempDir, { sagaId: 'T0000-MISSING' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_NOT_FOUND');
  });

  it("returns E_INVALID_INPUT when the target is not a saga (type!='saga')", async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'T9900',
        title: 'Plain epic',
        status: 'active',
        priority: 'high',
        type: 'epic',
        createdAt: now,
      },
    ]);

    const result = await repairSaga(env.tempDir, { sagaId: 'T9900' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });

  it('returns E_INVALID_INPUT when sagaId is empty', async () => {
    const result = await repairSaga(env.tempDir, { sagaId: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });
});
