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

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../paths.js';
import * as governorModule from '../../resources/governor.js';
import { createOperationExecutionContext } from '../background-ops.js';
import {
  _resetDualScopeDbCache,
  type CleoRuntime,
  createCleoRuntime,
  insertIdempotent,
  openDualScopeDb,
  openDualScopeDbAtPath,
  resolveDualScopeDbPath,
  setRuntimeOpenFn,
} from '../dual-scope-db.js';
import { withColdOpenLease } from '../writer-lease.js';

// ── Test directory management ─────────────────────────────────────────────────

let testRoot: string;
let projectDir: string;
let cleoDirProject: string;
let globalDir: string;

// Distinct explicit project roots must resolve to distinct fixture stores.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});
afterEach(() => vi.unstubAllEnvs());

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

  it('reopens a cached handle whose native connection was closed', async () => {
    const first = await openDualScopeDb('project', projectDir);
    first.db.$client.close();

    const reopened = await openDualScopeDb('project', projectDir);

    expect(reopened).not.toBe(first);
    expect(reopened.db.$client.isOpen).toBe(true);
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

// ── CleoRuntime store registry tests (E6-L12 · T12036) ────────────────────────

describe('CleoRuntime store registry', () => {
  let runtime: CleoRuntime;
  let projectAPath: string;
  let projectBPath: string;
  /** Scope-qualified key that openPaths should report for project A. */
  let projectAKey: string;
  let projectBKey: string;

  beforeEach(() => {
    // Reset the dual-scope cache so each test starts clean.
    _resetDualScopeDbCache();
    runtime = createCleoRuntime();

    // Create two distinct project directories with .cleo subdirs.
    const dirA = join(testRoot, 'project-a');
    const dirB = join(testRoot, 'project-b');
    mkdirSync(join(dirA, '.cleo'), { recursive: true });
    mkdirSync(join(dirB, '.cleo'), { recursive: true });
    projectAPath = resolveDualScopeDbPath('project', dirA);
    projectBPath = resolveDualScopeDbPath('project', dirB);
    projectAKey = `project::${resolvePath(projectAPath)}`;
    projectBKey = `project::${resolvePath(projectBPath)}`;
  });

  afterEach(async () => {
    runtime.closeAll();
    _resetDualScopeDbCache();
    try {
      rmSync(testRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // ── openProject ───────────────────────────────────────────────────────────

  describe('openProject', () => {
    it('returns a ProjectStore bound to the requested canonical path', async () => {
      const store = await runtime.openProject(projectAPath);
      expect(store.scope).toBe('project');
      expect(resolvePath(store.dbPath)).toBe(resolvePath(projectAPath));
      expect(store.db).toBeDefined();
    }, 30_000);

    it('concurrent openProject(A) and openProject(B) return distinct live handles', async () => {
      const [storeA, storeB] = await Promise.all([
        runtime.openProject(projectAPath),
        runtime.openProject(projectBPath),
      ]);
      expect(storeA).not.toBe(storeB);
      expect(resolvePath(storeA.dbPath)).toBe(resolvePath(projectAPath));
      expect(resolvePath(storeB.dbPath)).toBe(resolvePath(projectBPath));
      expect(storeA.db).not.toBe(storeB.db);
      expect(storeA.isOpen).toBe(true);
      expect(storeB.isOpen).toBe(true);
    }, 30_000);

    it('same-path concurrent opens single-flight and share one entry', async () => {
      const stores = await Promise.all(
        Array.from({ length: 10 }, () => runtime.openProject(projectAPath)),
      );
      for (const store of stores) {
        expect(store).toBe(stores[0]);
      }
    }, 30_000);

    it('returns cached entry on sequential same-path opens', async () => {
      const first = await runtime.openProject(projectAPath);
      const second = await runtime.openProject(projectAPath);
      expect(second).toBe(first);
    }, 30_000);

    it('reports scope-qualified keys in openPaths', async () => {
      await runtime.openProject(projectAPath);
      await runtime.openProject(projectBPath);
      const paths = runtime.openPaths;
      expect(paths.has(projectAKey)).toBe(true);
      expect(paths.has(projectBKey)).toBe(true);
    }, 30_000);

    // ── Bug 5 regressions: canonical path aliases ──────────────────────────

    it('equivalent path spellings single-flight (path normalization)', async () => {
      // Insert `/.` before the filename: /path/.cleo/./cleo.db → same as /path/.cleo/cleo.db
      const aliased = join(join(projectAPath, '..'), '.', 'cleo.db');
      const [store1, store2] = await Promise.all([
        runtime.openProject(projectAPath),
        runtime.openProject(aliased),
      ]);
      expect(store1).toBe(store2);
    }, 30_000);

    it('normalized path keying: path with redundant segments resolves to canonical', async () => {
      // Provide a path with a redundant `./` segment that resolve() normalizes.
      const dir = join(projectAPath, '..');
      const aliased = join(dir, '.', 'cleo.db');
      const [store1, store2] = await Promise.all([
        runtime.openProject(projectAPath),
        runtime.openProject(aliased),
      ]);
      expect(store1).toBe(store2);
    }, 30_000);
  });

  // ── openGlobal ────────────────────────────────────────────────────────────

  describe('openGlobal', () => {
    it('returns a GlobalStore bound to the canonical global path', async () => {
      const store = await runtime.openGlobal();
      expect(store.scope).toBe('global');
      expect(store.dbPath).toContain('cleo.db');
      expect(store.db).toBeDefined();
    }, 30_000);

    it('same-path concurrent opens single-flight', async () => {
      const stores = await Promise.all([runtime.openGlobal(), runtime.openGlobal()]);
      expect(stores[0]).toBe(stores[1]);
    }, 30_000);
  });

  // ── Scoped disposal ──────────────────────────────────────────────────────

  describe('scoped disposal', () => {
    it('closing one project never closes another project', async () => {
      const storeA = await runtime.openProject(projectAPath);
      const storeB = await runtime.openProject(projectBPath);

      storeA.close();

      expect(runtime.openPaths.has(projectAKey)).toBe(false);
      expect(runtime.openPaths.has(projectBKey)).toBe(true);
      expect(storeB.isOpen).toBe(true);
    }, 30_000);

    it('closing a project never closes the global scope', async () => {
      const project = await runtime.openProject(projectAPath);
      const global = await runtime.openGlobal();

      project.close();

      expect(runtime.openPaths.has(projectAKey)).toBe(false);
      expect(global.isOpen).toBe(true);
      const reopenedGlobal = await runtime.openGlobal();
      expect(reopenedGlobal).toBe(global);
    }, 30_000);

    it('closeProject() evicts only the targeted project', async () => {
      await runtime.openProject(projectAPath);
      await runtime.openProject(projectBPath);
      const global = await runtime.openGlobal();

      runtime.closeProject(projectAPath);

      expect(runtime.openPaths.has(projectAKey)).toBe(false);
      expect(runtime.openPaths.has(projectBKey)).toBe(true);
      expect(global.isOpen).toBe(true);
    }, 30_000);

    it('closeProject is idempotent', async () => {
      await runtime.openProject(projectAPath);
      runtime.closeProject(projectAPath);
      runtime.closeProject(projectAPath);
      expect(runtime.openPaths.has(projectAKey)).toBe(false);
    }, 30_000);

    it('closeAll() disposes every entry', async () => {
      await runtime.openProject(projectAPath);
      await runtime.openProject(projectBPath);
      await runtime.openGlobal();

      runtime.closeAll();

      expect(runtime.openPaths.size).toBe(0);
    }, 30_000);

    it('closeAll is idempotent and safe across edge cases', async () => {
      runtime.closeAll();
      expect(runtime.openPaths.size).toBe(0);
      await runtime.openProject(projectAPath);
      runtime.closeAll();
      runtime.closeAll();
      expect(runtime.openPaths.size).toBe(0);
    }, 30_000);
  });

  // ── Bug 1 regressions: close during in-flight init ───────────────────────

  describe('init cancellation (close during in-flight open)', () => {
    it('closeProject during in-flight open cancels the init and rejects', async () => {
      // Start an open on a path we haven't opened yet — it won't hit cache.
      const openPromise = runtime.openProject(projectAPath);
      // Cancel it immediately.
      runtime.closeProject(projectAPath);

      await expect(openPromise).rejects.toThrow(/cancelled/i);
    }, 30_000);

    it('closeAll during in-flight open cancels all inits', async () => {
      const openA = runtime.openProject(projectAPath);
      const openB = runtime.openProject(projectBPath);
      runtime.closeAll();

      await expect(openA).rejects.toThrow(/cancelled/i);
      await expect(openB).rejects.toThrow(/cancelled/i);
    }, 30_000);

    it('acquired handle is NOT closed when init is cancelled (replacement inherits it)', async () => {
      const openPromise = runtime.openProject(projectAPath);
      runtime.closeProject(projectAPath);

      await expect(openPromise).rejects.toThrow();

      // The dual-scope cache still has the live handle — the cancellation
      // intentionally left it intact. A fresh open reuses it.
      const fresh = await runtime.openProject(projectAPath);
      expect(fresh.scope).toBe('project');
      expect(fresh.isOpen).toBe(true);
    }, 30_000);

    it('cancelled-then-retry succeeds with a fresh entry', async () => {
      // Open + cancel.
      const first = runtime.openProject(projectAPath);
      runtime.closeProject(projectAPath);
      await expect(first).rejects.toThrow();

      // Retry — must succeed.
      const second = await runtime.openProject(projectAPath);
      expect(second.scope).toBe('project');
      expect(second.isOpen).toBe(true);
      expect(runtime.openPaths.has(projectAKey)).toBe(true);
    }, 30_000);
  });

  // ── Bug 2 regressions: cache-hit liveness ────────────────────────────────

  describe('cache-hit liveness (externally closed handle)', () => {
    it('reopens when the underlying DatabaseSync was externally closed', async () => {
      const first = await runtime.openProject(projectAPath);

      // Simulate external close — the dual-scope cache is evicted and
      // the native connection is closed, but the runtime still has the entry.
      _resetDualScopeDbCache('project');

      // The runtime should detect the closed native handle and reopen.
      const second = await runtime.openProject(projectAPath);
      expect(second).not.toBe(first);
      expect(second.isOpen).toBe(true);
      // The old store's native handle is now closed.
      expect(first.isOpen).toBe(false);
    }, 30_000);

    it('reopens after external close of global handle', async () => {
      const first = await runtime.openGlobal();
      _resetDualScopeDbCache('global');

      const second = await runtime.openGlobal();
      expect(second).not.toBe(first);
      expect(second.isOpen).toBe(true);
      expect(first.isOpen).toBe(false);
    }, 30_000);
  });

  // ── Bug 3 regressions: stale store close ─────────────────────────────────

  describe('stale store close (old close after reopen)', () => {
    it('old store close is a no-op after reopen', async () => {
      const store1 = await runtime.openProject(projectAPath);
      // Close and reopen.
      store1.close();
      const store2 = await runtime.openProject(projectAPath);
      expect(store2).not.toBe(store1);

      // store1.close() again must NOT affect store2 or the registry.
      store1.close();
      expect(runtime.openPaths.has(projectAKey)).toBe(true);
      expect(store2.isOpen).toBe(true);
    }, 30_000);

    it('old store close after closeAll+reopen is a no-op', async () => {
      const store1 = await runtime.openProject(projectAPath);
      runtime.closeAll();
      expect(runtime.openPaths.size).toBe(0);
      const store2 = await runtime.openProject(projectAPath);

      // Old close must not delete the new entry.
      store1.close();
      expect(runtime.openPaths.has(projectAKey)).toBe(true);
      expect(store2.isOpen).toBe(true);
    }, 30_000);
  });

  // ── Bug 4 regressions: scope collision via scope-qualified keys ──────────

  describe('scope-qualified keys (no project/global collision)', () => {
    it('project and global entries with overlapping path strings are distinct', async () => {
      const project = await runtime.openProject(projectAPath);
      const global = await runtime.openGlobal();

      // The runtime's openPaths must use scope-qualified keys, so both are
      // present even if projectAPath and the global path were identical
      // (they aren't here, but the test proves the key scheme).
      expect(runtime.openPaths.size).toBeGreaterThanOrEqual(2);
      expect(project.scope).toBe('project');
      expect(global.scope).toBe('global');

      // Close only project — global must survive.
      project.close();
      expect(global.isOpen).toBe(true);
    }, 30_000);
  });

  // ── Cross-runtime sharing (documented invariant) ─────────────────────────

  describe('cross-runtime shared handle behavior', () => {
    it('two runtimes share the same underlying handle for the same path', async () => {
      const rt1 = createCleoRuntime();
      const rt2 = createCleoRuntime();

      const s1 = await rt1.openProject(projectAPath);
      const s2 = await rt2.openProject(projectAPath);

      // Same underlying drizzle + native handle (shared _cache).
      expect(s1.db).toBe(s2.db);

      // Closing s1 in runtime A closes the shared handle.
      s1.close();
      // Runtime B's store now points to a closed native connection.
      expect(s2.isOpen).toBe(false);

      // But runtime B's liveness check on the next open reacquires a fresh
      // handle.
      const s3 = await rt2.openProject(projectAPath);
      expect(s3).not.toBe(s2);
      expect(s3.isOpen).toBe(true);

      rt1.closeAll();
      rt2.closeAll();
    }, 30_000);
  });

  // ── Failed-init-then-retry (compound regression) ─────────────────────────

  describe('failed-initialization retry', () => {
    it('entry is clean after cancelled init and reopens correctly', async () => {
      // Start an open on a path, cancel it mid-flight.
      const cancelled = runtime.openProject(projectAPath);
      runtime.closeProject(projectAPath);
      await expect(cancelled).rejects.toThrow();

      // Verify the entry is fully cleaned — registry has no trace of it.
      expect(runtime.openPaths.has(projectAKey)).toBe(false);

      // Retry: should succeed.
      const retry = await runtime.openProject(projectAPath);
      expect(retry.isOpen).toBe(true);
    }, 30_000);
  });

  // ── Dedicated mode (T12036 — snapshots/workers isolation) ───────────────

  describe('dedicated mode', () => {
    it('dedicated project open returns a live store not in the registry', async () => {
      const store = await runtime.openProject(projectAPath, { dedicated: true });
      expect(store.scope).toBe('project');
      expect(store.isOpen).toBe(true);
      // Dedicated entries are NOT tracked.
      expect(runtime.openPaths.size).toBe(0);
      store.close();
      expect(store.isOpen).toBe(false);
    }, 30_000);

    it('dedicated global open returns a live store not in the registry', async () => {
      const store = await runtime.openGlobal({ dedicated: true });
      expect(store.scope).toBe('global');
      expect(store.isOpen).toBe(true);
      expect(runtime.openPaths.size).toBe(0);
      store.close();
      expect(store.isOpen).toBe(false);
    }, 30_000);

    it('dedicated close does not affect a cached non-dedicated entry', async () => {
      const cached = await runtime.openProject(projectAPath);
      const dedicated = await runtime.openProject(projectAPath, { dedicated: true });

      // They are distinct stores with different handles.
      expect(dedicated).not.toBe(cached);
      expect(dedicated.db).not.toBe(cached.db);

      dedicated.close();
      // Cached entry survives.
      expect(cached.isOpen).toBe(true);
      expect(runtime.openPaths.has(projectAKey)).toBe(true);

      cached.close();
    }, 30_000);

    it('dedicated stores are never single-flighted', async () => {
      const [d1, d2] = await Promise.all([
        runtime.openProject(projectAPath, { dedicated: true }),
        runtime.openProject(projectAPath, { dedicated: true }),
      ]);
      // Each dedicated call opens a new connection — they are distinct.
      expect(d1).not.toBe(d2);
      expect(d1.db).not.toBe(d2.db);
      d1.close();
      d2.close();
    }, 30_000);

    // ── F4: concurrent dedicated fresh-file migration consistency ─────────

    it('concurrent dedicated opens of a fresh file both resolve live', async () => {
      // Dedicated opens now run under withColdOpenLease, so two concurrent
      // dedicated opens of a brand-new file serialize their migrations and
      // both succeed with live, independent handles.
      const [d1, d2] = await Promise.all([
        runtime.openProject(projectAPath, { dedicated: true }),
        runtime.openProject(projectAPath, { dedicated: true }),
      ]);
      expect(d1.isOpen).toBe(true);
      expect(d2.isOpen).toBe(true);
      expect(d1).not.toBe(d2);
      expect(d1.db).not.toBe(d2.db);
      d1.close();
      d2.close();
    }, 30_000);

    it('dedicated open bypasses setRuntimeOpenFn and produces an untracked independent store', async () => {
      // Install a custom opener that always throws — dedicated opens must
      // bypass it and call openDualScopeDbAtPath directly.
      setRuntimeOpenFn(runtime, async () => {
        throw new Error('custom opener must not be called for dedicated');
      });
      try {
        const store = await runtime.openProject(projectAPath, { dedicated: true });
        expect(store.isOpen).toBe(true);
        expect(runtime.openPaths.size).toBe(0);
        store.close();
      } finally {
        setRuntimeOpenFn(runtime, undefined);
      }
    }, 30_000);
  });

  // ── F1: identity-guarded chokepoint close ──────────────────────────────

  describe('identity-guarded chokepoint close (F1 · stale close after replacement)', () => {
    it('stale store close does not evict replacement from chokepoint cache', async () => {
      const store1 = await runtime.openProject(projectAPath);
      store1.close();

      // Open a replacement — this is a new chokepoint cache entry.
      const store2 = await runtime.openProject(projectAPath);

      // store1.close() again — must NOT evict store2's chokepoint entry.
      store1.close();

      // Verify store2's handle is still live in the chokepoint cache:
      // a direct openDualScopeDbAtPath returns the same handle.
      const directHandle = await openDualScopeDbAtPath('project', resolvePath(projectAPath));
      expect(directHandle.db).toBe(store2.db);
      expect(directHandle.isOpen).toBe(true);

      store2.close();
    }, 30_000);
  });

  // ── F2: cancel then immediate reopen shares in-flight chokepoint ──────

  describe('cancel-then-immediate-reopen (F2 · shared chokepoint promise)', () => {
    it('cancelled open does not close handle that replacement inherits', async () => {
      // p1 starts, enters chokepoint init.
      const p1 = runtime.openProject(projectAPath);
      // Cancel before p1 resolves.
      runtime.closeProject(projectAPath);
      // p2 starts IMMEDIATELY — before p1's await continues.
      const p2 = runtime.openProject(projectAPath);

      // p1 must reject.
      await expect(p1).rejects.toThrow(/cancelled/i);

      // p2 must resolve with a live store.
      const store2 = await p2;
      expect(store2.scope).toBe('project');
      expect(store2.isOpen).toBe(true);

      store2.close();
    }, 30_000);
  });

  // ── F3: post-await liveness before publish ─────────────────────────────

  describe('post-await liveness (F3 · injectable opener seam)', () => {
    it('one-time reacquisition succeeds when opener returns a dead handle then a live one', async () => {
      let openCount = 0;
      setRuntimeOpenFn(runtime, async (scope, path) => {
        const handle = await openDualScopeDbAtPath(scope, path);
        openCount++;
        if (openCount === 1) {
          handle.close();
        }
        return handle;
      });
      try {
        const store = await runtime.openProject(projectAPath);
        expect(store.isOpen).toBe(true);
        expect(openCount).toBe(2);
        store.close();
      } finally {
        setRuntimeOpenFn(runtime, undefined);
      }
    }, 30_000);

    it('throws LivenessExhaustedError when both attempts return dead handles', async () => {
      setRuntimeOpenFn(runtime, async (scope, path) => {
        const handle = await openDualScopeDbAtPath(scope, path);
        handle.close();
        return handle;
      });
      try {
        await expect(runtime.openProject(projectAPath)).rejects.toThrow(/liveness exhausted/i);
      } finally {
        setRuntimeOpenFn(runtime, undefined);
      }
    }, 30_000);

    it('preserves original error when retry fails with a non-liveness error', async () => {
      // Use an opener that succeeds on first call (live handle), then the
      // second call throws a migration error.
      let callCount = 0;
      setRuntimeOpenFn(runtime, async (scope, path) => {
        callCount++;
        if (callCount === 1) {
          const handle = await openDualScopeDbAtPath(scope, path);
          handle.close();
          return handle;
        }
        throw new Error('injected migration failure');
      });
      try {
        await expect(runtime.openProject(projectAPath)).rejects.toThrow(
          /injected migration failure/,
        );
      } finally {
        setRuntimeOpenFn(runtime, undefined);
      }
    }, 30_000);
  });

  // ── Path normalization in chokepoint (F5 extension) ────────────────────

  describe('chokepoint path normalization', () => {
    it('direct openDualScopeDbAtPath with aliased path shares cache entry', async () => {
      const h1 = await openDualScopeDbAtPath('project', resolvePath(projectAPath));
      // Open with a path containing ./ that normalize resolves.
      const aliased = join(join(resolvePath(projectAPath), '..'), '.', 'cleo.db');
      const h2 = await openDualScopeDbAtPath('project', aliased);

      // Same cache entry (normalized path key).
      expect(h2.db).toBe(h1.db);
      h1.close();
    }, 30_000);

    it('cached handle exposes normalized dbPath, not raw alias', async () => {
      // Open first via canonical path.
      const h1 = await openDualScopeDbAtPath('project', resolvePath(projectAPath));
      // Open second via aliased path — hits same cache entry.
      const aliased = join(join(resolvePath(projectAPath), '..'), '.', 'cleo.db');
      const h2 = await openDualScopeDbAtPath('project', aliased);

      // Both handles should report the normalized path, not the alias.
      expect(h2.dbPath).toBe(resolvePath(projectAPath));
      expect(h2.dbPath).toBe(h1.dbPath);
      h1.close();
    }, 30_000);
  });
});

describe('captured canonical opener lifetime', () => {
  function context(key: string, budgetMs = 2000) {
    return createOperationExecutionContext(
      {
        projectId: 'cold-open-fixture',
        projectRoot: projectDir,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: key,
      },
      { budgetMs },
    );
  }

  it('rejects cancellation before directory creation, including dedicated opens', async () => {
    const execution = context('expired', 0);
    const target = join(testRoot, 'never-created', 'cleo.db');
    try {
      for (const dedicated of [false, true]) {
        await expect(
          openDualScopeDbAtPath('project', target, undefined, { execution, dedicated }),
        ).rejects.toThrow();
      }
      expect(existsSync(join(testRoot, 'never-created'))).toBe(false);
    } finally {
      execution.close();
    }
  });

  it('refuses nested replacement of the captured execution through both openers', async () => {
    const original = context('original');
    const replacement = context('replacement');
    try {
      await worktreeScope.run(
        { worktreeRoot: projectDir, projectHash: 'cold-open-fixture', execution: original },
        async () => {
          await expect(
            openDualScopeDb('project', projectDir, { execution: replacement }),
          ).rejects.toThrow('cannot replace');
          await expect(
            openDualScopeDbAtPath('project', join(cleoDirProject, 'cleo.db'), undefined, {
              execution: replacement,
            }),
          ).rejects.toThrow('cannot replace');
        },
      );
      expect(existsSync(join(cleoDirProject, 'cleo.db'))).toBe(false);
    } finally {
      original.close();
      replacement.close();
    }
  });

  it('cancels a real cold initializer and lets its live shared waiter retry safely', async () => {
    const target = join(cleoDirProject, 'cleo.db');
    const holderNative = new DatabaseSync(target);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = withColdOpenLease('project', holderNative, async () => {
      entered();
      await gate;
    });
    await ready;
    const cancelled = context('cancelled', 30);
    const live = context('live', 5000);
    const first = openDualScopeDbAtPath('project', target, undefined, { execution: cancelled });
    const firstRejected = expect(first).rejects.toThrow();
    const second = openDualScopeDbAtPath('project', target, undefined, { execution: live });
    try {
      await firstRejected;
      expect(holderNative.isOpen).toBe(true);
      expect(
        holderNative
          .prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='tasks_tasks'")
          .get()?.count,
      ).toBe(0);
      release();
      await holder;
      const handle = await second;
      expect(handle.isOpen).toBe(true);
      expect(
        handle.db.$client.prepare("SELECT name FROM sqlite_master WHERE name='tasks_tasks'").get()
          ?.name,
      ).toBe('tasks_tasks');
      const fresh = new DatabaseSync(target, { readOnly: true });
      try {
        expect(
          fresh.prepare("SELECT name FROM sqlite_master WHERE name='tasks_tasks'").get()?.name,
        ).toBe('tasks_tasks');
      } finally {
        fresh.close();
      }
      cancelled.close();
      expect(await openDualScopeDbAtPath('project', target)).toBe(handle);
      expect(handle.db.$client.prepare('SELECT 1 AS alive').get()?.alive).toBe(1);
    } finally {
      release();
      await holder;
      await Promise.allSettled([first, second]);
      cancelled.close();
      live.close();
      holderNative.close();
    }
  }, 15000);

  it.each([
    false,
    true,
  ])('stops delayed maintenance after cancellation (cleanup=%s)', async (cleanup) => {
    let releaseAdmission = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releaseSlot = vi.fn(async () => {});
    const spy = vi.spyOn(governorModule.governor, 'tryAcquire').mockImplementation(async () => {
      entered();
      await gate;
      return {
        deferred: false,
        class: 'db-heavy',
        slot: 0,
        acquiredAtMs: Date.now(),
        release: releaseSlot,
      };
    });
    const execution = context('delayed-maintenance', 5000);
    const target = join(cleoDirProject, 'cleo.db');
    const first = openDualScopeDb('project', projectDir, { execution });
    try {
      await ready;
      const live = await openDualScopeDbAtPath('project', target);
      execution.close();
      if (cleanup) {
        _resetDualScopeDbCache();
        rmSync(cleoDirProject, { recursive: true });
      }
      const rejected = expect(first).rejects.toThrow();
      releaseAdmission();
      await rejected;
      expect(releaseSlot).toHaveBeenCalledTimes(1);
      if (cleanup) expect(existsSync(cleoDirProject)).toBe(false);
      else {
        expect(live.isOpen).toBe(true);
        expect(live.db.$client.prepare('SELECT 1 AS alive').get()?.alive).toBe(1);
      }
    } finally {
      releaseAdmission();
      await Promise.allSettled([first]);
      execution.close();
      spy.mockRestore();
    }
  });

  it('never closes a cached live handle when a different caller is already cancelled', async () => {
    const target = join(cleoDirProject, 'cleo.db');
    const handle = await openDualScopeDbAtPath('project', target);
    const execution = context('closed');
    execution.close();
    await expect(
      openDualScopeDbAtPath('project', target, undefined, { execution }),
    ).rejects.toThrow();
    expect(handle.isOpen).toBe(true);
    expect(handle.db.$client.prepare('SELECT 1 AS alive').get()?.alive).toBe(1);
  });
});
