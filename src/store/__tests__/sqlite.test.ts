/**
 * Tests for SQLite store initialization and lifecycle.
 *
 * Verifies database creation, table setup, WAL/journal mode,
 * schema version tracking, and cleanup.
 *
 * @task T4645
 * @epic T4638
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to set CLEO_DIR before importing sqlite module,
// since getDb calls getCleoDirAbsolute which uses CLEO_DIR or cwd.
let tempDir: string;
let cleoDir: string;

/**
 * Reset singleton state between tests by re-importing.
 * The sqlite module uses module-level singletons (_db, _nativeDb, _dbPath).
 * We call closeDb() to reset them between tests.
 */

describe('SQLite store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-sqlite-'));
    cleoDir = join(tempDir, '.cleo');
    // Set env so getCleoDirAbsolute resolves to our temp dir
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    // Close DB to reset singleton state
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates database file and .cleo directory on first getDb call', async () => {
    const { getDb, getDbPath, closeDb: close } = await import('../sqlite.js');
    close(); // Reset any prior singleton
    expect(existsSync(cleoDir)).toBe(false);

    const db = await getDb();
    expect(db).toBeDefined();
    expect(existsSync(getDbPath())).toBe(true);
  });

  it('creates all required tables', async () => {
    const { getDb, closeDb: close } = await import('../sqlite.js');
    close();
    const db = await getDb();

    // Query sqlite_master for table names
    const tables = db.all<{ name: string }>(
      // Using raw sql template from drizzle
      await import('drizzle-orm').then(m =>
        m.sql`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
      )
    );

    const tableNames = tables.map(t => t.name).sort();

    expect(tableNames).toContain('tasks');
    expect(tableNames).toContain('task_dependencies');
    expect(tableNames).toContain('task_relations');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('task_work_history');
    expect(tableNames).toContain('schema_meta');
  });

  it('creates expected indexes', async () => {
    const { getDb, closeDb: close } = await import('../sqlite.js');
    close();
    const db = await getDb();
    const { sql } = await import('drizzle-orm');

    const indexes = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    );

    const indexNames = indexes.map(i => i.name).sort();

    expect(indexNames).toContain('idx_tasks_status');
    expect(indexNames).toContain('idx_tasks_parent_id');
    expect(indexNames).toContain('idx_tasks_phase');
    expect(indexNames).toContain('idx_tasks_type');
    expect(indexNames).toContain('idx_tasks_priority');
    expect(indexNames).toContain('idx_deps_depends_on');
    expect(indexNames).toContain('idx_sessions_status');
    expect(indexNames).toContain('idx_work_history_session');
  });

  it('sets schema version to 1.0.0', async () => {
    const { getSchemaVersion, closeDb: close } = await import('../sqlite.js');
    close();
    const version = await getSchemaVersion();
    expect(version).toBe('1.0.0');
  });

  it('closeDb saves and releases resources', async () => {
    const { getDb, closeDb: close, getDbPath } = await import('../sqlite.js');
    close();
    await getDb();
    const dbPath = getDbPath();
    expect(existsSync(dbPath)).toBe(true);

    // Close should save
    close();

    // File should still exist after close
    expect(existsSync(dbPath)).toBe(true);
  });

  it('getDb returns same singleton on repeated calls', async () => {
    const { getDb, closeDb: close } = await import('../sqlite.js');
    close();
    const db1 = await getDb();
    const db2 = await getDb();
    expect(db1).toBe(db2);
  });

  it('dbExists returns false when no database file', async () => {
    const { dbExists, closeDb: close } = await import('../sqlite.js');
    close();
    expect(dbExists()).toBe(false);
  });

  it('dbExists returns true after getDb', async () => {
    const { getDb, dbExists, closeDb: close } = await import('../sqlite.js');
    close();
    await getDb();
    expect(dbExists()).toBe(true);
  });

  it('uses journal mode (not WAL) since sql.js is in-memory WASM', async () => {
    // sql.js operates in-memory with explicit save; journal_mode should
    // be 'memory' or 'delete' (not 'wal'), per sqlite.ts documentation.
    const { getDb, closeDb: close } = await import('../sqlite.js');
    close();
    const db = await getDb();
    const { sql } = await import('drizzle-orm');

    const result = db.all<{ journal_mode: string }>(
      sql`PRAGMA journal_mode`
    );

    // sql.js typically uses 'memory' journal mode
    expect(result[0]?.journal_mode).not.toBe('wal');
  });

  it('reopens database from persisted file after close', async () => {
    const { getDb, closeDb: close, getDbPath } = await import('../sqlite.js');
    close();

    // Create database and insert data
    const db1 = await getDb();
    const { sql } = await import('drizzle-orm');
    db1.run(sql`INSERT INTO tasks (id, title, status, priority, created_at)
      VALUES ('T001', 'Test task', 'pending', 'medium', datetime('now'))`);

    // Save and close
    const { saveToFile } = await import('../sqlite.js');
    saveToFile();
    close();

    // Reopen - should have persisted data
    const db2 = await getDb();
    const rows = db2.all<{ id: string }>(
      sql`SELECT id FROM tasks WHERE id = 'T001'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('T001');
  });

  describe('singleton reset behavior', () => {
    it('resetDbState clears all singleton references', async () => {
      const { getDb, resetDbState, closeDb: close } = await import('../sqlite.js');
      close();
      
      // Initialize singleton
      const db1 = await getDb();
      expect(db1).toBeDefined();
      
      // Reset should clear singleton
      resetDbState();
      
      // Next getDb should create new instance
      const db2 = await getDb();
      expect(db2).toBeDefined();
      expect(db2).not.toBe(db1);
    });

    it('resetDbState is safe to call multiple times', async () => {
      const { resetDbState, closeDb: close } = await import('../sqlite.js');
      close();
      
      // Should not throw when called multiple times
      expect(() => resetDbState()).not.toThrow();
      expect(() => resetDbState()).not.toThrow();
      expect(() => resetDbState()).not.toThrow();
    });

    it('resetDbState does not save data (unlike closeDb)', async () => {
      const { getDb, resetDbState, closeDb: close } = await import('../sqlite.js');
      const { getDbPath } = await import('../sqlite.js');
      close();
      
      // Initialize and insert data
      const db = await getDb();
      const { sql } = await import('drizzle-orm');
      db.run(sql`INSERT INTO tasks (id, title, status, priority, created_at)
        VALUES ('T002', 'Test task', 'pending', 'medium', datetime('now'))`);
      
      // Reset without saving
      resetDbState();
      
      // Reopen database - data should not exist since we didn't save
      const db2 = await getDb();
      const rows = db2.all<{ id: string }>(
        sql`SELECT id FROM tasks WHERE id = 'T002'`
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('path validation', () => {
    it('getDb resets singleton when cwd parameter differs', async () => {
      const { getDb, closeDb: close } = await import('../sqlite.js');
      close();
      
      // Temporarily unset CLEO_DIR so cwd parameter is respected
      const originalCleoDir = process.env['CLEO_DIR'];
      delete process.env['CLEO_DIR'];
      
      // Create two different directories
      const tempDir1 = await mkdtemp(join(tmpdir(), 'cleo-test-1-'));
      const tempDir2 = await mkdtemp(join(tmpdir(), 'cleo-test-2-'));
      
      try {
        // Get db for first directory
        const db1 = await getDb(tempDir1);
        
        // Get db for second directory - should create new instance
        const db2 = await getDb(tempDir2);
        
        // Should be different instances
        expect(db2).not.toBe(db1);
        
        // Going back to first directory should create another new instance
        const db3 = await getDb(tempDir1);
        expect(db3).not.toBe(db2);
      } finally {
        await rm(tempDir1, { recursive: true, force: true });
        await rm(tempDir2, { recursive: true, force: true });
        // Restore CLEO_DIR
        if (originalCleoDir) {
          process.env['CLEO_DIR'] = originalCleoDir;
        }
      }
    });

    it('getDb uses same singleton when cwd parameter matches', async () => {
      const { getDb, closeDb: close } = await import('../sqlite.js');
      close();
      
      // Temporarily unset CLEO_DIR so cwd parameter is respected
      const originalCleoDir = process.env['CLEO_DIR'];
      delete process.env['CLEO_DIR'];
      
      const tempDir1 = await mkdtemp(join(tmpdir(), 'cleo-test-3-'));
      
      try {
        // Get db for directory twice
        const db1 = await getDb(tempDir1);
        const db2 = await getDb(tempDir1);
        
        // Should be same instance
        expect(db1).toBe(db2);
      } finally {
        await rm(tempDir1, { recursive: true, force: true });
        // Restore CLEO_DIR
        if (originalCleoDir) {
          process.env['CLEO_DIR'] = originalCleoDir;
        }
      }
    });

    it('getDb with no cwd uses CLEO_DIR env for path comparison', async () => {
      const { getDb, closeDb: close } = await import('../sqlite.js');
      close();
      
      // First call with no cwd should use CLEO_DIR
      const db1 = await getDb();
      
      // Second call with no cwd should use same CLEO_DIR
      const db2 = await getDb();
      
      // Should be same instance
      expect(db1).toBe(db2);
    });
  });
});
