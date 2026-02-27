/**
 * Tests for SQLite-backed task store operations.
 *
 * Covers CRUD, filtering, search, archival, dependencies,
 * relations, and graph operations.
 *
 * @task T4645
 * @epic T4638
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../../types/task.js';

let tempDir: string;

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('SQLite task-store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-taskstore-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    // Reset singleton
    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // === createTask ===

  describe('createTask', () => {
    it('creates a task and retrieves it', async () => {
      const { createTask, getTask } = await import('../task-store.js');
      const task = makeTask({ id: 'T001', title: 'First task', description: 'A test task' });

      const created = await createTask(task);
      expect(created.id).toBe('T001');

      const retrieved = await getTask('T001');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('T001');
      expect(retrieved!.title).toBe('First task');
      expect(retrieved!.description).toBe('A test task');
      expect(retrieved!.status).toBe('pending');
      expect(retrieved!.priority).toBe('medium');
    });

    it('persists labels, notes, and acceptance as JSON', async () => {
      const { createTask, getTask } = await import('../task-store.js');
      const task = makeTask({
        id: 'T002',
        labels: ['bug', 'urgent'],
        notes: ['First note'],
        acceptance: ['Must pass tests'],
      });

      await createTask(task);
      const retrieved = await getTask('T002');

      expect(retrieved!.labels).toEqual(['bug', 'urgent']);
      expect(retrieved!.notes).toEqual(['First note']);
      expect(retrieved!.acceptance).toEqual(['Must pass tests']);
    });

    it('creates task with dependencies', async () => {
      const { createTask, getTask } = await import('../task-store.js');

      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002', depends: ['T001'] }));

      const retrieved = await getTask('T002');
      expect(retrieved!.depends).toEqual(['T001']);
    });

    it('creates task with provenance', async () => {
      const { createTask, getTask } = await import('../task-store.js');
      const task = makeTask({
        id: 'T003',
        provenance: {
          createdBy: 'agent-1',
          modifiedBy: null,
          sessionId: 'sess-001',
        },
      });

      await createTask(task);
      const retrieved = await getTask('T003');

      expect(retrieved!.provenance).toBeDefined();
      expect(retrieved!.provenance!.createdBy).toBe('agent-1');
      expect(retrieved!.provenance!.sessionId).toBe('sess-001');
    });

    it('preserves all task fields through roundtrip', async () => {
      const { createTask, getTask } = await import('../task-store.js');
      const now = new Date().toISOString();
      const task = makeTask({
        id: 'T004',
        title: 'Full task',
        description: 'Detailed description',
        status: 'active',
        priority: 'high',
        type: 'task',
        parentId: null,
        phase: 'implementation',
        size: 'large',
        position: 3,
        origin: 'bug-report',
        blockedBy: 'T001',
        createdAt: now,
      });

      await createTask(task);
      const retrieved = await getTask('T004');

      expect(retrieved!.title).toBe('Full task');
      expect(retrieved!.status).toBe('active');
      expect(retrieved!.priority).toBe('high');
      expect(retrieved!.type).toBe('task');
      expect(retrieved!.phase).toBe('implementation');
      expect(retrieved!.size).toBe('large');
      expect(retrieved!.position).toBe(3);
      expect(retrieved!.origin).toBe('bug-report');
      expect(retrieved!.blockedBy).toBe('T001');
    });
  });

  // === getTask ===

  describe('getTask', () => {
    it('returns null for non-existent task', async () => {
      const { getTask } = await import('../task-store.js');
      const result = await getTask('T999');
      expect(result).toBeNull();
    });

    it('loads dependencies with task', async () => {
      const { createTask, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));
      await createTask(makeTask({ id: 'T003', depends: ['T001', 'T002'] }));

      const task = await getTask('T003');
      expect(task!.depends).toHaveLength(2);
      expect(task!.depends).toContain('T001');
      expect(task!.depends).toContain('T002');
    });
  });

  // === updateTask ===

  describe('updateTask', () => {
    it('updates title and description', async () => {
      const { createTask, updateTask, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', title: 'Old title' }));

      const updated = await updateTask('T001', {
        title: 'New title',
        description: 'New description',
      });

      expect(updated).not.toBeNull();
      expect(updated!.title).toBe('New title');
      expect(updated!.description).toBe('New description');
      expect(updated!.updatedAt).toBeDefined();
    });

    it('updates status', async () => {
      const { createTask, updateTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));

      const updated = await updateTask('T001', { status: 'active' });
      expect(updated!.status).toBe('active');
    });

    it('updates priority', async () => {
      const { createTask, updateTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));

      const updated = await updateTask('T001', { priority: 'critical' });
      expect(updated!.priority).toBe('critical');
    });

    it('updates labels', async () => {
      const { createTask, updateTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', labels: ['old'] }));

      const updated = await updateTask('T001', { labels: ['new', 'updated'] });
      expect(updated!.labels).toEqual(['new', 'updated']);
    });

    it('updates dependencies', async () => {
      const { createTask, updateTask, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));
      await createTask(makeTask({ id: 'T003', depends: ['T001'] }));

      await updateTask('T003', { depends: ['T002'] });
      const task = await getTask('T003');
      expect(task!.depends).toEqual(['T002']);
    });

    it('returns null for non-existent task', async () => {
      const { updateTask } = await import('../task-store.js');
      const result = await updateTask('T999', { title: 'Nope' });
      expect(result).toBeNull();
    });

    it('sets updatedAt timestamp', async () => {
      const { createTask, updateTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));

      const before = new Date().toISOString();
      const updated = await updateTask('T001', { title: 'Changed' });
      expect(updated!.updatedAt).toBeDefined();
      expect(updated!.updatedAt! >= before).toBe(true);
    });
  });

  // === deleteTask ===

  describe('deleteTask', () => {
    it('deletes an existing task', async () => {
      const { createTask, deleteTask, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));

      const deleted = await deleteTask('T001');
      expect(deleted).toBe(true);

      const task = await getTask('T001');
      expect(task).toBeNull();
    });

    it('returns false for non-existent task', async () => {
      const { deleteTask } = await import('../task-store.js');
      const result = await deleteTask('T999');
      expect(result).toBe(false);
    });
  });

  // === listTasks ===

  describe('listTasks', () => {
    it('lists all non-archived tasks', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002', status: 'active' }));

      const tasks = await listTasks();
      expect(tasks).toHaveLength(2);
    });

    it('excludes archived tasks by default', async () => {
      const { createTask, archiveTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', status: 'done' }));
      await createTask(makeTask({ id: 'T002' }));

      await archiveTask('T001');

      const tasks = await listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe('T002');
    });

    it('filters by status', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', status: 'pending' }));
      await createTask(makeTask({ id: 'T002', status: 'active' }));
      await createTask(makeTask({ id: 'T003', status: 'pending' }));

      const pending = await listTasks({ status: 'pending' });
      expect(pending).toHaveLength(2);
      expect(pending.every(t => t.status === 'pending')).toBe(true);
    });

    it('filters by parentId', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', type: 'epic' }));
      await createTask(makeTask({ id: 'T002', parentId: 'T001' }));
      await createTask(makeTask({ id: 'T003', parentId: 'T001' }));
      await createTask(makeTask({ id: 'T004' }));

      const children = await listTasks({ parentId: 'T001' });
      expect(children).toHaveLength(2);
      expect(children.map(t => t.id).sort()).toEqual(['T002', 'T003']);
    });

    it('filters by null parentId (root tasks)', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002', parentId: 'T001' }));

      const roots = await listTasks({ parentId: null });
      expect(roots).toHaveLength(1);
      expect(roots[0]!.id).toBe('T001');
    });

    it('filters by type', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', type: 'epic' }));
      await createTask(makeTask({ id: 'T002', type: 'task' }));

      const epics = await listTasks({ type: 'epic' });
      expect(epics).toHaveLength(1);
      expect(epics[0]!.type).toBe('epic');
    });

    it('filters by phase', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', phase: 'design' }));
      await createTask(makeTask({ id: 'T002', phase: 'implementation' }));

      const design = await listTasks({ phase: 'design' });
      expect(design).toHaveLength(1);
      expect(design[0]!.phase).toBe('design');
    });

    it('respects limit parameter', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));
      await createTask(makeTask({ id: 'T003' }));

      const limited = await listTasks({ limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('loads dependencies for listed tasks', async () => {
      const { createTask, listTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002', depends: ['T001'] }));

      const tasks = await listTasks();
      const t002 = tasks.find(t => t.id === 'T002');
      expect(t002!.depends).toEqual(['T001']);
    });
  });

  // === findTasks ===

  describe('findTasks', () => {
    it('finds tasks by title substring', async () => {
      const { createTask, findTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', title: 'Fix authentication bug' }));
      await createTask(makeTask({ id: 'T002', title: 'Add login feature' }));

      const results = await findTasks('auth');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('T001');
    });

    it('finds tasks by ID substring', async () => {
      const { createTask, findTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));

      const results = await findTasks('T001');
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('T001');
    });

    it('finds tasks by description substring', async () => {
      const { createTask, findTasks } = await import('../task-store.js');
      await createTask(makeTask({
        id: 'T001',
        title: 'Some task',
        description: 'This involves database migration',
      }));

      const results = await findTasks('migration');
      expect(results).toHaveLength(1);
    });

    it('excludes archived tasks', async () => {
      const { createTask, archiveTask, findTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', title: 'Archived task', status: 'done' }));
      await archiveTask('T001');

      const results = await findTasks('Archived');
      expect(results).toHaveLength(0);
    });

    it('respects limit parameter', async () => {
      const { createTask, findTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', title: 'Test alpha' }));
      await createTask(makeTask({ id: 'T002', title: 'Test beta' }));
      await createTask(makeTask({ id: 'T003', title: 'Test gamma' }));

      const results = await findTasks('Test', 2);
      expect(results).toHaveLength(2);
    });
  });

  // === archiveTask ===

  describe('archiveTask', () => {
    it('archives an existing task', async () => {
      const { createTask, archiveTask, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', status: 'done' }));

      const result = await archiveTask('T001');
      expect(result).toBe(true);

      // Task still exists but with archived status
      const { getDb } = await import('../sqlite.js');
      const { eq } = await import('drizzle-orm');
      const { tasks: taskSchema } = await import('../schema.js');
      const db = await getDb();
      const rows = await db.select({ status: taskSchema.status, archivedAt: taskSchema.archivedAt })
        .from(taskSchema)
        .where(eq(taskSchema.id, 'T001'))
        .all();
      expect(rows[0]!.status).toBe('archived');
      expect(rows[0]!.archivedAt).toBeDefined();
    });

    it('sets archive reason', async () => {
      const { createTask, archiveTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', status: 'done' }));

      await archiveTask('T001', 'Manual cleanup');

      const { getDb } = await import('../sqlite.js');
      const { eq } = await import('drizzle-orm');
      const { tasks: taskSchema } = await import('../schema.js');
      const db = await getDb();
      const rows = await db.select({ archiveReason: taskSchema.archiveReason })
        .from(taskSchema)
        .where(eq(taskSchema.id, 'T001'))
        .all();
      expect(rows[0]!.archiveReason).toBe('Manual cleanup');
    });

    it('calculates cycle time in days', async () => {
      const { createTask, archiveTask } = await import('../task-store.js');
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await createTask(makeTask({ id: 'T001', status: 'done', createdAt: threeDaysAgo }));

      await archiveTask('T001');

      const { getDb } = await import('../sqlite.js');
      const { eq } = await import('drizzle-orm');
      const { tasks: taskSchema } = await import('../schema.js');
      const db = await getDb();
      const rows = await db.select({ cycleTimeDays: taskSchema.cycleTimeDays })
        .from(taskSchema)
        .where(eq(taskSchema.id, 'T001'))
        .all();
      expect(rows[0]!.cycleTimeDays).toBeGreaterThanOrEqual(2);
      expect(rows[0]!.cycleTimeDays).toBeLessThanOrEqual(4);
    });

    it('returns false for non-existent task', async () => {
      const { archiveTask } = await import('../task-store.js');
      const result = await archiveTask('T999');
      expect(result).toBe(false);
    });
  });

  // === Dependency operations ===

  describe('dependency operations', () => {
    it('addDependency creates a dependency link', async () => {
      const { createTask, addDependency, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));

      await addDependency('T002', 'T001');
      const task = await getTask('T002');
      expect(task!.depends).toContain('T001');
    });

    it('removeDependency removes a dependency link', async () => {
      const { createTask, addDependency, removeDependency, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002', depends: ['T001'] }));

      await removeDependency('T002', 'T001');
      const task = await getTask('T002');
      // depends should be empty or undefined
      expect(task!.depends ?? []).toEqual([]);
    });

    it('addDependency is idempotent', async () => {
      const { createTask, addDependency, getTask } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));

      await addDependency('T002', 'T001');
      await addDependency('T002', 'T001'); // duplicate, should not throw

      const task = await getTask('T002');
      expect(task!.depends).toHaveLength(1);
    });
  });

  // === Relation operations ===

  describe('relation operations', () => {
    it('addRelation creates a relation', async () => {
      const { createTask, addRelation, getRelations } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));

      await addRelation('T001', 'T002', 'blocks');

      const relations = await getRelations('T001');
      expect(relations).toHaveLength(1);
      expect(relations[0]!.relatedTo).toBe('T002');
      expect(relations[0]!.type).toBe('blocks');
    });

    it('addRelation supports different relation types', async () => {
      const { createTask, addRelation, getRelations } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));
      await createTask(makeTask({ id: 'T003' }));

      await addRelation('T001', 'T002', 'related');
      await addRelation('T001', 'T003', 'duplicates');

      const relations = await getRelations('T001');
      expect(relations).toHaveLength(2);
    });
  });

  // === Graph operations ===

  describe('graph operations', () => {
    it('getChildren returns direct children', async () => {
      const { createTask, getChildren } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', type: 'epic' }));
      await createTask(makeTask({ id: 'T002', parentId: 'T001' }));
      await createTask(makeTask({ id: 'T003', parentId: 'T001' }));
      await createTask(makeTask({ id: 'T004' }));

      const children = await getChildren('T001');
      expect(children).toHaveLength(2);
      expect(children.map(c => c.id).sort()).toEqual(['T002', 'T003']);
    });

    it('getSubtree returns full descendant tree', async () => {
      const { createTask, getSubtree } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', type: 'epic' }));
      await createTask(makeTask({ id: 'T002', parentId: 'T001', type: 'task' }));
      await createTask(makeTask({ id: 'T003', parentId: 'T002', type: 'subtask' }));
      await createTask(makeTask({ id: 'T004' })); // unrelated

      const subtree = await getSubtree('T001');
      expect(subtree).toHaveLength(3);
      expect(subtree.map(t => t.id).sort()).toEqual(['T001', 'T002', 'T003']);
    });

    it('getBlockerChain returns recursive blocker IDs', async () => {
      const { createTask, getBlockerChain } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002', depends: ['T001'] }));
      await createTask(makeTask({ id: 'T003', depends: ['T002'] }));

      const chain = await getBlockerChain('T003');
      expect(chain).toContain('T002');
      expect(chain).toContain('T001');
    });

    it('countByStatus returns status counts', async () => {
      const { createTask, countByStatus } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001', status: 'pending' }));
      await createTask(makeTask({ id: 'T002', status: 'pending' }));
      await createTask(makeTask({ id: 'T003', status: 'active' }));
      await createTask(makeTask({ id: 'T004', status: 'done' }));

      const counts = await countByStatus();
      expect(counts['pending']).toBe(2);
      expect(counts['active']).toBe(1);
      expect(counts['done']).toBe(1);
    });

    it('countTasks returns total non-archived count', async () => {
      const { createTask, archiveTask, countTasks } = await import('../task-store.js');
      await createTask(makeTask({ id: 'T001' }));
      await createTask(makeTask({ id: 'T002' }));
      await createTask(makeTask({ id: 'T003', status: 'done' }));
      await archiveTask('T003');

      const count = await countTasks();
      expect(count).toBe(2);
    });
  });
});
