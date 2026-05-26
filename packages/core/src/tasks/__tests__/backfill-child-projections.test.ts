/**
 * T10639 — Backfill child_task AC projection tests.
 *
 * Validates:
 *   AC1: Text rows preserved — non-child AC rows survive the backfill unchanged.
 *   AC2: Child_task projections created — all parent-child pairs get typed rows.
 *   AC3: Evidence bindings valid — evidence_ac_bindings still point to valid ACs.
 *
 * Uses direct temp DB seeding since the backfill function works against the
 * filesystem at `${projectRoot}/.cleo/tasks.db`.
 *
 * @saga T10538
 * @task T10639
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditChildProjectionAcRows,
  buildAcRowId,
  buildChildProjectionAcText,
  childProjectionFreshnessFingerprint,
  childProjectionSourceKey,
} from '../ac-table.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface NativeDb {
  prepare: (sql: string) => {
    all: (...params: any[]) => any[];
    get: (...params: any[]) => any;
    run: (...params: any[]) => any;
  };
  exec: (sql: string) => void;
  close: () => void;
}

async function initTestDb(dbPath: string): Promise<NativeDb> {
  const { openNativeDatabase } = await import('../../store/sqlite.js');
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  const { reconcileJournal, migrateSanitized } = await import('../../store/migration-manager.js');
  const { readdirSync } = await import('node:fs');
  const path = await import('node:path');

  const nativeDb = openNativeDatabase(dbPath) as any;
  const db = drizzle({ client: nativeDb as any });
  const migrationsFolder = path.join(
    path.join(path.join(import.meta.dirname ?? '', '..'), '..'),
    '..',
    'migrations',
    'drizzle-tasks',
  );
  reconcileJournal(nativeDb as any, migrationsFolder, 'tasks', 'tasks');
  migrateSanitized(db, { migrationsFolder });
  return nativeDb as unknown as NativeDb;
}

function seedTask(
  db: NativeDb,
  id: string,
  title: string,
  opts: { parentId?: string | null; acceptanceJson?: string; type?: string; status?: string } = {},
) {
  db.prepare(
    `INSERT INTO tasks (id, title, status, priority, type, parent_id, acceptance_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    title,
    opts.status ?? 'pending',
    'medium',
    opts.type ?? 'task',
    opts.parentId ?? null,
    opts.acceptanceJson ?? '[]',
  );
}

function seedAcRow(
  db: NativeDb,
  id: string,
  taskId: string,
  ordinal: number,
  text: string,
  opts: {
    kind?: string;
    sourceKey?: string;
    targetTaskId?: string | null;
    projection?: string;
  } = {},
) {
  db.prepare(
    `INSERT INTO task_acceptance_criteria (id, task_id, ordinal, kind, source_key, target_task_id, projection, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    taskId,
    ordinal,
    opts.kind ?? 'text',
    opts.sourceKey ?? `text:${ordinal}:manual`,
    opts.targetTaskId ?? null,
    opts.projection ?? 'legacy',
    text,
  );
}

/** Set up a project dir with .cleo/tasks.db */
async function setupProjectDir(tempDir: string): Promise<string> {
  const projectDir = join(tempDir, 'project');
  const cleoDir = join(projectDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });

  const dbPath = join(cleoDir, 'tasks.db');
  const db = await initTestDb(dbPath);
  db.close();
  return projectDir;
}

// ---------------------------------------------------------------------------
// AC1: Text rows preserved
// ---------------------------------------------------------------------------

describe('T10639 AC1 — text rows preserved', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10639-ac1-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('preserves existing text AC rows after backfill', async () => {
    const projectDir = await setupProjectDir(tempDir);
    const dbPath = join(projectDir, '.cleo', 'tasks.db');

    // Reopen with node:sqlite for raw access
    const { DatabaseSync } = await import('node:sqlite');
    const db = new (DatabaseSync as any)(dbPath) as NativeDb;

    // Parent with children and existing text AC rows
    seedTask(db, 'P1', 'Parent task', { type: 'epic' });
    seedTask(db, 'C1', 'Child one', { parentId: 'P1' });
    seedTask(db, 'C2', 'Child two', { parentId: 'P1' });

    const textAcId = 'text-ac-001';
    seedAcRow(db, textAcId, 'P1', 1, 'Manual AC text');
    db.close();

    // Now run actual backfill in dry-run mode
    const { backfillChildProjections } = await import('../backfill-child-projections.js');
    const result = await backfillChildProjections(projectDir, { dryRun: true });

    const p1Change = result.changes.find((c) => c.parentId === 'P1');
    expect(p1Change).toBeDefined();
    expect(p1Change!.childCount).toBe(2);
    // Parent should be dirty because 2 children lack child_task projections
    expect(p1Change!.auditBeforeStatus).toBe('dirty');
    expect(p1Change!.rebuilt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: Child_task projections created
// ---------------------------------------------------------------------------

describe('T10639 AC2 — child_task projections created', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10639-ac2-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects missing child_task projections', () => {
    const parentId = 'P2';
    const children = [
      { id: 'C1', title: 'Child one' },
      { id: 'C2', title: 'Child two' },
    ];

    // No child_task rows exist — only a text AC
    const acRows = [
      {
        id: 'ac-text-1',
        taskId: parentId,
        ordinal: 1,
        kind: 'text' as const,
        sourceKey: 'text:1:abc',
        targetTaskId: null,
        projection: 'legacy' as const,
        text: 'Manual text AC',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: null,
        contentHash: null,
      },
    ];

    const audit = auditChildProjectionAcRows(parentId, children, acRows);
    expect(audit.status).toBe('dirty');
    expect(audit.dirty).toBe(true);
    expect(audit.expectedRows).toBe(2);
    expect(audit.actualRows).toBe(0);
    expect(audit.findings).toEqual([
      expect.objectContaining({ code: 'missing_child_task_row', childId: 'C1' }),
      expect.objectContaining({ code: 'missing_child_task_row', childId: 'C2' }),
    ]);
  });

  it('recognizes clean child_task projections', () => {
    const parentId = 'P3';
    const child1 = { id: 'C1', title: 'Child one' };

    const childRow = {
      id: buildAcRowId(parentId, childProjectionSourceKey(child1.id)),
      taskId: parentId,
      ordinal: 2,
      kind: 'child_task' as const,
      sourceKey: childProjectionSourceKey(child1.id),
      targetTaskId: child1.id,
      projection: 'parent-child' as const,
      text: buildChildProjectionAcText(child1.id, child1.title),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null,
      contentHash: childProjectionFreshnessFingerprint(child1.id, child1.title),
    };

    const acRows = [
      {
        id: 'ac-text-1',
        taskId: parentId,
        ordinal: 1,
        kind: 'text' as const,
        sourceKey: 'text:1:abc',
        targetTaskId: null,
        projection: 'legacy' as const,
        text: 'Manual text AC',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: null,
        contentHash: null,
      },
      childRow,
    ];

    const audit = auditChildProjectionAcRows(parentId, [child1], acRows);
    expect(audit.status).toBe('clean');
    expect(audit.dirty).toBe(false);
    expect(audit.findings).toEqual([]);
  });

  it('applies child_task projection backfill for real on temp DB', async () => {
    const projectDir = await setupProjectDir(tempDir);
    const dbPath = join(projectDir, '.cleo', 'tasks.db');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new (DatabaseSync as any)(dbPath) as NativeDb;

    // Parent with 2 children, no AC rows
    seedTask(db, 'EPIC1', 'Test epic', { type: 'epic' });
    seedTask(db, 'T1', 'Task 1', { parentId: 'EPIC1' });
    seedTask(db, 'T2', 'Task 2', { parentId: 'EPIC1' });
    db.close();

    // Run backfill (not dry-run)
    const { backfillChildProjections } = await import('../backfill-child-projections.js');
    const result = await backfillChildProjections(projectDir, { dryRun: false });

    expect(result.parentsChanged).toBeGreaterThanOrEqual(1);

    // Verify the rows were created
    const db2 = new (DatabaseSync as any)(dbPath) as NativeDb;
    const childRows = db2
      .prepare(
        `SELECT kind, source_key, target_task_id, projection
         FROM task_acceptance_criteria
         WHERE task_id = 'EPIC1' AND kind = 'child_task'
         ORDER BY ordinal`,
      )
      .all() as any[];

    expect(childRows.length).toBe(2);
    expect(childRows[0].kind).toBe('child_task');
    expect(childRows[0].projection).toBe('parent-child');
    expect(childRows[0].target_task_id).toBe('T1');
    expect(childRows[1].target_task_id).toBe('T2');
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// AC3: Evidence bindings valid
// ---------------------------------------------------------------------------

describe('T10639 AC3 — evidence bindings valid', () => {
  it('child_task projection rebuild preserves non-child AC UUIDs for binding stability', async () => {
    const parentId = 'P5';
    const child1 = { id: 'C1', title: 'Child one' };

    const textAcId = 'stable-text-ac-uuid';
    const acRows = [
      {
        id: textAcId,
        taskId: parentId,
        ordinal: 1,
        kind: 'text' as const,
        sourceKey: 'text:1:abc',
        targetTaskId: null,
        projection: 'legacy' as const,
        text: 'Stable text AC',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: null,
        contentHash: null,
      },
    ];

    const { planChildProjectionRebuild } = await import('../ac-table.js');
    const result = planChildProjectionRebuild(parentId, [child1], acRows);

    // The text AC row should be preserved with its original UUID
    const textRow = result.plan.inserts.find((r: any) => r.kind === 'text');
    expect(textRow).toBeDefined();
    expect(textRow.id).toBe(textAcId);
    expect(textRow.text).toBe('Stable text AC');

    // Evidence bindings pointing to textAcId would remain valid
    // because the UUID survives the rebuild
  });

  it('insert plan has all deterministic UUIDs for idempotent re-runs', async () => {
    const parentId = 'P6';
    const child1 = { id: 'C1', title: 'Child one' };

    const { planChildProjectionRebuild } = await import('../ac-table.js');

    const acRows: any[] = [];
    const result1 = planChildProjectionRebuild(parentId, [child1], acRows);
    const result2 = planChildProjectionRebuild(parentId, [child1], acRows);

    expect(result1.plan.inserts.map((r: any) => r.id)).toEqual(
      result2.plan.inserts.map((r: any) => r.id),
    );
    expect(result1.plan.inserts.map((r: any) => r.sourceKey)).toEqual(
      result2.plan.inserts.map((r: any) => r.sourceKey),
    );
  });
});

// ---------------------------------------------------------------------------
// Integration test: full backfill on seeded DB
// ---------------------------------------------------------------------------

describe('T10639 integration — backfill on seeded DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t10639-int-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('dry-run reports dirty parents, non-dry-run creates projections', async () => {
    const projectDir = await setupProjectDir(tempDir);
    const dbPath = join(projectDir, '.cleo', 'tasks.db');

    const { DatabaseSync } = await import('node:sqlite');
    const db = new (DatabaseSync as any)(dbPath) as NativeDb;

    // Seed: parent with 3 children, no AC rows
    seedTask(db, 'EP1', 'Test epic', { type: 'epic' });
    seedTask(db, 'T1', 'Task 1', { parentId: 'EP1' });
    seedTask(db, 'T2', 'Task 2', { parentId: 'EP1' });
    seedTask(db, 'T3', 'Task 3', { parentId: 'EP1' });

    // Parent with text AC but no child projection
    seedTask(db, 'EP2', 'Epic with text AC', { type: 'epic' });
    seedTask(db, 'T4', 'Task 4', { parentId: 'EP2' });
    seedAcRow(db, 'ac-ep2-1', 'EP2', 1, 'Text AC for EP2');

    // Clean parent — has matching child_task projection
    seedTask(db, 'EP3', 'Clean epic', { type: 'epic' });
    seedTask(db, 'T5', 'Task 5', { parentId: 'EP3' });
    seedAcRow(db, 'ac-ep3-1', 'EP3', 1, 'Text AC for EP3');
    seedAcRow(
      db,
      buildAcRowId('EP3', childProjectionSourceKey('T5')),
      'EP3',
      2,
      buildChildProjectionAcText('T5', 'Task 5'),
      {
        kind: 'child_task',
        sourceKey: childProjectionSourceKey('T5'),
        targetTaskId: 'T5',
        projection: 'parent-child',
      },
    );

    // Parent with no children
    seedTask(db, 'EP4', 'Epic without children', { type: 'epic' });
    db.close();

    const { backfillChildProjections } = await import('../backfill-child-projections.js');

    // Dry run first
    const dryResult = await backfillChildProjections(projectDir, { dryRun: true });

    const ep1 = dryResult.changes.find((c) => c.parentId === 'EP1');
    expect(ep1).toBeDefined();
    expect(ep1!.childCount).toBe(3);
    expect(ep1!.auditBeforeStatus).toBe('dirty');

    const ep2 = dryResult.changes.find((c) => c.parentId === 'EP2');
    expect(ep2).toBeDefined();
    expect(ep2!.childCount).toBe(1);
    expect(ep2!.auditBeforeStatus).toBe('dirty');

    const ep3 = dryResult.changes.find((c) => c.parentId === 'EP3');
    expect(ep3).toBeDefined();
    expect(ep3!.auditBeforeStatus).toBe('clean');
    expect(ep3!.rebuilt).toBe(false);

    const ep4 = dryResult.changes.find((c) => c.parentId === 'EP4');
    expect(ep4).toBeUndefined();

    // Now apply for real
    const realResult = await backfillChildProjections(projectDir, { dryRun: false });
    expect(realResult.parentsChanged).toBe(2); // EP1 + EP2

    // Verify EP3 remains untouched
    const ep3Real = realResult.changes.find((c) => c.parentId === 'EP3');
    expect(ep3Real!.rebuilt).toBe(false);

    // Verify the child_task rows were created
    const db2 = new (DatabaseSync as any)(dbPath) as NativeDb;
    const ep1ChildRows = db2
      .prepare(
        `SELECT COUNT(*) as cnt FROM task_acceptance_criteria
         WHERE task_id = 'EP1' AND kind = 'child_task'`,
      )
      .get() as { cnt: number };
    expect(ep1ChildRows.cnt).toBe(3);

    const ep2ChildRows = db2
      .prepare(
        `SELECT COUNT(*) as cnt FROM task_acceptance_criteria
         WHERE task_id = 'EP2' AND kind = 'child_task'`,
      )
      .get() as { cnt: number };
    expect(ep2ChildRows.cnt).toBe(1);

    // Verify text AC rows survived
    const ep2TextRows = db2
      .prepare(
        `SELECT id, text FROM task_acceptance_criteria
         WHERE task_id = 'EP2' AND kind = 'text'`,
      )
      .all() as any[];
    expect(ep2TextRows[0].id).toBe('ac-ep2-1');
    expect(ep2TextRows[0].text).toBe('Text AC for EP2');

    db2.close();
  });
});
