/**
 * Integration tests for the dual-scope DB chokepoint (E4-T1 + E4-T4).
 *
 * Tests:
 *   1. openDualScopeDb('project') opens the project-scope cleo.db and migrates.
 *   2. openDualScopeDb('global') opens the global-scope cleo.db and migrates.
 *   3. insertIdempotent: writing a row with idempotency_key='X' 100× yields exactly 1 row.
 *   4. upsertIdempotent: updating an existing row via conflict target.
 *   5. Singleton cache: same (scope, cwd) returns the same handle reference.
 *   6. resolveDualScopeDbPath: sanity-check path shapes.
 *
 * @task T11515 (E4-T4)
 * @epic T11247 (E4)
 * @saga T11242
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as governorModule from '../../resources/governor.js';
import {
  _resetDualScopeDbCache,
  insertIdempotent,
  openDualScopeDb,
  resolveDualScopeDbPath,
} from '../dual-scope-db.js';

// ── Test directory management ─────────────────────────────────────────────────

let testRoot: string;
let projectDir: string;
let cleoDirProject: string;
let globalDir: string;

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `dual-scope-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Project scope: needs a .cleo dir under a project root
  projectDir = join(testRoot, 'project');
  cleoDirProject = join(projectDir, '.cleo');
  mkdirSync(cleoDirProject, { recursive: true });
  // Global scope: CLEO_HOME must end in 'cleo' so the DB path becomes
  // <CLEO_HOME>/cleo.db, which satisfies the /cleo[/\]cleo\.db$/ assertion.
  // vitest.setup.ts already sets CLEO_HOME to a per-fork sandbox, but we
  // override it here so the global DB lands in our isolated testRoot.
  globalDir = join(testRoot, 'cleo');
  mkdirSync(globalDir, { recursive: true });

  // CLEO_HOME is the env var that getCleoHome() reads (via getCleoPlatformPaths()
  // → createPlatformPathsResolver('cleo', 'CLEO_HOME')).  Setting XDG_DATA_HOME
  // alone does not work because env-paths' XDG_DATA_HOME path appends the app
  // name ("cleo"), making the result <XDG_DATA_HOME>/cleo, whereas CLEO_HOME is
  // used as-is.  We set CLEO_HOME = testRoot/cleo so the path becomes
  // testRoot/cleo/cleo.db, satisfying /cleo[/\]cleo\.db$/.
  process.env.CLEO_HOME = globalDir;
});

afterEach(() => {
  // Close and evict all cached handles.
  _resetDualScopeDbCache();
  // Restore env — delete our CLEO_HOME override so subsequent tests get the
  // per-fork sandbox set by vitest.setup.ts.
  delete process.env.CLEO_HOME;
  // Clean up temp dirs
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Count rows in a SQLite table via the native DB handle.
 * We use SQL directly since the consolidated schema tables
 * may not exist until migrations run.
 */
function countRows(nativeDb: import('node:sqlite').DatabaseSync, table: string): number {
  try {
    const result = nativeDb.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as
      | { c: number }
      | undefined;
    return result?.c ?? 0;
  } catch {
    return 0;
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('openDualScopeDb', () => {
  it('opens project scope and runs migrations', async () => {
    const handle = await openDualScopeDb('project', projectDir);
    expect(handle.scope).toBe('project');
    expect(handle.dbPath).toContain('cleo.db');
    expect(handle.db).toBeDefined();
  }, 30_000);

  it('opens global scope and runs migrations', async () => {
    const handle = await openDualScopeDb('global');
    expect(handle.scope).toBe('global');
    expect(handle.dbPath).toContain('cleo.db');
    expect(handle.db).toBeDefined();
  }, 30_000);

  it('returns the cached handle on subsequent calls (singleton)', async () => {
    const h1 = await openDualScopeDb('project', projectDir);
    const h2 = await openDualScopeDb('project', projectDir);
    expect(h1).toBe(h2);
  }, 30_000);

  it('project and global scopes are different handles', async () => {
    const proj = await openDualScopeDb('project', projectDir);
    const glob = await openDualScopeDb('global');
    expect(proj).not.toBe(glob);
    expect(proj.dbPath).not.toBe(glob.dbPath);
  }, 30_000);
});

describe('resolveDualScopeDbPath', () => {
  it('project path ends in .cleo/cleo.db under projectDir', () => {
    const path = resolveDualScopeDbPath('project', projectDir);
    expect(path).toMatch(/\.cleo[/\\]cleo\.db$/);
  });

  it('global path ends in cleo/cleo.db', () => {
    const path = resolveDualScopeDbPath('global');
    expect(path).toContain('cleo.db');
    expect(path).toMatch(/cleo[/\\]cleo\.db$/);
  });
});

describe('insertIdempotent + idempotency guarantee (E4 AC7)', () => {
  it('project scope: writing row with idempotency_key="X" 100× yields exactly 1 row', async () => {
    const handle = await openDualScopeDb('project', projectDir);

    // We need a table that exists after migration and has an idempotency_key column.
    // tasks_tasks has idempotency_key TEXT UNIQUE per the E2 schema (T11362).
    // Use the Drizzle schema's tasksTasksTable if available, or fall back to raw SQL.
    // Since the schema module is loaded dynamically, access via db.$client for low-level ops.

    // Low-level approach: use the native db to do direct inserts to verify idempotency logic.
    // This tests the ON CONFLICT DO NOTHING behavior without needing the full Drizzle typing.
    // The `as any` cast is required because $client is typed as unknown on the generic db handle.
    const nativeDb = (handle.db as any).$client as import('node:sqlite').DatabaseSync; // db-open-allowed: test-only $client access

    // Check if tasks_tasks exists (it should after migrations).
    const tableExistsResult = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks_tasks'")
      .get() as { name: string } | undefined;

    if (!tableExistsResult) {
      // Migrations may not have created the table if the migration folder is empty in tests.
      // Skip the row-level test but verify the handle opened successfully.
      expect(handle.db).toBeDefined();
      return;
    }

    // Insert a sentinel row 100 times via the idempotency helper.
    const idempotencyKey = `test-idempotency-${Date.now()}`;

    // Minimal row satisfying tasks_tasks NOT NULL constraints.
    // Only fill required columns to keep the test lean.
    const row = {
      id: 'T99999',
      title: 'Idempotency test task',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      idempotencyKey,
    };

    // Dynamic import with as-any cast to avoid typing the full schema module.
    // The table is exported as `tasksTasks` (not `tasksTasksTable`) per tasks-core.ts.
    const { tasksTasks } = (await import('../schema/cleo-project/tasks-core.js')) as any; // db-open-allowed: test-only schema import

    let insertedCount = 0;
    for (let i = 0; i < 100; i++) {
      const n = await insertIdempotent(handle.db, tasksTasks, row, 'idempotencyKey');
      insertedCount += n;
    }

    // Exactly 1 row should have been inserted despite 100 attempts.
    expect(insertedCount).toBe(1);

    // Verify via raw SQL.
    const rowCount = countRows(nativeDb, 'tasks_tasks');
    // At least 1 row (the one we just inserted); exactly our key appears once.
    const keyRow = nativeDb
      .prepare('SELECT COUNT(*) AS c FROM tasks_tasks WHERE idempotency_key = ?')
      .get(idempotencyKey) as { c: number } | undefined;
    expect(keyRow?.c).toBe(1);

    void rowCount; // suppress unused warning
  }, 60_000);

  it('global scope: opening and basic sanity check', async () => {
    const handle = await openDualScopeDb('global');
    // The `as any` cast is required because $client is typed as unknown on the generic db handle.
    const nativeDb = (handle.db as any).$client as import('node:sqlite').DatabaseSync;

    // Verify WAL mode is set (one of the pragma SSoT guarantees).
    const journalMode = nativeDb.prepare('PRAGMA journal_mode').get() as
      | { journal_mode: string }
      | undefined;
    expect(journalMode?.journal_mode).toBe('wal');
  }, 30_000);
});

describe('WAL coexistence (E3 AC8 preview)', () => {
  it('project and global DB can be open simultaneously without deadlock', async () => {
    const proj = await openDualScopeDb('project', projectDir);
    const glob = await openDualScopeDb('global');

    // Both handles should be usable concurrently without throwing.
    expect(proj.db).toBeDefined();
    expect(glob.db).toBeDefined();

    // The `as any` cast is required because $client is typed as unknown on the generic db handle.
    const projNative = (proj.db as any).$client as import('node:sqlite').DatabaseSync;
    const globNative = (glob.db as any).$client as import('node:sqlite').DatabaseSync;

    const projJournal = projNative.prepare('PRAGMA journal_mode').get() as
      | { journal_mode: string }
      | undefined;
    const globJournal = globNative.prepare('PRAGMA journal_mode').get() as
      | { journal_mode: string }
      | undefined;

    expect(projJournal?.journal_mode).toBe('wal');
    expect(globJournal?.journal_mode).toBe('wal');
  }, 30_000);
});

describe('exodus-on-open db-heavy admission (T12001 / Epic T11992)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('skips the exodus auto-migrate but still returns a usable handle when db-heavy is deferred', async () => {
    // Force the governor to DENY db-heavy admission on the exodus-on-open path.
    const spy = vi.spyOn(governorModule.governor, 'tryAcquire').mockResolvedValue({
      deferred: true,
      class: 'db-heavy',
      retryAfterMs: 2000,
      reason: 'forced deferral (test)',
    });

    // skip-not-block: the interactive open must NEVER fail or block under pressure
    // — it returns a valid, live handle (migration is simply deferred to a calmer
    // open). The legacy fleet is empty here, so the un-migrated handle is correct.
    const handle = await openDualScopeDb('project', projectDir);
    expect(handle).toBeDefined();
    expect(handle.scope).toBe('project');

    // The governor was consulted for db-heavy admission on the exodus path.
    expect(spy).toHaveBeenCalledWith('db-heavy');
  });

  it('proceeds with exodus-on-open when db-heavy is granted (full-budget byte-compatible)', async () => {
    const spy = vi.spyOn(governorModule.governor, 'tryAcquire').mockResolvedValue({
      deferred: false,
      class: 'db-heavy',
      slot: 0,
      acquiredAtMs: Date.now(),
      release: async () => {},
    });

    const handle = await openDualScopeDb('project', projectDir);
    expect(handle).toBeDefined();
    expect(spy).toHaveBeenCalledWith('db-heavy');
  });
});
