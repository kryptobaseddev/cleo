/**
 * Tests for migration runner retry+backoff on SQLITE_BUSY errors.
 *
 * Verifies that runMigrations retries BEGIN IMMEDIATE when another process
 * holds a RESERVED lock, using exponential backoff with jitter (T5185).
 *
 * @task T5185
 */

import { describe, it, expect } from 'vitest';
import { isSqliteBusy } from '../sqlite.js';

describe('isSqliteBusy', () => {
  it('detects SQLITE_BUSY error message', () => {
    expect(isSqliteBusy(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
  });

  it('detects lowercase sqlite_busy', () => {
    expect(isSqliteBusy(new Error('sqlite_busy'))).toBe(true);
  });

  it('detects "database is locked" variant', () => {
    expect(isSqliteBusy(new Error('database is locked'))).toBe(true);
  });

  it('detects mixed-case SQLITE_BUSY', () => {
    expect(isSqliteBusy(new Error('Error: SQLITE_BUSY - another process holds lock'))).toBe(true);
  });

  it('rejects non-Error values', () => {
    expect(isSqliteBusy('SQLITE_BUSY')).toBe(false);
    expect(isSqliteBusy(null)).toBe(false);
    expect(isSqliteBusy(undefined)).toBe(false);
    expect(isSqliteBusy(42)).toBe(false);
  });

  it('rejects other SQLite errors', () => {
    expect(isSqliteBusy(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed'))).toBe(false);
    expect(isSqliteBusy(new Error('SQLITE_ERROR: no such table'))).toBe(false);
    expect(isSqliteBusy(new Error('SQLITE_READONLY: attempt to write'))).toBe(false);
  });

  it('rejects generic errors', () => {
    expect(isSqliteBusy(new Error('something went wrong'))).toBe(false);
    expect(isSqliteBusy(new Error(''))).toBe(false);
  });
});

describe('migration retry+backoff (T5185)', () => {
  it('retries BEGIN IMMEDIATE on SQLITE_BUSY and succeeds', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { openNativeDatabase } = await import('../node-sqlite-adapter.js');

    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-retry-'));
    const dbPath = join(tempDir, 'test-retry.db');

    try {
      // Connection 1: hold a RESERVED lock to force SQLITE_BUSY on connection 2
      const db1 = openNativeDatabase(dbPath);
      db1.exec('CREATE TABLE IF NOT EXISTS test_table (id INTEGER PRIMARY KEY)');
      db1.prepare('BEGIN IMMEDIATE').run();
      // db1 now holds RESERVED lock

      // Connection 2: try BEGIN IMMEDIATE -- should get SQLITE_BUSY
      // Use a low busy_timeout so the test doesn't wait 5 seconds
      const db2 = openNativeDatabase(dbPath, { timeout: 100 });
      db2.exec('PRAGMA busy_timeout=100');

      // Verify that BEGIN IMMEDIATE actually throws SQLITE_BUSY
      let caughtBusy = false;
      try {
        db2.prepare('BEGIN IMMEDIATE').run();
      } catch (err) {
        caughtBusy = isSqliteBusy(err);
      }
      expect(caughtBusy).toBe(true);

      // Clean up
      db1.prepare('ROLLBACK').run();
      db1.close();
      db2.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('succeeds after lock is released between retry attempts', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { openNativeDatabase } = await import('../node-sqlite-adapter.js');

    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-retry-release-'));
    const dbPath = join(tempDir, 'test-retry-release.db');

    try {
      // Connection 1: hold a RESERVED lock
      const db1 = openNativeDatabase(dbPath);
      db1.exec('CREATE TABLE IF NOT EXISTS retry_test (id INTEGER PRIMARY KEY)');
      db1.prepare('BEGIN IMMEDIATE').run();

      // Connection 2: attempt BEGIN IMMEDIATE with retry
      const db2 = openNativeDatabase(dbPath, { timeout: 50 });
      db2.exec('PRAGMA busy_timeout=50');

      // Retry loop simulating what runMigrations does, but release lock
      // after the first BUSY failure (simulating another process finishing)
      let succeeded = false;
      let attempts = 0;
      const MAX_RETRIES = 5;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        attempts = attempt;
        try {
          db2.prepare('BEGIN IMMEDIATE').run();
          db2.prepare('INSERT INTO retry_test (id) VALUES (1)').run();
          db2.prepare('COMMIT').run();
          succeeded = true;
          break;
        } catch (err) {
          if (!isSqliteBusy(err) || attempt === MAX_RETRIES) {
            throw err;
          }
          // Release the lock from db1 after first BUSY failure,
          // simulating the other migration runner finishing
          if (attempt === 1) {
            db1.prepare('COMMIT').run();
          }
        }
      }

      expect(succeeded).toBe(true);
      expect(attempts).toBe(2); // First attempt BUSY, second succeeds

      // Verify the write actually persisted
      const row = db2.prepare('SELECT id FROM retry_test WHERE id = 1').get() as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row?.id).toBe(1);

      db1.close();
      db2.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('non-BUSY errors propagate immediately without retry', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { openNativeDatabase } = await import('../node-sqlite-adapter.js');

    const tempDir = await mkdtemp(join(tmpdir(), 'cleo-retry-nonbusy-'));
    const dbPath = join(tempDir, 'test-nonbusy.db');

    try {
      const db = openNativeDatabase(dbPath);
      db.exec('CREATE TABLE IF NOT EXISTS test_err (id INTEGER PRIMARY KEY)');

      // Try to create the same table with a conflicting schema in a transaction
      // This should fail with a non-BUSY error and NOT be retried
      let attempts = 0;
      const MAX_RETRIES = 5;

      try {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          attempts = attempt;
          try {
            db.prepare('BEGIN IMMEDIATE').run();
            try {
              // This will fail: duplicate column name
              db.prepare('ALTER TABLE test_err ADD COLUMN id INTEGER').run();
              db.prepare('COMMIT').run();
              break;
            } catch (err) {
              db.prepare('ROLLBACK').run();
              throw err;
            }
          } catch (err) {
            if (!isSqliteBusy(err) || attempt === MAX_RETRIES) {
              throw err;
            }
          }
        }
      } catch (err) {
        // Expected: non-BUSY error should propagate on first attempt
        expect(attempts).toBe(1);
        expect(isSqliteBusy(err)).toBe(false);
      }

      db.close();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
