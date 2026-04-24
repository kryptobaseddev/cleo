/**
 * Tests for the leaf-module DatabaseSync fix in sqlite-native.ts (T1325/T1331 v2).
 *
 * Architecture:
 *   sqlite-native.ts — leaf module, zero CLEO imports, owns the _ctor cache.
 *   sqlite.ts        — imports getDbSyncConstructor from sqlite-native.js.
 *
 * The v1 fix put `let _DatabaseSyncCtor = null` in sqlite.ts itself. When
 * Vitest eagerly traces the dynamic `import('../memory/dispatch-trace.js')` in
 * agent-resolver.ts, that trace re-enters sqlite.ts before its module scope
 * finishes executing. The `let` declaration is hoisted (TDZ) but the
 * initializer has not run, so any access to `_DatabaseSyncCtor` throws
 * `Cannot access '_DatabaseSyncCtor' before initialization`.
 *
 * The v2 fix moves the cache into sqlite-native.ts which has zero CLEO imports.
 * The cycle cannot re-enter sqlite-native.ts because nothing in the cycle
 * imports it (sqlite.ts → sqlite-native.ts is a terminal edge, not a back-edge).
 *
 * @task T1331
 * @epic T1323
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('sqlite-native.ts leaf module (T1331 v2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('importing sqlite-native.ts alone does NOT require node:sqlite at parse time', async () => {
    let sqliteLoadCount = 0;

    vi.doMock('node:sqlite', () => {
      sqliteLoadCount++;
      return { DatabaseSync: class MockDatabaseSync {} };
    });

    vi.resetModules();

    // Import the leaf module — node:sqlite must NOT be loaded at this point.
    await import('../sqlite-native.js');

    expect(sqliteLoadCount).toBe(0);
  });

  it('getDbSyncConstructor() returns a working constructor on first call', async () => {
    vi.resetModules();
    const { getDbSyncConstructor } = await import('../sqlite-native.js');
    const ctor = getDbSyncConstructor();
    expect(typeof ctor).toBe('function');
    // Verify the constructor name matches the real node:sqlite export
    expect(ctor.name).toBe('DatabaseSync');
  });

  it('getDbSyncConstructor() returns the memoized constructor on subsequent calls', async () => {
    vi.resetModules();
    const { getDbSyncConstructor } = await import('../sqlite-native.js');

    const first = getDbSyncConstructor();
    const second = getDbSyncConstructor();
    // Same reference — memoization working
    expect(first).toBe(second);
  });
});

describe('sqlite.ts lazy-init via sqlite-native.ts leaf (T1331)', () => {
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

  it('importing sqlite.ts does NOT require node:sqlite at module-load time', async () => {
    let sqliteRequiredCount = 0;

    vi.doMock('node:sqlite', () => {
      sqliteRequiredCount++;
      return {
        DatabaseSync: class MockDatabaseSync {},
      };
    });

    vi.resetModules();

    // Import sqlite.ts — the leaf module defers the require() call so
    // sqliteRequiredCount must still be 0 after this line.
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

  it('circular-import reproduction: importing sqlite.ts after agent-resolver chain does not TDZ', async () => {
    // This test reproduces the cycle that caused the TDZ failures:
    //   agent-resolver → dispatch-trace → extraction-gate → graph-auto-populate
    //   → memory-sqlite → sqlite.ts
    //
    // With the v2 leaf module fix, sqlite-native.ts (zero CLEO imports) is
    // the terminal edge; the cycle cannot re-enter it.
    //
    // We simulate the cycle by force-importing memory-sqlite.js (which imports
    // sqlite.js) before touching any database, then verifying sqlite.ts is
    // usable without TDZ errors.
    vi.resetModules();

    // Simulate a re-entrant import of memory-sqlite (part of the cycle)
    // If TDZ were still present this would throw before we even reach the assertion.
    let importError: Error | null = null;
    try {
      await import('../memory-sqlite.js');
      await import('../sqlite.js');
    } catch (err) {
      importError = err instanceof Error ? err : new Error(String(err));
    }

    expect(importError).toBeNull();

    // Now verify openNativeDatabase works
    const dbPath = join(tempDir, 'cycle-test.db');
    const { openNativeDatabase, closeDb } = await import('../sqlite.js');
    let db: ReturnType<typeof openNativeDatabase> | null = null;
    try {
      db = openNativeDatabase(dbPath);
      const result = db.prepare('SELECT 42 AS answer').get() as { answer: number } | undefined;
      expect(result?.answer).toBe(42);
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
