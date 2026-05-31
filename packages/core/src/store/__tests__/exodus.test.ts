/**
 * Unit tests for the exodus migration subsystem.
 *
 * Tests the plan builder, status reporter, and type structure without opening
 * any real DBs (relies on tmp dirs so no live data is touched).
 *
 * ## Regression tests (T11531 — attach-leak fix)
 *
 * The core regression suite builds fixture source DBs with ≥3 tables per
 * source across ≥2 source DBs, runs the migration, and asserts that EVERY row
 * from EVERY table is present in the consolidated target. It also asserts that
 * `runExodusVerify` returns `ok: false` with a populated `error` string when a
 * table is deliberately dropped from the target (catches the attach-leak class
 * permanently).
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @task T11531 (P0 attach-leak regression tests)
 * @saga T11242
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveStagingDirName, sourcesPresent } from '../exodus/plan.js';
import { runExodusStatus } from '../exodus/status.js';
import type { ExodusPlan, LegacyDbDescriptor } from '../exodus/types.js';
import { EXODUS_TARGET_SCHEMA_VERSION } from '../exodus/types.js';
import { runExodusVerify } from '../exodus/verify.js';

// ---------------------------------------------------------------------------
// SQLite helpers (DB Open Guard Gate 3 — test files may open raw for seeding)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cleo-exodus-test-'));
}

/**
 * Create a minimal SQLite DB at `path` with the given tables.
 * Each table is: `CREATE TABLE <name> (id INTEGER PRIMARY KEY, val TEXT)`.
 * Inserts `rowCount` rows with `val = '<tableName>-<i>'`.
 *
 * DB Open Guard Gate 3: allowed in test files for fixture seeding.
 */
function createSourceDb(
  path: string,
  tables: ReadonlyArray<{ readonly name: string; readonly rowCount: number }>,
): void {
  const db = new DatabaseSync(path);
  try {
    for (const { name, rowCount } of tables) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id INTEGER PRIMARY KEY, val TEXT)`);
      for (let i = 1; i <= rowCount; i++) {
        db.exec(`INSERT INTO "${name}" (id, val) VALUES (${i}, '${name}-${i}')`);
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Create a target consolidated DB at `path` with the same table schemas as
 * the sources (schema-only, no rows). The exodus migration inserts into these.
 *
 * DB Open Guard Gate 3: allowed in test files for fixture seeding.
 */
function createTargetDb(path: string, tableNames: ReadonlyArray<string>): void {
  const db = new DatabaseSync(path);
  try {
    for (const name of tableNames) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (id INTEGER PRIMARY KEY, val TEXT)`);
    }
  } finally {
    db.close();
  }
}

/**
 * Count rows in a table from the given DB file.
 *
 * DB Open Guard Gate 3: allowed in test files for assertion.
 */
function countRows(dbPath: string, tableName: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// deriveStagingDirName
// ---------------------------------------------------------------------------

describe('deriveStagingDirName', () => {
  it('returns a string starting with exodus-staging-', () => {
    const name = deriveStagingDirName();
    expect(name).toMatch(/^exodus-staging-/);
  });

  it('does not contain colons (shell-safe)', () => {
    const name = deriveStagingDirName();
    expect(name).not.toContain(':');
  });
});

// ---------------------------------------------------------------------------
// sourcesPresent
// ---------------------------------------------------------------------------

describe('sourcesPresent', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no source files exist', () => {
    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: join(tmpDir, 'tasks.db'), targetScope: 'project' },
      { name: 'brain', path: join(tmpDir, 'brain.db'), targetScope: 'project' },
    ];
    expect(sourcesPresent(sources)).toBe(false);
  });

  it('returns true when at least one source file exists', () => {
    const dbPath = join(tmpDir, 'tasks.db');
    writeFileSync(dbPath, ''); // zero-byte file is enough for existence check
    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: dbPath, targetScope: 'project' },
      { name: 'brain', path: join(tmpDir, 'brain.db'), targetScope: 'project' },
    ];
    expect(sourcesPresent(sources)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EXODUS_TARGET_SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('EXODUS_TARGET_SCHEMA_VERSION', () => {
  it('is a non-empty string containing the expected epoch', () => {
    expect(typeof EXODUS_TARGET_SCHEMA_VERSION).toBe('string');
    expect(EXODUS_TARGET_SCHEMA_VERSION.length).toBeGreaterThan(0);
    expect(EXODUS_TARGET_SCHEMA_VERSION).toContain('drizzle-v1.0.0-rc.3');
  });
});

// ---------------------------------------------------------------------------
// runExodusStatus — pure filesystem reads, no DB required
// ---------------------------------------------------------------------------

describe('runExodusStatus', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    // Simulate a minimal .cleo/ layout
    mkdirSync(join(tmpDir, '.cleo'));
    // Create a fake project-info.json so resolveCleoDir succeeds
    writeFileSync(
      join(tmpDir, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'test-exodus', projectRoot: tmpDir }),
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports no staging and no target DBs for a fresh project', () => {
    // Point status at our tmp dir
    const result = runExodusStatus(tmpDir);

    expect(result.hasStaging).toBe(false);
    expect(result.stagingDir).toBeNull();
    expect(result.journal).toBeNull();
    expect(result.projectDbExists).toBe(false);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('detects a staging directory when one exists', () => {
    const stagingName = `exodus-staging-20260101T000000Z`;
    mkdirSync(join(tmpDir, '.cleo', stagingName));

    const result = runExodusStatus(tmpDir);

    expect(result.hasStaging).toBe(true);
    expect(result.stagingDir).toContain(stagingName);
  });

  it('reads a journal from an existing staging dir', () => {
    const stagingName = `exodus-staging-20260101T000000Z`;
    const stagingDir = join(tmpDir, '.cleo', stagingName);
    mkdirSync(stagingDir);

    const journal = {
      version: 1 as const,
      cleoVersion: '2026.5.0',
      targetSchemaVersion: EXODUS_TARGET_SCHEMA_VERSION,
      nodeVersion: process.version,
      sqliteVersion: '3.53.0',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tables: [],
    };
    writeFileSync(join(stagingDir, 'exodus-journal.json'), JSON.stringify(journal));

    const result = runExodusStatus(tmpDir);

    expect(result.journal).not.toBeNull();
    expect(result.journal?.version).toBe(1);
    expect(result.journal?.cleoVersion).toBe('2026.5.0');
  });
});

// ---------------------------------------------------------------------------
// Type-level smoke test — ExodusPlan shape
// ---------------------------------------------------------------------------

describe('ExodusPlan type shape', () => {
  it('satisfies the required fields', () => {
    // Just ensure the type compiles with a minimal shape — no runtime assertion needed
    const plan: ExodusPlan = {
      sources: [],
      totalSourceBytes: 0,
      availableBytes: 1_000_000,
      diskPreflight: true,
      stagingDir: '/tmp/exodus-staging-20260101T000000Z',
      resumeFromStaging: false,
      projectDbPath: '/tmp/proj/.cleo/cleo.db',
      globalDbPath: '/home/user/.local/share/cleo/cleo.db',
    };
    expect(plan.diskPreflight).toBe(true);
    expect(plan.sources).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T11531 REGRESSION — runExodusVerify parity gate
//
// These tests do NOT require mocking openDualScopeDb. They directly test the
// verify engine with hand-crafted fixtures: source DBs with known row counts
// and target DBs seeded to expected (or intentionally wrong) states.
// ---------------------------------------------------------------------------

describe('T11531 regression — runExodusVerify parity gate', () => {
  let tmpDir: string;
  let sourceAPath: string;
  let sourceBPath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;

  // Fixture layout:
  //   sourceA (project-scope): tables alpha, beta, gamma — 10, 20, 30 rows
  //   sourceB (project-scope): tables delta, epsilon, zeta — 5, 15, 25 rows
  //   targetProject:           all 6 tables (pre-seeded per-test)
  //   targetGlobal:            empty DB (no global sources in this fixture)
  const SOURCE_A_TABLES = [
    { name: 'alpha', rowCount: 10 },
    { name: 'beta', rowCount: 20 },
    { name: 'gamma', rowCount: 30 },
  ] as const;
  const SOURCE_B_TABLES = [
    { name: 'delta', rowCount: 5 },
    { name: 'epsilon', rowCount: 15 },
    { name: 'zeta', rowCount: 25 },
  ] as const;
  const ALL_TABLES = [...SOURCE_A_TABLES, ...SOURCE_B_TABLES];

  const SOURCES: LegacyDbDescriptor[] = []; // populated in beforeEach

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourceAPath = join(tmpDir, 'sourceA.db');
    sourceBPath = join(tmpDir, 'sourceB.db');
    targetProjectPath = join(tmpDir, 'cleo-project.db');
    targetGlobalPath = join(tmpDir, 'cleo-global.db');

    // Create source fixture DBs with known row counts
    createSourceDb(sourceAPath, SOURCE_A_TABLES);
    createSourceDb(sourceBPath, SOURCE_B_TABLES);

    // Create empty target DBs with the right schema
    createTargetDb(
      targetProjectPath,
      ALL_TABLES.map((t) => t.name),
    );
    createTargetDb(targetGlobalPath, []);

    // Populate SOURCES array (clear first to avoid cross-test bleed)
    SOURCES.length = 0;
    SOURCES.push(
      { name: 'sourceA', path: sourceAPath, targetScope: 'project' },
      { name: 'sourceB', path: sourceBPath, targetScope: 'project' },
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok:true when all row counts match source (perfect migration)', () => {
    // Seed target with exact source row counts (simulates a successful migration)
    const projDb = new DatabaseSync(targetProjectPath);
    try {
      for (const { name, rowCount } of ALL_TABLES) {
        for (let i = 1; i <= rowCount; i++) {
          projDb.exec(`INSERT OR IGNORE INTO "${name}" (id, val) VALUES (${i}, '${name}-${i}')`);
        }
      }
    } finally {
      projDb.close();
    }

    const result = runExodusVerify(SOURCES, targetProjectPath, targetGlobalPath, undefined);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    for (const t of result.tables) {
      expect(t.countMatch, `${t.tableName} must match`).toBe(true);
    }
  });

  it('returns ok:false with populated error when a non-empty source table has 0 rows in target (attach-leak class)', () => {
    // Seed all tables correctly EXCEPT 'beta' — simulates data loss from the
    // attach-leak bug where all-but-first tables of a source were silently dropped.
    const projDb = new DatabaseSync(targetProjectPath);
    try {
      for (const { name, rowCount } of ALL_TABLES) {
        if (name === 'beta') continue; // simulate data loss
        for (let i = 1; i <= rowCount; i++) {
          projDb.exec(`INSERT OR IGNORE INTO "${name}" (id, val) VALUES (${i}, '${name}-${i}')`);
        }
      }
    } finally {
      projDb.close();
    }

    const result = runExodusVerify(SOURCES, targetProjectPath, targetGlobalPath, undefined);

    // Must be a hard failure — not just ok:false with undefined error
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
    // The error string must name the failing table
    expect(result.error).toContain('beta');

    const betaEntry = result.tables.find((t) => t.tableName === 'beta');
    expect(betaEntry).toBeDefined();
    expect(betaEntry!.countMatch).toBe(false);
    expect(betaEntry!.sourceCount).toBe(20);
    expect(betaEntry!.targetCount).toBe(0);
  });

  it('returns ok:false when multiple source tables are missing rows (full attach-leak simulation)', () => {
    // Only copy the first table from each source (as the buggy attach-leak would do)
    const projDb = new DatabaseSync(targetProjectPath);
    try {
      // Only 'alpha' (first of sourceA) and 'delta' (first of sourceB) get rows
      for (const { name } of [SOURCE_A_TABLES[0], SOURCE_B_TABLES[0]]) {
        const table = ALL_TABLES.find((t) => t.name === name)!;
        for (let i = 1; i <= table.rowCount; i++) {
          projDb.exec(`INSERT OR IGNORE INTO "${name}" (id, val) VALUES (${i}, '${name}-${i}')`);
        }
      }
    } finally {
      projDb.close();
    }

    const result = runExodusVerify(SOURCES, targetProjectPath, targetGlobalPath, undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();

    // All 4 skipped tables (beta, gamma, epsilon, zeta) must appear as failures
    const failingTables = result.tables.filter((t) => !t.countMatch);
    expect(failingTables.length).toBeGreaterThanOrEqual(4);

    // Each failing table must be referenced in the error string
    for (const ft of failingTables) {
      if (ft.sourceCount > 0) {
        expect(result.error, `error must mention ${ft.tableName}`).toContain(ft.tableName);
      }
    }
  });

  it('returns ok:false when a source table is entirely absent from the target', () => {
    // Seed all tables except drop 'delta' entirely from target schema
    const projDb = new DatabaseSync(targetProjectPath);
    try {
      for (const { name, rowCount } of ALL_TABLES) {
        for (let i = 1; i <= rowCount; i++) {
          projDb.exec(`INSERT OR IGNORE INTO "${name}" (id, val) VALUES (${i}, '${name}-${i}')`);
        }
      }
      projDb.exec(`DROP TABLE IF EXISTS "delta"`);
    } finally {
      projDb.close();
    }

    const result = runExodusVerify(SOURCES, targetProjectPath, targetGlobalPath, undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('delta');

    const deltaEntry = result.tables.find((t) => t.tableName === 'delta');
    expect(deltaEntry).toBeDefined();
    expect(deltaEntry!.countMatch).toBe(false);
    expect(deltaEntry!.sourceCount).toBe(5); // sourceB has 5 rows in delta
    expect(deltaEntry!.targetCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// T11531 REGRESSION — runExodusMigrate attach-once
//
// Tests that the migration engine copies ALL rows from ALL tables across
// multiple source DBs without the attach-leak. This uses a direct mock of
// openDualScopeDb so we can inject pre-built target DBs.
// ---------------------------------------------------------------------------

describe('T11531 regression — runExodusMigrate copies all tables from all sources', () => {
  let tmpDir: string;
  let sourceAPath: string;
  let sourceBPath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  const SOURCE_A_TABLES = [
    { name: 'tbl_a1', rowCount: 7 },
    { name: 'tbl_a2', rowCount: 13 },
    { name: 'tbl_a3', rowCount: 19 },
  ] as const;
  const SOURCE_B_TABLES = [
    { name: 'tbl_b1', rowCount: 3 },
    { name: 'tbl_b2', rowCount: 11 },
    { name: 'tbl_b3', rowCount: 17 },
  ] as const;
  const ALL_TABLES = [...SOURCE_A_TABLES, ...SOURCE_B_TABLES];

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourceAPath = join(tmpDir, 'sourceA.db');
    sourceBPath = join(tmpDir, 'sourceB.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });

    createSourceDb(sourceAPath, SOURCE_A_TABLES);
    createSourceDb(sourceBPath, SOURCE_B_TABLES);
    createTargetDb(
      targetProjectPath,
      ALL_TABLES.map((t) => t.name),
    );
    createTargetDb(targetGlobalPath, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('migrates all rows from all tables across 2 source DBs (attach-once regression)', async () => {
    // Import runExodusMigrate dynamically so we can inject the mock before import
    // (vi.doMock affects subsequent dynamic imports in the same test).
    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    // Build fake Drizzle-like handles that expose $client
    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        // Do NOT close the underlying DB here — we need it open for assertions.
        // The test's afterEach handles cleanup.
      },
    });

    vi.mock('../dual-scope-db.js', () => ({
      openDualScopeDb: vi.fn(),
      resolveDualScopeDbPath: vi.fn(),
    }));

    const dualScopeModule = await import('../dual-scope-db.js');
    vi.mocked(dualScopeModule.openDualScopeDb).mockImplementation((scope: string) => {
      if (scope === 'project') return Promise.resolve(makeFakeHandle(targetProjectDb) as never);
      return Promise.resolve(makeFakeHandle(targetGlobalDb) as never);
    });
    vi.mocked(dualScopeModule.resolveDualScopeDbPath).mockImplementation((scope: string) =>
      scope === 'project' ? targetProjectPath : targetGlobalPath,
    );

    const { runExodusMigrate: migrate } = await import('../exodus/migrate.js');

    const sources: LegacyDbDescriptor[] = [
      { name: 'sourceA', path: sourceAPath, targetScope: 'project' },
      { name: 'sourceB', path: sourceBPath, targetScope: 'project' },
    ];

    const plan: ExodusPlan = {
      sources,
      totalSourceBytes: 0,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath: targetProjectPath,
      globalDbPath: targetGlobalPath,
    };

    const result = await migrate(plan, false, undefined);

    expect(result.ok).toBe(true);

    // PRIMARY ASSERTION: every row from every table must be in the target
    for (const { name, rowCount } of ALL_TABLES) {
      const countInTarget = countRows(targetProjectPath, name);
      expect(
        countInTarget,
        `Table '${name}': expected ${rowCount} rows in target, got ${countInTarget} — attach-leak regression`,
      ).toBe(rowCount);
    }

    // No table should be skipped (the attach-leak caused tables 2+ to be skipped)
    const skipped = result.tables.filter((t) => t.skipped);
    expect(
      skipped,
      `Tables skipped (attach-leak regression): ${skipped.map((t) => `${t.sourceDb}.${t.tableName}`).join(', ')}`,
    ).toHaveLength(0);

    targetProjectDb.close();
    targetGlobalDb.close();
  });
});
