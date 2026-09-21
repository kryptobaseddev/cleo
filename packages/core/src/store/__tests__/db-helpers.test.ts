/**
 * Tests for db-helpers.ts — defensive orphan parent handling (T5034, T585).
 *
 * @task T5034
 * @task T585
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReadyTasks } from '../../orchestration/index.js';
import { validateSpawnReadiness } from '../../orchestration/validate-spawn.js';
import { getEnrichedWaves } from '../../orchestration/waves.js';
import { awaitBackgroundOps } from '../background-ops.js';
import { getTaskAccessor } from '../data-accessor.js';
import { loadDependenciesForTasks } from '../db-helpers.js';
import { closeAllDatabases, getDb, getNativeDb } from '../sqlite.js';
import * as schema from '../tasks-schema.js';
import { createTask } from '../tasks-sqlite.js';

let tempDir: string;

describe('upsertTask — orphan parent handling', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-dbhelpers-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    // Reset singleton so tests get fresh DB
    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('nulls out parentId when allowOrphanParent=true and parent does not exist', async () => {
    const { getDb } = await import('../sqlite.js');
    const { upsertTask } = await import('../db-helpers.js');
    const schema = await import('../tasks-schema.js');
    const db = await getDb();

    // Insert a child task with a non-existent parent using allowOrphanParent=true (bulk mode)
    await upsertTask(
      db,
      {
        id: 'T100',
        title: 'Child task',
        description: 'Has orphan parent ref',
        status: 'pending',
        priority: 'medium',
        parentId: 'T999', // does NOT exist in DB
        createdAt: new Date().toISOString(),
      },
      undefined,
      true, // allowOrphanParent: silently null out for bulk/archive operations (T5034)
    );

    // Verify the task was inserted with parentId = null
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'T100')).all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parentId).toBeNull();
  });

  it('preserves parentId (with warning) when allowOrphanParent=false and parent does not exist', async () => {
    // In normal single-task write mode (default), upsertTask logs a warning but does NOT
    // silently null out the parentId. This prevents data corruption for normal task creation
    // while still surfacing the integrity issue. The FK constraint (disabled in tests) would
    // reject the write in production if the parent truly does not exist.
    const { getDb } = await import('../sqlite.js');
    const { upsertTask } = await import('../db-helpers.js');
    const schema = await import('../tasks-schema.js');
    const db = await getDb();

    // Insert a child task with a non-existent parent using default allowOrphanParent=false
    // In VITEST, FK enforcement is OFF, so this will succeed without null-out.
    await upsertTask(db, {
      id: 'T100',
      title: 'Child task',
      description: 'Has orphan parent ref',
      status: 'pending',
      priority: 'medium',
      parentId: 'T999', // does NOT exist in DB
      createdAt: new Date().toISOString(),
    });

    // With allowOrphanParent=false, the parentId is NOT nulled out — warning is logged.
    // In test env FK is off, so T100 gets stored with parentId='T999' (not null).
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'T100')).all();

    expect(rows).toHaveLength(1);
    // parentId is preserved (not silently nulled), indicating the warning-only behavior
    expect(rows[0]!.parentId).toBe('T999');
  });

  it('preserves parentId when parent task exists', async () => {
    const { getDb } = await import('../sqlite.js');
    const { upsertTask } = await import('../db-helpers.js');
    const schema = await import('../tasks-schema.js');
    const db = await getDb();

    // First create the parent task
    await upsertTask(db, {
      id: 'T001',
      title: 'Parent task',
      description: 'This is the parent',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    });

    // Then create a child referencing the parent
    await upsertTask(db, {
      id: 'T002',
      title: 'Child task',
      description: 'Has valid parent ref',
      status: 'pending',
      priority: 'medium',
      parentId: 'T001',
      createdAt: new Date().toISOString(),
    });

    // Verify parentId is preserved
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'T002')).all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parentId).toBe('T001');
  });

  it('handles archived task with orphan parent using allowOrphanParent=true (T5034 regression)', async () => {
    // Bulk archive operations pass allowOrphanParent=true to tolerate missing parents.
    // This prevents FK violations when archiving tasks whose parents were deleted.
    const { getDb } = await import('../sqlite.js');
    const { upsertTask } = await import('../db-helpers.js');
    const schema = await import('../tasks-schema.js');
    const db = await getDb();

    // Simulate re-upserting an archived task whose parent was deleted
    await upsertTask(
      db,
      {
        id: 'T200',
        title: 'Archived child',
        description: 'Parent was deleted',
        status: 'pending',
        priority: 'medium',
        parentId: 'T2058', // deleted parent
        createdAt: '2025-01-01T00:00:00Z',
      },
      {
        archivedAt: '2025-06-01T00:00:00Z',
        // T1408 6-value enum (was 'completed' which is no longer valid).
        archiveReason: 'completed-unverified',
      },
      true, // allowOrphanParent: bulk/archive mode silently nulls (T5034)
    );

    // Should succeed (not throw) and null out the parentId
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.id, 'T200')).all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parentId).toBeNull();
    expect(rows[0]!.status).toBe('archived');
  });
});

describe('hard dependency read fidelity — T12293', () => {
  let root: string;
  const fixtureTask = (id: string, extra: Partial<Task> = {}): Task => ({
    id,
    title: id,
    description: 'Independent dependency read oracle',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    createdAt: '2026-09-20T00:00:00Z',
    ...extra,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-hard-dependency-read-'));
    await mkdir(join(root, '.cleo'));
    await mkdir(join(root, '.git'));
    vi.stubEnv('CLEO_ROOT', root);
    vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
    await createTask(fixtureTask('T100', { type: 'epic' }), root);
    await createTask(fixtureTask('T101', { parentId: 'T100' }), root);
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    await closeAllDatabases();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps a persisted dangling hard edge visible to reads, ready, waves and spawn', async () => {
    const db = await getDb(root);
    const native = getNativeDb(root);
    if (!native) throw new Error('Canonical native test handle is unavailable');
    // Simulate an authentic legacy corruption; enforcement is ON for every read oracle.
    native.exec('PRAGMA foreign_keys = OFF');
    try {
      await db.insert(schema.taskDependencies).values({ taskId: 'T101', dependsOn: 'T999' }).run();
    } finally {
      native.exec('PRAGMA foreign_keys = ON');
    }
    expect(native.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(native.prepare('PRAGMA foreign_key_check').all()).toHaveLength(1);
    const accessor = await getTaskAccessor(root);
    expect(await accessor.loadSingleTask('T101')).toMatchObject({ depends: ['T999'] });
    expect(await accessor.loadTasks(['T101'])).toMatchObject([{ depends: ['T999'] }]);
    expect(await accessor.getChildren('T100')).toMatchObject([{ depends: ['T999'] }]);
    expect(await getReadyTasks('T100', root, accessor)).toMatchObject([
      { taskId: 'T101', ready: false, blockers: ['T999'] },
    ]);
    expect(await getEnrichedWaves('T100', root, accessor)).toMatchObject({
      waves: [{ tasks: [{ id: 'T101', ready: false, blockedBy: ['T999'] }] }],
    });
    expect(await validateSpawnReadiness('T101', root, accessor)).toMatchObject({
      ready: false,
      issues: [expect.objectContaining({ code: 'V_MISSING_DEP' })],
    });
    expect(await db.select().from(schema.taskDependencies).all()).toMatchObject([
      { taskId: 'T101', dependsOn: 'T999' },
    ]);
  });

  it('loads external hard targets without treating a caller population as an eligibility filter', async () => {
    await createTask(fixtureTask('T200'), root);
    await createTask(fixtureTask('T201', { depends: ['T200'] }), root);
    const accessor = await getTaskAccessor(root);
    const selected = [fixtureTask('T201')];
    await loadDependenciesForTasks(await getDb(root), selected, new Set(['T201']));
    expect(selected).toMatchObject([{ id: 'T201', depends: ['T200'] }]);
    expect(selected).toHaveLength(1);
    expect(await accessor.loadTasks(['T200'])).toMatchObject([{ id: 'T200', status: 'pending' }]);
  });

  it('surfaces failed storage reads instead of returning an empty healthy dependency set', async () => {
    const db = await getDb(root);
    const failure = new Error('Independent dependency SELECT failure');
    vi.spyOn(db, 'select').mockImplementationOnce(() => {
      throw failure;
    });
    await expect(loadDependenciesForTasks(db, [fixtureTask('T101')])).rejects.toBe(failure);
    vi.restoreAllMocks();
  });
});
