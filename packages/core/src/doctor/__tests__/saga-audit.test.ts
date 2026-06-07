/**
 * Tests for `auditSagaHierarchy` (T10119).
 *
 * Covers the four detection branches:
 *
 *   1. Clean saga — zero violations + zero drift.
 *   2. I5 violation — saga row has a non-null `parentId`.
 *   3. I7 violation — a saga-member candidate carries `label='saga'`.
 *   4. auto-close-drift — all members done but saga still pending
 *      (`count` stays at 0; `driftCount` rises). T10116 fixes the root
 *      cause; this branch becomes a regression detector once that ships.
 *
 * Tests insert tasks directly into a real in-process SQLite tasks.db
 * via the same `getDb` + `getNativeDb` surface used by the rest of the
 * core doctor tests.
 *
 * @task T10119
 * @saga T10113
 * @epic T10209
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

interface NativeDbForTest {
  prepare: (sql: string) => {
    run: (...args: (string | number | null)[]) => void;
    get: (...args: (string | number | null)[]) => unknown;
  };
  exec: (sql: string) => void;
}

/**
 * Neutralize the PM-Core V2 structural guards that would reject the
 * DELIBERATELY invariant-violating rows this audit test must seed (a saga with
 * a parent for I5, a saga contained by another saga for I7). The audit's whole
 * purpose is to detect such malformed data — which can pre-date the guards or
 * arrive via a migration — so the fixture must be able to materialize it.
 *
 * Drops the parent-type-matrix triggers and disables CHECK-constraint
 * enforcement (incl. `chk_tasks_saga_no_parent`) on this connection. (T11280)
 */
function neutralizeSagaStructuralGuards(db: NativeDbForTest): void {
  db.exec('DROP TRIGGER IF EXISTS tasks_parent_type_matrix_insert');
  db.exec('DROP TRIGGER IF EXISTS tasks_parent_type_matrix_update');
  // T11884: the invariant guards were restored on the PREFIXED runtime table
  // (`tasks_tasks`) that this fixture actually writes to — the bare-table drops
  // above are now no-ops, so the prefixed-table guards must be dropped here too.
  db.exec('DROP TRIGGER IF EXISTS tasks_tasks_parent_type_matrix_insert');
  db.exec('DROP TRIGGER IF EXISTS tasks_tasks_parent_type_matrix_update');

  // Disable CHECK-constraint enforcement (incl. chk_tasks_saga_no_parent) on
  // THIS connection so the audit fixtures can seed deliberately
  // invariant-violating rows (a saga with a parent for I5, a saga inside a saga
  // for I7). Replaces the former `PRAGMA writable_schema=ON; UPDATE
  // sqlite_master …` schema surgery, which node:sqlite @ SQLite 3.53.0 rejects
  // with "table sqlite_master may not be modified" — DEFENSIVE mode blocks
  // sqlite_master writes even under writable_schema=ON. `ignore_check_constraints`
  // is version-agnostic and needs no schema mutation. (node:sqlite 3.53.0 — 6620e8e96.)
  db.exec('PRAGMA ignore_check_constraints=ON');
}

/**
 * Insert a single task row directly. Bypasses the higher-level `taskAdd`
 * path so the test can construct exactly the shape it wants (including
 * deliberately invariant-breaking rows for I5 / I7).
 *
 * `pipeline_stage` is set to `'contribution'` whenever `status='done'` so
 * the T877 status/pipeline_stage invariant trigger does not fire — the
 * audit under test cares about saga structure, not lifecycle bookkeeping.
 */
function insertTask(
  db: NativeDbForTest,
  row: {
    id: string;
    title: string;
    type: 'saga' | 'epic' | 'task' | 'subtask';
    status?: 'pending' | 'active' | 'done' | 'blocked';
    parentId?: string | null;
    labels?: string[];
  },
): void {
  const status = row.status ?? 'pending';
  const pipelineStage = status === 'done' ? 'contribution' : null;
  db.prepare(
    'INSERT INTO tasks_tasks (id, title, type, status, parent_id, labels_json, pipeline_stage) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.title,
    row.type,
    status,
    row.parentId ?? null,
    JSON.stringify(row.labels ?? []),
    pipelineStage,
  );
}

/**
 * Link a member into a saga via `parent_id` containment. PM-Core V2 (T10638)
 * resolves saga membership through `parent_id` (saga→epic), not the legacy
 * `task_relations.type='groups'` edge. Requires the matrix triggers to be
 * dropped first when the member would violate the type matrix (e.g. nested
 * saga for the I7 case).
 */
function linkMember(db: NativeDbForTest, sagaId: string, memberId: string): void {
  db.prepare('UPDATE tasks_tasks SET parent_id = ? WHERE id = ?').run(sagaId, memberId);
}

describe('auditSagaHierarchy (T10119)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-saga-audit-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    // Initialize tasks.db, then neutralize the PM-Core V2 structural guards so
    // the fixtures can seed deliberately invariant-violating rows for the audit.
    const { getDb, getNativeDb } = await import('../../store/sqlite.js');
    await getDb(tempDir);
    const nativeDb = getNativeDb() as NativeDbForTest | null;
    if (nativeDb) neutralizeSagaStructuralGuards(nativeDb);
  });

  afterEach(async () => {
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('returns empty result when no sagas exist', async () => {
    const { auditSagaHierarchy } = await import('../saga-audit.js');
    const result = await auditSagaHierarchy(tempDir);
    expect(result.sagas).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.driftCount).toBe(0);
  });

  it('reports zero violations for a clean saga with valid members', async () => {
    const { getNativeDb } = await import('../../store/sqlite.js');
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    // Clean saga + one normal Epic member.
    insertTask(db, { id: 'T9301', title: 'Clean Saga', type: 'saga' });
    insertTask(db, { id: 'T9311', title: 'Member Epic', type: 'epic' });
    linkMember(db, 'T9301', 'T9311');

    const { auditSagaHierarchy } = await import('../saga-audit.js');
    const result = await auditSagaHierarchy(tempDir);

    expect(result.sagas).toHaveLength(1);
    expect(result.sagas[0]?.sagaId).toBe('T9301');
    expect(result.sagas[0]?.violations).toEqual([]);
    expect(result.sagas[0]?.memberCount).toBe(1);
    expect(result.count).toBe(0);
    expect(result.driftCount).toBe(0);
  });

  it('detects I5 violation when saga has a non-null parentId', async () => {
    const { getNativeDb } = await import('../../store/sqlite.js');
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    insertTask(db, { id: 'T9390', title: 'Parent Epic', type: 'epic' });
    insertTask(db, {
      id: 'T9302',
      title: 'Saga with parent',
      type: 'saga',
      parentId: 'T9390',
    });

    const { auditSagaHierarchy } = await import('../saga-audit.js');
    const result = await auditSagaHierarchy(tempDir);

    const sg002 = result.sagas.find((s) => s.sagaId === 'T9302');
    expect(sg002).toBeDefined();
    const i5 = sg002?.violations.find((v) => v.kind === 'I5');
    expect(i5).toBeDefined();
    expect(i5?.offendingId).toBe('T9302');
    expect(i5?.message).toContain('I5');
    expect(i5?.message).toContain('T9390');
    expect(i5?.repairCommand).toBe('cleo saga repair T9302');
    expect(result.count).toBeGreaterThanOrEqual(1);
  });

  it('detects I7 violation when a saga member is itself a saga', async () => {
    const { getNativeDb } = await import('../../store/sqlite.js');
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    insertTask(db, { id: 'T9303', title: 'Outer Saga', type: 'saga' });
    // Nested saga — invariant I7 violation (a saga member that is itself a saga).
    insertTask(db, { id: 'T93031', title: 'Inner Saga', type: 'saga' });
    linkMember(db, 'T9303', 'T93031');

    const { auditSagaHierarchy } = await import('../saga-audit.js');
    const result = await auditSagaHierarchy(tempDir);

    const outer = result.sagas.find((s) => s.sagaId === 'T9303');
    expect(outer).toBeDefined();
    const i7 = outer?.violations.find((v) => v.kind === 'I7');
    expect(i7).toBeDefined();
    expect(i7?.offendingId).toBe('T93031');
    expect(i7?.message).toContain('I7');
    expect(i7?.message).toContain('T93031');
    expect(i7?.repairCommand).toBe('cleo saga detach T9303 T93031');
  });

  it('detects auto-close drift when all members done but saga pending', async () => {
    const { getNativeDb } = await import('../../store/sqlite.js');
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    insertTask(db, {
      id: 'T9304',
      title: 'Drifting Saga',
      type: 'saga',
      status: 'pending',
    });
    insertTask(db, { id: 'T9321', title: 'Member 1', type: 'epic', status: 'done' });
    insertTask(db, { id: 'T9322', title: 'Member 2', type: 'epic', status: 'done' });
    linkMember(db, 'T9304', 'T9321');
    linkMember(db, 'T9304', 'T9322');

    const { auditSagaHierarchy } = await import('../saga-audit.js');
    const result = await auditSagaHierarchy(tempDir);

    const drifting = result.sagas.find((s) => s.sagaId === 'T9304');
    expect(drifting).toBeDefined();
    expect(drifting?.memberCount).toBe(2);
    expect(drifting?.doneCount).toBe(2);

    const drift = drifting?.violations.find((v) => v.kind === 'auto-close-drift');
    expect(drift).toBeDefined();
    expect(drift?.message).toContain('2/2 members done');
    expect(drift?.message).toContain('status=pending');
    expect(drift?.repairCommand).toBe('cleo saga reconcile T9304');

    // Auto-close-drift is a soft warning — it does NOT count toward the
    // hard `count` total (only I5/I7/depth do).
    expect(result.driftCount).toBe(1);
    expect(result.count).toBe(0);
  });

  it('does NOT flag auto-close drift when saga.status=done matches members', async () => {
    const { getNativeDb } = await import('../../store/sqlite.js');
    const db = getNativeDb() as NativeDbForTest | null;
    if (!db) throw new Error('nativeDb not initialized');

    insertTask(db, {
      id: 'T9305',
      title: 'Closed Saga',
      type: 'saga',
      status: 'done',
    });
    insertTask(db, { id: 'T9323', title: 'Member 3', type: 'epic', status: 'done' });
    linkMember(db, 'T9305', 'T9323');

    const { auditSagaHierarchy } = await import('../saga-audit.js');
    const result = await auditSagaHierarchy(tempDir);

    const closed = result.sagas.find((s) => s.sagaId === 'T9305');
    expect(closed?.violations.find((v) => v.kind === 'auto-close-drift')).toBeUndefined();
    expect(result.driftCount).toBe(0);
  });
});
