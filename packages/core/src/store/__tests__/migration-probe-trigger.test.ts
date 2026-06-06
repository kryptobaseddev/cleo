/**
 * Regression tests for the migration journal probe.
 *
 * These tests pin two bug-fix behaviours that prevent CLEO from entering a
 * boot-loop when a previously-applied migration is missing from the drizzle
 * journal:
 *
 * 1. `probeAndMarkApplied` must detect `CREATE TRIGGER` targets and mark
 *    trigger-only migrations as applied when the triggers already exist
 *    in `sqlite_master`. Pre-fix, only ALTER/CREATE TABLE/CREATE INDEX were
 *    probed — trigger-only migrations like `t877-pipeline-stage-invariants`
 *    were never journaled and got re-run on every cleo invocation, throwing
 *    "trigger already exists".
 *
 * 2. The `t033-connection-health` migration must be idempotent against an
 *    empty source `release_manifests` table. The original INSERT FROM
 *    statement worked, but when paired with a partial-run scenario where
 *    journal writes were rolled back, drizzle re-ran the migration. The
 *    `WHERE EXISTS` guard makes the INSERT a no-op when the source is
 *    empty so the table rebuild still completes.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getTasksMigrationsFolder(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-tasks');
}

function getProjectMigrationsFolder(): string {
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-cleo-project');
}

describe('reconcileJournal — CREATE TRIGGER probe', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-probe-trigger-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks a trigger-only migration as applied when the triggers already exist', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = getTasksMigrationsFolder();
    const allMigrations = readMigrationFiles({ migrationsFolder });
    const triggerMig = allMigrations.find((m) => m.name?.includes('t877'));
    expect(triggerMig, 'expected t877 trigger migration to exist').toBeDefined();

    const dbPath = join(tempDir, 'tasks-trigger.db');
    const nativeDb = openNativeDatabase(dbPath);

    // Build minimal schema the triggers reference.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id text PRIMARY KEY,
        title text NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        pipeline_stage text
      );
      CREATE TABLE IF NOT EXISTS lifecycle_stages (
        id text PRIMARY KEY,
        stage_name text NOT NULL
      );
    `);

    // Pre-create every trigger this migration declares so the probe sees them
    // as already present. drizzle exposes the parsed statement array on the
    // migration meta object.
    const stmts = Array.isArray(triggerMig!.sql) ? triggerMig!.sql : [triggerMig!.sql ?? ''];
    for (const stmt of stmts) {
      if (/CREATE\s+TRIGGER/i.test(stmt)) {
        nativeDb.exec(stmt);
      }
    }

    // Bootstrap the journal table and insert every OTHER migration's entry so
    // only t877 is unjournaled.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    for (const m of allMigrations) {
      if (m.hash === triggerMig!.hash) continue;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }

    const beforeRow = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations" WHERE hash=?')
      .get(triggerMig!.hash);
    expect(beforeRow, 'trigger migration must not be journaled before reconcile').toBeUndefined();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks', 'tasks');

    const afterRow = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations" WHERE hash=?')
      .get(triggerMig!.hash);
    expect(
      afterRow,
      'probeAndMarkApplied must journal trigger-only migration when triggers exist',
    ).toBeDefined();

    nativeDb.close();
  });
});

describe('reconcileJournal — strips SQL comments before DDL-target extraction', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-probe-comment-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks t11538 applied even though its prose comment contains "CREATE TABLE half"', async () => {
    // Root-cause regression (fix/T-migration-probe-comment-strip):
    //
    // t11538's header comment reads "…the project-side CREATE TABLE half of that
    // move…". Pre-fix, probeAndMarkApplied scanned the RAW SQL, so createTableRegex
    // captured the phantom table `half`. tableExists('half') is false →
    // allTablesPresent false → the migration was NEVER journaled even though its
    // real tables (nexus_nodes, …) already exist → Drizzle re-ran its bare
    // `CREATE TABLE nexus_nodes` → "table already exists" → poisoned open →
    // "Task database not initialized". The fix strips comments first.
    const { openNativeDatabase } = await import('../sqlite.js');
    const { reconcileJournal } = await import('../migration-manager.js');
    const { readMigrationFiles } = await import('drizzle-orm/migrator');

    const migrationsFolder = getProjectMigrationsFolder();
    const allMigrations = readMigrationFiles({ migrationsFolder });
    const nexusMig = allMigrations.find((m) => m.name?.includes('t11538'));
    expect(nexusMig, 'expected t11538 nexus-graph migration to exist').toBeDefined();

    // Sanity-check the fixture still carries the phantom-trigger comment text.
    const migSql = (Array.isArray(nexusMig!.sql) ? nexusMig!.sql : [nexusMig!.sql ?? '']).join(
      '\n',
    );
    expect(
      /CREATE\s+TABLE\s+half/i.test(migSql),
      'fixture precondition: t11538 prose comment must contain "CREATE TABLE half"',
    ).toBe(true);

    const dbPath = join(tempDir, 'cleo-project.db');
    const nativeDb = openNativeDatabase(dbPath);

    // The project-scope existence table reconcileJournal checks for is tasks_tasks.
    nativeDb.exec(`CREATE TABLE IF NOT EXISTS tasks_tasks (id text PRIMARY KEY);`);

    // Fully apply the migration's DDL (it is purely additive CREATE TABLE +
    // CREATE INDEX — no rename, no trigger) so the schema genuinely already
    // contains every table AND index the probe checks for. This mirrors the live
    // poisoned state: the DDL ran but the journal entry was never written.
    const stmts = Array.isArray(nexusMig!.sql) ? nexusMig!.sql : [nexusMig!.sql ?? ''];
    for (const stmt of stmts) {
      if (/CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)/i.test(stmt)) {
        nativeDb.exec(stmt);
      }
    }
    expect(
      nativeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='nexus_nodes'")
        .get(),
      'fixture: nexus_nodes must exist before reconcile',
    ).toBeDefined();
    // …and the phantom `half` table must NOT exist (it never gets created).
    expect(
      nativeDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='half'").get(),
      'fixture: phantom "half" table must never exist',
    ).toBeUndefined();

    // Journal every migration EXCEPT t11538 so it is the only un-applied one.
    nativeDb.exec(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash text NOT NULL,
        created_at numeric,
        name text,
        applied_at TEXT
      )
    `);
    for (const m of allMigrations) {
      if (m.hash === nexusMig!.hash) continue;
      nativeDb.exec(
        `INSERT INTO "__drizzle_migrations" ("hash", "created_at", "name") VALUES ('${m.hash}', ${m.folderMillis}, '${m.name ?? ''}')`,
      );
    }

    const before = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations" WHERE hash=?')
      .get(nexusMig!.hash);
    expect(before, 't11538 must NOT be journaled before reconcile').toBeUndefined();

    reconcileJournal(nativeDb, migrationsFolder, 'tasks_tasks', 'dual-scope-db[project]');

    const after = nativeDb
      .prepare('SELECT hash FROM "__drizzle_migrations" WHERE hash=?')
      .get(nexusMig!.hash);
    // With the comment-strip fix this is journaled (phantom `half` ignored);
    // WITHOUT the fix it stays undefined (phantom `half` probe fails).
    expect(
      after,
      'probeAndMarkApplied must journal t11538 once SQL comments are stripped (phantom "half" ignored)',
    ).toBeDefined();

    nativeDb.close();
  });
});

describe('t033 release_manifests rebuild idempotency', () => {
  it('INSERT … FROM release_manifests WHERE EXISTS is a no-op when source is empty', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');

    const tempDir = mkdtempSync(join(tmpdir(), 'cleo-t033-empty-'));
    try {
      const dbPath = join(tempDir, 't033.db');
      const nativeDb = openNativeDatabase(dbPath);

      // Recreate the legacy source schema + an empty destination matching the new shape.
      nativeDb.exec(`
        CREATE TABLE release_manifests (
          id text PRIMARY KEY,
          version text NOT NULL UNIQUE,
          status text DEFAULT 'draft' NOT NULL,
          pipeline_id text,
          epic_id text,
          tasks_json text DEFAULT '[]' NOT NULL,
          changelog text,
          notes text,
          previous_version text,
          commit_sha text,
          git_tag text,
          npm_dist_tag text,
          created_at text NOT NULL,
          prepared_at text,
          committed_at text,
          tagged_at text,
          pushed_at text
        );
        CREATE TABLE release_manifests_new (
          id text PRIMARY KEY,
          version text NOT NULL UNIQUE,
          status text DEFAULT 'draft' NOT NULL,
          pipeline_id text,
          epic_id text,
          tasks_json text DEFAULT '[]' NOT NULL,
          changelog text,
          notes text,
          previous_version text,
          commit_sha text,
          git_tag text,
          npm_dist_tag text,
          created_at text NOT NULL,
          prepared_at text,
          committed_at text,
          tagged_at text,
          pushed_at text
        );
      `);

      // Verify the source is empty.
      const srcCount = nativeDb.prepare('SELECT COUNT(*) AS n FROM release_manifests').get() as {
        n: number;
      };
      expect(srcCount.n).toBe(0);

      // Execute the migration's idempotent INSERT.
      expect(() => {
        nativeDb.exec(`
          INSERT INTO \`release_manifests_new\` (\`id\`, \`version\`, \`status\`, \`pipeline_id\`, \`epic_id\`, \`tasks_json\`, \`changelog\`, \`notes\`, \`previous_version\`, \`commit_sha\`, \`git_tag\`, \`npm_dist_tag\`, \`created_at\`, \`prepared_at\`, \`committed_at\`, \`tagged_at\`, \`pushed_at\`)
          SELECT \`id\`, \`version\`, \`status\`, \`pipeline_id\`, \`epic_id\`, \`tasks_json\`, \`changelog\`, \`notes\`, \`previous_version\`, \`commit_sha\`, \`git_tag\`, \`npm_dist_tag\`, \`created_at\`, \`prepared_at\`, \`committed_at\`, \`tagged_at\`, \`pushed_at\`
          FROM \`release_manifests\`
          WHERE EXISTS (SELECT 1 FROM \`release_manifests\` LIMIT 1);
        `);
      }).not.toThrow();

      const dstCount = nativeDb
        .prepare('SELECT COUNT(*) AS n FROM release_manifests_new')
        .get() as {
        n: number;
      };
      expect(dstCount.n).toBe(0);

      nativeDb.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
