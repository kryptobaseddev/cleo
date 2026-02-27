/**
 * SafetyDataAccessor Integration Tests
 *
 * Tests the factory-level safety wrapper that wraps all DataAccessor
 * implementations with mandatory safety checks.
 *
 * Key tests:
 * - Factory always wraps with safety
 * - CLEO_DISABLE_SAFETY bypasses wrapping
 * - Read operations pass through without overhead
 * - Write operations trigger full safety pipeline
 * - Safety status reporting
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

// Mock git-checkpoint
vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

describe('SafetyDataAccessor', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-safety-accessor-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    delete process.env['CLEO_DISABLE_SAFETY'];

    vi.clearAllMocks();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_DISABLE_SAFETY'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ---- Fixtures ----

  const makeTaskFile = (): TaskFile => ({
    version: '2.10.0',
    project: { name: 'test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: { schemaVersion: '2.10.0', checksum: '0', configVersion: '1.0.0' },
    tasks: [],
  });

  function createMockAccessor(): DataAccessor {
    const data = {
      taskFile: makeTaskFile(),
      sessions: {
        sessions: [],
        version: '1.0.0',
        _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
      } as SessionsFile,
      archive: null as ArchiveFile | null,
    };

    return {
      engine: 'sqlite' as const,
      async loadTaskFile() { return data.taskFile; },
      async saveTaskFile(d: TaskFile) { data.taskFile = d; },
      async loadTodoFile() { return data.taskFile; },
      async saveTodoFile(d: TaskFile) { data.taskFile = d; },
      async loadArchive() { return data.archive; },
      async saveArchive(d: ArchiveFile) { data.archive = d; },
      async loadSessions() { return data.sessions; },
      async saveSessions(d: SessionsFile) { data.sessions = d; },
      async appendLog() {},
      async close() {},
    };
  }

  // ---- Factory Wrapping ----

  describe('Factory Integration', () => {
    it('should wrap accessor with safety by default', async () => {
      const { wrapWithSafety, isSafetyEnabled } = await import('../safety-data-accessor.js');
      const inner = createMockAccessor();

      const wrapped = wrapWithSafety(inner, tempDir);

      expect(isSafetyEnabled()).toBe(true);
      // Wrapped accessor should have same engine property
      expect(wrapped.engine).toBe('sqlite');
    });

    it('should bypass safety when CLEO_DISABLE_SAFETY=true', async () => {
      process.env['CLEO_DISABLE_SAFETY'] = 'true';

      const { wrapWithSafety, isSafetyEnabled } = await import('../safety-data-accessor.js');
      const inner = createMockAccessor();

      const wrapped = wrapWithSafety(inner, tempDir);

      expect(isSafetyEnabled()).toBe(false);
      // Should return the inner accessor unwrapped
      expect(wrapped).toBe(inner);
    });
  });

  // ---- Safety Status ----

  describe('Safety Status', () => {
    it('should report enabled when no env var set', async () => {
      const { getSafetyStatus } = await import('../safety-data-accessor.js');

      const status = getSafetyStatus();
      expect(status.enabled).toBe(true);
      expect(status.reason).toBeUndefined();
    });

    it('should report disabled with reason when env var set', async () => {
      process.env['CLEO_DISABLE_SAFETY'] = 'true';
      const { getSafetyStatus } = await import('../safety-data-accessor.js');

      const status = getSafetyStatus();
      expect(status.enabled).toBe(false);
      expect(status.reason).toContain('CLEO_DISABLE_SAFETY');
    });
  });

  // ---- Read Pass-Through ----

  describe('Read Operations', () => {
    it('should pass through loadTaskFile without modification', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const inner = createMockAccessor();
      const wrapped = new SafetyDataAccessor(inner, tempDir);

      const result = await wrapped.loadTaskFile();
      expect(result).toBeDefined();
      expect(result.version).toBe('2.10.0');
    });

    it('should pass through loadSessions without modification', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const inner = createMockAccessor();
      const wrapped = new SafetyDataAccessor(inner, tempDir);

      const result = await wrapped.loadSessions();
      expect(result.sessions).toEqual([]);
    });

    it('should pass through loadArchive without modification', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const inner = createMockAccessor();
      const wrapped = new SafetyDataAccessor(inner, tempDir);

      const result = await wrapped.loadArchive();
      expect(result).toBeNull();
    });
  });

  // ---- Write Operations with Safety ----

  describe('Write Operations', () => {
    it('should trigger safety pipeline on saveTaskFile', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const { getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();

      // Create sequence file so sequence validation doesn't fail
      await writeFile(join(cleoDir, '.sequence.json'), JSON.stringify({ counter: 100 }));

      const inner = createMockAccessor();
      const wrapped = new SafetyDataAccessor(inner, tempDir, { enabled: true });

      const taskFile = makeTaskFile();
      await wrapped.saveTaskFile(taskFile);

      // Stats should reflect the write
      const stats = getSafetyStats();
      expect(stats.writes).toBeGreaterThan(0);
    });

    it('should trigger safety pipeline on saveSessions', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const { getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();

      const inner = createMockAccessor();
      const wrapped = new SafetyDataAccessor(inner, tempDir, { enabled: true });

      await wrapped.saveSessions({
        sessions: [],
        version: '1.0.0',
        _meta: { schemaVersion: '1.0.0', lastUpdated: new Date().toISOString() },
      });

      expect(getSafetyStats().writes).toBeGreaterThan(0);
    });

    it('should trigger safety pipeline on saveArchive', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const { getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();

      const inner = createMockAccessor();
      // Need archive to be loadable for verification
      const archiveData = { archivedTasks: [] };
      inner.loadArchive = async () => archiveData;
      const wrapped = new SafetyDataAccessor(inner, tempDir, { enabled: true });

      await wrapped.saveArchive(archiveData);

      expect(getSafetyStats().writes).toBeGreaterThan(0);
    });

    it('should delegate close to inner accessor', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const inner = createMockAccessor();
      const closeSpy = vi.spyOn(inner, 'close');
      const wrapped = new SafetyDataAccessor(inner, tempDir);

      await wrapped.close();

      expect(closeSpy).toHaveBeenCalledOnce();
    });
  });

  // ---- Deprecated Aliases ----
  // Note: SafetyDataAccessor no longer exposes loadTodoFile/saveTodoFile aliases.
  // These tests now verify the canonical loadTaskFile/saveTaskFile methods work.

  describe('Deprecated Aliases', () => {
    it('should route loadTodoFile to loadTaskFile', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const inner = createMockAccessor();
      const wrapped = new SafetyDataAccessor(inner, tempDir);

      const result = await wrapped.loadTaskFile();
      expect(result).toBeDefined();
      expect(result.version).toBe('2.10.0');
    });

    it('should route saveTodoFile to saveTaskFile', async () => {
      const { SafetyDataAccessor } = await import('../safety-data-accessor.js');
      const { getSafetyStats, resetSafetyStats } = await import('../data-safety-central.js');
      resetSafetyStats();

      // Create sequence file so sequence validation doesn't fail
      await writeFile(join(cleoDir, '.sequence.json'), JSON.stringify({ counter: 100 }));

      const inner = createMockAccessor();
      const wrapped = new SafetyDataAccessor(inner, tempDir, { enabled: true });

      await wrapped.saveTaskFile(makeTaskFile());

      expect(getSafetyStats().writes).toBeGreaterThan(0);
    });
  });
});
