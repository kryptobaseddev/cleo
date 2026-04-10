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
