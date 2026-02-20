/**
 * Migration state tracking tests.
 *
 * @task T4726
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMigrationState,
  updateMigrationState,
  updateMigrationPhase,
  updateMigrationProgress,
  addMigrationError,
  addMigrationWarning,
  loadMigrationState,
  isMigrationInProgress,
  canResumeMigration,
  completeMigration,
  failMigration,
  clearMigrationState,
  getMigrationSummary,
  verifySourceIntegrity,
  type MigrationState,
} from '../state.js';

describe('migration state tracking', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-migration-test-'));
    cleoDir = join(tempDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });

    // Create test JSON files
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [
          { id: '1', title: 'Task 1' },
          { id: '2', title: 'Task 2' },
        ],
      }),
    );

    writeFileSync(
      join(cleoDir, 'sessions.json'),
      JSON.stringify({
        sessions: [
          { id: 's1', name: 'Session 1' },
        ],
      }),
    );

    writeFileSync(
      join(cleoDir, 'todo-archive.json'),
      JSON.stringify({
        archivedTasks: [
          { id: 'a1', title: 'Archived 1' },
        ],
      }),
    );
  });

  afterEach(async () => {
    try {
      await clearMigrationState(cleoDir);
      // Clean up temp dir
      const { rmSync } = await import('node:fs');
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('createMigrationState', () => {
    it('should create initial state with correct structure', async () => {
      const state = await createMigrationState(cleoDir);

      expect(state.version).toBe('1.0.0');
      expect(state.phase).toBe('init');
      expect(state.startedAt).toBeDefined();
      expect(state.errors).toEqual([]);
      expect(state.warnings).toEqual([]);
    });

    it('should capture source file info', async () => {
      const state = await createMigrationState(cleoDir);

      expect(state.sourceFiles.todoJson).toBeDefined();
      expect(state.sourceFiles.todoJson?.taskCount).toBe(2);
      expect(state.sourceFiles.todoJson?.checksum).toBeDefined();
      expect(state.sourceFiles.todoJson?.checksum.length).toBeGreaterThan(0);

      expect(state.sourceFiles.sessionsJson).toBeDefined();
      expect(state.sourceFiles.sessionsJson?.sessionCount).toBe(1);

      expect(state.sourceFiles.archiveJson).toBeDefined();
      expect(state.sourceFiles.archiveJson?.archivedCount).toBe(1);
    });

    it('should initialize progress counters', async () => {
      const state = await createMigrationState(cleoDir);

      expect(state.progress.tasksImported).toBe(0);
      expect(state.progress.archivedImported).toBe(0);
      expect(state.progress.sessionsImported).toBe(0);
      expect(state.progress.totalTasks).toBe(2);
      expect(state.progress.totalArchived).toBe(1);
      expect(state.progress.totalSessions).toBe(1);
    });

    it('should write state file to disk', async () => {
      await createMigrationState(cleoDir);

      const statePath = join(cleoDir, '.migration-state.json');
      expect(existsSync(statePath)).toBe(true);
    });
  });

  describe('updateMigrationState', () => {
    it('should update state with partial updates', async () => {
      await createMigrationState(cleoDir);

      const updated = await updateMigrationState(cleoDir, {
        phase: 'import',
        backupPath: '/some/backup/path',
      });

      expect(updated.phase).toBe('import');
      expect(updated.backupPath).toBe('/some/backup/path');
    });

    it('should throw if no state exists', async () => {
      await expect(updateMigrationState(cleoDir, { phase: 'import' }))
        .rejects
        .toThrow('No migration state exists');
    });

    it('should merge progress updates', async () => {
      await createMigrationState(cleoDir);

      const updated = await updateMigrationState(cleoDir, {
        progress: { 
          tasksImported: 5,
          archivedImported: 0,
          sessionsImported: 0,
          totalTasks: 2,
          totalArchived: 1,
          totalSessions: 1,
        },
      });

      expect(updated.progress.tasksImported).toBe(5);
      expect(updated.progress.archivedImported).toBe(0); // unchanged
      expect(updated.progress.totalTasks).toBe(2); // preserved from init
    });
  });

  describe('updateMigrationPhase', () => {
    it('should update phase', async () => {
      await createMigrationState(cleoDir);

      const updated = await updateMigrationPhase(cleoDir, 'backup');
      expect(updated.phase).toBe('backup');

      const updated2 = await updateMigrationPhase(cleoDir, 'import');
      expect(updated2.phase).toBe('import');
    });

    it('should update through all phases', async () => {
      await createMigrationState(cleoDir);

      const phases = ['backup', 'validate', 'import', 'verify', 'cleanup', 'complete'] as const;
      for (const phase of phases) {
        const updated = await updateMigrationPhase(cleoDir, phase);
        expect(updated.phase).toBe(phase);
      }
    });
  });

  describe('updateMigrationProgress', () => {
    it('should update progress counters', async () => {
      await createMigrationState(cleoDir);

      const updated = await updateMigrationProgress(cleoDir, {
        tasksImported: 1,
        archivedImported: 0,
        sessionsImported: 1,
      });

      expect(updated.progress.tasksImported).toBe(1);
      expect(updated.progress.archivedImported).toBe(0);
      expect(updated.progress.sessionsImported).toBe(1);
    });

    it('should preserve total counters', async () => {
      await createMigrationState(cleoDir);

      const updated = await updateMigrationProgress(cleoDir, { tasksImported: 1 });

      expect(updated.progress.totalTasks).toBe(2);
      expect(updated.progress.totalArchived).toBe(1);
      expect(updated.progress.totalSessions).toBe(1);
    });
  });

  describe('addMigrationError', () => {
    it('should add error to state', async () => {
      await createMigrationState(cleoDir);

      const updated = await addMigrationError(cleoDir, 'Something went wrong');

      expect(updated.errors).toContain('Something went wrong');
      expect(updated.phase).toBe('failed');
    });

    it('should accumulate multiple errors', async () => {
      await createMigrationState(cleoDir);

      await addMigrationError(cleoDir, 'Error 1');
      await addMigrationError(cleoDir, 'Error 2');

      const state = await loadMigrationState(cleoDir);
      expect(state?.errors).toContain('Error 1');
      expect(state?.errors).toContain('Error 2');
    });
  });

  describe('addMigrationWarning', () => {
    it('should add warning to state', async () => {
      await createMigrationState(cleoDir);

      const updated = await addMigrationWarning(cleoDir, 'This is a warning');

      expect(updated.warnings).toContain('This is a warning');
    });

    it('should not change phase', async () => {
      await createMigrationState(cleoDir);
      await updateMigrationPhase(cleoDir, 'import');

      const updated = await addMigrationWarning(cleoDir, 'Warning');

      expect(updated.phase).toBe('import');
    });
  });

  describe('loadMigrationState', () => {
    it('should return null if no state exists', async () => {
      const state = await loadMigrationState(cleoDir);
      expect(state).toBeNull();
    });

    it('should return state if it exists', async () => {
      await createMigrationState(cleoDir);

      const state = await loadMigrationState(cleoDir);
      expect(state).not.toBeNull();
      expect(state?.version).toBe('1.0.0');
    });
  });

  describe('isMigrationInProgress', () => {
    it('should return false if no state exists', async () => {
      const inProgress = await isMigrationInProgress(cleoDir);
      expect(inProgress).toBe(false);
    });

    it('should return true during migration', async () => {
      await createMigrationState(cleoDir);
      await updateMigrationPhase(cleoDir, 'import');

      const inProgress = await isMigrationInProgress(cleoDir);
      expect(inProgress).toBe(true);
    });

    it('should return false when complete', async () => {
      await createMigrationState(cleoDir);
      await completeMigration(cleoDir);

      const inProgress = await isMigrationInProgress(cleoDir);
      expect(inProgress).toBe(false);
    });

    it('should return false when failed', async () => {
      await createMigrationState(cleoDir);
      await failMigration(cleoDir, 'Error');

      const inProgress = await isMigrationInProgress(cleoDir);
      expect(inProgress).toBe(false);
    });
  });

  describe('canResumeMigration', () => {
    it('should return null if no state exists', async () => {
      const result = await canResumeMigration(cleoDir);
      expect(result).toBeNull();
    });

    it('should indicate can resume during migration', async () => {
      await createMigrationState(cleoDir);
      await updateMigrationPhase(cleoDir, 'import');
      await updateMigrationProgress(cleoDir, { tasksImported: 5 });

      const result = await canResumeMigration(cleoDir);
      expect(result?.canResume).toBe(true);
      expect(result?.phase).toBe('import');
      expect(result?.progress.tasksImported).toBe(5);
    });

    it('should indicate cannot resume when complete', async () => {
      await createMigrationState(cleoDir);
      await completeMigration(cleoDir);

      const result = await canResumeMigration(cleoDir);
      expect(result?.canResume).toBe(false);
      expect(result?.phase).toBe('complete');
    });

    it('should indicate cannot resume when failed', async () => {
      await createMigrationState(cleoDir);
      await failMigration(cleoDir, 'Error');

      const result = await canResumeMigration(cleoDir);
      expect(result?.canResume).toBe(false);
      expect(result?.phase).toBe('failed');
    });
  });

  describe('completeMigration', () => {
    it('should mark migration complete', async () => {
      await createMigrationState(cleoDir);

      const completed = await completeMigration(cleoDir);

      expect(completed.phase).toBe('complete');
      expect(completed.completedAt).toBeDefined();
    });

    it('should eventually clean up state', async () => {
      await createMigrationState(cleoDir);
      await completeMigration(cleoDir);

      // State is cleaned up after delay, so wait
      await new Promise((resolve) => setTimeout(resolve, 6000));

      const state = await loadMigrationState(cleoDir);
      expect(state).toBeNull();
    }, 10000);
  });

  describe('failMigration', () => {
    it('should mark migration failed', async () => {
      await createMigrationState(cleoDir);

      const failed = await failMigration(cleoDir, 'Migration failed');

      expect(failed.phase).toBe('failed');
      expect(failed.errors).toContain('Migration failed');
    });

    it('should preserve state for debugging', async () => {
      await createMigrationState(cleoDir);
      await updateMigrationPhase(cleoDir, 'import');
      await updateMigrationProgress(cleoDir, { tasksImported: 5 });

      await failMigration(cleoDir, 'Error occurred');

      const state = await loadMigrationState(cleoDir);
      expect(state?.phase).toBe('failed');
      expect(state?.progress.tasksImported).toBe(5);
    });
  });

  describe('clearMigrationState', () => {
    it('should remove state file', async () => {
      await createMigrationState(cleoDir);

      await clearMigrationState(cleoDir);

      const state = await loadMigrationState(cleoDir);
      expect(state).toBeNull();
    });

    it('should not throw if state does not exist', async () => {
      await expect(clearMigrationState(cleoDir)).resolves.not.toThrow();
    });
  });

  describe('getMigrationSummary', () => {
    it('should return null if no state exists', async () => {
      const summary = await getMigrationSummary(cleoDir);
      expect(summary).toBeNull();
    });

    it('should return formatted summary', async () => {
      await createMigrationState(cleoDir);
      await updateMigrationPhase(cleoDir, 'import');
      await updateMigrationProgress(cleoDir, { tasksImported: 1 });

      const summary = await getMigrationSummary(cleoDir);

      expect(summary).toContain('IMPORT');
      expect(summary).toContain('1/2 tasks');
    });
  });

  describe('verifySourceIntegrity', () => {
    it('should return invalid if no state exists', async () => {
      const result = await verifySourceIntegrity(cleoDir);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('state');
    });

    it('should detect unchanged files', async () => {
      await createMigrationState(cleoDir);

      const result = await verifySourceIntegrity(cleoDir);
      expect(result.valid).toBe(true);
      expect(result.changed).toEqual([]);
      expect(result.missing).toEqual([]);
    });

    it('should detect changed files', async () => {
      await createMigrationState(cleoDir);

      // Modify file
      writeFileSync(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [{ id: '1', title: 'Modified' }] }),
      );

      const result = await verifySourceIntegrity(cleoDir);
      expect(result.valid).toBe(false);
      expect(result.changed).toContain('todoJson');
    });

    it('should detect missing files', async () => {
      await createMigrationState(cleoDir);

      // Delete file
      const { unlinkSync } = await import('node:fs');
      unlinkSync(join(cleoDir, 'todo.json'));

      const result = await verifySourceIntegrity(cleoDir);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('todoJson');
    });
  });
});
