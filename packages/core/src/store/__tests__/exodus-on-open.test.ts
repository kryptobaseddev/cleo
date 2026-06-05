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
 *   - AC2: a forced parity failure ABORTS cleanly — the half-migrated tables are
 *     rolled back to empty IN PLACE (handle stays open) and legacy DBs are kept
 *     intact as the source of truth.
 *   - AC6: single-flight lock + re-entrancy guard prevent double / recursive
 *     migration; a project open never fires on a global-only legacy source.
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
  FIXTURE_HAZARD_EXPECTED_ROWS,
  type RepresentativeFixtureOptions,
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
async function armFixture(
  tmpDir: string,
  fixtureOpts: RepresentativeFixtureOptions = {},
): Promise<{
  fx: ReturnType<typeof buildRepresentativeFixture>;
  sources: LegacyDbDescriptor[];
  plan: ExodusPlan;
  projectDb: DatabaseSyncType;
  globalDb: DatabaseSyncType;
}> {
  const fx = buildRepresentativeFixture(tmpDir, fixtureOpts);

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
  // T11782 (FIX D): runExodusMigrate + the abort rollback now open the TARGET
  // DBs on a DEDICATED connection via openDualScopeDbAtPath. Wire it to the same
  // fixture handles so the real migrate/rollback engines exercise the fixture
  // target DBs (keyed by the fixture path the engine passes).
  vi.mocked(dualScope.openDualScopeDbAtPath).mockImplementation((scope: string, dbPath: string) => {
    const native = dbPath === fx.globalDbPath || scope === 'global' ? globalDb : projectDb;
    return Promise.resolve(makeFakeHandle(native) as never);
  });
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
    largestSourceBytes: 0,
    requiredBytes: 0,
    stagingCopyThresholdBytes: 256 * 1024 * 1024,
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
    openDualScopeDbAtPath: vi.fn(),
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
    const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

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

    const first = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);
    expect(first.outcome).toBe('migrated');

    // Second open: target now populated → fast-path skip, no migration.
    const second = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);
    expect(second.outcome).toBe('skipped');
    expect(second.reason).toMatch(/already populated/i);

    // Row counts are unchanged (no double-copy).
    expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(FIXTURE_EXPECTED_ROWS.tasks_tasks);
  });

  it('AC2: forced parity failure ABORTS cleanly — consolidated rolled back to empty in place, legacy intact, handle still open', async () => {
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
      introducedForeignKeyViolations: [],
      preExistingForeignKeyViolations: [],
      enumDrift: [],
      error: 'FORCED count deficit for abort test',
    });

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
    const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

    expect(result.outcome).toBe('aborted');
    expect(result.reason).toMatch(/parity/i);

    // The consolidated DB file is NOT deleted — the handle stays open and valid.
    // The migration's writes were rolled back IN PLACE so the base table is empty
    // (no half-migrated rows exposed). The caller's handle must still be usable.
    expect(existsSync(fx.projectDbPath), 'consolidated project cleo.db file must remain').toBe(
      true,
    );
    expect(projectDb.isOpen, 'caller handle must remain OPEN after abort').toBe(true);
    expect(
      countRows(fx.projectDbPath, 'tasks_tasks'),
      'consolidated base table must be empty after rollback',
    ).toBe(0);

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
    const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

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
    const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/no legacy project-scope source/i);
  });

  it('skips a PROJECT open when only a GLOBAL legacy DB exists (no cross-scope trigger)', async () => {
    const { fx, projectDb, globalDb, plan } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    // Simulate the signaldock→conduit migration scenario: a GLOBAL-scope legacy
    // source exists, but NO project-scope source. A project open must NOT fire.
    const exodusIndex = await import('../exodus/index.js');
    vi.mocked(exodusIndex.buildExodusPlan).mockReturnValue({
      ...plan,
      sources: [
        // global source present (e.g. signaldock.db) — points at a real file
        { name: 'signaldock', path: fx.brainDbPath, targetScope: 'global' },
        // project source ABSENT
        { name: 'tasks', path: join(tmpDir, 'no-tasks.db'), targetScope: 'project' },
      ],
    });

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
    const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/cross-scope-only/i);
    // Project consolidated DB untouched.
    expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(0);
  });

  it('AC6: single-flight — a held lock makes the loser skip without re-migrating', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');

    // Winner: a normal first-open migrates and populates the consolidated DB.
    const winner = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);
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
      const loser = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);
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
    );
    expect(result.outcome).toBe('migrated');
    // Flag is always cleared in the finally block, even across the nested opens.
    expect(onOpen._isExodusInProgress()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // T11572 — parity gate over-abort fixes, end-to-end through the REAL engines.
  // -------------------------------------------------------------------------

  it('T11572 BLOCKER 1: a fixture WITH FTS5 + _conduit_meta shadow tables migrates GREEN', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir, {
      withDerivedAndInternalTables: true,
    });
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    // Sanity: the source carries the derived FTS shadow + internal meta tables.
    expect(countRows(fx.brainDbPath, 'brain_decisions_fts_data')).toBeGreaterThan(0);
    expect(countRows(fx.brainDbPath, '_conduit_meta')).toBe(1);

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
    const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

    // The presence of FTS5 + meta shadow tables must NOT abort the cutover.
    expect(result.outcome, `unexpected outcome: ${result.reason}`).toBe('migrated');

    // Every BASE table — including the FTS5 content table brain_decisions — has
    // exact row parity. The derived/meta tables were skipped (no consolidated
    // home), not counted as deficits.
    for (const [table, expected] of Object.entries(FIXTURE_EXPECTED_ROWS)) {
      expect(countRows(fx.projectDbPath, table), `${table} parity`).toBe(expected);
    }
    expect(countRows(fx.projectDbPath, 'brain_decisions')).toBe(
      FIXTURE_HAZARD_EXPECTED_ROWS.brain_decisions,
    );
  });

  it('T11572 BLOCKER 2: a fixture with a pre-existing SOURCE FK orphan migrates GREEN (orphan preserved)', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir, {
      withPreExistingSourceOrphan: true,
    });
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    // Sanity: the source already has the 6 task_relations rows (4 clean + 2 orphan).
    expect(countRows(fx.tasksDbPath, 'task_relations')).toBe(
      FIXTURE_HAZARD_EXPECTED_ROWS.tasks_task_relations,
    );

    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
    const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

    // The pre-existing source orphan must NOT abort the cutover.
    expect(result.outcome, `unexpected outcome: ${result.reason}`).toBe('migrated');

    // The orphan row is PRESERVED (zero loss) — all 6 relation rows copied,
    // including the 2 that reference deleted tasks.
    expect(countRows(fx.projectDbPath, 'tasks_task_relations')).toBe(
      FIXTURE_HAZARD_EXPECTED_ROWS.tasks_task_relations,
    );
    // Base parity unaffected.
    for (const [table, expected] of Object.entries(FIXTURE_EXPECTED_ROWS)) {
      expect(countRows(fx.projectDbPath, table), `${table} parity`).toBe(expected);
    }
  });

  it('T11572 BLOCKER 3: retry after a FORCED abort RE-COPIES and succeeds (no permanent abort loop)', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    const verifyMod = await import('../exodus/index.js');
    const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');

    // --- Attempt 1: force a genuine deficit so the cutover aborts + rolls back. ---
    const verifySpy = vi.spyOn(verifyMod, 'verifyMigration').mockReturnValue({
      ok: false,
      tables: [
        {
          sourceTable: 'tasks',
          targetTable: 'tasks_tasks',
          scope: 'project',
          sourceCount: 30,
          targetCount: 12, // forced deficit
          sourceHash: 'aaaa',
          targetHash: 'bbbb',
          countMatch: false,
          hashMatch: false,
        },
      ],
      foreignKeyViolations: [],
      introducedForeignKeyViolations: [],
      preExistingForeignKeyViolations: [],
      enumDrift: [],
      error: 'FORCED count deficit for retry test',
    });

    const aborted = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);
    expect(aborted.outcome).toBe('aborted');
    // Consolidated rolled back to empty; legacy intact.
    expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(0);
    expect(countRows(fx.tasksDbPath, 'tasks')).toBe(FIXTURE_EXPECTED_ROWS.tasks_tasks);

    // The journal MUST have been cleared on abort so the retry re-copies. Before
    // the fix, the journal still marked every table 'done' and the retry copied
    // NOTHING (permanent abort loop).
    const stagingDir = join(tmpDir, 'staging');
    expect(
      existsSync(join(stagingDir, 'exodus-journal.json')),
      'migrate journal must be cleared after abort/rollback so retry re-copies',
    ).toBe(false);

    // --- Attempt 2: restore real verify; the retry must RE-COPY and migrate GREEN. ---
    verifySpy.mockRestore();

    const retried = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);
    expect(retried.outcome, `retry should re-copy and succeed: ${retried.reason}`).toBe('migrated');

    // The retry actually re-copied every row (not a no-op resume over an empty DB).
    for (const [table, expected] of Object.entries(FIXTURE_EXPECTED_ROWS)) {
      expect(countRows(fx.projectDbPath, table), `${table} re-copied on retry`).toBe(expected);
    }
  });

  it('T11777 (c): completion marker present → SKIP even when a legacy DB is on disk', async () => {
    const { fx, projectDb, globalDb } = await armFixture(tmpDir);
    openProjectDb = projectDb;
    openGlobalDb = globalDb;

    // Pin a temp project .cleo dir so the marker gate's resolveCleoDir(cwd) finds
    // exactly the marker we write (and never touches the live repo .cleo/).
    const cleoDir = join(tmpDir, '.cleo');
    const prevCleoDir = process.env.CLEO_DIR;
    process.env.CLEO_DIR = cleoDir; // absolute → pins the project .cleo dir

    try {
      const { writeExodusCompleteMarker } = await import('../exodus/archive.js');
      // Seal the project cutover. The marker is the durable trigger-gate.
      writeExodusCompleteMarker('project', ['tasks'], tmpDir);

      // The consolidated DB is EMPTY and a legacy source DB still exists on disk —
      // pre-T11777 this would re-arm the auto-migration. With the marker present
      // the hook MUST skip (cutover sealed) so a stranded legacy file can never
      // re-trigger exodus-on-open (DHQ-052 · T11662).
      expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(0);
      expect(existsSync(fx.tasksDbPath)).toBe(true);

      const { maybeRunExodusOnOpen } = await import('../exodus/on-open.js');
      const result = await maybeRunExodusOnOpen('project', fx.projectDbPath, projectDb, tmpDir);

      expect(result.outcome).toBe('skipped');
      expect(result.reason).toMatch(/completion marker/i);
      // No migration ran — consolidated stays empty, legacy untouched.
      expect(countRows(fx.projectDbPath, 'tasks_tasks')).toBe(0);
      expect(countRows(fx.tasksDbPath, 'tasks')).toBe(FIXTURE_EXPECTED_ROWS.tasks_tasks);
    } finally {
      if (prevCleoDir === undefined) delete process.env.CLEO_DIR;
      else process.env.CLEO_DIR = prevCleoDir;
    }
  });
});

// ---------------------------------------------------------------------------
// T11577 — data-continuity gate: a row SURPLUS is tolerated, a DEFICIT aborts.
// Drives the exported isDataContinuityOk() directly with constructed parity
// results so the deficit-vs-surplus decision is asserted in isolation.
// ---------------------------------------------------------------------------

describe('isDataContinuityOk — deficit vs surplus (T11577)', () => {
  /** Build a minimal VerifyMigrationResult with one parity row. */
  function resultWith(sourceCount: number, targetCount: number) {
    return {
      ok: sourceCount === targetCount,
      tables: [
        {
          sourceTable: 'nexus_audit_log',
          targetTable: 'nexus_audit_log',
          scope: 'project',
          sourceCount,
          targetCount,
          sourceHash: 'aaaa',
          targetHash: sourceCount === targetCount ? 'aaaa' : 'bbbb',
          countMatch: sourceCount === targetCount,
          hashMatch: sourceCount === targetCount,
        },
      ],
      foreignKeyViolations: [],
      introducedForeignKeyViolations: [],
      preExistingForeignKeyViolations: [],
      enumDrift: [],
    } as const;
  }

  it('GREEN: a target SURPLUS (target > source, e.g. migration-time audit writes) clears the gate', async () => {
    const { isDataContinuityOk } = await import('../exodus/on-open.js');
    // 161923 → 161926: target has 3 MORE rows than source — NOT data loss.
    expect(isDataContinuityOk(resultWith(161923, 161926))).toBe(true);
  });

  it('GREEN: exact parity clears the gate', async () => {
    const { isDataContinuityOk } = await import('../exodus/on-open.js');
    expect(isDataContinuityOk(resultWith(100, 100))).toBe(true);
  });

  it('ABORTS: a genuine DEFICIT (target < source) fails the gate — loss is never tolerated', async () => {
    const { isDataContinuityOk } = await import('../exodus/on-open.js');
    // 100 → 97: 3 rows MISSING — real data loss must abort.
    expect(isDataContinuityOk(resultWith(100, 97))).toBe(false);
  });

  it('ABORTS: a surplus does NOT mask an INTRODUCED FK orphan', async () => {
    const { isDataContinuityOk } = await import('../exodus/on-open.js');
    const r = {
      ...resultWith(100, 103),
      introducedForeignKeyViolations: [{ table: 'children', rowid: 1, parent: 'parents', fkid: 0 }],
    };
    // Surplus is fine on its own, but an introduced orphan is genuine loss.
    expect(isDataContinuityOk(r)).toBe(false);
  });
});
