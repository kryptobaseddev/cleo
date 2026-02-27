/**
 * Integration tests for migration failure scenarios.
 *
 * Tests that the migration system handles failures safely:
 * - State machine tracks phases and supports resume after interruption
 * - Invalid JSON source files are rejected before destructive operations
 * - Completed/failed migrations cannot be re-run via the state machine
 * - Logger captures structured failure events
 * - File locking prevents concurrent migration attempts
 *
 * @task T4729
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createMigrationState,
  updateMigrationPhase,
  updateMigrationProgress,
  loadMigrationState,
  isMigrationInProgress,
  canResumeMigration,
  completeMigration,
  failMigration,
  clearMigrationState,
  addMigrationError,
  verifySourceIntegrity,
  type MigrationPhase,
} from '../state.js';

import {
  validateSourceFiles,
  checkTaskCountMismatch,
} from '../validate.js';

import {
  MigrationLogger,
  readMigrationLog,
} from '../logger.js';

import { acquireLock, isLocked, withLock } from '../../../store/lock.js';

describe('migration failure integration: state machine recovery', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mig-fail-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    // Create valid source files for state tracking
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [
          { id: 'T001', title: 'Task 1', status: 'pending' },
          { id: 'T002', title: 'Task 2', status: 'done' },
        ],
      }),
    );

    await writeFile(
      join(cleoDir, 'sessions.json'),
      JSON.stringify({
        sessions: [{ id: 's1', name: 'Session 1' }],
      }),
    );

    await writeFile(
      join(cleoDir, 'todo-archive.json'),
      JSON.stringify({
        archivedTasks: [{ id: 'a1', title: 'Archived 1' }],
      }),
    );
  });

  afterEach(async () => {
    try {
      await clearMigrationState(cleoDir);
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const ORDERED_PHASES: MigrationPhase[] = [
    'init', 'backup', 'validate', 'import', 'verify', 'cleanup', 'complete',
  ];

  it('should track phase progression through the full lifecycle', async () => {
    await createMigrationState(cleoDir);

    for (const phase of ORDERED_PHASES) {
      const updated = await updateMigrationPhase(cleoDir, phase);
      expect(updated.phase).toBe(phase);

      const loaded = await loadMigrationState(cleoDir);
      expect(loaded?.phase).toBe(phase);
    }
  });

  it('should allow resume from each interruptible phase', async () => {
    const interruptiblePhases: MigrationPhase[] = [
      'init', 'backup', 'validate', 'import', 'verify', 'cleanup',
    ];

    for (const phase of interruptiblePhases) {
      // Simulate: create state, advance to phase, then "crash"
      await createMigrationState(cleoDir);
      await updateMigrationPhase(cleoDir, phase);

      // Simulate partial progress during import
      if (phase === 'import') {
        await updateMigrationProgress(cleoDir, { tasksImported: 1 });
      }

      // Verify resume is possible
      const resumeInfo = await canResumeMigration(cleoDir);
      expect(resumeInfo).not.toBeNull();
      expect(resumeInfo?.canResume).toBe(true);
      expect(resumeInfo?.phase).toBe(phase);

      // Verify isMigrationInProgress agrees
      const inProgress = await isMigrationInProgress(cleoDir);
      expect(inProgress).toBe(true);

      // Clean up for next iteration
      await clearMigrationState(cleoDir);
    }
  });

  it('should preserve progress counters across simulated interruption', async () => {
    await createMigrationState(cleoDir);
    await updateMigrationPhase(cleoDir, 'import');
    await updateMigrationProgress(cleoDir, {
      tasksImported: 1,
      archivedImported: 0,
      sessionsImported: 0,
    });

    // Simulate interruption: reload state from disk
    const recovered = await loadMigrationState(cleoDir);
    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe('import');
    expect(recovered!.progress.tasksImported).toBe(1);
    expect(recovered!.progress.totalTasks).toBe(2);

    // Resume: continue from where we left off
    await updateMigrationProgress(cleoDir, { tasksImported: 2 });
    await updateMigrationPhase(cleoDir, 'verify');

    const afterResume = await loadMigrationState(cleoDir);
    expect(afterResume!.phase).toBe('verify');
    expect(afterResume!.progress.tasksImported).toBe(2);
  });

  it('should detect source file changes during migration', async () => {
    await createMigrationState(cleoDir);
    await updateMigrationPhase(cleoDir, 'import');

    // Modify source file mid-migration
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({ tasks: [{ id: 'T001', title: 'MODIFIED', status: 'pending' }] }),
    );

    const integrity = await verifySourceIntegrity(cleoDir);
    expect(integrity.valid).toBe(false);
    expect(integrity.changed).toContain('todoJson');
  });

  it('should record errors when a phase fails', async () => {
    await createMigrationState(cleoDir);
    await updateMigrationPhase(cleoDir, 'import');

    // Simulate failure during import
    const failed = await addMigrationError(cleoDir, 'Import failed: disk full');

    expect(failed.phase).toBe('failed');
    expect(failed.errors).toContain('Import failed: disk full');

    // Verify cannot resume after failure
    const resumeInfo = await canResumeMigration(cleoDir);
    expect(resumeInfo?.canResume).toBe(false);
    expect(resumeInfo?.phase).toBe('failed');
  });
});

describe('migration failure integration: JSON validation before destructive ops', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mig-validate-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should reject corrupted todo.json with trailing comma', async () => {
    await writeFile(
      join(cleoDir, 'todo.json'),
      '{ "tasks": [ { "id": "T001" }, ] }',
    );

    const result = validateSourceFiles(cleoDir);

    expect(result.valid).toBe(false);
    expect(result.todoJson.valid).toBe(false);
    expect(result.todoJson.error).toContain('Parse error');
  });

  it('should reject truncated JSON (simulating interrupted write)', async () => {
    await writeFile(
      join(cleoDir, 'todo.json'),
      '{ "tasks": [ { "id": "T001", "title": "Test"',
    );

    const result = validateSourceFiles(cleoDir);

    expect(result.valid).toBe(false);
    expect(result.todoJson.valid).toBe(false);
    expect(result.todoJson.error).toContain('Parse error');
  });

  it('should reject empty files', async () => {
    await writeFile(join(cleoDir, 'todo.json'), '');

    const result = validateSourceFiles(cleoDir);

    expect(result.valid).toBe(false);
    expect(result.todoJson.valid).toBe(false);
    expect(result.todoJson.error).toContain('empty');
  });

  it('should reject whitespace-only files', async () => {
    await writeFile(join(cleoDir, 'todo.json'), '   \n\t  \n');

    const result = validateSourceFiles(cleoDir);

    expect(result.valid).toBe(false);
    expect(result.todoJson.valid).toBe(false);
    expect(result.todoJson.error).toContain('whitespace');
  });

  it('should reject corrupted sessions.json while accepting valid todo.json', async () => {
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({ tasks: [{ id: 'T001', title: 'Valid', status: 'pending' }] }),
    );
    await writeFile(
      join(cleoDir, 'sessions.json'),
      'not valid json at all',
    );

    const result = validateSourceFiles(cleoDir);

    expect(result.valid).toBe(false);
    expect(result.todoJson.valid).toBe(true);
    expect(result.sessionsJson.valid).toBe(false);
  });

  it('should detect mismatch when DB exists but JSON has 0 tasks', async () => {
    // Create a non-empty database file
    await writeFile(join(cleoDir, 'tasks.db'), Buffer.alloc(8192));

    const warning = checkTaskCountMismatch(cleoDir, 0);

    expect(warning).not.toBeNull();
    expect(warning).toContain('WARNING');
    expect(warning).toContain('data loss');
  });

  it('should validate all files and provide per-file error details', async () => {
    await writeFile(join(cleoDir, 'todo.json'), '{ broken }');
    await writeFile(join(cleoDir, 'sessions.json'), '[ also broken');
    await writeFile(
      join(cleoDir, 'todo-archive.json'),
      JSON.stringify({ archivedTasks: [{ id: 'a1' }] }),
    );

    const result = validateSourceFiles(cleoDir);

    expect(result.valid).toBe(false);
    expect(result.todoJson.valid).toBe(false);
    expect(result.sessionsJson.valid).toBe(false);
    expect(result.archiveJson.valid).toBe(true);
    expect(result.archiveJson.count).toBe(1);
  });
});

describe('migration failure integration: completed migration guard', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mig-guard-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({ tasks: [{ id: 'T001', title: 'Task 1' }] }),
    );
  });

  afterEach(async () => {
    try {
      await clearMigrationState(cleoDir);
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should report canResume=false for completed migrations', async () => {
    await createMigrationState(cleoDir);
    await completeMigration(cleoDir);

    const resumeInfo = await canResumeMigration(cleoDir);
    expect(resumeInfo).not.toBeNull();
    expect(resumeInfo!.canResume).toBe(false);
    expect(resumeInfo!.phase).toBe('complete');
  });

  it('should report canResume=false for failed migrations', async () => {
    await createMigrationState(cleoDir);
    await failMigration(cleoDir, 'Something broke');

    const resumeInfo = await canResumeMigration(cleoDir);
    expect(resumeInfo).not.toBeNull();
    expect(resumeInfo!.canResume).toBe(false);
    expect(resumeInfo!.phase).toBe('failed');
    expect(resumeInfo!.errors).toContain('Something broke');
  });

  it('should report not in progress for completed state', async () => {
    await createMigrationState(cleoDir);
    await completeMigration(cleoDir);

    const inProgress = await isMigrationInProgress(cleoDir);
    expect(inProgress).toBe(false);
  });

  it('should report not in progress for failed state', async () => {
    await createMigrationState(cleoDir);
    await failMigration(cleoDir, 'Error');

    const inProgress = await isMigrationInProgress(cleoDir);
    expect(inProgress).toBe(false);
  });

  it('should preserve error details in failed state for diagnostics', async () => {
    await createMigrationState(cleoDir);
    await updateMigrationPhase(cleoDir, 'import');
    await updateMigrationProgress(cleoDir, { tasksImported: 3 });
    await failMigration(cleoDir, 'Disk full during import');

    const state = await loadMigrationState(cleoDir);
    expect(state).not.toBeNull();
    expect(state!.phase).toBe('failed');
    expect(state!.progress.tasksImported).toBe(3);
    expect(state!.errors).toContain('Disk full during import');
    // State is preserved on disk for debugging, not auto-cleaned
    expect(existsSync(join(cleoDir, '.migration-state.json'))).toBe(true);
  });
});

describe('migration failure integration: logger captures failure events', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mig-log-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should capture phase failure with error details', () => {
    const logger = new MigrationLogger(tempDir);

    logger.phaseStart('import');
    logger.phaseFailed('import', new Error('Connection refused'), {
      tasksProcessed: 5,
      totalTasks: 20,
    });

    const entries = logger.getEntries();
    expect(entries).toHaveLength(2);

    const failEntry = entries[1];
    expect(failEntry.level).toBe('error');
    expect(failEntry.phase).toBe('import');
    expect(failEntry.operation).toBe('failed');
    expect(failEntry.data).toMatchObject({
      error: 'Connection refused',
      tasksProcessed: 5,
      totalTasks: 20,
    });
    expect(failEntry.data?.stack).toBeDefined();
  });

  it('should capture validation failures with structured data', () => {
    const logger = new MigrationLogger(tempDir);

    logger.logValidation('validate', 'todo.json', false, { size: 0 }, [
      'File is empty (0 bytes)',
    ]);

    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('error');
    expect(entries[0].data).toMatchObject({
      target: 'todo.json',
      valid: false,
      size: 0,
      errors: ['File is empty (0 bytes)'],
    });
  });

  it('should persist failure logs to JSONL file on disk', () => {
    const logger = new MigrationLogger(tempDir);

    logger.phaseStart('backup');
    logger.error('backup', 'file-copy', 'Failed to copy database', {
      source: 'tasks.db',
      errno: 'ENOSPC',
    });
    logger.phaseFailed('backup', 'No space left on device');

    const logPath = logger.getLogPath();
    expect(existsSync(logPath)).toBe(true);

    const diskEntries = readMigrationLog(logPath);
    expect(diskEntries).toHaveLength(3);

    const errorEntry = diskEntries.find(
      (e) => e.operation === 'file-copy',
    );
    expect(errorEntry).toBeDefined();
    expect(errorEntry!.level).toBe('error');
    expect(errorEntry!.data).toMatchObject({
      source: 'tasks.db',
      errno: 'ENOSPC',
    });
  });

  it('should track failure timing via durationMs', async () => {
    const logger = new MigrationLogger(tempDir);

    logger.phaseStart('init');
    await new Promise((resolve) => setTimeout(resolve, 50));
    logger.phaseFailed('init', 'Timeout');

    const entries = logger.getEntries();
    expect(entries[1].durationMs).toBeGreaterThan(entries[0].durationMs);
    expect(entries[1].durationMs).toBeGreaterThanOrEqual(50);
  });

  it('should provide accurate summary statistics including errors', () => {
    const logger = new MigrationLogger(tempDir);

    logger.info('init', 'start', 'Starting migration');
    logger.info('backup', 'start', 'Backing up');
    logger.warn('backup', 'size', 'Large file detected');
    logger.error('import', 'parse', 'JSON parse failed');
    logger.error('import', 'abort', 'Migration aborted');

    const summary = logger.getSummary();
    expect(summary.totalEntries).toBe(5);
    expect(summary.errors).toBe(2);
    expect(summary.warnings).toBe(1);
    expect(summary.info).toBe(2);
    expect(summary.phases).toEqual(
      expect.arrayContaining(['init', 'backup', 'import']),
    );
  });
});

describe('migration failure integration: concurrent lock prevention', () => {
  let tempDir: string;
  let lockFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mig-lock-'));
    lockFile = join(tempDir, 'migration.lock');
    // The lock target must exist
    await writeFile(lockFile, '');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should prevent concurrent migration via file lock', async () => {
    // Acquire lock simulating first migration
    const release = await acquireLock(lockFile, { retries: 0 });

    try {
      // Verify file is locked
      const locked = await isLocked(lockFile);
      expect(locked).toBe(true);

      // Attempt second lock should fail
      await expect(
        acquireLock(lockFile, { retries: 0 }),
      ).rejects.toThrow(/Failed to acquire lock/);
    } finally {
      await release();
    }
  });

  it('should release lock after migration completes normally', async () => {
    await withLock(lockFile, async () => {
      const locked = await isLocked(lockFile);
      expect(locked).toBe(true);
    });

    // Lock should be released
    const lockedAfter = await isLocked(lockFile);
    expect(lockedAfter).toBe(false);
  });

  it('should release lock after migration fails with error', async () => {
    await expect(
      withLock(lockFile, async () => {
        throw new Error('Migration failed');
      }),
    ).rejects.toThrow('Migration failed');

    // Lock should still be released despite the error
    const lockedAfter = await isLocked(lockFile);
    expect(lockedAfter).toBe(false);
  });

  it('should allow new migration after previous lock is released', async () => {
    // First migration
    await withLock(lockFile, async () => {
      // simulate work
    });

    // Second migration should succeed
    let secondRan = false;
    await withLock(lockFile, async () => {
      secondRan = true;
    });

    expect(secondRan).toBe(true);
  });
});

describe('migration failure integration: end-to-end failure workflow', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mig-e2e-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await clearMigrationState(cleoDir);
    } catch {
      // ignore
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should orchestrate validate -> fail -> log -> state update correctly', async () => {
    // Step 1: Write a corrupted source file
    await writeFile(join(cleoDir, 'todo.json'), '{ broken json }');
    await writeFile(
      join(cleoDir, 'sessions.json'),
      JSON.stringify({ sessions: [] }),
    );

    // Step 2: Create migration state and logger
    const logger = new MigrationLogger(cleoDir);
    await createMigrationState(cleoDir);

    // Step 3: Advance to validate phase
    await updateMigrationPhase(cleoDir, 'validate');
    logger.phaseStart('validate');

    // Step 4: Run validation
    const validation = validateSourceFiles(cleoDir);

    // Step 5: Validation fails -> log it and update state
    if (!validation.valid) {
      const errorMsg = validation.todoJson.error ?? 'Unknown validation error';
      logger.logValidation('validate', 'todo.json', false, {}, [errorMsg]);
      logger.phaseFailed('validate', errorMsg);
      await failMigration(cleoDir, `Pre-migration validation failed: ${errorMsg}`);
    }

    // Step 6: Verify the entire failure is recorded properly
    const state = await loadMigrationState(cleoDir);
    expect(state!.phase).toBe('failed');
    expect(state!.errors.length).toBeGreaterThan(0);
    expect(state!.errors[0]).toContain('Pre-migration validation failed');

    const logEntries = logger.getEntries();
    const errorEntries = logEntries.filter((e) => e.level === 'error');
    expect(errorEntries.length).toBeGreaterThanOrEqual(1);

    // Verify migration cannot be resumed
    const resumeInfo = await canResumeMigration(cleoDir);
    expect(resumeInfo!.canResume).toBe(false);
  });

  it('should handle interrupted import with recovery workflow', async () => {
    // Write valid source files
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [
          { id: 'T001', title: 'Task 1', status: 'pending' },
          { id: 'T002', title: 'Task 2', status: 'done' },
          { id: 'T003', title: 'Task 3', status: 'active' },
        ],
      }),
    );

    const logger = new MigrationLogger(cleoDir);

    // Phase 1: Init and validate succeed
    await createMigrationState(cleoDir);
    await updateMigrationPhase(cleoDir, 'validate');
    logger.phaseStart('validate');

    const validation = validateSourceFiles(cleoDir);
    expect(validation.valid).toBe(true);
    logger.phaseComplete('validate');

    // Phase 2: Import begins, partially completes, then "crashes"
    await updateMigrationPhase(cleoDir, 'import');
    logger.phaseStart('import');
    await updateMigrationProgress(cleoDir, { tasksImported: 1, totalTasks: 3 });
    logger.logImportProgress('import', 'tasks', 1, 3);

    // Simulate crash: logger and in-memory state are lost
    // Only disk state survives

    // Phase 3: Recovery - reload state and resume
    const recovered = await loadMigrationState(cleoDir);
    expect(recovered).not.toBeNull();
    expect(recovered!.phase).toBe('import');
    expect(recovered!.progress.tasksImported).toBe(1);

    // Resume import from where we left off
    const recoveryLogger = new MigrationLogger(cleoDir);
    recoveryLogger.info('import', 'resume', 'Resuming import', {
      fromTask: recovered!.progress.tasksImported,
    });

    await updateMigrationProgress(cleoDir, { tasksImported: 2 });
    await updateMigrationProgress(cleoDir, { tasksImported: 3 });
    recoveryLogger.logImportProgress('import', 'tasks', 3, 3);

    // Complete remaining phases
    await updateMigrationPhase(cleoDir, 'verify');
    recoveryLogger.phaseComplete('import');
    recoveryLogger.phaseStart('verify');
    recoveryLogger.phaseComplete('verify');

    await updateMigrationPhase(cleoDir, 'cleanup');
    recoveryLogger.phaseStart('cleanup');
    recoveryLogger.phaseComplete('cleanup');

    await completeMigration(cleoDir);

    // Verify: migration succeeded despite interruption
    const finalState = await loadMigrationState(cleoDir);
    expect(finalState!.phase).toBe('complete');
    expect(finalState!.progress.tasksImported).toBe(3);
    expect(finalState!.completedAt).toBeDefined();

    const recoverySummary = recoveryLogger.getSummary();
    expect(recoverySummary.errors).toBe(0);
  });
});
