/**
 * Tests for JSON-to-SQLite migration.
 *
 * Verifies data integrity through migration: field preservation,
 * dependency mapping, session import, and export roundtrip.
 *
 * @task T4645
 * @epic T4638
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('JSON to SQLite migration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-migrate-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', cleoDir);
    await writeFile(
      join(cleoDir, 'project-info.json'),
      JSON.stringify({ projectId: 'migration-fixture', projectHash: 'migration-fixture' }),
    );

    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  // === Basic migration ===

  describe('forward and dangling references under foreign keys ON (T13259)', () => {
    it('imports every task whatever the JSON order, and names each dropped reference', async () => {
      const task = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        title: `Task ${id}`,
        description: `Task ${id}`,
        status: 'pending',
        priority: 'medium',
        type: 'task',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...extra,
      });
      const todo = [
        // Forward references: a provenance session, a later dependency, an
        // archived epic parent, and a dependency cycle.
        task('T001', { provenance: { sessionId: 'sess-A' } }),
        task('T003', { depends: ['T004'] }),
        task('T004'),
        task('T011', { parentId: 'T010' }),
        task('T006', { depends: ['T007'] }),
        task('T007', { depends: ['T006'] }),
        // Dangling references: nothing in the import holds their targets.
        task('T008', { depends: ['T999'] }),
        task('T009', { parentId: 'T998' }),
      ];
      const archived = [task('T010', { type: 'epic', status: 'done' })];
      const sessions = [
        {
          id: 'sess-A',
          name: 'A',
          status: 'ended',
          scope: { type: 'global' },
          taskWork: { taskId: 'T004', setAt: '2026-01-01T00:00:00.000Z' },
          startedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'sess-B',
          name: 'B',
          status: 'ended',
          scope: { type: 'global' },
          taskWork: { taskId: 'T997', setAt: '2026-01-01T00:00:00.000Z' },
          startedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify({ tasks: todo }));
      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({ archivedTasks: archived }),
      );
      await writeFile(join(cleoDir, 'sessions.json'), JSON.stringify({ sessions }));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(todo.length);
      expect(result.archivedImported).toBe(archived.length);
      expect(result.sessionsImported).toBe(sessions.length);

      // Row counts match the source, with foreign keys ON.
      const { getDb, getNativeTasksDb } = await import('../sqlite.js');
      await getDb();
      const native = getNativeTasksDb();
      if (!native) throw new Error('fixture: no tasks store handle');
      const n = (sql: string) => (native.prepare(sql).get() as { n: number }).n;
      expect(
        (native.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
      ).toBe(1);
      expect(n("SELECT count(*) AS n FROM tasks_tasks WHERE status != 'archived'")).toBe(
        todo.length,
      );
      expect(n("SELECT count(*) AS n FROM tasks_tasks WHERE status = 'archived'")).toBe(1);
      expect(n('SELECT count(*) AS n FROM tasks_sessions')).toBe(sessions.length);
      expect(native.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // Forward references are kept.
      const one = (sql: string, ...args: string[]) =>
        native.prepare(sql).get(...args) as Record<string, string | null> | undefined;
      expect(one('SELECT session_id FROM tasks_tasks WHERE id = ?', 'T001')?.session_id).toBe(
        'sess-A',
      );
      expect(one('SELECT parent_id FROM tasks_tasks WHERE id = ?', 'T011')?.parent_id).toBe('T010');
      expect(
        one('SELECT current_task FROM tasks_sessions WHERE id = ?', 'sess-A')?.current_task,
      ).toBe('T004');
      expect(
        one(
          'SELECT 1 AS ok FROM tasks_task_dependencies WHERE task_id = ? AND depends_on = ?',
          'T003',
          'T004',
        ),
      ).toBeDefined();

      // Every dangling reference is dropped and named, never silently.
      for (const ref of [
        'Task T008: dependency T999 dropped',
        'Task T009: parent T998 dropped',
        'Session sess-B: current task T997 dropped',
      ]) {
        expect(result.warnings.some((w) => w.startsWith(ref))).toBe(true);
      }
      expect(one('SELECT parent_id FROM tasks_tasks WHERE id = ?', 'T009')?.parent_id).toBeNull();
      // The cycle loses exactly one edge, with a warning naming it.
      expect(
        n("SELECT count(*) AS n FROM tasks_task_dependencies WHERE task_id IN ('T006', 'T007')"),
      ).toBe(1);
    });
  });

  describe('one topo order across the active and archive files (T13259)', () => {
    it('a parent in the archive precedes its active child, so the type guard checks the pair', async () => {
      // A task cannot parent a task: with the archived parent inserted first,
      // the parent-type guard sees it and refuses the child, by name.
      const base = { status: 'pending', priority: 'medium', createdAt: '2026-01-01T00:00:00.000Z' };
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({
          tasks: [
            {
              ...base,
              id: 'T021',
              title: 'child',
              description: 'child',
              type: 'task',
              parentId: 'T020',
            },
          ],
        }),
      );
      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({
          archivedTasks: [
            {
              ...base,
              id: 'T020',
              title: 'parent',
              description: 'parent',
              type: 'task',
              status: 'done',
            },
          ],
        }),
      );
      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();
      expect(result.archivedImported).toBe(1);
      expect(result.errors.some((e) => e.startsWith('Failed to import task T021'))).toBe(true);
    });
  });

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
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({
          version: '2.10.0',
          project: { name: 'test' },
          _meta: { schemaVersion: '2.10.0' },
          tasks: [],
        }),
      );

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
            // T1408 6-value enum (was 'completed' which is no longer valid).
            archiveReason: 'completed-unverified',
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
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({
          version: '2.10.0',
          project: { name: 'test' },
          _meta: { schemaVersion: '2.10.0' },
          tasks: [],
        }),
      );

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
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({
          version: '2.10.0',
          project: { name: 'test' },
          _meta: { schemaVersion: '2.10.0' },
          tasks: [],
        }),
      );

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
      const { getTask } = await import('../tasks-sqlite.js');
      const task = await getTask('T002');
      expect(task!.depends).toContain('T001');
    });

    // T12886: a legacy todo.json can hold a dependency cycle. The cycle guard
    // refuses the closing edge; the import skips only that edge, warns with
    // the named cycle, and keeps the task and its other edges.
    const cyclicTodo = () => ({
      version: '2.10.0',
      project: { name: 'test' },
      _meta: { schemaVersion: '2.10.0' },
      tasks: [
        {
          id: 'T001',
          title: 'A',
          status: 'pending',
          priority: 'medium',
          depends: ['T003'],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'T002',
          title: 'B',
          status: 'pending',
          priority: 'medium',
          depends: ['T001'],
          createdAt: '2026-01-02T00:00:00.000Z',
        },
        {
          id: 'T003',
          title: 'C',
          status: 'pending',
          priority: 'medium',
          depends: ['T002'],
          createdAt: '2026-01-03T00:00:00.000Z',
        },
        {
          id: 'T004',
          title: 'D',
          status: 'pending',
          priority: 'medium',
          createdAt: '2026-01-04T00:00:00.000Z',
        },
        {
          id: 'T005',
          title: 'E',
          status: 'pending',
          priority: 'medium',
          depends: ['T004', 'T005'],
          createdAt: '2026-01-05T00:00:00.000Z',
        },
      ],
    });

    function expectCycleSkipped(result: {
      success: boolean;
      tasksImported: number;
      errors: string[];
      warnings: string[];
    }): void {
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(5);
      const cycleWarnings = result.warnings.filter((w) => w.includes('E_TASK_DEPENDENCY_CYCLE'));
      expect(cycleWarnings).toEqual([
        'Task T001: skipped dependency T001 → T003: it would close the dependency cycle T001 → T003 → T002 → T001 (E_TASK_DEPENDENCY_CYCLE)',
        'Task T005: skipped dependency T005 → T005: it would close the dependency cycle T005 → T005 (E_TASK_DEPENDENCY_CYCLE)',
      ]);
    }

    it('skips only a cycle-closing edge from a legacy todo.json (T12886)', async () => {
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(cyclicTodo()));
      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();
      expectCycleSkipped(result);
      const { getTask } = await import('../tasks-sqlite.js');
      expect((await getTask('T005'))?.depends).toEqual(['T004']);
      // topoSortTasks imports dependencies first, so T001's edge is the one refused.
      expect((await getTask('T001'))?.depends ?? []).toEqual([]);
      expect((await getTask('T002'))?.depends).toEqual(['T001']);
      expect((await getTask('T003'))?.depends).toEqual(['T002']);
    });

    it('skips only a cycle-closing edge in the atomic import path (T12886)', async () => {
      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(cyclicTodo()));
      const { migrateJsonToSqliteAtomic } = await import('../migration-sqlite.js');
      const tempDbPath = join(cleoDir, 'tasks.db.migrating');
      const result = await migrateJsonToSqliteAtomic(tempDir, tempDbPath);
      expectCycleSkipped(result);
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(tempDbPath, { readOnly: true });
      try {
        const edges = (
          db
            .prepare(
              "SELECT task_id || '->' || depends_on AS e FROM tasks_task_dependencies ORDER BY 1",
            )
            .all() as Array<{ e: string }>
        ).map((r) => r.e);
        expect(edges).toEqual(['T002->T001', 'T003->T002', 'T005->T004']);
      } finally {
        db.close();
      }
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
      // The provenance session must be in the import to be kept (T13259).
      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({
          version: '1.0.0',
          sessions: [
            {
              id: 'sess-001',
              name: 'Dev session',
              status: 'ended',
              scope: { type: 'global' },
              startedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          _meta: { schemaVersion: '1.0.0', lastUpdated: '2026-01-01T12:00:00.000Z' },
        }),
      );

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      await migrateJsonToSqlite();

      const { getTask } = await import('../tasks-sqlite.js');
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

    it('handles tasks with null/undefined descriptions', async () => {
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T001',
            title: 'No description task',
            // description intentionally omitted (undefined)
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'T002',
            title: 'Null description task',
            description: null,
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(2);
      expect(result.errors).toHaveLength(0);

      const { getTask } = await import('../tasks-sqlite.js');
      const task1 = await getTask('T001');
      const task2 = await getTask('T002');

      expect(task1!.description).toBe('Task: No description task');
      expect(task2!.description).toBe('Task: Null description task');
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
      expect(result2.warnings.some((w) => w.includes('already contains migrated data'))).toBe(true);

      // Should still have only 1 task
      const { countTasks } = await import('../tasks-sqlite.js');
      const count = await countTasks();
      expect(count).toBe(1);
    });
  });

  // === Topological sort: parent/child ordering ===

  describe('parent/child ordering (topological sort)', () => {
    it('imports child tasks when they appear before their parent in the array', async () => {
      // T002 (child of T001) appears BEFORE T001 — this used to fail FK constraint
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T002',
            title: 'Child task',
            description: 'Child of T001',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            parentId: 'T001',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
          {
            id: 'T001',
            title: 'Parent task',
            description: 'The parent',
            status: 'pending',
            priority: 'medium',
            type: 'epic',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(2);
      expect(result.errors).toHaveLength(0);

      const { getTask } = await import('../tasks-sqlite.js');
      const parent = await getTask('T001');
      const child = await getTask('T002');
      expect(parent).not.toBeNull();
      expect(child).not.toBeNull();
      expect(child!.parentId).toBe('T001');
    });

    it('handles deep hierarchy in reverse insertion order', async () => {
      // Grandchild → child → parent (worst case ordering)
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            // PM-Core V2 type matrix: task -> subtask (a task may only parent a
            // subtask, never another task). Keep T003 as the deepest level via
            // type 'subtask' so the 3-level reverse-insertion hierarchy stands.
            id: 'T003',
            title: 'Grandchild subtask',
            description: 'Child of T002',
            status: 'pending',
            priority: 'low',
            type: 'subtask',
            parentId: 'T002',
            createdAt: '2026-01-03T00:00:00.000Z',
          },
          {
            id: 'T002',
            title: 'Child task',
            description: 'Child of T001',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            parentId: 'T001',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
          {
            id: 'T001',
            title: 'Root task',
            description: 'The root',
            status: 'pending',
            priority: 'high',
            type: 'epic',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(3);
      expect(result.errors).toHaveLength(0);

      const { getTask } = await import('../tasks-sqlite.js');
      const root = await getTask('T001');
      const child = await getTask('T002');
      const grandchild = await getTask('T003');
      expect(root).not.toBeNull();
      expect(child!.parentId).toBe('T001');
      expect(grandchild!.parentId).toBe('T002');
    });

    it('handles tasks with no parentId (roots) in any order', async () => {
      // Multiple root tasks (no parentId) in any order — all should import fine
      const todoData = {
        version: '2.10.0',
        project: { name: 'test' },
        _meta: { schemaVersion: '2.10.0' },
        tasks: [
          {
            id: 'T003',
            title: 'Root C',
            description: 'Third root',
            status: 'pending',
            priority: 'low',
            type: 'task',
            createdAt: '2026-01-03T00:00:00.000Z',
          },
          {
            id: 'T001',
            title: 'Root A',
            description: 'First root',
            status: 'pending',
            priority: 'high',
            type: 'epic',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'T002',
            title: 'Root B',
            description: 'Second root',
            status: 'pending',
            priority: 'medium',
            type: 'task',
            createdAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(3);
      expect(result.errors).toHaveLength(0);
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
      expect(exported.tasks.every((t) => t.id !== 'T100')).toBe(true);
      // Archived should be separate
      expect(exported.archived.some((t) => t.id === 'T100')).toBe(true);
    });
  });
});
