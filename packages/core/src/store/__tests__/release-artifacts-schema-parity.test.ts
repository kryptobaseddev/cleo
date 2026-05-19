/**
 * Schema parity guardrails for the T9509 provenance graph tables:
 *   `release_artifacts`, `brain_release_links`.
 *
 * Each test validates that:
 *   1. The migration SQL file creates the expected table with correct column names.
 *   2. The migration SQL defines the expected indexes.
 *   3. The Drizzle schema enums in tasks-schema.ts are consistent (value counts
 *      and required values).
 *   4. Both tables apply cleanly on a fresh in-memory tasks.db via the
 *      standard `migrateSanitized` pipeline.
 *   5. Polymorphic design invariant: adding a new `artifact_type` value requires
 *      zero schema changes (column is plain TEXT, not CHECK-constrained).
 *   6. Composite PKs are correct for both tables.
 *   7. Cross-DB soft FK pattern: `brain_entry_id` has no hard REFERENCES
 *      constraint (brain.db lives in a separate SQLite file).
 *
 * @task T9509
 * @epic T9491
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BRAIN_RELEASE_LINK_TYPES,
  brainReleaseLinks,
  RELEASE_ARTIFACT_TYPES,
  releaseArtifacts,
  releases,
} from '../tasks-schema.js';

vi.mock('../../logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-tasks migration folder. */
function migrationsDir(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

/** Read all migration SQL files from the drizzle-tasks folder (sorted). */
function getAllMigrationFiles(): Array<{ name: string; sql: string }> {
  const dir = migrationsDir();
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(dir, name, 'migration.sql'), 'utf-8'),
    }));
}

/** Find the migration SQL for a given T9509 table. Returns latest match. */
function getMigrationSql(tableHint: string): string {
  const files = getAllMigrationFiles();
  const match = files.filter(({ sql }) => sql.includes(tableHint)).pop();
  if (!match) throw new Error(`No migration found for table hint: ${tableHint}`);
  return match.sql;
}

// ---------------------------------------------------------------------------
// Section 1: Migration SQL content checks — `release_artifacts`
// ---------------------------------------------------------------------------

describe('T9509 release_artifacts migration SQL', () => {
  it('creates the release_artifacts table', () => {
    const sql = getMigrationSql('CREATE TABLE `release_artifacts`');
    expect(sql).toContain('CREATE TABLE `release_artifacts`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `release_artifacts`');
    const requiredCols = [
      'release_id',
      'artifact_type',
      'identifier',
      'version',
      'url',
      'published_at',
      'metadata',
    ];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares composite PRIMARY KEY on (release_id, artifact_type, identifier)', () => {
    const sql = getMigrationSql('CREATE TABLE `release_artifacts`');
    expect(sql).toContain('PRIMARY KEY');
    expect(sql).toContain('release_id');
    expect(sql).toContain('artifact_type');
    expect(sql).toContain('identifier');
  });

  it('references releases table via FK on release_id with CASCADE', () => {
    const sql = getMigrationSql('CREATE TABLE `release_artifacts`');
    expect(sql).toContain('REFERENCES `releases`(`id`)');
    expect(sql).toContain('ON DELETE CASCADE');
    expect(sql).toContain('release_id');
  });

  it('metadata column defaults to empty JSON object', () => {
    const sql = getMigrationSql('CREATE TABLE `release_artifacts`');
    expect(sql).toContain('metadata');
    expect(sql).toContain("DEFAULT '{}'");
  });

  it('artifact_type column is plain TEXT without CHECK constraint (polymorphic design)', () => {
    const sql = getMigrationSql('CREATE TABLE `release_artifacts`');
    // The column must be TEXT
    expect(sql).toContain('artifact_type');
    // Must NOT have a CHECK constraint that would prevent adding new artifact types
    // The polymorphic design requires zero schema changes for new types
    const hasCheckOnArtifactType =
      sql.includes('CHECK') && sql.includes('artifact_type') && sql.includes("'npm'");
    expect(
      hasCheckOnArtifactType,
      'artifact_type must not be CHECK-constrained — polymorphic design requires adding new types without schema changes',
    ).toBe(false);
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `release_artifacts`');
    const requiredIndexes = [
      'idx_release_artifacts_release_id',
      'idx_release_artifacts_artifact_type',
      'idx_release_artifacts_published_at',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2: Migration SQL content checks — `brain_release_links`
// ---------------------------------------------------------------------------

describe('T9509 brain_release_links migration SQL', () => {
  it('creates the brain_release_links table', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    expect(sql).toContain('CREATE TABLE `brain_release_links`');
  });

  it('has all required columns', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    const requiredCols = ['brain_entry_id', 'release_id', 'link_type', 'created_at', 'created_by'];
    for (const col of requiredCols) {
      expect(sql, `Missing column: ${col}`).toContain(`\`${col}\``);
    }
  });

  it('declares composite PRIMARY KEY on (brain_entry_id, release_id, link_type)', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    expect(sql).toContain('PRIMARY KEY');
    expect(sql).toContain('brain_entry_id');
    expect(sql).toContain('release_id');
    expect(sql).toContain('link_type');
  });

  it('references releases table via FK on release_id with CASCADE', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    expect(sql).toContain('REFERENCES `releases`(`id`)');
    expect(sql).toContain('ON DELETE CASCADE');
  });

  it('brain_entry_id has no REFERENCES constraint (cross-DB soft FK — brain.db is separate)', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    // brain_entry_id must NOT have a REFERENCES clause (cross-DB FK not enforceable)
    // The only REFERENCES in the table DDL should be for release_id
    const brainEntryLine = sql.split('\n').find((line) => line.includes('brain_entry_id'));
    expect(brainEntryLine).toBeDefined();
    // The brain_entry_id column line must not contain REFERENCES
    expect(
      brainEntryLine,
      'brain_entry_id must not have a REFERENCES constraint — brain.db is a separate SQLite file',
    ).not.toContain('REFERENCES');
  });

  it('created_at defaults to datetime("now")', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    expect(sql).toContain('created_at');
    expect(sql).toContain("datetime('now')");
  });

  it('created_by is nullable', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    // created_by must not have NOT NULL (nullable)
    const createdByLine = sql.split('\n').find((line) => line.includes('created_by'));
    expect(createdByLine).toBeDefined();
    expect(createdByLine, 'created_by must be nullable').not.toContain('NOT NULL');
  });

  it('defines all required indexes', () => {
    const sql = getMigrationSql('CREATE TABLE `brain_release_links`');
    const requiredIndexes = [
      'idx_brain_release_links_brain_entry_id',
      'idx_brain_release_links_release_id',
      'idx_brain_release_links_link_type',
    ];
    for (const idx of requiredIndexes) {
      expect(sql, `Missing index: ${idx}`).toContain(idx);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: Drizzle schema column-name parity checks
// ---------------------------------------------------------------------------

describe('T9509 Drizzle schema parity — releaseArtifacts', () => {
  it('exports the releaseArtifacts table with the correct column set', () => {
    const cols = Object.keys(releaseArtifacts);
    expect(cols).toContain('releaseId');
    expect(cols).toContain('artifactType');
    expect(cols).toContain('identifier');
    expect(cols).toContain('version');
    expect(cols).toContain('url');
    expect(cols).toContain('publishedAt');
    expect(cols).toContain('metadata');
  });
});

describe('T9509 Drizzle schema parity — brainReleaseLinks', () => {
  it('exports the brainReleaseLinks table with the correct column set', () => {
    const cols = Object.keys(brainReleaseLinks);
    expect(cols).toContain('brainEntryId');
    expect(cols).toContain('releaseId');
    expect(cols).toContain('linkType');
    expect(cols).toContain('createdAt');
    expect(cols).toContain('createdBy');
  });
});

// ---------------------------------------------------------------------------
// Section 4: Enum constant invariants
// ---------------------------------------------------------------------------

describe('T9509 enum constant invariants', () => {
  it('RELEASE_ARTIFACT_TYPES contains exactly the 7 supported archetypes', () => {
    expect(RELEASE_ARTIFACT_TYPES).toHaveLength(7);
    const required = [
      'npm',
      'cargo',
      'docker',
      'pypi',
      'github-release',
      'binary',
      'github-tag',
    ] as const;
    for (const t of required) {
      expect(RELEASE_ARTIFACT_TYPES, `Missing artifact type: ${t}`).toContain(t);
    }
  });

  it('BRAIN_RELEASE_LINK_TYPES contains exactly the 4 supported link types', () => {
    expect(BRAIN_RELEASE_LINK_TYPES).toHaveLength(4);
    const required = ['approved-by', 'documented-in', 'derived-from', 'observed-in'] as const;
    for (const t of required) {
      expect(BRAIN_RELEASE_LINK_TYPES, `Missing link type: ${t}`).toContain(t);
    }
  });

  it('RELEASE_ARTIFACT_TYPES polymorphic invariant — set is extensible without schema change', () => {
    // Verify that all values in the enum are simple strings — no CHECK constraint
    // coupling means a new value can be added to this array and inserted without ALTER TABLE.
    for (const t of RELEASE_ARTIFACT_TYPES) {
      expect(typeof t).toBe('string');
      expect(t.length).toBeGreaterThan(0);
    }
    // As long as the array contains all currently required types, extending it is safe.
    expect(RELEASE_ARTIFACT_TYPES).toContain('npm');
    expect(RELEASE_ARTIFACT_TYPES).toContain('cargo');
    expect(RELEASE_ARTIFACT_TYPES).toContain('docker');
  });

  it('BRAIN_RELEASE_LINK_TYPES covers all semantic relationship directions', () => {
    // approved-by: decision→release (BRAIN decision approved a change)
    expect(BRAIN_RELEASE_LINK_TYPES).toContain('approved-by');
    // documented-in: entry first documented in this release
    expect(BRAIN_RELEASE_LINK_TYPES).toContain('documented-in');
    // derived-from: release outcome produced this BRAIN learning
    expect(BRAIN_RELEASE_LINK_TYPES).toContain('derived-from');
    // observed-in: observation made about this release
    expect(BRAIN_RELEASE_LINK_TYPES).toContain('observed-in');
  });
});

// ---------------------------------------------------------------------------
// Section 5: T9686-B2 unification — legacy columns are now on `releases`
// ---------------------------------------------------------------------------

describe('T9686-B2 unification — legacy columns on canonical `releases` table', () => {
  it('exports `releases` with legacy columns merged from `release_manifests`', () => {
    expect(releases).toBeDefined();
    const cols = Object.keys(releases);
    // Legacy-pipeline columns that MUST be present on the unified table
    expect(cols).toContain('tasksJson');
    expect(cols).toContain('preparedAt');
    expect(cols).toContain('committedAt');
    expect(cols).toContain('taggedAt');
    expect(cols).toContain('pushedAt');
    expect(cols).toContain('gitTag');
  });
});

// ---------------------------------------------------------------------------
// Section 6: End-to-end migration apply on a fresh tasks.db
// ---------------------------------------------------------------------------

describe('T9509 fresh migration apply — both tables created', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t9509-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('applies all drizzle-tasks migrations and creates release_artifacts, brain_release_links', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    expect(() => migrateSanitized(db, { migrationsFolder })).not.toThrow();

    const tableNames = ['release_artifacts', 'brain_release_links'];
    for (const tableName of tableNames) {
      const row = nativeDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(tableName) as { name: string } | undefined;
      expect(row?.name, `Table '${tableName}' was not created`).toBe(tableName);
    }

    nativeDb.close();
  });

  it('release_artifacts table has correct columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-ra-col.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(release_artifacts)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const colNames = cols.map((c) => c.name);
    const colMap = new Map(cols.map((c) => [c.name, c]));

    const expectedCols = [
      'release_id',
      'artifact_type',
      'identifier',
      'version',
      'url',
      'published_at',
      'metadata',
    ];
    for (const col of expectedCols) {
      expect(colNames, `Column '${col}' missing from release_artifacts table`).toContain(col);
    }

    // release_id, artifact_type, identifier, version must be NOT NULL
    for (const notNullCol of ['release_id', 'artifact_type', 'identifier', 'version']) {
      expect(colMap.get(notNullCol)?.notnull, `${notNullCol} must be NOT NULL`).toBe(1);
    }

    // url and published_at must be nullable
    for (const nullableCol of ['url', 'published_at']) {
      expect(colMap.get(nullableCol)?.notnull, `${nullableCol} must be nullable`).toBe(0);
    }

    // metadata defaults to '{}'
    expect(colMap.get('metadata')?.dflt_value, 'metadata must default to {}').toBe("'{}'");

    nativeDb.close();
  });

  it('release_artifacts has correct composite PK on (release_id, artifact_type, identifier)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-ra-pk.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(release_artifacts)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

    expect(pkCols).toContain('release_id');
    expect(pkCols).toContain('artifact_type');
    expect(pkCols).toContain('identifier');
    expect(pkCols).toHaveLength(3);

    nativeDb.close();
  });

  it('brain_release_links table has correct columns after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-brl-col.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(brain_release_links)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const colNames = cols.map((c) => c.name);
    const colMap = new Map(cols.map((c) => [c.name, c]));

    const expectedCols = ['brain_entry_id', 'release_id', 'link_type', 'created_at', 'created_by'];
    for (const col of expectedCols) {
      expect(colNames, `Column '${col}' missing from brain_release_links table`).toContain(col);
    }

    // release_id and link_type must be NOT NULL
    expect(colMap.get('release_id')?.notnull, 'release_id must be NOT NULL').toBe(1);
    expect(colMap.get('link_type')?.notnull, 'link_type must be NOT NULL').toBe(1);
    expect(colMap.get('created_at')?.notnull, 'created_at must be NOT NULL').toBe(1);

    // brain_entry_id and created_by must be nullable (soft FK / optional agent ID)
    expect(colMap.get('brain_entry_id')?.notnull, 'brain_entry_id must be nullable').toBe(0);
    expect(colMap.get('created_by')?.notnull, 'created_by must be nullable').toBe(0);

    nativeDb.close();
  });

  it('brain_release_links has correct composite PK on (brain_entry_id, release_id, link_type)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-brl-pk.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const cols = nativeDb.prepare('PRAGMA table_info(brain_release_links)').all() as Array<{
      name: string;
      pk: number;
    }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name);

    expect(pkCols).toContain('brain_entry_id');
    expect(pkCols).toContain('release_id');
    expect(pkCols).toContain('link_type');
    expect(pkCols).toHaveLength(3);

    nativeDb.close();
  });

  it('all required indexes are present after migration', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-t9509-idx.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    const indexes = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((r) => r.name));

    const expectedIndexes = [
      // release_artifacts
      'idx_release_artifacts_release_id',
      'idx_release_artifacts_artifact_type',
      'idx_release_artifacts_published_at',
      // brain_release_links
      'idx_brain_release_links_brain_entry_id',
      'idx_brain_release_links_release_id',
      'idx_brain_release_links_link_type',
    ];

    for (const idx of expectedIndexes) {
      expect(indexNames, `Index '${idx}' missing after migration`).toContain(idx);
    }

    nativeDb.close();
  });

  it('polymorphic: inserting a hypothetical new artifact_type succeeds without schema change', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-ra-poly.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Disable FKs for data insertion tests: the `releases` table has an FK to
    // `pull_requests` which is created by T9507 (not in this worktree branch).
    // FK enforcement is off by default in SQLite — this pragma restores that.
    nativeDb.exec('PRAGMA foreign_keys = OFF');

    // Insert a release row first (required by the FK)
    nativeDb
      .prepare(
        `INSERT INTO releases (id, version, scheme, channel, release_kind, status, created_at)
         VALUES ('test-release-id', 'v0.0.1-poly-test', 'calver', 'latest', 'regular', 'planned', datetime('now'))`,
      )
      .run();

    // Insert an artifact with a hypothetical new type ('gem') not in RELEASE_ARTIFACT_TYPES
    // This MUST succeed without any schema change — proving the polymorphic design.
    expect(() => {
      nativeDb
        .prepare(
          `INSERT INTO release_artifacts (release_id, artifact_type, identifier, version, metadata)
           VALUES ('test-release-id', 'gem', 'cleo-gem', '1.0.0', '{}')`,
        )
        .run();
    }).not.toThrow();

    const row = nativeDb
      .prepare(
        `SELECT artifact_type FROM release_artifacts WHERE release_id = 'test-release-id' AND identifier = 'cleo-gem'`,
      )
      .get() as { artifact_type: string } | undefined;
    expect(row?.artifact_type).toBe('gem');

    nativeDb.close();
  });

  it('brain_release_links allows multiple link_type values for the same (brain_entry_id, release_id) pair', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-brl-multi.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Disable FKs for data insertion tests: the `releases` table has an FK to
    // `pull_requests` which is created by T9507 (not in this worktree branch).
    nativeDb.exec('PRAGMA foreign_keys = OFF');

    // Insert a release row first
    nativeDb
      .prepare(
        `INSERT INTO releases (id, version, scheme, channel, release_kind, status, created_at)
         VALUES ('test-rel-2', 'v0.0.2-brl-test', 'calver', 'latest', 'regular', 'planned', datetime('now'))`,
      )
      .run();

    const brainEntryId = 'brain-decision-abc123';

    // Insert two link rows with the same (brain_entry_id, release_id) but different link_type
    nativeDb
      .prepare(
        `INSERT INTO brain_release_links (brain_entry_id, release_id, link_type)
         VALUES (?, 'test-rel-2', 'approved-by')`,
      )
      .run(brainEntryId);
    nativeDb
      .prepare(
        `INSERT INTO brain_release_links (brain_entry_id, release_id, link_type)
         VALUES (?, 'test-rel-2', 'documented-in')`,
      )
      .run(brainEntryId);

    const rows = nativeDb
      .prepare(
        `SELECT link_type FROM brain_release_links WHERE brain_entry_id = ? AND release_id = 'test-rel-2'`,
      )
      .all(brainEntryId) as Array<{ link_type: string }>;

    expect(rows).toHaveLength(2);
    const linkTypes = new Set(rows.map((r) => r.link_type));
    expect(linkTypes).toContain('approved-by');
    expect(linkTypes).toContain('documented-in');

    nativeDb.close();
  });

  it('brain_release_links allows NULL brain_entry_id (soft FK SET NULL semantics)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-brl-null.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Disable FKs for data insertion tests: the `releases` table has an FK to
    // `pull_requests` which is created by T9507 (not in this worktree branch).
    nativeDb.exec('PRAGMA foreign_keys = OFF');

    // Insert a release row
    nativeDb
      .prepare(
        `INSERT INTO releases (id, version, scheme, channel, release_kind, status, created_at)
         VALUES ('test-rel-3', 'v0.0.3-brl-null', 'calver', 'latest', 'regular', 'planned', datetime('now'))`,
      )
      .run();

    // Insert a link with NULL brain_entry_id (simulating SET NULL after BRAIN entry deletion)
    expect(() => {
      nativeDb
        .prepare(
          `INSERT INTO brain_release_links (brain_entry_id, release_id, link_type)
           VALUES (NULL, 'test-rel-3', 'observed-in')`,
        )
        .run();
    }).not.toThrow();

    const row = nativeDb
      .prepare(`SELECT brain_entry_id FROM brain_release_links WHERE release_id = 'test-rel-3'`)
      .get() as { brain_entry_id: string | null } | undefined;
    expect(row?.brain_entry_id).toBeNull();

    nativeDb.close();
  });

  it('T9686-B2: legacy `release_manifests` is dropped + columns merged into `releases`', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const { reconcileJournal, migrateSanitized } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'tasks-t9509-legacy.db');
    const nativeDb = openNativeDatabase(dbPath);
    const db = drizzle({ client: nativeDb });
    const migrationsFolder = migrationsDir();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');
    migrateSanitized(db, { migrationsFolder });

    // Legacy `release_manifests` must NO LONGER exist after T9686-B2.
    const row = nativeDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='release_manifests'")
      .get() as { name: string } | undefined;
    expect(row, 'release_manifests must be dropped by T9686-B2').toBeUndefined();

    // The unified `releases` table now carries the legacy columns.
    const cols = nativeDb.prepare('PRAGMA table_info(releases)').all() as Array<{
      name: string;
    }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('version');
    expect(colNames).toContain('tasks_json');
    expect(colNames).toContain('status');

    nativeDb.close();
  });
});
