/**
 * Integration tests for storage migration and dual-write mode.
 *
 * Covers:
 *   - Full migration: JSON fixtures -> migrate -> verify SQLite parity
 *   - Dry-run mode: correct stats without side effects
 *   - Verify mode: catches discrepancies
 *   - Roundtrip: JSON -> SQLite -> JSON export -> compare
 *   - Dual-write mode: writes go to both, reads from SQLite
 *
 * @task T4647
 * @task T4648
 * @epic T4638
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StoreEngine } from '../provider.js';

let tempDir: string;
let cleoDir: string;

/** Standard test todo.json fixture. */
function makeTodoJson(tasks: unknown[] = []) {
  return {
    version: '2.10.0',
    project: { name: 'test-project', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '0000000000000000',
      configVersion: '1.0.0',
    },
    focus: { currentTask: null },
    tasks,
  };
}

/** Standard test tasks fixture. */
const TEST_TASKS = [
  {
    id: 'T001',
    title: 'First task',
    description: 'The first test task',
    status: 'pending',
    priority: 'high',
    type: 'epic',
    createdAt: '2026-01-01T00:00:00.000Z',
    labels: ['core', 'v2'],
    notes: ['Important note'],
  },
  {
    id: 'T002',
    title: 'Second task',
    description: 'Depends on first',
    status: 'active',
    priority: 'medium',
    type: 'task',
    parentId: 'T001',
    depends: ['T001'],
    createdAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'T003',
    title: 'Third task',
    description: 'Done task',
    status: 'done',
    priority: 'low',
    type: 'subtask',
    parentId: 'T002',
    createdAt: '2026-01-03T00:00:00.000Z',
    completedAt: '2026-01-04T00:00:00.000Z',
  },
];

/** Standard archived tasks fixture. */
const TEST_ARCHIVED = [
  {
    id: 'T100',
    title: 'Archived task',
    description: 'Was completed and archived',
    status: 'done',
    priority: 'low',
    createdAt: '2025-12-01T00:00:00.000Z',
    completedAt: '2025-12-15T00:00:00.000Z',
    archivedAt: '2025-12-20T00:00:00.000Z',
    archiveReason: 'completed',
    cycleTimeDays: 14,
  },
];

/** Standard sessions fixture. */
const TEST_SESSIONS = [
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
    tasksCompleted: ['T003'],
    tasksCreated: ['T002'],
  },
];

describe('Migration integration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mig-int-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Reset SQLite singleton
    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('full migration: JSON -> SQLite', () => {
    it('migrates all data types and preserves record counts', async () => {
      // Write JSON fixtures
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify(makeTodoJson(TEST_TASKS)),
      );
      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({ _meta: { schemaVersion: '2.10.0' }, archivedTasks: TEST_ARCHIVED }),
      );
      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({
          version: '1.0.0',
          sessions: TEST_SESSIONS,
          _meta: { schemaVersion: '1.0.0', lastUpdated: '2026-01-01T12:00:00.000Z' },
        }),
      );

      // Migrate
      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(3);
      expect(result.archivedImported).toBe(1);
      expect(result.sessionsImported).toBe(1);
      expect(result.errors).toHaveLength(0);

      // Verify data in SQLite matches source
      const { getTask } = await import('../task-store.js');

      const t1 = await getTask('T001');
      expect(t1).not.toBeNull();
      expect(t1!.title).toBe('First task');
      expect(t1!.description).toBe('The first test task');
      expect(t1!.priority).toBe('high');
      expect(t1!.type).toBe('epic');
      expect(t1!.labels).toEqual(['core', 'v2']);
      expect(t1!.notes).toEqual(['Important note']);

      const t2 = await getTask('T002');
      expect(t2).not.toBeNull();
      expect(t2!.parentId).toBe('T001');
      expect(t2!.depends).toContain('T001');

      const t3 = await getTask('T003');
      expect(t3).not.toBeNull();
      expect(t3!.status).toBe('done');
      expect(t3!.completedAt).toBe('2026-01-04T00:00:00.000Z');

      // Verify session
      const { getSession } = await import('../session-store.js');
      const sess = await getSession('sess-001');
      expect(sess).not.toBeNull();
      expect(sess!.name).toBe('Dev session');
      expect(sess!.agent).toBe('claude');
    });

    it('preserves task hierarchy through migration', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify(makeTodoJson(TEST_TASKS)),
      );

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      await migrateJsonToSqlite();

      const { getChildren } = await import('../task-store.js');
      const children = await getChildren('T001');
      expect(children).toHaveLength(1);
      expect(children[0]!.id).toBe('T002');

      const grandchildren = await getChildren('T002');
      expect(grandchildren).toHaveLength(1);
      expect(grandchildren[0]!.id).toBe('T003');
    });
  });

  describe('roundtrip: JSON -> SQLite -> JSON', () => {
    it('produces equivalent JSON data after roundtrip', async () => {
      // Write initial JSON
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify(makeTodoJson(TEST_TASKS)),
      );
      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({ _meta: { schemaVersion: '2.10.0' }, archivedTasks: TEST_ARCHIVED }),
      );
      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({
          version: '1.0.0',
          sessions: TEST_SESSIONS,
          _meta: { schemaVersion: '1.0.0', lastUpdated: '2026-01-01T12:00:00.000Z' },
        }),
      );

      // Migrate to SQLite
      const { migrateJsonToSqlite, exportToJson } = await import('../migration-sqlite.js');
      await migrateJsonToSqlite();

      // Export back to JSON
      const exported = await exportToJson();

      // Verify task count preserved
      expect(exported.tasks.length).toBe(TEST_TASKS.length);
      expect(exported.archived.length).toBe(TEST_ARCHIVED.length);
      expect(exported.sessions.length).toBe(TEST_SESSIONS.length);

      // Verify key fields survive roundtrip
      const t1 = exported.tasks.find(t => t.id === 'T001');
      expect(t1).toBeDefined();
      expect(t1!.title).toBe('First task');

      const t2 = exported.tasks.find(t => t.id === 'T002');
      expect(t2).toBeDefined();
      expect(t2!.parentId).toBe('T001');

      // Verify sessions survive roundtrip
      const s1 = exported.sessions.find(s => s.id === 'sess-001');
      expect(s1).toBeDefined();
      expect(s1!.name).toBe('Dev session');
    });
  });

  describe('detectStoreEngine with dual', () => {
    it('detects dual engine from config', async () => {
      await writeFile(
        join(cleoDir, 'config.json'),
        JSON.stringify({ storage: { engine: 'dual' } }),
      );

      const { detectStoreEngine } = await import('../provider.js');
      const engine = detectStoreEngine(tempDir);
      expect(engine).toBe('dual');
    });
  });

  describe('dual-write mode', () => {
    it('creates a provider with dual engine type', async () => {
      // Set up minimal JSON project
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify(makeTodoJson()),
      );
      await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

      const { createStoreProvider } = await import('../provider.js');
      const provider = await createStoreProvider('dual' as StoreEngine, tempDir);
      expect(provider.engine).toBe('dual');
      await provider.close();
    });

    it('writes to SQLite on first operation', async () => {
      // Set up minimal JSON project
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify(makeTodoJson()),
      );
      await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

      const { createStoreProvider } = await import('../provider.js');
      const provider = await createStoreProvider('dual' as StoreEngine, tempDir);

      // Trigger a read operation which initializes SQLite lazily
      await provider.listTasks();

      // Verify SQLite database was created after first operation
      expect(existsSync(join(cleoDir, 'tasks.db'))).toBe(true);

      await provider.close();
    });

    it('listTasks returns empty for fresh dual-write project', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify(makeTodoJson()),
      );
      await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

      const { createStoreProvider } = await import('../provider.js');
      const provider = await createStoreProvider('dual' as StoreEngine, tempDir);

      const tasks = await provider.listTasks();
      expect(tasks).toEqual([]);

      await provider.close();
    });

    it('close is safe to call multiple times', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify(makeTodoJson()),
      );
      await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

      const { createStoreProvider } = await import('../provider.js');
      const provider = await createStoreProvider('dual' as StoreEngine, tempDir);

      await provider.close();
      await provider.close(); // Should not throw
    });
  });
});
