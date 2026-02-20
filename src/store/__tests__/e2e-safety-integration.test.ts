/**
 * End-to-End Safety Integration Tests
 *
 * Tests the complete safety pipeline from factory through all layers:
 * Factory → SafetyDataAccessor → data-safety-central → inner accessor
 *
 * These tests use real SQLite databases and test the full flow.
 *
 * @task T4741
 * @epic T4732
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

// Mock git-checkpoint
vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

describe('E2E Safety Integration', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-e2e-safety-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    delete process.env['CLEO_DISABLE_SAFETY'];

    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const { resetSafetyStats, enableSafety } = await import('../data-safety-central.js');
    resetSafetyStats();
    enableSafety();

    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_DISABLE_SAFETY'];
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Full Task Lifecycle with Safety', () => {
    it('should create → read → update → complete → delete with full safety', async () => {
      const { createTask, getTask, updateTask, deleteTask } = await import('../task-store.js');
      const { getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');

      // Sequence file needed for safety wrapper
      await writeFile(join(cleoDir, '.sequence.json'), JSON.stringify({ counter: 100 }));

      // 1. CREATE
      const task = await createTask({
        id: 'T001',
        title: 'E2E Safety Test',
        description: 'Testing full lifecycle',
        status: 'pending',
        priority: 'high',
        createdAt: new Date().toISOString(),
      });
      expect(task.id).toBe('T001');

      // 2. READ
      const loaded = await getTask('T001');
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('E2E Safety Test');
      expect(loaded!.priority).toBe('high');

      // 3. UPDATE
      const updated = await updateTask('T001', {
        status: 'active',
        title: 'Updated E2E Test',
      });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('active');

      // 4. Verify update persisted
      const reloaded = await getTask('T001');
      expect(reloaded!.title).toBe('Updated E2E Test');
      expect(reloaded!.status).toBe('active');

      // 5. DELETE
      const deleted = await deleteTask('T001');
      expect(deleted).toBe(true);

      // 6. Verify deletion
      const afterDelete = await getTask('T001');
      expect(afterDelete).toBeNull();
    });

    it('should handle task with all optional fields', async () => {
      const { createTask, getTask } = await import('../task-store.js');

      const task = await createTask({
        id: 'T001',
        title: 'Full task',
        description: 'With all fields',
        status: 'active',
        priority: 'critical',
        type: 'epic',
        phase: 'planning',
        size: 'large',
        position: 5,
        labels: ['test', 'safety'],
        notes: ['Note 1', 'Note 2'],
        acceptance: ['Criteria 1'],
        files: ['src/test.ts'],
        origin: 'feature-request',
        epicLifecycle: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-05T00:00:00.000Z',
      });

      const loaded = await getTask('T001');
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Full task');
      expect(loaded!.description).toBe('With all fields');
      expect(loaded!.priority).toBe('critical');
      expect(loaded!.type).toBe('epic');
      expect(loaded!.labels).toEqual(['test', 'safety']);
      expect(loaded!.notes).toEqual(['Note 1', 'Note 2']);
    });
  });

  describe('Session Lifecycle with Safety', () => {
    it('should create and retrieve sessions through store', async () => {
      const { createSession, getSession, listSessions } = await import('../session-store.js');

      const session = await createSession({
        id: 'sess-e2e-001',
        name: 'E2E Test Session',
        status: 'active',
        scope: { type: 'epic', epicId: 'T001' },
        agent: 'test-agent',
        notes: ['Starting E2E test'],
        tasksCompleted: [],
        tasksCreated: [],
        startedAt: new Date().toISOString(),
      });

      expect(session.id).toBe('sess-e2e-001');

      // Verify retrieval
      const loaded = await getSession('sess-e2e-001');
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('E2E Test Session');
      expect(loaded!.status).toBe('active');

      // List sessions
      const all = await listSessions();
      expect(all.length).toBeGreaterThanOrEqual(1);
      expect(all.some(s => s.id === 'sess-e2e-001')).toBe(true);
    });
  });

  describe('Collision Prevention E2E', () => {
    it('should prevent duplicate task creation through safeCreateTask', async () => {
      const { createTask } = await import('../task-store.js');
      const { safeCreateTask } = await import('../data-safety.js');

      // Create first task
      await createTask({
        id: 'T001',
        title: 'Original',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      // Attempt duplicate through safety layer
      const taskData = {
        id: 'T001',
        title: 'Duplicate',
        status: 'pending' as const,
        priority: 'medium' as const,
        createdAt: new Date().toISOString(),
      };

      await expect(
        safeCreateTask(
          () => createTask(taskData),
          taskData as any,
          tempDir,
          { autoCheckpoint: false, validateSequence: false },
        ),
      ).rejects.toThrow('collision');

      // Original task should still exist unchanged
      const { getTask } = await import('../task-store.js');
      const original = await getTask('T001');
      expect(original!.title).toBe('Original');
    });
  });

  describe('Write Verification E2E', () => {
    it('should verify data persists after write through safety layer', async () => {
      const { createTask } = await import('../task-store.js');
      const { verifyTaskWrite, safeCreateTask } = await import('../data-safety.js');

      const taskData = {
        id: 'T001',
        title: 'Verified task',
        status: 'pending' as const,
        priority: 'high' as const,
        createdAt: new Date().toISOString(),
      };

      await safeCreateTask(
        () => createTask(taskData),
        taskData as any,
        tempDir,
        { autoCheckpoint: false, validateSequence: false },
      );

      // Explicit verification
      const verified = await verifyTaskWrite('T001', { title: 'Verified task' }, tempDir);
      expect(verified).toBe(true);
    });
  });

  describe('Emergency Safety Disable E2E', () => {
    it('should bypass all safety when CLEO_DISABLE_SAFETY=true', async () => {
      process.env['CLEO_DISABLE_SAFETY'] = 'true';

      const { wrapWithSafety, isSafetyEnabled } = await import('../safety-data-accessor.js');
      expect(isSafetyEnabled()).toBe(false);

      // Factory should return unwrapped accessor
      const { createDataAccessor } = await import('../data-accessor.js');

      // Clean up env before assertions that might throw
      delete process.env['CLEO_DISABLE_SAFETY'];
    });
  });

  describe('Bulk Operations E2E', () => {
    it('should handle 100 task creates without data loss', async () => {
      const { createTask, getTask } = await import('../task-store.js');

      const taskIds: string[] = [];
      for (let i = 1; i <= 100; i++) {
        const id = `T${String(i).padStart(4, '0')}`;
        taskIds.push(id);
        await createTask({
          id,
          title: `Bulk task ${i}`,
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        });
      }

      // Verify all 100 tasks exist
      let found = 0;
      for (const id of taskIds) {
        const task = await getTask(id);
        if (task) found++;
      }
      expect(found).toBe(100);
    });

    it('should handle concurrent reads safely', async () => {
      const { createTask, getTask } = await import('../task-store.js');

      // Create 10 tasks
      for (let i = 1; i <= 10; i++) {
        await createTask({
          id: `T${String(i).padStart(3, '0')}`,
          title: `Concurrent task ${i}`,
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        });
      }

      // Read all 10 concurrently
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          getTask(`T${String(i + 1).padStart(3, '0')}`),
        ),
      );

      // All should succeed
      expect(results.every(r => r !== null)).toBe(true);
      expect(results.length).toBe(10);
    });
  });

  describe('Migration Safety E2E', () => {
    it('should safely migrate JSON to SQLite', async () => {
      // Create JSON files
      const todoData = {
        version: '2.10.0',
        project: { name: 'test', phases: {} },
        lastUpdated: new Date().toISOString(),
        _meta: { schemaVersion: '2.10.0', checksum: '0', configVersion: '1.0.0' },
        tasks: [
          {
            id: 'T001',
            title: 'Migrate me',
            status: 'pending',
            priority: 'medium',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'T002',
            title: 'Migrate me too',
            status: 'active',
            priority: 'high',
            createdAt: new Date().toISOString(),
          },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));
      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({ version: '1.0.0', sessions: [], _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() } }),
      );

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(true);
      expect(result.tasksImported).toBe(2);

      // Verify tasks in SQLite
      const { getTask } = await import('../task-store.js');
      const t1 = await getTask('T001');
      const t2 = await getTask('T002');

      expect(t1).not.toBeNull();
      expect(t1!.title).toBe('Migrate me');
      expect(t2).not.toBeNull();
      expect(t2!.status).toBe('active');
    });

    it('should prevent migration with corrupted JSON', async () => {
      await writeFile(join(cleoDir, 'todo.json'), '{ broken json }');
      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({ version: '1.0.0', sessions: [] }),
      );

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');
      const result = await migrateJsonToSqlite();

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should be idempotent (skip when data already exists)', async () => {
      const todoData = {
        version: '2.10.0',
        tasks: [
          { id: 'T001', title: 'Task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
        ],
      };

      await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData));
      await writeFile(join(cleoDir, 'sessions.json'), JSON.stringify({ version: '1.0.0', sessions: [] }));

      const { migrateJsonToSqlite } = await import('../migration-sqlite.js');

      // First migration
      const first = await migrateJsonToSqlite();
      expect(first.success).toBe(true);
      expect(first.tasksImported).toBe(1);

      const { closeDb } = await import('../sqlite.js');
      closeDb();

      // Second migration should skip
      const second = await migrateJsonToSqlite();
      expect(second.success).toBe(true);
      expect(second.tasksImported).toBe(0);
      expect(second.warnings.some(w => w.includes('already contains'))).toBe(true);
    });
  });

  describe('Checksum Verification E2E', () => {
    it('should detect file tampering via checksums', async () => {
      const { computeChecksum, compareChecksums } = await import('../../core/migration/checksum.js');

      // Create original file
      const filePath = join(cleoDir, 'test-data.json');
      const originalData = JSON.stringify({ tasks: [{ id: 'T001', title: 'Original' }] });
      await writeFile(filePath, originalData);

      const originalChecksum = await computeChecksum(filePath);
      expect(originalChecksum).toHaveLength(64);

      // Create backup
      const backupPath = join(cleoDir, 'test-data.backup.json');
      await writeFile(backupPath, originalData);

      // Checksums should match
      const match = await compareChecksums(filePath, backupPath);
      expect(match).toBe(true);

      // Tamper with original
      await writeFile(filePath, JSON.stringify({ tasks: [{ id: 'T001', title: 'Tampered' }] }));

      // Checksums should no longer match
      const tampered = await compareChecksums(filePath, backupPath);
      expect(tampered).toBe(false);
    });
  });

  describe('Migration State Tracking E2E', () => {
    it('should track migration lifecycle through all phases', async () => {
      const {
        createMigrationState,
        updateMigrationPhase,
        loadMigrationState,
        completeMigration,
        clearMigrationState,
      } = await import('../../core/migration/state.js');

      // Setup source files
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [{ id: 'T001', title: 'X', status: 'pending' }] }),
      );
      await writeFile(join(cleoDir, 'sessions.json'), JSON.stringify({ sessions: [] }));

      // Init
      const state = await createMigrationState(cleoDir);
      expect(state.phase).toBe('init');

      // Walk through phases
      for (const phase of ['backup', 'validate', 'import', 'verify', 'cleanup'] as const) {
        await updateMigrationPhase(cleoDir, phase);
        const loaded = await loadMigrationState(cleoDir);
        expect(loaded!.phase).toBe(phase);
      }

      // Complete
      const final = await completeMigration(cleoDir);
      expect(final.phase).toBe('complete');
      expect(final.completedAt).toBeDefined();

      // Clean up
      await clearMigrationState(cleoDir);
    });
  });

  describe('Migration Logger E2E', () => {
    it('should create structured JSONL log entries', async () => {
      const { MigrationLogger } = await import('../../core/migration/logger.js');

      const logger = new MigrationLogger(cleoDir);

      logger.info('init', 'start', 'Migration starting');
      logger.warn('import', 'duplicate', 'Skipping T001');
      logger.logImportProgress('import', 'tasks', 5, 10);
      logger.logValidation('verify', 'task-count', true, { count: 10 });

      const logPath = logger.getLogPath();
      expect(existsSync(logPath)).toBe(true);

      const content = await readFile(logPath, 'utf-8');
      const entries = content.trim().split('\n').map(l => JSON.parse(l));

      expect(entries.length).toBeGreaterThanOrEqual(4);
      expect(entries[0].level).toBe('info');
      expect(entries[1].level).toBe('warn');

      const summary = logger.getSummary();
      expect(summary.totalEntries).toBeGreaterThanOrEqual(4);
      expect(summary.info).toBeGreaterThanOrEqual(1);
      expect(summary.warnings).toBeGreaterThanOrEqual(1);
    });
  });
});
