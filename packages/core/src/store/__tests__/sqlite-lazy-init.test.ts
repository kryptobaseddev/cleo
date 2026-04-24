/**
 * Tests for the lazy-init DatabaseSync fix in sqlite.ts (T1325/T1331).
 *
 * Verifies that node:sqlite is NOT required at module-load time of sqlite.ts,
 * and that openNativeDatabase() successfully instantiates a database when called.
 *
 * Root cause: module-scope `const { DatabaseSync } = _require('node:sqlite')` was
 * executed during re-entrant initialization caused by Vitest eagerly tracing a
 * dynamic import in agent-resolver.ts, producing a TDZ ReferenceError. The fix
 * defers the require() call to first use via getDbSyncConstructor().
 *
 * @task T1331
 * @epic T1323
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('sqlite.ts lazy-init DatabaseSync (T1331)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-sqlite-lazy-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Reset module registry so singleton state is cleared between tests
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('does NOT require node:sqlite at module-load time', async () => {
    // Track whether node:sqlite was called at import time.
    // We do this by resetting modules and then observing that the import
    // of sqlite.ts itself does not trigger the node:sqlite factory.
    let sqliteRequiredCount = 0;

    vi.doMock('node:sqlite', () => {
      sqliteRequiredCount++;
      // Return a functional mock so that if it IS called at module-load time,
      // we can detect it (count > 0 before any openNativeDatabase call).
      return {
        DatabaseSync: class MockDatabaseSync {},
      };
    });

    vi.resetModules();

    // Import sqlite.ts — if the module-scope require() is still present,
    // sqliteRequiredCount will be 1 immediately after this line.
    await import('../sqlite.js');

    expect(sqliteRequiredCount).toBe(0);
  });

  it('openNativeDatabase() successfully instantiates when called with a valid path', async () => {
    vi.resetModules();

    const dbPath = join(tempDir, 'test.db');
    const { openNativeDatabase, closeDb } = await import('../sqlite.js');

    let db: ReturnType<typeof openNativeDatabase> | null = null;
    try {
      db = openNativeDatabase(dbPath);
      expect(db).toBeDefined();
      // Verify it is usable — prepare a simple statement
      const stmt = db.prepare('SELECT 1 AS val');
      const result = stmt.get() as { val: number } | undefined;
      expect(result?.val).toBe(1);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      closeDb();
    }
  });
});
