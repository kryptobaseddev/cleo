/**
 * Regression test: nexus.db fresh init MUST NOT emit "Adding missing column" warnings.
 *
 * T9164 added an explicit forward migration for `nexus_nodes.is_external`, so
 * fresh databases get the column from Drizzle rather than from the ensureColumns()
 * safety net. This test locks in that fix by:
 *
 *   1. Initialising a fresh nexus.db in an isolated tmpdir.
 *   2. Capturing every `warn` call emitted by the logger during init.
 *   3. Asserting that NO captured message contains "Adding missing column".
 *   4. Verifying via PRAGMA table_info that:
 *      - nexus_nodes contains `is_external`
 *      - nexus_relations contains `weight`, `last_accessed_at`, `co_accessed_count`
 *
 * If the "Adding missing column" warning reappears on a fresh DB it means a new
 * column was added to ensureColumns() without a corresponding forward migration —
 * fix the migration, not this test.
 *
 * @task T9168
 * @task T9164
 * @epic T9163
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Native SQLite handle (node:sqlite is CJS-only in current Node versions)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('nexus.db fresh init — zero "Adding missing column" warnings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-nexus-no-repair-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits zero "Adding missing column" warnings on a brand-new nexus.db', async () => {
    // ------------------------------------------------------------------
    // 1. Reset module registry so mocks below apply cleanly to this test.
    // ------------------------------------------------------------------
    vi.resetModules();

    const cleoHome = join(tempDir, 'cleo-home');
    mkdirSync(cleoHome, { recursive: true });

    // ------------------------------------------------------------------
    // 2. Mock paths.js so nexus.db is written to our isolated tmpdir.
    // ------------------------------------------------------------------
    vi.doMock('../../paths.js', () => ({
      getCleoHome: () => cleoHome,
      getCleoDirAbsolute: (cwd?: string) => (cwd ? join(cwd, '.cleo') : join(tempDir, '.cleo')),
      getProjectRoot: () => tempDir,
    }));

    // ------------------------------------------------------------------
    // 3. Set up a capturing logger mock BEFORE importing nexus-sqlite.js,
    //    so every getLogger() call inside that module (and migration-manager)
    //    returns spies whose `warn` calls we can inspect.
    // ------------------------------------------------------------------
    const capturedWarnings: string[] = [];

    vi.doMock('../../logger.js', () => ({
      getLogger: (_subsystem?: string) => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          // Pino logger: warn(obj, msg) or warn(msg).
          // Collect whichever argument is a string so we catch the message
          // regardless of call signature.
          for (const arg of args) {
            if (typeof arg === 'string') {
              capturedWarnings.push(arg);
            }
          }
        }),
      }),
    }));

    // ------------------------------------------------------------------
    // 4. Import nexus-sqlite AFTER mocks are in place (vi.resetModules()
    //    above ensures a fresh module graph).
    // ------------------------------------------------------------------
    const { getNexusDb, resetNexusDbState } = await import('../nexus-sqlite.js');
    resetNexusDbState();

    try {
      // ------------------------------------------------------------------
      // 5. Initialize a fresh nexus.db — this is the path under test.
      // ------------------------------------------------------------------
      const db = await getNexusDb();
      expect(db).toBeTruthy();

      // ------------------------------------------------------------------
      // 6. PRIMARY: no "Adding missing column" warning must have fired.
      //    The fix in T9164 ensures is_external arrives via migration, not
      //    via ensureColumns(), so this string should never appear.
      // ------------------------------------------------------------------
      const repairWarnings = capturedWarnings.filter((msg) =>
        msg.includes('Adding missing column'),
      );
      expect(
        repairWarnings,
        `Expected zero "Adding missing column" warnings on fresh nexus.db but got:\n  ${repairWarnings.join('\n  ')}`,
      ).toHaveLength(0);

      // ------------------------------------------------------------------
      // 7. SECONDARY: verify required columns exist via PRAGMA table_info.
      // ------------------------------------------------------------------
      const dbPath = join(cleoHome, 'nexus.db');
      const nativeDb = new DatabaseSync(dbPath, { readonly: true });

      try {
        // nexus_nodes must have is_external (added by T9164 migration).
        const nodesCols = nativeDb.prepare('PRAGMA table_info(nexus_nodes)').all() as Array<{
          name: string;
        }>;
        const nodesColNames = nodesCols.map((c) => c.name);
        expect(nodesColNames).toContain('is_external');

        // nexus_relations must have the three plasticity columns (T998 migration).
        const relCols = nativeDb.prepare('PRAGMA table_info(nexus_relations)').all() as Array<{
          name: string;
        }>;
        const relColNames = relCols.map((c) => c.name);
        expect(relColNames).toContain('weight');
        expect(relColNames).toContain('last_accessed_at');
        expect(relColNames).toContain('co_accessed_count');
      } finally {
        nativeDb.close();
      }
    } finally {
      resetNexusDbState();
    }
  });
});
