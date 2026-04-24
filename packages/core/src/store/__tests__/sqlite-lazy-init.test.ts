/**
 * Tests for the leaf-module DatabaseSync fix in sqlite-native.ts (T1325/T1331 v3).
 *
 * Architecture (v3):
 *   sqlite-native.ts — leaf module, zero CLEO imports, owns the _ctor cache AND
 *                      openNativeDatabase().
 *   sqlite.ts        — ZERO value-binding imports from sqlite-native.ts. Only a
 *                      re-export declaration and type-only import (both TDZ-safe).
 *                      Uses dynamic imports of sqlite-native.ts inside async
 *                      functions (getDb, autoRecoverFromBackup) — runtime only.
 *
 * History:
 *   v1: `let _DatabaseSyncCtor = null` lived in sqlite.ts. When Vitest eagerly
 *       traces the dynamic `import('../memory/dispatch-trace.js')` in
 *       agent-resolver.ts, it re-entered sqlite.ts before its module scope
 *       finished executing. The `let` is in TDZ → ReferenceError.
 *   v2: Moved the cache into sqlite-native.ts. Still had a static
 *       `import { getDbSyncConstructor }` in sqlite.ts → Vite SSR transforms
 *       it to `const __vite_ssr_import_N__ = await import(...)`. Re-entrant
 *       access before that await resolved → TDZ on `__vite_ssr_import_N__`.
 *   v3: sqlite.ts has NO value-binding imports from sqlite-native.ts.
 *       openNativeDatabase moved to sqlite-native.ts. Re-export declarations
 *       are live-binding getters (not `const`) → cannot TDZ.
 *
 * @task T1331
 * @epic T1323
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('sqlite-native.ts leaf module (T1331 v3)', () => {
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

describe('sqlite.ts v3: no static value-binding import from sqlite-native.ts (T1331)', () => {
  it('sqlite.ts module source has no static value-binding import from sqlite-native.ts', async () => {
    // This test reads the compiled source of sqlite.ts and asserts that there is
    // no `import { ... } from './sqlite-native.js'` (value-binding) at module scope.
    // Only `import type` and `export { ... } from` (re-export) are permitted.
    //
    // Why: Vite SSR transforms `import { foo } from './bar.js'` into
    //   `const __vite_ssr_import_N__ = await import('./bar.js')`
    // If sqlite.ts is re-entered during that await, the const binding is in TDZ.
    // Re-exports (`export { foo } from './bar.js'`) become live-binding getters,
    // not const bindings, so they cannot TDZ. (T1331 v3)
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const sqliteSrc = readFileSync(join(thisDir, '../sqlite.ts'), 'utf8');

    // Must NOT have a value-binding import from sqlite-native
    const valueImportPattern = /^import\s*\{[^}]*\}\s*from\s*['"]\.\/sqlite-native\.js['"]/m;
    expect(
      valueImportPattern.test(sqliteSrc),
      'sqlite.ts must NOT have a static value-binding import from sqlite-native.ts — ' +
        'use import type or dynamic import inside async functions only (T1331 v3)',
    ).toBe(false);

    // MUST have a type-only import (for internal type annotations) — type-only is TDZ-safe
    const typeOnlyImportPattern =
      /^import\s+type\s*\{[^}]*DatabaseSync[^}]*\}\s*from\s*['"]\.\/sqlite-native\.js['"]/m;
    expect(
      typeOnlyImportPattern.test(sqliteSrc),
      'sqlite.ts should have an import type for DatabaseSync from sqlite-native.ts',
    ).toBe(true);
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
