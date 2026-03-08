/**
 * Tests for core upgrade module.
 * @task T4699
 * @task T4723
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../store/lock.js';
import { checkStorageMigration } from '../system/storage-preflight.js';
import { runUpgrade } from '../upgrade.js';

describe('checkStorageMigration', () => {
  let tmpDir: string;
  let cleoDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `cleo-upgrade-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    cleoDir = join(tmpDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('detects JSON data with no config (v1→v2 upgrade)', () => {
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.summary).toContain('SQLite is the only supported storage engine');
    expect(result.fix).toContain('upgrade');
  });

  it('flags migration for legacy explicit JSON engine config (ADR-006)', () => {
    // Per ADR-006, JSON is no longer a valid engine. Even if config says json,
    // migration is needed because the DB doesn't exist.
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ storage: { engine: 'json' } }));

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.currentEngine).toBe('none');
  });

  it('flags broken state: config says sqlite but no DB', () => {
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ storage: { engine: 'sqlite' } }));

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.summary).toContain('no SQLite database');
  });

  it('flags when config says sqlite and DB exists but legacy files exist', () => {
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [{ id: 'T1', title: 'Test', status: 'pending', createdAt: '2026-01-01' }],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ storage: { engine: 'sqlite' } }));
    // Create a tiny DB file (simulating post-migration)
    writeFileSync(join(cleoDir, 'tasks.db'), Buffer.alloc(4096));

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.currentEngine).toBe('sqlite');
  });

  it('reports no data for empty project', () => {
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(false);
    expect(result.summary).toContain('No data found');
  });

  it('ignores legacy tasks.json for stale-file migration checks', () => {
    writeFileSync(join(cleoDir, 'tasks.json'), JSON.stringify({ tasks: [] }));
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ storage: { engine: 'sqlite' } }));
    writeFileSync(join(cleoDir, 'tasks.db'), Buffer.alloc(4096));

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(false);
    expect(result.summary).toContain('SQLite storage active');
  });

  it('counts archive tasks in total', () => {
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    writeFileSync(
      join(cleoDir, 'todo-archive.json'),
      JSON.stringify({
        tasks: [
          { id: 'T1', title: 'Done', status: 'done' },
          { id: 'T2', title: 'Done2', status: 'done' },
        ],
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = checkStorageMigration(tmpDir);
    expect(result.migrationNeeded).toBe(true);
    expect(result.details.archiveJsonTaskCount).toBe(2);
    expect(result.summary).toContain('2 task(s)');
  });
});

describe('runUpgrade locking (T4723)', () => {
  let tmpDir: string;
  let cleoDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `cleo-upgrade-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    cleoDir = join(tmpDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    // Close ALL SQLite connections before cleanup — Windows locks open files
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 200));
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('should succeed when no concurrent migration', async () => {
    // Setup: Create valid JSON files that need migration
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [
          {
            id: 'T1',
            title: 'Test Task',
            status: 'pending',
            createdAt: '2026-01-01',
            size: 'medium',
          },
        ],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), '{}');
    writeFileSync(join(cleoDir, '.gitignore'), 'tasks.db\ntodo.json\n');

    // Run upgrade with dryRun first to ensure it doesn't crash
    const result = await runUpgrade({ cwd: tmpDir, dryRun: true });

    // Should succeed and detect migration needed
    expect(result.success).toBe(true);
    expect(
      result.actions.some((a) => a.action === 'storage_migration' && a.status === 'preview'),
    ).toBe(true);
  });

  it('should block concurrent migration when lock is held', async () => {
    // Setup: Create valid JSON files that indicate migration needed
    // When config has no engine specified and no tasks.db exists,
    // preflight returns migrationNeeded: true
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [
          {
            id: 'T1',
            title: 'Test Task',
            status: 'pending',
            createdAt: '2026-01-01',
            size: 'medium',
          },
        ],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    // Config with no engine specified - should trigger migration
    writeFileSync(join(cleoDir, 'config.json'), '{}');
    writeFileSync(join(cleoDir, '.gitignore'), 'tasks.db\ntodo.json\n');

    // First check preflight to ensure migration is needed
    const preflight = checkStorageMigration(tmpDir);
    expect(preflight.migrationNeeded).toBe(true);

    // Acquire lock on tasks.db path (file doesn't need to exist for locking)
    // This simulates another migration process holding the lock
    const dbPath = join(cleoDir, 'tasks.db');
    const release = await acquireLock(dbPath, { stale: 5000, retries: 0 });

    try {
      // Attempt to run upgrade while lock is held
      const result = await runUpgrade({ cwd: tmpDir, dryRun: false, autoMigrate: true });

      // Should fail with lock error
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => e.includes('Cannot acquire migration lock'))).toBe(true);
      expect(
        result.actions.some((a) => a.action === 'storage_migration' && a.status === 'error'),
      ).toBe(true);
    } finally {
      // Release lock
      await release();
    }
  });

  it('should provide clear error message on lock failure', async () => {
    // Setup: Create valid JSON files that indicate migration needed
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [
          {
            id: 'T1',
            title: 'Test Task',
            status: 'pending',
            createdAt: '2026-01-01',
            size: 'medium',
          },
        ],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    // Config with no engine specified - should trigger migration
    writeFileSync(join(cleoDir, 'config.json'), '{}');
    writeFileSync(join(cleoDir, '.gitignore'), 'tasks.db\ntodo.json\n');

    // Verify migration is needed
    const preflight = checkStorageMigration(tmpDir);
    expect(preflight.migrationNeeded).toBe(true);

    // Acquire lock on tasks.db path (simulating another migration process)
    const dbPath = join(cleoDir, 'tasks.db');
    const release = await acquireLock(dbPath, { stale: 5000, retries: 0 });

    try {
      const result = await runUpgrade({ cwd: tmpDir, autoMigrate: true });

      // Verify error message content
      const migrationAction = result.actions.find((a) => a.action === 'storage_migration');
      expect(migrationAction).toBeDefined();
      expect(migrationAction?.status).toBe('error');
      expect(migrationAction?.details).toContain('Cannot acquire migration lock');
      expect(migrationAction?.details).toContain('Another migration is currently in progress');
      expect(migrationAction?.fix).toContain('Wait for the other migration to complete');
    } finally {
      await release();
    }
  });

  it('should release lock after migration completes', async () => {
    // Setup: Create valid JSON files
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        tasks: [
          {
            id: 'T1',
            title: 'Test Task',
            status: 'pending',
            createdAt: '2026-01-01',
            size: 'medium',
          },
        ],
        _meta: { schemaVersion: '2.10.0' },
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), '{}');
    writeFileSync(join(cleoDir, '.gitignore'), 'tasks.db\ntodo.json\n');

    // First upgrade (dry run - no actual migration)
    const result1 = await runUpgrade({ cwd: tmpDir, dryRun: true });
    expect(result1.success).toBe(true);

    // Second upgrade should also succeed (lock released)
    const result2 = await runUpgrade({ cwd: tmpDir, dryRun: true });
    expect(result2.success).toBe(true);
  });
});

describe('runUpgrade structural parity', () => {
  let tmpDir: string;
  let cleoDir: string;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `cleo-upgrade-structure-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    cleoDir = join(tmpDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    // Close ALL SQLite connections before cleanup — Windows locks open files
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      await new Promise((r) => setTimeout(r, 200));
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('creates missing config.json during upgrade', async () => {
    // Simulate partially initialized project: structure exists but config missing.
    const result = await runUpgrade({ cwd: tmpDir, dryRun: false });

    expect(existsSync(join(cleoDir, 'config.json'))).toBe(true);
    expect(result.actions.some((a) => a.action === 'config_file' && a.status === 'applied')).toBe(
      true,
    );
  });

  it('does not treat tasks.json as stale cleanup target', async () => {
    writeFileSync(join(cleoDir, 'tasks.db'), Buffer.alloc(4096));
    writeFileSync(join(cleoDir, 'tasks.json'), JSON.stringify({ tasks: [] }));

    const result = await runUpgrade({ cwd: tmpDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.actions.some((a) => a.action === 'stale_json_cleanup')).toBe(false);
    expect(existsSync(join(cleoDir, 'tasks.json'))).toBe(true);
  });

  it('detects migration from archive data without todo.json', async () => {
    writeFileSync(
      join(cleoDir, 'todo-archive.json'),
      JSON.stringify({
        tasks: [{ id: 'T2', title: 'Archived Task', status: 'done' }],
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = await runUpgrade({ cwd: tmpDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(
      result.actions.some((a) => a.action === 'storage_migration' && a.status === 'preview'),
    ).toBe(true);
  });

  it('detects migration from sessions data without todo.json', async () => {
    writeFileSync(
      join(cleoDir, 'sessions.json'),
      JSON.stringify({
        sessions: [{ id: 'S1', startedAt: '2026-01-01T00:00:00.000Z' }],
      }),
    );
    writeFileSync(join(cleoDir, 'config.json'), '{}');

    const result = await runUpgrade({ cwd: tmpDir, dryRun: true });

    expect(result.success).toBe(true);
    expect(
      result.actions.some((a) => a.action === 'storage_migration' && a.status === 'preview'),
    ).toBe(true);
  });
});
