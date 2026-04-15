/**
 * Tests for Scenario 3 in reconcileJournal: auto-reconciling partially-applied
 * migrations whose DDL columns already exist in the database but whose journal
 * entry was never written.
 *
 * Root cause: T417 migration (brain_observations.agent column) was cherry-picked
 * from a worktree. The ALTER TABLE succeeded but the journal INSERT never ran,
 * causing every subsequent `cleo observe` / `cleo memory find` to crash with
 * "duplicate column name".
 *
 * @task T417
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-brain migrations folder relative to this test file. */
function getBrainMigrationsFolder(): string {
  // Test lives at: packages/core/src/store/__tests__/
  // Migrations at: packages/core/migrations/drizzle-brain/
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-brain');
}

describe('reconcileJournal — Scenario 3 (T417: partially-applied migration)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-reconcile-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('inserts a journal entry when the column exists but the entry is missing', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'brain-partial.db');
    const nativeDb = openNativeDatabase(dbPath);
    const migrationsFolder = getBrainMigrationsFolder();

    // Simulate a brain.db that had the initial migration applied properly (schema
    // exists, journal has the baseline hash) but the T417 migration was applied
    // outside the journal (column added but journal entry never written).

    // 1. Create the full initial schema from the initial migration SQL directly
    //    (avoids pulling in the full Drizzle bootstrap; we just need the table).
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "brain_decisions" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "decision" text NOT NULL,
        "rationale" text NOT NULL,
        "confidence" text NOT NULL,
        "outcome" text,
        "alternatives_json" text,
        "context_epic_id" text,
        "context_task_id" text,
        "context_phase" text,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        "updated_at" text
      );
      CREATE TABLE IF NOT EXISTS "brain_observations" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "title" text NOT NULL,
        "subtitle" text,
        "narrative" text,
        "facts_json" text,
        "concepts_json" text,
        "project" text,
        "files_read_json" text,
        "files_modified_json" text,
        "source_session_id" text,
        "source_type" text DEFAULT 'agent' NOT NULL,
        "content_hash" text,
        "discovery_tokens" integer,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        "updated_at" text
      );
    `);

    // 2. Manually apply the T417 ALTER TABLE (simulates cherry-pick from worktree).
    nativeDb.exec('ALTER TABLE "brain_observations" ADD COLUMN "agent" text');

    // 3. Create the journal table and insert ONLY the baseline + indexes migration
    //    hashes — intentionally omitting the T417 hash.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const allMigrations = readMigrationFiles({ migrationsFolder });

    // Find the T417 migration by name
    const t417 = allMigrations.find((m) => m.name.includes('t417'));
    expect(t417).toBeDefined();

    // Insert all migrations EXCEPT T417 into the journal
    for (const m of allMigrations) {
      if (m.hash === t417!.hash) continue;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${m.hash}', ${m.folderMillis})`,
      );
    }

    // 4. Verify the journal does NOT contain the T417 entry before reconcile.
    const beforeEntries = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations"')
      .all() as Array<{ hash: string }>;
    expect(beforeEntries.some((e) => e.hash === t417!.hash)).toBe(false);

    // 5. Run reconcileJournal — Scenario 3 must detect and insert the T417 entry.
    reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

    // 6. Journal must now contain the T417 entry.
    const afterEntries = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations"')
      .all() as Array<{ hash: string }>;
    expect(afterEntries.some((e) => e.hash === t417!.hash)).toBe(true);

    nativeDb.close();
  });

  it('does NOT insert a journal entry when the column is genuinely missing', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');

    const dbPath = join(tempDir, 'brain-no-col.db');
    const nativeDb = openNativeDatabase(dbPath);
    const migrationsFolder = getBrainMigrationsFolder();

    // Create the schema WITHOUT the agent column.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "brain_decisions" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "decision" text NOT NULL,
        "rationale" text NOT NULL,
        "confidence" text NOT NULL,
        "outcome" text,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "brain_observations" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "title" text NOT NULL,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      );
    `);

    // Create the journal with baseline migrations but NOT T417.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const allMigrations = readMigrationFiles({ migrationsFolder });
    const t417 = allMigrations.find((m) => m.name.includes('t417'));
    expect(t417).toBeDefined();

    for (const m of allMigrations) {
      if (m.hash === t417!.hash) continue;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${m.hash}', ${m.folderMillis})`,
      );
    }

    // Run reconcileJournal — since the column does NOT exist, Scenario 3 must
    // NOT insert the T417 entry (leave it for Drizzle to run normally).
    reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

    const entries = nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{
      hash: string;
    }>;
    expect(entries.some((e) => e.hash === t417!.hash)).toBe(false);

    nativeDb.close();
  });

  it('migrateWithRetry does not throw after reconcileJournal inserts the missing entry', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal, migrateWithRetry } = await import('../migration-manager.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');
    const brainSchema = await import('../brain-schema.js');

    const dbPath = join(tempDir, 'brain-full.db');
    const nativeDb = openNativeDatabase(dbPath);
    const migrationsFolder = getBrainMigrationsFolder();

    // Build the complete brain schema with the agent column already present.
    // This mirrors a real production brain.db after T417 was cherry-picked.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "brain_decisions" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "decision" text NOT NULL,
        "rationale" text NOT NULL,
        "confidence" text NOT NULL,
        "outcome" text,
        "alternatives_json" text,
        "context_epic_id" text,
        "context_task_id" text,
        "context_phase" text,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        "updated_at" text
      );
      CREATE TABLE IF NOT EXISTS "brain_learnings" (
        "id" text PRIMARY KEY,
        "insight" text NOT NULL,
        "source" text NOT NULL,
        "confidence" real NOT NULL,
        "actionable" integer DEFAULT false NOT NULL,
        "application" text,
        "applicable_types_json" text,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        "updated_at" text
      );
      CREATE TABLE IF NOT EXISTS "brain_memory_links" (
        "memory_type" text NOT NULL,
        "memory_id" text NOT NULL,
        "task_id" text NOT NULL,
        "link_type" text NOT NULL,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        CONSTRAINT "brain_memory_links_pk" PRIMARY KEY("memory_type", "memory_id", "task_id", "link_type")
      );
      CREATE TABLE IF NOT EXISTS "brain_observations" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "title" text NOT NULL,
        "subtitle" text,
        "narrative" text,
        "facts_json" text,
        "concepts_json" text,
        "project" text,
        "files_read_json" text,
        "files_modified_json" text,
        "source_session_id" text,
        "source_type" text DEFAULT 'agent' NOT NULL,
        "content_hash" text,
        "discovery_tokens" integer,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        "updated_at" text
      );
      CREATE TABLE IF NOT EXISTS "brain_page_edges" (
        "from_id" text NOT NULL,
        "to_id" text NOT NULL,
        "edge_type" text NOT NULL,
        "weight" real DEFAULT 1,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        CONSTRAINT "brain_page_edges_pk" PRIMARY KEY("from_id", "to_id", "edge_type")
      );
      CREATE TABLE IF NOT EXISTS "brain_page_nodes" (
        "id" text PRIMARY KEY,
        "node_type" text NOT NULL,
        "label" text NOT NULL,
        "metadata_json" text,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "brain_patterns" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "pattern" text NOT NULL,
        "context" text NOT NULL,
        "frequency" integer DEFAULT 1 NOT NULL,
        "success_rate" real,
        "impact" text,
        "anti_pattern" text,
        "mitigation" text,
        "examples_json" text DEFAULT '[]',
        "extracted_at" text DEFAULT (datetime('now')) NOT NULL,
        "updated_at" text
      );
      CREATE TABLE IF NOT EXISTS "brain_schema_meta" (
        "key" text PRIMARY KEY,
        "value" text NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "brain_sticky_notes" (
        "id" text PRIMARY KEY,
        "content" text NOT NULL,
        "created_at" text DEFAULT (datetime('now')) NOT NULL,
        "updated_at" text,
        "tags_json" text,
        "status" text DEFAULT 'active' NOT NULL,
        "converted_to_json" text,
        "color" text,
        "priority" text,
        "source_type" text DEFAULT 'sticky-note'
      );
    `);

    // T417: agent column already applied out-of-band.
    nativeDb.exec('ALTER TABLE "brain_observations" ADD COLUMN "agent" text');

    // Journal: all migrations except T417.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
      )
    `);
    const { readMigrationFiles } = await import('drizzle-orm/migrator');
    const allMigrations = readMigrationFiles({ migrationsFolder });
    const t417 = allMigrations.find((m) => m.name.includes('t417'));
    expect(t417).toBeDefined();

    for (const m of allMigrations) {
      if (m.hash === t417!.hash) continue;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${m.hash}', ${m.folderMillis})`,
      );
    }

    // reconcileJournal fills in the missing T417 entry.
    reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

    // migrateWithRetry must NOT throw "duplicate column name".
    const db = drizzle(nativeDb, { schema: brainSchema });
    expect(() =>
      migrateWithRetry(db, migrationsFolder, nativeDb, 'brain_decisions', 'brain'),
    ).not.toThrow();

    nativeDb.close();
  });

  it('isDuplicateColumnError correctly identifies duplicate column errors', async () => {
    const { isDuplicateColumnError } = await import('../migration-manager.js');

    expect(isDuplicateColumnError(new Error('duplicate column name: agent'))).toBe(true);
    expect(isDuplicateColumnError(new Error('DUPLICATE COLUMN NAME: foo'))).toBe(true);
    expect(isDuplicateColumnError(new Error('Duplicate column name in table'))).toBe(true);
    expect(isDuplicateColumnError(new Error('SQLITE_BUSY: database is locked'))).toBe(false);
    expect(isDuplicateColumnError(new Error('no such table: tasks'))).toBe(false);
    expect(isDuplicateColumnError('not an error')).toBe(false);
    expect(isDuplicateColumnError(null)).toBe(false);
  });
});

/**
 * Tests for Scenario 2 Sub-case A and Sub-case B in reconcileJournal.
 *
 * Sub-case A: DB is ahead — all local hashes are present in DB, DB has extras.
 *   Root cause (T571): an older global install would delete+re-seed, causing an
 *   infinite WARN cycle. Fix: detect forward-compat and skip reconciliation.
 *
 * Sub-case B: Stale hashes from genuinely old CLEO — at least one local hash is
 *   MISSING from DB, meaning the hash algorithm changed.
 *   Root cause (T632): the original fix deleted the journal and re-inserted ALL
 *   local migrations as applied WITHOUT running their SQL, leaving columns missing.
 *   Fix: probeAndMarkApplied — mark a migration applied ONLY if its DDL targets
 *   already exist in the schema; leave the rest for Drizzle's migrate() to run.
 *
 * @task T632
 * @task T571
 */
describe('reconcileJournal — Scenario 2 (T632: Sub-case A/B stale journal discrimination)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-scenario2-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('Sub-case A: does NOT modify journal when DB is ahead of this install', async () => {
    // Simulate: DB has journal entries for migrations this install does not know about.
    // This is the forward-compatibility scenario (older global binary, newer DB).
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const dbPath = join(tempDir, 'brain-subcase-a.db');
    const nativeDb = openNativeDatabase(dbPath);
    const migrationsFolder = getBrainMigrationsFolder();

    const allMigrations = readMigrationFiles({ migrationsFolder });
    // Simulate a full-version DB that knows about all migrations.
    // "This install" will only know about the first migration.
    const installKnows = allMigrations.slice(0, 1);

    // Create schema (just needs brain_decisions to exist).
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "brain_decisions" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "decision" text NOT NULL,
        "rationale" text NOT NULL,
        "confidence" text NOT NULL,
        "outcome" text,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      )
    `);

    // Journal has ALL migrations (written by newer install).
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    for (const m of allMigrations) {
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }

    const countBefore = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;

    // Run reconcileJournal with a migrations folder that only has installKnows[0].
    // We simulate this by creating a temp subfolder with just that one migration.
    const { mkdtemp: mkdtemp2, cp, rm: rmTemp } = await import('node:fs/promises');
    const fakeInstallDir = await mkdtemp2(join(tmpdir(), 'fake-install-'));
    try {
      const { join: pathJoin } = await import('node:path');
      const { cp: cpFn } = await import('node:fs/promises');
      // Copy only the first migration folder.
      const firstMigName = installKnows[0]!.name;
      await cpFn(
        pathJoin(migrationsFolder, firstMigName!),
        pathJoin(fakeInstallDir, firstMigName!),
        { recursive: true },
      );
      // Copy meta files if present (journal.json, etc.)
      const { existsSync } = await import('node:fs');
      for (const meta of ['journal.json', '_journal.json']) {
        const src = pathJoin(migrationsFolder, meta);
        if (existsSync(src)) {
          await cpFn(src, pathJoin(fakeInstallDir, meta));
        }
      }

      // Reconcile from the old install's perspective.
      reconcileJournal(nativeDb, fakeInstallDir, 'brain_decisions', 'brain');
    } finally {
      await rmTemp(fakeInstallDir, { recursive: true, force: true });
    }

    // Journal must NOT have been modified — Sub-case A must preserve all entries.
    const countAfter = (
      nativeDb.prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"').get() as {
        cnt: number;
      }
    ).cnt;
    expect(countAfter).toBe(countBefore);

    nativeDb.close();
  });

  it('Sub-case B: marks migrations applied only when their DDL targets already exist (T632 root-cause fix)', async () => {
    // Simulate: DB has stale hashes from an older CLEO version (hash algorithm changed).
    // The schema already has some columns applied (e.g., from direct ALTER TABLE),
    // but the journal hashes do not match any current migration.
    //
    // The old bandaid: mark ALL local migrations applied → columns assumed present.
    // The root-cause fix: probe each migration's DDL; only mark applied if columns exist.
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const dbPath = join(tempDir, 'brain-subcase-b.db');
    const nativeDb = openNativeDatabase(dbPath);
    const migrationsFolder = getBrainMigrationsFolder();

    const allMigrations = readMigrationFiles({ migrationsFolder });

    // Find T417 (agent column) migration to verify probe behaviour.
    const t417 = allMigrations.find((m) => m.name?.includes('t417'));
    expect(t417).toBeDefined();

    // Create the schema with brain_decisions (existence check table).
    // brain_observations WITHOUT the `agent` column — simulates that T417 has
    // NOT been applied yet on this DB despite the stale journal claiming otherwise.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "brain_decisions" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "decision" text NOT NULL,
        "rationale" text NOT NULL,
        "confidence" text NOT NULL,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "brain_observations" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "title" text NOT NULL,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      )
    `);

    // Journal with STALE hashes (not matching any current migration).
    // This is the genuine Sub-case B: hashes changed due to algorithm update.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    // Insert fake stale hashes — none match current migration hashes.
    nativeDb.exec(`
      INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name")
        VALUES ('stale_hash_aaaaaa', 1000000, 'old_initial'),
               ('stale_hash_bbbbbb', 1000001, 'old_second')
    `);

    // Confirm: at least one local hash is missing from DB (Sub-case B condition).
    const dbHashes = new Set(
      (
        nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{
          hash: string;
        }>
      ).map((e) => e.hash),
    );
    const allLocalPresent = allMigrations.every((m) => dbHashes.has(m.hash));
    expect(allLocalPresent).toBe(false); // confirms we are in Sub-case B

    // Run reconcileJournal — Sub-case B fires, journal is cleared and probed.
    reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

    // After reconciliation the stale hashes must be gone.
    const afterEntries = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations"')
      .all() as Array<{ hash: string }>;

    expect(afterEntries.some((e) => e.hash === 'stale_hash_aaaaaa')).toBe(false);
    expect(afterEntries.some((e) => e.hash === 'stale_hash_bbbbbb')).toBe(false);

    // T417 migration targets brain_observations.agent — the column is MISSING, so
    // probeAndMarkApplied must NOT mark it applied. Drizzle migrate() will run it.
    expect(afterEntries.some((e) => e.hash === t417!.hash)).toBe(false);
  });

  it('Sub-case B: marks migration applied when its DDL columns already exist', async () => {
    // Same Sub-case B setup, but T417 column is already present.
    // probeAndMarkApplied MUST mark T417 applied (column exists → skip Drizzle).
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const dbPath = join(tempDir, 'brain-subcase-b-present.db');
    const nativeDb = openNativeDatabase(dbPath);
    const migrationsFolder = getBrainMigrationsFolder();

    const allMigrations = readMigrationFiles({ migrationsFolder });
    const t417 = allMigrations.find((m) => m.name?.includes('t417'));
    expect(t417).toBeDefined();

    // Create schema WITH brain_observations.agent column already present.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "brain_decisions" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "decision" text NOT NULL,
        "rationale" text NOT NULL,
        "confidence" text NOT NULL,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "brain_observations" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "title" text NOT NULL,
        "agent" text,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      )
    `);

    // Stale journal (Sub-case B).
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    nativeDb.exec(`
      INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name")
        VALUES ('stale_hash_cccccc', 1000000, 'old_initial')
    `);

    // Run reconcileJournal.
    reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

    // T417 column (agent) exists → probeAndMarkApplied must insert the journal entry.
    const afterEntries = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations"')
      .all() as Array<{ hash: string }>;
    expect(afterEntries.some((e) => e.hash === t417!.hash)).toBe(true);

    nativeDb.close();
  });

  it('Sub-case B: leaves migration unjournaled when table targeted by CREATE TABLE is missing', async () => {
    // Verifies probeAndMarkApplied does NOT mark a CREATE TABLE migration applied
    // when the table does not yet exist in the DB.
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const dbPath = join(tempDir, 'brain-subcase-b-create.db');
    const nativeDb = openNativeDatabase(dbPath);
    const migrationsFolder = getBrainMigrationsFolder();

    const allMigrations = readMigrationFiles({ migrationsFolder });

    // Find any migration that has a CREATE TABLE (e.g., T528 which recreates brain_page_edges).
    const t528 = allMigrations.find((m) => m.name?.includes('t528'));
    expect(t528).toBeDefined();

    // Only create brain_decisions (the existence table), NOT brain_page_nodes/brain_page_edges.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "brain_decisions" (
        "id" text PRIMARY KEY,
        "type" text NOT NULL,
        "decision" text NOT NULL,
        "rationale" text NOT NULL,
        "confidence" text NOT NULL,
        "created_at" text DEFAULT (datetime('now')) NOT NULL
      )
    `);

    // Stale journal (Sub-case B).
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    nativeDb.exec(
      `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('stale_hash_dddddd', 1000000, 'old_initial')`,
    );

    reconcileJournal(nativeDb, migrationsFolder, 'brain_decisions', 'brain');

    // T528 targets brain_page_nodes.quality_score and brain_page_edges — both tables
    // are absent, so T528 must NOT be marked applied.
    const afterEntries = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations"')
      .all() as Array<{ hash: string }>;
    expect(afterEntries.some((e) => e.hash === t528!.hash)).toBe(false);

    nativeDb.close();
  });
});
