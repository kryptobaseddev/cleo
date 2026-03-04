/**
 * Tests for batch task archiving.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { archiveTasks } from '../archive.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';

describe('archiveTasks', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('archives completed tasks', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Done task', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-02T00:00:00Z' },
      { id: 'T002', title: 'Pending task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await archiveTasks({}, env.tempDir, accessor);
    expect(result.archived).toContain('T001');
    expect(result.archived).not.toContain('T002');

    const updated = await accessor.loadTaskFile();
    expect(updated.tasks).toHaveLength(1);
    expect(updated.tasks[0].id).toBe('T002');

    const archive = await accessor.loadArchive();
    expect(archive).not.toBeNull();
    expect(archive!.archivedTasks).toHaveLength(1);
    expect(archive!.archivedTasks[0].id).toBe('T001');
  });

  it('includes cancelled tasks by default', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Cancelled', status: 'cancelled', priority: 'medium', createdAt: '2025-01-01T00:00:00Z', cancelledAt: '2025-01-02T00:00:00Z' },
    ]);

    const result = await archiveTasks({}, env.tempDir, accessor);
    expect(result.archived).toContain('T001');
  });

  it('excludes cancelled tasks when includeCancelled is false', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Cancelled', status: 'cancelled', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
    ]);

    const result = await archiveTasks({ includeCancelled: false }, env.tempDir, accessor);
    expect(result.archived).toHaveLength(0);
  });

  it('filters by date with before option', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Old', status: 'done', priority: 'medium', createdAt: '2024-01-01T00:00:00Z', completedAt: '2024-06-01T00:00:00Z' },
      { id: 'T002', title: 'Recent', status: 'done', priority: 'medium', createdAt: '2025-12-01T00:00:00Z', completedAt: '2025-12-15T00:00:00Z' },
    ]);

    const result = await archiveTasks({ before: '2025-01-01T00:00:00Z' }, env.tempDir, accessor);
    expect(result.archived).toContain('T001');
    expect(result.archived).not.toContain('T002');
  });

  it('archives specific tasks by ID', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Done 1', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'T002', title: 'Done 2', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
    ]);

    const result = await archiveTasks({ taskIds: ['T001'] }, env.tempDir, accessor);
    expect(result.archived).toEqual(['T001']);
  });

  it('supports dry run mode', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Done', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z' },
    ]);

    const result = await archiveTasks({ dryRun: true }, env.tempDir, accessor);
    expect(result.dryRun).toBe(true);
    expect(result.archived).toContain('T001');

    // Verify no changes were made
    const updated = await accessor.loadTaskFile();
    expect(updated.tasks).toHaveLength(1);
  });

  it('skips epics with active children', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Epic', status: 'done', priority: 'medium', type: 'epic', createdAt: '2025-01-01T00:00:00Z' },
      { id: 'T002', title: 'Active child', status: 'active', priority: 'medium', parentId: 'T001', createdAt: '2025-01-01T00:00:00Z' },
    ]);

    const result = await archiveTasks({}, env.tempDir, accessor);
    expect(result.skipped).toContain('T001');
    expect(result.archived).not.toContain('T001');
  });

  it('returns empty when nothing to archive', async () => {
    await seedTasks(accessor, [
      { id: 'T001', title: 'Active', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
    ]);

    const result = await archiveTasks({}, env.tempDir, accessor);
    expect(result.archived).toHaveLength(0);
  });

  it('appends to existing archive', async () => {
    // First, create T001 as archived
    await seedTasks(accessor, [
      { id: 'T001', title: 'Already archived', status: 'done', priority: 'medium', createdAt: '2024-01-01T00:00:00Z' },
    ]);
    await archiveTasks({ taskIds: ['T001'] }, env.tempDir, accessor);

    // Now add T002 as done and archive it
    await accessor.upsertSingleTask!({
      id: 'T002', title: 'New done', status: 'done', priority: 'medium', createdAt: '2025-01-01T00:00:00Z',
    } as import('../../../types/task.js').Task);

    await archiveTasks({ taskIds: ['T002'] }, env.tempDir, accessor);

    const archive = await accessor.loadArchive();
    expect(archive!.archivedTasks).toHaveLength(2);
  });
});
