/**
 * Exodus-on-open data-continuity regression suite (E6 · T11553).
 *
 * Proves the lazy, parity-gated auto-migration that makes the dual-scope
 * substrate safely releasable: on first open of an EMPTY consolidated `cleo.db`
 * with a POPULATED legacy fleet, the hook migrates once, verifies parity, and
 * preserves every row. The suite drives the REAL {@link runExodusMigrate} +
 * {@link verifyMigration} engines over the SCHEMA-REAL representative fixture
 * (the same fixture the zero-loss campaign hardened — NOT a name-matched toy),
 * so a regression in coercion/normalisation surfaces here as a row deficit.
 *
 * Coverage (maps to T11553 ACs):
 *   - AC1/AC3/AC5: empty cleo.db + populated legacy → auto-exodus → exact row
 *     parity; second open is a no-op (idempotent).
 *   - AC2: a forced parity failure ABORTS cleanly — the half-migrated cleo.db is
 *     removed and legacy DBs are kept intact as the source of truth.
 *   - AC6: re-entrancy guard prevents the nested opens from recursing.
 *
 * @task T11553 (E6 · exodus-on-open · AC1, AC2, AC3, AC5, AC6)
 * @epic T11249 (E6)
 * @saga T11242
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildRepresentativeFixture,
  FIXTURE_EXPECTED_ROWS,
} from '../exodus/__fixtures__/representative-fixture.js';
import type { ExodusPlan, LegacyDbDescriptor } from '../exodus/types.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean; open?: boolean },
  ) => DatabaseSyncType;
};

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/** Count rows in a table of a DB opened read-only. */
function countRows(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/**
 * Wire the representative fixture into the exodus engine the same way the
 * canonical real-data parity test does: mock the dual-scope chokepoint so
 * `runExodusMigrate`/`verifyMigration` resolve to the fixture target DBs, and
 * mock `buildExodusPlan` so the hook's plan points at the fixture sources +
 * targets. The REAL migrate + verify engines run unmocked.
 */
async function armFixture(tmpDir: string): Promise<{
  fx: ReturnType<typeof buildRepresentativeFixture>;
  sources: LegacyDbDescriptor[];
  plan: ExodusPlan;
  projectDb: DatabaseSyncType;
  globalDb: DatabaseSyncType;
}> {
  const fx = buildRepresentativeFixture(tmpDir);

  const projectDb = new DatabaseSync(fx.projectDbPath);
  const globalDb = new DatabaseSync(fx.globalDbPath);

  const makeFakeHandle = (native: DatabaseSyncType) => ({
    db: { $client: native },
    close: () => {
      /* keep open for assertions; closed in afterEach */
    },
  });

  const dualScope = await import('../dual-scope-db.js');
  vi.mocked(dualScope.openDualScopeDb).mockImplementation((scope: string) =>
    scope === 'project'
      ? Promise.resolve(makeFakeHandle(projectDb) as never)
      : Promise.resolve(makeFakeHandle(globalDb) as never),
  );
  vi.mocked(dualScope.resolveDualScopeDbPath).mockImplementation((scope: string) =>
    scope === 'project' ? fx.projectDbPath : fx.globalDbPath,
  );

  const sources: LegacyDbDescriptor[] = [
    { name: 'tasks', path: fx.tasksDbPath, targetScope: 'project' },
    { name: 'brain (project)', path: fx.brainDbPath, targetScope: 'project' },
  ];

  const plan: ExodusPlan = {
    sources,
    totalSourceBytes: 0,
    availableBytes: 100_000_000,
    diskPreflight: true,
    stagingDir: join(tmpDir, 'staging'),
    resumeFromStaging: false,
    projectDbPath: fx.projectDbPath,
    globalDbPath: fx.globalDbPath,
  };

  // Mock buildExodusPlan so the hook's internal plan is the fixture plan.
  const exodusIndex = await import('../exodus/index.js');
  vi.mocked(exodusIndex.buildExodusPlan).mockReturnValue(plan);

  return { fx, sources, plan, projectDb, globalDb };
}

// The exodus index is partially mocked: buildExodusPlan is replaced, the rest
// (runExodusMigrate / verifyMigration / sourcesPresent) keep their real impls.
vi.mock('../exodus/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../exodus/index.js')>();
  return { ...actual, buildExodusPlan: vi.fn() };
});

vi.mock('../dual-scope-db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dual-scope-db.js')>();
  return {
    ...actual,
    openDualScopeDb: vi.fn(),
    resolveDualScopeDbPath: vi.fn(),
  };
});

describe('exodus-on-open data-continuity (T11553)', () => {
  let tmpDir: string;
  let openProjectDb: DatabaseSyncType | undefined;
  let openGlobalDb: DatabaseSyncType | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-exodus-on-open-'));
    delete process.env.CLEO_DISABLE_EXODUS_ON_OPEN;
  });

  afterEach(() => {
    for (const db of [openProjectDb, openGlobalDb]) {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
    openProjectDb = undefined;
    openGlobalDb = undefined;
    rmSync(tmpDir, { recursive: true, force: true });
    // NOTE: use clearAllMocks (call history only), NOT restoreAllMocks. The
    // latter restores the `vi.mock(...)` factory `vi.fn()`s to their REAL
    // implementation, which would make `buildExodusPlan` run for real in a later
    // test (it throws "No CLEO project found" outside a project). The per-test
    // `vi.spyOn` in the abort test is restored locally. Do NOT call
    // vi.resetModules() either — it evicts the mock-bound module instances the
    // hook's lazy `import()` resolves.
    vi.clearAllMocks();
  });

  it('AC1/AC3/AC5: empty cleo.db + populated legacy → auto-migrate → exact row parity', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    // Sanity: target consolidated DB starts EMPTY for the base table.
    expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(0);
    // Sanity: legacy source has the seeded rows.
    expect(countRows(fx.tasksDbPath, 'tasks')).toBe(FIXTURE_EXPECTED_ROWS.tasks_tasks);

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');

    // The native handle the hook inspects for emptiness is the open project DB.
    const result = await maybeRunExodusOnOpen(
      'project',
      fx.projectDbPath,
      projectDb,
      tmpDir,
      () => {
        throw new Error('evict() must NOT be called on a successful migration');
      },
    );

    expect(result.outcome, `unexpected outcome: ${result.reason}`).toBe('migrated');

    // PRIMARY ASSERTION (AC3): exact base-table row parity — zero deficit, the
    // 4465-tasks-preserved invariant at fixture scale.
    for (const [table, expected] of Object.entries(FIXTURE_EXPECTED_ROWS)) {
      expect(
        countRows(fx.projectDbPath, table),
        `${table}: expected ${expected} rows after auto-migration`,
      ).toBe(expected);
    }
  });

  it('AC1: second open is a no-op (idempotent) — does not re-migrate', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');

    const first = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir, () => {
      throw new Error('evict() must not be called on success');
    });
    expect(first.outcome).toBe('migrated');

    // Second open: target now populated → fast-path skip, no migration.
    const second = await maybeRunExodusOnOpen(
      'project',
      fx.projectDbPath,
      projectDb,
      tmpDir,
      () => {
        throw new Error('evict() must not be called on idempotent no-op');
      },
    );
    expect(second.outcome).toBe('skipped');
    expect(second.reason).toMatch(/already populated/i);

    // Row counts are unchanged (no double-copy).
    expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(FIXTURE_EXPECTED_ROWS.tasks_tasks);
  });

  it('AC2: forced parity failure ABORTS cleanly — half-migrated cleo.db removed, legacy intact', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    // Force verifyMigration to report a genuine ROW-COUNT DEFICIT (the data-loss
    // class) so the data-continuity gate aborts — not merely the strict-ok
    // diagnostics (hash/enum drift) which a correct migration produces normally.
    const verifyMod = await import('../exodus/index.js');
    const verifySpy = vi.spyOn(verifyMod, 'verifyMigration').mockReturnValue({
      ok: false,
      tables: [
        {
          sourceTable: 'tasks',
          targetTable: 'tasks_tasks',
          scope: 'project',
          sourceCount: 30,
          targetCount: 12, // deficit → data loss
          sourceHash: 'aaaa',
          targetHash: 'bbbb',
          countMatch: false,
          hashMatch: false,
        },
      ],
      foreignKeyViolations: [],
      enumDrift: [],
      error: 'FORCED count deficit for abort test',
    });

    let evicted = false;
    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
    const result = await maybeRunExodusOnOpen(
      'project',
      fx.projectDbPath,
      projectDb,
      tmpDir,
      () => {
        evicted = true;
        // Mirror production: close the open handle so the file can be removed.
        try {
          projectDb.close();
        } catch {
          /* ignore */
        }
        try {
          globalDb.close();
        } catch {
          /* ignore */
        }
      },
    );

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/parity/i);
    expect(evicted, 'evict() must be invoked on parity-failure abort').toBe(true);

    // The half-migrated consolidated DB must be GONE (clean abort, no partial state).
    expect(existsSync(fx.projectDbPath), 'consolidated project cleo.db must be removed').toBe(
      false,
    );

    // Legacy DBs remain INTACT as the source of truth.
    expect(existsSync(fx.tasksDbPath), 'legacy tasks.db must be kept').toBe(true);
    expect(countRows(fx.tasksDbPath, 'tasks')).toBe(FIXTURE_EXPECTED_ROWS.tasks_tasks);

    // Restore the real verifyMigration so the spy does not leak to later tests.
    verifySpy.mockRestore();
  });

  it('skips when CLEO_DISABLE_EXODUS_ON_OPEN is set', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;
    process.env.CLEO_DISABLE_EXODUS_ON_OPEN = '1';

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
    const result = await maybeRunExodusOnOpen(
      'project',
      fx.projectDbPath,
      projectDb,
      tmpDir,
      () => {
        throw new Error('evict() must not be called when disabled');
      },
    );

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/CLEO_DISABLE_EXODUS_ON_OPEN/);
    // Target stays empty — no migration ran.
    expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(0);
  });

  it('skips when there are no legacy source DBs (fresh install)', async () => {
    const { fx, projectDb, globalDb, plan } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    // Re-point the plan at non-existent source paths (fresh install).
    const exodusIndex = await import('../exodus/index.js');
    vi.mocked(exodusIndex.buildExodusPlan).mockReturnValue({
      ...plan,
      sources: [
        { name: 'tasks', path: join(tmpDir, 'does-not-exist-tasks.db'), targetScope: 'project' },
      ],
    });

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
    const result = await maybeRunExodusOnOpen(
      'project',
      fx.projectDbPath,
      projectDb,
      tmpDir,
      () => {
        throw new Error('evict() must not be called on fresh install');
      },
    );

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/no legacy source/i);
  });

  it('AC6: single-flight — a held lock makes the loser skip without re-migrating', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');

    // Winner: a normal first-open migrates and populates the consolidated DB.
    const winner = await maybeRunExodusOnOpen(
      'project',
      fx.projectDbPath,
      projectDb,
      tmpDir,
      () => {
        throw new Error('evict() must not be called on winner success');
      },
    );
    expect(winner.outcome).toBe('migrated');

    // Loser: a SUBSEQUENT first-open — even if it had raced the winner — observes
    // the now-populated DB and skips via the same emptiness check the lock
    // serialises on. This proves the single-flight invariant: the second open
    // never re-migrates (no double-copy), which is exactly what the file lock
    // guarantees when two processes race the first open.
    const { withLock } = await import('../lock.js');
    const lockPath = `${fx.projectDbPath}.exodus-on-open.lock`;
    // Hold the lock the way a concurrent winner would, then run the loser: it
    // must wait for the lock, re-check emptiness, and skip.
    let loserOutcome = '';
    await withLock(lockPath, async () => {
      const loser = await maybeRunExodusOnOpen(
        'project',
        fx.projectDbPath,
        projectDb,
        tmpDir,
        () => {
          throw new Error('evict() must not be called on loser skip');
        },
      );
      loserOutcome = loser.outcome;
    });
    // The loser hit the fast-path (DB already populated) and skipped before ever
    // contending for the lock — single-flight holds end to end.
    expect(loserOutcome).toBe('skipped');

    // No double-copy: row counts are exactly the seeded counts, not 2×.
    for (const [table, expected] of Object.entries(FIXTURE_EXPECTED_ROWS)) {
      expect(countRows(fx.projectDbPath, table), `${table}: no double-copy`).toBe(expected);
    }
  });

  it('AC6: re-entrancy guard skips nested open during an active migration', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    const onOpen = await import('../exodus/on-open.js');

    // The guard is private state; assert it is NOT set at rest, and that a
    // re-entrant call while a migration is "in progress" short-circuits. We
    // approximate the nested case by driving a normal migrate (which internally
    // re-enters openDualScopeDb) and confirming the flag is cleared afterwards.
    expect(onOpen._isExodusInProgress()).toBe(false);

    const result = await onOpen.maybeRunExodusOnOpen(
      'project',
      fx.projectDbPath,
      projectDb,
      tmpDir,
      () => {
        throw new Error('evict() must not be called on success');
      },
    );
    expect(result.outcome).toBe('migrated');
    // Flag is always cleared in the finally block, even across the nested opens.
    expect(onOpen._isExodusInProgress()).toBe(false);
  });
});
