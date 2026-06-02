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
import { resolveConsolidatedTableName } from '../exodus/table-name-map.js';
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

// ---------------------------------------------------------------------------
// T11532 REGRESSION — name-mapping + column-drift + verify rowid fix
//
// These tests specifically cover the three root causes identified in T11532:
//
//   ROOT CAUSE 1: legacy unprefixed source table ('tasks') → prefixed target
//                 ('tasks_tasks'). Without the mapping, INSERT copies 0 rows.
//   ROOT CAUSE 2: target has extra column source lacks ('extra_col'). Without
//                 intersection copy, the INSERT fails with "no such column".
//   ROOT CAUSE 3: verify crashes with 'no such column: rowid' on WITHOUT ROWID
//                 tables before reporting any mismatches (safety net broken).
//
// The migration test uses the SAME mock-openDualScopeDb pattern as T11531.
// The verify test is direct (no mock needed — uses hand-crafted fixture DBs).
// ---------------------------------------------------------------------------

/**
 * Create a source DB with an UNPREFIXED table and a target DB with the
 * corresponding PREFIXED table that also has an EXTRA column.
 *
 * This exercises both ROOT CAUSE 1 (name-mapping) and ROOT CAUSE 2 (column
 * drift) in a single fixture.
 *
 * DB Open Guard Gate 3: allowed in test files for fixture seeding.
 */
function createNameMappingFixture(
  sourcePath: string,
  targetPath: string,
  legacyName: string,
  consolidatedName: string,
  rowCount: number,
): void {
  // Source: legacy unprefixed table
  const src = new DatabaseSync(sourcePath);
  try {
    src.exec(`CREATE TABLE "${legacyName}" (id INTEGER PRIMARY KEY, val TEXT)`);
    for (let i = 1; i <= rowCount; i++) {
      src.exec(`INSERT INTO "${legacyName}" VALUES (${i}, 'row-${i}')`);
    }
  } finally {
    src.close();
  }

  // Target: consolidated prefixed table WITH an extra column the source lacks
  const tgt = new DatabaseSync(targetPath);
  try {
    tgt.exec(
      `CREATE TABLE "${consolidatedName}" (id INTEGER PRIMARY KEY, val TEXT, extra_col TEXT DEFAULT NULL)`,
    );
  } finally {
    tgt.close();
  }
}

describe('T11532 regression — resolveConsolidatedTableName (name-mapping unit tests)', () => {
  it('maps tasks.db unprefixed table to tasks_ prefix', () => {
    expect(resolveConsolidatedTableName('tasks', 'tasks')).toEqual({
      kind: 'mapped',
      targetName: 'tasks_tasks',
    });
    expect(resolveConsolidatedTableName('tasks', 'commit_files')).toEqual({
      kind: 'mapped',
      targetName: 'tasks_commit_files',
    });
    expect(resolveConsolidatedTableName('tasks', 'sessions')).toEqual({
      kind: 'mapped',
      targetName: 'tasks_sessions',
    });
  });

  it('maps conduit.db unprefixed tables to conduit_ prefix', () => {
    expect(resolveConsolidatedTableName('conduit', 'messages')).toEqual({
      kind: 'mapped',
      targetName: 'conduit_messages',
    });
  });

  it('maps brain.db already-prefixed tables to themselves (identity)', () => {
    expect(resolveConsolidatedTableName('brain (project)', 'brain_observations')).toEqual({
      kind: 'mapped',
      targetName: 'brain_observations',
    });
    expect(resolveConsolidatedTableName('brain (project)', 'brain_patterns')).toEqual({
      kind: 'mapped',
      targetName: 'brain_patterns',
    });
  });

  it('maps brain.db sticky_tags to brain_sticky_tags (lost prefix case)', () => {
    expect(resolveConsolidatedTableName('brain (project)', 'sticky_tags')).toEqual({
      kind: 'mapped',
      targetName: 'brain_sticky_tags',
    });
  });

  it('maps brain_usage_log → brain_usage_log (T11546: now in consolidated schema, no longer orphan)', () => {
    // T11546: brain_usage_log was previously null (skip) because it wasn't Drizzle-managed.
    // Added to cleo-shared/brain.ts + migration 20260531000002 so 8471 rows can be migrated.
    const r = resolveConsolidatedTableName('brain (project)', 'brain_usage_log');
    expect(r.kind).toBe('mapped');
    if (r.kind === 'mapped') {
      expect(r.targetName).toBe('brain_usage_log');
    }
  });

  it('returns skip for brain_embeddings (vec0 virtual table)', () => {
    const r = resolveConsolidatedTableName('brain (project)', 'brain_embeddings');
    expect(r.kind).toBe('skip');
  });

  it('maps nexus.db unprefixed tables to nexus_ prefix', () => {
    expect(resolveConsolidatedTableName('nexus', 'project_registry')).toEqual({
      kind: 'mapped',
      targetName: 'nexus_project_registry',
    });
    expect(resolveConsolidatedTableName('nexus', 'user_profile')).toEqual({
      kind: 'mapped',
      targetName: 'nexus_user_profile',
    });
  });

  it('maps nexus.db already-prefixed tables to themselves (identity)', () => {
    expect(resolveConsolidatedTableName('nexus', 'nexus_audit_log')).toEqual({
      kind: 'mapped',
      targetName: 'nexus_audit_log',
    });
    expect(resolveConsolidatedTableName('nexus', 'nexus_nodes')).toEqual({
      kind: 'mapped',
      targetName: 'nexus_nodes',
    });
  });

  it('maps signaldock.db sessions to agent_registry_sessions (not tasks_sessions)', () => {
    // disambiguation: signaldock.db has its own 'sessions' table
    expect(resolveConsolidatedTableName('signaldock', 'sessions')).toEqual({
      kind: 'mapped',
      targetName: 'agent_registry_sessions',
    });
  });

  it('maps tasks.db attachments to docs_attachments (not conduit_attachments)', () => {
    // disambiguation: tasks.db has 'attachments' from attachments.ts → docs_attachments
    expect(resolveConsolidatedTableName('tasks', 'attachments')).toEqual({
      kind: 'mapped',
      targetName: 'docs_attachments',
    });
  });

  it('maps conduit.db attachments to conduit_attachments', () => {
    // disambiguation: conduit.db has its own 'attachments' → conduit_attachments
    expect(resolveConsolidatedTableName('conduit', 'attachments')).toEqual({
      kind: 'mapped',
      targetName: 'conduit_attachments',
    });
  });

  it('maps skills.db tables to skills_ prefix', () => {
    expect(resolveConsolidatedTableName('skills', 'skills')).toEqual({
      kind: 'mapped',
      targetName: 'skills_skills',
    });
    expect(resolveConsolidatedTableName('skills', 'skill_usage')).toEqual({
      kind: 'mapped',
      targetName: 'skills_skill_usage',
    });
  });
});

describe('T11532 regression — runExodusMigrate: unprefixed source → prefixed target + column drift', () => {
  let tmpDir: string;
  let sourceTasksPath: string;
  let sourceConduitPath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourceTasksPath = join(tmpDir, 'tasks.db');
    sourceConduitPath = join(tmpDir, 'conduit.db');
    targetProjectPath = join(tmpDir, 'cleo-project.db');
    targetGlobalPath = join(tmpDir, 'cleo-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('copies unprefixed source table to prefixed target AND tolerates target extra column', async () => {
    // Source 'tasks' DB: table 'tasks' (unprefixed, 50 rows)
    // Target: table 'tasks_tasks' WITH extra_col the source lacks
    //         table 'conduit_messages' for conduit source
    createNameMappingFixture(sourceTasksPath, targetProjectPath, 'tasks', 'tasks_tasks', 50);

    // Also add conduit_messages to the target and conduit source
    {
      const tgt = new DatabaseSync(targetProjectPath);
      try {
        tgt.exec(
          `CREATE TABLE IF NOT EXISTS "conduit_messages" (id INTEGER PRIMARY KEY, val TEXT, extra_col TEXT DEFAULT NULL)`,
        );
      } finally {
        tgt.close();
      }
    }
    createSourceDb(sourceConduitPath, [{ name: 'messages', rowCount: 30 }]);
    createTargetDb(targetGlobalPath, []);

    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open for assertions */
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
      { name: 'tasks', path: sourceTasksPath, targetScope: 'project' },
      { name: 'conduit', path: sourceConduitPath, targetScope: 'project' },
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

    // PRIMARY ASSERTION (ROOT CAUSE 1 + 2):
    // 'tasks' (legacy) → 'tasks_tasks' (consolidated) — ALL 50 rows must be present
    const tasksTasksCount = countRows(targetProjectPath, 'tasks_tasks');
    expect(
      tasksTasksCount,
      `ROOT CAUSE 1+2: 'tasks' → 'tasks_tasks': expected 50 rows, got ${tasksTasksCount}`,
    ).toBe(50);

    // 'messages' (legacy conduit) → 'conduit_messages' (consolidated) — 30 rows
    const conduitMsgCount = countRows(targetProjectPath, 'conduit_messages');
    expect(
      conduitMsgCount,
      `ROOT CAUSE 1+2: 'messages' → 'conduit_messages': expected 30 rows, got ${conduitMsgCount}`,
    ).toBe(30);

    targetProjectDb.close();
    targetGlobalDb.close();
  });
});

describe('T11532 regression — runExodusVerify: does NOT crash on name-mapped tables + fails loudly on shortfall', () => {
  let tmpDir: string;
  let sourceTasksPath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourceTasksPath = join(tmpDir, 'tasks.db');
    targetProjectPath = join(tmpDir, 'cleo-project.db');
    targetGlobalPath = join(tmpDir, 'cleo-global.db');

    // Source: tasks.db with 'tasks' table (100 rows)
    createSourceDb(sourceTasksPath, [{ name: 'tasks', rowCount: 100 }]);

    // Target: consolidated 'tasks_tasks' table with SAME schema as source
    // (same columns: id INTEGER PRIMARY KEY, val TEXT).
    // Note: column drift (extra_col) is tested in the migrate test — verify
    // checks count + hash parity using whatever columns exist in both DBs.
    const tgt = new DatabaseSync(targetProjectPath);
    try {
      tgt.exec(`CREATE TABLE "tasks_tasks" (id INTEGER PRIMARY KEY, val TEXT)`);
    } finally {
      tgt.close();
    }

    createTargetDb(targetGlobalPath, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns ok:true when prefixed target has all rows (name-mapping verify regression)', () => {
    // Seed tasks_tasks with all 100 rows — identical content to source
    const tgt = new DatabaseSync(targetProjectPath);
    try {
      for (let i = 1; i <= 100; i++) {
        // Use same val pattern as createSourceDb: '<tableName>-<i>'
        tgt.exec(`INSERT INTO "tasks_tasks" (id, val) VALUES (${i}, 'tasks-${i}')`);
      }
    } finally {
      tgt.close();
    }

    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: sourceTasksPath, targetScope: 'project' },
    ];

    const result = runExodusVerify(sources, targetProjectPath, targetGlobalPath, undefined);

    expect(result.ok, `verify must pass when all rows present: ${result.error ?? ''}`).toBe(true);
    expect(result.error).toBeUndefined();

    const tasksEntry = result.tables.find((t) => t.tableName === 'tasks_tasks');
    expect(tasksEntry, 'verify result must include tasks_tasks entry').toBeDefined();
    expect(tasksEntry?.countMatch).toBe(true);
    expect(tasksEntry?.sourceCount).toBe(100);
    expect(tasksEntry?.targetCount).toBe(100);
  });

  it('returns ok:false with error when prefixed target is empty (ROOT CAUSE 1 verify catches data loss)', () => {
    // Target tasks_tasks intentionally left empty (simulates the pre-fix bug
    // where 'tasks' rows were never copied because no name-mapping existed)
    const sources: LegacyDbDescriptor[] = [
      { name: 'tasks', path: sourceTasksPath, targetScope: 'project' },
    ];

    const result = runExodusVerify(sources, targetProjectPath, targetGlobalPath, undefined);

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    // Error must mention the consolidated table name, not the legacy name
    expect(result.error).toContain('tasks_tasks');

    const entry = result.tables.find((t) => t.tableName === 'tasks_tasks');
    expect(entry?.countMatch).toBe(false);
    expect(entry?.sourceCount).toBe(100);
    expect(entry?.targetCount).toBe(0);
  });
});

describe('T11532 regression — computeTableDigest does NOT crash on WITHOUT ROWID tables', () => {
  let tmpDir: string;
  let dbPath: string;
  let targetGlobalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    dbPath = join(tmpDir, 'source.db');
    targetGlobalPath = join(tmpDir, 'global.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('verify succeeds for a WITHOUT ROWID source table (ROOT CAUSE 3 rowid crash fix)', () => {
    // Create a WITHOUT ROWID source table
    const srcDb = new DatabaseSync(dbPath);
    try {
      srcDb.exec(
        `CREATE TABLE "no_rowid_table" (key TEXT NOT NULL, val TEXT, PRIMARY KEY (key)) WITHOUT ROWID`,
      );
      srcDb.exec(`INSERT INTO "no_rowid_table" VALUES ('k1', 'v1')`);
      srcDb.exec(`INSERT INTO "no_rowid_table" VALUES ('k2', 'v2')`);
    } finally {
      srcDb.close();
    }

    // Target consolidated DB with a matching table (same name for this test
    // since we're only testing the rowid fix, not the mapping fix)
    const tgtProjectPath = join(tmpDir, 'project.db');
    const tgt = new DatabaseSync(tgtProjectPath);
    try {
      tgt.exec(
        `CREATE TABLE "no_rowid_table" (key TEXT NOT NULL, val TEXT, PRIMARY KEY (key)) WITHOUT ROWID`,
      );
      tgt.exec(`INSERT INTO "no_rowid_table" VALUES ('k1', 'v1')`);
      tgt.exec(`INSERT INTO "no_rowid_table" VALUES ('k2', 'v2')`);
    } finally {
      tgt.close();
    }

    createTargetDb(targetGlobalPath, []);

    const sources: LegacyDbDescriptor[] = [{ name: 'tasks', path: dbPath, targetScope: 'project' }];

    // This must NOT throw "no such column: rowid"
    let result: ReturnType<typeof runExodusVerify>;
    expect(() => {
      result = runExodusVerify(sources, tgtProjectPath, targetGlobalPath, undefined);
    }).not.toThrow();

    // After the fix it should correctly detect both rows as present in target
    // (the 'no_rowid_table' maps through identity since it's not in TASKS_DB_MAP,
    //  so kind=mapped, targetName='no_rowid_table')
    expect(result!.ok).toBe(true);
    const entry = result!.tables.find((t) => t.tableName === 'no_rowid_table');
    expect(entry?.countMatch).toBe(true);
    expect(entry?.sourceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// T11533 REGRESSION — FK-defer + NOT NULL coalesce + signaldock skills +
//                     column-intersection digest
// ---------------------------------------------------------------------------

/**
 * Create a source DB with a PARENT table and a CHILD table that has a FK
 * reference to the parent. Rows are inserted parent-first (correct order).
 *
 * The target DB schema has the same tables. When FK enforcement is ON during
 * copy and the child is copied before the parent (or at the same time), the
 * INSERT fails with "FOREIGN KEY constraint failed" and drops the child rows.
 * With FK-defer (T11533), all rows survive regardless of copy order.
 *
 * DB Open Guard Gate 3: allowed in test files for fixture seeding.
 */
function createFkFixture(
  sourcePath: string,
  targetPath: string,
  parentRowCount: number,
  childRowCount: number,
): void {
  // Source: parent table + child table with FK
  const src = new DatabaseSync(sourcePath);
  try {
    src.exec('PRAGMA foreign_keys = ON');
    src.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    src.exec(`CREATE TABLE "children" (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES "parents"(id),
      val TEXT
    )`);
    for (let i = 1; i <= parentRowCount; i++) {
      src.exec(`INSERT INTO "parents" (id, name) VALUES (${i}, 'parent-${i}')`);
    }
    for (let i = 1; i <= childRowCount; i++) {
      const parentId = ((i - 1) % parentRowCount) + 1;
      src.exec(
        `INSERT INTO "children" (id, parent_id, val) VALUES (${i}, ${parentId}, 'child-${i}')`,
      );
    }
  } finally {
    src.close();
  }

  // Target: same schema but empty (migration fills it)
  const tgt = new DatabaseSync(targetPath);
  try {
    tgt.exec('PRAGMA foreign_keys = ON');
    tgt.exec(`CREATE TABLE "parents" (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`);
    tgt.exec(`CREATE TABLE "children" (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES "parents"(id),
      val TEXT
    )`);
  } finally {
    tgt.close();
  }
}

describe('T11533 regression — FK-defer: child rows survive when copied before parent', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  const PARENT_ROWS = 5;
  const CHILD_ROWS = 20;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'tasks.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });

    createFkFixture(sourcePath, targetProjectPath, PARENT_ROWS, CHILD_ROWS);
    createTargetDb(targetGlobalPath, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('migrates all child rows even with FK ON in target schema (FK-defer regression)', async () => {
    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open for assertions */
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

    // Use source name 'sourceA' (unrecognized → identity mapping) so tables
    // 'parents' and 'children' map to themselves (identity fallback).
    const sources: LegacyDbDescriptor[] = [
      { name: 'sourceA', path: sourcePath, targetScope: 'project' },
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

    // PRIMARY ASSERTION: ALL parent and child rows must survive despite FK constraints.
    const parentCount = countRows(targetProjectPath, 'parents');
    const childCount = countRows(targetProjectPath, 'children');
    expect(
      parentCount,
      `FK-defer regression: expected ${PARENT_ROWS} parent rows, got ${parentCount}`,
    ).toBe(PARENT_ROWS);
    expect(
      childCount,
      `FK-defer regression: expected ${CHILD_ROWS} child rows, got ${childCount} — children dropped due to FK constraint`,
    ).toBe(CHILD_ROWS);

    targetProjectDb.close();
    targetGlobalDb.close();
  });
});

describe('T11533 regression — NOT NULL coalesce: rows with NULL in target-only NOT NULL columns survive', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'tasks.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    createTargetDb(targetGlobalPath, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('copies all rows even when source has NULL for a target-only NOT NULL column (COALESCE fix)', async () => {
    // Source: table with id + val columns only
    // Target: same table with id + val + required_col (NOT NULL, no default)
    // Source rows have val=NULL for some rows — these would be silently dropped
    // by INSERT OR IGNORE if required_col had no COALESCE treatment.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "tbl" (id INTEGER PRIMARY KEY, val TEXT)`);
      // Insert 10 rows: 5 with val=NULL (would fail NOT NULL if val were the constrained col)
      for (let i = 1; i <= 10; i++) {
        if (i % 2 === 0) {
          src.exec(`INSERT INTO "tbl" (id, val) VALUES (${i}, NULL)`);
        } else {
          src.exec(`INSERT INTO "tbl" (id, val) VALUES (${i}, 'val-${i}')`);
        }
      }
    } finally {
      src.close();
    }

    // Target: same table with an EXTRA required_col NOT NULL (no default)
    const tgt = new DatabaseSync(targetProjectPath);
    try {
      tgt.exec(`CREATE TABLE "tbl" (id INTEGER PRIMARY KEY, val TEXT, required_col TEXT NOT NULL)`);
    } finally {
      tgt.close();
    }

    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open */
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
      { name: 'sourceA', path: sourcePath, targetScope: 'project' },
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

    // PRIMARY ASSERTION: ALL 10 rows must be in the target.
    // Before fix, rows with val=NULL would be silently dropped by INSERT OR IGNORE
    // because required_col NOT NULL without a source value would cause a violation.
    // With COALESCE fix, the intersection only copies shared columns (id, val),
    // and required_col gets its NOT NULL obligation from the COALESCE('') default.
    const rowCount = countRows(targetProjectPath, 'tbl');
    expect(
      rowCount,
      `NOT NULL coalesce regression: expected 10 rows, got ${rowCount} — rows with NULL val were silently dropped`,
    ).toBe(10);

    targetProjectDb.close();
    targetGlobalDb.close();
  });
});

describe('T11533 regression — resolveConsolidatedTableName: signaldock skills mapping', () => {
  it('maps signaldock.db skills → agent_registry_skills (not identity fallback)', () => {
    // Before T11533 fix: 'skills' was not in SIGNALDOCK_DB_MAP → identity fallback
    // → 'skills' absent in global cleo.db → 0 rows. After fix: maps to 'agent_registry_skills'.
    expect(resolveConsolidatedTableName('signaldock', 'skills')).toEqual({
      kind: 'mapped',
      targetName: 'agent_registry_skills',
    });
  });

  it('maps signaldock.db capabilities → agent_registry_capabilities', () => {
    expect(resolveConsolidatedTableName('signaldock', 'capabilities')).toEqual({
      kind: 'mapped',
      targetName: 'agent_registry_capabilities',
    });
  });

  it('maps signaldock.db agents → agent_registry_agents', () => {
    expect(resolveConsolidatedTableName('signaldock', 'agents')).toEqual({
      kind: 'mapped',
      targetName: 'agent_registry_agents',
    });
  });

  it('maps brain.db session_narrative → brain_session_narrative (T11533 fix)', () => {
    // Was missing from BRAIN_DB_MAP → identity fallback → 'session_narrative' absent
    // in consolidated → 0 rows. After fix: maps to 'brain_session_narrative'.
    expect(resolveConsolidatedTableName('brain (project)', 'session_narrative')).toEqual({
      kind: 'mapped',
      targetName: 'brain_session_narrative',
    });
  });

  it('maps brain.db brain_release_links → skip (T11550 P0: rows live in tasks.db, not brain.db)', () => {
    // T11550 discovered these rows physically live in tasks.db. The BRAIN_DB_MAP entry is now
    // null (skip) to prevent double-migration if brain.db ever contains a phantom table.
    // The real migration path is tasks.db → TASKS_DB_MAP (tested in T11550 describe block).
    const r = resolveConsolidatedTableName('brain (project)', 'brain_release_links');
    expect(r.kind).toBe('skip');
  });

  it('maps brain.db agent_credentials → skip (T11550 P0: rows live in tasks.db, not brain.db)', () => {
    // Same as brain_release_links: rows physically live in tasks.db (verified via sqlite_master).
    // BRAIN_DB_MAP → null (skip). Real path: tasks.db → TASKS_DB_MAP.
    const r = resolveConsolidatedTableName('brain (project)', 'agent_credentials');
    expect(r.kind).toBe('skip');
  });

  it('maps tasks.db agent_credentials → tasks_agent_credentials (T11550 P0 correct DB)', () => {
    // The 3 agent_credentials rows live in tasks.db — this is the real migration path.
    const r = resolveConsolidatedTableName('tasks', 'agent_credentials');
    expect(r.kind).toBe('mapped');
    if (r.kind === 'mapped') {
      expect(r.targetName).toBe('tasks_agent_credentials');
    }
  });

  it('maps tasks.db brain_release_links → tasks_brain_release_links (T11550 P0 correct DB)', () => {
    // The 8 brain_release_links rows live in tasks.db — this is the real migration path.
    const r = resolveConsolidatedTableName('tasks', 'brain_release_links');
    expect(r.kind).toBe('mapped');
    if (r.kind === 'mapped') {
      expect(r.targetName).toBe('tasks_brain_release_links');
    }
  });
});

describe('T11533 regression — runExodusVerify: column-intersection digest (hashMatch stability)', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'tasks.db');
    targetProjectPath = join(tmpDir, 'project.db');
    targetGlobalPath = join(tmpDir, 'global.db');
    createTargetDb(targetGlobalPath, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hashMatch=true when same data exists but target has EXTRA columns (column-drift digest fix)', () => {
    // Source: tasks.db table 'no_rowid_table' with (key, val) — use name that
    // maps to 'no_rowid_table' via identity fallback (unrecognized tasks column).
    // We use 'extra_col_test' to avoid name-map interference.
    // Source schema: id INTEGER PRIMARY KEY, val TEXT
    // Target schema: id INTEGER PRIMARY KEY, val TEXT, extra_tgt_col TEXT
    // Verify MUST compute digest on intersection (id, val) only → hashMatch=true.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "nexus_nodes" (id INTEGER PRIMARY KEY, val TEXT)`);
      for (let i = 1; i <= 5; i++) {
        src.exec(`INSERT INTO "nexus_nodes" VALUES (${i}, 'v${i}')`);
      }
    } finally {
      src.close();
    }

    // Target: same table with an EXTRA column (simulates consolidated schema drift)
    const tgt = new DatabaseSync(targetProjectPath);
    try {
      tgt.exec(
        `CREATE TABLE "nexus_nodes" (id INTEGER PRIMARY KEY, val TEXT, extra_tgt_col TEXT DEFAULT NULL)`,
      );
      // Same data as source
      for (let i = 1; i <= 5; i++) {
        tgt.exec(`INSERT INTO "nexus_nodes" (id, val) VALUES (${i}, 'v${i}')`);
      }
    } finally {
      tgt.close();
    }

    // Use 'nexus' source so nexus_nodes maps to 'nexus_nodes' (identity in NEXUS_DB_MAP)
    const sources: LegacyDbDescriptor[] = [
      { name: 'nexus', path: sourcePath, targetScope: 'project' },
    ];

    const result = runExodusVerify(sources, targetProjectPath, targetGlobalPath, undefined);

    expect(result.ok, `verify must pass: ${result.error ?? ''}`).toBe(true);

    const entry = result.tables.find((t) => t.tableName === 'nexus_nodes');
    expect(entry, 'must have nexus_nodes entry').toBeDefined();
    expect(entry?.countMatch, 'count must match').toBe(true);
    expect(
      entry?.hashMatch,
      'hashMatch must be true when data is same but target has extra column (T11533 column-intersection fix)',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T11546 REGRESSION — epoch→ISO coercion + no-swallow
//
// ROOT CAUSE: conduit_messages.created_at is INTEGER epoch in source but
// text with CHECK(GLOB ISO-8601) in target. INSERT OR IGNORE silently drops
// ALL rows when the integer doesn't match the GLOB. migrate reports success
// with rowsCopied=0 — false success, data loss.
//
// Fix (a): epoch→ISO coercion via strftime() in SELECT expression.
// Fix (b): no-swallow detection: rowsCopied=0 AND sourceCount>0 → hard error.
//
// Tests:
//   1. Full-table coercion: all rows from an epoch-INTEGER source column survive
//      into a target with ISO GLOB CHECK — rowsCopied == sourceCount.
//   2. No-swallow: migrate FAILS (not silent success) when any row is dropped by
//      an unresolvable constraint (e.g. a genuinely bad value that can't be coerced).
//   3. name-map regression: schema_meta → tasks_schema_meta, brain_usage_log → brain_usage_log.
// ---------------------------------------------------------------------------

describe('T11546 regression — epoch→ISO coercion: INTEGER epoch source → text GLOB CHECK target', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'conduit.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
    createTargetDb(targetGlobalPath, []);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('migrates ALL rows when source has INTEGER epoch and target has ISO GLOB CHECK (coercion fix)', async () => {
    // Source: conduit.db table 'messages' with INTEGER created_at (Unix epoch seconds)
    const ROW_COUNT = 25;
    const NOW_EPOCH = Math.floor(Date.now() / 1000); // seconds epoch

    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(
        `CREATE TABLE "messages" (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          from_agent_id TEXT NOT NULL,
          to_agent_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`,
      );
      for (let i = 1; i <= ROW_COUNT; i++) {
        src.exec(
          `INSERT INTO "messages" (id, conversation_id, from_agent_id, to_agent_id, content, created_at)
           VALUES ('msg-${i}', 'conv-1', 'agent-a', 'agent-b', 'hello ${i}', ${NOW_EPOCH + i})`,
        );
      }
    } finally {
      src.close();
    }

    // Target: conduit_messages with text created_at + ISO GLOB CHECK (mirrors real consolidated schema)
    const tgt = new DatabaseSync(targetProjectPath);
    try {
      tgt.exec(
        `CREATE TABLE "conduit_messages" (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          from_agent_id TEXT NOT NULL,
          to_agent_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          -- consolidation CHECK constraints (T11363)
          CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*')
        )`,
      );
    } finally {
      tgt.close();
    }

    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open for assertions */
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
      { name: 'conduit', path: sourcePath, targetScope: 'project' },
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

    expect(result.ok, `migrate must succeed: ${result.error ?? ''}`).toBe(true);

    // PRIMARY ASSERTION: ALL rows must be present — not 0 (the pre-fix failure mode).
    const targetCount = countRows(targetProjectPath, 'conduit_messages');
    expect(
      targetCount,
      `T11546 epoch coercion regression: expected ${ROW_COUNT} rows in conduit_messages, got ${targetCount}` +
        ' — INTEGER epoch was not converted to ISO-8601 before INSERT, all rows dropped by GLOB CHECK',
    ).toBe(ROW_COUNT);

    // SECONDARY ASSERTION: created_at values must be ISO-8601 formatted (not raw integers)
    const db = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const row = db.prepare(`SELECT created_at FROM conduit_messages LIMIT 1`).get() as {
        created_at: string;
      } | null;
      expect(row?.created_at, 'created_at must be ISO-8601 string after epoch coercion').toMatch(
        /^\d{4}-\d{2}-\d{2}T/,
      );
    } finally {
      db.close();
    }

    targetProjectDb.close();
    targetGlobalDb.close();
  });

  it('no-swallow: migrate reports error (not silent success) when rows dropped by unresolvable constraint', async () => {
    // Source: table where the target has a STRICT enum CHECK that source values violate.
    // This simulates a scenario where coercion cannot help (bad enum value, not epoch).
    // The no-swallow detection must surface this as a non-silent error.
    const src = new DatabaseSync(sourcePath);
    try {
      src.exec(`CREATE TABLE "messages" (id TEXT PRIMARY KEY, status TEXT NOT NULL)`);
      // Insert rows with an invalid status value that will fail the CHECK
      for (let i = 1; i <= 10; i++) {
        src.exec(`INSERT INTO "messages" (id, status) VALUES ('m-${i}', 'invalid_status')`);
      }
    } finally {
      src.close();
    }

    // Target: conduit_messages with a strict enum CHECK on status
    const tgt = new DatabaseSync(targetProjectPath);
    try {
      tgt.exec(
        `CREATE TABLE "conduit_messages" (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          CHECK ("status" IN ('pending', 'delivered', 'read', 'failed'))
        )`,
      );
    } finally {
      tgt.close();
    }

    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* keep open */
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
      { name: 'conduit', path: sourcePath, targetScope: 'project' },
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

    // PRIMARY ASSERTION: migrate must NOT report ok:true + rowsCopied=0 silently.
    // The no-swallow detection converts a 0-row full-table drop into a reported error.
    // The table result must show a reason/error (non-empty reason field).
    // Note: result.tables stores LEGACY table names (the source physical names), not consolidated names.
    // 'messages' is the legacy name in conduit.db (maps to consolidated 'conduit_messages').
    const msgTableResult = result.tables.find((t) => t.tableName === 'messages');
    expect(
      msgTableResult,
      'migrate must emit a result entry for messages (conduit_messages)',
    ).toBeDefined();
    expect(
      msgTableResult?.reason,
      'no-swallow: migrate must report a reason when ALL rows are dropped by a constraint — ' +
        'pre-fix: result.ok=true, rowsCopied=0, reason=undefined (silent data loss)',
    ).toBeTruthy();
    expect(
      msgTableResult?.rowsCopied,
      'no-swallow: rowsCopied must be 0 when all rows fail CHECK constraint',
    ).toBe(0);

    targetProjectDb.close();
    targetGlobalDb.close();
  });
});

describe('T11546 regression — name-map: no-home table mappings', () => {
  it('maps tasks.db schema_meta → tasks_schema_meta', () => {
    expect(resolveConsolidatedTableName('tasks', 'schema_meta')).toEqual({
      kind: 'mapped',
      targetName: 'tasks_schema_meta',
    });
  });

  it('maps brain.db brain_usage_log → brain_usage_log (identity — now in consolidated schema)', () => {
    expect(resolveConsolidatedTableName('brain', 'brain_usage_log')).toEqual({
      kind: 'mapped',
      targetName: 'brain_usage_log',
    });
  });

  it('maps brain.db brain_schema_meta → brain_schema_meta (identity — now mapped)', () => {
    expect(resolveConsolidatedTableName('brain (project)', 'brain_schema_meta')).toEqual({
      kind: 'mapped',
      targetName: 'brain_schema_meta',
    });
  });

  it('returns skip for brain.db brain_task_observations (not in consolidated schema)', () => {
    const r = resolveConsolidatedTableName('brain', 'brain_task_observations');
    expect(r.kind).toBe('skip');
  });

  it('returns skip for brain.db brain_embeddings (vec0 virtual table)', () => {
    const r = resolveConsolidatedTableName('brain', 'brain_embeddings');
    expect(r.kind).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
// T11547 REGRESSION — enum-value normalization in the migrate layer
//
// Verifies that rows with legacy enum values that fail the consolidated CHECK
// constraints are NORMALIZED (not silently dropped) during `copyTableFromAttached`.
//
// Test strategy: build a source DB whose table has a CHECK-constrained column
// containing legacy values that would fail the CHECK. The target DB uses the
// same schema with the strict CHECK. The migration must produce the correct
// canonical value in each row — confirmed by reading back the target after
// the migrate call.
//
// We use the same mock-openDualScopeDb pattern as T11531.
// ---------------------------------------------------------------------------

describe('T11547 regression — enum normalization in migrate layer', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'source.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Helper: run a migration with an injected source + pre-built target DB.
   * Returns the consolidated target DB path for post-migration assertions.
   */
  async function runMigrateWithFixture(
    sourceName: string,
    targetScope: 'project' | 'global',
  ): Promise<string> {
    const targetPath = targetScope === 'project' ? targetProjectPath : targetGlobalPath;
    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* test owns lifetime */
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

    const plan: ExodusPlan = {
      sources: [{ name: sourceName, path: sourcePath, targetScope }],
      totalSourceBytes: 0,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath: targetProjectPath,
      globalDbPath: targetGlobalPath,
    };

    const result = await migrate(plan, false, undefined);
    expect(result.ok, `migrate failed: ${result.error ?? 'unknown'}`).toBe(true);

    targetProjectDb.close();
    targetGlobalDb.close();

    return targetPath;
  }

  it('normalizes task_commits.link_source commit-message → commit-subject', async () => {
    // Source table: legacy table name 'task_commits' (maps to 'tasks_task_commits')
    // with link_source = 'commit-message' which is NOT in COMMIT_LINK_SOURCES.
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE task_commits (task_id TEXT, commit_sha TEXT, link_kind TEXT, link_source TEXT NOT NULL, created_at TEXT)`,
      );
      srcDb.exec(
        `INSERT INTO task_commits VALUES ('T1', 'abc123', 'task-commit', 'commit-message', '2026-01-01T00:00:00.000Z')`,
      );
      srcDb.exec(
        `INSERT INTO task_commits VALUES ('T2', 'def456', 'task-commit', 'commit-trailer', '2026-01-01T00:00:00.000Z')`,
      );
    } finally {
      srcDb.close();
    }

    // Target: tasks_task_commits with CHECK on link_source
    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_task_commits (task_id TEXT, commit_sha TEXT, link_kind TEXT NOT NULL, ` +
          `link_source TEXT NOT NULL CHECK (link_source IN ('commit-trailer','commit-subject','pr-title','pr-body','branch-name','manual')), ` +
          `created_at TEXT NOT NULL, PRIMARY KEY (task_id, commit_sha, link_kind))`,
      );
    } finally {
      tgtDb.close();
    }
    const emptyTgt = new DatabaseSync(targetGlobalPath);
    emptyTgt.close();

    await runMigrateWithFixture('tasks', 'project');

    // Verify: both rows present, commit-message → commit-subject
    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT task_id, link_source FROM tasks_task_commits ORDER BY task_id')
        .all() as Array<{ task_id: string; link_source: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.link_source, 'commit-message must be normalized to commit-subject').toBe(
        'commit-subject',
      );
      expect(rows[1]?.link_source, 'commit-trailer must pass through unchanged').toBe(
        'commit-trailer',
      );
    } finally {
      tgt.close();
    }
  });

  it('normalizes tasks_architecture_decisions.status case variants', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE architecture_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL, date TEXT NOT NULL, file_path TEXT NOT NULL)`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-001', 'T1', 'Accepted', 'body', '2026-01-01', 'foo.md')`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-002', 'T2', 'ACCEPTED', 'body', '2026-01-01', 'foo.md')`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-003', 'T3', 'approved', 'body', '2026-01-01', 'foo.md')`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-004', 'T4', 'Accepted (2026-04-18)', 'body', '2026-01-01', 'foo.md')`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-005', 'T5', 'proposed', 'body', '2026-01-01', 'foo.md')`,
      );
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_architecture_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, ` +
          `status TEXT NOT NULL CHECK (status IN ('proposed','accepted','superseded','deprecated')) DEFAULT 'proposed', ` +
          `content TEXT NOT NULL, date TEXT NOT NULL, file_path TEXT NOT NULL)`,
      );
    } finally {
      tgtDb.close();
    }
    const emptyTgt = new DatabaseSync(targetGlobalPath);
    emptyTgt.close();

    await runMigrateWithFixture('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, status FROM tasks_architecture_decisions ORDER BY id')
        .all() as Array<{ id: string; status: string }>;
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        if (row.id === 'ADR-005') {
          expect(row.status, `${row.id}: proposed must pass through`).toBe('proposed');
        } else {
          expect(row.status, `${row.id}: must normalize to 'accepted'`).toBe('accepted');
        }
      }
    } finally {
      tgt.close();
    }
  });

  it('normalizes brain_observations.source_type legacy values → agent', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_observations (id TEXT PRIMARY KEY, type TEXT NOT NULL, source_type TEXT, narrative TEXT NOT NULL)`,
      );
      srcDb.exec(
        `INSERT INTO brain_observations VALUES ('O-1', 'discovery', 'observer-compressed', 'obs 1')`,
      );
      srcDb.exec(
        `INSERT INTO brain_observations VALUES ('O-2', 'discovery', 'sleep-consolidation', 'obs 2')`,
      );
      srcDb.exec(`INSERT INTO brain_observations VALUES ('O-3', 'discovery', 'agent', 'obs 3')`);
      srcDb.exec(`INSERT INTO brain_observations VALUES ('O-4', 'discovery', 'manual', 'obs 4')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_observations (id TEXT PRIMARY KEY, type TEXT NOT NULL, ` +
          `source_type TEXT CHECK (source_type IS NULL OR source_type IN ('agent','session-debrief','claude-mem','manual')), ` +
          `narrative TEXT NOT NULL)`,
      );
    } finally {
      tgtDb.close();
    }
    const emptyTgt = new DatabaseSync(targetGlobalPath);
    emptyTgt.close();

    await runMigrateWithFixture('brain (project)', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, source_type FROM brain_observations ORDER BY id')
        .all() as Array<{ id: string; source_type: string }>;
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.id === 'O-1')?.source_type, 'observer-compressed → agent').toBe(
        'agent',
      );
      expect(rows.find((r) => r.id === 'O-2')?.source_type, 'sleep-consolidation → agent').toBe(
        'agent',
      );
      expect(rows.find((r) => r.id === 'O-3')?.source_type, 'agent passthrough').toBe('agent');
      expect(rows.find((r) => r.id === 'O-4')?.source_type, 'manual passthrough').toBe('manual');
    } finally {
      tgt.close();
    }
  });

  it('normalizes brain_observations.type legacy values to canonical types', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_observations (id TEXT PRIMARY KEY, type TEXT NOT NULL, narrative TEXT NOT NULL)`,
      );
      srcDb.exec(`INSERT INTO brain_observations VALUES ('O-1', 'observation', 'obs 1')`);
      srcDb.exec(`INSERT INTO brain_observations VALUES ('O-2', 'proposal', 'obs 2')`);
      srcDb.exec(`INSERT INTO brain_observations VALUES ('O-3', 'pattern', 'obs 3')`);
      srcDb.exec(`INSERT INTO brain_observations VALUES ('O-4', 'discovery', 'obs 4')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_observations (id TEXT PRIMARY KEY, ` +
          `type TEXT NOT NULL CHECK (type IN ('discovery','change','feature','bugfix','decision','refactor','diary','session-summary')), ` +
          `narrative TEXT NOT NULL)`,
      );
    } finally {
      tgtDb.close();
    }
    const emptyTgt = new DatabaseSync(targetGlobalPath);
    emptyTgt.close();

    await runMigrateWithFixture('brain (project)', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, type FROM brain_observations ORDER BY id')
        .all() as Array<{ id: string; type: string }>;
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.id === 'O-1')?.type, 'observation → discovery').toBe('discovery');
      expect(rows.find((r) => r.id === 'O-2')?.type, 'proposal → decision').toBe('decision');
      expect(rows.find((r) => r.id === 'O-3')?.type, 'pattern → refactor').toBe('refactor');
      expect(rows.find((r) => r.id === 'O-4')?.type, 'discovery passthrough').toBe('discovery');
    } finally {
      tgt.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T11548 REGRESSION — final enum coverage (285 rows, zero genuine loss)
//
// Verifies the 8 new ENUM_NORMALIZATIONS entries added in T11548:
//   - tasks_token_usage.transport: 'mcp' → 'agent'
//   - brain_decisions.decision_category: 'architecture' → 'architectural'
//   - brain_decisions.confidence: out-of-vocab → 'medium'
//   - tasks_commits.conventional_type: 'style' → 'chore'
//   - tasks_task_relations.relation_type: 'grouped-by' → 'groups'
//   - tasks_lifecycle_stages.stage_name: 'implemented'/'qaPassed'/'testsPassed' normalization
//   - tasks_architecture_decisions.gate_status: 'passed (T5313 consensus)'/'approved' → 'passed'
//   - tasks_evidence_ac_bindings.binding_type: 'validator:...' prefix → 'direct'
//
// Strategy mirrors T11547: build a source DB with legacy values, a target DB
// with the strict CHECK constraint, run migration, read back and assert.
//
// @task T11548
// ---------------------------------------------------------------------------

describe('T11548 regression — final enum coverage: transport/conventional_type/relation_type/lifecycle/gate_status/binding_type', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'source.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * Helper: run a migration with an injected source + pre-built target DB.
   * Mirrors the same helper used in the T11547 describe block above.
   */
  async function runMigrateT11548(
    sourceName: string,
    targetScope: 'project' | 'global',
  ): Promise<string> {
    const targetPath = targetScope === 'project' ? targetProjectPath : targetGlobalPath;
    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* test owns lifetime */
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

    const plan: ExodusPlan = {
      sources: [{ name: sourceName, path: sourcePath, targetScope }],
      totalSourceBytes: 0,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath: targetProjectPath,
      globalDbPath: targetGlobalPath,
    };

    const result = await migrate(plan, false, undefined);
    expect(result.ok, `migrate failed: ${result.error ?? 'unknown'}`).toBe(true);

    targetProjectDb.close();
    targetGlobalDb.close();

    return targetPath;
  }

  it('normalizes tasks_token_usage.transport: mcp → agent', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE token_usage (id INTEGER PRIMARY KEY, transport TEXT NOT NULL, tokens INTEGER)`,
      );
      srcDb.exec(`INSERT INTO token_usage VALUES (1, 'mcp', 100)`);
      srcDb.exec(`INSERT INTO token_usage VALUES (2, 'cli', 200)`);
      srcDb.exec(`INSERT INTO token_usage VALUES (3, 'agent', 150)`);
      srcDb.exec(`INSERT INTO token_usage VALUES (4, 'mcp', 75)`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_token_usage (id INTEGER PRIMARY KEY, ` +
          `transport TEXT NOT NULL CHECK (transport IN ('cli','api','agent','unknown')) DEFAULT 'unknown', ` +
          `tokens INTEGER)`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, transport FROM tasks_token_usage ORDER BY id')
        .all() as Array<{ id: number; transport: string }>;
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.id === 1)?.transport, 'mcp → agent').toBe('agent');
      expect(rows.find((r) => r.id === 2)?.transport, 'cli passthrough').toBe('cli');
      expect(rows.find((r) => r.id === 3)?.transport, 'agent passthrough').toBe('agent');
      expect(rows.find((r) => r.id === 4)?.transport, 'mcp → agent').toBe('agent');
    } finally {
      tgt.close();
    }
  });

  it('normalizes brain_decisions.decision_category: architecture → architectural', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, decision_category TEXT, title TEXT NOT NULL)`,
      );
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-1', 'architecture', 'Decision A')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-2', 'architectural', 'Decision B')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-3', 'other', 'Decision C')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, ` +
          `decision_category TEXT CHECK (decision_category IS NULL OR decision_category IN ('architectural','agent_dispatch','other')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('brain (project)', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, decision_category FROM brain_decisions ORDER BY id')
        .all() as Array<{ id: string; decision_category: string }>;
      expect(rows).toHaveLength(3);
      expect(
        rows.find((r) => r.id === 'D-1')?.decision_category,
        'architecture → architectural',
      ).toBe('architectural');
      expect(rows.find((r) => r.id === 'D-2')?.decision_category, 'architectural passthrough').toBe(
        'architectural',
      );
      expect(rows.find((r) => r.id === 'D-3')?.decision_category, 'other passthrough').toBe(
        'other',
      );
    } finally {
      tgt.close();
    }
  });

  it('normalizes brain_decisions.confidence: out-of-vocab → medium', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, confidence TEXT)`,
      );
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-1', 'A', 'high')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-2', 'B', 'medium')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-3', 'C', 'low')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-4', 'D', 'very-high')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-5', 'E', 'uncertain')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, ` +
          `confidence TEXT CHECK (confidence IS NULL OR confidence IN ('low','medium','high')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('brain (project)', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, confidence FROM brain_decisions ORDER BY id')
        .all() as Array<{ id: string; confidence: string }>;
      expect(rows).toHaveLength(5);
      expect(rows.find((r) => r.id === 'D-1')?.confidence, 'high passthrough').toBe('high');
      expect(rows.find((r) => r.id === 'D-2')?.confidence, 'medium passthrough').toBe('medium');
      expect(rows.find((r) => r.id === 'D-3')?.confidence, 'low passthrough').toBe('low');
      expect(rows.find((r) => r.id === 'D-4')?.confidence, 'very-high → medium').toBe('medium');
      expect(rows.find((r) => r.id === 'D-5')?.confidence, 'uncertain → medium').toBe('medium');
    } finally {
      tgt.close();
    }
  });

  it('normalizes tasks_commits.conventional_type: style → chore', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE commits (sha TEXT PRIMARY KEY, conventional_type TEXT NOT NULL, message TEXT)`,
      );
      srcDb.exec(`INSERT INTO commits VALUES ('abc1', 'style', 'format code')`);
      srcDb.exec(`INSERT INTO commits VALUES ('abc2', 'chore', 'update deps')`);
      srcDb.exec(`INSERT INTO commits VALUES ('abc3', 'feat', 'add feature')`);
      srcDb.exec(`INSERT INTO commits VALUES ('abc4', 'style', 'fix lint')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_commits (sha TEXT PRIMARY KEY, message TEXT, ` +
          `conventional_type TEXT NOT NULL DEFAULT 'chore' ` +
          `CHECK (conventional_type IN ('feat','fix','chore','docs','refactor','test','build','ci','perf','revert','breaking')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT sha, conventional_type FROM tasks_commits ORDER BY sha')
        .all() as Array<{ sha: string; conventional_type: string }>;
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.sha === 'abc1')?.conventional_type, 'style → chore').toBe('chore');
      expect(rows.find((r) => r.sha === 'abc2')?.conventional_type, 'chore passthrough').toBe(
        'chore',
      );
      expect(rows.find((r) => r.sha === 'abc3')?.conventional_type, 'feat passthrough').toBe(
        'feat',
      );
      expect(rows.find((r) => r.sha === 'abc4')?.conventional_type, 'style → chore').toBe('chore');
    } finally {
      tgt.close();
    }
  });

  it('normalizes tasks_task_relations.relation_type: grouped-by → groups', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE task_relations (from_task_id TEXT NOT NULL, to_task_id TEXT NOT NULL, relation_type TEXT NOT NULL, PRIMARY KEY (from_task_id, to_task_id, relation_type))`,
      );
      srcDb.exec(`INSERT INTO task_relations VALUES ('T1', 'T2', 'grouped-by')`);
      srcDb.exec(`INSERT INTO task_relations VALUES ('T1', 'T3', 'groups')`);
      srcDb.exec(`INSERT INTO task_relations VALUES ('T2', 'T4', 'related')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_task_relations (from_task_id TEXT NOT NULL, to_task_id TEXT NOT NULL, ` +
          `relation_type TEXT NOT NULL ` +
          `CHECK (relation_type IN ('related','blocks','duplicates','absorbs','fixes','extends','supersedes','groups')), ` +
          `PRIMARY KEY (from_task_id, to_task_id, relation_type))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare(
          'SELECT from_task_id, to_task_id, relation_type FROM tasks_task_relations ORDER BY from_task_id, to_task_id',
        )
        .all() as Array<{ from_task_id: string; to_task_id: string; relation_type: string }>;
      expect(rows).toHaveLength(3);
      expect(
        rows.find((r) => r.from_task_id === 'T1' && r.to_task_id === 'T2')?.relation_type,
        'grouped-by → groups',
      ).toBe('groups');
      expect(
        rows.find((r) => r.from_task_id === 'T1' && r.to_task_id === 'T3')?.relation_type,
        'groups passthrough',
      ).toBe('groups');
      expect(
        rows.find((r) => r.from_task_id === 'T2' && r.to_task_id === 'T4')?.relation_type,
        'related passthrough',
      ).toBe('related');
    } finally {
      tgt.close();
    }
  });

  it('normalizes tasks_lifecycle_stages.stage_name: implemented/qaPassed/testsPassed', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(`CREATE TABLE lifecycle_stages (id TEXT PRIMARY KEY, stage_name TEXT NOT NULL)`);
      srcDb.exec(`INSERT INTO lifecycle_stages VALUES ('LS-1', 'implemented')`);
      srcDb.exec(`INSERT INTO lifecycle_stages VALUES ('LS-2', 'qaPassed')`);
      srcDb.exec(`INSERT INTO lifecycle_stages VALUES ('LS-3', 'testsPassed')`);
      srcDb.exec(`INSERT INTO lifecycle_stages VALUES ('LS-4', 'implementation')`);
      srcDb.exec(`INSERT INTO lifecycle_stages VALUES ('LS-5', 'validation')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_lifecycle_stages (id TEXT PRIMARY KEY, ` +
          `stage_name TEXT NOT NULL ` +
          `CHECK (stage_name IN ('research','consensus','architecture_decision','specification','decomposition','implementation','validation','testing','release','contribution')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, stage_name FROM tasks_lifecycle_stages ORDER BY id')
        .all() as Array<{ id: string; stage_name: string }>;
      expect(rows).toHaveLength(5);
      expect(rows.find((r) => r.id === 'LS-1')?.stage_name, 'implemented → implementation').toBe(
        'implementation',
      );
      expect(rows.find((r) => r.id === 'LS-2')?.stage_name, 'qaPassed → validation').toBe(
        'validation',
      );
      expect(rows.find((r) => r.id === 'LS-3')?.stage_name, 'testsPassed → testing').toBe(
        'testing',
      );
      expect(rows.find((r) => r.id === 'LS-4')?.stage_name, 'implementation passthrough').toBe(
        'implementation',
      );
      expect(rows.find((r) => r.id === 'LS-5')?.stage_name, 'validation passthrough').toBe(
        'validation',
      );
    } finally {
      tgt.close();
    }
  });

  it('normalizes tasks_architecture_decisions.gate_status: passed-variant/approved → passed', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE architecture_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, content TEXT NOT NULL, date TEXT NOT NULL, file_path TEXT NOT NULL, gate_status TEXT)`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-1', 'A', 'accepted', 'c', '2026-01-01', 'f.md', 'passed (T5313 consensus)')`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-2', 'B', 'accepted', 'c', '2026-01-01', 'f.md', 'approved')`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-3', 'C', 'accepted', 'c', '2026-01-01', 'f.md', 'passed')`,
      );
      srcDb.exec(
        `INSERT INTO architecture_decisions VALUES ('ADR-4', 'D', 'accepted', 'c', '2026-01-01', 'f.md', 'pending')`,
      );
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_architecture_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, ` +
          `status TEXT NOT NULL CHECK (status IN ('proposed','accepted','superseded','deprecated')) DEFAULT 'proposed', ` +
          `content TEXT NOT NULL, date TEXT NOT NULL, file_path TEXT NOT NULL, ` +
          `gate_status TEXT CHECK (gate_status IS NULL OR gate_status IN ('pending','passed','failed','waived')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, gate_status FROM tasks_architecture_decisions ORDER BY id')
        .all() as Array<{ id: string; gate_status: string | null }>;
      expect(rows).toHaveLength(4);
      expect(
        rows.find((r) => r.id === 'ADR-1')?.gate_status,
        'passed (T5313 consensus) → passed',
      ).toBe('passed');
      expect(rows.find((r) => r.id === 'ADR-2')?.gate_status, 'approved → passed').toBe('passed');
      expect(rows.find((r) => r.id === 'ADR-3')?.gate_status, 'passed passthrough').toBe('passed');
      expect(rows.find((r) => r.id === 'ADR-4')?.gate_status, 'pending passthrough').toBe(
        'pending',
      );
    } finally {
      tgt.close();
    }
  });

  it('normalizes tasks_evidence_ac_bindings.binding_type: validator:... → direct', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE evidence_ac_bindings (id TEXT PRIMARY KEY, binding_type TEXT NOT NULL)`,
      );
      srcDb.exec(`INSERT INTO evidence_ac_bindings VALUES ('B-1', 'validator:schema')`);
      srcDb.exec(`INSERT INTO evidence_ac_bindings VALUES ('B-2', 'validator:runtime')`);
      srcDb.exec(`INSERT INTO evidence_ac_bindings VALUES ('B-3', 'direct')`);
      srcDb.exec(`INSERT INTO evidence_ac_bindings VALUES ('B-4', 'satisfies')`);
      srcDb.exec(`INSERT INTO evidence_ac_bindings VALUES ('B-5', 'coverage')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_evidence_ac_bindings (id TEXT PRIMARY KEY, ` +
          `binding_type TEXT NOT NULL CHECK (binding_type IN ('direct','satisfies','coverage')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11548('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, binding_type FROM tasks_evidence_ac_bindings ORDER BY id')
        .all() as Array<{ id: string; binding_type: string }>;
      expect(rows).toHaveLength(5);
      expect(rows.find((r) => r.id === 'B-1')?.binding_type, 'validator:schema → direct').toBe(
        'direct',
      );
      expect(rows.find((r) => r.id === 'B-2')?.binding_type, 'validator:runtime → direct').toBe(
        'direct',
      );
      expect(rows.find((r) => r.id === 'B-3')?.binding_type, 'direct passthrough').toBe('direct');
      expect(rows.find((r) => r.id === 'B-4')?.binding_type, 'satisfies passthrough').toBe(
        'satisfies',
      );
      expect(rows.find((r) => r.id === 'B-5')?.binding_type, 'coverage passthrough').toBe(
        'coverage',
      );
    } finally {
      tgt.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T11549 REGRESSION — zero-loss final mile
//
// Verifies three precise fixes:
//   1. brain_decisions.confidence: 'confirmed' → 'high' (not 'medium')
//   2. brain_decisions.decision_category: 'process' → 'other', 'technical' → 'other'
//   3. Epoch seconds-vs-ms: a seconds-epoch value (< 1e11) converts to a 2020s
//      year, not 1970 (magnitude heuristic — T11549 coercion fix)
//
// @task T11549
// ---------------------------------------------------------------------------

describe('T11549 regression — zero-loss final mile: confidence/decision_category enums + seconds-epoch coercion', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'source.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Shared migrate helper — mirrors T11548 helper exactly. */
  async function runMigrateT11549(
    sourceName: string,
    targetScope: 'project' | 'global',
  ): Promise<string> {
    const targetPath = targetScope === 'project' ? targetProjectPath : targetGlobalPath;
    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* test owns lifetime */
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

    const plan: ExodusPlan = {
      sources: [{ name: sourceName, path: sourcePath, targetScope }],
      totalSourceBytes: 0,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath: targetProjectPath,
      globalDbPath: targetGlobalPath,
    };

    const result = await migrate(plan, false, undefined);
    expect(result.ok, `migrate failed: ${result.error ?? 'unknown'}`).toBe(true);

    targetProjectDb.close();
    targetGlobalDb.close();

    return targetPath;
  }

  it('normalizes brain_decisions.confidence: confirmed → high (not medium)', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, decision TEXT NOT NULL, ` +
          `rationale TEXT NOT NULL, confidence TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'architecture')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-1', 'dec1', 'rat1', 'confirmed', 'architecture')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-2', 'dec2', 'rat2', 'high', 'architecture')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-3', 'dec3', 'rat3', 'medium', 'architecture')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-4', 'dec4', 'rat4', 'low', 'architecture')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-5', 'dec5', 'rat5', 'unknown-val', 'architecture')`,
      );
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, decision TEXT NOT NULL, ` +
          `rationale TEXT NOT NULL, ` +
          `confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')), ` +
          `type TEXT NOT NULL DEFAULT 'architecture')`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11549('brain', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, confidence FROM brain_decisions ORDER BY id')
        .all() as Array<{ id: string; confidence: string }>;
      expect(rows).toHaveLength(5);
      expect(rows.find((r) => r.id === 'D-1')?.confidence, 'confirmed → high').toBe('high');
      expect(rows.find((r) => r.id === 'D-2')?.confidence, 'high passthrough').toBe('high');
      expect(rows.find((r) => r.id === 'D-3')?.confidence, 'medium passthrough').toBe('medium');
      expect(rows.find((r) => r.id === 'D-4')?.confidence, 'low passthrough').toBe('low');
      expect(rows.find((r) => r.id === 'D-5')?.confidence, 'unknown-val → medium fallback').toBe(
        'medium',
      );
    } finally {
      tgt.close();
    }
  });

  it('normalizes brain_decisions.decision_category: process/technical → other', async () => {
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, decision TEXT NOT NULL, ` +
          `rationale TEXT NOT NULL, confidence TEXT NOT NULL DEFAULT 'medium', ` +
          `type TEXT NOT NULL DEFAULT 'architecture', decision_category TEXT NOT NULL DEFAULT 'architectural')`,
      );
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-1', 'd', 'r', 'high', 'arch', 'process')`);
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-2', 'd', 'r', 'high', 'arch', 'technical')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-3', 'd', 'r', 'high', 'arch', 'architecture')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-4', 'd', 'r', 'high', 'arch', 'architectural')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D-5', 'd', 'r', 'high', 'arch', 'agent_dispatch')`,
      );
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-6', 'd', 'r', 'high', 'arch', 'other')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, decision TEXT NOT NULL, ` +
          `rationale TEXT NOT NULL, ` +
          `confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')) DEFAULT 'medium', ` +
          `type TEXT NOT NULL DEFAULT 'architecture', ` +
          `decision_category TEXT NOT NULL ` +
          `CHECK (decision_category IN ('architectural','agent_dispatch','other')) DEFAULT 'architectural')`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11549('brain', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, decision_category FROM brain_decisions ORDER BY id')
        .all() as Array<{ id: string; decision_category: string }>;
      expect(rows).toHaveLength(6);
      expect(rows.find((r) => r.id === 'D-1')?.decision_category, 'process → other').toBe('other');
      expect(rows.find((r) => r.id === 'D-2')?.decision_category, 'technical → other').toBe(
        'other',
      );
      expect(
        rows.find((r) => r.id === 'D-3')?.decision_category,
        'architecture → architectural',
      ).toBe('architectural');
      expect(rows.find((r) => r.id === 'D-4')?.decision_category, 'architectural passthrough').toBe(
        'architectural',
      );
      expect(
        rows.find((r) => r.id === 'D-5')?.decision_category,
        'agent_dispatch passthrough',
      ).toBe('agent_dispatch');
      expect(rows.find((r) => r.id === 'D-6')?.decision_category, 'other passthrough').toBe(
        'other',
      );
    } finally {
      tgt.close();
    }
  });

  it('seconds-epoch value (< 1e11) coerces to a 2020s year, NOT 1970 (magnitude heuristic fix)', async () => {
    // Seconds epoch for 2026-06-01 ≈ 1_777_660_000 (< 1e11 → should be treated as seconds).
    // If treated as milliseconds (old bug): 1_777_660 seconds from epoch ≈ 1970-01-21.
    const secondsEpoch = 1_777_660_429; // 2026-06-01T... in seconds
    const msEpoch = 1_717_200_000_000; // 2024-06-01 in milliseconds (≥ 1e11 → ms branch)

    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE user_profile (trait_key TEXT PRIMARY KEY, trait_value TEXT NOT NULL, ` +
          `confidence REAL NOT NULL, source TEXT NOT NULL, ` +
          `first_observed_at INTEGER NOT NULL, last_reinforced_at INTEGER NOT NULL, ` +
          `reinforcement_count INTEGER NOT NULL DEFAULT 1)`,
      );
      // Row 1: seconds epoch (should → 2026; bug was → 1970)
      srcDb.exec(
        `INSERT INTO user_profile VALUES ('trait-sec', 'v', 0.9, 'manual', ${secondsEpoch}, ${secondsEpoch}, 1)`,
      );
      // Row 2: milliseconds epoch (should → 2024; was already correct before fix)
      srcDb.exec(
        `INSERT INTO user_profile VALUES ('trait-ms', 'v', 0.8, 'manual', ${msEpoch}, ${msEpoch}, 1)`,
      );
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      // Target uses TEXT ISO8601 columns with ISO GLOB CHECK (E10 §4 re-typing for nexus).
      tgtDb.exec(
        `CREATE TABLE nexus_user_profile (` +
          `trait_key TEXT PRIMARY KEY, ` +
          `trait_value TEXT NOT NULL, ` +
          `confidence REAL NOT NULL, ` +
          `source TEXT NOT NULL, ` +
          `first_observed_at TEXT NOT NULL ` +
          `CHECK ("first_observed_at" IS NULL OR "first_observed_at" GLOB '[0-9][0-9][0-9][0-9]-*'), ` +
          `last_reinforced_at TEXT NOT NULL ` +
          `CHECK ("last_reinforced_at" IS NULL OR "last_reinforced_at" GLOB '[0-9][0-9][0-9][0-9]-*'), ` +
          `reinforcement_count INTEGER NOT NULL DEFAULT 1)`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11549('nexus', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare(
          'SELECT trait_key, first_observed_at, last_reinforced_at FROM nexus_user_profile ORDER BY trait_key',
        )
        .all() as Array<{
        trait_key: string;
        first_observed_at: string;
        last_reinforced_at: string;
      }>;

      // Both rows must have migrated (neither dropped)
      expect(rows).toHaveLength(2);

      const secRow = rows.find((r) => r.trait_key === 'trait-sec');
      const msRow = rows.find((r) => r.trait_key === 'trait-ms');

      // Seconds-epoch row: first 4 chars must be '2026' (not '1970')
      expect(secRow?.first_observed_at.startsWith('2026'), 'seconds-epoch → 2026, not 1970').toBe(
        true,
      );
      expect(
        secRow?.last_reinforced_at.startsWith('2026'),
        'seconds-epoch last_reinforced → 2026',
      ).toBe(true);

      // Milliseconds-epoch row: first 4 chars must be '2024'
      expect(msRow?.first_observed_at.startsWith('2024'), 'ms-epoch → 2024').toBe(true);
      expect(msRow?.last_reinforced_at.startsWith('2024'), 'ms-epoch last_reinforced → 2024').toBe(
        true,
      );
    } finally {
      tgt.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T11550 REGRESSION — last 15 rows: wrong-DB-map + brain_decisions enums
// ---------------------------------------------------------------------------
//
// Bug 1: agent_credentials (3 rows) + brain_release_links (8 rows) physically
//   live in tasks.db. T11549 placed the mappings in BRAIN_DB_MAP. Since the
//   exodus tasks.db source uses 'tasks' → TASKS_DB_MAP, the rows were skipped.
//   Fix: move mappings to TASKS_DB_MAP; set BRAIN_DB_MAP entries to null (skip).
//
// Bug 2: brain_decisions.outcome legacy value 'accepted' not in consolidated
//   CHECK enum (success|failure|mixed|pending). Maps → 'success'.
//   brain_decisions.decided_by legacy value 'prime' not in consolidated CHECK
//   enum (owner|council|agent). Maps → 'agent'.
//   Fix: add ENUM_NORMALIZATIONS entries for both columns.
//
// @task T11550 (P0 zero-loss final mile — last 15 rows)

describe('T11550 regression — agent_credentials/brain_release_links from tasks.db + brain_decisions outcome/decided_by enums', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetProjectPath: string;
  let targetGlobalPath: string;
  let stagingDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    sourcePath = join(tmpDir, 'source.db');
    targetProjectPath = join(tmpDir, 'target-project.db');
    targetGlobalPath = join(tmpDir, 'target-global.db');
    stagingDir = join(tmpDir, 'staging');
    mkdirSync(stagingDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Shared migrate helper identical to T11549. */
  async function runMigrateT11550(
    sourceName: string,
    targetScope: 'project' | 'global',
  ): Promise<string> {
    const targetPath = targetScope === 'project' ? targetProjectPath : targetGlobalPath;
    const targetProjectDb = new DatabaseSync(targetProjectPath);
    const targetGlobalDb = new DatabaseSync(targetGlobalPath);

    const makeFakeHandle = (native: DatabaseSyncType) => ({
      db: { $client: native },
      close: () => {
        /* test owns lifetime */
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

    const plan: ExodusPlan = {
      sources: [{ name: sourceName, path: sourcePath, targetScope }],
      totalSourceBytes: 0,
      availableBytes: 100_000_000,
      diskPreflight: true,
      stagingDir,
      resumeFromStaging: false,
      projectDbPath: targetProjectPath,
      globalDbPath: targetGlobalPath,
    };

    const result = await migrate(plan, false, undefined);
    expect(result.ok, `migrate failed: ${result.error ?? 'unknown'}`).toBe(true);

    targetProjectDb.close();
    targetGlobalDb.close();

    return targetPath;
  }

  it('migrates agent_credentials from tasks.db source (3 rows, P0 wrong-DB-map fix)', async () => {
    // Before T11550: mapping was in BRAIN_DB_MAP; tasks.db → TASKS_DB_MAP had no entry → skip.
    // After T11550: TASKS_DB_MAP has 'agent_credentials' → 'tasks_agent_credentials'.
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE agent_credentials (` +
          `agent_id TEXT PRIMARY KEY, ` +
          `display_name TEXT NOT NULL, ` +
          `api_key_encrypted TEXT NOT NULL, ` +
          `api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io', ` +
          `is_active INTEGER NOT NULL DEFAULT 1, ` +
          `created_at INTEGER NOT NULL DEFAULT 0, ` +
          `updated_at INTEGER NOT NULL DEFAULT 0)`,
      );
      srcDb.exec(
        `INSERT INTO agent_credentials VALUES ('a1', 'Agent One', 'enc-key-1', 'https://api.signaldock.io', 1, 1717000000000, 1717000000000)`,
      );
      srcDb.exec(
        `INSERT INTO agent_credentials VALUES ('a2', 'Agent Two', 'enc-key-2', 'https://api.signaldock.io', 1, 1717000000001, 1717000000001)`,
      );
      srcDb.exec(
        `INSERT INTO agent_credentials VALUES ('a3', 'Agent Three', 'enc-key-3', 'https://api.signaldock.io', 0, 1717000000002, 1717000000002)`,
      );
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_agent_credentials (` +
          `agent_id TEXT PRIMARY KEY, ` +
          `display_name TEXT NOT NULL, ` +
          `api_key_encrypted TEXT NOT NULL, ` +
          `api_base_url TEXT NOT NULL DEFAULT 'https://api.signaldock.io', ` +
          `classification TEXT, ` +
          `privacy_tier TEXT NOT NULL DEFAULT 'public', ` +
          `capabilities TEXT NOT NULL DEFAULT '[]', ` +
          `skills TEXT NOT NULL DEFAULT '[]', ` +
          `transport_config TEXT NOT NULL DEFAULT '{}', ` +
          `is_active INTEGER NOT NULL DEFAULT 1, ` +
          `last_used_at INTEGER, ` +
          `created_at INTEGER NOT NULL DEFAULT 0, ` +
          `updated_at INTEGER NOT NULL DEFAULT 0)`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11550('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare(
          'SELECT agent_id, api_key_encrypted FROM tasks_agent_credentials ORDER BY agent_id',
        )
        .all() as Array<{ agent_id: string; api_key_encrypted: string }>;
      expect(rows, 'all 3 agent_credentials rows must migrate').toHaveLength(3);
      expect(rows[0]?.agent_id).toBe('a1');
      expect(rows[0]?.api_key_encrypted).toBe('enc-key-1');
      expect(rows[2]?.agent_id).toBe('a3');
    } finally {
      tgt.close();
    }
  });

  it('migrates brain_release_links from tasks.db source (8 rows, P0 wrong-DB-map fix)', async () => {
    // Before T11550: mapping was in BRAIN_DB_MAP; tasks.db → TASKS_DB_MAP had no entry → skip.
    // After T11550: TASKS_DB_MAP has 'brain_release_links' → 'tasks_brain_release_links'.
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_release_links (` +
          `brain_entry_id TEXT, ` +
          `release_id TEXT NOT NULL, ` +
          `link_type TEXT NOT NULL, ` +
          `created_at TEXT NOT NULL DEFAULT '', ` +
          `created_by TEXT)`,
      );
      for (let i = 1; i <= 8; i++) {
        srcDb.exec(
          `INSERT INTO brain_release_links VALUES ('brain-${i}', 'rel-${i}', 'approved-by', '2026-01-0${(i % 9) + 1}T00:00:00Z', 'agent')`,
        );
      }
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE tasks_brain_release_links (` +
          `brain_entry_id TEXT, ` +
          `release_id TEXT NOT NULL, ` +
          `link_type TEXT NOT NULL CHECK (link_type IN ('approved-by','documented-in','derived-from','observed-in')), ` +
          `created_at TEXT NOT NULL DEFAULT (datetime('now')), ` +
          `created_by TEXT, ` +
          `PRIMARY KEY (brain_entry_id, release_id, link_type))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11550('tasks', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const count = (
        tgt.prepare('SELECT COUNT(*) AS c FROM tasks_brain_release_links').get() as { c: number }
      ).c;
      expect(count, 'all 8 brain_release_links rows must migrate').toBe(8);
    } finally {
      tgt.close();
    }
  });

  it('normalizes brain_decisions.outcome: accepted → success (1 row, P0 enum fix)', async () => {
    // Legacy 'accepted' not in consolidated CHECK enum (success|failure|mixed|pending).
    // Maps to 'success' (decision was accepted = successfully ratified).
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, outcome TEXT)`,
      );
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D11132', 'Test Decision', 'accepted')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-ok1', 'Success', 'success')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-ok2', 'Pending', 'pending')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-ok3', 'Null outcome', null)`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, ` +
          `outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','failure','mixed','pending')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11550('brain (project)', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, outcome FROM brain_decisions ORDER BY id')
        .all() as Array<{ id: string; outcome: string | null }>;
      expect(rows, 'all 4 rows must migrate (none dropped)').toHaveLength(4);
      expect(rows.find((r) => r.id === 'D11132')?.outcome, 'accepted → success').toBe('success');
      expect(rows.find((r) => r.id === 'D-ok1')?.outcome, 'success passthrough').toBe('success');
      expect(rows.find((r) => r.id === 'D-ok2')?.outcome, 'pending passthrough').toBe('pending');
      expect(rows.find((r) => r.id === 'D-ok3')?.outcome, 'null preserved').toBeNull();
    } finally {
      tgt.close();
    }
  });

  it('normalizes brain_decisions.decided_by: prime → agent (3 rows, P0 enum fix)', async () => {
    // Legacy 'prime' not in consolidated CHECK enum (owner|council|agent).
    // Maps to 'agent' (CLEO Prime is a system agent persona).
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, decided_by TEXT NOT NULL DEFAULT 'agent')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('T11025-alias-registration', 'Alias Reg', 'prime')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('T11027-envelope-compliance', 'Envelope', 'prime')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('T11030-integration-test', 'Integration', 'prime')`,
      );
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-owner', 'Owner Dec', 'owner')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-council', 'Council Dec', 'council')`);
      srcDb.exec(`INSERT INTO brain_decisions VALUES ('D-agent', 'Agent Dec', 'agent')`);
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_decisions (id TEXT PRIMARY KEY, title TEXT NOT NULL, ` +
          `decided_by TEXT NOT NULL DEFAULT 'agent' CHECK (decided_by IN ('owner','council','agent')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11550('brain (project)', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare('SELECT id, decided_by FROM brain_decisions ORDER BY id')
        .all() as Array<{ id: string; decided_by: string }>;
      expect(rows, 'all 6 rows must migrate (none dropped by CHECK)').toHaveLength(6);
      expect(
        rows.find((r) => r.id === 'T11025-alias-registration')?.decided_by,
        'prime → agent',
      ).toBe('agent');
      expect(
        rows.find((r) => r.id === 'T11027-envelope-compliance')?.decided_by,
        'prime → agent',
      ).toBe('agent');
      expect(
        rows.find((r) => r.id === 'T11030-integration-test')?.decided_by,
        'prime → agent',
      ).toBe('agent');
      expect(rows.find((r) => r.id === 'D-owner')?.decided_by, 'owner passthrough').toBe('owner');
      expect(rows.find((r) => r.id === 'D-council')?.decided_by, 'council passthrough').toBe(
        'council',
      );
      expect(rows.find((r) => r.id === 'D-agent')?.decided_by, 'agent passthrough').toBe('agent');
    } finally {
      tgt.close();
    }
  });

  it('brain_decisions 118→118: all 4 real-project rows survive with combined outcome+decided_by normalization', async () => {
    // Simulate the exact 4 rows from the real-project brain.db that were dropping.
    // D11132: outcome='accepted' (→ success), decided_by='agent' (ok), confidence='confirmed' (→ high via T11549 rule), decision_category='process' (→ other via T11549 rule)
    // T11025/T11027/T11030: outcome=null (ok), decided_by='prime' (→ agent), confidence='confirmed' (→ high), decision_category='technical' (→ other)
    const srcDb = new DatabaseSync(sourcePath);
    try {
      srcDb.exec(
        `CREATE TABLE brain_decisions (` +
          `id TEXT PRIMARY KEY, ` +
          `title TEXT NOT NULL, ` +
          `outcome TEXT, ` +
          `decided_by TEXT NOT NULL DEFAULT 'agent', ` +
          `confidence TEXT NOT NULL DEFAULT 'medium', ` +
          `decision_category TEXT NOT NULL DEFAULT 'architectural')`,
      );
      // D11132: outcome='accepted', decided_by='agent' (already canonical)
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('D11132', 'D11132', 'accepted', 'agent', 'confirmed', 'process')`,
      );
      // Three 'prime' rows with null outcome
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('T11025-alias-registration', 'T11025', null, 'prime', 'confirmed', 'technical')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('T11027-envelope-compliance', 'T11027', null, 'prime', 'confirmed', 'technical')`,
      );
      srcDb.exec(
        `INSERT INTO brain_decisions VALUES ('T11030-integration-test', 'T11030', null, 'prime', 'confirmed', 'technical')`,
      );
    } finally {
      srcDb.close();
    }

    const tgtDb = new DatabaseSync(targetProjectPath);
    try {
      tgtDb.exec(
        `CREATE TABLE brain_decisions (` +
          `id TEXT PRIMARY KEY, ` +
          `title TEXT NOT NULL, ` +
          `outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','failure','mixed','pending')), ` +
          `decided_by TEXT NOT NULL DEFAULT 'agent' CHECK (decided_by IN ('owner','council','agent')), ` +
          `confidence TEXT NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')), ` +
          `decision_category TEXT NOT NULL DEFAULT 'architectural' CHECK (decision_category IN ('architectural','agent_dispatch','other')))`,
      );
    } finally {
      tgtDb.close();
    }
    new DatabaseSync(targetGlobalPath).close();

    await runMigrateT11550('brain (project)', 'project');

    const tgt = new DatabaseSync(targetProjectPath, { readOnly: true });
    try {
      const rows = tgt
        .prepare(
          'SELECT id, outcome, decided_by, confidence, decision_category FROM brain_decisions ORDER BY id',
        )
        .all() as Array<{
        id: string;
        outcome: string | null;
        decided_by: string;
        confidence: string;
        decision_category: string;
      }>;
      expect(rows, 'all 4 rows must survive — brain_decisions 118→118').toHaveLength(4);

      const d11132 = rows.find((r) => r.id === 'D11132');
      expect(d11132?.outcome, 'D11132 outcome: accepted → success').toBe('success');
      expect(d11132?.decided_by, 'D11132 decided_by: agent passthrough').toBe('agent');
      expect(d11132?.confidence, 'D11132 confidence: confirmed → high').toBe('high');
      expect(d11132?.decision_category, 'D11132 decision_category: process → other').toBe('other');

      const t11025 = rows.find((r) => r.id === 'T11025-alias-registration');
      expect(t11025?.outcome, 'T11025 outcome: null preserved').toBeNull();
      expect(t11025?.decided_by, 'T11025 decided_by: prime → agent').toBe('agent');
      expect(t11025?.confidence, 'T11025 confidence: confirmed → high').toBe('high');
      expect(t11025?.decision_category, 'T11025 decision_category: technical → other').toBe(
        'other',
      );
    } finally {
      tgt.close();
    }
  });
});
