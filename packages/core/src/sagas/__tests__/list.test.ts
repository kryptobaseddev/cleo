/**
 * Tests for `sagaList` (T10117) and `repairSaga` (T10117).
 *
 * Asserts:
 * - `sagaList()` returns ALL saga-labeled rows, including those with a
 *   non-null `parentId` (the 5 historically-hidden sagas surface again).
 * - Each I5-violating row emits a structured warning in `data.warnings[]`
 *   AND through the LAFS WarningCollector (`pushWarning`).
 * - When no I5 violators are present, the `warnings` array is omitted
 *   entirely (AC5: unchanged envelope shape for the well-formed case).
 * - `repairSaga()` is idempotent and:
 *     - clears `parentId` on the saga,
 *     - writes a `groups` edge from the former parent → the saga,
 *     - returns `repaired: false` on a second invocation.
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
import { resetDbState } from '../../store/sqlite.js';
import { E_SAGA_INVARIANT_VIOLATION_I5 } from '../enforcement.js';
import { sagaList } from '../list.js';
import { repairSaga } from '../repair.js';

/**
 * Five saga task IDs that the historical `!parentId` filter hid in the
 * production database (per T10117 dispatch contract). The test fixture
 * mirrors that shape by assigning each a non-null `parentId`.
 */
const HIDDEN_SAGAS = ['T9855', 'T9862', 'T9863', 'T9977', 'T10099'] as const;

/** Two well-formed sagas (no parentId) to exercise the happy path. */
const WELL_FORMED_SAGAS = ['T9831', 'T10113'] as const;

/**
 * Seed the 5 historically-hidden sagas (with non-null parentId) and a
 * matching set of "former parent" rows so the I5-violation shape is
 * fully realised. Returns a map of sagaId → former parentId.
 */
async function seedHiddenSagas(accessor: DataAccessor): Promise<Record<string, string>> {
  const now = new Date().toISOString();
  // Each former-parent must exist as a task row so FK constraints pass.
  const formerParents = HIDDEN_SAGAS.map((id, idx) => ({
    id: `T${9000 + idx}`,
    title: `Former parent for ${id}`,
    status: 'pending' as const,
    priority: 'medium' as const,
    type: 'epic' as const,
    createdAt: now,
  }));
  const sagas = HIDDEN_SAGAS.map((id, idx) => ({
    id,
    title: `Hidden saga ${id}`,
    status: 'active' as const,
    priority: 'high' as const,
    type: 'epic' as const,
    labels: ['saga'],
    parentId: formerParents[idx]?.id,
    createdAt: now,
  }));
  await seedTasks(accessor, [...formerParents, ...sagas]);
  const mapping: Record<string, string> = {};
  for (let i = 0; i < HIDDEN_SAGAS.length; i++) {
    const sagaId = HIDDEN_SAGAS[i];
    const parent = formerParents[i];
    if (sagaId && parent) {
      mapping[sagaId] = parent.id;
    }
  }
  return mapping;
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
      type: 'epic' as const,
      labels: ['saga'],
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
    resetDbState();
    await env.cleanup();
  });

  it('returns ALL saga-labeled rows including those with non-null parentId (AC1)', async () => {
    await seedWellFormedSagas(accessor);
    await seedHiddenSagas(accessor);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sagaIds = result.data.sagas.map((s) => s.id).sort();
    // 2 well-formed + 5 hidden = 7 sagas total
    expect(result.data.total).toBe(7);
    expect(sagaIds).toEqual([...WELL_FORMED_SAGAS, ...HIDDEN_SAGAS].sort());
  });

  it('includes each previously-hidden saga (T9855, T9862, T9863, T9977, T10099) (AC1)', async () => {
    await seedHiddenSagas(accessor);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const sagaIds = new Set(result.data.sagas.map((s) => s.id));
    for (const hidden of HIDDEN_SAGAS) {
      expect(sagaIds.has(hidden)).toBe(true);
    }
  });

  it('emits one structured I5 warning per saga with non-null parentId (AC2/AC4)', async () => {
    const parentMap = await seedHiddenSagas(accessor);

    const result = await sagaList(env.tempDir);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.warnings).toBeDefined();
    expect(result.data.warnings).toHaveLength(HIDDEN_SAGAS.length);
    const warningBySaga = new Map((result.data.warnings ?? []).map((w) => [w.sagaId, w]));
    for (const hidden of HIDDEN_SAGAS) {
      const entry = warningBySaga.get(hidden);
      expect(entry).toBeDefined();
      expect(entry?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I5);
      expect(entry?.offendingParentId).toBe(parentMap[hidden]);
    }
  });

  it('pushes I5 warnings into the active WarningCollector (LAFS envelope path)', async () => {
    await seedHiddenSagas(accessor);

    const collector = new WarningCollector();
    await withWarningCollector(collector, async () => {
      const result = await sagaList(env.tempDir);
      expect(result.success).toBe(true);
    });

    const drained = collector.drain();
    expect(drained).toBeDefined();
    expect(drained).toHaveLength(HIDDEN_SAGAS.length);
    for (const warning of drained ?? []) {
      expect(warning.code).toBe(E_SAGA_INVARIANT_VIOLATION_I5);
      const context = warning.context as
        | { sagaId?: string; offendingParentId?: string }
        | undefined;
      expect(context?.sagaId).toBeDefined();
      expect(context?.offendingParentId).toBeDefined();
    }
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
      type: 'epic' as const,
      labels: ['saga'],
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
    resetDbState();
    await env.cleanup();
  });

  it("detaches parentId and writes task_relations.type='groups' edge", async () => {
    const parentMap = await seedHiddenSagas(accessor);
    const sagaId = 'T9855';
    const formerParent = parentMap[sagaId];
    expect(formerParent).toBeDefined();
    if (!formerParent) return;

    const result = await repairSaga(env.tempDir, { sagaId });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.repaired).toBe(true);
    expect(result.data.detachedParentId).toBe(formerParent);
    expect(result.data.attachedRelation).toEqual({
      from: formerParent,
      to: sagaId,
      type: 'groups',
    });

    // Verify on-disk: saga has no parentId; parent has a groups edge to saga.
    const repaired = await accessor.loadSingleTask(sagaId);
    expect(repaired?.parentId ?? null).toBeNull();
    const parent = await accessor.loadSingleTask(formerParent);
    const groupsEdges = (parent?.relates ?? []).filter(
      (r) => r.type === 'groups' && r.taskId === sagaId,
    );
    expect(groupsEdges).toHaveLength(1);
  });

  it('is idempotent: a second call on the same saga reports repaired=false', async () => {
    await seedHiddenSagas(accessor);
    const sagaId = 'T9855';

    const first = await repairSaga(env.tempDir, { sagaId });
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.repaired).toBe(true);

    const second = await repairSaga(env.tempDir, { sagaId });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.repaired).toBe(false);
    expect(second.data.detachedParentId).toBeNull();
    expect(second.data.attachedRelation).toBeNull();
  });

  it('returns E_NOT_FOUND when sagaId does not exist', async () => {
    await seedWellFormedSagas(accessor);

    const result = await repairSaga(env.tempDir, { sagaId: 'T0000-MISSING' });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_NOT_FOUND');
  });

  it("returns E_INVALID_INPUT when the target is not a saga (label!='saga')", async () => {
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
