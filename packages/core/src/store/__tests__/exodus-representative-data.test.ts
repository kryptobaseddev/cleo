/**
 * Real-data parity gate — end-to-end exodus migrate + verifyMigration against a
 * SCHEMA-REAL representative fixture (T11551 · DHQ-045 · AC3).
 *
 * This is the durable regression guard for the exodus zero-loss campaign. It
 * runs the ACTUAL `runExodusMigrate` engine over a fixture with REAL production
 * hazards — epoch-INTEGER timestamps into ISO-GLOB columns, legacy enum aliases
 * that fail target CHECK constraints, unprefixed→prefixed table names, and a
 * self-referential FK copied child-before-parent — then asserts via
 * `verifyMigration` that EVERY base-table row survived with ZERO deficit.
 *
 * If a future change regresses the coercion/normalisation layer, the migration
 * will silently drop rows (the original ~805K-row failure mode) and this test
 * will fail with a populated parity error.
 *
 * @task T11551 (DHQ-045 — exodus zero-loss durable guard · AC3)
 * @epic T10878
 * @saga T11242
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

function countRows(dbPath: string, table: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

describe('exodus real-data parity gate (T11551 · DHQ-045)', () => {
  let tmpDir: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-exodus-repr-'));
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('migrates ALL rows from a schema-real fixture with ZERO base-table deficit', async () => {
    const fx = buildRepresentativeFixture(tmpDir);

    // Inject the pre-built target DBs the way the migrate engine expects.
    const projectDb = new DatabaseSync(fx.projectDbPath);
    const globalDb = new DatabaseSync(fx.globalDbPath);
    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open for assertions */
      },
    });

    vi.mock('../dual-scope-db.js', () => ({
      openDualScopeDb: vi.fn(),
      openDualScopeDbAtPath: vi.fn(),
      resolveDualScopeDbPath: vi.fn(),
    }));
    const dualScope = await import('../dual-scope-db.js');
    vi.mocked(dualScope.openDualScopeDb).mockImplementation((scope: string) =>
      scope === 'project'
        ? Promise.resolve(makeFakeHandle(projectDb) as never)
        : Promise.resolve(makeFakeHandle(globalDb) as never),
    );
    // T11782 (FIX D): runExodusMigrate opens the TARGET DBs on a dedicated
    // connection via openDualScopeDbAtPath. Wire it to the fixture handles
    // (keyed by the fixture path the engine passes).
    vi.mocked(dualScope.openDualScopeDbAtPath).mockImplementation(
      (scope: string, dbPath: string) => {
        const native = dbPath === fx.globalDbPath || scope === 'global' ? globalDb : projectDb;
        return Promise.resolve(makeFakeHandle(native) as never);
      },
    );
    vi.mocked(dualScope.resolveDualScopeDbPath).mockImplementation((scope: string) =>
      scope === 'project' ? fx.projectDbPath : fx.globalDbPath,
    );

    const { runExodusMigrate } = await import('../exodus/migrate.js');
    const { verifyMigration } = await import('../exodus/verify-migration.js');

    // The brain source uses the 'brain (project)' descriptor name so its tables
    // map by identity (already domain-prefixed) into the project-scope target.
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
      stagingDir,
      resumeFromStaging: false,
      projectDbPath: fx.projectDbPath,
      globalDbPath: fx.globalDbPath,
    };

    const migrateResult = await runExodusMigrate(plan, false, undefined);
    expect(
      migrateResult.ok,
      `migrate failed: ${migrateResult.error ?? ''}\n` +
        migrateResult.tables
          .filter((t) => t.reason)
          .map((t) => `  ${t.tableName}: ${t.reason}`)
          .join('\n'),
    ).toBe(true);

    // No table may report a data-loss reason (no-swallow assertion path).
    const lossyTables = migrateResult.tables.filter((t) => t.reason && !t.skipped);
    expect(
      lossyTables,
      `tables reported row drops: ${lossyTables.map((t) => `${t.tableName}: ${t.reason}`).join('; ')}`,
    ).toHaveLength(0);

    // PRIMARY ASSERTION: exact base-table row parity — zero deficit.
    for (const [table, expected] of Object.entries(FIXTURE_EXPECTED_ROWS)) {
      const got = countRows(fx.projectDbPath, table);
      expect(got, `${table}: expected ${expected} rows after migration, got ${got}`).toBe(expected);
    }

    // verifyMigration must independently confirm parity (count + checksum + FK +
    // enum drift). After a correct migration there is NO residual enum drift
    // (everything was normalised) and NO base-table deficit.
    const verify = verifyMigration(sources, fx.projectDbPath, fx.globalDbPath);

    // Base-table count parity is the gate: every fixture table must match.
    for (const table of Object.keys(FIXTURE_EXPECTED_ROWS)) {
      const entry = verify.tables.find((t) => t.targetTable === table);
      expect(entry, `verifyMigration missing entry for ${table}`).toBeDefined();
      expect(entry?.countMatch, `${table} count parity`).toBe(true);
    }
    // No referential orphans introduced by the migration.
    expect(
      verify.foreignKeyViolations,
      `FK orphans: ${JSON.stringify(verify.foreignKeyViolations)}`,
    ).toHaveLength(0);

    projectDb.close();
    globalDb.close();
  });
});
