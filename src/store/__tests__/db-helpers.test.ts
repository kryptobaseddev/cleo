/**
 * Tests for db-helpers.ts — defensive orphan parent handling (T5034).
 *
 * @task T5034
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';

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

  it('nulls out parentId when parent task does not exist', async () => {
    const { getDb } = await import('../sqlite.js');
    const { upsertTask } = await import('../db-helpers.js');
    const schema = await import('../schema.js');
    const db = await getDb();

    // Insert a child task with a non-existent parent
    await upsertTask(db, {
      id: 'T100',
      title: 'Child task',
      description: 'Has orphan parent ref',
      status: 'pending',
      priority: 'medium',
      parentId: 'T999', // does NOT exist in DB
      createdAt: new Date().toISOString(),
    });

    // Verify the task was inserted with parentId = null
    const rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'T100'))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parentId).toBeNull();
  });

  it('preserves parentId when parent task exists', async () => {
    const { getDb } = await import('../sqlite.js');
    const { upsertTask } = await import('../db-helpers.js');
    const schema = await import('../schema.js');
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
    const rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'T002'))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parentId).toBe('T001');
  });

  it('handles archived task with orphan parent (T5034 regression)', async () => {
    const { getDb } = await import('../sqlite.js');
    const { upsertTask } = await import('../db-helpers.js');
    const schema = await import('../schema.js');
    const db = await getDb();

    // Simulate re-upserting an archived task whose parent was deleted
    await upsertTask(db, {
      id: 'T200',
      title: 'Archived child',
      description: 'Parent was deleted',
      status: 'pending',
      priority: 'medium',
      parentId: 'T2058', // deleted parent
      createdAt: '2025-01-01T00:00:00Z',
    }, {
      archivedAt: '2025-06-01T00:00:00Z',
      archiveReason: 'completed',
    });

    // Should succeed (not throw) and null out the parentId
    const rows = await db.select().from(schema.tasks)
      .where(eq(schema.tasks.id, 'T200'))
      .all();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.parentId).toBeNull();
    expect(rows[0]!.status).toBe('archived');
  });
});
