/**
 * Data Safety Central - Unit Tests
 *
 * Tests the centralized safety manager that wraps all data operations
 * with sequence validation, write verification, and checkpointing.
 *
 * Coverage:
 * - safeSaveTaskFile: sequence check -> write -> verify -> checkpoint
 * - safeSaveSessions: write -> verify -> checkpoint
 * - safeSaveArchive: write -> verify -> checkpoint
 * - safeAppendLog: write -> checkpoint (no verification)
 * - runDataIntegrityCheck: comprehensive validation
 * - getSafetyStats / resetSafetyStats: statistics tracking
 * - enableSafety / disableSafety: runtime toggle
 *
 * @task T4741
 * @epic T4732
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskFile } from '../../types/task.js';
import type { DataAccessor, ArchiveFile, SessionsFile } from '../data-accessor.js';

// Mock git-checkpoint to prevent real git operations
vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

describe('Data Safety Central', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-safety-central-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Reset module state
    const mod = await import('../data-safety-central.js');
    mod.resetSafetyStats();
    mod.enableSafety();

    // Clear mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- Fixtures ----

  const makeTaskFile = (tasks: TaskFile['tasks'] = []): TaskFile => ({
    version: '2.10.0',
    project: { name: 'test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: { schemaVersion: '2.10.0', checksum: '0', configVersion: '1.0.0' },
    tasks,
  });

  const makeSessionsFile = (count = 0): SessionsFile => ({
    sessions: Array.from({ length: count }, (_, i) => ({
      id: `sess-${i}`,
      name: `Session ${i}`,
      status: 'ended' as const,
      scope: { type: 'epic' as const, epicId: 'T001' },
      agent: 'test',
      notes: [],
      tasksCompleted: [],
      tasksCreated: [],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    })),
    version: '1.0.0',
    _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
  });

  const makeArchiveFile = (count = 0): ArchiveFile => ({
    archivedTasks: Array.from({ length: count }, (_, i) => ({
      id: `T${900 + i}`,
      title: `Archived task ${i}`,
      status: 'done' as const,
      priority: 'medium' as const,
      createdAt: new Date().toISOString(),
    })) as ArchiveFile['archivedTasks'],
  });

  /**
   * Create a mock DataAccessor that stores data in memory.
   */
  function createMockAccessor(): DataAccessor & {
    _taskFile: TaskFile;
    _sessions: SessionsFile;
    _archive: ArchiveFile | null;
    _logs: Record<string, unknown>[];
  } {
    const mock = {
      engine: 'json' as const,
      _taskFile: makeTaskFile(),
      _sessions: makeSessionsFile(),
      _archive: null as ArchiveFile | null,
      _logs: [] as Record<string, unknown>[],

      async loadTaskFile() {
        return mock._taskFile;
      },
      async saveTaskFile(data: TaskFile) {
        mock._taskFile = data;
      },
      async loadTodoFile() {
        return mock._taskFile;
      },
      async saveTodoFile(data: TaskFile) {
        mock._taskFile = data;
      },
      async loadArchive() {
        return mock._archive;
      },
      async saveArchive(data: ArchiveFile) {
        mock._archive = data;
      },
      async loadSessions() {
        return mock._sessions;
      },
      async saveSessions(data: SessionsFile) {
        mock._sessions = data;
      },
      async appendLog(entry: Record<string, unknown>) {
        mock._logs.push(entry);
      },
      async close() {},
    };
    return mock;
  }

  // ---- Statistics Tracking ----

  describe('Safety Statistics', () => {
    it('should start with zero stats', async () => {
      const { getSafetyStats } = await import('../data-safety-central.js');
      const stats = getSafetyStats();
      expect(stats.writes).toBe(0);
      expect(stats.verifications).toBe(0);
      expect(stats.checkpoints).toBe(0);
      expect(stats.errors).toBe(0);
      expect(stats.lastCheckpoint).toBeNull();
    });

    it('should reset stats correctly', async () => {
      const { resetSafetyStats, getSafetyStats, safeSaveTaskFile } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();

      // Perform a write to increment stats
      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        checkpoint: false,
        validateSequence: false,
      });

      expect(getSafetyStats().writes).toBeGreaterThan(0);

      resetSafetyStats();
      const stats = getSafetyStats();
      expect(stats.writes).toBe(0);
      expect(stats.verifications).toBe(0);
    });

    it('should increment writes on saveTaskFile', async () => {
      const { safeSaveTaskFile, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        checkpoint: false,
        validateSequence: false,
      });

      expect(getSafetyStats().writes).toBe(1);
    });

    it('should increment verifications when verify is enabled', async () => {
      const { safeSaveTaskFile, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        verify: true,
        checkpoint: false,
        validateSequence: false,
      });

      expect(getSafetyStats().verifications).toBe(1);
    });

    it('should not increment verifications when verify is disabled', async () => {
      const { safeSaveTaskFile, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        verify: false,
        checkpoint: false,
        validateSequence: false,
      });

      expect(getSafetyStats().verifications).toBe(0);
    });

    it('should increment checkpoints after write', async () => {
      const { safeSaveTaskFile, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        verify: false,
        checkpoint: true,
        validateSequence: false,
      });

      expect(getSafetyStats().checkpoints).toBe(1);
      expect(getSafetyStats().lastCheckpoint).not.toBeNull();
    });
  });

  // ---- Write Verification ----

  describe('Write Verification', () => {
    it('should pass verification when task count matches', async () => {
      const { safeSaveTaskFile } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      const taskFile = makeTaskFile([
        { id: 'T001', title: 'Test', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      ] as TaskFile['tasks']);

      // Should not throw
      await safeSaveTaskFile(accessor, taskFile, tempDir, {
        verify: true,
        checkpoint: false,
        validateSequence: false,
      });

      // Verify the data was actually stored
      expect(accessor._taskFile.tasks?.length).toBe(1);
    });

    it('should fail verification when task count mismatches', async () => {
      const { safeSaveTaskFile } = await import('../data-safety-central.js');

      // Create an accessor where saveTaskFile loses a task
      const accessor = createMockAccessor();
      const originalSave = accessor.saveTaskFile.bind(accessor);
      accessor.saveTaskFile = async (data: TaskFile) => {
        // Simulate data loss: save fewer tasks than written
        const modified = { ...data, tasks: (data.tasks ?? []).slice(0, 1) };
        await originalSave(modified);
      };

      const taskFile = makeTaskFile([
        { id: 'T001', title: 'A', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
        { id: 'T002', title: 'B', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      ] as TaskFile['tasks']);

      await expect(
        safeSaveTaskFile(accessor, taskFile, tempDir, {
          verify: true,
          checkpoint: false,
          validateSequence: false,
          strict: true,
        }),
      ).rejects.toThrow('count mismatch');
    });

    it('should fail verification when tasks array is missing', async () => {
      const { safeSaveTaskFile } = await import('../data-safety-central.js');

      const accessor = createMockAccessor();
      // After save, the loadTaskFile returns data without tasks array
      accessor.loadTaskFile = async () => ({ ...makeTaskFile(), tasks: undefined as unknown as TaskFile['tasks'] });

      const taskFile = makeTaskFile([
        { id: 'T001', title: 'A', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      ] as TaskFile['tasks']);

      await expect(
        safeSaveTaskFile(accessor, taskFile, tempDir, {
          verify: true,
          checkpoint: false,
          validateSequence: false,
          strict: true,
        }),
      ).rejects.toThrow('tasks array missing');
    });

    it('should fail verification when last written task is not found', async () => {
      const { safeSaveTaskFile } = await import('../data-safety-central.js');

      const accessor = createMockAccessor();
      // Return different tasks than what was written
      accessor.loadTaskFile = async () =>
        makeTaskFile([
          { id: 'T999', title: 'Wrong', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
        ] as TaskFile['tasks']);

      const taskFile = makeTaskFile([
        { id: 'T001', title: 'Correct', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      ] as TaskFile['tasks']);

      await expect(
        safeSaveTaskFile(accessor, taskFile, tempDir, {
          verify: true,
          checkpoint: false,
          validateSequence: false,
          strict: true,
        }),
      ).rejects.toThrow('not found');
    });
  });

  // ---- Sessions Verification ----

  describe('Session Safety', () => {
    it('should verify session count after save', async () => {
      const { safeSaveSessions } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      const sessions = makeSessionsFile(3);

      await safeSaveSessions(accessor, sessions, tempDir, {
        checkpoint: false,
      });

      expect(accessor._sessions.sessions.length).toBe(3);
    });

    it('should fail when session count mismatches', async () => {
      const { safeSaveSessions } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();

      // After save, return fewer sessions
      accessor.loadSessions = async () => makeSessionsFile(1);

      await expect(
        safeSaveSessions(accessor, makeSessionsFile(3), tempDir, {
          verify: true,
          checkpoint: false,
          strict: true,
        }),
      ).rejects.toThrow('count mismatch');
    });
  });

  // ---- Archive Verification ----

  describe('Archive Safety', () => {
    it('should verify archive count after save', async () => {
      const { safeSaveArchive } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      const archive = makeArchiveFile(5);

      await safeSaveArchive(accessor, archive, tempDir, {
        checkpoint: false,
      });

      expect(accessor._archive?.archivedTasks.length).toBe(5);
    });

    it('should fail when archive is null after save', async () => {
      const { safeSaveArchive } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      accessor.loadArchive = async () => null;

      await expect(
        safeSaveArchive(accessor, makeArchiveFile(2), tempDir, {
          verify: true,
          checkpoint: false,
          strict: true,
        }),
      ).rejects.toThrow('not found after write');
    });

    it('should fail when archive count mismatches', async () => {
      const { safeSaveArchive } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      accessor.loadArchive = async () => makeArchiveFile(1);

      await expect(
        safeSaveArchive(accessor, makeArchiveFile(5), tempDir, {
          verify: true,
          checkpoint: false,
          strict: true,
        }),
      ).rejects.toThrow('count mismatch');
    });
  });

  // ---- Log Safety ----

  describe('Log Safety', () => {
    it('should append log entry without verification', async () => {
      const { safeAppendLog, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      await safeAppendLog(accessor, { action: 'test', timestamp: new Date().toISOString() }, tempDir, {
        checkpoint: false,
      });

      expect(accessor._logs.length).toBe(1);
      expect(getSafetyStats().writes).toBe(1);
      // Logs don't have verification
      expect(getSafetyStats().verifications).toBe(0);
    });
  });

  // ---- Checkpoint Behavior ----

  describe('Checkpointing', () => {
    it('should call gitCheckpoint when checkpoint is enabled', async () => {
      const { gitCheckpoint } = await import('../git-checkpoint.js');
      const { safeSaveTaskFile, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        verify: false,
        checkpoint: true,
        validateSequence: false,
      });

      expect(gitCheckpoint).toHaveBeenCalledWith('auto', expect.stringContaining('TaskFile'), tempDir);
    });

    it('should NOT call gitCheckpoint when checkpoint is disabled', async () => {
      const { gitCheckpoint } = await import('../git-checkpoint.js');
      const { safeSaveTaskFile, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        verify: false,
        checkpoint: false,
        validateSequence: false,
      });

      expect(gitCheckpoint).not.toHaveBeenCalled();
    });

    it('should not fail the operation when checkpoint throws', async () => {
      const gitMod = await import('../git-checkpoint.js');
      vi.mocked(gitMod.gitCheckpoint).mockRejectedValueOnce(new Error('git not found'));

      const { safeSaveTaskFile, getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();
      const accessor = createMockAccessor();

      // Should not throw even though checkpoint fails
      await safeSaveTaskFile(accessor, makeTaskFile(), tempDir, {
        verify: false,
        checkpoint: true,
        validateSequence: false,
      });

      // Write still succeeded
      expect(getSafetyStats().writes).toBe(1);
    });
  });

  // ---- Enable/Disable Safety ----

  describe('Safety Toggle', () => {
    it('should disable all safety options', async () => {
      const { disableSafety, safeSaveTaskFile, getSafetyStats, resetSafetyStats, enableSafety } = await import('../data-safety-central.js');
      resetSafetyStats();

      disableSafety();

      const accessor = createMockAccessor();
      // Even with corrupted data, should not throw because strict is off
      accessor.loadTaskFile = async () => ({ ...makeTaskFile(), tasks: undefined as unknown as TaskFile['tasks'] });

      // Will not throw because verify=false when disabled
      await safeSaveTaskFile(accessor, makeTaskFile([{ id: 'T001', title: 'X', status: 'pending', priority: 'medium', createdAt: '' }] as TaskFile['tasks']), tempDir);

      // Re-enable for other tests
      enableSafety();
    });

    it('should re-enable safety after disable', async () => {
      const { disableSafety, enableSafety, safeSaveTaskFile } = await import('../data-safety-central.js');

      disableSafety();
      enableSafety();

      const accessor = createMockAccessor();
      accessor.loadTaskFile = async () => ({ ...makeTaskFile(), tasks: undefined as unknown as TaskFile['tasks'] });

      // Now verification should be active again and should throw
      await expect(
        safeSaveTaskFile(accessor, makeTaskFile([{ id: 'T001', title: 'X', status: 'pending', priority: 'medium', createdAt: '' }] as TaskFile['tasks']), tempDir, {
          validateSequence: false,
          checkpoint: false,
        }),
      ).rejects.toThrow();
    });
  });

  // ---- Data Integrity Check ----

  describe('Data Integrity Check', () => {
    it('should pass when all data loads correctly', async () => {
      const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      accessor._taskFile = makeTaskFile();
      accessor._sessions = makeSessionsFile();

      const result = await checkIntegrity(accessor, tempDir);

      // May have sequence warnings, but should not have structural errors
      expect(result.stats).toBeDefined();
    });

    it('should report error when TaskFile fails to load', async () => {
      const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      accessor.loadTaskFile = async () => {
        throw new Error('corrupted');
      };

      const result = await checkIntegrity(accessor, tempDir);

      expect(result.passed).toBe(false);
      expect(result.errors.some(e => e.includes('TaskFile load failed'))).toBe(true);
    });

    it('should report error when TaskFile is missing tasks array', async () => {
      const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      accessor.loadTaskFile = async () =>
        ({ ...makeTaskFile(), tasks: undefined } as unknown as TaskFile);

      const result = await checkIntegrity(accessor, tempDir);

      expect(result.errors.some(e => e.includes('tasks array'))).toBe(true);
    });

    it('should report error when SessionsFile fails to load', async () => {
      const { runDataIntegrityCheck: checkIntegrity } = await import('../data-safety-central.js');
      const accessor = createMockAccessor();
      accessor.loadSessions = async () => {
        throw new Error('session corruption');
      };

      const result = await checkIntegrity(accessor, tempDir);

      expect(result.errors.some(e => e.includes('SessionsFile load failed'))).toBe(true);
    });
  });
});
