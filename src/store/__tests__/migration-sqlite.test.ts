/**
 * Tests for JSON-to-SQLite migration.
 *
 * Verifies data integrity through migration: field preservation,
 * dependency mapping, session import, and export roundtrip.
 *
 * @task T4645
 * @epic T4638
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;

describe('JSON to SQLite migration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-migrate-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // === Basic migration ===

  describe('migrateJsonToSqlite', () => {
    it('migrates tasks from todo.json', async () => {
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T001',
            title: 'First task',
            description: 'A test task',
            status: 'pending',
            priority: 'high',
            type: 'task',
            createdAt: '2026-01-01T00:00:00.000Z',
            labels: ['bug'],
            notes: ['A note'],
          },
          {
            id: 'T002',
            title: 'Second task',
            description: 'Another task',
            status: 'done',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-01-02T00:00:00.000Z',
            depends: ['T001'],
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(2);
      expect(result.errors).toHaveLength(0);
    });

    it('migrates archived tasks from todo-archive.json', async () => {
      // Minimal todo.json
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify({
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [],
      }));

      const archiveData = {
        _meta: { schemaVersion: '2.4.0', totalArchived: 1 },
        archivedTasks: [
          {
            id: 'T100',
            title: 'Archived task',
            description: 'Was completed',
            status: 'done',
            priority: 'low',
            createdAt: '2025-12-01T00:00:00.000Z',
            completedAt: '2025-12-15T00:00:00.000Z',
            archivedAt: '2025-12-20T00:00:00.000Z',
            archiveReason: 'completed',
            cycleTimeDays: 14,
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo-archive.json'), JSON.stringify(archiveData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.archivedImported).toBe(1);
    });

    it('migrates sessions from sessions.json', async () => {
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify({
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [],
      }));

      const sessionsData = {
        version: '1.0.0',
        sessions: [
          {
            id: 'sess-001',
            name: 'Dev session',
            status: 'ended',
            scope: { type: 'epic', epicId: 'T001' },
            focus: { taskId: 'T002', setAt: '2026-01-01T10:00:00.000Z' },
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T12:00:00.000Z',
            agent: 'claude',
            notes: ['Session note'],
            tasksCompleted: ['T002'],
            tasksCreated: ['T003'],
          },
        ],
        _meta: { schemaVersion: '1.0.0', lastUpdated: '2026-01-01T12:00:00.000Z' },
      };

      await writeFile(join(cleoDir, 'sessions.json'), JSON.stringify(sessionsData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.sessionsImported).toBe(1);
    });

    it('handles empty data migration', async () => {
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify({
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [],
      }));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(0);
      expect(result.archivedImported).toBe(0);
      expect(result.sessionsImported).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('handles missing JSON files gracefully', async () => {
      // No todo.json, no archive, no sessions
      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      // Should still succeed (with warnings)
      expect(result.tasksImported).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('preserves task dependencies through migration', async () => {
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T001',
            title: 'Dep target',
            status: 'pending',
            priority: 'medium',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'T002',
            title: 'Dependent',
            status: 'pending',
            priority: 'medium',
            depends: ['T001'],
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      await migrateJsonToSqlite();

      // Verify dependencies in SQLite
      const { getTask } = await import('../task-store.js');
      const task = await getTask('T002');
      expect(task!.depends).toContain('T001');
    });

    it('preserves all task fields through migration', async () => {
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T001',
            title: 'Full task',
            description: 'Detailed description',
            status: 'active',
            priority: 'critical',
            type: 'epic',
            phase: 'planning',
            size: 'large',
            position: 5,
            labels: ['important', 'v2'],
            notes: ['Note 1', 'Note 2'],
            acceptance: ['Criteria 1'],
            files: ['src/main.ts'],
            origin: 'feature-request',
            blockedBy: 'external-dep',
            epicLifecycle: 'active',
            noAutoComplete: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-05T00:00:00.000Z',
            provenance: {
              createdBy: 'agent-1',
              modifiedBy: 'agent-2',
              sessionId: 'sess-001',
            },
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      await migrateJsonToSqlite();

      const { getTask } = await import('../task-store.js');
      const task = await getTask('T001');

      expect(task!.title).toBe('Full task');
      expect(task!.description).toBe('Detailed description');
      expect(task!.status).toBe('active');
      expect(task!.priority).toBe('critical');
      expect(task!.type).toBe('epic');
      expect(task!.phase).toBe('planning');
      expect(task!.size).toBe('large');
      expect(task!.position).toBe(5);
      expect(task!.labels).toEqual(['important', 'v2']);
      expect(task!.notes).toEqual(['Note 1', 'Note 2']);
      expect(task!.acceptance).toEqual(['Criteria 1']);
      expect(task!.files).toEqual(['src/main.ts']);
      expect(task!.origin).toBe('feature-request');
      expect(task!.blockedBy).toBe('external-dep');
      expect(task!.epicLifecycle).toBe('active');
      expect(task!.noAutoComplete).toBe(true);
      expect(task!.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(task!.provenance?.createdBy).toBe('agent-1');
      expect(task!.provenance?.modifiedBy).toBe('agent-2');
      expect(task!.provenance?.sessionId).toBe('sess-001');
    });

    it('does not duplicate tasks on re-migration (onConflictDoNothing)', async () => {
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T001',
            title: 'Task one',
            status: 'pending',
            priority: 'medium',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');

      // Migrate twice
      await migrateJsonToSqlite();
      const result2 = await migrateJsonToSqlite();

      // Second migration should report warning about existing db
      expect(result2.warnings.some(w => w.includes('already contains migrated data'))).toBe(true);

      // Should still have only 1 task
      const { countTasks } = await import('../task-store.js');
      const count = await countTasks();
      expect(count).toBe(1);
    });
  });

  // === exportToJson ===

  describe('exportToJson', () => {
    it('exports tasks and sessions back to JSON', async () => {
      // First migrate data in
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T001',
            title: 'Task one',
            description: 'First',
            status: 'pending',
            priority: 'medium',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'T002',
            title: 'Task two',
            description: 'Second',
            status: 'done',
            priority: 'high',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const sessionsData = {
        version: '1.0.0',
        sessions: [
          {
            id: 'sess-001',
            name: 'Test session',
            status: 'ended',
            scope: { type: 'global' },
            focus: { taskId: null, setAt: null },
            startedAt: '2026-01-01T00:00:00.000Z',
            endedAt: '2026-01-01T12:00:00.000Z',
          },
        ],
        _meta: { schemaVersion: '1.0.0', lastUpdated: '2026-01-01T12:00:00.000Z' },
      };

      await writeFile(join(cleoDir, 'sessions.json'), JSON.stringify(sessionsData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      await migrateJsonToSqlite();

      // Now export
      const { exportToJson } = await import('../migration-sqlite.js');
      const exported = await exportToJson();

      expect(exported.tasks.length).toBeGreaterThanOrEqual(2);
      expect(exported.sessions).toHaveLength(1);
      expect(exported.sessions[0]!.id).toBe('sess-001');
    });

    it('separates archived tasks in export', async () => {
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T001',
            title: 'Active task',
            status: 'pending',
            priority: 'medium',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };

      const archiveData = {
        _meta: { schemaVersion: '2.4.0' },
        archivedTasks: [
          {
            id: 'T100',
            title: 'Old task',
            status: 'done',
            priority: 'low',
            createdAt: '2025-12-01T00:00:00.000Z',
            archivedAt: '2025-12-15T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));
      await writeFile(join(cleoDir, 'todo-archive.json'), JSON.stringify(archiveData));

      const { migrateJsonToSqlite, exportToJson } = await import('../migration-sqlite.js');
      await migrateJsonToSqlite();

      const exported = await exportToJson();

      // Active tasks should not include archived
      expect(exported.tasks.every(t => t.id !== 'T100')).toBe(true);
      // Archived should be separate
      expect(exported.archived.some(t => t.id === 'T100')).toBe(true);
    });
  });
});
